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
  SessionTurnPositionAnchorNotFoundError,
  SessionTurnPositionLimitError,
  SessionTurnPositionRecoveryError,
  SessionTurnPositionSnapshotMismatchError,
  type SessionTranscriptBodyPositionKey,
  type SessionTranscriptProjection,
  type SessionTranscriptRecordsByPositionKeysSnapshotRequest,
  type SessionTurnPositionPageSnapshotRequest,
  type SessionTurnPositionReadResult,
  type SessionTurnPositionSnapshotKey,
  type SessionTurnPositionSnapshotReleaseRequest,
} from './session-store.js';
import { ensureTurnIndexRows } from './session-turn-position-authority.js';
import { sqliteTableExists } from './sqlite-schema-introspection.js';

export const SESSION_TURN_POSITION_MAX_PAGE_POSITIONS = 128;
export const SESSION_TURN_POSITION_MAX_PAGE_BYTES = 64 * 1024;
export const SESSION_TURN_POSITION_BUILD_MAX_POSITIONS = 1_024;
export const SESSION_TURN_POSITION_BODY_MAX_KEYS = 128;
export const SESSION_TURN_POSITION_BODY_MAX_RECORDS = 256;
export const SESSION_TURN_POSITION_BODY_MAX_BYTES = 16 * 1024 * 1024;

export type SessionTurnPositionBuildPhase =
  | 'recovering'
  | 'legacy'
  | 'admission'
  | 'notes'
  | 'ready';

export interface SessionTurnPositionSnapshotRow {
  readonly slot: number;
  readonly through_sequence: number | null;
  readonly authority_revision: number;
  readonly snapshot_generation: number;
  readonly state: 'building' | 'ready';
  readonly build_phase: SessionTurnPositionBuildPhase;
  readonly build_next_owner_ordinal: number;
  readonly build_next_shared_ordinal: number;
  readonly build_cursor_sequence: number;
  readonly build_cursor_admitted_at: number | null;
  readonly build_cursor_position_kind: 'turn' | 'note' | null;
  readonly build_cursor_position_id: string | null;
  readonly ready_owner_total: number | null;
  readonly ready_shared_total: number | null;
}

export type SessionTurnPositionAllocation =
  | { readonly kind: 'snapshot'; readonly snapshot: SessionTurnPositionSnapshotRow }
  | Extract<SessionTurnPositionReadResult, { kind: 'capacity' }>;

export interface SessionTurnPositionBuildStep {
  readonly snapshot: SessionTurnPositionSnapshotRow;
  readonly executedPhase: Exclude<SessionTurnPositionBuildPhase, 'ready'>;
}

export interface SessionTurnMembershipPreflight {
  readonly records: readonly {
    readonly positionKey: SessionTranscriptBodyPositionKey;
    readonly sequence: number;
  }[];
  readonly storedBytes: number;
}

export function allocateOrRequireSessionTurnPositionSnapshot(
  db: DatabaseSync,
  request: SessionTurnPositionPageSnapshotRequest,
): SessionTurnPositionAllocation {
  validatePageRequest(request);
  ensureSessionExists(db, request.sessionId);
  ensureTurnIndexRows(db, request.sessionId);
  const actualThrough = readHighWater(db, request.sessionId);
  if (request.snapshotKey) {
    return {
      kind: 'snapshot',
      snapshot: requireLeasedSnapshot(
        db,
        request.sessionId,
        request.projection,
        request.snapshotLeaseId,
        request.snapshotKey,
      ),
    };
  }
  const throughSequence =
    request.throughSequence === undefined ? actualThrough : request.throughSequence;
  if (
    throughSequence !== null &&
    (!Number.isSafeInteger(throughSequence) ||
      throughSequence < 0 ||
      actualThrough === null ||
      throughSequence > actualThrough)
  ) {
    throw new SessionTurnPositionSnapshotMismatchError(request.sessionId);
  }
  const authorityRevision = readAuthorityRevision(db, request.sessionId);
  const existing = findSnapshotByAuthority(
    db,
    request.sessionId,
    throughSequence,
    authorityRevision,
  );
  if (existing) {
    acquireLease(
      db,
      request.sessionId,
      existing.snapshot_generation,
      request.projection,
      request.snapshotLeaseId,
    );
    return { kind: 'snapshot', snapshot: existing };
  }
  const occupied = db
    .prepare('SELECT slot FROM session_turn_position_snapshots WHERE session_id = ? ORDER BY slot')
    .all(request.sessionId) as Array<{ slot: number }>;
  if (occupied.length >= 2) {
    return {
      kind: 'capacity',
      projection: request.projection,
      throughSequence,
      authorityRevision,
      retainedSnapshots: 2,
    };
  }
  const used = new Set(occupied.map(({ slot }) => slot));
  const slot = used.has(0) ? 1 : 0;
  const generation = (
    db
      .prepare(`
        UPDATE session_turn_authority_revisions
        SET next_snapshot_generation = next_snapshot_generation + 1
        WHERE session_id = ?
        RETURNING next_snapshot_generation - 1 AS generation
      `)
      .get(request.sessionId) as { generation: number }
  ).generation;
  db.prepare(`
    INSERT INTO session_turn_position_snapshots(
      session_id, slot, through_sequence, authority_revision, snapshot_generation,
      state, build_phase
    ) VALUES (?, ?, ?, ?, ?, 'building', 'recovering')
  `).run(request.sessionId, slot, throughSequence, authorityRevision, generation);
  acquireLease(db, request.sessionId, generation, request.projection, request.snapshotLeaseId);
  return {
    kind: 'snapshot',
    snapshot: requireSnapshot(db, request.sessionId, {
      throughSequence,
      authorityRevision,
      snapshotGeneration: generation,
    }),
  };
}

export function markSessionTurnRecoveryComplete(
  db: DatabaseSync,
  sessionId: string,
  snapshot: SessionTurnPositionSnapshotRow,
): SessionTurnPositionSnapshotRow {
  if (snapshot.state !== 'building' || snapshot.build_phase !== 'recovering') return snapshot;
  const indexed = (
    db
      .prepare('SELECT indexed_through_sequence FROM session_turn_index_state WHERE session_id = ?')
      .get(sessionId) as { indexed_through_sequence: number }
  ).indexed_through_sequence;
  if (snapshot.through_sequence !== null && indexed < snapshot.through_sequence) return snapshot;
  const updated = db
    .prepare(`
      UPDATE session_turn_position_snapshots SET build_phase = 'legacy'
      WHERE session_id = ? AND slot = ? AND state = 'building' AND build_phase = 'recovering'
    `)
    .run(sessionId, snapshot.slot);
  if (updated.changes !== 1) throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  return requireSnapshot(db, sessionId, snapshotKeyFromRow(snapshot));
}

export function advanceSessionTurnPositionOrdinalBuild(
  db: DatabaseSync,
  sessionId: string,
  snapshot: SessionTurnPositionSnapshotRow,
): SessionTurnPositionBuildStep {
  if (snapshot.state !== 'building' || snapshot.build_phase === 'recovering') {
    throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  }
  const executedPhase = snapshot.build_phase;
  if (executedPhase === 'ready') throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  const boundary = validateHybridBoundary(db, sessionId, snapshot.through_sequence);
  const rows = readBuildRows(db, sessionId, snapshot, boundary, executedPhase);
  const insert = db.prepare(`
    INSERT INTO session_turn_snapshot_positions(
      session_id, snapshot_generation, position_kind, position_id,
      owner_ordinal, shared_ordinal, owner_first_sequence, shared_first_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let nextOwnerOrdinal = snapshot.build_next_owner_ordinal;
  let nextSharedOrdinal = snapshot.build_next_shared_ordinal;
  let sequenceCursor = snapshot.build_cursor_sequence;
  let admittedAtCursor = snapshot.build_cursor_admitted_at;
  let positionKindCursor = snapshot.build_cursor_position_kind;
  let positionIdCursor = snapshot.build_cursor_position_id;
  for (const row of rows) {
    const sharedVisible =
      row.shared_first_sequence !== null &&
      snapshot.through_sequence !== null &&
      row.shared_first_sequence <= snapshot.through_sequence;
    insert.run(
      sessionId,
      snapshot.snapshot_generation,
      row.position_kind,
      row.position_id,
      nextOwnerOrdinal,
      sharedVisible ? nextSharedOrdinal : null,
      row.owner_first_sequence,
      sharedVisible ? row.shared_first_sequence : null,
    );
    nextOwnerOrdinal += 1;
    if (sharedVisible) nextSharedOrdinal += 1;
    sequenceCursor = row.owner_first_sequence ?? sequenceCursor;
    admittedAtCursor = row.admitted_at;
    positionKindCursor = row.position_kind;
    positionIdCursor = row.position_id;
  }
  const exhausted = rows.length < SESSION_TURN_POSITION_BUILD_MAX_POSITIONS;
  const nextPhase = exhausted ? followingPhase(executedPhase) : executedPhase;
  if (nextPhase === 'ready') {
    if (nextOwnerOrdinal === 0) {
      insert.run(sessionId, snapshot.snapshot_generation, 'empty', '', 0, 0, null, null);
      nextOwnerOrdinal = 1;
      nextSharedOrdinal = 1;
    } else if (nextSharedOrdinal === 0) {
      insert.run(sessionId, snapshot.snapshot_generation, 'empty', '', null, 0, null, null);
      nextSharedOrdinal = 1;
    }
    const published = db
      .prepare(`
        UPDATE session_turn_position_snapshots
        SET state = 'ready', build_phase = 'ready',
          build_next_owner_ordinal = ?, build_next_shared_ordinal = ?,
          ready_owner_total = ?, ready_shared_total = ?
        WHERE session_id = ? AND slot = ? AND state = 'building' AND build_phase = ?
      `)
      .run(
        nextOwnerOrdinal,
        nextSharedOrdinal,
        nextOwnerOrdinal,
        nextSharedOrdinal,
        sessionId,
        snapshot.slot,
        executedPhase,
      );
    if (published.changes !== 1) throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  } else {
    const phaseChanged = nextPhase !== executedPhase;
    const updated = db
      .prepare(`
        UPDATE session_turn_position_snapshots
        SET build_phase = ?, build_next_owner_ordinal = ?, build_next_shared_ordinal = ?,
          build_cursor_sequence = ?, build_cursor_admitted_at = ?,
          build_cursor_position_kind = ?, build_cursor_position_id = ?
        WHERE session_id = ? AND slot = ? AND state = 'building' AND build_phase = ?
      `)
      .run(
        nextPhase,
        nextOwnerOrdinal,
        nextSharedOrdinal,
        phaseChanged ? -1 : sequenceCursor,
        phaseChanged ? null : admittedAtCursor,
        phaseChanged ? null : positionKindCursor,
        phaseChanged ? null : positionIdCursor,
        sessionId,
        snapshot.slot,
        executedPhase,
      );
    if (updated.changes !== 1) throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  }
  return {
    snapshot: requireSnapshot(db, sessionId, snapshotKeyFromRow(snapshot)),
    executedPhase,
  };
}

export function pageReadySessionTurnPositionSnapshot(
  db: DatabaseSync,
  request: SessionTurnPositionPageSnapshotRequest,
  snapshot: SessionTurnPositionSnapshotRow,
): Extract<SessionTurnPositionReadResult, { kind: 'page' }> {
  validatePageRequest(request);
  requireLease(
    db,
    request.sessionId,
    request.projection,
    request.snapshotLeaseId,
    snapshot.snapshot_generation,
  );
  const columns = projectionColumns(request.projection);
  const totalPositions =
    request.projection === 'owner' ? snapshot.ready_owner_total : snapshot.ready_shared_total;
  if (snapshot.state !== 'ready' || totalPositions === null || totalPositions < 1) {
    throw new SessionTurnPositionSnapshotMismatchError(request.sessionId);
  }
  let selectedOrdinal: number;
  switch (request.anchor.kind) {
    case 'tail':
      selectedOrdinal = totalPositions - 1;
      break;
    case 'ordinal':
      selectedOrdinal = Math.min(request.anchor.ordinal, totalPositions - 1);
      break;
    case 'sequence': {
      const row = db
        .prepare(`
          SELECT ${columns.ordinal} AS ordinal FROM session_turn_snapshot_positions
          WHERE session_id = ? AND snapshot_generation = ?
            AND ${columns.ordinal} IS NOT NULL AND ${columns.firstSequence} <= ?
          ORDER BY ${columns.firstSequence} DESC LIMIT 1
        `)
        .get(request.sessionId, snapshot.snapshot_generation, request.anchor.sequence) as
        | { ordinal: number }
        | undefined;
      selectedOrdinal = row?.ordinal ?? 0;
      break;
    }
    case 'turn': {
      const row = db
        .prepare(`
          SELECT ${columns.ordinal} AS ordinal FROM session_turn_snapshot_positions
          WHERE session_id = ? AND snapshot_generation = ?
            AND position_kind = 'turn' AND position_id = ?
            AND ${columns.ordinal} IS NOT NULL
        `)
        .get(request.sessionId, snapshot.snapshot_generation, request.anchor.turnId) as
        | { ordinal: number }
        | undefined;
      if (!row) {
        throw new SessionTurnPositionAnchorNotFoundError(request.sessionId, request.anchor.turnId);
      }
      selectedOrdinal = row.ordinal;
      break;
    }
  }
  let startOrdinal =
    request.anchor.kind === 'tail'
      ? Math.max(0, totalPositions - request.maxPositions)
      : selectedOrdinal;
  const rows = db
    .prepare(`
      SELECT ${columns.ordinal} AS ordinal, position_kind, position_id,
        ${columns.firstSequence} AS first_sequence
      FROM session_turn_snapshot_positions
      WHERE session_id = ? AND snapshot_generation = ? AND ${columns.ordinal} >= ?
      ORDER BY ${columns.ordinal} LIMIT ?
    `)
    .all(
      request.sessionId,
      snapshot.snapshot_generation,
      startOrdinal,
      request.maxPositions,
    ) as Array<{
    ordinal: number;
    position_kind: 'turn' | 'note' | 'empty';
    position_id: string;
    first_sequence: number | null;
  }>;
  const expectedRows = Math.min(request.maxPositions, totalPositions - startOrdinal);
  if (
    rows.length !== expectedRows ||
    rows.some((row, index) => row.ordinal !== startOrdinal + index)
  ) {
    throw new SessionTurnPositionRecoveryError(request.sessionId, 'corrupt_source');
  }
  let positions = rows.map((row) => ({
    ordinal: row.ordinal,
    key:
      row.position_kind === 'empty'
        ? ({ kind: 'empty' } as const)
        : ({ kind: row.position_kind, id: row.position_id } as const),
    firstSequence: row.first_sequence,
  }));
  const key = snapshotKeyFromRow(snapshot);
  while (
    positions.length > 0 &&
    Buffer.byteLength(
      JSON.stringify({
        kind: 'page',
        snapshotKey: key,
        projection: request.projection,
        startOrdinal,
        totalPositions,
        positions,
        hasOlder: startOrdinal > 0,
        hasNewer: startOrdinal + positions.length < totalPositions,
      }),
      'utf8',
    ) > SESSION_TURN_POSITION_MAX_PAGE_BYTES
  ) {
    if (request.anchor.kind === 'tail') {
      positions = positions.slice(1);
      startOrdinal += 1;
    } else {
      positions = positions.slice(0, -1);
    }
  }
  if (positions.length === 0) {
    throw new SessionTurnPositionLimitError(request.sessionId, 'page_metadata_bytes');
  }
  return {
    kind: 'page',
    snapshotKey: key,
    projection: request.projection,
    startOrdinal,
    totalPositions,
    positions,
    hasOlder: startOrdinal > 0,
    hasNewer: startOrdinal + positions.length < totalPositions,
  };
}

export function readSessionTurnMembershipPreflight(
  db: DatabaseSync,
  request: SessionTranscriptRecordsByPositionKeysSnapshotRequest,
): SessionTurnMembershipPreflight {
  validateRecordRequest(request);
  const snapshot = requireLeasedSnapshot(
    db,
    request.sessionId,
    request.projection,
    request.snapshotLeaseId,
    request.snapshotKey,
  );
  if (snapshot.state !== 'ready') {
    throw new SessionTurnPositionSnapshotMismatchError(request.sessionId);
  }
  const unique = new Set(request.positionKeys.map(positionKeyIdentity));
  if (unique.size !== request.positionKeys.length) {
    throw new SessionTurnPositionSnapshotMismatchError(request.sessionId);
  }
  const ordinalColumn = projectionColumns(request.projection).ordinal;
  const selected = request.positionKeys.map((positionKey) => {
    const row = db
      .prepare(`
        SELECT ${ordinalColumn} AS ordinal FROM session_turn_snapshot_positions
        WHERE session_id = ? AND snapshot_generation = ?
          AND position_kind = ? AND position_id = ? AND ${ordinalColumn} IS NOT NULL
      `)
      .get(request.sessionId, snapshot.snapshot_generation, positionKey.kind, positionKey.id) as
      | { ordinal: number }
      | undefined;
    if (!row) throw new SessionTurnPositionSnapshotMismatchError(request.sessionId);
    return { positionKey, ordinal: row.ordinal };
  });
  selected.sort((left, right) => left.ordinal - right.ordinal);
  const records: Array<{
    positionKey: SessionTranscriptBodyPositionKey;
    sequence: number;
  }> = [];
  let storedBytes = 0;
  for (const selectedPosition of selected) {
    if (request.snapshotKey.throughSequence === null) continue;
    const remaining = request.maxRecords - records.length;
    const rows = db
      .prepare(`
        SELECT membership.sequence,
          coalesce(payload.record_bytes, length(CAST(message.record_json AS BLOB))) AS stored_bytes
        FROM session_turn_memberships AS membership
        INNER JOIN session_messages AS message
          ON message.session_id = membership.session_id AND message.sequence = membership.sequence
        LEFT JOIN session_message_payloads AS payload
          ON payload.session_id = message.session_id AND payload.sequence = message.sequence
        WHERE membership.session_id = ? AND membership.position_kind = ?
          AND membership.position_id = ? AND membership.sequence <= ?
        ORDER BY membership.sequence LIMIT ?
      `)
      .all(
        request.sessionId,
        selectedPosition.positionKey.kind,
        selectedPosition.positionKey.id,
        request.snapshotKey.throughSequence,
        remaining + 1,
      ) as Array<{ sequence: number; stored_bytes: number }>;
    if (rows.length > remaining) {
      throw new SessionTurnPositionLimitError(request.sessionId, 'transcript_record_count');
    }
    for (const row of rows) {
      if (!Number.isSafeInteger(row.stored_bytes) || row.stored_bytes < 1) {
        throw new SessionTurnPositionRecoveryError(
          request.sessionId,
          'corrupt_source',
          row.sequence,
        );
      }
      storedBytes += row.stored_bytes;
      if (storedBytes > request.maxBytes) {
        throw new SessionTurnPositionLimitError(request.sessionId, 'transcript_record_bytes');
      }
      records.push({ positionKey: selectedPosition.positionKey, sequence: row.sequence });
    }
  }
  if (new Set(records.map((record) => record.sequence)).size !== records.length) {
    throw new SessionTurnPositionRecoveryError(request.sessionId, 'corrupt_source');
  }
  return { records, storedBytes };
}

export function releaseSessionTurnPositionSnapshot(
  db: DatabaseSync,
  request: SessionTurnPositionSnapshotReleaseRequest,
): void {
  validateProjection(request.projection);
  validateLeaseId(request.snapshotLeaseId);
  ensureTurnIndexRows(db, request.sessionId);
  const snapshot = requireLeasedSnapshot(
    db,
    request.sessionId,
    request.projection,
    request.snapshotLeaseId,
    request.snapshotKey,
  );
  const released = db
    .prepare(`
      DELETE FROM session_turn_snapshot_leases
      WHERE session_id = ? AND snapshot_generation = ? AND projection = ? AND lease_id = ?
    `)
    .run(
      request.sessionId,
      snapshot.snapshot_generation,
      request.projection,
      request.snapshotLeaseId,
    );
  if (released.changes !== 1) {
    throw new SessionTurnPositionSnapshotMismatchError(request.sessionId);
  }
  const retained = db
    .prepare(`
      SELECT 1 FROM session_turn_snapshot_leases
      WHERE session_id = ? AND snapshot_generation = ? LIMIT 1
    `)
    .get(request.sessionId, snapshot.snapshot_generation);
  if (!retained) {
    db.prepare(`
      DELETE FROM session_turn_position_snapshots
      WHERE session_id = ? AND snapshot_generation = ?
    `).run(request.sessionId, snapshot.snapshot_generation);
  }
}

export function reclaimSessionTurnPositionSnapshotsForNewOwner(db: DatabaseSync): void {
  if (!sqliteTableExists(db, 'session_turn_position_snapshots')) return;
  db.prepare('DELETE FROM session_turn_position_snapshots').run();
}

export function snapshotKeyFromRow(
  row: SessionTurnPositionSnapshotRow,
): SessionTurnPositionSnapshotKey {
  return {
    throughSequence: row.through_sequence,
    authorityRevision: row.authority_revision,
    snapshotGeneration: row.snapshot_generation,
  };
}

export function requireSnapshot(
  db: DatabaseSync,
  sessionId: string,
  key: SessionTurnPositionSnapshotKey,
): SessionTurnPositionSnapshotRow {
  validateSnapshotKey(key);
  const row = db
    .prepare(`
      SELECT slot, through_sequence, authority_revision, snapshot_generation, state,
        build_phase, build_next_owner_ordinal, build_next_shared_ordinal,
        build_cursor_sequence, build_cursor_admitted_at, build_cursor_position_kind,
        build_cursor_position_id, ready_owner_total, ready_shared_total
      FROM session_turn_position_snapshots
      WHERE session_id = ? AND snapshot_generation = ?
    `)
    .get(sessionId, key.snapshotGeneration) as SessionTurnPositionSnapshotRow | undefined;
  if (
    !row ||
    row.through_sequence !== key.throughSequence ||
    row.authority_revision !== key.authorityRevision
  ) {
    throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  }
  return row;
}

function requireLeasedSnapshot(
  db: DatabaseSync,
  sessionId: string,
  projection: SessionTranscriptProjection,
  leaseId: string,
  key: SessionTurnPositionSnapshotKey,
): SessionTurnPositionSnapshotRow {
  validateProjection(projection);
  validateLeaseId(leaseId);
  const snapshot = requireSnapshot(db, sessionId, key);
  requireLease(db, sessionId, projection, leaseId, snapshot.snapshot_generation);
  return snapshot;
}

function requireLease(
  db: DatabaseSync,
  sessionId: string,
  projection: SessionTranscriptProjection,
  leaseId: string,
  generation: number,
): void {
  if (
    !db
      .prepare(`
        SELECT 1 FROM session_turn_snapshot_leases
        WHERE session_id = ? AND snapshot_generation = ? AND projection = ? AND lease_id = ?
      `)
      .get(sessionId, generation, projection, leaseId)
  ) {
    throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  }
}

function acquireLease(
  db: DatabaseSync,
  sessionId: string,
  generation: number,
  projection: SessionTranscriptProjection,
  leaseId: string,
): void {
  validateProjection(projection);
  validateLeaseId(leaseId);
  const inserted = db
    .prepare(`
      INSERT INTO session_turn_snapshot_leases(
        session_id, snapshot_generation, projection, lease_id
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, projection, lease_id) DO NOTHING
    `)
    .run(sessionId, generation, projection, leaseId);
  if (inserted.changes === 0) {
    const existing = db
      .prepare(`
        SELECT snapshot_generation FROM session_turn_snapshot_leases
        WHERE session_id = ? AND projection = ? AND lease_id = ?
      `)
      .get(sessionId, projection, leaseId) as { snapshot_generation: number } | undefined;
    if (existing?.snapshot_generation === generation) return;
    throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  }
}

function findSnapshotByAuthority(
  db: DatabaseSync,
  sessionId: string,
  throughSequence: number | null,
  authorityRevision: number,
): SessionTurnPositionSnapshotRow | undefined {
  return db
    .prepare(`
      SELECT slot, through_sequence, authority_revision, snapshot_generation, state,
        build_phase, build_next_owner_ordinal, build_next_shared_ordinal,
        build_cursor_sequence, build_cursor_admitted_at, build_cursor_position_kind,
        build_cursor_position_id, ready_owner_total, ready_shared_total
      FROM session_turn_position_snapshots
      WHERE session_id = ?
        AND ((through_sequence = ?) OR (through_sequence IS NULL AND ? IS NULL))
        AND authority_revision = ?
    `)
    .get(sessionId, throughSequence, throughSequence, authorityRevision) as
    | SessionTurnPositionSnapshotRow
    | undefined;
}

interface BuildRow {
  readonly position_kind: 'turn' | 'note';
  readonly position_id: string;
  readonly owner_first_sequence: number | null;
  readonly shared_first_sequence: number | null;
  readonly admitted_at: number | null;
}

function readBuildRows(
  db: DatabaseSync,
  sessionId: string,
  snapshot: SessionTurnPositionSnapshotRow,
  boundary: number | null,
  phase: Exclude<SessionTurnPositionBuildPhase, 'recovering' | 'ready'>,
): BuildRow[] {
  const through = snapshot.through_sequence;
  if (phase === 'legacy') {
    if (through === null) return [];
    return db
      .prepare(`
        SELECT position_kind, position_id, owner_first_sequence,
          shared_first_sequence, NULL AS admitted_at
        FROM session_turn_metadata
        WHERE session_id = ? AND owner_first_sequence <= ? AND order_source = 'legacy'
          AND (? IS NULL OR owner_first_sequence < ?)
          AND owner_first_sequence > ?
        ORDER BY owner_first_sequence, position_kind, position_id LIMIT ?
      `)
      .all(
        sessionId,
        through,
        boundary,
        boundary,
        snapshot.build_cursor_sequence,
        SESSION_TURN_POSITION_BUILD_MAX_POSITIONS,
      ) as unknown as BuildRow[];
  }
  if (phase === 'admission') {
    const watermarkSql =
      through === null
        ? 'owner_first_sequence IS NULL'
        : '(owner_first_sequence IS NULL OR owner_first_sequence <= ?)';
    const parameters: Array<string | number | null> = [sessionId];
    if (through !== null) parameters.push(through);
    parameters.push(
      snapshot.build_cursor_admitted_at,
      snapshot.build_cursor_admitted_at,
      snapshot.build_cursor_admitted_at,
      snapshot.build_cursor_position_id,
      SESSION_TURN_POSITION_BUILD_MAX_POSITIONS,
    );
    return db
      .prepare(`
        SELECT position_kind, position_id, owner_first_sequence,
          shared_first_sequence, admitted_at
        FROM session_turn_metadata
        WHERE session_id = ? AND position_kind = 'turn'
          AND order_source = 'admission' AND ${watermarkSql}
          AND (? IS NULL OR admitted_at > ? OR (admitted_at = ? AND position_id > ?))
        ORDER BY admitted_at, position_id LIMIT ?
      `)
      .all(...parameters) as unknown as BuildRow[];
  }
  if (through === null || boundary === null) return [];
  return db
    .prepare(`
      SELECT position_kind, position_id, owner_first_sequence,
        shared_first_sequence, NULL AS admitted_at
      FROM session_turn_metadata
      WHERE session_id = ? AND owner_first_sequence <= ? AND position_kind = 'note'
        AND order_source = 'legacy' AND owner_first_sequence >= ?
        AND owner_first_sequence > ?
      ORDER BY owner_first_sequence, position_id LIMIT ?
    `)
    .all(
      sessionId,
      through,
      boundary,
      snapshot.build_cursor_sequence,
      SESSION_TURN_POSITION_BUILD_MAX_POSITIONS,
    ) as unknown as BuildRow[];
}

function validateHybridBoundary(
  db: DatabaseSync,
  sessionId: string,
  throughSequence: number | null,
): number | null {
  if (throughSequence === null) return null;
  const boundary = (
    db
      .prepare(`
        SELECT MIN(owner_first_sequence) AS boundary FROM session_turn_metadata
        WHERE session_id = ? AND position_kind = 'turn'
          AND order_source = 'admission' AND owner_first_sequence <= ?
      `)
      .get(sessionId, throughSequence) as { boundary: number | null }
  ).boundary;
  if (boundary !== null) {
    const hybrid = db
      .prepare(`
        SELECT owner_first_sequence FROM session_turn_metadata
        WHERE session_id = ? AND position_kind = 'turn' AND order_source = 'legacy'
          AND owner_first_sequence >= ? AND owner_first_sequence <= ?
        ORDER BY owner_first_sequence LIMIT 1
      `)
      .get(sessionId, boundary, throughSequence) as { owner_first_sequence: number } | undefined;
    if (hybrid) {
      db.prepare(`
        UPDATE session_turn_index_state
        SET failure_reason = 'hybrid_missing_admission', failure_sequence = ?
        WHERE session_id = ?
      `).run(hybrid.owner_first_sequence, sessionId);
      throw new SessionTurnPositionRecoveryError(
        sessionId,
        'hybrid_missing_admission',
        hybrid.owner_first_sequence,
      );
    }
  }
  return boundary;
}

function followingPhase(
  phase: Exclude<SessionTurnPositionBuildPhase, 'recovering' | 'ready'>,
): Exclude<SessionTurnPositionBuildPhase, 'recovering'> {
  if (phase === 'legacy') return 'admission';
  if (phase === 'admission') return 'notes';
  return 'ready';
}

function validatePageRequest(request: SessionTurnPositionPageSnapshotRequest): void {
  validateProjection(request.projection);
  validateLeaseId(request.snapshotLeaseId);
  if (
    !Number.isSafeInteger(request.maxPositions) ||
    request.maxPositions < 1 ||
    request.maxPositions > SESSION_TURN_POSITION_MAX_PAGE_POSITIONS ||
    (request.snapshotKey !== undefined && request.throughSequence !== undefined)
  ) {
    throw new Error('Invalid Session Turn-position page request');
  }
  if (
    request.anchor.kind === 'ordinal' &&
    (!Number.isSafeInteger(request.anchor.ordinal) || request.anchor.ordinal < 0)
  ) {
    throw new Error('Invalid Session Turn-position ordinal anchor');
  }
  if (
    request.anchor.kind === 'sequence' &&
    (!Number.isSafeInteger(request.anchor.sequence) || request.anchor.sequence < 0)
  ) {
    throw new Error('Invalid Session Turn-position sequence anchor');
  }
  if (request.anchor.kind === 'turn' && request.anchor.turnId.length === 0) {
    throw new Error('Invalid Session Turn-position Turn anchor');
  }
}

function validateRecordRequest(
  request: SessionTranscriptRecordsByPositionKeysSnapshotRequest,
): void {
  validateProjection(request.projection);
  validateLeaseId(request.snapshotLeaseId);
  if (
    request.positionKeys.length < 1 ||
    request.positionKeys.length > SESSION_TURN_POSITION_BODY_MAX_KEYS ||
    request.positionKeys.some(
      (positionKey) =>
        (positionKey.kind !== 'turn' && positionKey.kind !== 'note') ||
        typeof positionKey.id !== 'string' ||
        positionKey.id.length === 0,
    ) ||
    !Number.isSafeInteger(request.maxRecords) ||
    request.maxRecords < 1 ||
    request.maxRecords > SESSION_TURN_POSITION_BODY_MAX_RECORDS ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1 ||
    request.maxBytes > SESSION_TURN_POSITION_BODY_MAX_BYTES
  ) {
    throw new Error('Invalid Session Turn-position record request');
  }
  validateSnapshotKey(request.snapshotKey);
}

function projectionColumns(projection: SessionTranscriptProjection): {
  readonly ordinal: 'owner_ordinal' | 'shared_ordinal';
  readonly firstSequence: 'owner_first_sequence' | 'shared_first_sequence';
} {
  return projection === 'owner'
    ? { ordinal: 'owner_ordinal', firstSequence: 'owner_first_sequence' }
    : { ordinal: 'shared_ordinal', firstSequence: 'shared_first_sequence' };
}

function positionKeyIdentity(positionKey: SessionTranscriptBodyPositionKey): string {
  return `${positionKey.kind}\0${positionKey.id}`;
}

function validateProjection(projection: string): asserts projection is SessionTranscriptProjection {
  if (projection !== 'owner' && projection !== 'shared') {
    throw new Error('Invalid Session transcript projection');
  }
}

function validateLeaseId(leaseId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(leaseId)) {
    throw new Error('Invalid Session Turn-position snapshot lease id');
  }
}

function validateSnapshotKey(key: SessionTurnPositionSnapshotKey): void {
  if (
    (key.throughSequence !== null &&
      (!Number.isSafeInteger(key.throughSequence) || key.throughSequence < 0)) ||
    !Number.isSafeInteger(key.authorityRevision) ||
    key.authorityRevision < 0 ||
    !Number.isSafeInteger(key.snapshotGeneration) ||
    key.snapshotGeneration < 1
  ) {
    throw new Error('Invalid Session Turn-position snapshot key');
  }
}

function readHighWater(db: DatabaseSync, sessionId: string): number | null {
  return (
    db
      .prepare('SELECT MAX(sequence) AS high_water FROM session_messages WHERE session_id = ?')
      .get(sessionId) as { high_water: number | null }
  ).high_water;
}

function readAuthorityRevision(db: DatabaseSync, sessionId: string): number {
  return (
    db
      .prepare(`
        SELECT authority_revision FROM session_turn_authority_revisions WHERE session_id = ?
      `)
      .get(sessionId) as { authority_revision: number }
  ).authority_revision;
}

function ensureSessionExists(db: DatabaseSync, sessionId: string): void {
  if (!db.prepare('SELECT 1 FROM session_metadata WHERE session_id = ?').get(sessionId)) {
    throw new SessionTurnPositionSnapshotMismatchError(sessionId);
  }
}
