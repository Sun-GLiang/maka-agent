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
import test from 'node:test';
import { classifySharedSessionTranscriptVisibility, decodeStoredMessage } from '@maka/core/session';
import {
  advanceSessionTurnIdentityScanner,
  completeSessionTurnIdentityScanner,
  createSessionTurnIdentityScannerState,
  restoreSessionTurnIdentityScannerState,
  serializeSessionTurnIdentityScannerState,
  SessionTurnIdentityScannerError,
} from '../session-turn-identity-scanner.js';

function scan(
  json: string,
  splits: readonly number[] = [],
  sql = { messageId: 'message-1', messageType: 'user' },
) {
  let state = createSessionTurnIdentityScannerState();
  const bytes = Buffer.from(json);
  let offset = 0;
  for (const end of [...splits, bytes.length]) {
    advanceSessionTurnIdentityScanner(state, bytes.subarray(offset, end));
    state = restoreSessionTurnIdentityScannerState(serializeSessionTurnIdentityScannerState(state));
    offset = end;
  }
  return completeSessionTurnIdentityScanner(state, sql);
}

test('extracts only the top-level identity envelope across arbitrary fragment boundaries', () => {
  const json = JSON.stringify({
    text: '正文 😀 \\ escaped',
    nested: { id: 'fake-id', type: 'system_note', turnId: 'fake-turn', kind: 'step_limit' },
    turnId: 'turn-一',
    type: 'user',
    id: 'message-1',
    ts: 1,
  });
  const expected = { kind: 'turn', positionId: 'turn-一', sharedVisibility: true };
  assert.deepEqual(scan(json), expected);
  for (let split = 1; split < Buffer.byteLength(json); split += 1) {
    assert.deepEqual(scan(json, [split]), expected);
  }
});

test('handles escaped identity values and visible/invisible turnless notes', () => {
  assert.deepEqual(
    scan(
      '{"kind":"step_limit","id":"note\\u002d1","type":"system_note","text":"x"}',
      [2, 7, 19, 31, 47],
      { messageId: 'note-1', messageType: 'system_note' },
    ),
    { kind: 'note', positionId: 'note-1', sharedVisibility: true },
  );
  assert.deepEqual(
    scan('{"id":"hidden","type":"system_note","kind":"mode_change"}', [], {
      messageId: 'hidden',
      messageType: 'system_note',
    }),
    { kind: 'ignored' },
  );
});

test('rejects duplicate, empty, missing, nested, mismatched, and non-string identity', () => {
  const invalid = [
    '{"id":"message-1","id":"message-1","type":"user","turnId":"turn"}',
    '{"id":"message-1","type":"user","turnId":""}',
    '{"id":"message-1","type":"user"}',
    '{"id":"message-1","type":"user","nested":{"turnId":"turn"}}',
    '{"id":"message-1","type":"user","turnId":1}',
    '{"id":"message-1","type":"user","turnId":{"value":"turn"}}',
    '{"id":"message-1","type":"future_message","turnId":"turn"}',
  ];
  for (const json of invalid) {
    assert.throws(() => scan(json), SessionTurnIdentityScannerError);
  }
  assert.throws(() => scan('{"id":"other","type":"user","turnId":"turn"}'), /mismatch/u);
  assert.throws(
    () =>
      scan('{"id":"note","type":"system_note","kind":"future_note"}', [], {
        messageId: 'note',
        messageType: 'system_note',
      }),
    SessionTurnIdentityScannerError,
  );
  assert.throws(
    () =>
      scan('{"id":"note","type":"system_note","kind":"step_limit","turnId":""}', [], {
        messageId: 'note',
        messageType: 'system_note',
      }),
    SessionTurnIdentityScannerError,
  );
});

test('rejects invalid UTF-8, truncated JSON, excessive nesting, and corrupt persisted state', () => {
  const state = createSessionTurnIdentityScannerState();
  assert.throws(
    () => advanceSessionTurnIdentityScanner(state, Uint8Array.from([0x7b, 0x22, 0xc0])),
    /UTF-8/u,
  );
  assert.throws(() => scan('{"id":"message-1","type":"user","turnId":"turn"'), /truncated/u);
  assert.throws(() => scan('{"id":"message-1","type":"user","turnId":"turn",}'), /JSON/u);
  assert.throws(
    () => scan('{"id":"message-1","type":"user","turnId":"turn","body":[1,]}'),
    /JSON/u,
  );
  assert.throws(() => scan('{"id":"message-1",\u00a0"type":"user","turnId":"turn"}'), /JSON/u);
  assert.throws(
    () =>
      scan(
        `{"id":"message-1","type":"user","turnId":"turn","x":${'['.repeat(4_097)}0${']'.repeat(4_097)}}`,
      ),
    /nesting/u,
  );
  assert.throws(() => restoreSessionTurnIdentityScannerState('{"version":999}'), /unsupported/u);
  assert.throws(
    () =>
      restoreSessionTurnIdentityScannerState(
        JSON.stringify({
          version: 1,
          rootStarted: true,
          rootComplete: false,
          stack: [{ kind: 'object', expectation: 'invented', pendingKey: null }],
          lexical: { kind: 'invented' },
          utf8: { needed: 0, codePoint: 0, minimum: 0 },
          seenIdentityKeys: [],
          identity: { turnIdPresent: false, kindPresent: false },
          capturedBytes: 0,
        }),
      ),
    /unsupported/u,
  );
});

test('rejects captured identity larger than 32 KiB without retaining body fields', () => {
  assert.throws(
    () =>
      scan(
        JSON.stringify({
          id: 'message-1',
          type: 'user',
          turnId: 'x'.repeat(32 * 1024 + 1),
          text: 'body'.repeat(100_000),
        }),
      ),
    /32 KiB/u,
  );
  assert.deepEqual(
    scan(
      JSON.stringify({
        id: 'message-1',
        type: 'user',
        turnId: 'turn',
        text: 'body'.repeat(100_000),
      }),
      [4 * 1024],
    ),
    { kind: 'turn', positionId: 'turn', sharedVisibility: true },
  );
  assert.deepEqual(
    scan(
      JSON.stringify({
        id: 'message-1',
        type: 'user',
        turnId: 'turn',
        ['x'.repeat(100 * 1024)]: 'ignored body field',
      }),
      [4 * 1024],
    ),
    { kind: 'turn', positionId: 'turn', sharedVisibility: true },
  );
});

test('differentially extracts every canonical StoredMessage identity under key reordering', () => {
  const messages = [
    { type: 'user', id: 'message-1', turnId: 'turn-1', ts: 1, text: 'user' },
    {
      type: 'assistant',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'assistant',
      modelId: 'model',
    },
    {
      type: 'tool_call',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      toolName: 'tool',
      args: { turnId: 'nested-fake', kind: 'step_limit' },
    },
    {
      type: 'tool_result',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'call-1',
      isError: false,
      content: { kind: 'text', text: 'result' },
    },
    {
      type: 'permission_decision',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'call-1',
      toolName: 'tool',
      decision: 'allow',
    },
    { type: 'token_usage', id: 'message-1', turnId: 'turn-1', ts: 1, input: 1, output: 2 },
    {
      type: 'turn_state',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      status: 'completed',
      partialOutputRetained: false,
    },
    {
      type: 'workhub_coordination',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-1',
      actionFingerprint: `sha256:${'0'.repeat(64)}`,
      coordinationTurnId: 'turn-1',
      targetSessionId: 'target-session',
      disposition: 'delegate_existing',
      userText: 'work',
      delegationId: 'delegation-1',
      targetTurnId: 'target-turn',
      targetMessageId: 'target-message',
      targetSessionName: 'target',
    },
    {
      type: 'system_note',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      kind: 'error',
    },
  ];
  for (const message of messages) {
    const reordered = Object.fromEntries(Object.entries(message).reverse());
    const json = JSON.stringify(reordered);
    const decoded = decodeStoredMessage(JSON.parse(json) as never);
    assert.equal(decoded.id, 'message-1');
    assert.deepEqual(
      scan(json, [1, 2, 7, Math.floor(Buffer.byteLength(json) / 2)], {
        messageId: 'message-1',
        messageType: message.type,
      }),
      {
        kind: 'turn',
        positionId: 'turn-1',
        sharedVisibility:
          classifySharedSessionTranscriptVisibility(
            decoded.type === 'system_note'
              ? { type: decoded.type, kind: decoded.kind }
              : { type: decoded.type },
          ) === 'visible',
      },
    );
  }
});
