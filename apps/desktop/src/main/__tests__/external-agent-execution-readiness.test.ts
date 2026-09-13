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
import test from 'node:test';
import {
  ensureAntigravityExecutionReady,
  type TaskEntryExternalAgentService,
} from '../../renderer/features/task-entry/testing.js';

const HOST = { profileId: 'local', hostId: 'host-local' };

function services(
  overrides: Partial<TaskEntryExternalAgentService>,
): TaskEntryExternalAgentService {
  return {
    authentication: async () => ({
      acpAgentId: 'antigravity',
      executable: '/agent/agy_acp_server.par',
      status: 'verified',
    }),
    createAttemptId: () => 'attempt-1',
    start: async () => ({
      attemptId: 'attempt-1',
      action: 'login',
      expectedExecutable: '/agent/agy_acp_server.par',
      phase: 'succeeded',
    }),
    query: async () => assert.fail('unexpected setup query'),
    prepareDraftModel: async () => assert.fail('unexpected draft preparation'),
    updateDraftModel: async () => assert.fail('unexpected draft update'),
    releaseDraft: async () => assert.fail('unexpected draft release'),
    ...overrides,
  };
}

test('an unverified Antigravity Host signs in before execution readiness succeeds', async () => {
  let authenticationReads = 0;
  const starts: unknown[] = [];
  const result = await ensureAntigravityExecutionReady(
    services({
      authentication: async () => ({
        acpAgentId: 'antigravity',
        executable: '/agent/agy_acp_server.par',
        status: authenticationReads++ === 0 ? 'unverified' : 'verified',
      }),
      start: async (input, host) => {
        starts.push({ input, host });
        return { ...input, phase: 'connecting' };
      },
      query: async () => ({
        attemptId: 'attempt-1',
        action: 'login',
        expectedExecutable: '/agent/agy_acp_server.par',
        phase: 'succeeded',
      }),
    }),
    HOST,
    async () => undefined,
  );

  assert.deepEqual(result, { status: 'ready' });
  assert.deepEqual(starts, [{
    input: {
      attemptId: 'attempt-1',
      action: 'login',
      expectedExecutable: '/agent/agy_acp_server.par',
    },
    host: HOST,
  }]);
  assert.equal(authenticationReads, 2);
});

test('a failed Antigravity sign-in stays out of the task creation path', async () => {
  const result = await ensureAntigravityExecutionReady(
    services({
      authentication: async () => ({
        acpAgentId: 'antigravity',
        executable: '/agent/agy_acp_server.par',
        status: 'unverified',
      }),
      start: async (input) => ({
        ...input,
        phase: 'failed',
        failure: 'authentication_failed',
      }),
    }),
    HOST,
  );

  assert.deepEqual(result, {
    status: 'setup_required',
    reason: 'login_failed',
    failure: 'authentication_failed',
  });
});

test('Antigravity without a configured executable requests setup without starting login', async () => {
  let starts = 0;
  const result = await ensureAntigravityExecutionReady(
    services({
      authentication: async () => ({
        acpAgentId: 'antigravity',
        executable: '',
        status: 'unverified',
      }),
      start: async (input) => {
        starts += 1;
        return { ...input, phase: 'succeeded' };
      },
    }),
    HOST,
  );

  assert.deepEqual(result, { status: 'setup_required', reason: 'not_configured' });
  assert.equal(starts, 0);
});
