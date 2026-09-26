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
import { waitFor } from '@maka/core/test-only/async-primitives';
import type { PlanQueryResult } from '@maka/runtime-host/protocol';
import { AcpSessionDomainObservation } from '../acp/session-domain-observation.js';

test('canonical Plan replacement rereads even when Goal is unchanged and rejects an old page', async () => {
  const reads: Array<(result: PlanQueryResult) => void> = [];
  const plans: number[] = [];
  const goals: unknown[] = [];
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: () =>
      new Promise<PlanQueryResult>((resolve) => {
        reads.push(resolve);
      }),
    goalNotify: () => async (status) => {
      goals.push(status);
    },
    planNotify: () => async (status) => {
      plans.push(status.storeVersion);
    },
  });
  observer.initialize(null);
  assert.equal(reads.length, 1);
  observer.canonicalReplacement(null);
  reads[0]!(page(9));
  await waitFor(() => reads.length === 2);
  assert.deepEqual(plans, []);
  reads[1]!(page(1));
  await waitFor(() => plans.length === 1);
  assert.deepEqual(plans, [1]);
  assert.equal(goals.length, 2, 'new canonical epoch replays the Goal projection');
  observer.dispose();
});

test('Plan invalidations coalesce during one read and dispose fences late delivery', async () => {
  const reads: Array<(result: PlanQueryResult) => void> = [];
  const plans: number[] = [];
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: () =>
      new Promise<PlanQueryResult>((resolve) => {
        reads.push(resolve);
      }),
    goalNotify: () => undefined,
    planNotify: () => async (status) => {
      plans.push(status.storeVersion);
    },
  });
  observer.planChanged();
  observer.planChanged();
  observer.planChanged();
  assert.equal(reads.length, 1);
  reads[0]!(page(1));
  await waitFor(() => reads.length === 2);
  reads[1]!(page(2));
  await waitFor(() => plans.includes(2));
  assert.deepEqual(plans, [1, 2]);
  observer.planChanged();
  await waitFor(() => reads.length === 3);
  observer.dispose();
  reads[2]!(page(3));
  await Promise.resolve();
  assert.deepEqual(plans, [1, 2]);
});

test('failed initial Plan refresh retries without inventing a state notification', async () => {
  let reads = 0;
  const plans: number[] = [];
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: async () => {
      reads += 1;
      if (reads === 1) throw new Error('temporary read failure');
      return page(4);
    },
    goalNotify: () => undefined,
    planNotify: () => async (status) => {
      plans.push(status.storeVersion);
    },
  });
  observer.planChanged();
  await waitFor(() => plans.length === 1);
  assert.deepEqual(plans, [4]);
  assert.equal(reads, 2);
  observer.dispose();
});

function page(storeVersion: number): PlanQueryResult {
  return {
    kind: 'page',
    sessionId: 'session-1',
    storeVersion,
    latestProposalId: null,
    activeExecutionId: null,
    items: [],
    nextCursor: null,
  };
}
