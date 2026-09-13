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
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { decodeExternalAgentDraftModelProjection } from '../protocol/external-agent-draft.js';
import type { AcpAgentBackend, AcpModelConfiguration } from '../server/acp/acp-agent-backend.js';
import { HostExternalAgentDraftModelCoordinator } from '../server/acp/draft-model-coordinator.js';

const DRAFT_ID = 'b1f0a594-e497-416b-8ee7-b4490996db82';
const CWD = '/workspace/project';
const OPTIONS = [
  { value: 'gemini-flash', name: 'Gemini Flash' },
  { value: 'claude-sonnet', name: 'Claude Sonnet' },
] as const;

function context(connectionId: string): ConnectionContext {
  return {
    hostEpoch: 'epoch',
    connectionId,
    principal: 'desktop',
    acquireResidency: () => ({ release() {} }),
  };
}

function fakeBackend(disposals: { count: number }) {
  let currentValue: string = OPTIONS[0].value;
  const configuration = (): AcpModelConfiguration => ({
    configId: 'model',
    currentValue,
    options: OPTIONS,
  });
  const backend = {
    prepare: async () => configuration(),
    modelConfiguration: configuration,
    setModel: async (value: string) => {
      assert.ok(OPTIONS.some((option) => option.value === value));
      currentValue = value;
      return configuration();
    },
    dispose: async () => {
      disposals.count += 1;
    },
  } as unknown as AcpAgentBackend;
  return backend;
}

test('discovers, updates, and promotes one connection-owned ACP draft', async () => {
  const disposals = { count: 0 };
  const backend = fakeBackend(disposals);
  let preparations = 0;
  const coordinator = new HostExternalAgentDraftModelCoordinator({
    resolveWorkspace: async () => ({ cwd: CWD }),
    prepareBackend: async () => {
      preparations += 1;
      return backend;
    },
  });
  const owner = context('connection-1');

  const prepared = await coordinator.handlers['external_agents.draft.model.prepare'](
    {
      draftId: DRAFT_ID,
      externalAgentId: 'antigravity',
      workspace: { kind: 'host_path', path: CWD },
    },
    owner,
  );
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.result.options.length, 2);
    assert.deepEqual(decodeExternalAgentDraftModelProjection(prepared.result), prepared.result);
  }

  const repeated = await coordinator.handlers['external_agents.draft.model.prepare'](
    {
      draftId: DRAFT_ID,
      externalAgentId: 'antigravity',
      workspace: { kind: 'host_path', path: CWD },
    },
    owner,
  );
  assert.equal(repeated.ok, true);
  assert.equal(preparations, 1);

  const rebound = await coordinator.handlers['external_agents.draft.model.prepare'](
    {
      draftId: DRAFT_ID,
      externalAgentId: 'antigravity',
      workspace: { kind: 'host_path', path: '/workspace/other' },
    },
    owner,
  );
  assert.equal(rebound.ok, false);
  if (!rebound.ok) assert.equal(rebound.error.code, 'operation_conflict');

  const updated = await coordinator.handlers['external_agents.draft.model.update'](
    { draftId: DRAFT_ID, value: OPTIONS[1].value },
    owner,
  );
  assert.equal(updated.ok, true);
  if (updated.ok) assert.equal(updated.result.currentValue, OPTIONS[1].value);

  assert.equal(coordinator.take('antigravity', DRAFT_ID, CWD), backend);
  assert.equal(disposals.count, 0, 'promotion must retain the initialized ACP process');
});

test('only the owning connection may release a draft and disconnect cleanup disposes it', async () => {
  const disposals = { count: 0 };
  const coordinator = new HostExternalAgentDraftModelCoordinator({
    resolveWorkspace: async () => ({ cwd: CWD }),
    prepareBackend: async () => fakeBackend(disposals),
  });
  const owner = context('connection-1');
  await coordinator.handlers['external_agents.draft.model.prepare'](
    {
      draftId: DRAFT_ID,
      externalAgentId: 'antigravity',
      workspace: { kind: 'host_path', path: CWD },
    },
    owner,
  );

  const foreignRelease = await coordinator.handlers['external_agents.draft.release'](
    { draftId: DRAFT_ID },
    context('connection-2'),
  );
  assert.deepEqual(foreignRelease, {
    ok: false,
    error: {
      code: 'operation_conflict',
      message: 'External Agent draft model: operation_conflict',
    },
  });
  assert.equal(disposals.count, 0);

  await coordinator.releaseConnection(owner.connectionId);
  assert.equal(disposals.count, 1);
  assert.equal(coordinator.take('antigravity', DRAFT_ID, CWD), undefined);
});
