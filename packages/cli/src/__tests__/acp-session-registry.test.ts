/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  RequestError,
  type NewSessionRequest,
  type SessionNotification,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';
import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import { THINKING_LEVELS, type ThinkingLevel } from '@maka/core/model-thinking';
import {
  RuntimeHostOperationError,
  RuntimeHostPermanentReconnectError,
  RuntimeHostSubscriptionError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import {
  SESSION_CATALOG_CWD_MAX_BYTES,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionCatalogProjection,
  type SessionContinuitySnapshot,
} from '@maka/runtime-host/protocol';
import {
  AcpSessionRegistry,
  type AcpSessionAttachment,
  type AcpSessionAttachmentOpenInput,
  type AcpSessionRegistryConnection,
} from '../acp/session-registry.js';

const SESSION_REVISION = `sha256:${'a'.repeat(64)}` as const;
const NEW_SESSION_REVISION = `sha256:${'b'.repeat(64)}` as const;

const DEFAULT_CONFIG_OPTIONS: Array<Extract<SessionConfigOption, { type: 'select' }>> = [
  {
    type: 'select',
    id: 'permission_mode',
    name: 'Permission mode',
    category: '_maka/permission_mode',
    currentValue: 'ask',
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'bypass', name: 'Bypass' },
    ],
  },
  {
    type: 'select',
    id: 'thinking_level',
    name: 'Thinking level',
    category: 'thought_level',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'off', name: 'Off' },
      { value: 'minimal', name: 'Minimal' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Extra high' },
      { value: 'max', name: 'Max' },
    ],
  },
  {
    type: 'select',
    id: 'collaboration_mode',
    name: 'Collaboration mode',
    category: 'mode',
    currentValue: 'agent',
    options: [
      { value: 'agent', name: 'Agent' },
      { value: 'plan', name: 'Plan' },
    ],
  },
  {
    type: 'select',
    id: 'orchestration_mode',
    name: 'Orchestration mode',
    category: '_maka/orchestration_mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'swarm', name: 'Swarm' },
      { value: 'graph', name: 'Graph' },
    ],
  },
];

describe('ACP Session registry', () => {
  test('does not connect when disposed before a Session method is used', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return fakeConnection();
      },
    });

    await registry.dispose();
    await registry.dispose();

    assert.equal(connectCalls, 0);
  });

  test('reports the requested Session operation after disposal', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () => fakeConnection(),
    });
    await registry.dispose();

    for (const [operation, request] of [
      ['session.create', () => registry.create({ cwd: '/workspace', mcpServers: [] })],
      ['session.catalog.query', () => registry.list({})],
      [
        'session.configuration.update',
        () =>
          registry.setConfigOption({
            sessionId: 'session-closed',
            configId: 'permission_mode',
            value: 'bypass',
          }),
      ],
      [
        'turn.start',
        () =>
          registry.prompt(
            { sessionId: 'session-closed', prompt: [{ type: 'text', text: 'hello' }] },
            promptContext([]),
          ),
      ],
      ['session.close', () => registry.close({ sessionId: 'session-closed' })],
    ] as const) {
      await assert.rejects(request(), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, -32603);
        assert.deepEqual(error.data, {
          source: 'runtime_host',
          operation,
          code: 'registry_closed',
        });
        return true;
      });
    }
  });

  test('does not start a queued connection after disposal begins', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return fakeConnection();
      },
    });

    const list = registry.list({});
    const dispose = registry.dispose();

    await assert.rejects(
      list,
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32603 &&
        (error.data as { code?: string }).code === 'registry_closed',
    );
    await dispose;
    assert.equal(connectCalls, 0);
  });

  test('aborts an in-flight connection before disposal waits for it', async () => {
    let connectSignal: AbortSignal | undefined;
    const registry = new AcpSessionRegistry({
      connect: async (signal) => {
        connectSignal = signal;
        return new Promise<ReturnType<typeof fakeConnection>>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    const list = registry.list({});
    await waitFor(() => connectSignal !== undefined);
    const dispose = registry.dispose();

    await assert.rejects(
      list,
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32603 &&
        (error.data as { code?: string }).code === 'registry_closed',
    );
    await dispose;
    assert.equal(connectSignal?.aborted, true);
  });

  test('shares one in-flight connection across concurrent Session methods', async () => {
    const connecting = deferred<ReturnType<typeof fakeConnection>>();
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return connecting.promise;
      },
      newSessionId: () => 'session-concurrent',
    });
    const create = registry.create({ cwd: '/workspace', mcpServers: [] });
    const list = registry.list({});
    await waitFor(() => connectCalls === 1);

    connecting.resolve(
      fakeConnection({
        request: async (operation) =>
          operation === 'session.catalog.query'
            ? {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [],
                nextCursor: null,
              }
            : catalogSession('session-concurrent'),
      }),
    );

    assert.deepEqual(await create, {
      sessionId: 'session-concurrent',
      configOptions: DEFAULT_CONFIG_OPTIONS,
    });
    assert.deepEqual(await list, { sessions: [] });
    assert.equal(connectCalls, 1);
    await registry.dispose();
  });

  test('reports a stable connection error and retries on a later Session request', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        if (connectCalls === 1) throw new Error('Host unavailable');
        return fakeConnection({
          request: async () => ({
            kind: 'page',
            revision: SESSION_REVISION,
            sessions: [],
            nextCursor: null,
          }),
        });
      },
    });

    await assert.rejects(registry.list({}), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'connect',
        code: 'connection_failed',
      });
      return true;
    });
    assert.deepEqual(await registry.list({}), { sessions: [] });
    assert.equal(connectCalls, 2);
    await registry.dispose();
  });

  test('closes a connection that resolves after disposal starts', async () => {
    const connecting = deferred<ReturnType<typeof fakeConnection>>();
    let connectCalls = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return connecting.promise;
      },
    });
    const list = registry.list({});
    await waitFor(() => connectCalls === 1);
    const dispose = registry.dispose();

    connecting.resolve(
      fakeConnection({
        close: async () => {
          closeCalls += 1;
        },
      }),
    );

    await assert.rejects(list, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.equal((error.data as { code?: string }).code, 'registry_closed');
      return true;
    });
    await dispose;
    assert.equal(closeCalls, 1);
  });

  test('creates more than the Host subscription limit without opening a subscription', async () => {
    const sessionCount = 17;
    const createdSessionIds: string[] = [];
    let subscriptionOpens = 0;
    let nextId = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        const connection = fakeConnection({
          request: async (operation, input) => {
            assert.equal(operation, 'session.create');
            const sessionId = (input as { sessionId: string }).sessionId;
            createdSessionIds.push(sessionId);
            return catalogSession(sessionId);
          },
        });
        return {
          ...connection,
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            throw new Error('PR 2 must not open a subscription');
          },
        } as AcpSessionRegistryConnection;
      },
      newSessionId: () => `session-unattached-${++nextId}`,
    });

    const creates = await Promise.all(
      Array.from({ length: sessionCount }, () =>
        registry.create({ cwd: '/workspace', mcpServers: [] }),
      ),
    );

    assert.equal(creates.length, sessionCount);
    assert.equal(createdSessionIds.length, sessionCount);
    assert.equal(subscriptionOpens, 0);
    await registry.dispose();
  });

  test('rejects unsupported prompt content before attaching or starting a Turn', async () => {
    let attachmentOpens = 0;
    const turnRequests: string[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            turnRequests.push(operation);
            return catalogSession('session-prompt-validation');
          },
        }),
      newSessionId: () => 'session-prompt-validation',
      openSessionAttachment: async () => {
        attachmentOpens += 1;
        return new FakeAcpSessionAttachment('session-prompt-validation');
      },
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    turnRequests.length = 0;

    await assertInvalidParams(
      registry.prompt(
        {
          sessionId: 'session-prompt-validation',
          prompt: [{ type: 'image', data: '', mimeType: 'image/png' }],
        },
        promptContext([]),
      ),
      { field: 'prompt', reason: 'unsupported_content_type' },
    );

    assert.equal(attachmentOpens, 0);
    assert.deepEqual(turnRequests, []);
    await registry.dispose();
  });

  test('shares a concurrent first attachment and starts event consumption before turn.start', async () => {
    const notifications: SessionNotification[] = [];
    const attachment = new FakeAcpSessionAttachment('session-concurrent-prompt');
    const attachGate = deferred<AcpSessionAttachment>();
    let attachmentOpens = 0;
    const startedTurnIds: string[] = [];
    const turnIds = ['turn-a', 'turn-b'];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-concurrent-prompt');
            if (operation === 'turn.start') {
              const turnId = (input as { turnId: string }).turnId;
              assert.equal(attachment.nextCalls(turnId), 1);
              startedTurnIds.push(turnId);
              queueMicrotask(() => {
                attachment.emit(
                  turnId,
                  sessionEvent(turnId, {
                    type: 'text_complete',
                    messageId: `message-${turnId}`,
                    text: turnId,
                  }),
                );
                attachment.emit(
                  turnId,
                  sessionEvent(turnId, { type: 'complete', stopReason: 'end_turn' }),
                );
                attachment.finish(turnId);
              });
              return {
                kind: 'started',
                turn: {
                  sessionId: 'session-concurrent-prompt',
                  turnId,
                  runId: `run-${turnId}`,
                  status: 'running',
                },
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
        }),
      newSessionId: () => 'session-concurrent-prompt',
      newTurnId: () => turnIds.shift()!,
      openSessionAttachment: async () => {
        attachmentOpens += 1;
        return attachGate.promise;
      },
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    const first = registry.prompt(
      { sessionId: 'session-concurrent-prompt', prompt: [{ type: 'text', text: 'one' }] },
      promptContext(notifications),
    );
    const second = registry.prompt(
      { sessionId: 'session-concurrent-prompt', prompt: [{ type: 'text', text: 'two' }] },
      promptContext(notifications),
    );
    await waitFor(() => attachmentOpens === 1);
    attachGate.resolve(attachment);

    assert.deepEqual(await Promise.all([first, second]), [
      { stopReason: 'end_turn' },
      { stopReason: 'end_turn' },
    ]);
    assert.deepEqual(new Set(startedTurnIds), new Set(['turn-a', 'turn-b']));
    assert.equal(attachmentOpens, 1);
    assert.deepEqual(
      new Set(
        notifications.flatMap(({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
            ? [update.content.text]
            : [],
        ),
      ),
      new Set(['turn-a', 'turn-b']),
    );
    await registry.dispose();
    assert.equal(attachment.closeCalls, 1);
  });

  test('latches cancellation while the initial attachment is pending and never dispatches', async () => {
    const attachment = new FakeAcpSessionAttachment('session-cancel-before-attach');
    const attachGate = deferred<AcpSessionAttachment>();
    let turnStarts = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create')
              return catalogSession('session-cancel-before-attach');
            if (operation === 'turn.start') turnStarts += 1;
            return {};
          },
        }),
      newSessionId: () => 'session-cancel-before-attach',
      newTurnId: () => 'turn-cancelled',
      openSessionAttachment: async () => attachGate.promise,
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const prompt = registry.prompt(
      {
        sessionId: 'session-cancel-before-attach',
        prompt: [{ type: 'text', text: 'cancel me' }],
      },
      promptContext([]),
    );
    await registry.cancel({ sessionId: 'session-cancel-before-attach' });
    attachGate.resolve(attachment);

    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.equal(turnStarts, 0);
    await registry.dispose();
  });

  test('waits for the live root identity before issuing exactly one turn.stop', async () => {
    const attachment = new FakeAcpSessionAttachment('session-cancel-live');
    const startGate = deferred<unknown>();
    const stopInputs: unknown[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-cancel-live');
            if (operation === 'turn.start') return startGate.promise;
            if (operation === 'turn.stop') {
              stopInputs.push(input);
              return {
                sessionId: 'session-cancel-live',
                turnId: 'turn-live',
                runId: 'run-live',
                status: 'cancelled',
                terminalEventId: 'terminal-live',
                abortSource: 'user',
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
        }),
      newSessionId: () => 'session-cancel-live',
      newTurnId: () => 'turn-live',
      openSessionAttachment: async (input) => attachment.bind(input),
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId: 'session-cancel-live', prompt: [{ type: 'text', text: 'run' }] },
      promptContext([]),
    );
    await waitFor(() => attachment.nextCalls('turn-live') === 1);
    const cancel = registry.cancel({ sessionId: 'session-cancel-live' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stopInputs, []);

    attachment.setRoot({
      sessionId: 'session-cancel-live',
      turnId: 'turn-live',
      runId: 'run-live',
      status: 'running',
    });
    startGate.resolve({
      kind: 'started',
      turn: {
        sessionId: 'session-cancel-live',
        turnId: 'turn-live',
        runId: 'run-live',
        status: 'running',
      },
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    });
    await cancel;
    await registry.cancel({ sessionId: 'session-cancel-live' });
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.deepEqual(stopInputs, [
      { sessionId: 'session-cancel-live', turnId: 'turn-live', runId: 'run-live' },
    ]);
    await registry.dispose();
  });

  for (const timing of ['before interruption', 'after interruption'] as const) {
    for (const recovery of [
      'subscription',
      'query',
      'not-found',
      'permanent-query',
      'permanent-attachment',
      'terminal',
      'shutdown',
    ] as const) {
      test(`retains cancellation ${timing} until unknown admission resolves via ${recovery}`, async () => {
        const sessionId = 'session-unknown-start';
        const turn = {
          sessionId,
          turnId: 'turn-unknown',
          runId: 'run-recovered',
          status: 'running' as const,
        };
        const attachment = new FakeAcpSessionAttachment(sessionId);
        const start = deferred<unknown>();
        const query = deferred<unknown>();
        const stopInputs: unknown[] = [];
        let starts = 0;
        let queries = 0;
        let settled = false;
        const registry = new AcpSessionRegistry({
          connect: async () =>
            fakeConnection({
              request: async (operation, input) => {
                if (operation === 'session.create') return catalogSession(sessionId);
                if (operation === 'turn.start') {
                  starts += 1;
                  return start.promise;
                }
                if (operation === 'turn.query') {
                  assert.deepEqual(input, { sessionId, turnId: turn.turnId });
                  queries += 1;
                  return query.promise;
                }
                if (operation === 'turn.stop') {
                  stopInputs.push(input);
                  attachment.setRoot({
                    ...turn,
                    status: 'cancelled',
                    terminalEventId: 'terminal-unknown',
                    abortSource: 'user',
                  });
                  return attachment.snapshot.rootTurn;
                }
                throw new Error(`Unexpected operation ${operation}`);
              },
            }),
          newSessionId: () => sessionId,
          newTurnId: () => turn.turnId,
          openSessionAttachment: async (input) => attachment.bind(input),
        });
        await registry.create({ cwd: '/workspace', mcpServers: [] });
        const prompt = registry
          .prompt({ sessionId, prompt: [{ type: 'text', text: 'run' }] }, promptContext([]))
          .then((result) => {
            settled = true;
            return result;
          });
        await waitFor(() => attachment.nextCalls(turn.turnId) === 1);
        const cancel = () =>
          recovery === 'shutdown' ? registry.dispose() : registry.cancel({ sessionId });
        let cancellation = timing === 'before interruption' ? cancel() : undefined;
        start.reject(
          new RuntimeHostRequestInterruptedError(
            'turn.start',
            'command',
            'dispatched',
            'connection_lost',
          ),
        );
        await waitFor(() => queries === 1);
        cancellation ??= cancel();
        await new Promise((resolve) => setImmediate(resolve));
        if (recovery === 'shutdown') await waitFor(() => settled);
        else assert.equal(settled, false);
        assert.deepEqual(stopInputs, []);
        if (recovery === 'subscription') {
          // A transient query failure and an unrelated root do not retire or
          // redirect the original cancellation intent.
          query.reject(
            new RuntimeHostRequestInterruptedError('turn.query', 'query', 'dispatched', 'timeout'),
          );
          attachment.setRoot({ ...turn, turnId: 'other-turn', runId: 'other-run' });
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(settled, false);
          assert.deepEqual(stopInputs, []);
          attachment.setRoot(turn);
        } else if (recovery === 'permanent-query') {
          query.reject(new RuntimeHostPermanentReconnectError('Host identity changed'));
        } else if (recovery === 'permanent-attachment') {
          attachment.failAttachment(
            new RuntimeHostPermanentReconnectError('Host identity changed'),
          );
        } else if (recovery === 'not-found') {
          query.reject(
            new RuntimeHostOperationError('turn.query', 'not_found', 'Turn was not admitted'),
          );
        } else if (recovery === 'terminal') {
          query.resolve({ ...turn, status: 'completed', terminalEventId: 'terminal-unknown' });
        } else {
          if (recovery === 'shutdown') assert.equal(attachment.closeCalls, 1);
          query.resolve(turn);
        }
        await waitFor(() => settled);
        await cancellation;
        assert.deepEqual(await prompt, { stopReason: 'cancelled' });
        assert.deepEqual(
          stopInputs,
          recovery === 'not-found' ||
            recovery === 'terminal' ||
            recovery === 'shutdown' ||
            recovery.startsWith('permanent-')
            ? []
            : [{ sessionId, turnId: turn.turnId, runId: turn.runId }],
        );
        assert.equal(starts, 1);
        assert.equal(queries, 1);
        await registry.dispose();
      });
    }
  }

  for (const action of ['prompt', 'cancel', 'close', 'dispose'] as const) {
    for (const admission of ['interrupted', 'started'] as const) {
      test(`${action} settles after attachment fails before a late ${admission} start response`, async () => {
        const sessionId = 'failed-before-start';
        const turn = { sessionId, turnId: 'turn', runId: 'run', status: 'running' as const };
        const attachment = new FakeAcpSessionAttachment(sessionId);
        const start = deferred<unknown>();
        const stops: unknown[] = [];
        let started = false;
        let settled = false;
        const registry = new AcpSessionRegistry({
          connect: async () =>
            fakeConnection({
              request: async (operation, input) => {
                if (operation === 'session.create') return catalogSession(sessionId);
                if (operation === 'turn.start') {
                  started = true;
                  return start.promise;
                }
                if (operation === 'turn.stop') {
                  stops.push(input);
                  return {};
                }
                throw new Error(`Unexpected ${operation}`);
              },
            }),
          newSessionId: () => sessionId,
          newTurnId: () => turn.turnId,
          openSessionAttachment: async (input) => attachment.bind(input),
        });
        await registry.create({ cwd: '/workspace', mcpServers: [] });
        const prompt = registry.prompt(
          { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
          promptContext([]),
        );
        const outcome = prompt
          .then(
            (value) => value,
            (error) => error,
          )
          .then((value) => {
            settled = true;
            return value;
          });
        await waitFor(() => started);
        attachment.failAttachment(new RuntimeHostPermanentReconnectError('Host identity changed'));
        const cleanup =
          action === 'cancel'
            ? registry.cancel({ sessionId })
            : action === 'close'
              ? registry.close({ sessionId })
              : action === 'dispose'
                ? registry.dispose()
                : Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        if (admission === 'started') start.resolve({ kind: 'started', turn });
        else
          start.reject(
            new RuntimeHostRequestInterruptedError(
              'turn.start',
              'command',
              'dispatched',
              'connection_lost',
            ),
          );
        await waitFor(() => settled);
        const result = await outcome;
        if (action === 'prompt') assert.ok(result instanceof RequestError);
        else assert.deepEqual(result, { stopReason: 'cancelled' });
        await cleanup;
        assert.deepEqual(
          stops,
          admission === 'started' ? [{ sessionId, turnId: turn.turnId, runId: turn.runId }] : [],
        );
        await registry.dispose();
      });
    }
  }

  test('shutdown stops a late admitted start after observation has closed', async () => {
    const sessionId = 'session-late-start';
    const turn = { sessionId, turnId: 'turn-late', runId: 'run-late', status: 'running' as const };
    const start = deferred<unknown>();
    const stop = deferred<unknown>();
    const calls: string[] = [];
    const attachment = new FakeAcpSessionAttachment(sessionId);
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') return start.promise;
            if (operation === 'turn.stop') {
              assert.deepEqual(input, { sessionId, turnId: turn.turnId, runId: turn.runId });
              calls.push('stop');
              return stop.promise;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          close: async () => {
            calls.push('connection.close');
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turn.turnId,
      openSessionAttachment: async (input) => attachment.bind(input),
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'run' }] },
      promptContext([]),
    );
    await waitFor(() => attachment.nextCalls(turn.turnId) === 1);
    const disposal = registry.dispose();
    await waitFor(() => attachment.closeCalls === 1);
    await new Promise((resolve) => setImmediate(resolve));
    start.resolve({
      kind: 'started',
      turn,
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    });
    try {
      await waitFor(() => calls.includes('stop'));
      assert.deepEqual(calls, ['stop']);
    } finally {
      stop.resolve({ ...turn, status: 'cancelled' });
      await disposal;
      await prompt;
    }
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.deepEqual(calls, ['stop', 'connection.close']);
  });

  test('shutdown closes the connection when an outcome-unknown query never settles', async () => {
    const sessionId = 'session-pending-query-on-shutdown';
    const turn = {
      sessionId,
      turnId: 'turn-pending-query',
      runId: 'run-pending-query',
      status: 'completed' as const,
      terminalEventId: 'terminal-pending-query',
    };
    const start = deferred<unknown>();
    const query = deferred<unknown>();
    const attachment = new FakeAcpSessionAttachment(sessionId);
    const calls: string[] = [];
    let queries = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') return start.promise;
            if (operation === 'turn.query') {
              queries += 1;
              return query.promise;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          close: async () => {
            calls.push('connection.close');
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turn.turnId,
      openSessionAttachment: async (input) => attachment.bind(input),
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'run' }] },
      promptContext([]),
    );
    await waitFor(() => attachment.nextCalls(turn.turnId) === 1);
    const disposal = registry.dispose();
    start.reject(
      new RuntimeHostRequestInterruptedError(
        'turn.start',
        'command',
        'dispatched',
        'connection_lost',
      ),
    );
    await waitFor(() => queries === 1);
    let settled = false;
    const outcome = Promise.all([disposal, prompt]).then((value) => {
      settled = true;
      return value;
    });
    let settledBeforeQuerySettlement = false;
    let closedBeforeQuerySettlement = false;
    try {
      await waitFor(() => settled);
      settledBeforeQuerySettlement = true;
      closedBeforeQuerySettlement = calls.includes('connection.close');
    } finally {
      query.resolve(turn);
      await outcome;
    }
    assert.equal(settledBeforeQuerySettlement, true);
    assert.equal(closedBeforeQuerySettlement, true);
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.deepEqual(calls, ['connection.close']);
  });

  for (const timing of ['before start returns', 'after start returns'] as const) {
    for (const action of ['cancel', 'abort'] as const) {
      test(`${action} completes the prompt when Stop delivery rejects ${timing} without another event`, async (t) => {
        const diagnostic = t.mock.method(console, 'error', () => undefined);
        const start = deferred<unknown>();
        const abort = new AbortController();
        const sessionId = 'session-stop-reject';
        const turn = {
          sessionId,
          turnId: 'turn-reject',
          runId: 'run-reject',
          status: 'running' as const,
        };
        const failure = new Error('Stop delivery failed');
        const attachment = new FakeAcpSessionAttachment(sessionId);
        const registry = new AcpSessionRegistry({
          connect: async () =>
            fakeConnection({
              request: async (operation) => {
                if (operation === 'session.create') return catalogSession(sessionId);
                if (operation === 'turn.start') return start.promise;
                if (operation === 'turn.stop') throw failure;
                throw new Error(`Unexpected operation ${operation}`);
              },
            }),
          newSessionId: () => sessionId,
          newTurnId: () => turn.turnId,
          openSessionAttachment: async (input) => attachment.bind(input),
        });
        await registry.create({ cwd: '/workspace', mcpServers: [] });
        let outcome: unknown;
        const prompt = registry
          .prompt(
            { sessionId, prompt: [{ type: 'text', text: 'run' }] },
            { ...promptContext([]), signal: abort.signal },
          )
          .then(
            (result) => {
              outcome = result;
            },
            (error: unknown) => {
              outcome = error;
            },
          );
        await waitFor(() => attachment.nextCalls(turn.turnId) === 1);
        const started = {
          kind: 'started',
          turn,
          skillInvocation: { loaded: [], failed: [], receipts: [] },
        };
        if (timing === 'after start returns') {
          start.resolve(started);
          await new Promise((resolve) => setImmediate(resolve));
        }
        attachment.setRoot(turn);
        const cancellation = action === 'cancel' ? registry.cancel({ sessionId }) : abort.abort();
        await waitFor(() => diagnostic.mock.callCount() === 1);
        start.resolve(started);
        await cancellation;
        try {
          await waitFor(() => outcome !== undefined);
          assert.deepEqual(outcome, { stopReason: 'cancelled' });
          assert.deepEqual(diagnostic.mock.calls[0]?.arguments, [
            '[acp] Host Stop delivery failed:',
            failure,
          ]);
          assert.equal(attachment.closeCalls, 0);
          assert.equal(attachment.snapshot.rootTurn?.status, 'running');
        } finally {
          await registry.dispose();
          await prompt;
        }
      });
    }
  }

  test('close removes ownership immediately and still closes attachment after stop failure', async () => {
    const attachment = new FakeAcpSessionAttachment('session-close-live');
    const stopFailure = new Error('stop failed');
    let turnStarted = false;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-close-live');
            if (operation === 'turn.start') {
              turnStarted = true;
              return {
                kind: 'started',
                turn: {
                  sessionId: 'session-close-live',
                  turnId: 'turn-close',
                  runId: 'run-close',
                  status: 'running',
                },
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (operation === 'turn.stop') throw stopFailure;
            if (operation === 'session.catalog.query') {
              return {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [catalogSession('session-close-live')],
                nextCursor: null,
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
        }),
      newSessionId: () => 'session-close-live',
      newTurnId: () => 'turn-close',
      openSessionAttachment: async (input) => attachment.bind(input),
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const prompt = registry
      .prompt(
        { sessionId: 'session-close-live', prompt: [{ type: 'text', text: 'run' }] },
        promptContext([]),
      )
      .catch((error: unknown) => error);
    await waitFor(() => turnStarted);
    attachment.setRoot({
      sessionId: 'session-close-live',
      turnId: 'turn-close',
      runId: 'run-close',
      status: 'running',
    });

    const firstClose = registry.close({ sessionId: 'session-close-live' });
    const concurrentClose = registry.close({ sessionId: 'session-close-live' });
    await assertInvalidParams(
      registry.prompt(
        { sessionId: 'session-close-live', prompt: [{ type: 'text', text: 'late' }] },
        promptContext([]),
      ),
      { reason: 'unknown_session' },
    );
    const closeOutcomes = await Promise.allSettled([firstClose, concurrentClose]);
    assert.deepEqual(
      closeOutcomes.map((outcome) =>
        outcome.status === 'rejected' ? outcome.reason : outcome.value,
      ),
      [stopFailure, stopFailure],
    );
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.equal(attachment.closeCalls, 1);
    assert.deepEqual(await registry.list({}), {
      sessions: [
        {
          sessionId: 'session-close-live',
          cwd: '/workspace',
          title: 'session-close-live',
          updatedAt: '1970-01-01T00:00:00.001Z',
        },
      ],
    });
    await assertInvalidParams(registry.close({ sessionId: 'session-close-live' }), {
      reason: 'unknown_session',
    });
    await registry.dispose();
  });

  for (const action of ['cancel', 'close', 'dispose'] as const) {
    test(`${action} stops an externally started root on an idle attachment`, async () => {
      const sessionId = 'external-root';
      const attachment = new FakeAcpSessionAttachment(sessionId);
      const calls: Array<{ operation: string; input: unknown }> = [];
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation, input) => {
              calls.push({ operation, input });
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.start') {
                attachment.emit(
                  'local',
                  sessionEvent('local', { type: 'complete', stopReason: 'end_turn' }),
                );
                return { kind: 'started' };
              }
              if (operation === 'turn.stop') {
                assert.equal(attachment.closeCalls, 0);
                return {};
              }
              throw new Error(operation);
            },
          }),
        newSessionId: () => sessionId,
        newTurnId: () => 'local',
        openSessionAttachment: async (input) => attachment.bind(input),
      });
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      await registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        promptContext([]),
      );
      attachment.setRoot({
        sessionId,
        turnId: 'external',
        runId: 'external-run',
        status: 'running',
      });
      try {
        if (action === 'dispose') await registry.dispose();
        else await registry[action]({ sessionId });
        assert.deepEqual(
          calls.filter(({ operation }) => operation === 'turn.stop'),
          [
            {
              operation: 'turn.stop',
              input: { sessionId, turnId: 'external', runId: 'external-run' },
            },
          ],
        );
      } finally {
        attachment.setRoot(null);
        await registry.dispose();
      }
    });
  }

  for (const source of ['complete', 'recovery'] as const) {
    test(`fails a ${source} rewrite, stops its exact root, and permits another prompt`, async () => {
      const sessionId = 'rewrite';
      const attachment = new FakeAcpSessionAttachment(sessionId);
      const notifications: SessionNotification[] = [];
      const stops: unknown[] = [];
      let turnNumber = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation, input) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.start') {
                const { turnId } = input as { turnId: string };
                attachment.setRoot({
                  sessionId,
                  turnId,
                  runId: `run-${turnId}`,
                  status: 'running',
                });
                if (turnId === 'turn-1') {
                  attachment.emit(
                    turnId,
                    sessionEvent(turnId, { type: 'text_delta', messageId: 'answer', text: 'old' }),
                  );
                } else {
                  attachment.emit(
                    turnId,
                    sessionEvent(turnId, { type: 'complete', stopReason: 'end_turn' }),
                  );
                }
                return { kind: 'started' };
              }
              if (operation === 'turn.stop') {
                stops.push(input);
                return {};
              }
              throw new Error(operation);
            },
          }),
        newSessionId: () => sessionId,
        newTurnId: () => `turn-${++turnNumber}`,
        openSessionAttachment: async (input) => attachment.bind(input),
      });
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      const prompt = registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        promptContext(notifications),
      );
      const rejected = assert.rejects(prompt, {
        data: { source: 'adapter', code: 'unsupported_stream_revision' },
      });
      await waitFor(() => notifications.length === 1);
      if (source === 'complete') {
        attachment.emit(
          'turn-1',
          sessionEvent('turn-1', { type: 'text_complete', messageId: 'answer', text: '' }),
        );
      } else {
        attachment.replaceTranscript('turn-1', [
          {
            type: 'assistant',
            id: 'answer',
            turnId: 'turn-1',
            ts: 1,
            text: 'new',
            modelId: 'default',
          },
        ]);
      }
      try {
        await rejected;
        assert.deepEqual(stops, [{ sessionId, turnId: 'turn-1', runId: 'run-turn-1' }]);
        assert.equal(notifications.length, 1);
        assert.deepEqual(
          await registry.prompt(
            { sessionId, prompt: [{ type: 'text', text: 'next' }] },
            promptContext([]),
          ),
          { stopReason: 'end_turn' },
        );
      } finally {
        attachment.setRoot(null);
        await registry.dispose();
      }
    });
  }

  test('retires a failed attachment so the next prompt opens a fresh one', async () => {
    const first = new FakeAcpSessionAttachment('session-reattach');
    const second = new FakeAcpSessionAttachment('session-reattach');
    let attachmentOpens = 0;
    let starts = 0;
    const stops: unknown[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-reattach');
            if (operation === 'turn.stop') {
              stops.push(input);
              return {};
            }
            if (operation !== 'turn.start') throw new Error(`Unexpected operation ${operation}`);
            starts += 1;
            const turnId = (input as { turnId: string }).turnId;
            const attachment = starts === 1 ? first : second;
            queueMicrotask(() => {
              if (starts === 1) {
                attachment.failAttachment(new Error('subscription failed'));
              } else {
                attachment.emit(
                  turnId,
                  sessionEvent(turnId, { type: 'complete', stopReason: 'end_turn' }),
                );
                attachment.finish(turnId);
              }
            });
            return {
              kind: 'started',
              turn: {
                sessionId: 'session-reattach',
                turnId,
                runId: `run-${turnId}`,
                status: 'running',
              },
              skillInvocation: { loaded: [], failed: [], receipts: [] },
            };
          },
        }),
      newSessionId: () => 'session-reattach',
      newTurnId: (() => {
        const ids = ['turn-first', 'turn-second'];
        return () => ids.shift()!;
      })(),
      openSessionAttachment: async (input) => {
        attachmentOpens += 1;
        return (attachmentOpens === 1 ? first : second).bind(input);
      },
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    await assert.rejects(
      registry.prompt(
        { sessionId: 'session-reattach', prompt: [{ type: 'text', text: 'first' }] },
        promptContext([]),
      ),
      {
        data: { source: 'runtime_host', operation: 'subscription.open', code: 'internal_failure' },
      },
    );
    assert.deepEqual(
      await registry.prompt(
        { sessionId: 'session-reattach', prompt: [{ type: 'text', text: 'second' }] },
        promptContext([]),
      ),
      { stopReason: 'end_turn' },
    );
    assert.equal(attachmentOpens, 2);
    assert.deepEqual(stops, [
      { sessionId: 'session-reattach', turnId: 'turn-first', runId: 'run-turn-first' },
    ]);
    await registry.dispose();
  });

  for (const action of ['close', 'shutdown', 'failure'] as const) {
    test(`handles ${action} before attachment open settles without starting a Turn`, async () => {
      const attachment = new FakeAcpSessionAttachment('pending');
      const gate = deferred<AcpSessionAttachment>();
      let opening = false;
      let starts = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession('pending');
              starts += 1;
              throw new Error('unexpected Turn admission');
            },
          }),
        newSessionId: () => 'pending',
        openSessionAttachment: async (input) => {
          attachment.bind(input);
          opening = true;
          return gate.promise;
        },
      });
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      const prompt = registry.prompt(
        { sessionId: 'pending', prompt: [{ type: 'text', text: 'hello' }] },
        promptContext([]),
      );
      const outcome = prompt.then(
        (result) => result,
        (error: unknown) => error,
      );
      await waitFor(() => opening);
      const closing =
        action === 'close'
          ? registry.close({ sessionId: 'pending' })
          : action === 'shutdown'
            ? registry.dispose()
            : Promise.resolve();
      if (action === 'failure') attachment.failAttachment(new Error('early subscription EOF'));
      gate.resolve(attachment);
      await closing;
      const result = await outcome;
      if (action === 'failure') assert.ok(result instanceof RequestError);
      else assert.deepEqual(result, { stopReason: 'cancelled' });
      assert.equal(starts, 0);
      assert.equal(attachment.closeCalls, 1);
      await registry.dispose();
    });
  }

  test('shutdown cancels active prompts and closes attachments before the shared Host', async () => {
    const lifecycle: string[] = [];
    const startGate = deferred<unknown>();
    const attachment = new FakeAcpSessionAttachment('session-shutdown', () => {
      lifecycle.push('attachment.close');
    });
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-shutdown');
            if (operation === 'turn.start') return startGate.promise;
            throw new Error(`Unexpected operation ${operation}`);
          },
          close: async () => {
            lifecycle.push('connection.close');
          },
        }),
      newSessionId: () => 'session-shutdown',
      newTurnId: () => 'turn-shutdown',
      openSessionAttachment: async (input) => attachment.bind(input),
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId: 'session-shutdown', prompt: [{ type: 'text', text: 'run' }] },
      promptContext([]),
    );
    await waitFor(() => attachment.nextCalls('turn-shutdown') === 1);

    const disposal = registry.dispose();
    await waitFor(() => attachment.closeCalls === 1);
    startGate.reject(new Error('start request interrupted'));
    await disposal;

    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.deepEqual(lifecycle, ['attachment.close', 'connection.close']);
    await assert.rejects(
      registry.list({}),
      (error: unknown) =>
        error instanceof RequestError &&
        (error.data as { code?: string }).code === 'registry_closed',
    );
  });

  test('returns projected configuration and owns only a representable successful create', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    let subscriptionOpens = 0;
    const created = catalogSession('session-configured', '/workspace', {
      thinkingLevel: 'high',
      permissionMode: 'explore',
      collaborationMode: 'plan',
      orchestrationMode: 'swarm',
    });
    const registry = new AcpSessionRegistry({
      connect: async () => {
        const connection = fakeConnection({
          thinkingLevels: ['low', 'high'],
          request: async (operation, input) => {
            requests.push({ operation, input });
            return created;
          },
        });
        return {
          ...connection,
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            throw new Error('PR 2 must not open a subscription');
          },
        } as AcpSessionRegistryConnection;
      },
      newSessionId: () => 'session-configured',
    });

    const response = await registry.create({ cwd: '/workspace', mcpServers: [] });

    assert.deepEqual(response, {
      sessionId: 'session-configured',
      configOptions: configOptions(
        {
          permission_mode: 'explore',
          thinking_level: 'high',
          collaboration_mode: 'plan',
          orchestration_mode: 'swarm',
        },
        ['low', 'high'],
      ),
    });
    assert.deepEqual(requests, [
      {
        operation: 'session.create',
        input: {
          sessionId: 'session-configured',
          workspace: { kind: 'host_path', path: '/workspace' },
          modelTarget: { kind: 'default' },
        },
      },
    ]);
    assert.equal(subscriptionOpens, 0);
    await registry.dispose();
  });

  test('omits thinking configuration when the selected model declares no levels', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          thinkingLevels: [],
          request: async (operation) => {
            assert.equal(operation, 'session.create');
            return catalogSession('session-no-thinking');
          },
        }),
      newSessionId: () => 'session-no-thinking',
    });

    const response = await registry.create({ cwd: '/workspace', mcpServers: [] });

    assert.deepEqual(
      response.configOptions?.map(({ id }) => id),
      ['permission_mode', 'collaboration_mode', 'orchestration_mode'],
    );
    await registry.dispose();
  });

  test('does not grant ownership by listing a Session', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [catalogSession('listed-session')],
              nextCursor: null,
            };
          },
        }),
    });
    await registry.list({});

    await assertInvalidParams(
      registry.setConfigOption({
        sessionId: 'listed-session',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      { reason: 'unknown_session' },
    );
    assert.equal(requests, 1);
    await registry.dispose();
  });

  test('keeps failed creates unowned and returns committed IDs even for unsupported projections', async () => {
    for (const [name, createOutcome] of [
      [
        'failed',
        new RuntimeHostOperationError('session.create', 'operation_conflict', 'create failed'),
      ],
      [
        'legacy',
        {
          kind: 'unsupported_legacy_record',
          id: 'session-legacy',
          revision: 1,
          reason: 'not_wire_representable',
        },
      ],
    ] as const) {
      let requests = 0;
      const sessionId = `session-${name}`;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              requests += 1;
              if (createOutcome instanceof Error) throw createOutcome;
              return createOutcome;
            },
          }),
        newSessionId: () => sessionId,
      });

      if (!(createOutcome instanceof Error)) {
        assert.deepEqual(await registry.create({ cwd: '/workspace', mcpServers: [] }), {
          sessionId,
        });
        await registry.close({ sessionId });
        assert.equal(requests, 1);
        await registry.dispose();
        continue;
      }
      await assert.rejects(registry.create({ cwd: '/workspace', mcpServers: [] }));
      await assertInvalidParams(
        registry.setConfigOption({
          sessionId,
          configId: 'permission_mode',
          value: 'bypass',
        }),
        { reason: 'unknown_session' },
      );
      assert.equal(requests, 1);
      await registry.dispose();
    }
  });

  test('returns the committed ID on catalog failure without admitting mutations during projection', async () => {
    const catalog = deferred<never>();
    let projecting = false;
    const connection = fakeConnection({ request: async () => catalogSession('created') });
    const request = connection.request;
    connection.request = (async (operation, input) => {
      if (operation === 'connection.catalog.query') {
        projecting = true;
        return catalog.promise;
      }
      return request(operation, input);
    }) as AcpSessionRegistryConnection['request'];
    const registry = new AcpSessionRegistry({
      connect: async () => connection,
      newSessionId: () => 'created',
    });
    const creation = registry.create({ cwd: '/workspace', mcpServers: [] });
    await waitFor(() => projecting);
    await assertInvalidParams(
      registry.setConfigOption({
        sessionId: 'created',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      { reason: 'unknown_session' },
    );
    catalog.reject(new Error('catalog unavailable'));
    assert.deepEqual(await creation, { sessionId: 'created' });
    assert.deepEqual(await registry.close({ sessionId: 'created' }), {});
    await registry.dispose();
  });

  test('publishes complete external options in order, including model changes, and stops after close', async () => {
    const sessionId = 'external-options';
    const attachment = new FakeAcpSessionAttachment(sessionId);
    let session = catalogSession(sessionId);
    const notifications: SessionNotification[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return session;
            if (operation === 'session.catalog.query') return { kind: 'session', session };
            if (operation === 'session.configuration.update') {
              session = {
                ...session,
                ...(input as { patch: object }).patch,
                revision: session.revision + 1,
              };
              attachment.setMetadataRevision(session.revision);
              return { kind: 'committed', session };
            }
            if (operation === 'turn.start') {
              attachment.emit(
                'turn',
                sessionEvent('turn', { type: 'complete', stopReason: 'end_turn' }),
              );
              return { kind: 'started' };
            }
            throw new Error(operation);
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn',
      openSessionAttachment: async (input) => {
        attachment.bind(input);
        attachment.setMetadataRevision(1);
        return attachment;
      },
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    await registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
      promptContext(notifications),
    );
    session = { ...session, revision: 2, model: 'non-reasoning' };
    attachment.setMetadataRevision(2);
    await waitFor(() => notifications.length === 1);
    const removed = notifications[0]!.update;
    assert.equal(removed.sessionUpdate, 'config_option_update');
    if (removed.sessionUpdate !== 'config_option_update') assert.fail();
    assert.deepEqual(
      removed.configOptions,
      configOptions({}).filter(({ id }) => id !== 'thinking_level'),
    );
    session = { ...session, revision: 3, model: 'default', thinkingLevel: 'high' };
    attachment.setMetadataRevision(3);
    await waitFor(() => notifications.length === 2);
    const added = notifications[1]!.update;
    assert.equal(added.sessionUpdate, 'config_option_update');
    if (added.sessionUpdate !== 'config_option_update') assert.fail();
    assert.deepEqual(added.configOptions, configOptions({ thinking_level: 'high' }));
    const configured = await registry.setConfigOption({
      sessionId,
      configId: 'permission_mode',
      value: 'bypass',
    });
    assert.deepEqual(notifications[2]!.update, {
      sessionUpdate: 'config_option_update',
      configOptions: configured.configOptions,
    });
    await registry.close({ sessionId });
    session = { ...session, revision: 5, model: 'non-reasoning' };
    attachment.setMetadataRevision(5);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notifications.length, 3);
    await registry.dispose();
  });

  for (const replaceAttachment of [false, true]) {
    test(`orders pending configuration responses before updates across ${replaceAttachment ? 'replacement' : 'first'} attachment`, async () => {
      const sessionId = 'configuration-attachment-race';
      let session = catalogSession(sessionId);
      let attachment: FakeAcpSessionAttachment | undefined;
      let turn = 0;
      let holdProjection = false;
      const projectionStarted = deferred<void>();
      const releaseProjection = deferred<void>();
      const delivered: Array<[string, string | boolean]> = [];
      const connection = fakeConnection({
        request: async (operation, input) => {
          if (operation === 'session.create') return session;
          if (operation === 'session.catalog.query') return { kind: 'session', session };
          if (operation === 'session.configuration.update') {
            session = {
              ...session,
              ...(input as { patch: object }).patch,
              revision: session.revision + 1,
            };
            attachment?.setMetadataRevision(session.revision);
            return { kind: 'committed', session };
          }
          if (operation === 'turn.start') {
            const { turnId } = input as { turnId: string };
            attachment!.emit(
              turnId,
              sessionEvent(turnId, { type: 'complete', stopReason: 'end_turn' }),
            );
            return { kind: 'started' };
          }
          throw new Error(operation);
        },
      });
      const request = connection.request;
      connection.request = (async (operation, input) => {
        if (operation === 'connection.catalog.query' && holdProjection) {
          holdProjection = false;
          projectionStarted.resolve();
          await releaseProjection.promise;
        }
        return request(operation, input);
      }) as AcpSessionRegistryConnection['request'];
      const registry = new AcpSessionRegistry({
        connect: async () => connection,
        newSessionId: () => sessionId,
        newTurnId: () => `turn-${++turn}`,
        openSessionAttachment: async (input) => {
          attachment = new FakeAcpSessionAttachment(sessionId).bind(input);
          attachment.setMetadataRevision(session.revision);
          return attachment;
        },
      });
      const prompt = () =>
        registry.prompt(
          { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
          {
            signal: new AbortController().signal,
            notify: async ({ update }) => {
              if (update.sessionUpdate === 'config_option_update') {
                delivered.push([
                  'notification',
                  update.configOptions.find(({ id }) => id === 'permission_mode')!.currentValue,
                ]);
              }
            },
          },
        );
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      if (replaceAttachment) await prompt();
      holdProjection = true;
      const setting = registry
        .setConfigOption({ sessionId, configId: 'permission_mode', value: 'bypass' })
        .then(({ configOptions }) => {
          delivered.push([
            'response',
            configOptions.find(({ id }) => id === 'permission_mode')!.currentValue,
          ]);
        });
      await projectionStarted.promise;
      const previous = attachment;
      if (replaceAttachment) previous!.failAttachment(new Error('subscription failed'));
      const prompting = prompt();
      await waitFor(() => attachment !== undefined && attachment !== previous);
      session = { ...session, revision: session.revision + 1, permissionMode: 'ask' };
      attachment!.setMetadataRevision(session.revision);
      await new Promise((resolve) => setImmediate(resolve));
      releaseProjection.resolve();
      await Promise.all([setting, prompting]);
      await waitFor(() => delivered.some(([kind]) => kind === 'notification'));
      await registry.dispose();
      assert.deepEqual(delivered, [
        ['response', 'bypass'],
        ['notification', 'ask'],
      ]);
    });
  }

  test('suppresses an external configuration projection that finishes after close', async () => {
    const sessionId = 'closing-options';
    const attachment = new FakeAcpSessionAttachment(sessionId);
    const read = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    let reading = false;
    const notifications: SessionNotification[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query') {
              reading = true;
              return read.promise;
            }
            attachment.emit(
              'turn',
              sessionEvent('turn', { type: 'complete', stopReason: 'end_turn' }),
            );
            return { kind: 'started' };
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn',
      openSessionAttachment: async (input) => {
        attachment.bind(input);
        attachment.setMetadataRevision(1);
        return attachment;
      },
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    await registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
      promptContext(notifications),
    );
    attachment.setMetadataRevision(2);
    await waitFor(() => reading);
    await registry.close({ sessionId });
    read.resolve({
      kind: 'session',
      session: catalogSession(sessionId, '/workspace', { revision: 2, permissionMode: 'bypass' }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notifications, []);
    await registry.dispose();
  });

  test('closing an active prompt does not wait for a stalled configuration read', async () => {
    const attachment = new FakeAcpSessionAttachment('stalled');
    const read = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    let reading = false;
    let started = false;
    const notifications: SessionNotification[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('stalled');
            if (operation === 'session.catalog.query') {
              reading = true;
              return read.promise;
            }
            if (operation === 'turn.stop') return {};
            started = true;
            attachment.setRoot({
              sessionId: 'stalled',
              turnId: 'turn',
              runId: 'run',
              status: 'running',
            });
            attachment.setMetadataRevision(2);
            attachment.emit(
              'turn',
              sessionEvent('turn', { type: 'text_delta', messageId: 'answer', text: 'pending' }),
            );
            return { kind: 'started' };
          },
        }),
      newSessionId: () => 'stalled',
      newTurnId: () => 'turn',
      openSessionAttachment: async (input) => {
        attachment.bind(input);
        attachment.setMetadataRevision(1);
        return attachment;
      },
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId: 'stalled', prompt: [{ type: 'text', text: 'hello' }] },
      promptContext(notifications),
    );
    await waitFor(() => reading && started);
    let closed = false;
    const closing = registry.close({ sessionId: 'stalled' }).then(() => {
      closed = true;
    });
    try {
      await waitFor(() => closed);
      assert.deepEqual(await prompt, { stopReason: 'cancelled' });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.update.sessionUpdate, 'agent_message_chunk');
    } finally {
      read.resolve({
        kind: 'session',
        session: catalogSession('stalled', '/workspace', { revision: 2 }),
      });
      await closing;
      await registry.dispose();
    }
  });

  for (const failure of ['failed', 'stalled'] as const) {
    test(`keeps live prompt streaming after ${failure} configuration refresh`, async () => {
      const sessionId = 'refresh-live';
      const attachment = new FakeAcpSessionAttachment(sessionId);
      const read = deferred<unknown>();
      const notifications: SessionNotification[] = [];
      let reads = 0;
      let stops = 0;
      let settled = false;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'session.catalog.query') {
                reads += 1;
                if (reads === 1) return read.promise;
                return {
                  kind: 'session',
                  session: catalogSession(sessionId, '/workspace', {
                    revision: 3,
                    permissionMode: 'bypass',
                  }),
                };
              }
              if (operation === 'turn.stop') {
                stops += 1;
                return {};
              }
              const turn = { sessionId, turnId: 'turn', runId: 'run', status: 'running' as const };
              attachment.setRoot(turn);
              return { kind: 'started', turn };
            },
          }),
        newSessionId: () => sessionId,
        newTurnId: () => 'turn',
        openSessionAttachment: async (input) => attachment.bind(input),
      });
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      const prompt = registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        promptContext(notifications),
      );
      const outcome = prompt.then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await waitFor(() => attachment.nextCalls('turn') === 1);
      attachment.setMetadataRevision(2);
      await waitFor(() => reads === 1);
      if (failure === 'failed') read.reject(new Error('catalog unavailable'));
      attachment.emit(
        'turn',
        sessionEvent('turn', { type: 'text_delta', messageId: 'answer', text: 'still streaming' }),
      );
      try {
        await waitFor(() =>
          notifications.some(({ update }) => update.sessionUpdate === 'agent_message_chunk'),
        );
        assert.equal(settled, false);
        assert.equal(stops, 0);
        assert.equal(attachment.closeCalls, 0);
        attachment.emit('turn', sessionEvent('turn', { type: 'complete', stopReason: 'end_turn' }));
        await waitFor(() => settled);
        assert.deepEqual(await outcome, { stopReason: 'end_turn' });
        if (failure === 'failed') {
          attachment.setMetadataRevision(3);
          await waitFor(() =>
            notifications.some(({ update }) => update.sessionUpdate === 'config_option_update'),
          );
          assert.equal(reads, 2);
        }
      } finally {
        read.resolve({ kind: 'session', session: catalogSession(sessionId) });
        attachment.setRoot(null);
        await registry.dispose();
        await outcome;
      }
    });
  }

  test('maps observation failures to stable ACP errors', async () => {
    const sessionId = 'observation-failure';
    const attachment = new FakeAcpSessionAttachment(sessionId);
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            return { kind: 'started' };
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn',
      openSessionAttachment: async (input) => attachment.bind(input),
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
      promptContext([]),
    );
    const rejected = assert.rejects(prompt, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'subscription.open',
        code: 'subscription_failure',
        reason: 'connection_closed',
      });
      return true;
    });
    await waitFor(() => attachment.nextCalls('turn') === 1);
    attachment.failAttachment(
      new RuntimeHostSubscriptionError('connection_closed', 'Recovery exhausted'),
    );
    await rejected;
    await registry.dispose();
  });

  test('rejects non-owned and invalid configuration requests before Host I/O', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return catalogSession('session-owned');
          },
        }),
      newSessionId: () => 'session-owned',
    });

    await assertInvalidParams(
      registry.setConfigOption({
        sessionId: 'session-unowned',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      { reason: 'unknown_session' },
    );
    assert.equal(requests, 0);

    await registry.create({ cwd: '/workspace', mcpServers: [] });
    assert.equal(requests, 1);
    for (const [request, data] of [
      [
        { sessionId: 'session-owned', configId: 'unknown', value: 'bypass' },
        { field: 'configId', reason: 'unsupported' },
      ],
      [
        {
          sessionId: 'session-owned',
          configId: 'permission_mode',
          value: true,
          type: 'boolean',
        },
        { field: 'value', reason: 'invalid_type' },
      ],
      [
        { sessionId: 'session-owned', configId: 'permission_mode', value: 'maybe' },
        { field: 'value', reason: 'unsupported' },
      ],
    ] as const) {
      await assertInvalidParams(
        registry.setConfigOption(request as SetSessionConfigOptionRequest),
        data,
      );
      assert.equal(requests, 1);
    }
    await registry.dispose();
  });

  test('updates one configuration field with the latest revision and returns committed options', async () => {
    const current = catalogSession('session-cas', '/workspace', {
      revision: 7,
      thinkingLevel: 'minimal',
    });
    const committed = catalogSession('session-cas', '/workspace', {
      revision: 8,
      permissionMode: 'bypass',
      thinkingLevel: 'high',
    });
    const requests: Array<{ operation: string; input: unknown }> = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-cas');
            if (operation === 'session.catalog.query') {
              return { kind: 'session', session: current };
            }
            return { kind: 'committed', session: committed };
          },
        }),
      newSessionId: () => 'session-cas',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    const response = await registry.setConfigOption({
      sessionId: 'session-cas',
      configId: 'permission_mode',
      value: 'bypass',
    });

    assert.deepEqual(requests.slice(1), [
      {
        operation: 'session.catalog.query',
        input: { kind: 'get', sessionId: 'session-cas' },
      },
      {
        operation: 'session.configuration.update',
        input: {
          sessionId: 'session-cas',
          expectedRevision: 7,
          patch: { permissionMode: 'bypass' },
        },
      },
    ]);
    assert.deepEqual(response, {
      configOptions: configOptions({ permission_mode: 'bypass', thinking_level: 'high' }),
    });
    await registry.dispose();
  });

  test('rereads the Session after one revision conflict before retrying', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    let reads = 0;
    let updates = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-retry');
            if (operation === 'session.catalog.query') {
              reads += 1;
              return {
                kind: 'session',
                session: catalogSession('session-retry', '/workspace', {
                  revision: reads,
                  collaborationMode: reads === 1 ? 'agent' : 'plan',
                }),
              };
            }
            updates += 1;
            return updates === 1
              ? { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 }
              : {
                  kind: 'committed',
                  session: catalogSession('session-retry', '/workspace', {
                    revision: 3,
                    permissionMode: 'bypass',
                    collaborationMode: 'plan',
                  }),
                };
          },
        }),
      newSessionId: () => 'session-retry',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    await registry.setConfigOption({
      sessionId: 'session-retry',
      configId: 'permission_mode',
      value: 'bypass',
    });

    assert.deepEqual(
      requests.slice(1).map(({ operation }) => operation),
      [
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
      ],
    );
    assert.deepEqual(requests[4]?.input, {
      sessionId: 'session-retry',
      expectedRevision: 2,
      patch: { permissionMode: 'bypass' },
    });
    await registry.dispose();
  });

  test('concurrent different-field changes converge through one-field CAS patches', async () => {
    const firstReads = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    const requests: Array<{ operation: string; input: unknown }> = [];
    let reads = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-converge');
            if (operation === 'session.catalog.query') {
              reads += 1;
              if (reads <= 2) {
                if (reads === 2) {
                  firstReads.resolve({
                    kind: 'session',
                    session: catalogSession('session-converge'),
                  });
                }
                return firstReads.promise;
              }
              return {
                kind: 'session',
                session: catalogSession('session-converge', '/workspace', {
                  revision: 2,
                  permissionMode: 'bypass',
                }),
              };
            }
            const patch = (input as { patch: Record<string, unknown> }).patch;
            if ('permissionMode' in patch) {
              return {
                kind: 'committed',
                session: catalogSession('session-converge', '/workspace', {
                  revision: 2,
                  permissionMode: 'bypass',
                }),
              };
            }
            if ((input as { expectedRevision: number }).expectedRevision === 1) {
              return { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 };
            }
            return {
              kind: 'committed',
              session: catalogSession('session-converge', '/workspace', {
                revision: 3,
                permissionMode: 'bypass',
                collaborationMode: 'plan',
              }),
            };
          },
        }),
      newSessionId: () => 'session-converge',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    const [permission, collaboration] = await Promise.all([
      registry.setConfigOption({
        sessionId: 'session-converge',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      registry.setConfigOption({
        sessionId: 'session-converge',
        configId: 'collaboration_mode',
        value: 'plan',
      }),
    ]);

    const updates = requests.filter(
      ({ operation }) => operation === 'session.configuration.update',
    );
    assert.deepEqual(
      updates.map(({ input }) => (input as { patch: unknown }).patch),
      [{ permissionMode: 'bypass' }, { collaborationMode: 'plan' }, { collaborationMode: 'plan' }],
    );
    assert.deepEqual(permission, {
      configOptions: configOptions({ permission_mode: 'bypass' }),
    });
    assert.deepEqual(collaboration, {
      configOptions: configOptions({
        permission_mode: 'bypass',
        collaboration_mode: 'plan',
      }),
    });
    await registry.dispose();
  });

  test('stops after three revision conflicts without a fourth Host operation', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-conflicts');
            if (operation === 'session.catalog.query') {
              return { kind: 'session', session: catalogSession('session-conflicts') };
            }
            return { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 };
          },
        }),
      newSessionId: () => 'session-conflicts',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    await assert.rejects(
      registry.setConfigOption({
        sessionId: 'session-conflicts',
        configId: 'thinking_level',
        value: 'off',
      }),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, -32603);
        assert.deepEqual(error.data, {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'revision_conflict',
          attempts: 3,
        });
        return true;
      },
    );
    assert.deepEqual(
      requests.slice(1).map(({ operation }) => operation),
      [
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
      ],
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 7);
    await registry.dispose();
  });

  test('rejects invalid, missing, and legacy catalog lookup results with stable errors', async () => {
    for (const [name, result, acpCode, data] of [
      [
        'invalid',
        {
          kind: 'page',
          revision: SESSION_REVISION,
          sessions: [],
          nextCursor: null,
        },
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'catalog_read_failure',
          reason: 'invalid_projection',
        },
      ],
      [
        'missing',
        { kind: 'session', session: null },
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'not_found',
        },
      ],
      [
        'legacy',
        {
          kind: 'session',
          session: {
            kind: 'unsupported_legacy_record',
            id: 'session-legacy',
            revision: 1,
            reason: 'not_wire_representable',
          },
        },
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'unsupported_session_projection',
        },
      ],
    ] as const) {
      const sessionId = `session-${name}`;
      let requests = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              requests += 1;
              return operation === 'session.create' ? catalogSession(sessionId) : result;
            },
          }),
        newSessionId: () => sessionId,
      });
      await registry.create({ cwd: '/workspace', mcpServers: [] });

      await assert.rejects(
        registry.setConfigOption({
          sessionId,
          configId: 'permission_mode',
          value: 'bypass',
        }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, acpCode);
          assert.deepEqual(error.data, data);
          return true;
        },
      );
      assert.equal(requests, 2);
      await registry.dispose();
    }
  });

  test('maps configuration Host failures without retrying them', async () => {
    for (const [hostError, acpCode, data] of [
      [
        new RuntimeHostOperationError(
          'session.configuration.update',
          'invalid_request',
          'invalid update',
        ),
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'invalid_request',
        },
      ],
      [
        new RuntimeHostOperationError(
          'session.configuration.update',
          'not_found',
          'missing Session',
        ),
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'not_found',
        },
      ],
      ...(['session_busy', 'operation_conflict', 'commit_outcome_unknown'] as const).map(
        (code) =>
          [
            new RuntimeHostOperationError('session.configuration.update', code, 'update failed'),
            -32603,
            {
              source: 'runtime_host',
              operation: 'session.configuration.update',
              code,
            },
          ] as const,
      ),
      [
        new RuntimeHostRequestInterruptedError(
          'session.configuration.update',
          'command',
          'dispatched',
          'connection_lost',
        ),
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'request_interrupted',
          reason: 'connection_lost',
          dispatch: 'dispatched',
        },
      ],
    ] as const) {
      let requests = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              requests += 1;
              if (operation === 'session.create') return catalogSession('session-errors');
              if (operation === 'session.catalog.query') {
                return { kind: 'session', session: catalogSession('session-errors') };
              }
              throw hostError;
            },
          }),
        newSessionId: () => 'session-errors',
      });
      await registry.create({ cwd: '/workspace', mcpServers: [] });

      await assert.rejects(
        registry.setConfigOption({
          sessionId: 'session-errors',
          configId: 'permission_mode',
          value: 'bypass',
        }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, acpCode);
          assert.deepEqual(error.data, data);
          return true;
        },
      );
      assert.equal(requests, 3);
      await registry.dispose();
    }
  });

  test('does not start an update after disposal begins during its catalog read', async () => {
    const catalogRead = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    let catalogReads = 0;
    let updates = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-closing');
            if (operation === 'session.catalog.query') {
              catalogReads += 1;
              return catalogRead.promise;
            }
            updates += 1;
            return {
              kind: 'committed',
              session: catalogSession('session-closing', '/workspace', { revision: 2 }),
            };
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      newSessionId: () => 'session-closing',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const update = registry.setConfigOption({
      sessionId: 'session-closing',
      configId: 'permission_mode',
      value: 'bypass',
    });
    await waitFor(() => catalogReads === 1);

    const dispose = registry.dispose();
    catalogRead.resolve({
      kind: 'session',
      session: catalogSession('session-closing'),
    });

    await assert.rejects(update, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.configuration.update',
        code: 'registry_closed',
      });
      return true;
    });
    await dispose;
    assert.equal(updates, 0);
    assert.equal(closeCalls, 1);
  });

  test('does not reread after a held update conflicts during disposal', async () => {
    const heldUpdate = deferred<{
      kind: 'revision_conflict';
      expectedRevision: number;
      actualRevision: number;
    }>();
    let catalogReads = 0;
    let updates = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-conflict-closing');
            if (operation === 'session.catalog.query') {
              catalogReads += 1;
              if (catalogReads === 1) {
                return {
                  kind: 'session',
                  session: catalogSession('session-conflict-closing'),
                };
              }
              throw new RuntimeHostRequestInterruptedError(
                'session.catalog.query',
                'query',
                'dispatched',
                'connection_lost',
              );
            }
            updates += 1;
            return heldUpdate.promise;
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      newSessionId: () => 'session-conflict-closing',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });
    const update = registry.setConfigOption({
      sessionId: 'session-conflict-closing',
      configId: 'permission_mode',
      value: 'bypass',
    });
    await waitFor(() => updates === 1);

    const dispose = registry.dispose();
    heldUpdate.resolve({ kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 });

    await assert.rejects(update, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.configuration.update',
        code: 'registry_closed',
      });
      return true;
    });
    await dispose;
    assert.equal(catalogReads, 1);
    assert.equal(updates, 1);
    assert.equal(closeCalls, 1);
  });

  test('rejects unsupported creation inputs before touching Runtime Host', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {};
          },
        }),
    });

    const cases: Array<readonly [string, NewSessionRequest]> = [
      [
        'mcpServers',
        {
          cwd: '/workspace',
          mcpServers: [{ name: 'server', command: 'server', args: [], env: [] }],
        },
      ],
      [
        'additionalDirectories',
        {
          cwd: '/workspace',
          mcpServers: [],
          additionalDirectories: ['/other'],
        },
      ],
      ['cwd', { cwd: 'relative', mcpServers: [] }],
      [
        'cwd',
        {
          cwd: `/${'x'.repeat(SESSION_CATALOG_CWD_MAX_BYTES)}`,
          mcpServers: [],
        },
      ],
    ];
    for (const [field, input] of cases) {
      await assert.rejects(
        registry.create(input),
        (error: unknown) =>
          error instanceof RequestError &&
          error.code === -32602 &&
          (error.data as { field?: string }).field === field,
      );
    }
    assert.equal(requests, 0);
    await registry.dispose();
  });

  test('keeps failed and outcome-unknown creates distinct', async () => {
    for (const [hostCode, acpCode] of [
      ['invalid_request', -32602],
      ['commit_outcome_unknown', -32603],
    ] as const) {
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              throw new RuntimeHostOperationError('session.create', hostCode, 'create failed');
            },
          }),
        newSessionId: () => `session-${hostCode}`,
      });

      await assert.rejects(
        registry.create({ cwd: '/workspace', mcpServers: [] }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, acpCode);
          assert.deepEqual(error.data, {
            source: 'runtime_host',
            operation: 'session.create',
            code: hostCode,
            sessionId: `session-${hostCode}`,
          });
          return true;
        },
      );
      await registry.dispose();
    }
  });

  test('maps one filtered Host catalog page per ACP page and carries cwd across pages', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-acp-list-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(workspace);
    await symlink(workspace, alias);
    const canonicalWorkspace = await realpath(workspace);
    const inputs: unknown[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            assert.equal(operation, 'session.catalog.query');
            inputs.push(input);
            if ((input as { kind: string }).kind === 'list_start') {
              return {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [
                  catalogSession('other', join(root, 'other'), {
                    name: 'Other',
                    activityAt: 1_000,
                  }),
                  {
                    kind: 'unsupported_legacy_record',
                    id: 'legacy',
                    revision: 1,
                    reason: 'not_wire_representable',
                  },
                ],
                nextCursor: 'page-2',
              };
            }
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [
                catalogSession('matching', canonicalWorkspace, {
                  name: 'Matching session',
                  activityAt: 2_000,
                }),
                catalogSession('undated', canonicalWorkspace, {
                  name: 'Out-of-range activity',
                  activityAt: Number.MAX_SAFE_INTEGER,
                }),
              ],
              nextCursor: null,
            };
          },
        }),
    });

    const first = await registry.list({ cwd: alias });
    assert.deepEqual(first.sessions, []);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await registry.list({ cursor: first.nextCursor });
    assert.deepEqual(second, {
      sessions: [
        {
          sessionId: 'matching',
          cwd: canonicalWorkspace,
          title: 'Matching session',
          updatedAt: '1970-01-01T00:00:02.000Z',
        },
        {
          sessionId: 'undated',
          cwd: canonicalWorkspace,
          title: 'Out-of-range activity',
        },
      ],
    });
    assert.deepEqual(inputs, [
      { kind: 'list_start' },
      { kind: 'list_continue', revision: SESSION_REVISION, cursor: 'page-2' },
    ]);
    await registry.dispose();
  });

  test('rejects a cursor reused with a different normalized cwd before Host I/O', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [],
              nextCursor: 'page-2',
            };
          },
        }),
    });
    const first = await registry.list({ cwd: '/workspace/one/../one' });

    await assert.rejects(
      registry.list({ cwd: '/workspace/two', cursor: first.nextCursor }),
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32602 &&
        (error.data as { reason?: string }).reason === 'cursor_cwd_mismatch',
    );
    assert.equal(requests, 1);
    await registry.dispose();
  });

  test('rejects malformed and oversized ACP cursors as invalid params', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {};
          },
        }),
    });
    const invalidRevisionCursor = Buffer.from(
      JSON.stringify({
        revision: 'sha256:bad',
        cursor: 'page-2',
        cwd: null,
      }),
      'utf8',
    ).toString('base64url');
    const versionedCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        revision: SESSION_REVISION,
        cursor: 'page-2',
        cwd: null,
      }),
      'utf8',
    ).toString('base64url');
    for (const cursor of [
      'not-a-cursor',
      'x'.repeat(8 * 1024 + 1),
      invalidRevisionCursor,
      versionedCursor,
    ]) {
      await assert.rejects(
        registry.list({ cursor }),
        (error: unknown) =>
          error instanceof RequestError &&
          error.code === -32602 &&
          (error.data as { reason?: string }).reason === 'invalid_cursor',
      );
    }
    assert.equal(requests, 0);
    await registry.dispose();
  });

  test('translates stale and repeated Host cursors into stable ACP errors', async () => {
    for (const [nextResult, expectedCode, expectedReason] of [
      [
        {
          kind: 'revision_changed',
          expectedRevision: SESSION_REVISION,
          actualRevision: NEW_SESSION_REVISION,
        },
        -32602,
        'stale_cursor',
      ],
      [
        {
          kind: 'page',
          revision: SESSION_REVISION,
          sessions: [],
          nextCursor: 'page-2',
        },
        -32603,
        'repeated_cursor',
      ],
    ] as const) {
      let first = true;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              if (!first) return nextResult;
              first = false;
              return {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [],
                nextCursor: 'page-2',
              };
            },
          }),
      });
      const page = await registry.list({});
      await assert.rejects(registry.list({ cursor: page.nextCursor }), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, expectedCode);
        assert.equal((error.data as { reason?: string; code?: string }).reason, expectedReason);
        return true;
      });
      await registry.dispose();
    }
  });

  test('maps Runtime Host invalid_request from session/list to invalid params', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            throw new RuntimeHostOperationError(
              'session.catalog.query',
              'invalid_request',
              'invalid query',
            );
          },
        }),
    });

    await assert.rejects(registry.list({}), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32602);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.catalog.query',
        code: 'invalid_request',
      });
      return true;
    });
    await registry.dispose();
  });
});

function fakeConnection(
  overrides: {
    request?: (operation: string, input: unknown) => Promise<unknown>;
    close?: () => Promise<void>;
    thinkingLevels?: readonly ThinkingLevel[];
  } = {},
): AcpSessionRegistryConnection {
  return {
    reconnecting: true,
    request: async (operation, input) =>
      operation === 'connection.catalog.query'
        ? connectionCatalogPage(overrides.thinkingLevels ?? THINKING_LEVELS)
        : (overrides.request?.(operation, input) ?? {}),
    openSessionSubscription: async () => {
      throw new Error('Unexpected recoverable subscription open');
    },
    openSessionSubscriptionOnce: async () => {
      throw new Error('Unexpected initial subscription open');
    },
    close: overrides.close ?? (async () => undefined),
  } as AcpSessionRegistryConnection;
}

function promptContext(notifications: SessionNotification[]) {
  return {
    signal: new AbortController().signal,
    notify: async (notification: SessionNotification) => void notifications.push(notification),
  };
}

class FakeAcpSessionAttachment implements AcpSessionAttachment {
  snapshot: SessionContinuitySnapshot;
  closeCalls = 0;
  #callbacks: AcpSessionAttachmentOpenInput | undefined;
  readonly #streams = new Map<string, FakeEventStream>();

  constructor(
    readonly sessionId: string,
    readonly onClose: () => void = () => undefined,
  ) {
    this.snapshot = continuitySnapshot(sessionId);
  }

  bind(input: AcpSessionAttachmentOpenInput): this {
    this.#callbacks = input;
    return this;
  }

  eventsForTurn(turnId: string): AsyncIterable<SessionEvent> {
    return this.#stream(turnId);
  }

  failTurn(turnId: string, error: unknown): void {
    this.#stream(turnId).fail(error);
  }

  failAttachment(error: Error): void {
    this.#callbacks?.onFailed(error);
    for (const stream of this.#streams.values()) stream.fail(error);
  }

  emit(turnId: string, event: SessionEvent): void {
    this.#stream(turnId).push(event);
  }

  finish(turnId: string): void {
    this.#stream(turnId).finish();
  }

  nextCalls(turnId: string): number {
    return this.#streams.get(turnId)?.nextCalls ?? 0;
  }

  setRoot(rootTurn: SessionContinuitySnapshot['rootTurn']): void {
    this.snapshot = {
      ...this.snapshot,
      projectionRevision: this.snapshot.projectionRevision + 1,
      rootTurn,
    };
    this.#callbacks?.onSnapshotChanged(this.snapshot);
  }

  replaceTranscript(turnId: string, messages: readonly StoredMessage[]): void {
    this.#callbacks?.onTranscriptReplaced(turnId, messages);
  }

  setMetadataRevision(metadataRevision: number): void {
    this.snapshot = { ...this.snapshot, session: { ...this.snapshot.session, metadataRevision } };
    this.#callbacks?.onSnapshotChanged(this.snapshot);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.onClose();
    for (const stream of this.#streams.values()) stream.finish();
  }

  #stream(turnId: string): FakeEventStream {
    let stream = this.#streams.get(turnId);
    if (!stream) {
      stream = new FakeEventStream();
      this.#streams.set(turnId, stream);
    }
    return stream;
  }
}

class FakeEventStream implements AsyncIterable<SessionEvent>, AsyncIterator<SessionEvent> {
  readonly #events: SessionEvent[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<SessionEvent>): void;
    reject(error: unknown): void;
  }> = [];
  nextCalls = 0;
  #done = false;

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return this;
  }

  next(): Promise<IteratorResult<SessionEvent>> {
    this.nextCalls += 1;
    const event = this.#events.shift();
    if (event) return Promise.resolve({ done: false, value: event });
    if (this.#done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  push(event: SessionEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.#events.push(event);
  }

  fail(error: unknown): void {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  finish(): void {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

function continuitySnapshot(sessionId: string): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId,
      metadataRevision: 1,
      status: 'active',
      createdAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: null,
    goal: null,
    queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
  };
}

function sessionEvent<T extends Omit<SessionEvent, 'id' | 'turnId' | 'ts'>>(
  turnId: string,
  value: T,
): SessionEvent {
  return { id: `event-${turnId}`, turnId, ts: 1, ...value } as unknown as SessionEvent;
}

function connectionCatalogPage(thinkingLevels: readonly ThinkingLevel[]) {
  return {
    kind: 'page' as const,
    revision: 1,
    defaultTarget: { connectionId: 'connection-1', model: 'default' },
    connectionCount: 1,
    items: [
      {
        kind: 'connection' as const,
        connectionIndex: 0,
        connectionId: 'connection-1',
        revision: 1,
        slug: 'default',
        name: 'Default',
        providerType: 'openai' as const,
        enabled: true,
        enabledModelIdCount: 1,
        modelCount: 0,
        catalogEntryCount: 1,
      },
      {
        kind: 'enabled_model_id' as const,
        connectionIndex: 0,
        itemIndex: 0,
        modelId: 'default',
      },
      {
        kind: 'catalog_entry' as const,
        connectionIndex: 0,
        itemIndex: 0,
        entry: {
          id: 'default',
          canUseAsChatDefault: true,
          isDefault: true,
          supportsVision: false,
          thinkingLevels,
        },
      },
    ],
    nextCursor: null,
  };
}

function catalogSession(
  id: string,
  cwd = '/workspace',
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: { target: { kind: 'host_path', path: cwd }, hostCwd: cwd },
    createdAt: 1,
    activityAt: 1,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'default',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function configOptions(
  values: Partial<
    Record<
      'permission_mode' | 'thinking_level' | 'collaboration_mode' | 'orchestration_mode',
      string
    >
  >,
  thinkingLevels: readonly ThinkingLevel[] = THINKING_LEVELS,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = structuredClone(DEFAULT_CONFIG_OPTIONS);
  const thinking = options.find(({ id }) => id === 'thinking_level');
  if (thinking?.type === 'select') {
    thinking.options = thinking.options.flatMap((option) =>
      'value' in option &&
      (option.value === 'default' || thinkingLevels.includes(option.value as ThinkingLevel))
        ? [option]
        : [],
    );
  }
  for (const option of options) {
    if (option.type !== 'select') continue;
    option.currentValue = values[option.id as keyof typeof values] ?? option.currentValue;
  }
  return options;
}

async function assertInvalidParams(
  promise: Promise<unknown>,
  data: Record<string, unknown>,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, -32602);
    assert.deepEqual(error.data, data);
    return true;
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
