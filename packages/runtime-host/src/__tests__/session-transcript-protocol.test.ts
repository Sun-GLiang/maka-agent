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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSessionTranscriptPositionsInput,
  decodeSessionTranscriptPositionsResult,
  decodeSessionTranscriptBootstrap,
  decodeSessionTranscriptPage,
  decodeSessionTranscriptPageInput,
  decodeSessionTranscriptTurnWindowInput,
  decodeSessionTranscriptTurnWindowResult,
  encodeProtocolMessage,
  HOST_OPERATION_SPECS,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  SESSION_TRANSCRIPT_POSITION_PAGE_MAX_POSITIONS,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
} from '../protocol/index.js';

const input = {
  subscriptionId: 'subscription-1',
  source: 'durable' as const,
  direction: 'older' as const,
  throughSequence: 3,
  cursor: null,
  anchorSequence: 2,
  maxBytes: 1024,
};
const payloadDigest = `sha256:${'a'.repeat(64)}` as const;

const page = {
  kind: 'page' as const,
  sessionId: 'session-1',
  source: 'durable' as const,
  direction: 'older' as const,
  throughSequence: 3,
  rawBytes: 4,
  fragments: [
    {
      kind: 'durable' as const,
      sequence: 2,
      byteOffset: 0,
      totalBytes: 4,
      payloadDigest: null,
      data: Buffer.from('test').toString('base64'),
    },
  ],
  rangeBoundarySequence: 2,
  protectedTurnSequence: 2,
  nextCursor: 'opaque-cursor',
};

test('Session transcript protocol accepts bounded correlated pages and bootstraps', () => {
  assert.deepEqual(decodeSessionTranscriptPageInput(input), input);
  assert.deepEqual(decodeSessionTranscriptPage(page), page);
  assert.doesNotThrow(() =>
    HOST_OPERATION_SPECS['session.transcript.page'].assertOutputForInput?.(input, page),
  );

  const bootstrap = {
    throughSequence: 3,
    durableCoverage: 'complete' as const,
    overlayMessageCount: 0,
    durable: { ...page, direction: 'older' as const },
    overlay: {
      kind: 'page' as const,
      sessionId: 'session-1',
      source: 'overlay' as const,
      direction: 'older' as const,
      throughSequence: 3,
      rawBytes: 0,
      fragments: [],
      rangeBoundarySequence: null,
      protectedTurnSequence: null,
      nextCursor: null,
    },
  };
  assert.deepEqual(decodeSessionTranscriptBootstrap(bootstrap), bootstrap);
  assert.throws(
    () => decodeSessionTranscriptBootstrap({ ...bootstrap, overlayMessageCount: 4_097 }),
    isProtocolError,
  );
  const release = { subscriptionId: 'subscription-1' };
  assert.deepEqual(
    HOST_OPERATION_SPECS['session.transcript.overlay.release'].decodeInput(release),
    release,
  );
  assert.deepEqual(
    HOST_OPERATION_SPECS['session.transcript.overlay.release'].decodeOutput(release),
    release,
  );
});

test('a maximum single-fragment continuation remains transport safe', () => {
  const data = Buffer.alloc(SESSION_TRANSCRIPT_PAGE_MAX_BYTES, 0x61);
  const result = {
    ...page,
    sessionId: 's'.repeat(128),
    rawBytes: data.byteLength,
    fragments: [
      {
        kind: 'durable' as const,
        sequence: 2,
        byteOffset: 1,
        totalBytes: data.byteLength + 1,
        payloadDigest,
        data: data.toString('base64'),
      },
    ],
    nextCursor: 'c'.repeat(1_024),
  };
  assert.deepEqual(decodeSessionTranscriptPage(result), result);
  const encoded = encodeProtocolMessage({
    requestId: 'r'.repeat(128),
    operation: 'session.transcript.page',
    ok: true,
    result,
  });
  assert.ok(encoded.byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES);
});

test('a maximum multi-message page remains transport safe', () => {
  const fragmentBytes = SESSION_TRANSCRIPT_PAGE_MAX_BYTES / 256;
  const result = {
    ...page,
    sessionId: 's'.repeat(128),
    direction: 'newer' as const,
    throughSequence: Number.MAX_SAFE_INTEGER,
    rawBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
    fragments: Array.from({ length: 256 }, (_, sequence) => ({
      kind: 'durable' as const,
      sequence,
      byteOffset: 0,
      totalBytes: fragmentBytes,
      payloadDigest,
      data: Buffer.alloc(fragmentBytes, 0x61).toString('base64'),
    })),
    nextCursor: 'c'.repeat(1_024),
  };
  assert.deepEqual(decodeSessionTranscriptPage(result), result);
  assert.ok(
    encodeProtocolMessage({
      requestId: 'r'.repeat(128),
      operation: 'session.transcript.page',
      ok: true,
      result,
    }).byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES,
  );
});

test('Session transcript protocol rejects malformed and uncorrelated values', () => {
  assert.throws(
    () => decodeSessionTranscriptPageInput({ ...input, cursor: 'cursor', anchorSequence: 2 }),
    isProtocolError,
  );
  assert.throws(
    () => decodeSessionTranscriptPage({ ...page, rangeBoundarySequence: 4 }),
    isProtocolError,
  );
  assert.throws(
    () => decodeSessionTranscriptPage({ ...page, protectedTurnSequence: 4 }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeSessionTranscriptPage({
        ...page,
        source: 'overlay',
        rawBytes: 0,
        fragments: [],
        rangeBoundarySequence: null,
        protectedTurnSequence: 2,
        nextCursor: null,
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeSessionTranscriptPage({
        ...page,
        fragments: [{ ...page.fragments[0], data: 'not base64' }],
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      HOST_OPERATION_SPECS['session.transcript.page'].assertOutputForInput?.(input, {
        ...page,
        throughSequence: 4,
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeSessionTranscriptBootstrap({
        throughSequence: 3,
        durableCoverage: 'complete',
        overlayMessageCount: 0,
        durable: page,
        overlay: { ...page, source: 'overlay', throughSequence: 2 },
      }),
    isProtocolError,
  );
});

test('semantic transcript operations accept only opaque subscription-scoped requests', () => {
  const acquire = {
    kind: 'acquire' as const,
    subscriptionId: 'subscription-1',
    anchor: { kind: 'tail' as const },
    maxPositions: SESSION_TRANSCRIPT_POSITION_PAGE_MAX_POSITIONS,
  };
  const page = {
    kind: 'page' as const,
    subscriptionId: 'subscription-1',
    snapshotToken: 'snapshot-token',
    anchor: { kind: 'turn' as const, turnId: 'turn-1' },
    maxPositions: 1,
  };
  const continuation = {
    kind: 'continue' as const,
    subscriptionId: 'subscription-1',
    cursor: 'positions-cursor',
  };
  const replace = {
    kind: 'replace' as const,
    subscriptionId: 'subscription-1',
    snapshotToken: 'snapshot-token',
    anchor: { kind: 'ordinal' as const, ordinal: 4 },
    maxPositions: 8,
  };
  const release = {
    kind: 'release' as const,
    subscriptionId: 'subscription-1',
    snapshotToken: 'snapshot-token',
  };
  for (const input of [acquire, page, continuation, replace, release]) {
    assert.deepEqual(decodeSessionTranscriptPositionsInput(input), input);
  }

  assert.throws(
    () => decodeSessionTranscriptPositionsInput({ ...acquire, sessionId: 'session-1' }),
    isProtocolError,
  );
  assert.throws(
    () => decodeSessionTranscriptPositionsInput({ ...acquire, maxPositions: 0 }),
    isProtocolError,
  );
  assert.throws(
    () => decodeSessionTranscriptPositionsInput({ ...acquire, maxPositions: 129 }),
    isProtocolError,
  );
  assert.throws(
    () => decodeSessionTranscriptPositionsInput({ ...page, snapshotToken: 'x'.repeat(1_025) }),
    isProtocolError,
  );

  const result = {
    kind: 'page' as const,
    subscriptionId: 'subscription-1',
    snapshotToken: 'snapshot-token',
    totalPositions: 3,
    startOrdinal: 1,
    positions: [
      { ordinal: 1, key: { kind: 'note' as const, id: 'note-1' } },
      { ordinal: 2, key: { kind: 'turn' as const, id: 'turn-2' } },
    ],
    olderCursor: 'older-cursor',
    newerCursor: null,
  };
  assert.deepEqual(decodeSessionTranscriptPositionsResult(result), result);
  assert.throws(
    () =>
      decodeSessionTranscriptPositionsResult({
        ...result,
        positions: [{ ordinal: 1, key: { kind: 'turn', id: '' } }],
      }),
    isProtocolError,
  );
  assert.throws(
    () => decodeSessionTranscriptPositionsResult({ ...result, authorityRevision: 1 }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeSessionTranscriptPositionsResult({
        ...result,
        totalPositions: 2,
        startOrdinal: 0,
        positions: [
          { ordinal: 0, key: { kind: 'empty' } },
          { ordinal: 1, key: { kind: 'turn', id: 'turn-1' } },
        ],
      }),
    isProtocolError,
  );
  for (const semanticResult of [
    {
      kind: 'building',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
      retryAfterMs: 25,
    },
    {
      kind: 'capacity',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
      retryAfterMs: 1_000,
    },
    {
      kind: 'snapshot_stale',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
    },
    {
      kind: 'anchor_not_found',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
    },
    { kind: 'released', subscriptionId: 'subscription-1' },
  ]) {
    assert.deepEqual(decodeSessionTranscriptPositionsResult(semanticResult), semanticResult);
  }
});

test('semantic Turn-window protocol keeps retained fragments opaque and bounded', () => {
  const open = {
    kind: 'open' as const,
    subscriptionId: 'subscription-1',
    snapshotToken: 'snapshot-token',
    startOrdinal: 4,
    maxPositions: 10,
    replaceCursor: null,
  };
  const continuation = {
    kind: 'continue' as const,
    subscriptionId: 'subscription-1',
    cursor: 'window-cursor',
  };
  assert.deepEqual(decodeSessionTranscriptTurnWindowInput(open), open);
  assert.deepEqual(
    decodeSessionTranscriptTurnWindowInput({
      kind: 'open',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
      startOrdinal: 4,
      maxPositions: 10,
    }),
    {
      kind: 'open',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
      startOrdinal: 4,
      maxPositions: 10,
    },
  );
  assert.deepEqual(decodeSessionTranscriptTurnWindowInput(continuation), continuation);
  assert.throws(
    () => decodeSessionTranscriptTurnWindowInput({ ...open, maxPositions: 0 }),
    isProtocolError,
  );
  assert.throws(
    () => decodeSessionTranscriptTurnWindowInput({ ...open, maxPositions: 11 }),
    isProtocolError,
  );

  const bytes = Buffer.from('{"positions":[]}');
  const result = {
    kind: 'page' as const,
    subscriptionId: 'subscription-1',
    snapshotToken: 'snapshot-token',
    windowId: 'window-1',
    byteOffset: 0,
    totalBytes: bytes.byteLength,
    payloadDigest: `sha256:${'a'.repeat(64)}` as const,
    data: bytes.toString('base64'),
    nextCursor: null,
  };
  assert.deepEqual(decodeSessionTranscriptTurnWindowResult(result), result);
  assert.throws(
    () => decodeSessionTranscriptTurnWindowResult({ ...result, data: 'not base64' }),
    isProtocolError,
  );
  assert.throws(
    () => decodeSessionTranscriptTurnWindowResult({ ...result, snapshotGeneration: 3 }),
    isProtocolError,
  );
  for (const semanticResult of [
    {
      kind: 'building',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
      retryAfterMs: 25,
    },
    {
      kind: 'capacity',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
      retryAfterMs: 1_000,
    },
    {
      kind: 'snapshot_stale',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
    },
    {
      kind: 'anchor_not_found',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
    },
    {
      kind: 'position_too_large',
      subscriptionId: 'subscription-1',
      snapshotToken: 'snapshot-token',
    },
  ]) {
    assert.deepEqual(decodeSessionTranscriptTurnWindowResult(semanticResult), semanticResult);
  }
});

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
