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

import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES = 16 * 1024;
export const SESSION_TRANSCRIPT_PAGE_MAX_BYTES = 512 * 1024;
export const SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES = 256;
export const SESSION_TRANSCRIPT_RANGE_MAX_BYTES = 16 * 1024 * 1024;
export const SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES = SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES;
export const SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES = 4_096;
export const SESSION_TRANSCRIPT_PAGE_RESULT_MAX_BYTES = 744 * 1024;
export const SESSION_TRANSCRIPT_CURSOR_MAX_BYTES = 1024;
export const SESSION_TRANSCRIPT_POSITION_PAGE_MAX_POSITIONS = 128;
export const SESSION_TRANSCRIPT_POSITION_PAGE_MAX_BYTES = 64 * 1024;
export const SESSION_TRANSCRIPT_WINDOW_MAX_POSITIONS = 10;
export const SESSION_TRANSCRIPT_WINDOW_MAX_BYTES = 16 * 1024 * 1024;

export type SessionTranscriptSemanticPositionKey =
  | { readonly kind: 'turn'; readonly id: string }
  | { readonly kind: 'note'; readonly id: string }
  | { readonly kind: 'empty' };

export interface SessionTranscriptSemanticPosition {
  readonly ordinal: number;
  readonly key: SessionTranscriptSemanticPositionKey;
}

export type SessionTranscriptVisiblePositionAnchor =
  | { readonly kind: 'tail' }
  | { readonly kind: 'ordinal'; readonly ordinal: number }
  | { readonly kind: 'turn'; readonly turnId: string };

export type SessionTranscriptPositionsInput =
  | {
      readonly kind: 'acquire';
      readonly subscriptionId: string;
      readonly anchor: SessionTranscriptVisiblePositionAnchor;
      readonly maxPositions: number;
    }
  | {
      readonly kind: 'page';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
      readonly anchor: SessionTranscriptVisiblePositionAnchor;
      readonly maxPositions: number;
    }
  | {
      readonly kind: 'continue';
      readonly subscriptionId: string;
      readonly cursor: string;
    }
  | {
      readonly kind: 'replace';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
      readonly anchor: SessionTranscriptVisiblePositionAnchor;
      readonly maxPositions: number;
    }
  | {
      readonly kind: 'release';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
    };

export type SessionTranscriptPositionsResult =
  | {
      readonly kind: 'page';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
      readonly totalPositions: number;
      readonly startOrdinal: number;
      readonly positions: readonly SessionTranscriptSemanticPosition[];
      readonly olderCursor: string | null;
      readonly newerCursor: string | null;
    }
  | {
      readonly kind: 'building' | 'capacity';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
      readonly retryAfterMs: number;
    }
  | {
      readonly kind: 'snapshot_stale' | 'anchor_not_found';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
    }
  | {
      readonly kind: 'released';
      readonly subscriptionId: string;
    };

export type SessionTranscriptTurnWindowInput =
  | {
      readonly kind: 'open';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
      readonly startOrdinal: number;
      readonly maxPositions: number;
      readonly replaceCursor?: string | null;
    }
  | {
      readonly kind: 'continue';
      readonly subscriptionId: string;
      readonly cursor: string;
    };

export type SessionTranscriptTurnWindowResult =
  | {
      readonly kind: 'page';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
      readonly windowId: string;
      readonly byteOffset: number;
      readonly totalBytes: number;
      readonly payloadDigest: `sha256:${string}`;
      readonly data: string;
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'building' | 'capacity';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
      readonly retryAfterMs: number;
    }
  | {
      readonly kind: 'snapshot_stale' | 'anchor_not_found' | 'position_too_large';
      readonly subscriptionId: string;
      readonly snapshotToken: string;
    };

export type SessionTranscriptPageSource = 'durable' | 'overlay';
export type SessionTranscriptPageDirection = 'older' | 'newer';

export type SessionTranscriptFragment =
  | {
      readonly kind: 'durable';
      readonly sequence: number;
      readonly byteOffset: number;
      readonly totalBytes: number;
      readonly payloadDigest: `sha256:${string}` | null;
      readonly data: string;
    }
  | {
      readonly kind: 'overlay';
      readonly messageIndex: number;
      readonly byteOffset: number;
      readonly totalBytes: number;
      readonly data: string;
    };

export interface SessionTranscriptPage {
  readonly kind: 'page';
  readonly sessionId: string;
  readonly source: SessionTranscriptPageSource;
  readonly direction: SessionTranscriptPageDirection;
  readonly throughSequence: number | null;
  readonly rawBytes: number;
  readonly fragments: readonly SessionTranscriptFragment[];
  /** Host-selected far edge that the client must assemble before publishing this range. */
  readonly rangeBoundarySequence: number | null;
  /** Host-selected Turn identity that bounded consumers must retain while trimming this range. */
  readonly protectedTurnSequence: number | null;
  readonly nextCursor: string | null;
}

export interface SessionTranscriptBootstrap {
  readonly throughSequence: number | null;
  /** Whether every durable sequence is present or policy projection may leave gaps. */
  readonly durableCoverage: 'complete' | 'projected';
  readonly overlayMessageCount: number;
  readonly durable: SessionTranscriptPage;
  readonly overlay: SessionTranscriptPage;
}

export interface SessionTranscriptPageInput {
  readonly subscriptionId: string;
  readonly source: SessionTranscriptPageSource;
  readonly direction: SessionTranscriptPageDirection;
  readonly throughSequence: number | null;
  readonly cursor: string | null;
  readonly anchorSequence: number | null;
  readonly maxBytes: number;
}

export interface SessionTranscriptOverlayReleaseInput {
  readonly subscriptionId: string;
}

export interface SessionTranscriptOverlayReleaseResult {
  readonly subscriptionId: string;
}

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'operation_conflict',
  'persistence_failed',
  'internal_failure',
] as const;

export const SESSION_TRANSCRIPT_OPERATION_SPECS = {
  'session.transcript.page': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTranscriptPageInput,
    decodeOutput: decodeSessionTranscriptPage,
    assertOutputForInput: assertSessionTranscriptPageOutput,
  }),
  'session.transcript.overlay.release': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTranscriptOverlayReleaseInput,
    decodeOutput: decodeSessionTranscriptOverlayReleaseResult,
    assertOutputForInput: (input, output) => {
      if (input.subscriptionId !== output.subscriptionId) {
        throw invalidProtocolFrame('Session transcript overlay release identity changed');
      }
    },
  }),
  'session.transcript.positions.query': defineOperation<
    SessionTranscriptPositionsInput,
    SessionTranscriptPositionsResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTranscriptPositionsInput,
    decodeOutput: decodeSessionTranscriptPositionsResult,
    assertOutputForInput: assertSemanticTranscriptPositionsOutput,
  }),
  'session.transcript.turn_window.page': defineOperation<
    SessionTranscriptTurnWindowInput,
    SessionTranscriptTurnWindowResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTranscriptTurnWindowInput,
    decodeOutput: decodeSessionTranscriptTurnWindowResult,
    assertOutputForInput: assertSemanticTranscriptTurnWindowOutput,
  }),
} as const;

export function decodeSessionTranscriptPositionsInput(
  value: unknown,
): SessionTranscriptPositionsInput {
  const record = requireRecord(value, 'Session transcript positions input');
  switch (record.kind) {
    case 'acquire': {
      const input = requireExactRecord(record, 'Session transcript positions acquire input', [
        'kind',
        'subscriptionId',
        'anchor',
        'maxPositions',
      ]);
      return {
        kind: 'acquire',
        subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
        anchor: decodeSemanticPositionAnchor(input.anchor),
        maxPositions: requireSemanticPositionLimit(input.maxPositions),
      };
    }
    case 'page':
    case 'replace': {
      const input = requireExactRecord(
        record,
        `Session transcript positions ${record.kind} input`,
        ['kind', 'subscriptionId', 'snapshotToken', 'anchor', 'maxPositions'],
      );
      return {
        kind: record.kind,
        subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
        snapshotToken: requireOpaqueTranscriptToken(input.snapshotToken, 'snapshot token'),
        anchor: decodeSemanticPositionAnchor(input.anchor),
        maxPositions: requireSemanticPositionLimit(input.maxPositions),
      };
    }
    case 'continue': {
      const input = requireExactRecord(record, 'Session transcript positions continue input', [
        'kind',
        'subscriptionId',
        'cursor',
      ]);
      return {
        kind: 'continue',
        subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
        cursor: requireOpaqueTranscriptToken(input.cursor, 'positions cursor'),
      };
    }
    case 'release': {
      const input = requireExactRecord(record, 'Session transcript positions release input', [
        'kind',
        'subscriptionId',
        'snapshotToken',
      ]);
      return {
        kind: 'release',
        subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
        snapshotToken: requireOpaqueTranscriptToken(input.snapshotToken, 'snapshot token'),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid Session transcript positions input kind');
  }
}

export function decodeSessionTranscriptPositionsResult(
  value: unknown,
): SessionTranscriptPositionsResult {
  requireEncodedByteLimit(
    value,
    'Session transcript positions result',
    SESSION_TRANSCRIPT_POSITION_PAGE_MAX_BYTES,
  );
  const record = requireRecord(value, 'Session transcript positions result');
  if (record.kind === 'page') {
    const result = requireExactRecord(record, 'Session transcript positions page result', [
      'kind',
      'subscriptionId',
      'snapshotToken',
      'totalPositions',
      'startOrdinal',
      'positions',
      'olderCursor',
      'newerCursor',
    ]);
    if (
      !Array.isArray(result.positions) ||
      result.positions.length > SESSION_TRANSCRIPT_POSITION_PAGE_MAX_POSITIONS
    ) {
      throw invalidProtocolFrame('Invalid Session transcript semantic positions');
    }
    const startOrdinal = requireCount(result.startOrdinal, 'Session transcript start ordinal');
    const positions = result.positions.map((position, index) =>
      decodeSemanticPosition(position, startOrdinal + index),
    );
    const totalPositions = requireCount(
      result.totalPositions,
      'Session transcript total positions',
    );
    if (
      positions.length === 0 ||
      startOrdinal >= totalPositions ||
      startOrdinal + positions.length > totalPositions ||
      (positions.some((position) => position.key.kind === 'empty') &&
        (totalPositions !== 1 || startOrdinal !== 0 || positions.length !== 1))
    ) {
      throw invalidProtocolFrame('Invalid Session transcript position page bounds');
    }
    return {
      kind: 'page',
      subscriptionId: requireId(result.subscriptionId, 'subscriptionId'),
      snapshotToken: requireOpaqueTranscriptToken(result.snapshotToken, 'snapshot token'),
      totalPositions,
      startOrdinal,
      positions,
      olderCursor: decodeNullableTranscriptToken(result.olderCursor, 'older positions cursor'),
      newerCursor: decodeNullableTranscriptToken(result.newerCursor, 'newer positions cursor'),
    };
  }
  if (record.kind === 'building' || record.kind === 'capacity') {
    const result = requireExactRecord(record, `Session transcript ${record.kind} result`, [
      'kind',
      'subscriptionId',
      'snapshotToken',
      'retryAfterMs',
    ]);
    const retryAfterMs = requireCount(result.retryAfterMs, 'Session transcript retry hint');
    if (retryAfterMs < 25 || retryAfterMs > 1_000) {
      throw invalidProtocolFrame('Invalid Session transcript retry hint');
    }
    return {
      kind: record.kind,
      subscriptionId: requireId(result.subscriptionId, 'subscriptionId'),
      snapshotToken: requireOpaqueTranscriptToken(result.snapshotToken, 'snapshot token'),
      retryAfterMs,
    };
  }
  if (record.kind === 'snapshot_stale' || record.kind === 'anchor_not_found') {
    const result = requireExactRecord(record, `Session transcript ${record.kind} result`, [
      'kind',
      'subscriptionId',
      'snapshotToken',
    ]);
    return {
      kind: record.kind,
      subscriptionId: requireId(result.subscriptionId, 'subscriptionId'),
      snapshotToken: requireOpaqueTranscriptToken(result.snapshotToken, 'snapshot token'),
    };
  }
  if (record.kind === 'released') {
    const result = requireExactRecord(record, 'Session transcript released result', [
      'kind',
      'subscriptionId',
    ]);
    return {
      kind: 'released',
      subscriptionId: requireId(result.subscriptionId, 'subscriptionId'),
    };
  }
  throw invalidProtocolFrame('Invalid Session transcript positions result kind');
}

export function decodeSessionTranscriptTurnWindowInput(
  value: unknown,
): SessionTranscriptTurnWindowInput {
  const record = requireRecord(value, 'Session transcript Turn-window input');
  if (record.kind === 'open') {
    const input = requireShapedRecord(
      record,
      'Session transcript Turn-window open input',
      ['kind', 'subscriptionId', 'snapshotToken', 'startOrdinal', 'maxPositions'],
      ['replaceCursor'],
    );
    const maxPositions = requireCount(
      input.maxPositions,
      'Session transcript Turn-window position limit',
    );
    if (maxPositions < 1 || maxPositions > SESSION_TRANSCRIPT_WINDOW_MAX_POSITIONS) {
      throw invalidProtocolFrame('Invalid Session transcript Turn-window position limit');
    }
    return {
      kind: 'open',
      subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
      snapshotToken: requireOpaqueTranscriptToken(input.snapshotToken, 'snapshot token'),
      startOrdinal: requireCount(input.startOrdinal, 'Session transcript start ordinal'),
      maxPositions,
      ...(Object.hasOwn(input, 'replaceCursor')
        ? {
            replaceCursor:
              input.replaceCursor === null
                ? null
                : requireOpaqueTranscriptToken(input.replaceCursor, 'window replacement cursor'),
          }
        : {}),
    };
  }
  if (record.kind === 'continue') {
    const input = requireExactRecord(record, 'Session transcript Turn-window continue input', [
      'kind',
      'subscriptionId',
      'cursor',
    ]);
    return {
      kind: 'continue',
      subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
      cursor: requireOpaqueTranscriptToken(input.cursor, 'window cursor'),
    };
  }
  throw invalidProtocolFrame('Invalid Session transcript Turn-window input kind');
}

export function decodeSessionTranscriptTurnWindowResult(
  value: unknown,
): SessionTranscriptTurnWindowResult {
  requireEncodedByteLimit(
    value,
    'Session transcript Turn-window result',
    SESSION_TRANSCRIPT_PAGE_RESULT_MAX_BYTES,
  );
  const record = requireRecord(value, 'Session transcript Turn-window result');
  if (record.kind === 'page') {
    const result = requireExactRecord(record, 'Session transcript Turn-window page result', [
      'kind',
      'subscriptionId',
      'snapshotToken',
      'windowId',
      'byteOffset',
      'totalBytes',
      'payloadDigest',
      'data',
      'nextCursor',
    ]);
    const byteOffset = requireCount(result.byteOffset, 'Session transcript window byte offset');
    const totalBytes = requireCount(result.totalBytes, 'Session transcript window total bytes');
    const data = requireBase64Fragment(result.data);
    const dataBytes = Buffer.from(data, 'base64').byteLength;
    if (
      totalBytes < 1 ||
      totalBytes > SESSION_TRANSCRIPT_WINDOW_MAX_BYTES ||
      byteOffset >= totalBytes ||
      byteOffset + dataBytes > totalBytes
    ) {
      throw invalidProtocolFrame('Invalid Session transcript Turn-window fragment bounds');
    }
    return {
      kind: 'page',
      subscriptionId: requireId(result.subscriptionId, 'subscriptionId'),
      snapshotToken: requireOpaqueTranscriptToken(result.snapshotToken, 'snapshot token'),
      windowId: requireId(result.windowId, 'windowId'),
      byteOffset,
      totalBytes,
      payloadDigest: requirePayloadDigest(result.payloadDigest, 'Turn-window payload digest'),
      data,
      nextCursor: decodeNullableTranscriptToken(result.nextCursor, 'window cursor'),
    };
  }
  if (record.kind === 'building' || record.kind === 'capacity') {
    const result = requireExactRecord(record, `Session transcript ${record.kind} result`, [
      'kind',
      'subscriptionId',
      'snapshotToken',
      'retryAfterMs',
    ]);
    const retryAfterMs = requireCount(result.retryAfterMs, 'Session transcript retry hint');
    if (retryAfterMs < 25 || retryAfterMs > 1_000) {
      throw invalidProtocolFrame('Invalid Session transcript retry hint');
    }
    return {
      kind: record.kind,
      subscriptionId: requireId(result.subscriptionId, 'subscriptionId'),
      snapshotToken: requireOpaqueTranscriptToken(result.snapshotToken, 'snapshot token'),
      retryAfterMs,
    };
  }
  if (
    record.kind === 'snapshot_stale' ||
    record.kind === 'anchor_not_found' ||
    record.kind === 'position_too_large'
  ) {
    const result = requireExactRecord(record, `Session transcript ${record.kind} result`, [
      'kind',
      'subscriptionId',
      'snapshotToken',
    ]);
    return {
      kind: record.kind,
      subscriptionId: requireId(result.subscriptionId, 'subscriptionId'),
      snapshotToken: requireOpaqueTranscriptToken(result.snapshotToken, 'snapshot token'),
    };
  }
  throw invalidProtocolFrame('Invalid Session transcript Turn-window result kind');
}

function assertSemanticTranscriptSubscription(
  input: { readonly subscriptionId: string },
  output: { readonly subscriptionId: string },
): void {
  if (input.subscriptionId !== output.subscriptionId) {
    throw invalidProtocolFrame('Session semantic transcript subscription changed');
  }
}

function assertSemanticTranscriptPositionsOutput(
  input: SessionTranscriptPositionsInput,
  output: SessionTranscriptPositionsResult,
): void {
  assertSemanticTranscriptSubscription(input, output);
  if (
    output.kind === 'page' &&
    input.kind !== 'continue' &&
    input.kind !== 'release' &&
    output.positions.length > input.maxPositions
  ) {
    throw invalidProtocolFrame('Session transcript position page exceeds request limit');
  }
  if (
    input.kind === 'page' &&
    'snapshotToken' in output &&
    output.snapshotToken !== input.snapshotToken
  ) {
    throw invalidProtocolFrame('Session transcript snapshot token changed');
  }
}

function assertSemanticTranscriptTurnWindowOutput(
  input: SessionTranscriptTurnWindowInput,
  output: SessionTranscriptTurnWindowResult,
): void {
  assertSemanticTranscriptSubscription(input, output);
  if (input.kind === 'open' && output.snapshotToken !== input.snapshotToken) {
    throw invalidProtocolFrame('Session transcript window snapshot token changed');
  }
}

function decodeSemanticPositionAnchor(value: unknown): SessionTranscriptVisiblePositionAnchor {
  const anchor = requireRecord(value, 'Session transcript semantic position anchor');
  if (anchor.kind === 'tail') {
    requireExactRecord(anchor, 'Session transcript tail anchor', ['kind']);
    return { kind: 'tail' };
  }
  if (anchor.kind === 'ordinal') {
    const exact = requireExactRecord(anchor, 'Session transcript ordinal anchor', [
      'kind',
      'ordinal',
    ]);
    return {
      kind: 'ordinal',
      ordinal: requireCount(exact.ordinal, 'Session transcript position ordinal'),
    };
  }
  if (anchor.kind === 'turn') {
    const exact = requireExactRecord(anchor, 'Session transcript Turn anchor', ['kind', 'turnId']);
    return { kind: 'turn', turnId: requireId(exact.turnId, 'turnId') };
  }
  throw invalidProtocolFrame('Invalid Session transcript semantic position anchor');
}

function decodeSemanticPosition(
  value: unknown,
  expectedOrdinal: number,
): SessionTranscriptSemanticPosition {
  const position = requireExactRecord(value, 'Session transcript semantic position', [
    'ordinal',
    'key',
  ]);
  const ordinal = requireCount(position.ordinal, 'Session transcript position ordinal');
  if (ordinal !== expectedOrdinal) {
    throw invalidProtocolFrame('Session transcript semantic position ordinals are not contiguous');
  }
  return { ordinal, key: decodeSemanticPositionKey(position.key) };
}

function decodeSemanticPositionKey(value: unknown): SessionTranscriptSemanticPositionKey {
  const key = requireRecord(value, 'Session transcript semantic position key');
  if (key.kind === 'empty') {
    requireExactRecord(key, 'Session transcript empty position key', ['kind']);
    return { kind: 'empty' };
  }
  if (key.kind === 'turn' || key.kind === 'note') {
    const exact = requireExactRecord(key, 'Session transcript semantic position key', [
      'kind',
      'id',
    ]);
    return { kind: key.kind, id: requireId(exact.id, 'Session transcript position identity') };
  }
  throw invalidProtocolFrame('Invalid Session transcript semantic position key');
}

function requireSemanticPositionLimit(value: unknown): number {
  const limit = requireCount(value, 'Session transcript semantic position limit');
  if (limit < 1 || limit > SESSION_TRANSCRIPT_POSITION_PAGE_MAX_POSITIONS) {
    throw invalidProtocolFrame('Invalid Session transcript semantic position limit');
  }
  return limit;
}

function requireOpaqueTranscriptToken(value: unknown, label: string): string {
  return requireUtf8String(
    value,
    `Session transcript ${label}`,
    SESSION_TRANSCRIPT_CURSOR_MAX_BYTES,
  );
}

function decodeNullableTranscriptToken(value: unknown, label: string): string | null {
  return value === null ? null : requireOpaqueTranscriptToken(value, label);
}

function decodeSessionTranscriptOverlayReleaseInput(
  value: unknown,
): SessionTranscriptOverlayReleaseInput {
  const input = requireExactRecord(value, 'Session transcript overlay release input', [
    'subscriptionId',
  ]);
  return { subscriptionId: requireId(input.subscriptionId, 'subscriptionId') };
}

function decodeSessionTranscriptOverlayReleaseResult(
  value: unknown,
): SessionTranscriptOverlayReleaseResult {
  const result = requireExactRecord(value, 'Session transcript overlay release result', [
    'subscriptionId',
  ]);
  return { subscriptionId: requireId(result.subscriptionId, 'subscriptionId') };
}

export function decodeSessionTranscriptPageInput(value: unknown): SessionTranscriptPageInput {
  const input = requireExactRecord(value, 'Session transcript page input', [
    'subscriptionId',
    'source',
    'direction',
    'throughSequence',
    'cursor',
    'anchorSequence',
    'maxBytes',
  ]);
  const cursor =
    input.cursor === null
      ? null
      : requireUtf8String(
          input.cursor,
          'Session transcript cursor',
          SESSION_TRANSCRIPT_CURSOR_MAX_BYTES,
        );
  const anchorSequence =
    input.anchorSequence === null
      ? null
      : requireCount(input.anchorSequence, 'Session transcript anchor sequence');
  if (cursor !== null && anchorSequence !== null) {
    throw invalidProtocolFrame('Session transcript cursor and anchor are mutually exclusive');
  }
  return {
    subscriptionId: requireId(input.subscriptionId, 'subscriptionId'),
    source: decodeSource(input.source),
    direction: decodeDirection(input.direction),
    throughSequence:
      input.throughSequence === null
        ? null
        : requireCount(input.throughSequence, 'Session transcript watermark'),
    cursor,
    anchorSequence,
    maxBytes: requirePageByteLimit(input.maxBytes),
  };
}

export function decodeSessionTranscriptBootstrap(value: unknown): SessionTranscriptBootstrap {
  const bootstrap = requireExactRecord(value, 'Session transcript bootstrap', [
    'throughSequence',
    'durableCoverage',
    'overlayMessageCount',
    'durable',
    'overlay',
  ]);
  const throughSequence =
    bootstrap.throughSequence === null
      ? null
      : requireCount(bootstrap.throughSequence, 'Session transcript watermark');
  if (bootstrap.durableCoverage !== 'complete' && bootstrap.durableCoverage !== 'projected') {
    throw invalidProtocolFrame('Invalid Session transcript durable coverage');
  }
  const overlayMessageCount = requireCount(
    bootstrap.overlayMessageCount,
    'Session transcript overlay message count',
  );
  if (overlayMessageCount > SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES) {
    throw invalidProtocolFrame('Session transcript overlay exceeds its message limit');
  }
  const durable = decodeSessionTranscriptPage(bootstrap.durable);
  const overlay = decodeSessionTranscriptPage(bootstrap.overlay);
  if (
    durable.source !== 'durable' ||
    durable.direction !== 'older' ||
    overlay.source !== 'overlay' ||
    overlay.direction !== 'older' ||
    durable.throughSequence !== throughSequence ||
    overlay.throughSequence !== throughSequence
  ) {
    throw invalidProtocolFrame('Invalid Session transcript bootstrap correlation');
  }
  if (durable.rawBytes + overlay.rawBytes > SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES) {
    throw invalidProtocolFrame('Session transcript bootstrap exceeds byte limit');
  }
  return {
    throughSequence,
    durableCoverage: bootstrap.durableCoverage,
    overlayMessageCount,
    durable,
    overlay,
  };
}

export function decodeSessionTranscriptPage(value: unknown): SessionTranscriptPage {
  requireEncodedByteLimit(
    value,
    'Session transcript page result',
    SESSION_TRANSCRIPT_PAGE_RESULT_MAX_BYTES,
  );
  const result = requireExactRecord(value, 'Session transcript page result', [
    'kind',
    'sessionId',
    'source',
    'direction',
    'throughSequence',
    'rawBytes',
    'fragments',
    'rangeBoundarySequence',
    'protectedTurnSequence',
    'nextCursor',
  ]);
  if (result.kind !== 'page') throw invalidProtocolFrame('Invalid Session transcript page kind');
  const source = decodeSource(result.source);
  const direction = decodeDirection(result.direction);
  const throughSequence =
    result.throughSequence === null
      ? null
      : requireCount(result.throughSequence, 'Session transcript watermark');
  if (
    !Array.isArray(result.fragments) ||
    result.fragments.length > SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES
  ) {
    throw invalidProtocolFrame('Invalid Session transcript page fragments');
  }
  const fragments = result.fragments.map((fragment) =>
    decodeSessionTranscriptFragment(fragment, source, throughSequence),
  );
  assertFragmentOrder(fragments, direction);
  const rawBytes = requireCount(result.rawBytes, 'Session transcript page bytes');
  if (
    rawBytes > SESSION_TRANSCRIPT_PAGE_MAX_BYTES ||
    fragments.reduce(
      (total, fragment) => total + Buffer.from(fragment.data, 'base64').byteLength,
      0,
    ) !== rawBytes
  ) {
    throw invalidProtocolFrame('Invalid Session transcript page byte count');
  }
  const nextCursor =
    result.nextCursor === null
      ? null
      : requireUtf8String(
          result.nextCursor,
          'Session transcript cursor',
          SESSION_TRANSCRIPT_CURSOR_MAX_BYTES,
        );
  const rangeBoundarySequence =
    result.rangeBoundarySequence === null
      ? null
      : requireCount(result.rangeBoundarySequence, 'Session transcript range boundary sequence');
  const protectedTurnSequence =
    result.protectedTurnSequence === null
      ? null
      : requireCount(result.protectedTurnSequence, 'Session transcript protected Turn sequence');
  if (
    (rangeBoundarySequence !== null && source !== 'durable') ||
    (rangeBoundarySequence !== null &&
      (throughSequence === null || rangeBoundarySequence > throughSequence))
  ) {
    throw invalidProtocolFrame('Invalid Session transcript range boundary');
  }
  if (
    (protectedTurnSequence !== null && source !== 'durable') ||
    (protectedTurnSequence !== null &&
      (throughSequence === null || protectedTurnSequence > throughSequence))
  ) {
    throw invalidProtocolFrame('Invalid Session transcript protected Turn sequence');
  }
  if (fragments.length === 0 && (rawBytes !== 0 || nextCursor !== null)) {
    throw invalidProtocolFrame('Invalid empty Session transcript page');
  }
  return {
    kind: 'page',
    sessionId: requireEntityId(result.sessionId, 'sessionId'),
    source,
    direction,
    throughSequence,
    rawBytes,
    fragments,
    rangeBoundarySequence,
    protectedTurnSequence,
    nextCursor,
  };
}

function assertFragmentOrder(
  fragments: readonly SessionTranscriptFragment[],
  direction: SessionTranscriptPageDirection,
): void {
  let previous: number | undefined;
  for (const fragment of fragments) {
    const identity = fragment.kind === 'durable' ? fragment.sequence : fragment.messageIndex;
    if (
      previous !== undefined &&
      (direction === 'older' ? identity >= previous : identity <= previous)
    ) {
      throw invalidProtocolFrame('Session transcript page fragment order changed');
    }
    previous = identity;
  }
}

function decodeSessionTranscriptFragment(
  value: unknown,
  source: SessionTranscriptPageSource,
  throughSequence: number | null,
): SessionTranscriptFragment {
  const fragment = requireRecord(value, 'Session transcript fragment');
  const identityKey = source === 'durable' ? 'sequence' : 'messageIndex';
  const exact = requireExactRecord(fragment, 'Session transcript fragment', [
    'kind',
    identityKey,
    'byteOffset',
    'totalBytes',
    ...(source === 'durable' ? ['payloadDigest'] : []),
    'data',
  ]);
  if (exact.kind !== source) {
    throw invalidProtocolFrame('Session transcript fragment source changed');
  }
  const byteOffset = requireCount(exact.byteOffset, 'Session transcript fragment byte offset');
  const totalBytes = requireCount(exact.totalBytes, 'Session transcript fragment total bytes');
  const data = requireBase64Fragment(exact.data);
  const dataBytes = Buffer.from(data, 'base64').byteLength;
  if (
    totalBytes === 0 ||
    dataBytes === 0 ||
    byteOffset >= totalBytes ||
    byteOffset + dataBytes > totalBytes
  ) {
    throw invalidProtocolFrame('Invalid Session transcript fragment bounds');
  }
  if (source === 'durable') {
    const sequence = requireCount(exact.sequence, 'Session transcript message sequence');
    if (throughSequence === null || sequence > throughSequence) {
      throw invalidProtocolFrame('Session transcript fragment exceeds watermark');
    }
    const payloadDigest =
      exact.payloadDigest === null
        ? null
        : requirePayloadDigest(exact.payloadDigest, 'Session transcript payload digest');
    return { kind: 'durable', sequence, byteOffset, totalBytes, payloadDigest, data };
  }
  return {
    kind: 'overlay',
    messageIndex: requireCount(exact.messageIndex, 'Session transcript overlay index'),
    byteOffset,
    totalBytes,
    data,
  };
}

function requirePayloadDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as `sha256:${string}`;
}

function requireBase64Fragment(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw invalidProtocolFrame('Invalid Session transcript fragment data');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > SESSION_TRANSCRIPT_PAGE_MAX_BYTES || bytes.toString('base64') !== value) {
    throw invalidProtocolFrame('Invalid Session transcript fragment data');
  }
  return value;
}

function assertSessionTranscriptPageOutput(
  input: SessionTranscriptPageInput,
  output: SessionTranscriptPage,
): void {
  if (
    output.source !== input.source ||
    output.direction !== input.direction ||
    output.throughSequence !== input.throughSequence ||
    output.rawBytes > input.maxBytes
  ) {
    throw invalidProtocolFrame('Session transcript page does not match request');
  }
}

function decodeSource(value: unknown): SessionTranscriptPageSource {
  if (value !== 'durable' && value !== 'overlay') {
    throw invalidProtocolFrame('Invalid Session transcript page source');
  }
  return value;
}

function decodeDirection(value: unknown): SessionTranscriptPageDirection {
  if (value !== 'older' && value !== 'newer') {
    throw invalidProtocolFrame('Invalid Session transcript page direction');
  }
  return value;
}

function requirePageByteLimit(value: unknown): number {
  const limit = requireCount(value, 'Session transcript page byte limit');
  if (limit < 1 || limit > SESSION_TRANSCRIPT_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Invalid Session transcript page byte limit');
  }
  return limit;
}
