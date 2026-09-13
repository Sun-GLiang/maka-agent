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
  decodeExternalAgentSessionModelProjection,
  EXTERNAL_AGENT_SESSION_OPERATION_SPECS,
} from '../protocol/external-agent-session.js';
import {
  AcpModelConfigurationError,
  type AcpAgentBackend,
  type AcpModelConfiguration,
} from '../server/acp/acp-agent-backend.js';
import { HostExternalAgentSessionModelCoordinator } from '../server/acp/session-model-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const initial: AcpModelConfiguration = {
  configId: 'model',
  currentValue: 'gemini-3.7-flash-high',
  options: [
    { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
    { value: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
  ],
};
const context = {
  hostEpoch: 'epoch-1',
  connectionId: 'connection-1',
  principal: 'owner',
  principalKind: 'local_owner',
  acquireResidency: () => ({ release() {} }),
} satisfies ConnectionContext;

test('external Agent model protocol accepts one bounded Antigravity model selector', () => {
  const projection = decodeExternalAgentSessionModelProjection({
    sessionId: 'session-1',
    acpAgentId: 'antigravity',
    ...initial,
  });
  assert.deepEqual(projection.options, initial.options);
  assert.throws(
    () => decodeExternalAgentSessionModelProjection({ ...projection, currentValue: 'maka-model' }),
    /Current external Agent model is not selectable/,
  );
  assert.deepEqual(
    EXTERNAL_AGENT_SESSION_OPERATION_SPECS['external_agents.session.model.update'].decodeInput({
      sessionId: 'session-1',
      value: 'gemini-3.1-pro-preview',
    }),
    { sessionId: 'session-1', value: 'gemini-3.1-pro-preview' },
  );
});

test('external Agent model coordinator queries and updates the same live ACP backend', async () => {
  let current = initial;
  const requested: string[] = [];
  const backend = {
    modelConfiguration: () => current,
    setModel: async (value: string) => {
      requested.push(value);
      current = { ...initial, currentValue: value };
      return current;
    },
  } as unknown as AcpAgentBackend;
  const coordinator = new HostExternalAgentSessionModelCoordinator((sessionId) =>
    sessionId === 'session-1' ? backend : undefined,
  );

  const queried = await coordinator.handlers['external_agents.session.model.query'](
    { sessionId: 'session-1' },
    context,
  );
  assert.equal(queried.ok && queried.result.currentValue, initial.currentValue);

  const updated = await coordinator.handlers['external_agents.session.model.update'](
    { sessionId: 'session-1', value: 'gemini-3.1-pro-preview' },
    context,
  );
  assert.equal(updated.ok && updated.result.currentValue, 'gemini-3.1-pro-preview');
  assert.deepEqual(requested, ['gemini-3.1-pro-preview']);

  assert.deepEqual(
    await coordinator.handlers['external_agents.session.model.query'](
      { sessionId: 'missing-session' },
      context,
    ),
    {
      ok: false,
      error: { code: 'not_found', message: 'External Agent Session model: not_found' },
    },
  );
});

test('external Agent model coordinator rejects model changes while the ACP Session is busy', async () => {
  const backend = {
    modelConfiguration: () => initial,
    setModel: async () => {
      throw new AcpModelConfigurationError('busy');
    },
  } as unknown as AcpAgentBackend;
  const coordinator = new HostExternalAgentSessionModelCoordinator(() => backend);
  assert.deepEqual(
    await coordinator.handlers['external_agents.session.model.update'](
      { sessionId: 'session-1', value: 'gemini-3.1-pro-preview' },
      context,
    ),
    {
      ok: false,
      error: { code: 'session_busy', message: 'External Agent Session model: session_busy' },
    },
  );
});
