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
import { methods, type ClientConnection, type ToolCallContent } from '@agentclientprotocol/sdk';
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

async function collectEvents(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
