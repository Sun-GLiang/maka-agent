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

import { createHash, randomUUID } from 'node:crypto';
import type { StoredMessage } from '@maka/core/session';
import {
  SessionTurnPositionAnchorNotFoundError,
  SessionTurnPositionLimitError,
  SessionTurnPositionSnapshotMismatchError,
  SESSION_TURN_POSITION_BODY_MAX_BYTES,
  SESSION_TURN_POSITION_BODY_MAX_RECORDS,
  type SessionTranscriptProjection,
  type SessionTranscriptPositionKey,
  type SessionTurnPositionAnchor,
  type SessionTurnPositionSnapshotKey,
} from '@maka/storage/execution-stores';
import {
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  SESSION_TRANSCRIPT_WINDOW_MAX_POSITIONS,
  type SessionTranscriptPositionsInput,
  type SessionTranscriptPositionsResult,
  type SessionTranscriptTurnWindowInput,
  type SessionTranscriptTurnWindowResult,
} from '../protocol/index.js';
import { projectSharedSessionTranscriptMessage } from './shared-session-transcript.js';
import type { SessionTranscriptReader } from './session-transcript-reader.js';
import {
  decodeTranscriptSignedToken,
  encodeTranscriptSignedToken,
} from './transcript-signed-token.js';
import { selectTranscriptBuffer } from './transcript-buffer-slice.js';

const SEMANTIC_RETRY_AFTER_MS = 50;
export const SEMANTIC_TRANSCRIPT_WINDOW_IDLE_TTL_MS = 5 * 60 * 1_000;

interface SemanticSnapshot {
  readonly handleId: string;
  readonly incarnation: string;
  readonly token: string;
  readonly leaseId: string;
  key?: SessionTurnPositionSnapshotKey;
}

interface RetainedSemanticWindow {
  readonly id: string;
  readonly incarnation: string;
  readonly snapshotTokenDigest: string;
  readonly bytes: Buffer;
  readonly digest: `sha256:${string}`;
  currentCursor: string | null;
  retained: boolean;
  expiry?: NodeJS.Timeout;
}

export interface SubscriberSemanticTranscriptState {
  readonly sessionId: string;
  readonly subscriptionId: string;
  readonly projection: SessionTranscriptProjection;
  readonly cursorSecret: Buffer;
  semanticEligibleThroughSequence: number | null | undefined;
  currentSnapshot?: SemanticSnapshot;
  pendingSnapshot?: SemanticSnapshot;
  activeWindow?: RetainedSemanticWindow;
  closed: boolean;
  releaseTail: Promise<void>;
}

export interface SemanticTranscriptRetainedAccounting {
  retain(bytes: number): boolean;
  release(bytes: number): void;
}

export class SemanticTranscriptRequestError extends Error {
  readonly name = 'SemanticTranscriptRequestError';
}

export class SemanticTranscriptConflictError extends Error {
  readonly name = 'SemanticTranscriptConflictError';
}

export function createSubscriberSemanticTranscriptState(input: {
  sessionId: string;
  subscriptionId: string;
  projection: SessionTranscriptProjection;
  cursorSecret: Buffer;
}): SubscriberSemanticTranscriptState {
  return {
    ...input,
    semanticEligibleThroughSequence: undefined,
    closed: false,
    releaseTail: Promise.resolve(),
  };
}

export function confirmSemanticTranscriptWatermark(
  state: SubscriberSemanticTranscriptState,
  throughSequence: number | null,
): void {
  const current = state.semanticEligibleThroughSequence;
  if (
    current !== undefined &&
    current !== null &&
    throughSequence !== null &&
    throughSequence < current
  ) {
    throw new Error('Session semantic transcript watermark moved backwards');
  }
  state.semanticEligibleThroughSequence = throughSequence;
}

export async function querySemanticTranscriptPositions(input: {
  reader: SessionTranscriptReader;
  state: SubscriberSemanticTranscriptState;
  request: SessionTranscriptPositionsInput;
  accounting?: SemanticTranscriptRetainedAccounting;
}): Promise<SessionTranscriptPositionsResult> {
  const { reader, state, request } = input;
  assertSubscription(state, request.subscriptionId);
  if (state.closed) throw new SemanticTranscriptRequestError('Semantic transcript is closed');
  if (state.semanticEligibleThroughSequence === undefined) {
    throw new SemanticTranscriptRequestError('Semantic transcript is not active');
  }
  if (request.kind === 'release') {
    if (state.currentSnapshot?.token !== request.snapshotToken) {
      decodeExactToken('snapshot', request.snapshotToken, state);
      return { kind: 'released', subscriptionId: state.subscriptionId };
    }
    const snapshot = requireSnapshotToken(state, request.snapshotToken, 'current');
    await releaseSnapshot(reader, state, snapshot, input.accounting);
    return { kind: 'released', subscriptionId: state.subscriptionId };
  }
  if (request.kind === 'continue') {
    const cursor = decodePositionsCursor(request.cursor, state);
    const snapshot = state.currentSnapshot;
    if (!snapshot || tokenDigest(snapshot.token) !== cursor.snapshotTokenDigest) {
      throw new SemanticTranscriptRequestError('Positions cursor snapshot is stale');
    }
    const result = await readPositionPage(
      reader,
      state,
      snapshot,
      {
        kind: 'ordinal',
        ordinal: cursor.nextOrdinal,
      },
      cursor.maxPositions,
    );
    clearWindowForStaleResult(state, result, input.accounting);
    return result;
  }
  if (request.kind === 'replace') {
    if (state.currentSnapshot?.token !== request.snapshotToken) {
      decodeExactToken('snapshot', request.snapshotToken, state);
      return {
        kind: 'snapshot_stale',
        subscriptionId: state.subscriptionId,
        snapshotToken: request.snapshotToken,
      };
    }
    const current = requireSnapshotToken(state, request.snapshotToken, 'current');
    const pending = state.pendingSnapshot ?? createSnapshot(state);
    state.pendingSnapshot = pending;
    let result: SessionTranscriptPositionsResult;
    try {
      result = await readPositionPage(reader, state, pending, request.anchor, request.maxPositions);
    } catch (error) {
      await releaseSpecificSnapshotSerialized(reader, state, pending);
      state.pendingSnapshot = undefined;
      throw error;
    }
    if (result.kind === 'page') {
      if (state.currentSnapshot !== current) {
        await releaseSpecificSnapshotSerialized(reader, state, pending);
        state.pendingSnapshot = undefined;
        throw new SemanticTranscriptConflictError('Semantic snapshot replacement lost its race');
      }
      await releaseSpecificSnapshotSerialized(reader, state, current);
      if (state.closed) {
        await releaseSubscriberSemanticTranscript(reader, state, input.accounting);
        throw new SemanticTranscriptRequestError('Semantic transcript is closed');
      }
      state.currentSnapshot = pending;
      state.pendingSnapshot = undefined;
      if (state.activeWindow) {
        releaseWindow(state.activeWindow, input.accounting);
        state.activeWindow = undefined;
      }
    } else if (result.kind === 'snapshot_stale' || result.kind === 'anchor_not_found') {
      await releaseSpecificSnapshotSerialized(reader, state, pending);
      state.pendingSnapshot = undefined;
    }
    return result;
  }
  let snapshot: SemanticSnapshot;
  if (request.kind === 'acquire') {
    snapshot = state.currentSnapshot ?? createSnapshot(state);
    state.currentSnapshot ??= snapshot;
  } else {
    if (state.currentSnapshot?.token !== request.snapshotToken) {
      decodeExactToken('snapshot', request.snapshotToken, state);
      return {
        kind: 'snapshot_stale',
        subscriptionId: state.subscriptionId,
        snapshotToken: request.snapshotToken,
      };
    }
    snapshot = requireSnapshotToken(state, request.snapshotToken, 'current');
  }
  const result = await readPositionPage(
    reader,
    state,
    snapshot,
    request.anchor,
    request.maxPositions,
  );
  clearWindowForStaleResult(state, result, input.accounting);
  return result;
}

export async function readSemanticTranscriptTurnWindow(input: {
  reader: SessionTranscriptReader;
  state: SubscriberSemanticTranscriptState;
  request: SessionTranscriptTurnWindowInput;
  fragmentBytes?: number;
  accounting?: SemanticTranscriptRetainedAccounting;
}): Promise<SessionTranscriptTurnWindowResult> {
  const { state, request } = input;
  assertSubscription(state, request.subscriptionId);
  if (state.closed) throw new SemanticTranscriptRequestError('Semantic transcript is closed');
  const fragmentBytes = input.fragmentBytes ?? SESSION_TRANSCRIPT_PAGE_MAX_BYTES;
  if (request.kind === 'continue') {
    const cursor = decodeWindowCursor(request.cursor, state);
    const window = state.activeWindow;
    if (
      !window ||
      window.id !== cursor.windowId ||
      window.incarnation !== cursor.incarnation ||
      window.snapshotTokenDigest !== cursor.snapshotTokenDigest ||
      window.currentCursor !== request.cursor
    ) {
      throw new SemanticTranscriptRequestError('Window cursor is stale');
    }
    return sliceWindow(state, window, cursor.offset, fragmentBytes, input.accounting);
  }
  if (state.currentSnapshot?.token !== request.snapshotToken) {
    decodeExactToken('snapshot', request.snapshotToken, state);
    return {
      kind: 'snapshot_stale',
      subscriptionId: state.subscriptionId,
      snapshotToken: request.snapshotToken,
    };
  }
  const snapshot = requireSnapshotToken(state, request.snapshotToken, 'current');
  if (!snapshot.key) {
    return {
      kind: 'snapshot_stale',
      subscriptionId: state.subscriptionId,
      snapshotToken: snapshot.token,
    };
  }
  const oldWindow = state.activeWindow;
  if (oldWindow) {
    if (
      typeof request.replaceCursor !== 'string' ||
      oldWindow.currentCursor !== request.replaceCursor
    ) {
      throw new SemanticTranscriptRequestError(
        'Active semantic window requires its current cursor',
      );
    }
    decodeWindowCursor(request.replaceCursor, state);
  } else if (request.replaceCursor != null) {
    throw new SemanticTranscriptRequestError('Semantic window replacement cursor is stale');
  }
  const prepared = await prepareWindow(input.reader, state, snapshot, request);
  if (prepared.kind !== 'ready') {
    if (prepared.result.kind === 'snapshot_stale' && state.activeWindow) {
      releaseWindow(state.activeWindow, input.accounting);
      state.activeWindow = undefined;
    }
    return prepared.result;
  }
  if (state.closed) throw new SemanticTranscriptRequestError('Semantic transcript is closed');
  if (input.accounting && !input.accounting.retain(prepared.window.bytes.byteLength)) {
    return {
      kind: 'capacity',
      subscriptionId: state.subscriptionId,
      snapshotToken: snapshot.token,
      retryAfterMs: SEMANTIC_RETRY_AFTER_MS,
    };
  }
  prepared.window.retained = input.accounting !== undefined;
  state.activeWindow = prepared.window;
  if (oldWindow) releaseWindow(oldWindow, input.accounting);
  return sliceWindow(state, prepared.window, 0, fragmentBytes, input.accounting);
}

export function releaseSubscriberSemanticTranscript(
  reader: SessionTranscriptReader,
  state: SubscriberSemanticTranscriptState,
  accounting?: SemanticTranscriptRetainedAccounting,
): Promise<void> {
  state.closed = true;
  const release = async () => {
    if (state.activeWindow) {
      releaseWindow(state.activeWindow, accounting);
      state.activeWindow = undefined;
    }
    const failures: unknown[] = [];
    for (const [property, snapshot] of [
      ['pendingSnapshot', state.pendingSnapshot],
      ['currentSnapshot', state.currentSnapshot],
    ] as const) {
      if (!snapshot?.key) continue;
      try {
        await releaseSpecificSnapshot(reader, state, snapshot);
        if (state[property] === snapshot) state[property] = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to release semantic transcript snapshots');
    }
  };
  const task = state.releaseTail.then(release, release);
  state.releaseTail = task.catch(() => undefined);
  return task;
}

async function readPositionPage(
  reader: SessionTranscriptReader,
  state: SubscriberSemanticTranscriptState,
  snapshot: SemanticSnapshot,
  anchor: SessionTurnPositionAnchor,
  maxPositions: number,
): Promise<SessionTranscriptPositionsResult> {
  try {
    const result = await reader.readPositionPage({
      sessionId: state.sessionId,
      projection: state.projection,
      snapshotLeaseId: snapshot.leaseId,
      ...(snapshot.key
        ? { snapshotKey: snapshot.key }
        : { throughSequence: state.semanticEligibleThroughSequence ?? null }),
      anchor,
      maxPositions,
    });
    if (result.kind !== 'capacity') snapshot.key = result.snapshotKey;
    if (state.closed) {
      await releaseSubscriberSemanticTranscript(reader, state);
      throw new SemanticTranscriptRequestError('Semantic transcript is closed');
    }
    if (result.kind === 'building') {
      return {
        kind: 'building',
        subscriptionId: state.subscriptionId,
        snapshotToken: snapshot.token,
        retryAfterMs: SEMANTIC_RETRY_AFTER_MS,
      };
    }
    if (result.kind === 'capacity') {
      return {
        kind: 'capacity',
        subscriptionId: state.subscriptionId,
        snapshotToken: snapshot.token,
        retryAfterMs: SEMANTIC_RETRY_AFTER_MS,
      };
    }
    const positions = result.positions.map(({ ordinal, key }) => ({ ordinal, key }));
    const digest = tokenDigest(snapshot.token);
    const olderOrdinal = Math.max(0, result.startOrdinal - maxPositions);
    const olderMaxPositions = result.startOrdinal - olderOrdinal;
    const newerOrdinal = result.startOrdinal + positions.length;
    return {
      kind: 'page',
      subscriptionId: state.subscriptionId,
      snapshotToken: snapshot.token,
      totalPositions: result.totalPositions,
      startOrdinal: result.startOrdinal,
      positions,
      olderCursor: result.hasOlder
        ? encodePositionsCursor(state, digest, 'older', olderOrdinal, olderMaxPositions)
        : null,
      newerCursor: result.hasNewer
        ? encodePositionsCursor(state, digest, 'newer', newerOrdinal, maxPositions)
        : null,
    };
  } catch (error) {
    if (error instanceof SessionTurnPositionSnapshotMismatchError) {
      snapshot.key = undefined;
      if (state.currentSnapshot === snapshot) state.currentSnapshot = undefined;
      if (state.pendingSnapshot === snapshot) state.pendingSnapshot = undefined;
      return {
        kind: 'snapshot_stale',
        subscriptionId: state.subscriptionId,
        snapshotToken: snapshot.token,
      };
    }
    if (error instanceof SessionTurnPositionAnchorNotFoundError) {
      return {
        kind: 'anchor_not_found',
        subscriptionId: state.subscriptionId,
        snapshotToken: snapshot.token,
      };
    }
    throw error;
  }
}

async function prepareWindow(
  reader: SessionTranscriptReader,
  state: SubscriberSemanticTranscriptState,
  snapshot: SemanticSnapshot,
  request: Extract<SessionTranscriptTurnWindowInput, { readonly kind: 'open' }>,
): Promise<
  | { readonly kind: 'ready'; readonly window: RetainedSemanticWindow }
  | { readonly kind: 'result'; readonly result: SessionTranscriptTurnWindowResult }
> {
  let page;
  try {
    page = await reader.readPositionPage({
      sessionId: state.sessionId,
      projection: state.projection,
      snapshotLeaseId: snapshot.leaseId,
      snapshotKey: snapshot.key!,
      anchor: { kind: 'ordinal', ordinal: request.startOrdinal },
      maxPositions: Math.min(request.maxPositions, SESSION_TRANSCRIPT_WINDOW_MAX_POSITIONS),
    });
    if (state.closed) throw new SemanticTranscriptRequestError('Semantic transcript is closed');
  } catch (error) {
    if (error instanceof SessionTurnPositionSnapshotMismatchError) {
      snapshot.key = undefined;
      if (state.currentSnapshot === snapshot) state.currentSnapshot = undefined;
      return { kind: 'result', result: simpleWindowResult('snapshot_stale', state, snapshot) };
    }
    if (error instanceof SessionTurnPositionAnchorNotFoundError) {
      return { kind: 'result', result: simpleWindowResult('anchor_not_found', state, snapshot) };
    }
    throw error;
  }
  if (page.kind === 'building' || page.kind === 'capacity') {
    return {
      kind: 'result',
      result: {
        kind: page.kind,
        subscriptionId: state.subscriptionId,
        snapshotToken: snapshot.token,
        retryAfterMs: SEMANTIC_RETRY_AFTER_MS,
      },
    };
  }
  const encodedPositions: Buffer[] = [];
  let acceptedStartOrdinal: number | undefined;
  let acceptedEndOrdinalExclusive: number | undefined;
  let remainingRecords = SESSION_TURN_POSITION_BODY_MAX_RECORDS;
  let remainingBytes = SESSION_TURN_POSITION_BODY_MAX_BYTES;
  for (const position of page.positions) {
    if (position.key.kind === 'empty') {
      const encodedPosition = encodeSemanticPosition({
        position: { ordinal: position.ordinal, key: position.key },
        messages: [],
      });
      if (
        !semanticWindowFits(
          snapshot.token,
          page.totalPositions,
          encodedPositions,
          encodedPosition,
          acceptedStartOrdinal ?? position.ordinal,
          position.ordinal + 1,
        )
      ) {
        if (encodedPositions.length === 0) {
          return {
            kind: 'result',
            result: simpleWindowResult('position_too_large', state, snapshot),
          };
        }
        break;
      }
      encodedPositions.push(encodedPosition);
      acceptedStartOrdinal ??= position.ordinal;
      acceptedEndOrdinalExclusive = position.ordinal + 1;
      continue;
    }
    if (remainingRecords < 1 || remainingBytes < 1) break;
    try {
      const body = await reader.readPositionRecords({
        sessionId: state.sessionId,
        projection: state.projection,
        snapshotLeaseId: snapshot.leaseId,
        snapshotKey: snapshot.key!,
        positionKeys: [position.key],
        maxBytes: remainingBytes,
        maxRecords: remainingRecords,
      });
      if (state.closed) throw new SemanticTranscriptRequestError('Semantic transcript is closed');
      if (
        body.rawBytes < 0 ||
        body.rawBytes > remainingBytes ||
        body.records.length > remainingRecords
      ) {
        throw new Error('Semantic transcript position body exceeded its requested budget');
      }
      let previousSequence = -1;
      const messages: StoredMessage[] = [];
      for (const record of body.records) {
        if (
          !samePositionKey(record.positionKey, position.key) ||
          record.sequence <= previousSequence
        ) {
          throw new Error('Semantic transcript position body order changed');
        }
        previousSequence = record.sequence;
        const message =
          state.projection === 'shared'
            ? projectSharedSessionTranscriptMessage(record.message, state.sessionId)
            : record.message;
        if (message) messages.push(message);
      }
      const encodedPosition = encodeSemanticPosition({
        position: { ordinal: position.ordinal, key: position.key },
        messages,
      });
      if (
        !semanticWindowFits(
          snapshot.token,
          page.totalPositions,
          encodedPositions,
          encodedPosition,
          acceptedStartOrdinal ?? position.ordinal,
          position.ordinal + 1,
        )
      ) {
        if (encodedPositions.length === 0) {
          return {
            kind: 'result',
            result: simpleWindowResult('position_too_large', state, snapshot),
          };
        }
        break;
      }
      encodedPositions.push(encodedPosition);
      acceptedStartOrdinal ??= position.ordinal;
      acceptedEndOrdinalExclusive = position.ordinal + 1;
      remainingRecords -= body.records.length;
      remainingBytes -= body.rawBytes;
    } catch (error) {
      if (
        error instanceof SessionTurnPositionLimitError &&
        (error.reason === 'transcript_record_bytes' || error.reason === 'transcript_record_count')
      ) {
        if (encodedPositions.length === 0) {
          return {
            kind: 'result',
            result: simpleWindowResult('position_too_large', state, snapshot),
          };
        }
        break;
      }
      if (error instanceof SessionTurnPositionSnapshotMismatchError) {
        snapshot.key = undefined;
        if (state.currentSnapshot === snapshot) state.currentSnapshot = undefined;
        return { kind: 'result', result: simpleWindowResult('snapshot_stale', state, snapshot) };
      }
      throw error;
    }
  }
  if (
    encodedPositions.length === 0 ||
    acceptedStartOrdinal === undefined ||
    acceptedEndOrdinalExclusive === undefined
  ) {
    return { kind: 'result', result: simpleWindowResult('position_too_large', state, snapshot) };
  }
  const encoded = encodeSemanticWindow(
    snapshot.token,
    page.totalPositions,
    acceptedStartOrdinal,
    acceptedEndOrdinalExclusive,
    encodedPositions,
  );
  const digest = `sha256:${createHash('sha256').update(encoded).digest('hex')}` as const;
  return {
    kind: 'ready',
    window: {
      id: randomUUID(),
      incarnation: randomUUID(),
      snapshotTokenDigest: tokenDigest(snapshot.token),
      bytes: encoded,
      digest,
      currentCursor: null,
      retained: false,
    },
  };
}

function sliceWindow(
  state: SubscriberSemanticTranscriptState,
  window: RetainedSemanticWindow,
  offset: number,
  fragmentBytes: number,
  accounting: SemanticTranscriptRetainedAccounting | undefined,
): SessionTranscriptTurnWindowResult {
  if (offset < 0 || offset >= window.bytes.byteLength || fragmentBytes < 1) {
    throw new SemanticTranscriptRequestError('Invalid semantic window offset');
  }
  const selected = selectTranscriptBuffer(
    window.bytes,
    'newer',
    offset,
    fragmentBytes,
    () => new SemanticTranscriptRequestError('Invalid semantic window offset'),
  );
  if (!selected) throw new SemanticTranscriptRequestError('Invalid semantic window byte budget');
  const end = selected.nextOffset;
  const nextCursor =
    end === window.bytes.byteLength ? null : encodeWindowCursor(state, window, end);
  window.currentCursor = nextCursor;
  const result: SessionTranscriptTurnWindowResult = {
    kind: 'page',
    subscriptionId: state.subscriptionId,
    snapshotToken: state.currentSnapshot!.token,
    windowId: window.id,
    byteOffset: offset,
    totalBytes: window.bytes.byteLength,
    payloadDigest: window.digest,
    data: selected.data.toString('base64'),
    nextCursor,
  };
  if (nextCursor === null) {
    releaseWindow(window, accounting);
    if (state.activeWindow === window) state.activeWindow = undefined;
  } else {
    armWindowExpiry(state, window, accounting);
  }
  return result;
}

function armWindowExpiry(
  state: SubscriberSemanticTranscriptState,
  window: RetainedSemanticWindow,
  accounting: SemanticTranscriptRetainedAccounting | undefined,
): void {
  if (window.expiry) clearTimeout(window.expiry);
  window.expiry = setTimeout(() => {
    if (state.activeWindow !== window) return;
    releaseWindow(window, accounting);
    state.activeWindow = undefined;
  }, SEMANTIC_TRANSCRIPT_WINDOW_IDLE_TTL_MS);
  window.expiry.unref();
}

async function releaseSnapshot(
  reader: SessionTranscriptReader,
  state: SubscriberSemanticTranscriptState,
  snapshot: SemanticSnapshot,
  accounting: SemanticTranscriptRetainedAccounting | undefined,
): Promise<void> {
  const pending = state.pendingSnapshot;
  if (pending && pending !== snapshot) {
    await releaseSpecificSnapshotSerialized(reader, state, pending);
    if (state.pendingSnapshot === pending) state.pendingSnapshot = undefined;
  }
  await releaseSpecificSnapshotSerialized(reader, state, snapshot);
  if (state.activeWindow) {
    releaseWindow(state.activeWindow, accounting);
    state.activeWindow = undefined;
  }
  if (state.currentSnapshot === snapshot) state.currentSnapshot = undefined;
  if (state.pendingSnapshot === snapshot) state.pendingSnapshot = undefined;
}

async function releaseSpecificSnapshot(
  reader: SessionTranscriptReader,
  state: SubscriberSemanticTranscriptState,
  snapshot: SemanticSnapshot,
): Promise<void> {
  if (!snapshot.key) return;
  const key = snapshot.key;
  await reader.releasePositionSnapshot({
    sessionId: state.sessionId,
    projection: state.projection,
    snapshotLeaseId: snapshot.leaseId,
    snapshotKey: key,
  });
  if (snapshot.key === key) snapshot.key = undefined;
}

function releaseSpecificSnapshotSerialized(
  reader: SessionTranscriptReader,
  state: SubscriberSemanticTranscriptState,
  snapshot: SemanticSnapshot,
): Promise<void> {
  const release = () => releaseSpecificSnapshot(reader, state, snapshot);
  const task = state.releaseTail.then(release, release);
  state.releaseTail = task.catch(() => undefined);
  return task;
}

function releaseWindow(
  window: RetainedSemanticWindow,
  accounting: SemanticTranscriptRetainedAccounting | undefined,
): void {
  if (window.expiry) {
    clearTimeout(window.expiry);
    window.expiry = undefined;
  }
  if (!window.retained) return;
  window.retained = false;
  accounting?.release(window.bytes.byteLength);
}

function clearWindowForStaleResult(
  state: SubscriberSemanticTranscriptState,
  result: SessionTranscriptPositionsResult,
  accounting: SemanticTranscriptRetainedAccounting | undefined,
): void {
  if (result.kind !== 'snapshot_stale' || !state.activeWindow) return;
  releaseWindow(state.activeWindow, accounting);
  state.activeWindow = undefined;
}

function createSnapshot(state: SubscriberSemanticTranscriptState): SemanticSnapshot {
  const handleId = randomUUID();
  const incarnation = randomUUID();
  return {
    handleId,
    incarnation,
    leaseId: randomUUID(),
    token: encodeTranscriptSignedToken(
      'snapshot',
      { version: 1, handleId, incarnation },
      state.cursorSecret,
    ),
  };
}

function requireSnapshotToken(
  state: SubscriberSemanticTranscriptState,
  token: string,
  expected: 'current' | 'pending',
): SemanticSnapshot {
  const decoded = decodeExactToken('snapshot', token, state);
  const snapshot = expected === 'current' ? state.currentSnapshot : state.pendingSnapshot;
  if (
    typeof decoded.handleId !== 'string' ||
    typeof decoded.incarnation !== 'string' ||
    !snapshot ||
    decoded.handleId !== snapshot.handleId ||
    decoded.incarnation !== snapshot.incarnation ||
    token !== snapshot.token
  ) {
    throw new SemanticTranscriptRequestError('Semantic snapshot token is stale');
  }
  return snapshot;
}

function encodePositionsCursor(
  state: SubscriberSemanticTranscriptState,
  snapshotTokenDigest: string,
  direction: 'older' | 'newer',
  nextOrdinal: number,
  maxPositions: number,
): string {
  return encodeTranscriptSignedToken(
    'positions',
    {
      version: 1,
      subscriptionId: state.subscriptionId,
      snapshotTokenDigest,
      direction,
      nextOrdinal,
      maxPositions,
    },
    state.cursorSecret,
  );
}

function decodePositionsCursor(
  value: string,
  state: SubscriberSemanticTranscriptState,
): {
  snapshotTokenDigest: string;
  direction: 'older' | 'newer';
  nextOrdinal: number;
  maxPositions: number;
} {
  const decoded = decodeExactToken('positions', value, state);
  if (
    typeof decoded.snapshotTokenDigest !== 'string' ||
    (decoded.direction !== 'older' && decoded.direction !== 'newer') ||
    !isCount(decoded.nextOrdinal) ||
    !isCount(decoded.maxPositions)
  ) {
    throw new SemanticTranscriptRequestError('Invalid positions cursor');
  }
  return decoded as {
    snapshotTokenDigest: string;
    direction: 'older' | 'newer';
    nextOrdinal: number;
    maxPositions: number;
  };
}

function encodeWindowCursor(
  state: SubscriberSemanticTranscriptState,
  window: RetainedSemanticWindow,
  offset: number,
): string {
  return encodeTranscriptSignedToken(
    'window',
    {
      version: 1,
      subscriptionId: state.subscriptionId,
      snapshotTokenDigest: window.snapshotTokenDigest,
      windowId: window.id,
      incarnation: window.incarnation,
      offset,
    },
    state.cursorSecret,
  );
}

function decodeWindowCursor(
  value: string,
  state: SubscriberSemanticTranscriptState,
): {
  snapshotTokenDigest: string;
  windowId: string;
  incarnation: string;
  offset: number;
} {
  const decoded = decodeExactToken('window', value, state);
  if (
    typeof decoded.snapshotTokenDigest !== 'string' ||
    typeof decoded.windowId !== 'string' ||
    typeof decoded.incarnation !== 'string' ||
    !isCount(decoded.offset)
  ) {
    throw new SemanticTranscriptRequestError('Invalid semantic window cursor');
  }
  return decoded as {
    snapshotTokenDigest: string;
    windowId: string;
    incarnation: string;
    offset: number;
  };
}

function decodeExactToken(
  domain: 'snapshot' | 'positions' | 'window',
  value: string,
  state: SubscriberSemanticTranscriptState,
): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = decodeTranscriptSignedToken(domain, value, state.cursorSecret);
  } catch (cause) {
    throw new SemanticTranscriptRequestError('Invalid semantic transcript token', { cause });
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new SemanticTranscriptRequestError('Invalid semantic transcript token');
  }
  const record = decoded as Record<string, unknown>;
  const keys =
    domain === 'snapshot'
      ? ['version', 'handleId', 'incarnation']
      : domain === 'positions'
        ? [
            'version',
            'subscriptionId',
            'snapshotTokenDigest',
            'direction',
            'nextOrdinal',
            'maxPositions',
          ]
        : ['version', 'subscriptionId', 'snapshotTokenDigest', 'windowId', 'incarnation', 'offset'];
  if (
    record.version !== 1 ||
    (domain !== 'snapshot' && record.subscriptionId !== state.subscriptionId) ||
    (domain === 'snapshot' &&
      (typeof record.handleId !== 'string' || typeof record.incarnation !== 'string')) ||
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new SemanticTranscriptRequestError(
      'Semantic transcript token does not match subscription',
    );
  }
  return record;
}

function simpleWindowResult(
  kind: 'snapshot_stale' | 'anchor_not_found' | 'position_too_large',
  state: SubscriberSemanticTranscriptState,
  snapshot: SemanticSnapshot,
): SessionTranscriptTurnWindowResult {
  return {
    kind,
    subscriptionId: state.subscriptionId,
    snapshotToken: snapshot.token,
  };
}

function encodeSemanticPosition(value: {
  readonly position: { readonly ordinal: number; readonly key: SessionTranscriptPositionKey };
  readonly messages: readonly StoredMessage[];
}): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function semanticWindowFits(
  snapshotToken: string,
  totalPositions: number,
  accepted: readonly Buffer[],
  candidate: Buffer,
  startOrdinal: number,
  endOrdinalExclusive: number,
): boolean {
  const { prefix, suffix } = semanticWindowEnvelope(
    snapshotToken,
    totalPositions,
    startOrdinal,
    endOrdinalExclusive,
  );
  const positionsBytes =
    accepted.reduce((total, position) => total + position.byteLength, 0) + candidate.byteLength;
  const separators = accepted.length;
  return (
    prefix.byteLength + positionsBytes + separators + suffix.byteLength <=
    SESSION_TURN_POSITION_BODY_MAX_BYTES
  );
}

function encodeSemanticWindow(
  snapshotToken: string,
  totalPositions: number,
  startOrdinal: number,
  endOrdinalExclusive: number,
  positions: readonly Buffer[],
): Buffer {
  const { prefix, suffix } = semanticWindowEnvelope(
    snapshotToken,
    totalPositions,
    startOrdinal,
    endOrdinalExclusive,
  );
  const fragments: Buffer[] = [prefix];
  for (const [index, position] of positions.entries()) {
    if (index > 0) fragments.push(Buffer.from(','));
    fragments.push(position);
  }
  fragments.push(suffix);
  return Buffer.concat(fragments);
}

function semanticWindowEnvelope(
  snapshotToken: string,
  totalPositions: number,
  startOrdinal: number,
  endOrdinalExclusive: number,
): { readonly prefix: Buffer; readonly suffix: Buffer } {
  return {
    prefix: Buffer.from(
      `{"snapshotToken":${JSON.stringify(snapshotToken)},"startOrdinal":${startOrdinal},"endOrdinalExclusive":${endOrdinalExclusive},"totalPositions":${totalPositions},"positions":[`,
      'utf8',
    ),
    suffix: Buffer.from(
      `],"hasOlder":${startOrdinal > 0},"hasNewer":${endOrdinalExclusive < totalPositions}}`,
      'utf8',
    ),
  };
}

function samePositionKey(
  left: Exclude<SessionTranscriptPositionKey, { readonly kind: 'empty' }>,
  right: SessionTranscriptPositionKey,
): boolean {
  return right.kind !== 'empty' && left.kind === right.kind && left.id === right.id;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function assertSubscription(
  state: SubscriberSemanticTranscriptState,
  subscriptionId: string,
): void {
  if (state.subscriptionId !== subscriptionId) {
    throw new SemanticTranscriptRequestError('Semantic transcript subscription changed');
  }
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
