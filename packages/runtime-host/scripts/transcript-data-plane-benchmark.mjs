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

import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import { createSessionStore } from '@maka/storage/session-store';
import { ClientSessionSubscription } from '../dist/client/session-subscription.js';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '../dist/protocol/index.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
} from '../dist/server/session-transcript-pager.js';
import {
  confirmSemanticTranscriptWatermark,
  createSubscriberSemanticTranscriptState,
  querySemanticTranscriptPositions,
  readSemanticTranscriptTurnWindow,
  releaseSubscriberSemanticTranscript,
} from '../dist/server/semantic-session-transcript-pager.js';

const BOOTSTRAP_BYTES = 16 * 1024;
const RTT_MS = Number.parseInt(process.env.MAKA_TRANSCRIPT_BENCHMARK_RTT_MS ?? '20', 10);
const FULL_SEMANTIC = process.env.MAKA_TRANSCRIPT_BENCHMARK_FULL_SEMANTIC === '1';
const cases = [
  { name: '5k-small-messages', messages: 5_000, textBytes: 96 },
  { name: '10k-semantic-positions', messages: 10_000, textBytes: 96, alternatingVisibility: true },
  { name: '15MiB-single-message', messages: 1, textBytes: 15 * 1024 * 1024, semantic: true },
  {
    name: '17MiB-single-message',
    messages: 1,
    textBytes: 17 * 1024 * 1024,
    semantic: true,
    semanticOnly: true,
  },
  { name: '17MiB-transcript', totalBytes: 17 * 1024 * 1024, textBytes: 4 * 1024 },
  { name: '64MiB-transcript', totalBytes: 64 * 1024 * 1024, textBytes: 4 * 1024 },
];

const results = [];
for (const fixture of cases) results.push(await runFixture(fixture));
console.table(results);

async function runFixture(fixture) {
  const messages = buildMessages(fixture);
  const root = await mkdtemp(join(tmpdir(), 'maka-transcript-benchmark-'));
  const store = createSessionStore(root);
  const setupAt = performance.now();
  const session = await store.create({
    cwd: root,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: fixture.name,
    labels: [],
  });
  await store.appendMessages(session.id, messages);
  const setupMs = performance.now() - setupAt;
  const reader = sqliteReader(store);
  try {
    if (fixture.semanticOnly) {
      const throughSequence = await reader.readDurableHighWater(session.id);
      const semantic = await measureSemantic({
        reader,
        sessionId: session.id,
        throughSequence,
        fullWindows: true,
        databasePath: join(root, OPERATIONAL_STATE_DATABASE_NAME),
      });
      return {
        fixture: fixture.name,
        messages: messages.length,
        rawMiB: decimalMiB(
          messages.reduce(
            (total, message) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'),
            0,
          ),
        ),
        bootstrapKiB: '-',
        wireRequests: '-',
        pageRequests: '-',
        setupMs: setupMs.toFixed(1),
        bootstrapCpuMs: '-',
        materializeCpuMs: '-',
        modeledRttFloorMs: '-',
        ...semanticMetrics(semantic),
      };
    }
    const openedAt = performance.now();
    const throughSequence = await reader.readDurableHighWater(session.id);
    const { bootstrap, state } = await createSessionTranscriptBootstrap({
      reader,
      sessionId: session.id,
      subscriptionId: `benchmark-${fixture.name}`,
      throughSequence,
      rootTurn: null,
      activeAssistantStreams: [],
      maxBytes: BOOTSTRAP_BYTES,
      projection: 'owner',
    });
    const bootstrapCpuMs = performance.now() - openedAt;
    let pageRequests = 0;
    let transferredRawBytes = bootstrap.durable.rawBytes + bootstrap.overlay.rawBytes;
    const subscription = new ClientSessionSubscription(
      {
        hostEpoch: 'benchmark-host',
        subscriptionId: state.subscriptionId,
        nextSequence: 1,
        activeAssistantStreams: [],
        transcript: bootstrap,
        snapshot: {
          schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
          session: {
            sessionId: state.sessionId,
            metadataRevision: 1,
            status: 'active',
            createdAt: 1,
            isArchived: false,
          },
          projectionRevision: 1,
          rootTurn: null,
          goal: null,
          queue: {
            hostEpoch: 'benchmark-host',
            queueRevision: 0,
            steering: [],
            followup: [],
          },
          interactions: { pending: [] },
        },
      },
      async () => undefined,
      async (request) => {
        pageRequests += 1;
        const page = await readSessionTranscriptPage({ reader, state, request });
        transferredRawBytes += page.rawBytes;
        return page;
      },
    );
    const materializeAt = performance.now();
    const materialized = await subscription.loadTranscript((value) => value);
    const materializeCpuMs = performance.now() - materializeAt;
    if (materialized.length !== messages.length) {
      throw new Error(
        `${fixture.name} materialized ${materialized.length}/${messages.length} messages`,
      );
    }
    const wireRequests = 1 + pageRequests;
    const semantic =
      fixture.semantic || fixture.alternatingVisibility || FULL_SEMANTIC
        ? await measureSemantic({
            reader,
            store,
            sessionId: session.id,
            throughSequence,
            fullWindows: FULL_SEMANTIC,
            databasePath: join(root, OPERATIONAL_STATE_DATABASE_NAME),
          })
        : undefined;
    return {
      fixture: fixture.name,
      messages: messages.length,
      rawMiB: decimalMiB(transferredRawBytes),
      bootstrapKiB: decimalKiB(bootstrap.durable.rawBytes + bootstrap.overlay.rawBytes),
      wireRequests,
      pageRequests,
      setupMs: setupMs.toFixed(1),
      bootstrapCpuMs: bootstrapCpuMs.toFixed(1),
      materializeCpuMs: materializeCpuMs.toFixed(1),
      modeledRttFloorMs: wireRequests * RTT_MS,
      ...semanticMetrics(semantic),
    };
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

function buildMessages(fixture) {
  const messages = [];
  let encodedBytes = 0;
  const targetCount = fixture.messages ?? Number.POSITIVE_INFINITY;
  while (
    messages.length < targetCount &&
    (fixture.totalBytes === undefined || encodedBytes < fixture.totalBytes)
  ) {
    const index = messages.length;
    const message =
      fixture.alternatingVisibility && index % 2 === 1
        ? {
            type: 'permission_decision',
            id: `message-${index}`,
            turnId: `turn-${index}`,
            ts: index + 1,
            toolUseId: `tool-${index}`,
            toolName: 'benchmark',
            decision: 'allow',
          }
        : {
            type: 'user',
            id: `message-${index}`,
            turnId: `turn-${index}`,
            ts: index + 1,
            text: 'x'.repeat(fixture.textBytes),
          };
    messages.push(message);
    encodedBytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
  }
  return messages;
}

async function measureSemantic({
  reader,
  store,
  sessionId,
  throughSequence,
  fullWindows,
  databasePath,
}) {
  let storageCalls = 0;
  let positionPageCalls = 0;
  let bodyCalls = 0;
  let releaseCalls = 0;
  let rawBytes = 0;
  let responses = 0;
  let encodedBytes = 0;
  let retainedBytes = 0;
  let peakRetainedBytes = 0;
  let preparingBytes = 0;
  let peakPreparationBytes = 0;
  const measuredReader = {
    ...reader,
    readPositionPage: async (request) => {
      storageCalls += 1;
      positionPageCalls += 1;
      return reader.readPositionPage(request);
    },
    readPositionRecords: async (request) => {
      storageCalls += 1;
      bodyCalls += 1;
      const result = await reader.readPositionRecords(request);
      rawBytes += result.rawBytes;
      return result;
    },
    releasePositionSnapshot: async (request) => {
      storageCalls += 1;
      releaseCalls += 1;
      return reader.releasePositionSnapshot(request);
    },
  };
  const accounting = {
    retain: (bytes) => {
      if (retainedBytes + bytes > 64 * 1024 * 1024) return false;
      retainedBytes += bytes;
      peakRetainedBytes = Math.max(peakRetainedBytes, retainedBytes);
      return true;
    },
    release: (bytes) => {
      retainedBytes -= bytes;
      if (retainedBytes < 0) throw new Error('semantic benchmark accounting underflow');
    },
  };
  const owner = await acquireSemanticSnapshot(measuredReader, sessionId, 'owner', throughSequence);
  const shared = await acquireSemanticSnapshot(
    measuredReader,
    sessionId,
    'shared',
    throughSequence,
  );
  let buildSteps = owner.buildSteps + shared.buildSteps;
  let secondOwner;
  if (owner.total === 10_000 && shared.total === 5_000) {
    await store.appendMessage(sessionId, {
      type: 'system_note',
      id: 'benchmark-hidden-generation-note',
      ts: throughSequence + 2,
      kind: 'session_start',
    });
    secondOwner = await acquireSemanticSnapshot(
      measuredReader,
      sessionId,
      'owner',
      throughSequence + 1,
    );
    buildSteps += secondOwner.buildSteps;
    if (secondOwner.total !== owner.total) {
      throw new Error('hidden generation marker changed semantic position cardinality');
    }
  }
  const inspector = new DatabaseSync(databasePath);
  inspector.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const cardinality = inspector
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM session_turn_position_snapshots WHERE session_id = ?) AS snapshot_rows,
         (SELECT COUNT(*) FROM session_turn_snapshot_positions WHERE session_id = ?) AS position_rows,
         (SELECT COUNT(*) FROM session_turn_snapshot_leases WHERE session_id = ?) AS lease_rows`,
    )
    .get(sessionId, sessionId, sessionId);
  const dataVersionBefore = inspector.prepare('PRAGMA data_version').get().data_version;
  const warmWalBefore = await fileSize(`${databasePath}-wal`);
  const cpuSamples = [];
  const warmSnapshotKey = JSON.stringify(owner.state.currentSnapshot?.key);
  const warmAnchors = [
    { kind: 'tail' },
    { kind: 'ordinal', ordinal: Math.floor(owner.total / 2) },
    { kind: 'turn', turnId: `turn-${Math.floor(owner.total / 2)}` },
  ];
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const started = performance.now();
    const page = await querySemanticTranscriptPositions({
      reader: measuredReader,
      state: owner.state,
      request: {
        kind: 'page',
        subscriptionId: owner.state.subscriptionId,
        snapshotToken: owner.token,
        anchor: warmAnchors[iteration % warmAnchors.length],
        maxPositions: 10,
      },
    });
    if (page.kind !== 'page') throw new Error(`warm semantic read returned ${page.kind}`);
    if (iteration >= 2) cpuSamples.push(performance.now() - started);
  }
  if (JSON.stringify(owner.state.currentSnapshot?.key) !== warmSnapshotKey) {
    throw new Error('warm semantic reads changed their exact snapshot identity');
  }
  const warmWalAfter = await fileSize(`${databasePath}-wal`);
  const dataVersionAfter = inspector.prepare('PRAGMA data_version').get().data_version;
  inspector.close();
  const windowPositionReadsBefore = positionPageCalls;
  const windowBodyReadsBefore = bodyCalls;
  const windowLimit = fullWindows ? Number.POSITIVE_INFINITY : 1;
  let startOrdinal = 0;
  let windows = 0;
  let acceptedPositions = 0;
  let oversizedPositions = 0;
  for (
    let windowIndex = 0;
    startOrdinal < owner.total && windowIndex < windowLimit;
    windowIndex += 1
  ) {
    preparingBytes += 48 * 1024 * 1024;
    peakPreparationBytes = Math.max(peakPreparationBytes, preparingBytes);
    let result;
    try {
      result = await readSemanticTranscriptTurnWindow({
        reader: measuredReader,
        state: owner.state,
        request: {
          kind: 'open',
          subscriptionId: owner.state.subscriptionId,
          snapshotToken: owner.token,
          startOrdinal,
          maxPositions: 10,
          replaceCursor: null,
        },
        accounting,
      });
    } finally {
      preparingBytes -= 48 * 1024 * 1024;
    }
    if (result.kind === 'position_too_large') {
      oversizedPositions += 1;
      break;
    }
    if (result.kind !== 'page') throw new Error(`semantic window returned ${result.kind}`);
    const fragments = [];
    while (result.kind === 'page') {
      responses += 1;
      encodedBytes += Buffer.byteLength(JSON.stringify(result), 'utf8');
      fragments.push(Buffer.from(result.data, 'base64'));
      if (result.nextCursor === null) break;
      result = await readSemanticTranscriptTurnWindow({
        reader: measuredReader,
        state: owner.state,
        request: {
          kind: 'continue',
          subscriptionId: owner.state.subscriptionId,
          cursor: result.nextCursor,
        },
        accounting,
      });
    }
    if (result.kind !== 'page') throw new Error(`semantic continuation returned ${result.kind}`);
    const decoded = JSON.parse(Buffer.concat(fragments).toString('utf8'));
    if (decoded.startOrdinal !== startOrdinal || decoded.endOrdinalExclusive <= startOrdinal) {
      throw new Error('semantic benchmark window did not advance');
    }
    windows += 1;
    acceptedPositions += decoded.positions.length;
    startOrdinal = decoded.endOrdinalExclusive;
  }
  const ownerTotal = owner.total;
  const sharedTotal = shared.total;
  if (secondOwner) {
    await releaseSubscriberSemanticTranscript(measuredReader, secondOwner.state, accounting);
  }
  await releaseSubscriberSemanticTranscript(measuredReader, shared.state, accounting);
  await releaseSubscriberSemanticTranscript(measuredReader, owner.state, accounting);
  if (retainedBytes !== 0) throw new Error('semantic benchmark retained accounting leaked');
  if (preparingBytes !== 0) throw new Error('semantic benchmark preparation accounting leaked');
  if (fullWindows && startOrdinal < owner.total && owner.total !== 1) {
    throw new Error('semantic benchmark did not cover every position');
  }
  cpuSamples.sort((left, right) => left - right);
  const rawForAmplification = Math.max(1, rawBytes);
  return {
    ownerTotal,
    sharedTotal,
    storageCalls,
    buildSteps,
    windowPositionReads: positionPageCalls - windowPositionReadsBefore,
    windowBodyReads: bodyCalls - windowBodyReadsBefore,
    releaseCalls,
    windows,
    acceptedPositions,
    oversizedPositions,
    rawBytes,
    responses,
    encodedBytes,
    peakRetainedBytes,
    peakPreparationBytes,
    snapshotRows: Number(cardinality.snapshot_rows),
    positionRows: Number(cardinality.position_rows),
    leaseRows: Number(cardinality.lease_rows),
    warmWalDeltaBytes: warmWalAfter - warmWalBefore,
    warmDataVersionDelta: Number(dataVersionAfter) - Number(dataVersionBefore),
    wireAmplification: (encodedBytes / rawForAmplification).toFixed(3),
    cpuMedianMs: cpuSamples[Math.floor(cpuSamples.length / 2)].toFixed(3),
    cpuP95Ms: cpuSamples[Math.ceil(cpuSamples.length * 0.95) - 1].toFixed(3),
  };
}

async function acquireSemanticSnapshot(reader, sessionId, projection, throughSequence) {
  const state = createSubscriberSemanticTranscriptState({
    sessionId,
    subscriptionId: `benchmark-${projection}-${sessionId}`,
    projection,
    cursorSecret: randomBytes(32),
  });
  confirmSemanticTranscriptWatermark(state, throughSequence);
  let result = await querySemanticTranscriptPositions({
    reader,
    state,
    request: {
      kind: 'acquire',
      subscriptionId: state.subscriptionId,
      anchor: { kind: 'tail' },
      maxPositions: 10,
    },
  });
  let buildSteps = result.kind === 'building' ? 1 : 0;
  for (let steps = 0; result.kind === 'building' && steps < 100_000; steps += 1) {
    result = await querySemanticTranscriptPositions({
      reader,
      state,
      request: {
        kind: 'page',
        subscriptionId: state.subscriptionId,
        snapshotToken: result.snapshotToken,
        anchor: { kind: 'tail' },
        maxPositions: 10,
      },
    });
    if (result.kind === 'building') buildSteps += 1;
  }
  if (result.kind !== 'page') throw new Error(`semantic snapshot returned ${result.kind}`);
  return { state, token: result.snapshotToken, total: result.totalPositions, buildSteps };
}

function sqliteReader(store) {
  return {
    readDurableHighWater: (sessionId) => store.readTranscriptHighWaterSnapshot(sessionId),
    readDurablePage: (sessionId, request) => store.readTranscriptPageSnapshot(sessionId, request),
    readDurableRecords: (sessionId, request) =>
      store.readTranscriptRecordsSnapshot(sessionId, request),
    readDurableMessagesById: (sessionId, request) =>
      store.readTranscriptMessagesSnapshot(sessionId, request),
    readPositionPage: (request) => store.readTurnPositionPageSnapshot(request),
    readPositionRecords: (request) => store.readTranscriptRecordsByPositionKeysSnapshot(request),
    releasePositionSnapshot: (request) => store.releaseTurnPositionSnapshot(request),
    readActiveOverlay: async () => [],
  };
}

function decimalMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function decimalKiB(bytes) {
  return (bytes / 1024).toFixed(2);
}

function semanticMetrics(semantic) {
  return {
    semanticOwner: semantic?.ownerTotal ?? '-',
    semanticShared: semantic?.sharedTotal ?? '-',
    semanticStorageCalls: semantic?.storageCalls ?? '-',
    semanticBuildSteps: semantic?.buildSteps ?? '-',
    semanticPositionReads: semantic?.windowPositionReads ?? '-',
    semanticBodyReads: semantic?.windowBodyReads ?? '-',
    semanticReleaseCalls: semantic?.releaseCalls ?? '-',
    semanticWindows: semantic?.windows ?? '-',
    semanticAcceptedPositions: semantic?.acceptedPositions ?? '-',
    semanticOversizedPositions: semantic?.oversizedPositions ?? '-',
    semanticResponses: semantic?.responses ?? '-',
    semanticRawMiB: semantic ? decimalMiB(semantic.rawBytes) : '-',
    semanticEncodedMiB: semantic ? decimalMiB(semantic.encodedBytes) : '-',
    semanticPeakMiB: semantic ? decimalMiB(semantic.peakRetainedBytes) : '-',
    semanticPeakPreparationMiB: semantic ? decimalMiB(semantic.peakPreparationBytes) : '-',
    semanticSnapshotRows: semantic?.snapshotRows ?? '-',
    semanticPositionRows: semantic?.positionRows ?? '-',
    semanticLeaseRows: semantic?.leaseRows ?? '-',
    semanticWarmWalDelta: semantic?.warmWalDeltaBytes ?? '-',
    semanticWarmDataVersionDelta: semantic?.warmDataVersionDelta ?? '-',
    semanticWireAmplification: semantic?.wireAmplification ?? '-',
    semanticCpuMedianMs: semantic?.cpuMedianMs ?? '-',
    semanticCpuP95Ms: semantic?.cpuP95Ms ?? '-',
  };
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return 0;
    throw error;
  }
}
