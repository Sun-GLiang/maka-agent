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
import { test } from 'node:test';
import {
  methods,
  type ClientApp,
  type ClientConnection,
  type ToolCallContent,
} from '@agentclientprotocol/sdk';
import type { SessionEvent } from '@maka/core/events';
import type { AcpConnectionOwner } from '../server/acp/connection.js';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import {
  AcpAgentBackend,
  mapAcpStopReason,
  projectAcpToolContent,
} from '../server/acp/acp-agent-backend.js';

test('projects mixed ACP tool content in protocol order without dropping diffs', () => {
  const content: ToolCallContent[] = [
    { type: 'content', content: { type: 'text', text: 'before' } },
    { type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' },
    { type: 'terminal', terminalId: 'terminal-1' },
    { type: 'diff', path: 'src/b.ts', oldText: 'one', newText: 'two' },
    { type: 'content', content: { type: 'text', text: 'after' } },
  ];

  const projected = projectAcpToolContent(content);
  assert.deepEqual(decodeCanonicalToolResultContent(projected), projected);
  assert.equal(projected.kind, 'external_tool');
  if (projected.kind !== 'external_tool') return;
  assert.deepEqual(
    projected.parts.map((part) => part.kind),
    ['text', 'file_diff', 'terminal', 'file_diff', 'text'],
  );
  assert.match(
    projected.parts[1]?.kind === 'file_diff' ? projected.parts[1].diff : '',
    /-old\n\+new/,
  );
  assert.match(
    projected.parts[3]?.kind === 'file_diff' ? projected.parts[3].diff : '',
    /-one\n\+two/,
  );
});

test('maps every ACP terminal reason to a canonical durable outcome', () => {
  assert.equal(mapAcpStopReason('end_turn'), 'end_turn');
  assert.equal(mapAcpStopReason('max_tokens'), 'max_tokens');
  assert.equal(mapAcpStopReason('max_turn_requests'), 'step_limit');
  assert.equal(mapAcpStopReason('refusal'), 'error');
});

test('reports an Agent execution error message as an explicit prompt diagnostic', async () => {
  let acceptUpdate:
    | ((input: {
        params: {
          sessionId: string;
          update: {
            sessionUpdate: 'agent_message_chunk';
            content: { type: 'text'; text: string };
          };
        };
      }) => void)
    | undefined;
  const connection = {
    agent: {
      async request(method: unknown) {
        if (method === methods.agent.initialize) {
          return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
        }
        if (method === methods.agent.session.new) return { sessionId: 'acp-session-1' };
        if (method === methods.agent.session.prompt) {
          acceptUpdate?.({
            params: {
              sessionId: 'acp-session-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Agent execution error: request failed (code 403): unavailable in location',
                },
              },
            },
          });
          return { stopReason: 'end_turn' };
        }
        throw new Error('unexpected request');
      },
      notify: async () => undefined,
    },
  } as unknown as ClientConnection;
  const owner: AcpConnectionOwner = {
    connection,
    failed: new Promise<never>(() => {}),
    closed: Promise.resolve(),
    dispose: async () => undefined,
  };
  const backend = new AcpAgentBackend({
    sessionId: 'session-1',
    cwd: process.cwd(),
    executable: '/agent',
    env: {},
    releaseResidency: () => undefined,
    onCleanupFailure: () => assert.fail('cleanup should succeed'),
    onUnavailable: () => assert.fail('the reusable connection remains available'),
    createConnection: (input) => {
      const app = {
        onNotification(method: unknown, handler: unknown) {
          if (method === methods.client.session.update) {
            acceptUpdate = handler as typeof acceptUpdate;
          }
          return app;
        },
        onRequest() {
          return app;
        },
      } as unknown as ClientApp;
      input.configureClient?.(app);
      return owner;
    },
  });

  const events = await collectEvents(backend.send({ turnId: 'turn-1', text: 'hello' }));
  const error = events.find(
    (candidate): candidate is Extract<SessionEvent, { type: 'error' }> =>
      candidate.type === 'error',
  );
  assert.equal(error?.code, 'acp_agent_execution_failed');
  assert.equal(error?.reason, 'acp_agent_execution_failed');
  assert.equal(
    error?.message,
    'Agent execution error: request failed (code 403): unavailable in location',
  );
  assert.deepEqual(error?.details, { stage: 'prompt', providerStopReason: 'end_turn' });
  assert.deepEqual(
    events
      .filter((candidate) => candidate.type === 'complete')
      .map((candidate) => ({
        stopReason: candidate.stopReason,
        providerStopReason: candidate.providerStopReason,
      })),
    [{ stopReason: 'error', providerStopReason: 'end_turn' }],
  );
});

test('retains and updates only the ACP Agent model configuration for the live Session', async () => {
  const requestedModels: string[] = [];
  const modelOptions = [
    { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
    { value: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
  ];
  const configOptions = (currentValue: string) => [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: modelOptions,
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'agent',
      options: [{ value: 'agent', name: 'Agent' }],
    },
  ];
  const connection = {
    agent: {
      async request(method: unknown, params: unknown) {
        if (method === methods.agent.initialize) {
          return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
        }
        if (method === methods.agent.session.new) {
          return {
            sessionId: 'acp-session-1',
            configOptions: configOptions(modelOptions[0]!.value),
          };
        }
        if (method === methods.agent.session.prompt) return { stopReason: 'end_turn' };
        if (method === methods.agent.session.setConfigOption) {
          const request = params as { sessionId: string; configId: string; value: string };
          assert.deepEqual(request, {
            sessionId: 'acp-session-1',
            configId: 'model',
            value: modelOptions[1]!.value,
          });
          requestedModels.push(request.value);
          return { configOptions: configOptions(request.value) };
        }
        throw new Error('unexpected request');
      },
      notify: async () => undefined,
    },
  } as unknown as ClientConnection;
  const backend = new AcpAgentBackend({
    sessionId: 'session-1',
    cwd: process.cwd(),
    executable: '/agent',
    env: {},
    releaseResidency: () => undefined,
    onCleanupFailure: () => assert.fail('cleanup should succeed'),
    onUnavailable: () => assert.fail('the reusable connection remains available'),
    createConnection: () => ({
      connection,
      failed: new Promise<never>(() => {}),
      closed: Promise.resolve(),
      dispose: async () => undefined,
    }),
  });

  await collectEvents(backend.send({ turnId: 'turn-1', text: 'hello' }));
  assert.deepEqual(backend.modelConfiguration(), {
    configId: 'model',
    currentValue: modelOptions[0]!.value,
    options: modelOptions,
  });

  assert.deepEqual(await backend.setModel(modelOptions[1]!.value), {
    configId: 'model',
    currentValue: modelOptions[1]!.value,
    options: modelOptions,
  });
  assert.deepEqual(requestedModels, [modelOptions[1]!.value]);
});

test('stop cancels startup before a prompt can be dispatched', async () => {
  let signal: AbortSignal | undefined;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let promptRequests = 0;
  let disposals = 0;
  let unavailable = 0;
  const connection = {
    agent: {
      request(method: unknown, _params: unknown, options?: { cancellationSignal?: AbortSignal }) {
        if (method === methods.agent.session.prompt) promptRequests += 1;
        if (method !== methods.agent.initialize) throw new Error('unexpected request');
        signal = options?.cancellationSignal;
        resolveStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('startup cancelled')), {
            once: true,
          });
        });
      },
      notify: async () => undefined,
    },
  } as unknown as ClientConnection;
  const owner: AcpConnectionOwner = {
    connection,
    failed: new Promise<never>(() => {}),
    closed: Promise.resolve(),
    dispose: async () => {
      disposals += 1;
    },
  };
  const backend = new AcpAgentBackend({
    sessionId: 'session-1',
    cwd: process.cwd(),
    executable: '/agent',
    env: {},
    releaseResidency: () => undefined,
    onCleanupFailure: () => assert.fail('cleanup should succeed'),
    onUnavailable: () => {
      unavailable += 1;
    },
    createConnection: () => owner,
  });

  const events = collectEvents(backend.send({ turnId: 'turn-1', text: 'hello' }));
  await started;
  await backend.stop('user_stop');
  const completed = await events;

  assert.equal(signal?.aborted, true);
  assert.equal(promptRequests, 0);
  assert.equal(disposals, 1);
  assert.equal(unavailable, 1);
  assert.deepEqual(
    completed
      .filter((event) => event.type === 'complete')
      .map((event) => ({
        stopReason: event.stopReason,
        providerStopReason: event.providerStopReason,
      })),
    [{ stopReason: 'user_stop', providerStopReason: 'cancelled_during_startup' }],
  );
});

for (const scenario of [
  { method: methods.agent.initialize, stage: 'initialize' },
  { method: methods.agent.session.new, stage: 'session_new' },
  { method: methods.agent.session.prompt, stage: 'prompt' },
] as const) {
  test(`reports ${scenario.stage} failures as a terminal, redacted ACP diagnostic`, async () => {
    let unavailable = 0;
    const failure = Object.assign(new Error('Internal error'), { code: -32603 });
    const connection = {
      agent: {
        async request(method: unknown) {
          if (method === scenario.method) throw failure;
          if (method === methods.agent.initialize) {
            return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
          }
          if (method === methods.agent.session.new) return { sessionId: 'acp-session-1' };
          throw new Error('unexpected request');
        },
        notify: async () => undefined,
      },
    } as unknown as ClientConnection;
    const owner: AcpConnectionOwner = {
      connection,
      failed: new Promise<never>(() => {}),
      closed: Promise.resolve(),
      dispose: async () => undefined,
    };
    const backend = new AcpAgentBackend({
      sessionId: 'session-1',
      cwd: process.cwd(),
      executable: '/agent',
      env: {},
      releaseResidency: () => undefined,
      onCleanupFailure: () => assert.fail('cleanup should succeed'),
      onUnavailable: () => {
        unavailable += 1;
      },
      createConnection: (input) => {
        input.onStderr(
          Buffer.from(`${'x'.repeat(16 * 1024)}\nAuthorization: Bearer private-fixture-token`),
        );
        return owner;
      },
    });

    const events = await collectEvents(backend.send({ turnId: 'turn-1', text: 'hello' }));
    const error = events.find(
      (event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error',
    );

    assert.equal(unavailable, 1);
    assert.equal(error?.code, `acp_${scenario.stage}_failed`);
    assert.equal(error?.reason, `acp_${scenario.stage}_failed`);
    assert.equal(error?.message, `Antigravity ACP ${scenario.stage} failed: Internal error`);
    const details = error?.details;
    if (!details || Array.isArray(details)) assert.fail('expected structured ACP diagnostics');
    assert.equal(details.stage, scenario.stage);
    assert.equal(details.jsonRpcCode, -32603);
    const stderr = String(details.stderr);
    assert.equal(stderr.endsWith('Authorization: Bearer [redacted]'), true);
    assert.equal(stderr.includes('private-fixture-token'), false);
    assert.ok(Buffer.byteLength(stderr) <= 8 * 1024);
    assert.deepEqual(
      events.filter((event) => event.type === 'complete'),
      [
        {
          type: 'complete',
          id: events.at(-1)?.id,
          turnId: 'turn-1',
          ts: events.at(-1)?.ts,
          stopReason: 'error',
          providerStopReason: `acp_${scenario.stage}_failed`,
        },
      ],
    );
  });
}

async function collectEvents(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
