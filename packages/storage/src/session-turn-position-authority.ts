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

import type { DatabaseSync } from 'node:sqlite';
import {
  SHARED_SESSION_TRANSCRIPT_VISIBILITY_POLICY_VERSION,
  type StoredMessage,
} from '@maka/core/session';
import { SessionTurnPositionRecoveryError } from './session-store.js';
import {
  classifyStoredMessageTurnIdentity,
  publishSessionTurnMembership,
  SessionTurnIdentityClassificationError,
  SessionTurnMembershipPublicationError,
} from './session-turn-membership.js';
import { sqliteTableExists } from './sqlite-schema-introspection.js';

export function recordAppendedSessionTurnMetadata(
  db: DatabaseSync,
  sessionId: string,
  firstSequence: number,
  entries: readonly {
    readonly message: StoredMessage;
    readonly recordBytes: number;
  }[],
): void {
  if (!sqliteTableExists(db, 'session_turn_metadata') || entries.length === 0) return;
  ensureTurnIndexRows(db, sessionId);
  const fillsBodylessAdmission = entries.some(({ message }) => {
    const turnId = (message as { turnId?: unknown }).turnId;
    if (typeof turnId !== 'string' || turnId.length === 0) return false;
    return Boolean(
      db
        .prepare(`
          SELECT 1 FROM session_turn_metadata
          WHERE session_id = ? AND position_kind = 'turn' AND position_id = ?
            AND order_source = 'admission' AND owner_first_sequence IS NULL
        `)
        .get(sessionId, turnId),
    );
  });
  for (let index = 0; index < entries.length; index += 1) {
    publishCanonicalMembership(db, sessionId, firstSequence + index, entries[index]!.message);
  }
  const state = db
    .prepare('SELECT indexed_through_sequence FROM session_turn_index_state WHERE session_id = ?')
    .get(sessionId) as { indexed_through_sequence: number };
  if (state.indexed_through_sequence === firstSequence - 1) {
    const sourceBytes = entries.reduce((total, { recordBytes }) => total + recordBytes, 0);
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
      throw new SessionTurnPositionRecoveryError(sessionId, 'corrupt_source');
    }
    db.prepare(`
      UPDATE session_turn_index_state
      SET indexed_through_sequence = ?,
        source_records = source_records + ?, source_bytes = source_bytes + ?
      WHERE session_id = ?
    `).run(firstSequence + entries.length - 1, entries.length, sourceBytes, sessionId);
  }
  if (fillsBodylessAdmission) invalidateBuildingSnapshots(db, sessionId);
}

export function recordRootTurnAdmissionForPositionIndex(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
  admittedAt: number,
): void {
  if (!sqliteTableExists(db, 'session_turn_metadata')) return;
  if (!db.prepare('SELECT 1 FROM session_metadata WHERE session_id = ?').get(sessionId)) return;
  if (!turnId || !Number.isSafeInteger(admittedAt) || admittedAt < 0) {
    throw new SessionTurnPositionRecoveryError(sessionId, 'incompatible_identity');
  }
  ensureTurnIndexRows(db, sessionId);
  const current = db
    .prepare(`
      SELECT order_source, admitted_at, owner_first_sequence
      FROM session_turn_metadata
      WHERE session_id = ? AND position_kind = 'turn' AND position_id = ?
    `)
    .get(sessionId, turnId) as
    | {
        order_source: string;
        admitted_at: number | null;
        owner_first_sequence: number | null;
      }
    | undefined;
  if (current?.order_source === 'admission' && current.admitted_at !== admittedAt) {
    throw new SessionTurnPositionRecoveryError(sessionId, 'corrupt_source');
  }
  db.prepare(`
    INSERT INTO session_turn_metadata(
      session_id, position_kind, position_id, order_source, admitted_at,
      owner_first_sequence, shared_first_sequence
    ) VALUES (?, 'turn', ?, 'admission', ?, NULL, NULL)
    ON CONFLICT(session_id, position_kind, position_id) DO UPDATE SET
      order_source = 'admission', admitted_at = excluded.admitted_at
  `).run(sessionId, turnId, admittedAt);
  db.prepare(`
    UPDATE session_turn_index_state
    SET admission_cursor_admitted_at = ?, admission_cursor_turn_id = ?
    WHERE session_id = ? AND admission_recovery_complete = 1
      AND (admission_cursor_admitted_at IS NULL
        OR (admission_cursor_admitted_at, admission_cursor_turn_id) < (?, ?))
  `).run(admittedAt, turnId, sessionId, admittedAt, turnId);
  db.prepare(`
    UPDATE session_turn_index_state SET failure_reason = NULL, failure_sequence = NULL
    WHERE session_id = ? AND failure_reason = 'hybrid_missing_admission'
  `).run(sessionId);
  invalidateBuildingSnapshots(db, sessionId);
  advanceAuthorityRevision(db, sessionId);
}

export function recordRootTurnAdmissionsPurgedForPositionIndex(
  db: DatabaseSync,
  sessionId: string,
): void {
  if (!sqliteTableExists(db, 'session_turn_metadata')) return;
  if (!db.prepare('SELECT 1 FROM session_metadata WHERE session_id = ?').get(sessionId)) return;
  ensureTurnIndexRows(db, sessionId);
  const removed = db
    .prepare(`
    DELETE FROM session_turn_metadata
    WHERE session_id = ? AND position_kind = 'turn'
      AND order_source = 'admission' AND owner_first_sequence IS NULL
  `)
    .run(sessionId);
  const downgraded = db
    .prepare(`
    UPDATE session_turn_metadata SET order_source = 'legacy', admitted_at = NULL
    WHERE session_id = ? AND position_kind = 'turn'
      AND order_source = 'admission' AND owner_first_sequence IS NOT NULL
  `)
    .run(sessionId);
  if (removed.changes === 0 && downgraded.changes === 0) return;
  db.prepare(`
    UPDATE session_turn_index_state SET failure_reason = NULL, failure_sequence = NULL
    WHERE session_id = ? AND failure_reason = 'hybrid_missing_admission'
  `).run(sessionId);
  invalidateBuildingSnapshots(db, sessionId);
  advanceAuthorityRevision(db, sessionId);
}

export function invalidateSessionTurnPositionIndex(db: DatabaseSync, sessionId: string): void {
  if (!sqliteTableExists(db, 'session_turn_metadata')) return;
  ensureTurnIndexRows(db, sessionId);
  db.prepare('DELETE FROM session_turn_position_snapshots WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_turn_identity_recovery WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_turn_metadata WHERE session_id = ?').run(sessionId);
  db.prepare(`
    UPDATE session_turn_index_state
    SET indexed_through_sequence = -1, source_records = 0, source_bytes = 0,
      admission_cursor_admitted_at = NULL, admission_cursor_turn_id = NULL,
      admission_recovery_complete = 0,
      failure_reason = NULL, failure_sequence = NULL
    WHERE session_id = ?
  `).run(sessionId);
  advanceAuthorityRevision(db, sessionId);
}

export function ensureTurnIndexRows(db: DatabaseSync, sessionId: string): void {
  db.prepare(`
    INSERT INTO session_turn_authority_revisions(session_id, visibility_policy_version)
    VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING
  `).run(sessionId, SHARED_SESSION_TRANSCRIPT_VISIBILITY_POLICY_VERSION);
  db.prepare(`
    INSERT INTO session_turn_index_state(session_id)
    VALUES (?) ON CONFLICT(session_id) DO NOTHING
  `).run(sessionId);
  const authority = db
    .prepare(`
      SELECT visibility_policy_version FROM session_turn_authority_revisions
      WHERE session_id = ?
    `)
    .get(sessionId) as { visibility_policy_version: number };
  if (authority.visibility_policy_version === SHARED_SESSION_TRANSCRIPT_VISIBILITY_POLICY_VERSION) {
    return;
  }
  db.prepare('DELETE FROM session_turn_position_snapshots WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_turn_identity_recovery WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_turn_metadata WHERE session_id = ?').run(sessionId);
  db.prepare(`
    UPDATE session_turn_index_state
    SET indexed_through_sequence = -1, source_records = 0, source_bytes = 0,
      admission_cursor_admitted_at = NULL, admission_cursor_turn_id = NULL,
      admission_recovery_complete = 0,
      failure_reason = NULL, failure_sequence = NULL
    WHERE session_id = ?
  `).run(sessionId);
  db.prepare(`
    UPDATE session_turn_authority_revisions
    SET visibility_policy_version = ?, authority_revision = authority_revision + 1
    WHERE session_id = ?
  `).run(SHARED_SESSION_TRANSCRIPT_VISIBILITY_POLICY_VERSION, sessionId);
}

function publishCanonicalMembership(
  db: DatabaseSync,
  sessionId: string,
  sequence: number,
  message: StoredMessage,
): void {
  try {
    publishSessionTurnMembership(
      db,
      sessionId,
      sequence,
      classifyStoredMessageTurnIdentity(message),
    );
  } catch (error) {
    if (error instanceof SessionTurnIdentityClassificationError) {
      throw new SessionTurnPositionRecoveryError(sessionId, 'incompatible_identity', sequence, {
        cause: error,
      });
    }
    if (error instanceof SessionTurnMembershipPublicationError) {
      throw new SessionTurnPositionRecoveryError(sessionId, error.reason, sequence, {
        cause: error,
      });
    }
    throw error;
  }
}

function invalidateBuildingSnapshots(db: DatabaseSync, sessionId: string): void {
  db.prepare(`
    DELETE FROM session_turn_position_snapshots WHERE session_id = ? AND state = 'building'
  `).run(sessionId);
}

function advanceAuthorityRevision(db: DatabaseSync, sessionId: string): void {
  db.prepare(`
    UPDATE session_turn_authority_revisions
    SET authority_revision = authority_revision + 1 WHERE session_id = ?
  `).run(sessionId);
}
