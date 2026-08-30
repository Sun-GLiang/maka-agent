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
import { SessionTurnPositionRecoveryError } from './session-store.js';

export const SESSION_TURN_ADMISSION_RECOVERY_MAX_ROWS = 1_024;

export interface SessionTurnAdmissionRecoveryResult {
  readonly complete: boolean;
}

interface PersistedRecoveryFailure {
  readonly failure_reason: 'corrupt_source' | 'incompatible_identity' | 'hybrid_missing_admission';
  readonly failure_sequence: number;
}

interface AdmissionRecoveryState {
  readonly admission_cursor_admitted_at: number | null;
  readonly admission_cursor_turn_id: string | null;
  readonly admission_recovery_complete: number;
  readonly failure_reason: PersistedRecoveryFailure['failure_reason'] | null;
  readonly failure_sequence: number | null;
}

/**
 * Reconciles only canonical admission identity/order scalars. Transcript
 * membership and body decoding remain owned by their existing recovery path.
 */
export function advanceSessionTurnAdmissionRecovery(
  db: DatabaseSync,
  input: {
    readonly sessionId: string;
    readonly maxAdmissions: number;
  },
): SessionTurnAdmissionRecoveryResult {
  if (
    !Number.isSafeInteger(input.maxAdmissions) ||
    input.maxAdmissions < 1 ||
    input.maxAdmissions > SESSION_TURN_ADMISSION_RECOVERY_MAX_ROWS
  ) {
    throw new SessionTurnPositionRecoveryError(input.sessionId, 'corrupt_source');
  }
  const state = db
    .prepare(`SELECT admission_cursor_admitted_at, admission_cursor_turn_id,
      admission_recovery_complete, failure_reason, failure_sequence
      FROM session_turn_index_state WHERE session_id = ?`)
    .get(input.sessionId) as unknown as AdmissionRecoveryState | undefined;
  if (!state) throw new SessionTurnPositionRecoveryError(input.sessionId, 'corrupt_source');
  if (state.failure_reason !== null) {
    throw new SessionTurnPositionRecoveryError(
      input.sessionId,
      state.failure_reason,
      state.failure_sequence ?? 0,
    );
  }
  if (state.admission_recovery_complete === 1) return { complete: true };
  const rows = (
    state.admission_cursor_admitted_at === null
      ? db
          .prepare(`
            SELECT turn_id, admitted_at
            FROM core_root_turn_admissions
            WHERE session_id = ?
            ORDER BY admitted_at, turn_id
            LIMIT ?
          `)
          .all(input.sessionId, input.maxAdmissions)
      : db
          .prepare(`
            SELECT turn_id, admitted_at
            FROM core_root_turn_admissions
            WHERE session_id = ? AND (admitted_at, turn_id) > (?, ?)
            ORDER BY admitted_at, turn_id
            LIMIT ?
          `)
          .all(
            input.sessionId,
            state.admission_cursor_admitted_at,
            state.admission_cursor_turn_id,
            input.maxAdmissions,
          )
  ) as Array<{ turn_id?: unknown; admitted_at?: unknown }>;
  const readExisting = db.prepare(`
    SELECT order_source, admitted_at
    FROM session_turn_metadata
    WHERE session_id = ? AND position_kind = 'turn' AND position_id = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO session_turn_metadata(
      session_id, position_kind, position_id, order_source, admitted_at,
      owner_first_sequence, shared_first_sequence
    ) VALUES (?, 'turn', ?, 'admission', ?, NULL, NULL)
    ON CONFLICT(session_id, position_kind, position_id) DO UPDATE SET
      order_source = 'admission', admitted_at = excluded.admitted_at
  `);
  let cursorAdmittedAt = state.admission_cursor_admitted_at;
  let cursorTurnId = state.admission_cursor_turn_id;
  for (const row of rows) {
    if (
      typeof row.turn_id !== 'string' ||
      row.turn_id.length === 0 ||
      typeof row.admitted_at !== 'number' ||
      !Number.isSafeInteger(row.admitted_at) ||
      row.admitted_at < 0
    ) {
      failAdmissionRecovery(db, input.sessionId);
    }
    const existing = readExisting.get(input.sessionId, row.turn_id) as
      | { order_source: string; admitted_at: number | null }
      | undefined;
    if (existing?.order_source === 'admission' && existing.admitted_at !== row.admitted_at) {
      failAdmissionRecovery(db, input.sessionId);
    }
    upsert.run(input.sessionId, row.turn_id, row.admitted_at);
    cursorAdmittedAt = row.admitted_at;
    cursorTurnId = row.turn_id;
  }
  const complete = rows.length < input.maxAdmissions;
  db.prepare(`UPDATE session_turn_index_state
    SET admission_cursor_admitted_at = ?, admission_cursor_turn_id = ?,
      admission_recovery_complete = ?
    WHERE session_id = ?`).run(cursorAdmittedAt, cursorTurnId, complete ? 1 : 0, input.sessionId);
  return { complete };
}

function failAdmissionRecovery(db: DatabaseSync, sessionId: string): never {
  db.prepare(`UPDATE session_turn_index_state
    SET failure_reason = 'corrupt_source', failure_sequence = 0
    WHERE session_id = ?`).run(sessionId);
  throw new SessionTurnPositionRecoveryError(sessionId, 'corrupt_source', 0);
}
