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

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IHasher } from 'hash-wasm';
import {
  publishSessionTurnMembership,
  SessionTurnMembershipPublicationError,
} from './session-turn-membership.js';
import {
  advanceSessionTurnIdentityScanner,
  completeSessionTurnIdentityScanner,
  createSessionTurnIdentityScannerState,
  restoreSessionTurnIdentityScannerState,
  serializeSessionTurnIdentityScannerState,
  SessionTurnIdentityScannerError,
  type SessionTurnIdentityScannerStateV1,
  type SessionTurnRecoveredIdentity,
} from './session-turn-identity-scanner.js';
import {
  planForwardTranscriptSlice,
  readTranscriptSlices,
} from './sqlite-session-transcript-slices.js';
import { SQLITE_SESSION_MESSAGE_CHUNK_BYTES } from './sqlite-session-metadata-schema.js';

export const SESSION_TURN_IDENTITY_HASH_STATE_VERSION = 1;
export const SESSION_TURN_IDENTITY_HASH_ALGORITHM = 'sha256';
export const SESSION_TURN_IDENTITY_HASH_IMPLEMENTATION = 'hash-wasm@4.12.0';

export type SessionTurnIdentityRecoveryFailureReason =
  | 'corrupt_source'
  | 'incompatible_identity'
  | 'hybrid_missing_admission';

export interface SessionTurnIdentityRecoveryProgress {
  readonly complete: boolean;
  readonly nextSequence: number;
  readonly currentByteOffset: number;
  readonly sourceRecords: number;
  readonly sourceBytes: number;
  readonly lastStepRecords: number;
  readonly lastStepBytes: number;
}

export interface SessionTurnIdentityRecoveryFailureFact {
  readonly complete: false;
  readonly failure: SessionTurnIdentityRecoveryFailureReason;
  readonly failureSequence: number;
}

export type SessionTurnIdentityRecoveryResult =
  | SessionTurnIdentityRecoveryProgress
  | SessionTurnIdentityRecoveryFailureFact;

interface IndexStateRow {
  readonly indexed_through_sequence: number;
  readonly source_records: number;
  readonly source_bytes: number;
  readonly failure_reason: SessionTurnIdentityRecoveryFailureReason | null;
  readonly failure_sequence: number | null;
}

interface PartialRow {
  readonly sequence: number;
  readonly byte_offset: number;
  readonly record_bytes: number;
  readonly chunked: number;
  readonly expected_digest: string | null;
  readonly message_id: string;
  readonly message_type: string;
  readonly hash_state_version: number;
  readonly hash_algorithm: string;
  readonly hash_implementation: string;
  readonly hash_state: Uint8Array;
  readonly scanner_state_version: number;
  readonly scanner_state: string;
  readonly derived_state_digest: string;
}

interface SourceMetadata {
  readonly sequence: number;
  readonly message_id: string;
  readonly message_type: string;
  readonly record_bytes: number;
  readonly chunked: number;
  readonly expected_digest: string | null;
}

/**
 * Advance only the scalar identity index. This function never returns source
 * bytes, JSON, fragments, or StoredMessage objects to its caller.
 */
export function advanceSessionTurnIdentityRecovery(
  db: DatabaseSync,
  input: {
    readonly sessionId: string;
    readonly throughSequence: number;
    readonly maxSourceBytes: number;
    readonly maxCompletedRecords: number;
    readonly hasher: IHasher;
  },
): SessionTurnIdentityRecoveryResult {
  const { sessionId, throughSequence, maxSourceBytes, maxCompletedRecords, hasher } = input;
  const initial = readIndexState(db, sessionId);
  if (initial.failure_reason !== null) {
    return {
      complete: false,
      failure: initial.failure_reason,
      failureSequence: initial.failure_sequence!,
    };
  }
  let nextSequence = initial.indexed_through_sequence + 1;
  let stepBytes = 0;
  let stepRecords = 0;
  while (
    nextSequence <= throughSequence &&
    stepBytes < maxSourceBytes &&
    stepRecords < maxCompletedRecords
  ) {
    const source = readSourceMetadata(db, sessionId, nextSequence);
    if (!source) return fail(db, sessionId, 'corrupt_source', nextSequence);
    let partial = readPartial(db, sessionId);
    let scanner: SessionTurnIdentityScannerStateV1;
    let byteOffset: number;
    if (partial && partial.sequence !== nextSequence) {
      return fail(db, sessionId, 'corrupt_source', nextSequence);
    }
    if (partial && !sameSource(partial, source)) {
      return fail(db, sessionId, 'corrupt_source', nextSequence);
    }
    try {
      if (partial) {
        validateDerivedEnvelope(partial);
        hasher.load(Uint8Array.from(partial.hash_state));
        scanner = restoreSessionTurnIdentityScannerState(partial.scanner_state);
        byteOffset = partial.byte_offset;
      } else {
        hasher.init();
        scanner = createSessionTurnIdentityScannerState();
        byteOffset = 0;
      }
    } catch {
      // Derived scanner/hash state is reconstructible. Discard only the
      // current partial record and restart it from the authoritative bytes.
      db.prepare('DELETE FROM session_turn_identity_recovery WHERE session_id = ?').run(sessionId);
      partial = undefined;
      hasher.init();
      scanner = createSessionTurnIdentityScannerState();
      byteOffset = 0;
    }

    const available = maxSourceBytes - stepBytes;
    const byteLength = planForwardTranscriptSlice(
      source.record_bytes,
      byteOffset,
      available,
      source.chunked === 1 ? SQLITE_SESSION_MESSAGE_CHUNK_BYTES : 1,
    );
    if (byteLength === 0) break;
    let data: Buffer;
    try {
      const bySequence = readTranscriptSlices(db, sessionId, [
        {
          sequence: source.sequence,
          byteOffset,
          totalBytes: source.record_bytes,
          byteLength,
          chunked: source.chunked === 1,
          payloadDigest:
            source.expected_digest === null ? null : `sha256:${source.expected_digest}`,
        },
      ]);
      data = bySequence.get(source.sequence)!;
      if (!data || data.byteLength !== byteLength) {
        return fail(db, sessionId, 'corrupt_source', source.sequence);
      }
      hasher.update(data);
      advanceSessionTurnIdentityScanner(scanner, data);
    } catch (error) {
      return fail(
        db,
        sessionId,
        error instanceof SessionTurnIdentityScannerError ? error.reason : 'corrupt_source',
        source.sequence,
        error,
      );
    }
    byteOffset += byteLength;
    stepBytes += byteLength;
    db.prepare(`
      UPDATE session_turn_index_state SET source_bytes = source_bytes + ? WHERE session_id = ?
    `).run(byteLength, sessionId);
    if (byteOffset < source.record_bytes) {
      writePartial(db, sessionId, source, byteOffset, hasher.save(), scanner);
      break;
    }

    let identity: SessionTurnRecoveredIdentity;
    try {
      const digest = hasher.digest('hex');
      if (source.expected_digest !== null && digest !== source.expected_digest) {
        return fail(db, sessionId, 'corrupt_source', source.sequence);
      }
      identity = completeSessionTurnIdentityScanner(scanner, {
        messageId: source.message_id,
        messageType: source.message_type,
      });
    } catch (error) {
      return fail(
        db,
        sessionId,
        error instanceof SessionTurnIdentityScannerError ? error.reason : 'corrupt_source',
        source.sequence,
        error,
      );
    }
    try {
      publishSessionTurnMembership(db, sessionId, source.sequence, identity);
    } catch (error) {
      return fail(
        db,
        sessionId,
        error instanceof SessionTurnMembershipPublicationError ? error.reason : 'corrupt_source',
        source.sequence,
        error,
      );
    }
    db.prepare('DELETE FROM session_turn_identity_recovery WHERE session_id = ?').run(sessionId);
    nextSequence += 1;
    stepRecords += 1;
    db.prepare(`
      UPDATE session_turn_index_state
      SET indexed_through_sequence = ?, source_records = source_records + 1
      WHERE session_id = ?
    `).run(source.sequence, sessionId);
  }
  const final = readIndexState(db, sessionId);
  const partial = readPartial(db, sessionId);
  return {
    complete: final.indexed_through_sequence >= throughSequence,
    nextSequence: final.indexed_through_sequence + 1,
    currentByteOffset: partial?.byte_offset ?? 0,
    sourceRecords: final.source_records,
    sourceBytes: final.source_bytes,
    lastStepRecords: stepRecords,
    lastStepBytes: stepBytes,
  };
}

function readIndexState(db: DatabaseSync, sessionId: string): IndexStateRow {
  return db
    .prepare(`
      SELECT indexed_through_sequence, source_records, source_bytes,
        failure_reason, failure_sequence
      FROM session_turn_index_state WHERE session_id = ?
    `)
    .get(sessionId) as unknown as IndexStateRow;
}

function readPartial(db: DatabaseSync, sessionId: string): PartialRow | undefined {
  return db
    .prepare('SELECT * FROM session_turn_identity_recovery WHERE session_id = ?')
    .get(sessionId) as PartialRow | undefined;
}

function readSourceMetadata(
  db: DatabaseSync,
  sessionId: string,
  sequence: number,
): SourceMetadata | undefined {
  const row = db
    .prepare(`
      SELECT message.sequence, message.message_id, message.message_type,
        coalesce(payload.record_bytes, length(CAST(message.record_json AS BLOB))) AS record_bytes,
        payload.record_bytes IS NOT NULL AS chunked, payload.sha256 AS expected_digest
      FROM session_messages AS message
      LEFT JOIN session_message_payloads AS payload
        ON payload.session_id = message.session_id AND payload.sequence = message.sequence
      WHERE message.session_id = ? AND message.sequence = ?
    `)
    .get(sessionId, sequence) as Partial<SourceMetadata> | undefined;
  if (
    !row ||
    row.sequence !== sequence ||
    typeof row.message_id !== 'string' ||
    row.message_id.length === 0 ||
    typeof row.message_type !== 'string' ||
    row.message_type.length === 0 ||
    !Number.isSafeInteger(row.record_bytes) ||
    (row.record_bytes ?? 0) < 1 ||
    (row.chunked !== 0 && row.chunked !== 1) ||
    (row.expected_digest !== null &&
      (typeof row.expected_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.expected_digest)))
  ) {
    return undefined;
  }
  return row as SourceMetadata;
}

function sameSource(partial: PartialRow, source: SourceMetadata): boolean {
  return (
    partial.sequence === source.sequence &&
    partial.record_bytes === source.record_bytes &&
    partial.chunked === source.chunked &&
    partial.expected_digest === source.expected_digest &&
    partial.message_id === source.message_id &&
    partial.message_type === source.message_type &&
    partial.byte_offset >= 0 &&
    partial.byte_offset < source.record_bytes
  );
}

function validateDerivedEnvelope(partial: PartialRow): void {
  if (
    partial.hash_state_version !== SESSION_TURN_IDENTITY_HASH_STATE_VERSION ||
    partial.hash_algorithm !== SESSION_TURN_IDENTITY_HASH_ALGORITHM ||
    partial.hash_implementation !== SESSION_TURN_IDENTITY_HASH_IMPLEMENTATION ||
    partial.scanner_state_version !== 1 ||
    !(partial.hash_state instanceof Uint8Array) ||
    partial.hash_state.byteLength < 1 ||
    partial.hash_state.byteLength > 64 * 1024 ||
    partial.derived_state_digest !== derivedStateDigest(partial.hash_state, partial.scanner_state)
  ) {
    throw new Error('Unsupported derived recovery state');
  }
}

function writePartial(
  db: DatabaseSync,
  sessionId: string,
  source: SourceMetadata,
  byteOffset: number,
  hashState: Uint8Array,
  scanner: SessionTurnIdentityScannerStateV1,
): void {
  const scannerState = serializeSessionTurnIdentityScannerState(scanner);
  const derivedDigest = derivedStateDigest(hashState, scannerState);
  db.prepare(`
    INSERT INTO session_turn_identity_recovery(
      session_id, sequence, byte_offset, record_bytes, chunked, expected_digest,
      message_id, message_type, hash_state_version, hash_algorithm,
      hash_implementation, hash_state, scanner_state_version, scanner_state
      , derived_state_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'sha256', 'hash-wasm@4.12.0', ?, 1, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      sequence = excluded.sequence, byte_offset = excluded.byte_offset,
      record_bytes = excluded.record_bytes, chunked = excluded.chunked,
      expected_digest = excluded.expected_digest, message_id = excluded.message_id,
      message_type = excluded.message_type, hash_state_version = excluded.hash_state_version,
      hash_algorithm = excluded.hash_algorithm,
      hash_implementation = excluded.hash_implementation, hash_state = excluded.hash_state,
      scanner_state_version = excluded.scanner_state_version,
      scanner_state = excluded.scanner_state,
      derived_state_digest = excluded.derived_state_digest
  `).run(
    sessionId,
    source.sequence,
    byteOffset,
    source.record_bytes,
    source.chunked,
    source.expected_digest,
    source.message_id,
    source.message_type,
    hashState,
    scannerState,
    derivedDigest,
  );
}

function derivedStateDigest(hashState: Uint8Array, scannerState: string): string {
  return createHash('sha256')
    .update('session-turn-identity-recovery-v1\0')
    .update(SESSION_TURN_IDENTITY_HASH_ALGORITHM)
    .update('\0')
    .update(SESSION_TURN_IDENTITY_HASH_IMPLEMENTATION)
    .update('\0')
    .update(hashState)
    .update('\0')
    .update(scannerState, 'utf8')
    .digest('hex');
}

function fail(
  db: DatabaseSync,
  sessionId: string,
  reason: 'corrupt_source' | 'incompatible_identity',
  sequence: number,
  cause?: unknown,
): SessionTurnIdentityRecoveryFailureFact {
  db.prepare(`
    UPDATE session_turn_index_state
    SET failure_origin = 'transcript', failure_reason = ?, failure_sequence = ?
    WHERE session_id = ?
  `).run(reason, sequence, sessionId);
  db.prepare('DELETE FROM session_turn_identity_recovery WHERE session_id = ?').run(sessionId);
  void cause;
  return { complete: false, failure: reason, failureSequence: sequence };
}
