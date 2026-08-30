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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { createSHA256 } from 'hash-wasm';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import { createConversationOperationalStateStore } from '../conversation-operational-state.js';
import { OPERATIONAL_STATE_DATABASE_NAME } from '../operational-state-store.js';
import { createSessionStore } from '../session-store.js';
import { advanceSessionTurnIdentityRecovery } from '../session-turn-identity-recovery.js';

describe('Session Turn position snapshots', () => {
  test('materializes owner and shared tagged positions in one exact generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-dual-turn-position-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(session.id, [
        {
          type: 'permission_decision',
          id: 'hidden-first',
          turnId: 'same-id',
          ts: 1,
          toolUseId: 'tool-use',
          toolName: 'Bash',
          decision: 'deny',
        },
        { type: 'user', id: 'visible-second', turnId: 'same-id', ts: 2, text: 'visible' },
        { type: 'system_note', id: 'same-id', ts: 3, kind: 'step_limit' },
      ]);

      const owner = await readyPage(store, session.id, 'owner-lease', 'owner');
      const shared = await readyPage(store, session.id, 'shared-lease', 'shared');
      assert.equal(owner.snapshotKey.snapshotGeneration, shared.snapshotKey.snapshotGeneration);
      assert.equal(owner.totalPositions, 2);
      assert.equal(shared.totalPositions, 2);
      assert.deepEqual(owner.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'same-id' }, firstSequence: 0 },
        { ordinal: 1, key: { kind: 'note', id: 'same-id' }, firstSequence: 2 },
      ]);
      assert.deepEqual(shared.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'same-id' }, firstSequence: 1 },
        { ordinal: 1, key: { kind: 'note', id: 'same-id' }, firstSequence: 2 },
      ]);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('makes empty and all-hidden shared projections observably identical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-shared-empty-position-'));
    const store = createSessionStore(root);
    try {
      const emptySession = await store.create(makeInput({ name: 'Empty' }));
      const hiddenSession = await store.create(makeInput({ name: 'Hidden' }));
      await store.appendMessages(hiddenSession.id, [
        hiddenPermission('hidden-turn', 0),
        {
          type: 'system_note',
          id: 'hidden-note',
          ts: 1,
          kind: 'mode_change',
        },
      ]);
      const empty = await readyPage(store, emptySession.id, 'empty-shared', 'shared');
      const hidden = await readyPage(store, hiddenSession.id, 'hidden-shared', 'shared');
      assert.equal(empty.totalPositions, 1);
      assert.equal(hidden.totalPositions, 1);
      assert.deepEqual(empty.positions, [
        { ordinal: 0, key: { kind: 'empty' }, firstSequence: null },
      ]);
      assert.deepEqual(hidden.positions, empty.positions);
      const owner = await readyPage(store, hiddenSession.id, 'hidden-owner', 'owner');
      assert.deepEqual(owner.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'hidden-turn' }, firstSequence: 0 },
      ]);
      assert.equal(owner.snapshotKey.snapshotGeneration, hidden.snapshotKey.snapshotGeneration);
      await assert.rejects(
        store.readTranscriptRecordsByPositionKeysSnapshot({
          sessionId: hiddenSession.id,
          projection: 'shared',
          snapshotLeaseId: 'hidden-shared',
          snapshotKey: hidden.snapshotKey,
          positionKeys: bodyKeys('hidden-turn'),
          maxRecords: 1,
          maxBytes: 64 * 1024,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('binds leases to a projection while sharing one retained generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-projection-lease-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, user('turn-a', 0));
      const owner = await readyPage(store, session.id, 'owner-only', 'owner');
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'shared',
          snapshotLeaseId: 'owner-only',
          snapshotKey: owner.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
      const shared = await readyPage(store, session.id, 'shared-only', 'shared');
      assert.deepEqual(shared.snapshotKey, owner.snapshotKey);
      await store.releaseTurnPositionSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'owner-only',
        snapshotKey: owner.snapshotKey,
      });
      const retained = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'shared',
        snapshotLeaseId: 'shared-only',
        snapshotKey: shared.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(retained.kind, 'page');
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed and lazily rebuilds when persisted shared policy version drifts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-shared-policy-version-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, user('turn-a', 0));
      const before = await readyPage(store, session.id, 'policy-before', 'shared');
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(`UPDATE session_turn_authority_revisions
          SET visibility_policy_version = 999 WHERE session_id = ?`)
          .run(session.id);
      } finally {
        database.close();
      }
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'shared',
          snapshotLeaseId: 'policy-before',
          snapshotKey: before.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
      const after = await readyPage(store, session.id, 'policy-after', 'shared');
      assert.equal(after.snapshotKey.authorityRevision, before.snapshotKey.authorityRevision + 1);
      assert.ok(after.snapshotKey.snapshotGeneration > before.snapshotKey.snapshotGeneration);
      assert.deepEqual(after.positions, before.positions);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('publishes one stable synthetic position for an empty Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-empty-turn-position-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      const page = await readyPage(store, session.id);

      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('expected an atomically ready page');
      assert.deepEqual(page.snapshotKey, {
        throughSequence: null,
        authorityRevision: 0,
        snapshotGeneration: 1,
      });
      assert.equal(page.startOrdinal, 0);
      assert.equal(page.totalPositions, 1);
      assert.deepEqual(page.positions, [
        {
          ordinal: 0,
          key: { kind: 'empty' },
          firstSequence: null,
        },
      ]);
      assert.equal(page.hasOlder, false);
      assert.equal(page.hasNewer, false);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses inclusive predecessor semantics for legacy ordinal, sequence, and turn anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-legacy-turn-position-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(session.id, [
        { type: 'user', id: 'user-a', turnId: 'turn-a', ts: 1, text: 'a' },
        {
          type: 'assistant',
          id: 'assistant-a',
          turnId: 'turn-a',
          ts: 2,
          text: 'A',
          modelId: 'test-model',
        },
        { type: 'user', id: 'user-b', turnId: 'turn-b', ts: 3, text: 'b' },
        {
          type: 'assistant',
          id: 'assistant-b',
          turnId: 'turn-b',
          ts: 4,
          text: 'B',
          modelId: 'test-model',
        },
        { type: 'system_note', id: 'note', ts: 5, kind: 'step_limit' },
      ]);

      const ready = await readyPage(store, session.id);
      const first = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: ready.snapshotKey,
        anchor: { kind: 'ordinal', ordinal: 1 },
        maxPositions: 2,
      });
      assert.equal(first.kind, 'page');
      if (first.kind !== 'page') assert.fail('expected a ready legacy page');
      assert.deepEqual(first.positions, [
        { ordinal: 1, key: { kind: 'turn', id: 'turn-b' }, firstSequence: 2 },
        { ordinal: 2, key: { kind: 'note', id: 'note' }, firstSequence: 4 },
      ]);

      for (const anchor of [
        { kind: 'sequence' as const, sequence: 3 },
        { kind: 'turn' as const, turnId: 'turn-b' },
      ]) {
        const anchored = await store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: first.snapshotKey,
          anchor,
          maxPositions: 2,
        });
        assert.equal(anchored.kind, 'page');
        if (anchored.kind !== 'page') assert.fail('expected an exact snapshot page');
        assert.equal(anchored.startOrdinal, 1);
        assert.deepEqual(anchored.positions, first.positions);
      }
      const clamped = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: ready.snapshotKey,
        anchor: { kind: 'ordinal', ordinal: 999 },
        maxPositions: 2,
      });
      assert.equal(clamped.kind, 'page');
      if (clamped.kind !== 'page') assert.fail('expected a clamped inclusive ordinal');
      assert.deepEqual(clamped.positions, [
        { ordinal: 2, key: { kind: 'note', id: 'note' }, firstSequence: 4 },
      ]);
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: ready.snapshotKey,
          anchor: { kind: 'turn', turnId: 'missing-turn' },
          maxPositions: 2,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_anchor_not_found',
      );
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: ready.snapshotKey,
          anchor: { kind: 'turn', turnId: '' },
          maxPositions: 2,
        }),
        /invalid/iu,
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('orders modern Turns only by root admission and keeps steering in its existing position', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-modern-turn-position-'));
    const store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    try {
      const session = await store.create(makeInput());
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-b', 'user-b', 10));
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-a', 'user-a', 10));
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-c', 'user-c', 5));
      await store.appendMessages(session.id, [
        { type: 'user', id: 'user-b', turnId: 'turn-b', ts: 1, text: 'b' },
        { type: 'user', id: 'user-a', turnId: 'turn-a', ts: 2, text: 'a' },
        { type: 'user', id: 'user-c', turnId: 'turn-c', ts: 3, text: 'c' },
        {
          type: 'user',
          id: 'steering-b',
          turnId: 'turn-b',
          ts: 4,
          text: 'steer',
          steeringEventId: 'steering-b',
        },
      ]);

      const page = await readyPage(store, session.id);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('expected modern positions');
      assert.deepEqual(page.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-c' }, firstSequence: 2 },
        { ordinal: 1, key: { kind: 'turn', id: 'turn-a' }, firstSequence: 1 },
        { ordinal: 2, key: { kind: 'turn', id: 'turn-b' }, firstSequence: 0 },
      ]);
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('represents admission-before-body and applies the closed turnless-note visibility policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-admission-before-body-'));
    const store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    try {
      const session = await store.create(makeInput());
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-bodyless', 'future-user', 10));
      const bodyless = await readyPage(store, session.id, 'lease-bodyless');
      assert.deepEqual(bodyless.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-bodyless' }, firstSequence: null },
      ]);
      const bodylessRecords = await store.readTranscriptRecordsByPositionKeysSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-bodyless',
        snapshotKey: bodyless.snapshotKey,
        positionKeys: bodyKeys('turn-bodyless'),
        maxRecords: 1,
        maxBytes: 1,
      });
      assert.deepEqual(bodylessRecords.records, []);
      assert.equal(bodylessRecords.rawBytes, 0);
      const sharedBodyless = await readyPage(store, session.id, 'lease-bodyless-shared', 'shared');
      assert.equal(
        sharedBodyless.snapshotKey.snapshotGeneration,
        bodyless.snapshotKey.snapshotGeneration,
      );
      assert.deepEqual(sharedBodyless.positions, [
        { ordinal: 0, key: { kind: 'empty' }, firstSequence: null },
      ]);

      await store.appendMessages(session.id, [
        { type: 'system_note', id: 'hidden-note', ts: 1, kind: 'mode_change' },
        {
          type: 'system_note',
          id: 'associated-note',
          turnId: 'turn-bodyless',
          ts: 2,
          kind: 'error',
        },
        { type: 'user', id: 'future-user', turnId: 'turn-bodyless', ts: 3, text: 'body' },
        { type: 'system_note', id: 'visible-note', ts: 4, kind: 'step_limit' },
      ]);
      const materialized = await readyPage(store, session.id, 'lease-materialized');
      assert.deepEqual(materialized.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-bodyless' }, firstSequence: 1 },
        { ordinal: 1, key: { kind: 'note', id: 'visible-note' }, firstSequence: 3 },
      ]);
      const sharedMaterialized = await readyPage(
        store,
        session.id,
        'lease-materialized-shared',
        'shared',
      );
      assert.deepEqual(sharedMaterialized.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-bodyless' }, firstSequence: 2 },
        { ordinal: 1, key: { kind: 'note', id: 'visible-note' }, firstSequence: 3 },
      ]);
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed on an explicitly empty Turn identity before committing the append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-empty-turn-identity-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await assert.rejects(
        store.appendMessage(session.id, {
          type: 'user',
          id: 'empty-turn',
          turnId: '',
          ts: 1,
          text: 'invalid',
        }),
        (error: unknown) => {
          assert.equal((error as { reason?: unknown }).reason, 'incompatible_identity');
          return true;
        },
      );
      assert.equal(await store.readTranscriptHighWaterSnapshot(session.id), null);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps equal note and Turn strings distinct through composite identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-note-turn-identity-collision-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessage(session.id, {
        type: 'system_note',
        id: 'session-note:collision',
        ts: 1,
        kind: 'step_limit',
      });
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'colliding-turn',
        turnId: 'session-note:collision',
        ts: 2,
        text: 'separate Turn namespace',
      });
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'prefixed-turn',
        turnId: 'session:real-turn',
        ts: 3,
        text: 'prefix is opaque',
      });
      const page = await readyPage(store, session.id, 'lease-collision');
      assert.deepEqual(
        page.positions.map(({ key }) => key),
        [
          { kind: 'note', id: 'session-note:collision' },
          { kind: 'turn', id: 'session-note:collision' },
          { kind: 'turn', id: 'session:real-turn' },
        ],
      );
      const turnAnchor = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-collision',
        snapshotKey: page.snapshotKey,
        anchor: { kind: 'turn', turnId: 'session-note:collision' },
        maxPositions: 1,
      });
      assert.equal(turnAnchor.kind, 'page');
      if (turnAnchor.kind !== 'page') assert.fail('expected exact Turn anchor');
      assert.equal(turnAnchor.startOrdinal, 1);
      const bodies = await store.readTranscriptRecordsByPositionKeysSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-collision',
        snapshotKey: page.snapshotKey,
        positionKeys: [
          { kind: 'turn', id: 'session-note:collision' },
          { kind: 'note', id: 'session-note:collision' },
        ],
        maxRecords: 2,
        maxBytes: 64 * 1024,
      });
      assert.deepEqual(
        bodies.records.map(({ positionKey, message }) => [positionKey, message.id]),
        [
          [{ kind: 'note', id: 'session-note:collision' }, 'session-note:collision'],
          [{ kind: 'turn', id: 'session-note:collision' }, 'colliding-turn'],
        ],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('purging admission authority removes bodyless placeholders and downgrades body Turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-admission-purge-position-'));
    const store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    const conversation = createConversationOperationalStateStore(root);
    try {
      const session = await store.create(makeInput());
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-bodyless', 'future-user', 5));
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-body', 'body-user', 10));
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'body-user',
        turnId: 'turn-body',
        ts: 1,
        text: 'body',
      });
      const admitted = await readyPage(store, session.id, 'lease-admitted');
      assert.deepEqual(
        admitted.positions.map(({ key }) => (key.kind === 'empty' ? '' : key.id)),
        ['turn-bodyless', 'turn-body'],
      );

      await conversation.purge(session.id);
      const legacy = await readyPage(store, session.id, 'lease-purged');
      assert.equal(
        legacy.snapshotKey.authorityRevision,
        admitted.snapshotKey.authorityRevision + 1,
      );
      assert.deepEqual(legacy.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-body' }, firstSequence: 0 },
      ]);
      await store.remove(session.id);
      await conversation.purge(session.id);
    } finally {
      conversation.close();
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('shares one exact generation across leases and releases only after the last consumer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-shared-position-lease-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, user('turn-a', 0));
      const first = await readyPage(store, session.id, 'lease-one');
      const secondFacade = createSessionStore(root);
      const shared = await secondFacade.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-two',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(shared.kind, 'page');
      if (shared.kind !== 'page') assert.fail('expected shared ready snapshot');
      assert.deepEqual(shared.snapshotKey, first.snapshotKey);
      await secondFacade.close?.();

      await store.releaseTurnPositionSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-one',
        snapshotKey: first.snapshotKey,
      });
      const retained = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-two',
        snapshotKey: first.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(retained.kind, 'page');
      await store.releaseTurnPositionSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-two',
        snapshotKey: first.snapshotKey,
      });
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-two',
          snapshotKey: first.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
      const rebuilt = await readyPage(store, session.id, 'lease-three');
      assert.ok(rebuilt.snapshotKey.snapshotGeneration > first.snapshotKey.snapshotGeneration);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps a legacy prefix by sequence before admission-ordered modern Turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-hybrid-prefix-turn-position-'));
    const store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    try {
      const session = await store.create(makeInput());
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-b', 'user-b', 20));
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-a', 'user-a', 10));
      await store.appendMessages(session.id, [
        user('turn-legacy', 0),
        user('turn-b', 1),
        user('turn-a', 2),
        { type: 'system_note', id: 'modern-note', ts: 4, kind: 'step_limit' },
      ]);

      const page = await readyPage(store, session.id);
      assert.deepEqual(page.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-legacy' }, firstSequence: 0 },
        { ordinal: 1, key: { kind: 'turn', id: 'turn-a' }, firstSequence: 2 },
        { ordinal: 2, key: { kind: 'turn', id: 'turn-b' }, firstSequence: 1 },
        { ordinal: 3, key: { kind: 'note', id: 'modern-note' }, firstSequence: 3 },
      ]);
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed after bounded recovery finds a hybrid Turn without admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-hybrid-turn-position-'));
    const store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    try {
      const session = await store.create(makeInput());
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-modern', 'user-modern', 10));
      await store.appendMessages(session.id, [
        { type: 'user', id: 'user-modern', turnId: 'turn-modern', ts: 1, text: 'modern' },
        { type: 'user', id: 'user-missing', turnId: 'turn-missing', ts: 2, text: 'missing' },
      ]);

      await assert.rejects(readyPage(store, session.id), (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'session_turn_position_recovery_failed');
        assert.equal((error as { reason?: unknown }).reason, 'hybrid_missing_admission');
        return true;
      });
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('increments authority at a fixed watermark while preserving the old exact snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-authority-revision-'));
    const store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(session.id, [user('turn-a', 0), user('turn-b', 1)]);
      const legacy = await readyPage(store, session.id);
      assert.deepEqual(
        legacy.positions.map(({ key }) => (key.kind === 'empty' ? '' : key.id)),
        ['turn-a', 'turn-b'],
      );

      await runs.admitRootTurn(rootAdmission(session.id, 'turn-b', 'user-1', 10));
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-a', 'user-0', 20));

      const modern = await readyPage(store, session.id, 'lease-modern');
      assert.deepEqual(modern.snapshotKey, {
        throughSequence: legacy.snapshotKey.throughSequence,
        authorityRevision: legacy.snapshotKey.authorityRevision + 2,
        snapshotGeneration: legacy.snapshotKey.snapshotGeneration + 1,
      });
      assert.deepEqual(
        modern.positions.map(({ key }) => (key.kind === 'empty' ? '' : key.id)),
        ['turn-b', 'turn-a'],
      );

      const stableLegacy = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: legacy.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(stableLegacy.kind, 'page');
      if (stableLegacy.kind !== 'page') assert.fail('expected retained exact snapshot');
      assert.deepEqual(
        stableLegacy.positions.map(({ key }) => (key.kind === 'empty' ? '' : key.id)),
        ['turn-a', 'turn-b'],
      );
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('atomically invalidates an unfinished snapshot when admission authority changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-building-authority-'));
    const store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(
        session.id,
        Array.from({ length: 1_025 }, (_, index) => user(`turn-${index}`, index)),
      );
      const building = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(building.kind, 'building');
      if (building.kind !== 'building') assert.fail('expected an unfinished position build');

      await runs.admitRootTurn(rootAdmission(session.id, 'turn-1024', 'user-1024', 10));

      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: building.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('returns capacity for a third exact snapshot and never reuses a released generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-capacity-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, user('turn-a', 0));
      const first = await readyPage(store, session.id, 'lease-first');
      await store.appendMessage(session.id, user('turn-b', 1));
      const second = await readyPage(store, session.id, 'lease-second', 'shared');
      await store.appendMessage(session.id, user('turn-c', 2));

      const capacity = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-third',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.deepEqual(capacity, {
        kind: 'capacity',
        projection: 'owner',
        throughSequence: 2,
        authorityRevision: 0,
        retainedSnapshots: 2,
      });

      const stableFirst = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-first',
        snapshotKey: first.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(stableFirst.kind, 'page');
      if (stableFirst.kind !== 'page') assert.fail('expected retained first snapshot');
      assert.equal(stableFirst.totalPositions, 1);
      assert.deepEqual(
        stableFirst.positions.map(({ key }) => (key.kind === 'empty' ? '' : key.id)),
        ['turn-a'],
      );

      await store.releaseTurnPositionSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-first',
        snapshotKey: first.snapshotKey,
      });
      const third = await readyPage(store, session.id, 'lease-third');
      assert.equal(first.snapshotKey.snapshotGeneration, 1);
      assert.equal(second.snapshotKey.snapshotGeneration, 2);
      assert.equal(third.snapshotKey.snapshotGeneration, 3);
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-first',
          snapshotKey: first.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('caps one recovery step at 1,024 source records and resumes after reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-recovery-count-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessages(
        session.id,
        Array.from({ length: 1_025 }, (_, index) => user(`turn-${index}`, index)),
      );
      await store.close?.();
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database
          .prepare('DELETE FROM session_turn_position_snapshots WHERE session_id = ?')
          .run(session.id);
        database.prepare('DELETE FROM session_turn_metadata WHERE session_id = ?').run(session.id);
        database
          .prepare(`UPDATE session_turn_index_state SET indexed_through_sequence = -1,
            source_records = 0, source_bytes = 0,
            failure_reason = NULL, failure_sequence = NULL WHERE session_id = ?`)
          .run(session.id);
      } finally {
        database.close();
      }

      store = createSessionStore(root);
      const building = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(building.kind, 'building');
      if (building.kind !== 'building') assert.fail('expected bounded recovery progress');
      assert.equal(building.progress.sourceRecords, 1_024);
      assert.equal(building.progress.nextSequence, 1_024);

      await store.close?.();
      store = createSessionStore(root);
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: building.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
      const ready = await readyPage(store, session.id, 'lease-resumed');
      assert.equal(ready.totalPositions, 1_025);
      assert.ok(ready.snapshotKey.snapshotGeneration > building.snapshotKey.snapshotGeneration);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('caps one recovery step below 4 MiB of source payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-recovery-bytes-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessages(
        session.id,
        Array.from({ length: 5 }, (_, index) => ({
          ...user(`turn-${index}`, index),
          text: `${index}${'x'.repeat(1024 * 1024)}`,
        })),
      );
      await store.close?.();
      resetProjection(root, session.id);
      store = createSessionStore(root);

      const building = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(building.kind, 'building');
      if (building.kind !== 'building') assert.fail('expected byte-bounded recovery');
      assert.equal(building.progress.sourceRecords, 3);
      assert.ok(building.progress.sourceBytes < 4 * 1024 * 1024);
      assert.equal(building.progress.nextSequence, 3);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('resumes an oversized first source record without a size-only failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-oversized-source-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessage(session.id, {
        ...user('turn-oversized', 0),
        text: 'x'.repeat(4 * 1024 * 1024 + 1024),
      });
      await store.close?.();
      resetProjection(root, session.id);
      store = createSessionStore(root);

      const first = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(first.kind, 'building');
      if (first.kind !== 'building') assert.fail('expected partial scalar recovery');
      assert.equal(first.progress.lastStepBytes, 4 * 1024 * 1024);
      assert.equal(first.progress.lastStepRecords, 0);
      assert.equal(first.progress.currentByteOffset, 4 * 1024 * 1024);
      const ready = await readyPage(store, session.id);
      assert.equal(ready.totalPositions, 1);
      assert.equal(
        ready.positions[0] ? positionId(ready.positions[0]) : undefined,
        'turn-oversized',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('resumes legacy inline records larger than one recovery step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-legacy-inline-source-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    const message = {
      ...user('turn-legacy-inline', 0),
      text: 'x'.repeat(4 * 1024 * 1024 + 1024),
    };
    try {
      await store.appendMessage(session.id, message);
      await store.close?.();
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('BEGIN IMMEDIATE');
        database
          .prepare(`UPDATE session_messages SET record_json = ?
            WHERE session_id = ? AND sequence = 0`)
          .run(JSON.stringify(message), session.id);
        database
          .prepare('DELETE FROM session_message_payloads WHERE session_id = ? AND sequence = 0')
          .run(session.id);
        database.exec('COMMIT');
      } finally {
        database.close();
      }
      resetProjection(root, session.id);
      store = createSessionStore(root);

      const first = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-legacy-inline',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(first.kind, 'building');
      if (first.kind !== 'building') assert.fail('expected partial inline scalar recovery');
      assert.equal(first.progress.lastStepBytes, 4 * 1024 * 1024);
      assert.equal(first.progress.lastStepRecords, 0);
      assert.equal(first.progress.currentByteOffset, 4 * 1024 * 1024);

      const ready = await readyPage(store, session.id, 'lease-legacy-inline');
      assert.equal(
        ready.positions[0] ? positionId(ready.positions[0]) : undefined,
        'turn-legacy-inline',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('accounts exact 4 MiB boundaries and resumes identity located after a huge body', async () => {
    const targets = [4 * 1024 * 1024 - 1, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 9 * 1024 * 1024];
    for (const [index, targetBytes] of targets.entries()) {
      const root = await mkdtemp(join(tmpdir(), `maka-turn-position-exact-bytes-${index}-`));
      let store = createSessionStore(root);
      try {
        const session = await store.create(makeInput());
        const message = exactSizeUserMessage(targetBytes, `exact-turn-${index}`, index % 2 === 1);
        assert.equal(Buffer.byteLength(JSON.stringify(message), 'utf8'), targetBytes);
        await store.appendMessage(session.id, message);
        await store.close?.();
        resetProjection(root, session.id);
        store = createSessionStore(root);

        let result = await store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: `lease-exact-${index}`,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        });
        const recoveryBytes: number[] = [];
        while (result.kind === 'building') {
          if (result.progress.phase === 'recovering') {
            recoveryBytes.push(result.progress.lastStepBytes);
            assert.ok(result.progress.lastStepBytes <= 4 * 1024 * 1024);
            assert.ok(result.progress.lastStepRecords <= 1_024);
          }
          result = await store.readTurnPositionPageSnapshot({
            sessionId: session.id,
            projection: 'owner',
            snapshotLeaseId: `lease-exact-${index}`,
            snapshotKey: result.snapshotKey,
            anchor: { kind: 'tail' },
            maxPositions: 8,
          });
        }
        assert.equal(result.kind, 'page');
        if (result.kind !== 'page') assert.fail('expected exact-size recovered page');
        assert.equal(
          result.positions[0] ? positionId(result.positions[0]) : undefined,
          `exact-turn-${index}`,
        );
        assert.equal(
          recoveryBytes.reduce((total, bytes) => total + bytes, 0),
          targetBytes,
        );
        assert.equal(Math.max(...recoveryBytes), Math.min(targetBytes, 4 * 1024 * 1024));
      } finally {
        await store.close?.();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test('discards corrupt derived state and restarts only the partial source record after reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-derived-recovery-reset-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessage(
        session.id,
        exactSizeUserMessage(9 * 1024 * 1024, 'turn-derived-reset', true),
      );
      await store.close?.();
      resetProjection(root, session.id);
      store = createSessionStore(root);
      const partial = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-derived-before',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(partial.kind, 'building');
      if (partial.kind !== 'building') assert.fail('expected partial record');
      assert.equal(partial.progress.currentByteOffset, 4 * 1024 * 1024);
      await store.close?.();

      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        const row = database
          .prepare(`SELECT scanner_state FROM session_turn_identity_recovery
            WHERE session_id = ?`)
          .get(session.id) as { scanner_state: string };
        const scannerState = JSON.parse(row.scanner_state) as {
          identity: { id: string };
        };
        scannerState.identity.id = 'x'.repeat(scannerState.identity.id.length);
        database
          .prepare(`UPDATE session_turn_identity_recovery
            SET scanner_state = ? WHERE session_id = ?`)
          .run(JSON.stringify(scannerState), session.id);
      } finally {
        database.close();
      }
      store = createSessionStore(root);
      const restarted = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-derived-after',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(restarted.kind, 'building');
      if (restarted.kind !== 'building') assert.fail('expected reconstructed partial state');
      assert.equal(restarted.progress.currentByteOffset, 4 * 1024 * 1024);
      assert.equal(restarted.progress.lastStepBytes, 4 * 1024 * 1024);
      assert.equal(restarted.progress.sourceBytes, 8 * 1024 * 1024);
      const ready = await readyPage(store, session.id, 'lease-derived-after');
      assert.equal(
        ready.positions[0] ? positionId(ready.positions[0]) : undefined,
        'turn-derived-reset',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('publishes recovery cursor, counters, and membership atomically at commit boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-transaction-boundary-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessage(session.id, user('turn-atomic', 0));
      await store.close?.();
      resetProjection(root, session.id);
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
        const rolledBack = advanceSessionTurnIdentityRecovery(database, {
          sessionId: session.id,
          throughSequence: 0,
          maxSourceBytes: 4 * 1024 * 1024,
          maxCompletedRecords: 1_024,
          hasher: await createSHA256(),
        });
        assert.equal('failure' in rolledBack, false);
        assert.equal(
          (
            database
              .prepare(`SELECT COUNT(*) AS count FROM session_turn_memberships
                WHERE session_id = ?`)
              .get(session.id) as { count: number }
          ).count,
          1,
        );
        database.exec('ROLLBACK');
        assert.equal(
          (
            database
              .prepare(`SELECT COUNT(*) AS count FROM session_turn_memberships
                WHERE session_id = ?`)
              .get(session.id) as { count: number }
          ).count,
          0,
        );
        database.exec('BEGIN IMMEDIATE');
        const committed = advanceSessionTurnIdentityRecovery(database, {
          sessionId: session.id,
          throughSequence: 0,
          maxSourceBytes: 4 * 1024 * 1024,
          maxCompletedRecords: 1_024,
          hasher: await createSHA256(),
        });
        assert.equal('failure' in committed, false);
        database.exec('COMMIT');
        const state = database
          .prepare(`SELECT indexed_through_sequence, source_records
            FROM session_turn_index_state WHERE session_id = ?`)
          .get(session.id) as { indexed_through_sequence: number; source_records: number };
        assert.deepEqual([state.indexed_through_sequence, state.source_records], [0, 1]);
      } finally {
        database.close();
      }
      store = createSessionStore(root);
      const ready = await readyPage(store, session.id, 'lease-atomic');
      assert.equal(ready.positions[0] ? positionId(ready.positions[0]) : undefined, 'turn-atomic');
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists a partial-source mutation failure until authoritative invalidation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-partial-source-mutation-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessage(
        session.id,
        exactSizeUserMessage(9 * 1024 * 1024, 'turn-source-mutation', false),
      );
      await store.close?.();
      resetProjection(root, session.id);
      store = createSessionStore(root);
      const partial = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-source-before',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(partial.kind, 'building');
      await store.close?.();

      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(`UPDATE session_messages SET message_id = 'mutated-id'
            WHERE session_id = ? AND sequence = 0`)
          .run(session.id);
      } finally {
        database.close();
      }
      store = createSessionStore(root);
      for (const lease of ['lease-source-failed', 'lease-source-failed']) {
        await assert.rejects(
          store.readTurnPositionPageSnapshot({
            sessionId: session.id,
            projection: 'owner',
            snapshotLeaseId: lease,
            anchor: { kind: 'tail' },
            maxPositions: 8,
          }),
          (error: unknown) => {
            assert.equal((error as { reason?: unknown }).reason, 'corrupt_source');
            assert.equal((error as { sequence?: unknown }).sequence, 0);
            return true;
          },
        );
      }
      const failed = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        const failure = failed
          .prepare(`SELECT failure_reason, failure_sequence
            FROM session_turn_index_state WHERE session_id = ?`)
          .get(session.id) as { failure_reason: string; failure_sequence: number };
        assert.equal(failure.failure_reason, 'corrupt_source');
        assert.equal(failure.failure_sequence, 0);
      } finally {
        failed.close();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('binds transcript record reads to the exact snapshot key and Turn membership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-records-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(session.id, [
        hiddenPermission('turn-a', 0),
        {
          type: 'assistant',
          id: 'assistant-a',
          turnId: 'turn-a',
          ts: 2,
          text: 'answer',
          modelId: 'test-model',
        },
        user('turn-b', 1),
      ]);
      const page = await readyPage(store, session.id);
      const sharedPage = await readyPage(store, session.id, 'lease-shared-records', 'shared');
      assert.equal(sharedPage.positions[0]?.firstSequence, 1);

      const records = await store.readTranscriptRecordsByPositionKeysSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: page.snapshotKey,
        positionKeys: bodyKeys('turn-a'),
        maxBytes: 64 * 1024,
        maxRecords: 8,
      });
      assert.deepEqual(records.snapshotKey, page.snapshotKey);
      assert.deepEqual(
        records.records.map(({ positionKey, sequence, message }) => [
          positionKey,
          sequence,
          message.id,
        ]),
        [
          [{ kind: 'turn', id: 'turn-a' }, 0, 'permission-0'],
          [{ kind: 'turn', id: 'turn-a' }, 1, 'assistant-a'],
        ],
      );
      const sharedRecords = await store.readTranscriptRecordsByPositionKeysSnapshot({
        sessionId: session.id,
        projection: 'shared',
        snapshotLeaseId: 'lease-shared-records',
        snapshotKey: sharedPage.snapshotKey,
        positionKeys: bodyKeys('turn-a'),
        maxBytes: 64 * 1024,
        maxRecords: 8,
      });
      assert.deepEqual(
        sharedRecords.records.map(({ positionKey, sequence, message }) => [
          positionKey,
          sequence,
          message.id,
        ]),
        [
          [{ kind: 'turn', id: 'turn-a' }, 0, 'permission-0'],
          [{ kind: 'turn', id: 'turn-a' }, 1, 'assistant-a'],
        ],
      );
      await assert.rejects(
        store.readTranscriptRecordsByPositionKeysSnapshot({
          sessionId: session.id,
          projection: 'shared',
          snapshotLeaseId: 'lease-shared-records',
          snapshotKey: sharedPage.snapshotKey,
          positionKeys: bodyKeys('turn-a'),
          maxBytes: 64 * 1024,
          maxRecords: 1,
        }),
        (error: unknown) => (error as { reason?: unknown }).reason === 'transcript_record_count',
      );
      for (const [limits, reason] of [
        [{ maxBytes: 64 * 1024, maxRecords: 1 }, 'transcript_record_count'],
        [{ maxBytes: 1, maxRecords: 8 }, 'transcript_record_bytes'],
      ] as const) {
        await assert.rejects(
          store.readTranscriptRecordsByPositionKeysSnapshot({
            sessionId: session.id,
            projection: 'owner',
            snapshotLeaseId: 'lease-default',
            snapshotKey: page.snapshotKey,
            positionKeys: bodyKeys('turn-a'),
            ...limits,
          }),
          (error: unknown) => {
            assert.equal(
              (error as { code?: unknown }).code,
              'session_turn_position_limit_exceeded',
            );
            assert.equal((error as { reason?: unknown }).reason, reason);
            return true;
          },
        );
      }
      for (const snapshotKey of [
        { ...page.snapshotKey, authorityRevision: page.snapshotKey.authorityRevision + 1 },
        { ...page.snapshotKey, snapshotGeneration: 999 },
      ]) {
        await assert.rejects(
          store.readTranscriptRecordsByPositionKeysSnapshot({
            sessionId: session.id,
            projection: 'owner',
            snapshotLeaseId: 'lease-default',
            snapshotKey,
            positionKeys: bodyKeys('turn-a'),
            maxBytes: 64 * 1024,
            maxRecords: 8,
          }),
          (error: unknown) =>
            (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
        );
      }
      for (const request of [
        { positionKeys: bodyKeys('turn-a', 'turn-a'), maxRecords: 8, maxBytes: 64 * 1024 },
        { positionKeys: bodyKeys(''), maxRecords: 8, maxBytes: 64 * 1024 },
        {
          positionKeys: Array.from({ length: 129 }, (_, index) => `turn-${index}`).map((id) => ({
            kind: 'turn' as const,
            id,
          })),
          maxRecords: 8,
          maxBytes: 64 * 1024,
        },
        { positionKeys: bodyKeys('turn-a'), maxRecords: 257, maxBytes: 64 * 1024 },
        { positionKeys: bodyKeys('turn-a'), maxRecords: 8, maxBytes: 16 * 1024 * 1024 + 1 },
        { positionKeys: [{ kind: 'empty' }] as never, maxRecords: 8, maxBytes: 64 * 1024 },
      ]) {
        await assert.rejects(
          store.readTranscriptRecordsByPositionKeysSnapshot({
            sessionId: session.id,
            projection: 'owner',
            snapshotLeaseId: 'lease-default',
            snapshotKey: page.snapshotKey,
            ...request,
          }),
          /invalid|unique|stale|mismatched/iu,
        );
      }
      for (const request of [
        { snapshotLeaseId: 'lease-unknown', positionKeys: bodyKeys('turn-a') },
        { snapshotLeaseId: 'lease-default', positionKeys: bodyKeys('turn-unknown') },
        {
          snapshotLeaseId: 'lease-default',
          positionKeys: [{ kind: 'note' as const, id: 'turn-a' }],
        },
      ]) {
        await assert.rejects(
          store.readTranscriptRecordsByPositionKeysSnapshot({
            sessionId: session.id,
            projection: 'owner',
            snapshotKey: page.snapshotKey,
            maxRecords: 8,
            maxBytes: 64 * 1024,
            ...request,
          }),
          (error: unknown) =>
            (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
        );
      }

      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(`UPDATE session_messages SET record_json = '{'
            WHERE session_id = ? AND sequence = 1`)
          .run(session.id);
      } finally {
        database.close();
      }
      await assert.rejects(
        store.readTranscriptRecordsByPositionKeysSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: page.snapshotKey,
          positionKeys: bodyKeys('turn-a'),
          maxRecords: 1,
          maxBytes: 64 * 1024,
        }),
        (error: unknown) => (error as { reason?: unknown }).reason === 'transcript_record_count',
      );
      await assert.rejects(
        store.readTranscriptRecordsByPositionKeysSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: page.snapshotKey,
          positionKeys: bodyKeys('turn-a'),
          maxRecords: 2,
          maxBytes: 64 * 1024,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'stored_session_message_incompatible',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed with a typed recovery error for a corrupted durable source record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-corrupt-source-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessage(session.id, user('turn-a', 0));
      await store.close?.();
      resetProjection(root, session.id);
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(
            'UPDATE session_messages SET record_json = ? WHERE session_id = ? AND sequence = 0',
          )
          .run('{', session.id);
      } finally {
        database.close();
      }
      store = createSessionStore(root);

      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'session_turn_position_recovery_failed');
          assert.equal((error as { reason?: unknown }).reason, 'corrupt_source');
          return true;
        },
      );
      const failed = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        assert.equal(
          (
            failed
              .prepare(`SELECT COUNT(*) AS count FROM session_turn_position_snapshots
                WHERE session_id = ?`)
              .get(session.id) as { count: number }
          ).count,
          0,
        );
      } finally {
        failed.close();
      }
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-retry-failed-source',
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) => (error as { reason?: unknown }).reason === 'corrupt_source',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed when a valid stored body no longer resolves to its exact position key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-body-identity-drift-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      const original = user('turn-before', 0);
      await store.appendMessage(session.id, original);
      const page = await readyPage(store, session.id);
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(`UPDATE session_messages SET record_json = ?
            WHERE session_id = ? AND sequence = 0`)
          .run(JSON.stringify({ ...original, turnId: 'turn-after' }), session.id);
      } finally {
        database.close();
      }

      await assert.rejects(
        store.readTranscriptRecordsByPositionKeysSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: page.snapshotKey,
          positionKeys: bodyKeys('turn-before'),
          maxRecords: 1,
          maxBytes: 64 * 1024,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'stored_session_message_incompatible',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('enforces exact shared raw record-count and stored-byte boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-shared-position-body-limits-'));
    const store = createSessionStore(root);
    try {
      const countSession = await store.create(makeInput({ name: 'Count boundary' }));
      await store.appendMessages(countSession.id, [
        user('turn-count-boundary', 0),
        ...Array.from({ length: 255 }, (_, index) =>
          hiddenPermission('turn-count-boundary', index + 1),
        ),
      ]);
      const countAtLimit = await readyPage(store, countSession.id, 'count-at-limit', 'shared');
      const exactCount = await store.readTranscriptRecordsByPositionKeysSnapshot({
        sessionId: countSession.id,
        projection: 'shared',
        snapshotLeaseId: 'count-at-limit',
        snapshotKey: countAtLimit.snapshotKey,
        positionKeys: bodyKeys('turn-count-boundary'),
        maxRecords: 256,
        maxBytes: 16 * 1024 * 1024,
      });
      assert.equal(exactCount.records.length, 256);
      await store.appendMessage(countSession.id, hiddenPermission('turn-count-boundary', 256));
      const countOverLimit = await readyPage(store, countSession.id, 'count-over-limit', 'shared');
      await assert.rejects(
        store.readTranscriptRecordsByPositionKeysSnapshot({
          sessionId: countSession.id,
          projection: 'shared',
          snapshotLeaseId: 'count-over-limit',
          snapshotKey: countOverLimit.snapshotKey,
          positionKeys: bodyKeys('turn-count-boundary'),
          maxRecords: 256,
          maxBytes: 16 * 1024 * 1024,
        }),
        (error: unknown) => (error as { reason?: unknown }).reason === 'transcript_record_count',
      );

      const byteSession = await store.create(makeInput({ name: 'Byte boundary' }));
      await store.appendMessage(
        byteSession.id,
        exactSizeUserMessage(16 * 1024 * 1024, 'turn-byte-boundary', false),
      );
      const bytesAtLimit = await readyPage(store, byteSession.id, 'bytes-at-limit', 'shared');
      const exactBytes = await store.readTranscriptRecordsByPositionKeysSnapshot({
        sessionId: byteSession.id,
        projection: 'shared',
        snapshotLeaseId: 'bytes-at-limit',
        snapshotKey: bytesAtLimit.snapshotKey,
        positionKeys: bodyKeys('turn-byte-boundary'),
        maxRecords: 256,
        maxBytes: 16 * 1024 * 1024,
      });
      assert.equal(exactBytes.rawBytes, 16 * 1024 * 1024);
      await store.appendMessage(byteSession.id, hiddenPermission('turn-byte-boundary', 1));
      const bytesOverLimit = await readyPage(store, byteSession.id, 'bytes-over-limit', 'shared');
      await assert.rejects(
        store.readTranscriptRecordsByPositionKeysSnapshot({
          sessionId: byteSession.id,
          projection: 'shared',
          snapshotLeaseId: 'bytes-over-limit',
          snapshotKey: bytesOverLimit.snapshotKey,
          positionKeys: bodyKeys('turn-byte-boundary'),
          maxRecords: 256,
          maxBytes: 16 * 1024 * 1024,
        }),
        (error: unknown) => (error as { reason?: unknown }).reason === 'transcript_record_bytes',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists chunk-integrity failure across repair/reopen until authoritative invalidation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-chunk-corrupt-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessage(session.id, {
        ...user('turn-chunk-corrupt', 0),
        text: 'x'.repeat(1024 * 1024),
      });
      await store.close?.();
      resetProjection(root, session.id);
      const corrupt = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        corrupt
          .prepare(`UPDATE session_message_chunks SET sha256 = ?
            WHERE session_id = ? AND sequence = 0 AND chunk_index = 0`)
          .run('0'.repeat(64), session.id);
      } finally {
        corrupt.close();
      }
      store = createSessionStore(root);
      await assert.rejects(readyPage(store, session.id), (error: unknown) => {
        assert.equal((error as { reason?: unknown }).reason, 'corrupt_source');
        return true;
      });
      await store.close?.();

      const repaired = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        const chunk = repaired
          .prepare(`SELECT data FROM session_message_chunks
            WHERE session_id = ? AND sequence = 0 AND chunk_index = 0`)
          .get(session.id) as { data: Uint8Array };
        repaired
          .prepare(`UPDATE session_message_chunks SET sha256 = ?
            WHERE session_id = ? AND sequence = 0 AND chunk_index = 0`)
          .run(createHash('sha256').update(chunk.data).digest('hex'), session.id);
      } finally {
        repaired.close();
      }
      store = createSessionStore(root);
      await assert.rejects(readyPage(store, session.id, 'lease-still-failed'), (error: unknown) => {
        assert.equal((error as { reason?: unknown }).reason, 'corrupt_source');
        return true;
      });
      await store.close?.();
      resetProjection(root, session.id);
      store = createSessionStore(root);
      const recovered = await readyPage(store, session.id, 'lease-after-reset');
      assert.equal(
        recovered.positions[0] ? positionId(recovered.positions[0]) : undefined,
        'turn-chunk-corrupt',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses the shared physical decoder to reject noncanonical complete-record chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-body-chunk-shape-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, {
        ...user('turn-chunk-shape', 0),
        text: 'x'.repeat(1024 * 1024),
      });
      const page = await readyPage(store, session.id);
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        const tail = database
          .prepare(`SELECT chunk_index, data FROM session_message_chunks
            WHERE session_id = ? AND sequence = 0
            ORDER BY chunk_index DESC LIMIT 2`)
          .all(session.id) as Array<{ chunk_index: number; data: Uint8Array }>;
        assert.equal(tail.length, 2);
        const last = tail[0]!;
        const prior = tail[1]!;
        assert.equal(prior.data.byteLength, 64 * 1024);
        const joined = Buffer.concat([Buffer.from(prior.data), Buffer.from(last.data)]);
        const shiftedPrior = joined.subarray(0, 64 * 1024 - 1);
        const shiftedLast = joined.subarray(64 * 1024 - 1);
        const update = database.prepare(`UPDATE session_message_chunks
          SET data = ?, sha256 = ?
          WHERE session_id = ? AND sequence = 0 AND chunk_index = ?`);
        update.run(
          shiftedPrior,
          createHash('sha256').update(shiftedPrior).digest('hex'),
          session.id,
          prior.chunk_index,
        );
        update.run(
          shiftedLast,
          createHash('sha256').update(shiftedLast).digest('hex'),
          session.id,
          last.chunk_index,
        );
      } finally {
        database.close();
      }

      await assert.rejects(
        store.readTranscriptRecordsByPositionKeysSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: page.snapshotKey,
          positionKeys: bodyKeys('turn-chunk-shape'),
          maxRecords: 1,
          maxBytes: 2 * 1024 * 1024,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'stored_session_message_incompatible',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed when recovered Turn identity conflicts with persisted projection metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-identity-conflict-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessage(session.id, user('turn-a', 0));
      await store.close?.();
      resetProjection(root, session.id);
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(`INSERT INTO session_turn_metadata(
            session_id, position_kind, position_id, order_source,
            owner_first_sequence, shared_first_sequence
          ) VALUES (?, 'turn', 'turn-conflict', 'legacy', 0, 0)`)
          .run(session.id);
      } finally {
        database.close();
      }
      store = createSessionStore(root);

      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'session_turn_position_recovery_failed');
          assert.equal((error as { reason?: unknown }).reason, 'corrupt_source');
          return true;
        },
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('shortens a page to keep serialized position metadata below 64 KiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-page-bytes-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(
        session.id,
        Array.from({ length: 128 }, (_, index) => user(`turn-${index}-${'t'.repeat(600)}`, index)),
      );
      const ready = await readyPage(store, session.id);
      const page = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: ready.snapshotKey,
        anchor: { kind: 'ordinal', ordinal: 0 },
        maxPositions: 128,
      });
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('expected bounded page');
      assert.ok(page.positions.length < 128);
      assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 64 * 1024);
      assert.equal(page.hasNewer, true);

      const tail = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: page.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 128,
      });
      assert.equal(tail.kind, 'page');
      if (tail.kind !== 'page') assert.fail('expected bounded tail page');
      assert.ok(tail.positions.length < 128);
      assert.equal(tail.positions.at(-1)?.ordinal, 127);
      assert.equal(tail.hasNewer, false);
      assert.equal(tail.hasOlder, true);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('returns a typed failure when one position alone exceeds the metadata budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-single-page-limit-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, user(`turn-${'x'.repeat(70 * 1024)}`, 0));
      await assert.rejects(readyPage(store, session.id), (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'session_turn_position_limit_exceeded');
        assert.equal((error as { reason?: unknown }).reason, 'page_metadata_bytes');
        return true;
      });
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('indexes imported transcripts without copying a 16 KiB-plus body into positions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-imported-'));
    const store = createSessionStore(root);
    try {
      const messages = [
        { ...user('turn-imported', 0), text: 'x'.repeat(20 * 1024) },
        user('turn-second', 1),
      ];
      const session = await store.createImportedSession(makeInput(), messages, {
        adapterId: 'test-adapter',
        sourceSessionId: 'source-session',
      });
      const page = await readyPage(store, session.id);
      assert.deepEqual(page.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-imported' }, firstSequence: 0 },
        { ordinal: 1, key: { kind: 'turn', id: 'turn-second' }, firstSequence: 1 },
      ]);
      assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') < 4 * 1024);
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        const state = database
          .prepare(`SELECT indexed_through_sequence, source_records, source_bytes
            FROM session_turn_index_state WHERE session_id = ?`)
          .get(session.id) as {
          indexed_through_sequence: number;
          source_records: number;
          source_bytes: number;
        };
        assert.equal(state.indexed_through_sequence, 1);
        assert.equal(state.source_records, 2);
        assert.equal(
          state.source_bytes,
          messages.reduce(
            (total, message) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'),
            0,
          ),
        );
      } finally {
        database.close();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reclaims ready generations across owner reopen and preserves monotonic generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-ready-reopen-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessages(session.id, [user('turn-a', 0), user('turn-b', 1)]);
      const before = await readyPage(store, session.id);
      await store.close?.();
      store = createSessionStore(root);
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: before.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
      const after = await readyPage(store, session.id, 'lease-after-reopen');
      assert.ok(after.snapshotKey.snapshotGeneration > before.snapshotKey.snapshotGeneration);
      assert.deepEqual(after.positions, before.positions);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps live snapshot leases when a second facade shares the same database owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-same-owner-'));
    const first = createSessionStore(root);
    let second: ReturnType<typeof createSessionStore> | undefined;
    try {
      const session = await first.create(makeInput());
      await first.appendMessages(session.id, [user('turn-a', 0), user('turn-b', 1)]);
      const original = await readyPage(first, session.id, 'lease-first');

      second = createSessionStore(root);
      const shared = await second.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-second',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(shared.kind, 'page');
      if (shared.kind !== 'page') assert.fail('expected a shared ready generation');
      assert.deepEqual(shared.snapshotKey, original.snapshotKey);

      await first.releaseTurnPositionSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-first',
        snapshotKey: original.snapshotKey,
      });
      const retained = await second.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-second',
        snapshotKey: shared.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(retained.kind, 'page');
    } finally {
      await second?.close?.();
      await first.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('database guards reject mutation of ready position rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-ready-corrupt-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessages(session.id, [
        user('turn-a', 0),
        user('turn-b', 1),
        user('turn-c', 2),
      ]);
      const ready = await readyPage(store, session.id);
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        for (const mutate of [
          () =>
            database
              .prepare(`INSERT INTO session_turn_snapshot_positions(
                session_id, snapshot_generation, position_kind, position_id,
                owner_ordinal, shared_ordinal, owner_first_sequence, shared_first_sequence
              ) VALUES (?, ?, 'turn', 'turn-extra', 3, 3, 3, 3)`)
              .run(session.id, ready.snapshotKey.snapshotGeneration),
          () =>
            database
              .prepare(`UPDATE session_turn_snapshot_positions SET position_id = 'mutated'
                WHERE session_id = ? AND snapshot_generation = ? AND owner_ordinal = 2`)
              .run(session.id, ready.snapshotKey.snapshotGeneration),
          () =>
            database
              .prepare(`DELETE FROM session_turn_snapshot_positions
                WHERE session_id = ? AND snapshot_generation = ? AND owner_ordinal = 2`)
              .run(session.id, ready.snapshotKey.snapshotGeneration),
          () =>
            database
              .prepare(`UPDATE session_turn_position_snapshots SET ready_owner_total = 2
                WHERE session_id = ? AND snapshot_generation = ?`)
              .run(session.id, ready.snapshotKey.snapshotGeneration),
        ]) {
          assert.throws(mutate, /immutable/u);
        }
      } finally {
        database.close();
      }
      const stable = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: ready.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(stable.kind, 'page');
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('atomically expires exact snapshots when historical handoff shifts sequence anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-historical-insert-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(session.id, [
        {
          type: 'assistant',
          id: 'prior-output',
          turnId: 'turn-prior',
          ts: 10,
          text: 'prior',
          modelId: 'test-model',
        },
        {
          type: 'assistant',
          id: 'target-output',
          turnId: 'turn-target',
          ts: 20,
          text: 'target',
          modelId: 'test-model',
        },
        { type: 'user', id: 'newer-user', turnId: 'turn-newer', ts: 30, text: 'newer' },
      ]);
      const before = await readyPage(store, session.id);

      await store.markMessagesHandedOff({
        sessionId: session.id,
        messageIds: ['historical-user'],
        turnId: 'turn-target',
        provenRootMessages: [
          { messageId: 'historical-user', content: { text: 'historical' }, admittedAt: 17 },
        ],
      });

      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: before.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
      const after = await readyPage(store, session.id);
      assert.ok(after.snapshotKey.snapshotGeneration > before.snapshotKey.snapshotGeneration);
      assert.deepEqual(
        after.positions.map((position) => [positionId(position), position.firstSequence]),
        [
          ['turn-prior', 0],
          ['turn-target', 1],
          ['turn-newer', 3],
        ],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('additively migrates a current v34 database and boundedly rebuilds legacy metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-v34-migration-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.appendMessages(session.id, [user('turn-a', 0), user('turn-b', 1)]);
      await store.close?.();
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database.exec(`
          PRAGMA foreign_keys = OFF;
          DROP TABLE session_turn_snapshot_leases;
          DROP TABLE session_turn_snapshot_positions;
          DROP TABLE session_turn_position_snapshots;
          DROP TABLE session_turn_identity_recovery;
          DROP TABLE session_turn_memberships;
          DROP TABLE session_turn_metadata;
          DROP TABLE session_turn_index_state;
          DROP TABLE session_turn_authority_revisions;
          UPDATE session_metadata_schema SET version = 34 WHERE scope = 'session_metadata';
        `);
      } finally {
        database.close();
      }

      store = createSessionStore(root);
      const lazy = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        assert.equal(
          (
            lazy
              .prepare(`SELECT COUNT(*) AS count FROM session_turn_metadata WHERE session_id = ?`)
              .get(session.id) as { count: number }
          ).count,
          0,
        );
      } finally {
        lazy.close();
      }
      const page = await readyPage(store, session.id);
      assert.deepEqual(page.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-a' }, firstSequence: 0 },
        { ordinal: 1, key: { kind: 'turn', id: 'turn-b' }, firstSequence: 1 },
      ]);
      const migrated = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        assert.equal(
          (
            migrated
              .prepare(
                `SELECT version FROM session_metadata_schema WHERE scope = 'session_metadata'`,
              )
              .get() as { version: number }
          ).version,
          35,
        );
        const metadataColumns = new Set(
          (
            migrated.prepare(`PRAGMA table_info(session_turn_metadata)`).all() as Array<{
              name: string;
            }>
          ).map(({ name }) => name),
        );
        assert.deepEqual(
          ['position_kind', 'position_id', 'owner_first_sequence', 'shared_first_sequence'].map(
            (name) => metadataColumns.has(name),
          ),
          [true, true, true, true],
        );
        assert.equal(metadataColumns.has('turn_id'), false);
        const snapshotColumns = new Set(
          (
            migrated.prepare(`PRAGMA table_info(session_turn_position_snapshots)`).all() as Array<{
              name: string;
            }>
          ).map(({ name }) => name),
        );
        assert.equal(snapshotColumns.has('ready_owner_total'), true);
        assert.equal(snapshotColumns.has('ready_shared_total'), true);
      } finally {
        migrated.close();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers a v34 bodyless root admission before publishing owner and shared snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-v34-bodyless-admission-'));
    let store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    const session = await store.create(makeInput());
    try {
      await runs.admitRootTurn(
        rootAdmission(session.id, 'turn-bodyless-v34', 'future-user-v34', 42),
      );
      runs.close?.();
      await store.close?.();
      downgradeTurnProjectionToV34(root);

      store = createSessionStore(root);
      const owner = await readyPage(store, session.id, 'v34-bodyless-owner', 'owner');
      const shared = await readyPage(store, session.id, 'v34-bodyless-shared', 'shared');
      assert.deepEqual(owner.positions, [
        {
          ordinal: 0,
          key: { kind: 'turn', id: 'turn-bodyless-v34' },
          firstSequence: null,
        },
      ]);
      assert.deepEqual(shared.positions, [
        { ordinal: 0, key: { kind: 'empty' }, firstSequence: null },
      ]);
      const migrated = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        assert.deepEqual(
          (
            migrated
              .prepare(`SELECT position_kind, position_id, order_source, admitted_at,
              owner_first_sequence, shared_first_sequence
              FROM session_turn_metadata WHERE session_id = ?`)
              .all(session.id) as Array<Record<string, unknown>>
          ).map((row) => ({ ...row })),
          [
            {
              position_kind: 'turn',
              position_id: 'turn-bodyless-v34',
              order_source: 'admission',
              admitted_at: 42,
              owner_first_sequence: null,
              shared_first_sequence: null,
            },
          ],
        );
      } finally {
        migrated.close();
      }

      await store.close?.();
      store = createSessionStore(root);
      const reopenedOwner = await readyPage(store, session.id, 'v34-bodyless-reopen', 'owner');
      assert.deepEqual(reopenedOwner.positions, owner.positions);
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers v34 admission order while preserving owner and shared body anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-v34-admission-bodies-'));
    let store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    const session = await store.create(makeInput());
    try {
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-late', 'late-user', 20));
      await runs.admitRootTurn(rootAdmission(session.id, 'turn-early', 'early-user', 10));
      await store.appendMessages(session.id, [
        hiddenPermission('turn-late', 0),
        { ...user('turn-early', 1), id: 'early-user' },
        { ...user('turn-late', 2), id: 'late-user' },
      ]);
      runs.close?.();
      await store.close?.();
      downgradeTurnProjectionToV34(root);

      store = createSessionStore(root);
      const owner = await readyPage(store, session.id, 'v34-bodies-owner', 'owner');
      const shared = await readyPage(store, session.id, 'v34-bodies-shared', 'shared');
      assert.deepEqual(owner.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-early' }, firstSequence: 1 },
        { ordinal: 1, key: { kind: 'turn', id: 'turn-late' }, firstSequence: 0 },
      ]);
      assert.deepEqual(shared.positions, [
        { ordinal: 0, key: { kind: 'turn', id: 'turn-early' }, firstSequence: 1 },
        { ordinal: 1, key: { kind: 'turn', id: 'turn-late' }, firstSequence: 2 },
      ]);
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bounds legacy admission reconciliation and atomically rebuilds after owner reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-admission-recovery-bound-'));
    let store = createSessionStore(root);
    const session = await store.create(makeInput());
    try {
      await store.close?.();
      const seeded = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        const insert = seeded.prepare(`INSERT INTO core_root_turn_admissions(
          session_id, turn_id, admitted_at, record_json
        ) VALUES (?, ?, ?, '{}')`);
        seeded.exec('BEGIN IMMEDIATE');
        for (let index = 0; index < 1_025; index += 1) {
          insert.run(session.id, `turn-${index.toString().padStart(4, '0')}`, index);
        }
        seeded.exec('COMMIT');
      } finally {
        seeded.close();
      }
      downgradeTurnProjectionToV34(root);

      store = createSessionStore(root);
      const first = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'admission-bound-first',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(first.kind, 'building');
      if (first.kind !== 'building') assert.fail('expected bounded admission reconciliation');
      const bounded = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        assert.equal(
          (
            bounded
              .prepare(`SELECT COUNT(*) AS count FROM session_turn_metadata
                WHERE session_id = ? AND order_source = 'admission'`)
              .get(session.id) as { count: number }
          ).count,
          1_024,
        );
        const snapshotState = bounded
          .prepare(`SELECT state, build_phase, build_cursor_admitted_at,
            build_cursor_position_id FROM session_turn_position_snapshots
            WHERE session_id = ? AND snapshot_generation = ?`)
          .get(session.id, first.snapshotKey.snapshotGeneration) as {
          state: string;
          build_phase: string;
          build_cursor_admitted_at: number;
          build_cursor_position_id: string;
        };
        assert.deepEqual(
          { ...snapshotState },
          {
            state: 'building',
            build_phase: 'recovering',
            build_cursor_admitted_at: 1_023,
            build_cursor_position_id: 'turn-1023',
          },
        );
        assert.equal(
          (
            bounded
              .prepare(`SELECT COUNT(*) AS count FROM session_turn_snapshot_positions
                WHERE session_id = ? AND snapshot_generation = ?`)
              .get(session.id, first.snapshotKey.snapshotGeneration) as { count: number }
          ).count,
          0,
        );
        const plan = bounded
          .prepare(`EXPLAIN QUERY PLAN SELECT turn_id, admitted_at
            FROM core_root_turn_admissions
            WHERE session_id = ? AND (admitted_at, turn_id) > (?, ?)
            ORDER BY admitted_at, turn_id LIMIT ?`)
          .all(session.id, 1_023, 'turn-1023', 1_024)
          .map((row) => String((row as { detail?: unknown }).detail ?? ''))
          .join('\n');
        assert.match(plan, /core_root_turn_admissions_order/u);
        assert.match(plan, /\(admitted_at,turn_id\)>\(\?,\?\)/u);
        assert.doesNotMatch(plan, /TEMP B-TREE|OFFSET|ROW_NUMBER|COUNT DISTINCT/iu);
      } finally {
        bounded.close();
      }

      await store.close?.();
      store = createSessionStore(root);
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'admission-bound-first',
          snapshotKey: first.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) =>
          (error as { code?: unknown }).code === 'session_turn_position_snapshot_mismatch',
      );
      const ready = await readyPage(store, session.id, 'admission-bound-reopen', 'owner');
      assert.equal(ready.totalPositions, 1_025);
      assert.ok(ready.snapshotKey.snapshotGeneration > first.snapshotKey.snapshotGeneration);
      const completed = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        const positions = completed
          .prepare(`SELECT owner_ordinal, position_id FROM session_turn_snapshot_positions
            WHERE session_id = ? AND snapshot_generation = ? AND owner_ordinal IS NOT NULL
            ORDER BY owner_ordinal`)
          .all(session.id, ready.snapshotKey.snapshotGeneration) as Array<{
          owner_ordinal: number;
          position_id: string;
        }>;
        assert.equal(positions.length, 1_025);
        for (let index = 0; index < positions.length; index += 1) {
          assert.deepEqual(
            { ...positions[index] },
            {
              owner_ordinal: index,
              position_id: `turn-${index.toString().padStart(4, '0')}`,
            },
          );
        }
      } finally {
        completed.close();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rehydrates a bodyless admission after shared visibility policy reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-bodyless-policy-reset-'));
    const store = createSessionStore(root);
    const runs = createSqliteAgentRunStore(root);
    try {
      const session = await store.create(makeInput());
      await runs.admitRootTurn(
        rootAdmission(session.id, 'turn-bodyless-policy', 'future-policy-user', 7),
      );
      const before = await readyPage(store, session.id, 'bodyless-policy-before', 'owner');
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(`UPDATE session_turn_authority_revisions
            SET visibility_policy_version = 999 WHERE session_id = ?`)
          .run(session.id);
      } finally {
        database.close();
      }

      const owner = await readyPage(store, session.id, 'bodyless-policy-after', 'owner');
      const shared = await readyPage(store, session.id, 'bodyless-policy-shared', 'shared');
      assert.ok(owner.snapshotKey.snapshotGeneration > before.snapshotKey.snapshotGeneration);
      assert.deepEqual(owner.positions, [
        {
          ordinal: 0,
          key: { kind: 'turn', id: 'turn-bodyless-policy' },
          firstSequence: null,
        },
      ]);
      assert.deepEqual(shared.positions, [
        { ordinal: 0, key: { kind: 'empty' }, firstSequence: null },
      ]);
    } finally {
      runs.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed on invalid or contradictory canonical admission scalars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-invalid-admission-source-'));
    let store = createSessionStore(root);
    try {
      const invalidIdentity = await store.create(makeInput({ name: 'Invalid identity' }));
      const invalidTime = await store.create(makeInput({ name: 'Invalid time' }));
      const contradiction = await store.create(makeInput({ name: 'Contradiction' }));
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        const insert = database.prepare(`INSERT INTO core_root_turn_admissions(
          session_id, turn_id, admitted_at, record_json
        ) VALUES (?, ?, ?, '{}')`);
        insert.run(invalidIdentity.id, '', 1);
        insert.run(invalidTime.id, 'turn-negative-time', -1);
        insert.run(contradiction.id, 'turn-contradiction', 1);
        database
          .prepare(`INSERT INTO session_turn_metadata(
            session_id, position_kind, position_id, order_source, admitted_at,
            owner_first_sequence, shared_first_sequence
          ) VALUES (?, 'turn', 'turn-contradiction', 'admission', 2, NULL, NULL)`)
          .run(contradiction.id);
      } finally {
        database.close();
      }

      for (const sessionId of [invalidIdentity.id, invalidTime.id, contradiction.id]) {
        await assert.rejects(
          store.readTurnPositionPageSnapshot({
            sessionId,
            projection: 'owner',
            snapshotLeaseId: 'invalid-admission',
            anchor: { kind: 'tail' },
            maxPositions: 8,
          }),
          (error: unknown) => {
            assert.equal(
              (error as { code?: unknown }).code,
              'session_turn_position_recovery_failed',
            );
            assert.equal((error as { reason?: unknown }).reason, 'corrupt_source');
            return true;
          },
        );
        const failed = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
          readOnly: true,
        });
        try {
          assert.deepEqual(
            {
              ...(failed
                .prepare(`SELECT failure_reason, failure_sequence
                  FROM session_turn_index_state WHERE session_id = ?`)
                .get(sessionId) as Record<string, unknown>),
            },
            { failure_reason: 'corrupt_source', failure_sequence: 0 },
          );
        } finally {
          failed.close();
        }
      }

      await store.close?.();
      const repaired = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        repaired
          .prepare(`UPDATE core_root_turn_admissions SET turn_id = 'turn-repaired'
            WHERE session_id = ? AND turn_id = ''`)
          .run(invalidIdentity.id);
      } finally {
        repaired.close();
      }
      store = createSessionStore(root);
      await assert.rejects(
        store.readTurnPositionPageSnapshot({
          sessionId: invalidIdentity.id,
          projection: 'owner',
          snapshotLeaseId: 'invalid-admission-reopen',
          anchor: { kind: 'tail' },
          maxPositions: 8,
        }),
        (error: unknown) => (error as { reason?: unknown }).reason === 'corrupt_source',
      );

      const reset = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        reset
          .prepare(`UPDATE session_turn_authority_revisions
            SET visibility_policy_version = 999 WHERE session_id = ?`)
          .run(invalidIdentity.id);
      } finally {
        reset.close();
      }
      const recovered = await readyPage(
        store,
        invalidIdentity.id,
        'invalid-admission-policy-reset',
        'owner',
      );
      assert.deepEqual(recovered.positions, [
        {
          ordinal: 0,
          key: { kind: 'turn', id: 'turn-repaired' },
          firstSequence: null,
        },
      ]);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses indexed owner/shared keyset plans for 10,000 alternating-visibility Turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-turn-position-plan-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(
        session.id,
        Array.from({ length: 10_000 }, (_, index) =>
          index % 2 === 0 ? user(`turn-${index}`, index) : hiddenPermission(`turn-${index}`, index),
        ),
      );
      const firstStep = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(firstStep.kind, 'building');
      if (firstStep.kind !== 'building') assert.fail('expected bounded position publication');
      assert.equal(firstStep.progress.phase, 'recovering');
      assert.equal(firstStep.progress.sourceRecords, 10_000);
      assert.ok(firstStep.progress.sourceBytes > 0);
      assert.equal(firstStep.progress.builtPositions, 0);
      assert.equal(firstStep.progress.lastStepPositions, 0);
      const secondStep = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: firstStep.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(secondStep.kind, 'building');
      if (secondStep.kind !== 'building') assert.fail('expected legacy ordinal build');
      assert.equal(secondStep.progress.phase, 'legacy');
      assert.equal(secondStep.progress.builtPositions, 1_024);
      const sharedProgress = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'shared',
        snapshotLeaseId: 'lease-shared-progress',
        throughSequence: secondStep.snapshotKey.throughSequence,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      assert.equal(sharedProgress.kind, 'building');
      if (sharedProgress.kind !== 'building') assert.fail('expected shared ordinal progress');
      assert.equal(sharedProgress.progress.builtPositions, 1_024);
      assert.equal(sharedProgress.progress.lastStepPositions, 512);
      const bounded = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        assert.equal(
          (
            bounded
              .prepare(`SELECT COUNT(*) AS count FROM session_turn_snapshot_positions
                WHERE session_id = ? AND snapshot_generation = ?`)
              .get(session.id, secondStep.snapshotKey.snapshotGeneration) as { count: number }
          ).count,
          2_048,
        );
        const recoveryPlans = [
          bounded
            .prepare(`EXPLAIN QUERY PLAN SELECT MIN(owner_first_sequence) AS boundary
              FROM session_turn_metadata
              WHERE session_id = ? AND order_source = 'admission' AND owner_first_sequence <= ?`)
            .all(session.id, 9_999),
          bounded
            .prepare(`EXPLAIN QUERY PLAN SELECT position_kind, position_id,
                owner_first_sequence, NULL AS admitted_at
              FROM session_turn_metadata
              WHERE session_id = ? AND owner_first_sequence <= ? AND order_source = 'legacy'
                AND (? IS NULL OR owner_first_sequence < ?) AND owner_first_sequence > ?
              ORDER BY owner_first_sequence, position_kind, position_id LIMIT ?`)
            .all(session.id, 9_999, null, null, -1, 1_025),
        ].flat() as Array<{ detail: string }>;
        assert.equal(
          recoveryPlans.some(({ detail }) => /\bSCAN\b|USE TEMP B-TREE/.test(detail)),
          false,
        );
        assert.equal(
          recoveryPlans.every(({ detail }) => detail.includes('SEARCH session_turn_metadata')),
          true,
        );
      } finally {
        bounded.close();
      }
      let tail = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: secondStep.snapshotKey,
        anchor: { kind: 'tail' },
        maxPositions: 8,
      });
      while (tail.kind === 'building') {
        tail = await store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: tail.snapshotKey,
          anchor: { kind: 'tail' },
          maxPositions: 8,
        });
      }
      assert.equal(tail.kind, 'page');
      if (tail.kind !== 'page') assert.fail('expected steady page');
      assert.equal(tail.totalPositions, 10_000);
      assert.equal(tail.positions.length, 8);
      const sharedTail = await readyPage(store, session.id, 'lease-shared-10k', 'shared');
      assert.equal(sharedTail.snapshotKey.snapshotGeneration, tail.snapshotKey.snapshotGeneration);
      assert.equal(sharedTail.totalPositions, 5_000);
      assert.equal(sharedTail.positions.length, 8);
      const sharedMiddle = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'shared',
        snapshotLeaseId: 'lease-shared-10k',
        snapshotKey: sharedTail.snapshotKey,
        anchor: { kind: 'ordinal', ordinal: 2_500 },
        maxPositions: 8,
      });
      assert.equal(sharedMiddle.kind, 'page');
      if (sharedMiddle.kind !== 'page') assert.fail('expected indexed shared page');
      assert.deepEqual(sharedMiddle.positions[0]?.key, { kind: 'turn', id: 'turn-5000' });

      const sparseRecords = await store.readTranscriptRecordsByPositionKeysSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: tail.snapshotKey,
        positionKeys: bodyKeys('turn-9999', 'turn-0'),
        maxRecords: 2,
        maxBytes: 64 * 1024,
      });
      assert.deepEqual(
        sparseRecords.records.map(({ sequence }) => sequence),
        [0, 9_999],
      );

      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME), {
        readOnly: true,
      });
      try {
        const plans = [
          database
            .prepare(`EXPLAIN QUERY PLAN SELECT owner_ordinal FROM session_turn_snapshot_positions
              WHERE session_id = ? AND snapshot_generation = ?
                AND owner_ordinal IS NOT NULL AND owner_first_sequence <= ?
              ORDER BY owner_first_sequence DESC LIMIT 1`)
            .all(session.id, tail.snapshotKey.snapshotGeneration, 5_000),
          database
            .prepare(`EXPLAIN QUERY PLAN SELECT owner_ordinal FROM session_turn_snapshot_positions
              WHERE session_id = ? AND snapshot_generation = ?
                AND position_kind = 'turn' AND position_id = ? AND owner_ordinal IS NOT NULL`)
            .all(session.id, tail.snapshotKey.snapshotGeneration, 'turn-5000'),
          database
            .prepare(`EXPLAIN QUERY PLAN SELECT owner_ordinal, position_kind, position_id,
                owner_first_sequence
              FROM session_turn_snapshot_positions
              WHERE session_id = ? AND snapshot_generation = ?
                AND owner_ordinal IS NOT NULL AND owner_ordinal >= ?
              ORDER BY owner_ordinal LIMIT ?`)
            .all(session.id, tail.snapshotKey.snapshotGeneration, 5_000, 8),
          database
            .prepare(`EXPLAIN QUERY PLAN SELECT shared_ordinal, position_kind, position_id,
                shared_first_sequence
              FROM session_turn_snapshot_positions
              WHERE session_id = ? AND snapshot_generation = ?
                AND shared_ordinal IS NOT NULL AND shared_ordinal >= ?
              ORDER BY shared_ordinal LIMIT ?`)
            .all(session.id, tail.snapshotKey.snapshotGeneration, 2_500, 8),
        ].flat() as Array<{ detail: string }>;
        assert.equal(
          plans.some(({ detail }) => /\bSCAN\b|USE TEMP B-TREE/.test(detail)),
          false,
        );
        assert.equal(
          plans.every(({ detail }) => detail.includes('SEARCH session_turn_snapshot_positions')),
          true,
        );
        const membershipPlan = database
          .prepare(`EXPLAIN QUERY PLAN
            SELECT membership.sequence,
              coalesce(payload.record_bytes, length(CAST(message.record_json AS BLOB)))
            FROM session_turn_memberships AS membership
            INNER JOIN session_messages AS message
              ON message.session_id = membership.session_id
              AND message.sequence = membership.sequence
            LEFT JOIN session_message_payloads AS payload
              ON payload.session_id = message.session_id AND payload.sequence = message.sequence
            WHERE membership.session_id = ? AND membership.position_kind = 'turn'
              AND membership.position_id = ?
              AND membership.sequence <= ?
            ORDER BY membership.sequence LIMIT ?`)
          .all(session.id, 'turn-9999', 9_999, 2) as Array<{ detail: string }>;
        assert.equal(
          membershipPlan.some(({ detail }) => /\bSCAN\b|USE TEMP B-TREE/u.test(detail)),
          false,
        );
        assert.equal(
          membershipPlan.some(({ detail }) =>
            detail.includes('session_turn_memberships_by_position'),
          ),
          true,
        );
      } finally {
        database.close();
      }

      for (const anchor of [
        { kind: 'ordinal' as const, ordinal: 5_000 },
        { kind: 'sequence' as const, sequence: 5_000 },
        { kind: 'turn' as const, turnId: 'turn-5000' },
      ]) {
        const page = await store.readTurnPositionPageSnapshot({
          sessionId: session.id,
          projection: 'owner',
          snapshotLeaseId: 'lease-default',
          snapshotKey: tail.snapshotKey,
          anchor,
          maxPositions: 8,
        });
        assert.equal(page.kind, 'page');
        if (page.kind !== 'page') assert.fail('expected indexed anchored page');
        assert.equal(page.startOrdinal, 5_000);
        assert.equal(page.positions.length, 8);
      }
      const adjacent = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: tail.snapshotKey,
        anchor: { kind: 'ordinal', ordinal: 5_008 },
        maxPositions: 8,
      });
      assert.equal(adjacent.kind, 'page');
      if (adjacent.kind !== 'page') assert.fail('expected adjacent keyset page');
      assert.deepEqual(
        adjacent.positions.map(({ ordinal }) => ordinal),
        Array.from({ length: 8 }, (_, index) => 5_008 + index),
      );
      assert.equal(
        new Set(adjacent.positions.map(({ key }) => (key.kind === 'empty' ? '' : key.id))).size,
        8,
      );
      const prior = await store.readTurnPositionPageSnapshot({
        sessionId: session.id,
        projection: 'owner',
        snapshotLeaseId: 'lease-default',
        snapshotKey: tail.snapshotKey,
        anchor: { kind: 'ordinal', ordinal: 5_000 },
        maxPositions: 8,
      });
      assert.equal(prior.kind, 'page');
      if (prior.kind !== 'page') assert.fail('expected prior keyset page');
      assert.equal(
        prior.positions.some((position) =>
          adjacent.positions.some((candidate) => positionId(candidate) === positionId(position)),
        ),
        false,
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

type TestStore = ReturnType<typeof createSessionStore>;

async function readyPage(
  store: TestStore,
  sessionId: string,
  snapshotLeaseId = 'lease-default',
  projection: 'owner' | 'shared' = 'owner',
) {
  let result = await store.readTurnPositionPageSnapshot({
    sessionId,
    projection,
    snapshotLeaseId,
    anchor: { kind: 'tail' },
    maxPositions: 8,
  });
  while (result.kind === 'building') {
    result = await store.readTurnPositionPageSnapshot({
      sessionId,
      projection,
      snapshotLeaseId,
      snapshotKey: result.snapshotKey,
      anchor: { kind: 'tail' },
      maxPositions: 8,
    });
  }
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') assert.fail('expected a ready page');
  return result;
}

function user(turnId: string, index: number) {
  return {
    type: 'user' as const,
    id: `user-${index}`,
    turnId,
    ts: index,
    text: turnId,
  };
}

function hiddenPermission(turnId: string, index: number) {
  return {
    type: 'permission_decision' as const,
    id: `permission-${index}`,
    turnId,
    ts: index,
    toolUseId: `tool-${index}`,
    toolName: 'Read',
    decision: 'deny' as const,
  };
}

function bodyKeys(...ids: string[]) {
  return ids.map((id) => ({ kind: 'turn' as const, id }));
}

function positionId(position: { key: { kind: 'turn' | 'note'; id: string } | { kind: 'empty' } }) {
  return position.key.kind === 'empty' ? '' : position.key.id;
}

function exactSizeUserMessage(targetBytes: number, turnId: string, turnIdAfterBody: boolean) {
  const message = turnIdAfterBody
    ? { type: 'user' as const, id: `user-${turnId}`, ts: 1, text: '', turnId }
    : { type: 'user' as const, id: `user-${turnId}`, turnId, ts: 1, text: '' };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
  assert.ok(targetBytes >= envelopeBytes);
  message.text = 'x'.repeat(targetBytes - envelopeBytes);
  return message;
}

function rootAdmission(
  sessionId: string,
  turnId: string,
  userMessageId: string,
  admittedAt: number,
) {
  return {
    sessionId,
    turnId,
    proposedRunId: `run-${turnId}`,
    proposedUserMessageId: userMessageId,
    execution: { kind: 'external_message' as const },
    previousRootTurnId: null,
    normalizedInput: { text: turnId },
    sourceMessages: [],
    admittedAt,
  };
}

function resetProjection(root: string, sessionId: string): void {
  const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database
      .prepare('DELETE FROM session_turn_position_snapshots WHERE session_id = ?')
      .run(sessionId);
    database.prepare('DELETE FROM session_turn_metadata WHERE session_id = ?').run(sessionId);
    database
      .prepare(`UPDATE session_turn_index_state SET indexed_through_sequence = -1,
        source_records = 0, source_bytes = 0,
        failure_reason = NULL, failure_sequence = NULL WHERE session_id = ?`)
      .run(sessionId);
  } finally {
    database.close();
  }
}

function downgradeTurnProjectionToV34(root: string): void {
  const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE session_turn_snapshot_leases;
      DROP TABLE session_turn_snapshot_positions;
      DROP TABLE session_turn_position_snapshots;
      DROP TABLE session_turn_identity_recovery;
      DROP TABLE session_turn_memberships;
      DROP TABLE session_turn_metadata;
      DROP TABLE session_turn_index_state;
      DROP TABLE session_turn_authority_revisions;
      UPDATE session_metadata_schema SET version = 34 WHERE scope = 'session_metadata';
    `);
  } finally {
    database.close();
  }
}

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    llmConnectionSlug: 'test-connection',
    model: 'test-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}
