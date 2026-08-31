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
import { test } from 'node:test';
import {
  UsageSnapshotCache,
  UsageSnapshotCapacityError,
  type UsageSnapshotContents,
} from '../server/usage-snapshot-cache.js';

const CONTENTS: UsageSnapshotContents = {
  summary: {
    range: { from: 0, to: 1 },
    totalRequests: 0,
    totalCostUsd: 0,
    totalTokens: {
      input: 0,
      output: 0,
      cacheMiss: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
  },
  provenance: {
    coverage: {
      attempts: 0,
      pricedAttempts: 0,
      unpricedAttempts: 0,
      usageReportedAttempts: 0,
      usagePartialAttempts: 0,
      usageMissingAttempts: 0,
    },
    legacyRecords: 0,
    unreadableRecords: 0,
    pendingRepairs: 0,
  },
  llmRows: [],
  llmTruncated: false,
  toolRows: [],
  toolTruncated: false,
  pricingEntries: [],
};

test('preserves four owned leases at capacity instead of evicting an active revision', () => {
  let revision = 0;
  const cache = new UsageSnapshotCache({
    capacity: 4,
    createRevision: () => `revision-${++revision}`,
  });
  const retained = Array.from({ length: 4 }, (_, index) =>
    cache.retain(`connection-${index}`, CONTENTS),
  );

  assert.throws(
    () => cache.retain('connection-5', CONTENTS),
    (error: unknown) =>
      error instanceof UsageSnapshotCapacityError &&
      error.message === 'Usage snapshot capacity is occupied',
  );
  for (const [index, snapshot] of retained.entries()) {
    assert.equal(cache.get(`connection-${index}`, snapshot.revision)?.revision, snapshot.revision);
  }
});

test('enforces ownership and reclaims capacity on release and connection teardown', () => {
  let revision = 0;
  const cache = new UsageSnapshotCache({
    capacity: 2,
    createRevision: () => `revision-${++revision}`,
  });
  const first = cache.retain('connection-a', CONTENTS);
  cache.retain('connection-b', CONTENTS);

  assert.equal(cache.get('connection-b', first.revision), undefined);
  cache.release('connection-b', first.revision);
  assert.equal(cache.get('connection-a', first.revision)?.revision, first.revision);
  assert.throws(() => cache.retain('connection-c', CONTENTS), UsageSnapshotCapacityError);

  cache.release('connection-a', first.revision);
  const third = cache.retain('connection-c', CONTENTS);
  assert.equal(cache.get('connection-c', third.revision)?.revision, third.revision);

  cache.releaseConnection('connection-b');
  const fourth = cache.retain('connection-d', CONTENTS);
  assert.equal(cache.get('connection-d', fourth.revision)?.revision, fourth.revision);
});

test('renews idle lifetime on owner access without extending the hard deadline', () => {
  let now = 0;
  const cache = new UsageSnapshotCache({
    now: () => now,
    ttlMs: 100,
    hardTtlMs: 250,
    createRevision: () => 'revision-1',
  });
  const retained = cache.retain('connection-a', CONTENTS);

  now = 90;
  assert.equal(cache.get('connection-a', retained.revision)?.revision, retained.revision);
  now = 180;
  assert.equal(cache.get('connection-a', retained.revision)?.revision, retained.revision);
  now = 249;
  assert.equal(cache.get('connection-a', retained.revision)?.revision, retained.revision);
  now = 250;
  assert.equal(cache.get('connection-a', retained.revision), undefined);
});

test('expires an idle lease before its hard deadline', () => {
  let now = 0;
  const cache = new UsageSnapshotCache({
    now: () => now,
    ttlMs: 100,
    hardTtlMs: 250,
    createRevision: () => 'revision-1',
  });
  const retained = cache.retain('connection-a', CONTENTS);

  now = 100;
  assert.equal(cache.get('connection-a', retained.revision), undefined);
});
