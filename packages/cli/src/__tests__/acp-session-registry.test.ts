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
import { RequestError, type NewSessionRequest } from '@agentclientprotocol/sdk';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  RuntimeHostSubscriptionError,
} from '@maka/runtime-host/client';
import {
  SESSION_CATALOG_CWD_MAX_BYTES,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import { AcpSessionRegistry, type AcpSessionRegistryConnection } from '../acp/session-registry.js';

const SESSION_REVISION = `sha256:${'a'.repeat(64)}` as const;
const NEW_SESSION_REVISION = `sha256:${'b'.repeat(64)}` as const;
type TestableSubscription = Awaited<
  ReturnType<AcpSessionRegistryConnection['openSessionSubscriptionOnce']>
>;

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
            : {},
      }),
    );

    assert.deepEqual(await create, { sessionId: 'session-concurrent' });
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

  test('creates exact Host sessions and continuously tracks isolated subscription snapshots', async () => {
    const subscriptions = new Map<string, TestSubscription>();
    const requests: Array<{ operation: string; input: unknown }> = [];
    let nextId = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            return { kind: 'unsupported_legacy_record' };
          },
          open: async ({ sessionId }) => {
            const subscription = new TestSubscription(sessionId);
            subscriptions.set(sessionId, subscription);
            return subscription;
          },
        }),
      newSessionId: () => `session-${++nextId}`,
    });

    assert.deepEqual(
      await registry.create({
        cwd: '/workspace/one',
        mcpServers: [],
        additionalDirectories: [],
        _meta: { projectId: 'must-be-ignored' },
      }),
      { sessionId: 'session-1' },
    );
    assert.deepEqual(await registry.create({ cwd: '/workspace/two', mcpServers: [] }), {
      sessionId: 'session-2',
    });
    assert.deepEqual(requests, [
      {
        operation: 'session.create',
        input: {
          sessionId: 'session-1',
          workspace: { kind: 'host_path', path: '/workspace/one' },
          modelTarget: { kind: 'default' },
        },
      },
      {
        operation: 'session.create',
        input: {
          sessionId: 'session-2',
          workspace: { kind: 'host_path', path: '/workspace/two' },
          modelTarget: { kind: 'default' },
        },
      },
    ]);

    const first = subscriptions.get('session-1')!;
    const second = subscriptions.get('session-2')!;
    for (let revision = 2; revision <= 40; revision += 1) {
      first.push(projectionFrame(first, snapshot('session-1', revision), revision));
    }
    second.push(projectionFrame(second, snapshot('session-2', 7), 2));
    await waitFor(() => registry.inspect('session-1')?.snapshot.projectionRevision === 40);
    await waitFor(() => registry.inspect('session-2')?.snapshot.projectionRevision === 7);

    const inspection = registry.inspect('session-1')!;
    assert.equal(inspection.failure, undefined);
    inspection.snapshot.session.status = 'running';
    assert.equal(registry.inspect('session-1')?.snapshot.session.status, 'active');
    assert.equal(first.nextCalls >= 40, true, 'the consumer keeps an iterator read pending');

    await registry.dispose();
    await registry.dispose();
    assert.equal(first.closeCalls, 1);
    assert.equal(second.closeCalls, 1);
  });

  test('records subscription failures without producing an unhandled rejection', async () => {
    const subscription = new TestSubscription('session-1');
    const registry = new AcpSessionRegistry({
      connect: async () => fakeConnection({ open: async () => subscription }),
      newSessionId: () => 'session-1',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    subscription.fail(
      new RuntimeHostSubscriptionError('slow_consumer', 'consumer exceeded its queue'),
    );
    await waitFor(() => registry.inspect('session-1')?.failure !== undefined);
    assert.deepEqual(registry.inspect('session-1')?.failure, {
      source: 'runtime_host',
      operation: 'subscription.consume',
      code: 'subscription_failure',
      reason: 'slow_consumer',
    });

    await registry.dispose();
  });

  test('records an unexpected clean subscription end as a failure', async () => {
    const subscription = new TestSubscription('session-1');
    const registry = new AcpSessionRegistry({
      connect: async () => fakeConnection({ open: async () => subscription }),
      newSessionId: () => 'session-1',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    subscription.end();
    await waitFor(() => registry.inspect('session-1')?.failure !== undefined);
    assert.deepEqual(registry.inspect('session-1')?.failure, {
      source: 'runtime_host',
      operation: 'subscription.consume',
      code: 'subscription_closed',
    });
    await registry.dispose();
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

  test('reports a durable session identity when subscription opening fails without rollback', async () => {
    const operations: string[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            operations.push(operation);
            return {};
          },
          open: async () => {
            throw new RuntimeHostOperationError(
              'subscription.open',
              'operation_unavailable',
              'subscription unavailable',
            );
          },
        }),
      newSessionId: () => 'session-durable',
    });

    await assert.rejects(
      registry.create({ cwd: '/workspace', mcpServers: [] }),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, -32603);
        assert.deepEqual(error.data, {
          source: 'runtime_host',
          operation: 'subscription.open',
          code: 'operation_unavailable',
          sessionId: 'session-durable',
          durableSessionCreated: true,
        });
        return true;
      },
    );
    assert.equal(registry.inspect('session-durable'), undefined);
    assert.deepEqual(operations, ['session.create']);
    await registry.dispose();
  });

  test('keeps failed and outcome-unknown creates distinct from known durable sessions', async () => {
    for (const [hostCode, acpCode] of [
      ['invalid_request', -32602],
      ['commit_outcome_unknown', -32603],
    ] as const) {
      let opens = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              throw new RuntimeHostOperationError('session.create', hostCode, 'create failed');
            },
            open: async ({ sessionId }) => {
              opens += 1;
              return new TestSubscription(sessionId);
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
      assert.equal(opens, 0);
      await registry.dispose();
    }
  });

  test('closes a subscription that opens after disposal starts and never registers it', async () => {
    const opening = deferred<TestableSubscription>();
    const subscription = new TestSubscription('session-race');
    let opens = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          open: async () => {
            opens += 1;
            return opening.promise;
          },
        }),
      newSessionId: () => 'session-race',
    });

    const create = registry.create({ cwd: '/workspace', mcpServers: [] });
    await waitFor(() => opens === 1);
    const dispose = registry.dispose();
    opening.resolve(subscription);

    await assert.rejects(
      create,
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32603 &&
        (error.data as { code?: string }).code === 'registry_closed',
    );
    await dispose;
    assert.equal(subscription.closeCalls, 1);
    assert.equal(registry.inspect('session-race'), undefined);
  });

  test('connection cleanup interrupts an in-flight open before disposal waits for it', async () => {
    const opening = deferred<TestableSubscription>();
    let opens = 0;
    let connectionCloses = 0;
    const interruption = new RuntimeHostRequestInterruptedError(
      'subscription.open',
      'control',
      'not_dispatched',
      'connection_lost',
    );
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          open: async () => {
            opens += 1;
            return opening.promise;
          },
          close: async () => {
            connectionCloses += 1;
            opening.reject(interruption);
          },
        }),
      newSessionId: () => 'session-race',
    });

    const create = registry.create({ cwd: '/workspace', mcpServers: [] });
    const createRejected = assert.rejects(create, RequestError);
    await waitFor(() => opens === 1);
    const dispose = registry.dispose();
    try {
      await waitFor(() => connectionCloses === 1);
    } finally {
      opening.reject(interruption);
      await Promise.allSettled([createRejected, dispose]);
    }
    await createRejected;
    await dispose;
    assert.equal(connectionCloses, 1);
  });

  test('connection cleanup terminates a raced subscription that cannot close', async () => {
    const opening = deferred<TestableSubscription>();
    const subscription = new TestSubscription('session-race');
    subscription.closeError = new Error('subscription close failed');
    let opens = 0;
    let connectionCloses = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          open: async () => {
            opens += 1;
            return opening.promise;
          },
          close: async () => {
            connectionCloses += 1;
            subscription.end();
          },
        }),
      newSessionId: () => 'session-race',
    });

    const create = registry.create({ cwd: '/workspace', mcpServers: [] });
    await waitFor(() => opens === 1);
    const dispose = registry.dispose();
    opening.resolve(subscription);

    await assert.rejects(create, RequestError);
    await dispose;
    assert.equal(subscription.closeCalls, 1);
    assert.equal(connectionCloses, 1);
  });

  test('connection cleanup terminates a registered subscription that cannot close', async () => {
    const subscription = new TestSubscription('session-1');
    subscription.closeError = new Error('subscription close failed');
    let connectionCloses = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          open: async () => subscription,
          close: async () => {
            connectionCloses += 1;
            subscription.end();
          },
        }),
      newSessionId: () => 'session-1',
    });
    await registry.create({ cwd: '/workspace', mcpServers: [] });

    await registry.dispose();
    assert.equal(subscription.closeCalls, 1);
    assert.equal(connectionCloses, 1);
    assert.equal(registry.inspect('session-1'), undefined);
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
                  catalogSession('other', join(root, 'other'), 'Other', 1_000),
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
                catalogSession('matching', canonicalWorkspace, 'Matching session', 2_000),
                catalogSession(
                  'undated',
                  canonicalWorkspace,
                  'Out-of-range activity',
                  Number.MAX_SAFE_INTEGER,
                ),
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
    const registry = new AcpSessionRegistry({
      connect: async () => fakeConnection(),
    });
    const invalidRevisionCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        revision: 'sha256:bad',
        cursor: 'page-2',
        cwd: null,
      }),
      'utf8',
    ).toString('base64url');
    for (const cursor of ['not-a-cursor', 'x'.repeat(8 * 1024 + 1), invalidRevisionCursor]) {
      await assert.rejects(
        registry.list({ cursor }),
        (error: unknown) =>
          error instanceof RequestError &&
          error.code === -32602 &&
          (error.data as { reason?: string }).reason === 'invalid_cursor',
      );
    }
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

class TestSubscription implements TestableSubscription {
  readonly hostEpoch = 'host-1';
  readonly subscriptionId: string;
  readonly snapshot: SessionContinuitySnapshot;
  readonly #frames: SubscriptionFrame[] = [];
  #waiting: ReturnType<typeof deferred<IteratorResult<SubscriptionFrame>>> | undefined;
  #failure: Error | undefined;
  #done = false;
  closeError: Error | undefined;
  closeCalls = 0;
  nextCalls = 0;

  constructor(sessionId: string) {
    this.subscriptionId = `subscription-${sessionId}`;
    this.snapshot = snapshot(sessionId, 1);
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return { next: () => this.next() };
  }

  next(): Promise<IteratorResult<SubscriptionFrame>> {
    this.nextCalls += 1;
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve({ done: false, value: frame });
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#done) return Promise.resolve({ done: true, value: undefined });
    assert.equal(this.#waiting, undefined, 'only one iterator read may be pending');
    this.#waiting = deferred<IteratorResult<SubscriptionFrame>>();
    return this.#waiting.promise;
  }

  push(frame: SubscriptionFrame): void {
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting.resolve({ done: false, value: frame });
      return;
    }
    this.#frames.push(frame);
  }

  fail(error: Error): void {
    this.#failure = error;
    this.#waiting?.reject(error);
    this.#waiting = undefined;
  }

  end(): void {
    this.#done = true;
    this.#waiting?.resolve({ done: true, value: undefined });
    this.#waiting = undefined;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
    this.end();
  }
}

function fakeConnection(
  overrides: {
    request?: (operation: string, input: unknown) => Promise<unknown>;
    open?: (input: { sessionId: string }) => Promise<TestableSubscription>;
    close?: () => Promise<void>;
  } = {},
): AcpSessionRegistryConnection {
  return {
    request: overrides.request ?? (async () => ({})),
    openSessionSubscriptionOnce:
      overrides.open ?? (async ({ sessionId }) => new TestSubscription(sessionId)),
    close: overrides.close ?? (async () => undefined),
  } as AcpSessionRegistryConnection;
}

function snapshot(sessionId: string, projectionRevision: number): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId,
      metadataRevision: 1,
      status: 'active',
      createdAt: 1,
      isArchived: false,
    },
    projectionRevision,
    rootTurn: null,
    goal: null,
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
  };
}

function projectionFrame(
  subscription: TestSubscription,
  next: SessionContinuitySnapshot,
  sequence: number,
): SubscriptionFrame {
  return {
    kind: 'subscription.session_projection',
    hostEpoch: subscription.hostEpoch,
    subscriptionId: subscription.subscriptionId,
    sequence,
    snapshot: next,
  };
}

function catalogSession(id: string, cwd: string, name: string, activityAt: number) {
  return {
    id,
    revision: 1,
    workspace: { target: { kind: 'host_path', path: cwd }, hostCwd: cwd },
    createdAt: 1,
    activityAt,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'default',
    permissionMode: 'default',
    collaborationMode: 'default',
    orchestrationMode: 'default',
  };
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
