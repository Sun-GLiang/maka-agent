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
  readonly lastStepAdmissions: number;
  readonly cursorAdmittedAt: number | null;
  readonly cursorTurnId: string | null;
}

interface PersistedRecoveryFailure {
  readonly failure_reason: 'corrupt_source' | 'incompatible_identity' | 'hybrid_missing_admission';
  readonly failure_sequence: number;
}

/**
 * Reconciles only canonical admission identity/order scalars. Transcript
 * membership and body decoding remain owned by their existing recovery path.
 */
export function advanceSessionTurnAdmissionRecovery(
  db: DatabaseSync,
  input: {
    readonly sessionId: string;
    readonly cursorAdmittedAt: number | null;
    readonly cursorTurnId: string | null;
    readonly maxAdmissions: number;
  },
): SessionTurnAdmissionRecoveryResult {
  if (
    !Number.isSafeInteger(input.maxAdmissions) ||
    input.maxAdmissions < 1 ||
    input.maxAdmissions > SESSION_TURN_ADMISSION_RECOVERY_MAX_ROWS ||
    (input.cursorAdmittedAt === null) !== (input.cursorTurnId === null)
  ) {
    throw new SessionTurnPositionRecoveryError(input.sessionId, 'corrupt_source');
  }
  const persistedFailure = db
    .prepare(`SELECT failure_reason, failure_sequence FROM session_turn_index_state
      WHERE session_id = ? AND failure_reason IS NOT NULL`)
    .get(input.sessionId) as PersistedRecoveryFailure | undefined;
  if (persistedFailure) {
    throw new SessionTurnPositionRecoveryError(
      input.sessionId,
      persistedFailure.failure_reason,
      persistedFailure.failure_sequence,
    );
  }
  const rows = (
    input.cursorAdmittedAt === null
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
          .all(input.sessionId, input.cursorAdmittedAt, input.cursorTurnId, input.maxAdmissions)
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
  let cursorAdmittedAt = input.cursorAdmittedAt;
  let cursorTurnId = input.cursorTurnId;
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
  return {
    complete: rows.length < input.maxAdmissions,
    lastStepAdmissions: rows.length,
    cursorAdmittedAt,
    cursorTurnId,
  };
}

function failAdmissionRecovery(db: DatabaseSync, sessionId: string): never {
  db.prepare(`UPDATE session_turn_index_state
    SET failure_reason = 'corrupt_source', failure_sequence = 0
    WHERE session_id = ?`).run(sessionId);
  throw new SessionTurnPositionRecoveryError(sessionId, 'corrupt_source', 0);
}
