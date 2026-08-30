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
import { isUserVisibleSessionSystemNote, type StoredMessage } from '@maka/core/session';
import { SessionTurnPositionRecoveryError } from './session-store.js';

export function recordAppendedSessionTurnMetadata(
  db: DatabaseSync,
  sessionId: string,
  firstSequence: number,
  messages: readonly StoredMessage[],
  encodedByteLengths: readonly number[],
): void {
  if (!tableExists(db, 'session_turn_metadata') || messages.length === 0) return;
  if (messages.length !== encodedByteLengths.length) {
    throw new Error('Session Turn metadata byte evidence is incomplete');
  }
  ensureTurnIndexRows(db, sessionId);
  const fillsBodylessAdmission = messages.some((message) => {
    const turnId = (message as { turnId?: unknown }).turnId;
    if (typeof turnId !== 'string' || turnId.length === 0) return false;
    return Boolean(
      db
        .prepare(`
          SELECT 1 FROM session_turn_metadata
          WHERE session_id = ? AND turn_id = ? AND order_source = 'admission'
            AND first_sequence IS NULL
        `)
        .get(sessionId, turnId),
    );
  });
  for (let index = 0; index < messages.length; index += 1) {
    publishCanonicalMembership(db, sessionId, firstSequence + index, messages[index]!);
  }
  const state = db
    .prepare('SELECT indexed_through_sequence FROM session_turn_index_state WHERE session_id = ?')
    .get(sessionId) as { indexed_through_sequence: number };
  if (state.indexed_through_sequence === firstSequence - 1) {
    db.prepare(`
      UPDATE session_turn_index_state
      SET indexed_through_sequence = ?
      WHERE session_id = ?
    `).run(firstSequence + messages.length - 1, sessionId);
  }
  if (fillsBodylessAdmission) invalidateBuildingSnapshots(db, sessionId);
}

export function recordRootTurnAdmissionForPositionIndex(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
  admittedAt: number,
): void {
  if (!tableExists(db, 'session_turn_metadata')) return;
  if (!db.prepare('SELECT 1 FROM session_metadata WHERE session_id = ?').get(sessionId)) return;
  if (!turnId || !Number.isSafeInteger(admittedAt) || admittedAt < 0) {
    throw new SessionTurnPositionRecoveryError(sessionId, 'incompatible_identity');
  }
  ensureTurnIndexRows(db, sessionId);
  const current = db
    .prepare(`
      SELECT identity_kind, order_source, admitted_at, first_sequence
      FROM session_turn_metadata WHERE session_id = ? AND turn_id = ?
    `)
    .get(sessionId, turnId) as
    | {
        identity_kind: string;
        order_source: string;
        admitted_at: number | null;
        first_sequence: number | null;
      }
    | undefined;
  if (current && current.identity_kind !== 'turn') {
    throw new SessionTurnPositionRecoveryError(sessionId, 'corrupt_source');
  }
  if (current?.order_source === 'admission' && current.admitted_at !== admittedAt) {
    throw new SessionTurnPositionRecoveryError(sessionId, 'corrupt_source');
  }
  db.prepare(`
    INSERT INTO session_turn_metadata(
      session_id, turn_id, identity_kind, order_source, admitted_at, first_sequence
    ) VALUES (?, ?, 'turn', 'admission', ?, NULL)
    ON CONFLICT(session_id, turn_id) DO UPDATE SET
      order_source = 'admission', admitted_at = excluded.admitted_at
  `).run(sessionId, turnId, admittedAt);
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
  if (!tableExists(db, 'session_turn_metadata')) return;
  if (!db.prepare('SELECT 1 FROM session_metadata WHERE session_id = ?').get(sessionId)) return;
  ensureTurnIndexRows(db, sessionId);
  const removed = db
    .prepare(`
    DELETE FROM session_turn_metadata
    WHERE session_id = ? AND identity_kind = 'turn'
      AND order_source = 'admission' AND first_sequence IS NULL
  `)
    .run(sessionId);
  const downgraded = db
    .prepare(`
    UPDATE session_turn_metadata SET order_source = 'legacy', admitted_at = NULL
    WHERE session_id = ? AND identity_kind = 'turn'
      AND order_source = 'admission' AND first_sequence IS NOT NULL
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
  if (!tableExists(db, 'session_turn_metadata')) return;
  ensureTurnIndexRows(db, sessionId);
  db.prepare('DELETE FROM session_turn_position_snapshots WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_turn_identity_recovery WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_turn_metadata WHERE session_id = ?').run(sessionId);
  db.prepare(`
    UPDATE session_turn_index_state
    SET indexed_through_sequence = -1, source_records = 0, source_bytes = 0,
      failure_reason = NULL, failure_sequence = NULL
    WHERE session_id = ?
  `).run(sessionId);
  advanceAuthorityRevision(db, sessionId);
}

export function ensureTurnIndexRows(db: DatabaseSync, sessionId: string): void {
  db.prepare(`
    INSERT INTO session_turn_authority_revisions(session_id)
    VALUES (?) ON CONFLICT(session_id) DO NOTHING
  `).run(sessionId);
  db.prepare(`
    INSERT INTO session_turn_index_state(session_id)
    VALUES (?) ON CONFLICT(session_id) DO NOTHING
  `).run(sessionId);
}

function publishCanonicalMembership(
  db: DatabaseSync,
  sessionId: string,
  sequence: number,
  message: StoredMessage,
): void {
  const explicitTurnId = (message as { turnId?: unknown }).turnId;
  let turnId: string;
  let identityKind: 'turn' | 'note';
  if (typeof explicitTurnId === 'string') {
    if (explicitTurnId.length === 0) {
      throw new SessionTurnPositionRecoveryError(sessionId, 'incompatible_identity', sequence);
    }
    turnId = explicitTurnId;
    identityKind = 'turn';
  } else if (message.type === 'system_note') {
    if (!message.id || !isUserVisibleSessionSystemNote(message.kind)) return;
    turnId = `session-note:${message.id}`;
    identityKind = 'note';
  } else {
    throw new SessionTurnPositionRecoveryError(sessionId, 'incompatible_identity', sequence);
  }
  const admission =
    identityKind === 'turn' && tableExists(db, 'core_root_turn_admissions')
      ? (db
          .prepare(`
            SELECT admitted_at FROM core_root_turn_admissions
            WHERE session_id = ? AND turn_id = ?
          `)
          .get(sessionId, turnId) as { admitted_at: number } | undefined)
      : undefined;
  const existingIdentity = db
    .prepare(`
      SELECT identity_kind FROM session_turn_metadata
      WHERE session_id = ? AND turn_id = ?
    `)
    .get(sessionId, turnId) as { identity_kind: string } | undefined;
  if (existingIdentity && existingIdentity.identity_kind !== identityKind) {
    throw new SessionTurnPositionRecoveryError(sessionId, 'incompatible_identity', sequence);
  }
  db.prepare(`
    INSERT INTO session_turn_metadata(
      session_id, turn_id, identity_kind, order_source, admitted_at, first_sequence
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_id) DO UPDATE SET
      order_source = CASE WHEN excluded.order_source = 'admission' THEN 'admission'
        ELSE session_turn_metadata.order_source END,
      admitted_at = COALESCE(excluded.admitted_at, session_turn_metadata.admitted_at),
      first_sequence = CASE WHEN session_turn_metadata.first_sequence IS NULL
        THEN excluded.first_sequence
        ELSE MIN(session_turn_metadata.first_sequence, excluded.first_sequence) END
  `).run(
    sessionId,
    turnId,
    identityKind,
    admission ? 'admission' : 'legacy',
    admission?.admitted_at ?? null,
    sequence,
  );
  const existing = db
    .prepare(`
      SELECT turn_id FROM session_turn_memberships WHERE session_id = ? AND sequence = ?
    `)
    .get(sessionId, sequence) as { turn_id: string } | undefined;
  if (existing && existing.turn_id !== turnId) {
    throw new SessionTurnPositionRecoveryError(sessionId, 'corrupt_source', sequence);
  }
  db.prepare(`
    INSERT INTO session_turn_memberships(session_id, sequence, turn_id)
    VALUES (?, ?, ?) ON CONFLICT(session_id, sequence) DO NOTHING
  `).run(sessionId, sequence, turnId);
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

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table),
  );
}
