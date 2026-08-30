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
  classifySharedSessionTranscriptVisibility,
  isSessionSystemNoteKind,
  isStoredMessageType,
  type StoredMessage,
} from '@maka/core/session';
import { sqliteTableExists } from './sqlite-schema-introspection.js';

export type SessionTurnIdentity =
  | {
      readonly kind: 'turn' | 'note';
      readonly positionId: string;
      readonly sharedVisibility: boolean;
    }
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
  if (input.id.length === 0) {
    throw new SessionTurnIdentityClassificationError('message id must be a non-empty string');
  }
  if (!isStoredMessageType(input.type)) {
    throw new SessionTurnIdentityClassificationError('message type is unknown');
  }
  const visibility = (() => {
    if (input.type !== 'system_note') {
      return classifySharedSessionTranscriptVisibility({ type: input.type });
    }
    if (!input.kindPresent || !isSessionSystemNoteKind(input.kind)) {
      throw new SessionTurnIdentityClassificationError('system note kind is unknown or missing');
    }
    return classifySharedSessionTranscriptVisibility({ type: input.type, kind: input.kind });
  })();
  if (input.turnIdPresent) {
    if (typeof input.turnId !== 'string' || input.turnId.length === 0) {
      throw new SessionTurnIdentityClassificationError('turnId must be a non-empty string');
    }
    return {
      kind: 'turn',
      positionId: input.turnId,
      sharedVisibility: visibility === 'visible',
    };
  }
  if (input.type !== 'system_note') {
    throw new SessionTurnIdentityClassificationError('non-system message is missing turnId');
  }
  return visibility === 'visible'
    ? { kind: 'note', positionId: input.id, sharedVisibility: true }
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
          .get(sessionId, identity.positionId) as { admitted_at: number } | undefined)
      : undefined;
  db.prepare(`
    INSERT INTO session_turn_metadata(
      session_id, position_kind, position_id, order_source, admitted_at,
      owner_first_sequence, shared_first_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, position_kind, position_id) DO UPDATE SET
      order_source = CASE WHEN excluded.order_source = 'admission' THEN 'admission'
        ELSE session_turn_metadata.order_source END,
      admitted_at = COALESCE(excluded.admitted_at, session_turn_metadata.admitted_at),
      owner_first_sequence = CASE WHEN session_turn_metadata.owner_first_sequence IS NULL
        THEN excluded.owner_first_sequence
        ELSE MIN(session_turn_metadata.owner_first_sequence, excluded.owner_first_sequence) END,
      shared_first_sequence = CASE
        WHEN excluded.shared_first_sequence IS NULL THEN session_turn_metadata.shared_first_sequence
        WHEN session_turn_metadata.shared_first_sequence IS NULL THEN excluded.shared_first_sequence
        ELSE MIN(session_turn_metadata.shared_first_sequence, excluded.shared_first_sequence) END
  `).run(
    sessionId,
    identity.kind,
    identity.positionId,
    admission ? 'admission' : 'legacy',
    admission?.admitted_at ?? null,
    sequence,
    identity.sharedVisibility ? sequence : null,
  );
  const inserted = db
    .prepare(`
      INSERT INTO session_turn_memberships(
        session_id, sequence, position_kind, position_id, shared_visibility
      ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, sequence) DO NOTHING
    `)
    .run(
      sessionId,
      sequence,
      identity.kind,
      identity.positionId,
      identity.sharedVisibility ? 1 : 0,
    );
  if (inserted.changes === 1) return;
  const existing = db
    .prepare(`
      SELECT position_kind, position_id, shared_visibility
      FROM session_turn_memberships WHERE session_id = ? AND sequence = ?
    `)
    .get(sessionId, sequence) as
    | { position_kind: string; position_id: string; shared_visibility: number }
    | undefined;
  if (
    existing?.position_kind !== identity.kind ||
    existing.position_id !== identity.positionId ||
    existing.shared_visibility !== (identity.sharedVisibility ? 1 : 0)
  ) {
    throw new SessionTurnMembershipPublicationError('corrupt_source', sequence);
  }
}
