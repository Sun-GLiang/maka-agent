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
import { sqliteTableExists } from './sqlite-schema-introspection.js';

export type SessionTurnIdentity =
  | { readonly kind: 'turn'; readonly turnId: string }
  | { readonly kind: 'note'; readonly turnId: string }
  | { readonly kind: 'ignored' };

export class SessionTurnIdentityClassificationError extends Error {
  constructor(readonly detail: string) {
    super(`Session Turn identity is incompatible: ${detail}`);
    this.name = 'SessionTurnIdentityClassificationError';
  }
}

export class SessionTurnMembershipPublicationError extends Error {
  constructor(
    readonly reason: 'corrupt_source' | 'incompatible_identity',
    readonly sequence: number,
  ) {
    super(`Session Turn membership publication failed (${reason}) at sequence ${sequence}`);
    this.name = 'SessionTurnMembershipPublicationError';
  }
}

export function classifySessionTurnIdentity(input: {
  readonly id: string;
  readonly type: string;
  readonly turnIdPresent: boolean;
  readonly turnId?: string;
  readonly kindPresent: boolean;
  readonly kind?: string;
}): SessionTurnIdentity {
  if (input.turnIdPresent) {
    if (typeof input.turnId !== 'string' || input.turnId.length === 0) {
      throw new SessionTurnIdentityClassificationError('turnId must be a non-empty string');
    }
    return { kind: 'turn', turnId: input.turnId };
  }
  if (input.type !== 'system_note') {
    throw new SessionTurnIdentityClassificationError('non-system message is missing turnId');
  }
  if (!input.kindPresent || typeof input.kind !== 'string' || input.kind.length === 0) {
    throw new SessionTurnIdentityClassificationError('turnless system note is missing kind');
  }
  return input.id.length > 0 && isUserVisibleSessionSystemNote(input.kind)
    ? { kind: 'note', turnId: `session-note:${input.id}` }
    : { kind: 'ignored' };
}

export function classifyStoredMessageTurnIdentity(message: StoredMessage): SessionTurnIdentity {
  const turnId = (message as { turnId?: unknown }).turnId;
  return classifySessionTurnIdentity({
    id: message.id,
    type: message.type,
    turnIdPresent: typeof turnId === 'string',
    turnId: typeof turnId === 'string' ? turnId : undefined,
    kindPresent: message.type === 'system_note',
    kind: message.type === 'system_note' ? message.kind : undefined,
  });
}

export function publishSessionTurnMembership(
  db: DatabaseSync,
  sessionId: string,
  sequence: number,
  identity: SessionTurnIdentity,
): void {
  if (identity.kind === 'ignored') return;
  const admission =
    identity.kind === 'turn' && sqliteTableExists(db, 'core_root_turn_admissions')
      ? (db
          .prepare(`
            SELECT admitted_at FROM core_root_turn_admissions
            WHERE session_id = ? AND turn_id = ?
          `)
          .get(sessionId, identity.turnId) as { admitted_at: number } | undefined)
      : undefined;
  const existingIdentity = db
    .prepare(`
      SELECT identity_kind FROM session_turn_metadata
      WHERE session_id = ? AND turn_id = ?
    `)
    .get(sessionId, identity.turnId) as { identity_kind: string } | undefined;
  if (existingIdentity && existingIdentity.identity_kind !== identity.kind) {
    throw new SessionTurnMembershipPublicationError('incompatible_identity', sequence);
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
    identity.turnId,
    identity.kind,
    admission ? 'admission' : 'legacy',
    admission?.admitted_at ?? null,
    sequence,
  );
  const inserted = db
    .prepare(`
      INSERT INTO session_turn_memberships(session_id, sequence, turn_id)
      VALUES (?, ?, ?) ON CONFLICT(session_id, sequence) DO NOTHING
    `)
    .run(sessionId, sequence, identity.turnId);
  if (inserted.changes === 1) return;
  const existing = db
    .prepare(`
      SELECT turn_id FROM session_turn_memberships WHERE session_id = ? AND sequence = ?
    `)
    .get(sessionId, sequence) as { turn_id: string } | undefined;
  if (existing?.turn_id !== identity.turnId) {
    throw new SessionTurnMembershipPublicationError('corrupt_source', sequence);
  }
}
