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
import { Readable, Writable } from 'node:stream';
import { describe, test } from 'node:test';
import type {
  RuntimeHostConnection,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '@maka/runtime-host/protocol';
import { runMakaAcpStdioServer } from '../acp/stdio-server.js';

describe('Maka ACP stdio server', () => {
  test('answers initialize without Runtime Host input or dependencies', async () => {
    const harness = createHarness([
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      })}\n`,
    ]);

    assert.equal(await harness.run(), 0);
    assert.deepEqual(harness.stdoutMessages(), [
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: {} } },
          authMethods: [],
          agentInfo: { name: 'maka', title: 'Maka', version: '0.2.0' },
        },
      },
    ]);
  });

  test('returns zero after normal EOF', async () => {
    const harness = createHarness([]);

    assert.equal(await harness.run(), 0);
  });

  test('returns a JSON-RPC parse error and then zero after EOF', async () => {
    const harness = createHarness(['not json\n']);

    assert.equal(await harness.run(), 0);
    assert.deepEqual(harness.stdoutMessages(), [
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]);
  });

  test('propagates a stdin transport error', async () => {
    const transportError = new Error('stdin transport failed');
    const stdin = Readable.from(
      (async function* () {
        throw transportError;
      })(),
    );
    const harness = createHarness([], { stdin });

    await assert.rejects(harness.run(), (error: unknown) => error === transportError);
  });

  test('disposes ACP subscriptions before closing the Runtime Host context', async () => {
    const lifecycle: string[] = [];
    const connection = {
      request: async () => ({ kind: 'unsupported_legacy_record' }),
      openSessionSubscriptionOnce: async ({ sessionId }: { sessionId: string }) =>
        closingSubscription(sessionId, lifecycle),
      close: async () => undefined,
    } as unknown as RuntimeHostConnection;
    const harness = createHarness(
      [
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1 },
        })}\n`,
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: '/workspace', mcpServers: [] },
        })}\n`,
      ],
      {
        connection,
        onClose: () => lifecycle.push('context.close'),
      },
    );

    assert.equal(await harness.run(), 0);
    const response = harness
      .stdoutMessages()
      .find((message) => (message as { id?: unknown }).id === 2) as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: { sessionId?: unknown };
    };
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 2);
    assert.equal(typeof response.result?.sessionId, 'string');
    assert.deepEqual(lifecycle, ['subscription.close', 'context.close']);
  });
});

function createHarness(
  chunks: string[],
  options: {
    readonly stdin?: Readable;
    readonly connection?: RuntimeHostConnection;
    readonly onClose?: () => void;
  } = {},
) {
  const stdin = options.stdin ?? Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  let closes = 0;
  const connection =
    options.connection ??
    ({
      request: async () => ({ kind: 'unsupported_legacy_record' }),
      openSessionSubscriptionOnce: async () => {
        throw new Error('subscription is not available in this fixture');
      },
      close: async () => undefined,
    } as unknown as RuntimeHostConnection);
  const stdoutChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return {
    run: () =>
      runMakaAcpStdioServer(
        { workspaceRoot: '/workspace', clientDataRoot: '/client-data', version: '0.2.0' },
        {
          stdin,
          stdout,
          connectRuntimeHostCli: async () =>
            ({
              connection,
              close: async () => {
                closes += 1;
                options.onClose?.();
              },
            }) as Awaited<
              ReturnType<typeof import('../runtime-host-cli-context.js').connectRuntimeHostCli>
            >,
        },
      ),
    closeCalls: () => closes,
    stdoutMessages: () =>
      Buffer.concat(stdoutChunks)
        .toString('utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
  };
}

function closingSubscription(
  sessionId: string,
  lifecycle: string[],
): RuntimeHostSessionSubscription {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    hostEpoch: 'host-1',
    subscriptionId: `subscription-${sessionId}`,
    snapshot: {
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
    },
    activeAssistantStreams: [],
    transcriptBootstrap: null,
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await closed;
          return { done: true, value: undefined };
        },
      };
    },
    close: async () => {
      lifecycle.push('subscription.close');
      finish();
    },
  } as unknown as RuntimeHostSessionSubscription;
}
