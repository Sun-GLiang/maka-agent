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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import {
  SessionTurnPositionLimitError,
  type SessionTurnPositionSnapshotKey,
} from '@maka/storage/execution-stores';
import { createSessionStore } from '@maka/storage/session-store';
import {
  confirmSemanticTranscriptWatermark,
  createSubscriberSemanticTranscriptState,
  querySemanticTranscriptPositions,
  readSemanticTranscriptTurnWindow,
  releaseSubscriberSemanticTranscript,
  SEMANTIC_TRANSCRIPT_WINDOW_IDLE_TTL_MS,
  SemanticTranscriptRequestError,
} from '../server/semantic-session-transcript-pager.js';
import type { SessionTranscriptReader } from '../server/session-transcript-reader.js';

const snapshotKey: SessionTurnPositionSnapshotKey = {
  throughSequence: 5,
  authorityRevision: 2,
  snapshotGeneration: 7,
};

test('acquires, continues, and releases an opaque exact semantic snapshot', async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const reader = semanticReader({
    readPositionPage: async (request) => {
      calls.push({ kind: 'positions', value: request });
      return {
        kind: 'page',
        projection: request.projection,
        snapshotKey,
        startOrdinal: 0,
        totalPositions: 2,
        positions: [
          { ordinal: 0, key: { kind: 'turn', id: 'turn-1' }, firstSequence: 0 },
          { ordinal: 1, key: { kind: 'note', id: 'note-1' }, firstSequence: 5 },
        ],
        hasOlder: false,
        hasNewer: false,
      };
    },
    releasePositionSnapshot: async (request) => {
      calls.push({ kind: 'release', value: request });
    },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x41),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 2,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  const publicHandle = JSON.parse(
    Buffer.from(acquired.snapshotToken.split('.')[0]!, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(publicHandle).sort(), ['handleId', 'incarnation', 'version']);
  assert.equal(JSON.stringify(publicHandle).includes('session-1'), false);
  assert.equal(JSON.stringify(publicHandle).includes('owner'), false);
  assert.deepEqual(acquired.positions, [
    { ordinal: 0, key: { kind: 'turn', id: 'turn-1' } },
    { ordinal: 1, key: { kind: 'note', id: 'note-1' } },
  ]);
  assert.equal(JSON.stringify(acquired).includes('snapshotGeneration'), false);
  const firstRequest = calls[0]?.value as Record<string, unknown>;
  assert.equal(firstRequest.throughSequence, 5);
  assert.equal(firstRequest.projection, 'owner');

  await assert.rejects(
    querySemanticTranscriptPositions({
      reader,
      state,
      request: {
        kind: 'page',
        subscriptionId: 'subscription-1',
        snapshotToken: `${acquired.snapshotToken}x`,
        anchor: { kind: 'tail' },
        maxPositions: 1,
      },
    }),
    SemanticTranscriptRequestError,
  );
  const otherState = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-2',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x51),
  });
  confirmSemanticTranscriptWatermark(otherState, 5);
  await assert.rejects(
    querySemanticTranscriptPositions({
      reader,
      state: otherState,
      request: {
        kind: 'page',
        subscriptionId: 'subscription-2',
        snapshotToken: acquired.snapshotToken,
        anchor: { kind: 'tail' },
        maxPositions: 1,
      },
    }),
    SemanticTranscriptRequestError,
  );

  const released = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'release',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
    },
  });
  assert.deepEqual(released, { kind: 'released', subscriptionId: 'subscription-1' });
  assert.deepEqual(
    await querySemanticTranscriptPositions({
      reader,
      state,
      request: {
        kind: 'release',
        subscriptionId: 'subscription-1',
        snapshotToken: acquired.snapshotToken,
      },
    }),
    released,
  );
  await releaseSubscriberSemanticTranscript(reader, state);
  assert.equal(calls.filter((call) => call.kind === 'release').length, 1);
});

test('uses a reduced older-page limit near the transcript head to avoid overlap', async () => {
  const requests: Array<{ anchor: unknown; maxPositions: number }> = [];
  const reader = semanticReader({
    readPositionPage: async (request) => {
      requests.push({ anchor: request.anchor, maxPositions: request.maxPositions });
      const startOrdinal = requests.length === 1 ? 3 : 0;
      const count = requests.length === 1 ? 5 : 3;
      return {
        kind: 'page',
        projection: request.projection,
        snapshotKey,
        startOrdinal,
        totalPositions: 8,
        positions: Array.from({ length: count }, (_, index) => ({
          ordinal: startOrdinal + index,
          key: { kind: 'turn' as const, id: `turn-${startOrdinal + index}` },
          firstSequence: startOrdinal + index,
        })),
        hasOlder: startOrdinal > 0,
        hasNewer: startOrdinal + count < 8,
      };
    },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x61),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: state.subscriptionId,
      anchor: { kind: 'ordinal', ordinal: 3 },
      maxPositions: 5,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page' || acquired.olderCursor === null) {
    assert.fail('expected an older positions cursor');
  }
  const older = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'continue',
      subscriptionId: state.subscriptionId,
      cursor: acquired.olderCursor,
    },
  });
  assert.equal(older.kind, 'page');
  if (older.kind !== 'page') assert.fail('expected an older position page');
  assert.deepEqual(
    older.positions.map((position) => position.ordinal),
    [0, 1, 2],
  );
  assert.deepEqual(requests[1], {
    anchor: { kind: 'ordinal', ordinal: 0 },
    maxPositions: 3,
  });
});

test('encodes a complete shared semantic window once and continues by slicing only', async () => {
  let positionReads = 0;
  let bodyReads = 0;
  const reader = semanticReader({
    readPositionPage: async (request) => {
      positionReads += 1;
      return {
        kind: 'page',
        projection: request.projection,
        snapshotKey,
        startOrdinal: 0,
        totalPositions: 1,
        positions: [{ ordinal: 0, key: { kind: 'turn', id: 'turn-1' }, firstSequence: 0 }],
        hasOlder: false,
        hasNewer: false,
      };
    },
    readPositionRecords: async (request) => {
      bodyReads += 1;
      return {
        projection: request.projection,
        snapshotKey,
        rawBytes: 200,
        records: [
          {
            positionKey: { kind: 'turn', id: 'turn-1' },
            sequence: 0,
            message: {
              type: 'permission_decision',
              id: 'hidden-1',
              turnId: 'turn-1',
              ts: 1,
              toolUseId: 'tool-use-1',
              toolName: 'shell',
              decision: 'allow',
            },
          },
          {
            positionKey: { kind: 'turn', id: 'turn-1' },
            sequence: 1,
            message: {
              type: 'user',
              id: 'user-1',
              turnId: 'turn-1',
              ts: 2,
              text: 'visible',
            },
          },
        ],
      };
    },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'shared',
    cursorSecret: Buffer.alloc(32, 0x42),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  const beforeWindow = positionReads;
  const first = await readSemanticTranscriptTurnWindow({
    reader,
    state,
    request: {
      kind: 'open',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
      startOrdinal: 0,
      maxPositions: 1,
      replaceCursor: null,
    },
    fragmentBytes: 32,
  });
  assert.equal(first.kind, 'page');
  if (first.kind !== 'page') assert.fail('expected a window page');
  const fragments = [Buffer.from(first.data, 'base64')];
  let cursor = first.nextCursor;
  while (cursor) {
    const continued = await readSemanticTranscriptTurnWindow({
      reader,
      state,
      request: { kind: 'continue', subscriptionId: 'subscription-1', cursor },
      fragmentBytes: 32,
    });
    assert.equal(continued.kind, 'page');
    if (continued.kind !== 'page') assert.fail('expected a window continuation');
    fragments.push(Buffer.from(continued.data, 'base64'));
    cursor = continued.nextCursor;
  }
  assert.equal(positionReads, beforeWindow + 1);
  assert.equal(bodyReads, 1);
  const decoded = JSON.parse(Buffer.concat(fragments).toString('utf8')) as {
    positions: Array<{ messages: StoredMessage[] }>;
  };
  assert.deepEqual(decoded.positions[0]?.messages, [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 2, text: 'visible' },
  ]);
});

test('refreshes the semantic window idle TTL after every accepted continuation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reader = semanticReader({
    readPositionPage: async (request) => ({
      kind: 'page',
      projection: request.projection,
      snapshotKey,
      startOrdinal: 0,
      totalPositions: 1,
      positions: [{ ordinal: 0, key: { kind: 'turn', id: 'turn-1' }, firstSequence: 0 }],
      hasOlder: false,
      hasNewer: false,
    }),
    readPositionRecords: async (request) => ({
      projection: request.projection,
      snapshotKey,
      rawBytes: 1_024,
      records: [
        {
          positionKey: { kind: 'turn', id: 'turn-1' },
          sequence: 0,
          message: {
            type: 'user',
            id: 'user-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'x'.repeat(1_024),
          },
        },
      ],
    }),
  });
  let retainedBytes = 0;
  const accounting = {
    retain: (bytes: number) => {
      retainedBytes += bytes;
      return true;
    },
    release: (bytes: number) => {
      retainedBytes -= bytes;
    },
  };
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x62),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: state.subscriptionId,
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  const first = await readSemanticTranscriptTurnWindow({
    reader,
    state,
    request: {
      kind: 'open',
      subscriptionId: state.subscriptionId,
      snapshotToken: acquired.snapshotToken,
      startOrdinal: 0,
      maxPositions: 1,
    },
    fragmentBytes: 16,
    accounting,
  });
  if (first.kind !== 'page' || first.nextCursor === null) {
    assert.fail('expected a retained semantic window');
  }
  t.mock.timers.tick(SEMANTIC_TRANSCRIPT_WINDOW_IDLE_TTL_MS - 1);
  const continued = await readSemanticTranscriptTurnWindow({
    reader,
    state,
    request: {
      kind: 'continue',
      subscriptionId: state.subscriptionId,
      cursor: first.nextCursor,
    },
    fragmentBytes: 16,
    accounting,
  });
  assert.equal(continued.kind, 'page');
  t.mock.timers.tick(2);
  assert.ok(retainedBytes > 0);
  t.mock.timers.tick(SEMANTIC_TRANSCRIPT_WINDOW_IDLE_TTL_MS);
  assert.equal(retainedBytes, 0);
  await releaseSubscriberSemanticTranscript(reader, state, accounting);
});

test('maps an oversized first semantic position to a typed zero-fragment result', async () => {
  const reader = semanticReader({
    readPositionPage: async (request) => ({
      kind: 'page',
      projection: request.projection,
      snapshotKey,
      startOrdinal: 0,
      totalPositions: 1,
      positions: [{ ordinal: 0, key: { kind: 'turn', id: 'turn-1' }, firstSequence: 0 }],
      hasOlder: false,
      hasNewer: false,
    }),
    readPositionRecords: async () => {
      throw new SessionTurnPositionLimitError('session-1', 'transcript_record_bytes');
    },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x43),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  const result = await readSemanticTranscriptTurnWindow({
    reader,
    state,
    request: {
      kind: 'open',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
      startOrdinal: 0,
      maxPositions: 1,
      replaceCursor: null,
    },
  });
  assert.deepEqual(result, {
    kind: 'position_too_large',
    subscriptionId: 'subscription-1',
    snapshotToken: acquired.snapshotToken,
  });
});

test('reuses one exact lease and key across bounded building retries', async () => {
  const requests: Array<{ snapshotLeaseId: string; snapshotKey?: SessionTurnPositionSnapshotKey }> =
    [];
  let building = true;
  const reader = semanticReader({
    readPositionPage: async (request) => {
      requests.push(request);
      if (building) {
        building = false;
        return {
          kind: 'building',
          projection: request.projection,
          snapshotKey,
          progress: {
            phase: 'recovering',
            nextSequence: 1,
            currentByteOffset: 0,
            sourceRecords: 1,
            sourceBytes: 10,
            builtPositions: 0,
            lastStepRecords: 1,
            lastStepBytes: 10,
            lastStepPositions: 0,
          },
        };
      }
      return {
        kind: 'page',
        projection: request.projection,
        snapshotKey,
        startOrdinal: 0,
        totalPositions: 1,
        positions: [{ ordinal: 0, key: { kind: 'empty' }, firstSequence: null }],
        hasOlder: false,
        hasNewer: false,
      };
    },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x44),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const first = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(first.kind, 'building');
  if (first.kind !== 'building') assert.fail('expected building');
  const second = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'page',
      subscriptionId: 'subscription-1',
      snapshotToken: first.snapshotToken,
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(second.kind, 'page');
  assert.equal(requests[0]?.snapshotLeaseId, requests[1]?.snapshotLeaseId);
  assert.equal(requests[0]?.snapshotKey, undefined);
  assert.deepEqual(requests[1]?.snapshotKey, snapshotKey);
});

test('keeps the maximal complete prefix when a later projected position exceeds the encoded budget', async () => {
  const reader = semanticReader({
    readPositionPage: async (request) => ({
      kind: 'page',
      projection: request.projection,
      snapshotKey,
      startOrdinal: 0,
      totalPositions: 2,
      positions: [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-1' }, firstSequence: 0 },
        { ordinal: 1, key: { kind: 'turn', id: 'turn-2' }, firstSequence: 1 },
      ],
      hasOlder: false,
      hasNewer: false,
    }),
    readPositionRecords: async (request) => {
      const key = request.positionKeys[0]!;
      const large = key.id === 'turn-2';
      return {
        projection: request.projection,
        snapshotKey,
        rawBytes: large ? 2_800_000 : 32,
        records: [
          {
            positionKey: key,
            sequence: large ? 1 : 0,
            message: {
              type: 'user',
              id: large ? 'user-2' : 'user-1',
              turnId: key.id,
              ts: large ? 2 : 1,
              text: large ? '\u0000'.repeat(2_800_000) : 'fits',
            },
          },
        ],
      };
    },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x45),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 2,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  const window = await readSemanticTranscriptTurnWindow({
    reader,
    state,
    request: {
      kind: 'open',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
      startOrdinal: 0,
      maxPositions: 2,
      replaceCursor: null,
    },
    fragmentBytes: 16 * 1024 * 1024,
  });
  assert.equal(window.kind, 'page');
  if (window.kind !== 'page') assert.fail('expected a complete-prefix window');
  const decoded = JSON.parse(Buffer.from(window.data, 'base64').toString('utf8')) as {
    endOrdinalExclusive: number;
    positions: unknown[];
    hasNewer: boolean;
  };
  assert.equal(decoded.endOrdinalExclusive, 1);
  assert.equal(decoded.positions.length, 1);
  assert.equal(decoded.hasNewer, true);
});

test('keeps a snapshot releasable when the Storage release fails', async () => {
  let releases = 0;
  const reader = semanticReader({
    readPositionPage: async (request) => ({
      kind: 'page',
      projection: request.projection,
      snapshotKey,
      startOrdinal: 0,
      totalPositions: 1,
      positions: [{ ordinal: 0, key: { kind: 'empty' }, firstSequence: null }],
      hasOlder: false,
      hasNewer: false,
    }),
    releasePositionSnapshot: async () => {
      releases += 1;
      if (releases === 1) throw new Error('transient release failure');
    },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x46),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  const release = () =>
    querySemanticTranscriptPositions({
      reader,
      state,
      request: {
        kind: 'release',
        subscriptionId: 'subscription-1',
        snapshotToken: acquired.snapshotToken,
      },
    });
  await assert.rejects(release(), /transient release failure/);
  assert.deepEqual(await release(), { kind: 'released', subscriptionId: 'subscription-1' });
  assert.equal(releases, 2);
});

test('maps every previously valid replaced snapshot token to stale without an ABA window', async () => {
  let generation = 6;
  const reader = semanticReader({
    readPositionPage: async (request) => ({
      kind: 'page',
      projection: request.projection,
      snapshotKey: { ...snapshotKey, snapshotGeneration: ++generation },
      startOrdinal: 0,
      totalPositions: 1,
      positions: [{ ordinal: 0, key: { kind: 'empty' }, firstSequence: null }],
      hasOlder: false,
      hasNewer: false,
    }),
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x47),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const first = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(first.kind, 'page');
  if (first.kind !== 'page') assert.fail('expected a position page');
  let currentToken = first.snapshotToken;
  for (let index = 0; index < 6; index += 1) {
    const replaced = await querySemanticTranscriptPositions({
      reader,
      state,
      request: {
        kind: 'replace',
        subscriptionId: 'subscription-1',
        snapshotToken: currentToken,
        anchor: { kind: 'tail' },
        maxPositions: 1,
      },
    });
    assert.equal(replaced.kind, 'page');
    if (replaced.kind !== 'page') assert.fail('expected a replacement page');
    currentToken = replaced.snapshotToken;
  }
  assert.deepEqual(
    await querySemanticTranscriptPositions({
      reader,
      state,
      request: {
        kind: 'page',
        subscriptionId: 'subscription-1',
        snapshotToken: first.snapshotToken,
        anchor: { kind: 'tail' },
        maxPositions: 1,
      },
    }),
    {
      kind: 'snapshot_stale',
      subscriptionId: 'subscription-1',
      snapshotToken: first.snapshotToken,
    },
  );
});

test('uses the current signed window cursor as CAS and retains the old window on preparation failure', async () => {
  let failPreparation = false;
  let retainedBytes = 0;
  const reader = semanticReader({
    readPositionPage: async (request) => ({
      kind: 'page',
      projection: request.projection,
      snapshotKey,
      startOrdinal: 0,
      totalPositions: 1,
      positions: [{ ordinal: 0, key: { kind: 'turn', id: 'turn-1' }, firstSequence: 0 }],
      hasOlder: false,
      hasNewer: false,
    }),
    readPositionRecords: async (request) => {
      if (failPreparation) throw new Error('projection failed');
      return {
        projection: request.projection,
        snapshotKey,
        rawBytes: 64,
        records: [
          {
            positionKey: { kind: 'turn', id: 'turn-1' },
            sequence: 0,
            message: {
              type: 'user',
              id: 'user-1',
              turnId: 'turn-1',
              ts: 1,
              text: 'fragmented body',
            },
          },
        ],
      };
    },
  });
  const accounting = {
    retain: (bytes: number) => {
      retainedBytes += bytes;
      return true;
    },
    release: (bytes: number) => {
      retainedBytes -= bytes;
    },
  };
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x48),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  const first = await readSemanticTranscriptTurnWindow({
    reader,
    state,
    request: {
      kind: 'open',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
      startOrdinal: 0,
      maxPositions: 1,
      replaceCursor: null,
    },
    fragmentBytes: 16,
    accounting,
  });
  assert.equal(first.kind, 'page');
  if (first.kind !== 'page' || first.nextCursor === null) assert.fail('expected a retained window');
  const retainedBeforeFailure = retainedBytes;
  await assert.rejects(
    readSemanticTranscriptTurnWindow({
      reader,
      state,
      request: {
        kind: 'open',
        subscriptionId: 'subscription-1',
        snapshotToken: acquired.snapshotToken,
        startOrdinal: 0,
        maxPositions: 1,
        replaceCursor: `${first.nextCursor}x`,
      },
      fragmentBytes: 16,
      accounting,
    }),
    SemanticTranscriptRequestError,
  );
  failPreparation = true;
  await assert.rejects(
    readSemanticTranscriptTurnWindow({
      reader,
      state,
      request: {
        kind: 'open',
        subscriptionId: 'subscription-1',
        snapshotToken: acquired.snapshotToken,
        startOrdinal: 0,
        maxPositions: 1,
        replaceCursor: first.nextCursor,
      },
      fragmentBytes: 16,
      accounting,
    }),
    /projection failed/,
  );
  assert.equal(retainedBytes, retainedBeforeFailure);
  failPreparation = false;
  const continued = await readSemanticTranscriptTurnWindow({
    reader,
    state,
    request: {
      kind: 'continue',
      subscriptionId: 'subscription-1',
      cursor: first.nextCursor,
    },
    fragmentBytes: 16,
    accounting,
  });
  assert.equal(continued.kind, 'page');
  if (continued.kind !== 'page') assert.fail('expected the retained old window');
});

test('keeps the current snapshot active while a replacement receives typed capacity', async () => {
  let capacity = false;
  const reader = semanticReader({
    readPositionPage: async (request) =>
      capacity
        ? {
            kind: 'capacity',
            projection: request.projection,
            throughSequence: 5,
            authorityRevision: 2,
            retainedSnapshots: 2,
          }
        : {
            kind: 'page',
            projection: request.projection,
            snapshotKey,
            startOrdinal: 0,
            totalPositions: 1,
            positions: [{ ordinal: 0, key: { kind: 'empty' }, firstSequence: null }],
            hasOlder: false,
            hasNewer: false,
          },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x49),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  capacity = true;
  const replacement = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'replace',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(replacement.kind, 'capacity');
  capacity = false;
  const current = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'page',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(current.kind, 'page');
  if (current.kind !== 'page') assert.fail('expected the original snapshot page');
  assert.equal(current.snapshotToken, acquired.snapshotToken);
});

test('releasing the current snapshot also releases a pending replacement lease', async () => {
  let generation = 0;
  let replacement = false;
  const releasedLeases: string[] = [];
  const reader = semanticReader({
    readPositionPage: async (request) => {
      const key = { ...snapshotKey, snapshotGeneration: ++generation };
      return replacement
        ? {
            kind: 'building',
            projection: request.projection,
            snapshotKey: key,
            progress: {
              phase: 'legacy',
              nextSequence: 1,
              currentByteOffset: 0,
              sourceRecords: 1,
              sourceBytes: 10,
              builtPositions: 0,
              lastStepRecords: 0,
              lastStepBytes: 0,
              lastStepPositions: 0,
            },
          }
        : {
            kind: 'page',
            projection: request.projection,
            snapshotKey: key,
            startOrdinal: 0,
            totalPositions: 1,
            positions: [{ ordinal: 0, key: { kind: 'empty' }, firstSequence: null }],
            hasOlder: false,
            hasNewer: false,
          };
    },
    releasePositionSnapshot: async (request) => {
      releasedLeases.push(request.snapshotLeaseId);
    },
  });
  const state = createSubscriberSemanticTranscriptState({
    sessionId: 'session-1',
    subscriptionId: 'subscription-1',
    projection: 'owner',
    cursorSecret: Buffer.alloc(32, 0x4a),
  });
  confirmSemanticTranscriptWatermark(state, 5);
  const acquired = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: 'subscription-1',
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(acquired.kind, 'page');
  if (acquired.kind !== 'page') assert.fail('expected a position page');
  replacement = true;
  const building = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'replace',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
      anchor: { kind: 'tail' },
      maxPositions: 1,
    },
  });
  assert.equal(building.kind, 'building');
  const released = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'release',
      subscriptionId: 'subscription-1',
      snapshotToken: acquired.snapshotToken,
    },
  });
  assert.equal(released.kind, 'released');
  assert.equal(releasedLeases.length, 2);
  assert.notEqual(releasedLeases[0], releasedLeases[1]);
});

test('real SQLite snapshots preserve shared privacy, two-slot leases, ABA, and bodyless Turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-semantic-sqlite-'));
  const store = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const reader = semanticReader({
    readPositionPage: (request) => store.readTurnPositionPageSnapshot(request),
    readPositionRecords: (request) => store.readTranscriptRecordsByPositionKeysSnapshot(request),
    releasePositionSnapshot: (request) => store.releaseTurnPositionSnapshot(request),
  });
  const makeState = (sessionId: string, subscriptionId: string, projection: 'owner' | 'shared') =>
    createSubscriberSemanticTranscriptState({
      sessionId,
      subscriptionId,
      projection,
      cursorSecret: Buffer.alloc(32, subscriptionId.length),
    });
  const ready = async (state: ReturnType<typeof makeState>, throughSequence: number | null) => {
    confirmSemanticTranscriptWatermark(state, throughSequence);
    let result = await querySemanticTranscriptPositions({
      reader,
      state,
      request: {
        kind: 'acquire',
        subscriptionId: state.subscriptionId,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      },
    });
    for (let step = 0; result.kind === 'building' && step < 32; step += 1) {
      result = await querySemanticTranscriptPositions({
        reader,
        state,
        request: {
          kind: 'page',
          subscriptionId: state.subscriptionId,
          snapshotToken: result.snapshotToken,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        },
      });
    }
    return result;
  };
  try {
    const hidden = await store.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    await store.appendMessages(hidden.id, [
      {
        type: 'permission_decision',
        id: 'hidden-permission',
        turnId: 'hidden-turn',
        ts: 1,
        toolUseId: 'hidden-tool',
        toolName: 'Read',
        decision: 'deny',
      },
      { type: 'system_note', id: 'hidden-note', ts: 2, kind: 'session_start' },
    ]);
    const sharedFirst = makeState(hidden.id, 'shared-first', 'shared');
    const ownerFirst = makeState(hidden.id, 'owner-first', 'owner');
    const sharedPage = await ready(sharedFirst, 1);
    const ownerPage = await ready(ownerFirst, 1);
    assert.equal(sharedPage.kind, 'page');
    assert.equal(ownerPage.kind, 'page');
    if (sharedPage.kind !== 'page' || ownerPage.kind !== 'page') {
      assert.fail('expected ready owner and shared snapshots');
    }
    assert.deepEqual(sharedPage.positions, [{ ordinal: 0, key: { kind: 'empty' } }]);
    assert.deepEqual(ownerPage.positions, [
      { ordinal: 0, key: { kind: 'turn', id: 'hidden-turn' } },
    ]);
    assert.equal(
      sharedFirst.currentSnapshot?.key?.snapshotGeneration,
      ownerFirst.currentSnapshot?.key?.snapshotGeneration,
    );

    await store.appendMessage(hidden.id, {
      type: 'system_note',
      id: 'visible-note',
      ts: 3,
      kind: 'context_compacted',
    });
    const sharedSecond = makeState(hidden.id, 'shared-second', 'shared');
    const secondPage = await ready(sharedSecond, 2);
    assert.equal(secondPage.kind, 'page');
    if (secondPage.kind !== 'page') assert.fail('expected a second exact generation');
    assert.deepEqual(secondPage.positions, [
      { ordinal: 0, key: { kind: 'note', id: 'visible-note' } },
    ]);
    const secondGeneration = sharedSecond.currentSnapshot?.key?.snapshotGeneration;

    await store.appendMessage(hidden.id, {
      type: 'system_note',
      id: 'visible-note-2',
      ts: 4,
      kind: 'step_limit',
    });
    const sharedThird = makeState(hidden.id, 'shared-third', 'shared');
    assert.equal((await ready(sharedThird, 3)).kind, 'capacity');
    await releaseSubscriberSemanticTranscript(reader, sharedFirst);
    assert.equal((await ready(sharedThird, 3)).kind, 'capacity');
    await releaseSubscriberSemanticTranscript(reader, ownerFirst);
    const thirdPage = await ready(sharedThird, 3);
    assert.equal(thirdPage.kind, 'page');
    if (thirdPage.kind !== 'page') assert.fail('expected capacity release to admit a generation');
    assert.ok(
      (sharedThird.currentSnapshot?.key?.snapshotGeneration ?? 0) > (secondGeneration ?? 0),
    );

    const bodyless = await store.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    await runs.admitRootTurn({
      sessionId: bodyless.id,
      turnId: 'bodyless-turn',
      proposedRunId: 'bodyless-run',
      proposedUserMessageId: 'bodyless-user',
      execution: { kind: 'external_message' },
      previousRootTurnId: null,
      normalizedInput: { text: 'future body' },
      sourceMessages: [],
      admittedAt: 10,
    });
    const bodylessOwner = makeState(bodyless.id, 'bodyless-owner', 'owner');
    const bodylessPage = await ready(bodylessOwner, null);
    assert.equal(bodylessPage.kind, 'page');
    if (bodylessPage.kind !== 'page') assert.fail('expected a bodyless Turn position');
    assert.deepEqual(bodylessPage.positions, [
      { ordinal: 0, key: { kind: 'turn', id: 'bodyless-turn' } },
    ]);
    const bodylessWindow = await readSemanticTranscriptTurnWindow({
      reader,
      state: bodylessOwner,
      request: {
        kind: 'open',
        subscriptionId: bodylessOwner.subscriptionId,
        snapshotToken: bodylessPage.snapshotToken,
        startOrdinal: 0,
        maxPositions: 1,
      },
    });
    assert.equal(bodylessWindow.kind, 'page');
    if (bodylessWindow.kind !== 'page') assert.fail('expected a bodyless semantic window');
    assert.deepEqual(
      JSON.parse(Buffer.from(bodylessWindow.data, 'base64').toString('utf8')).positions,
      [{ position: { ordinal: 0, key: { kind: 'turn', id: 'bodyless-turn' } }, messages: [] }],
    );

    await releaseSubscriberSemanticTranscript(reader, sharedSecond);
    await releaseSubscriberSemanticTranscript(reader, sharedThird);
    await releaseSubscriberSemanticTranscript(reader, bodylessOwner);
  } finally {
    runs.close?.();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

function semanticReader(overrides: Partial<SessionTranscriptReader>): SessionTranscriptReader {
  return {
    readDurableHighWater: async () => 5,
    readDurablePage: async () => ({
      throughSequence: 5,
      fragments: [],
      rawBytes: 0,
      next: null,
    }),
    readDurableRecords: async () => ({
      throughSequence: 5,
      records: [],
      nextPosition: null,
    }),
    readDurableMessagesById: async () => [],
    readActiveOverlay: async () => [],
    readPositionPage: async () => {
      throw new Error('not configured');
    },
    readPositionRecords: async () => {
      throw new Error('not configured');
    },
    releasePositionSnapshot: async () => undefined,
    ...overrides,
  };
}
