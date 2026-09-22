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
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import type { SessionSummary } from '@maka/core/session';
import { useExecutorSelection, newTaskConfiguration, ConversationServicesProvider, type ConversationServices } from '../../renderer/features/conversation/index.js';

const entry: ExecutorCatalogEntry = { id: 'external', displayName: 'External', readiness: 'ready', models: [{ id: 'selected', name: 'Selected' }], supportsAttachments: false, supportsModelChange: true };

test('late draft discovery cannot replace the current target; existing tasks inspect without probing', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = { document, window, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  let latest!: ReturnType<typeof useExecutorSelection>;
  let discoveryCalls = 0, inspectionCalls = 0;
  let finishOld!: (value: readonly ExecutorCatalogEntry[]) => void;
  const old = new Promise<readonly ExecutorCatalogEntry[]>(resolve => { finishOld = resolve; });
  const services = {
    subscribeChanges: () => () => {},
    newTasks: { subscribeChanges: () => () => {}, getExecutors: async () => { discoveryCalls++; return discoveryCalls === 1 ? old : [entry]; } },
    sessions: { getExecutorState: async () => { inspectionCalls++; return [{ ...entry, readiness: 'history_only' }]; }, setExecutorConfiguration: async () => ({ ok: false, code: 'operation_unavailable' }) },
  } as unknown as ConversationServices;
  function Probe(props: { draftKey: string; session?: SessionSummary }) {
    latest = useExecutorSelection({ key: props.draftKey, cwd: '/fixture', target: { hostId: 'host', profileId: 'profile', projectId: null }, session: props.session });
    return null;
  }
  async function render(draftKey: string, session?: SessionSummary) {
    await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe, { draftKey, session }) })));
  }
  try {
    await render('old');
    await render('current');
    assert.deepEqual(latest.catalog, [entry]);
    await act(async () => { finishOld([{ ...entry, id: 'stale' }]); await old; });
    assert.deepEqual(latest.catalog, [entry]);
    await act(async () => latest.select({ executorId: 'external', configuration: { model: 'selected' } }));
    await act(async () => latest.refresh());
    assert.equal(latest.selection?.configuration.model, 'selected');
    await render('current', { id: 'saved', executorId: 'external', executorConfig: { model: 'selected' } } as SessionSummary);
    assert.equal(latest.entry?.readiness, 'history_only');
    assert.equal(discoveryCalls, 3);
    assert.equal(inspectionCalls, 1);
    await act(async () => latest.select({ executorId: 'external', configuration: { model: 'rejected' } }));
    assert.equal(latest.selection?.configuration.model, 'selected');
    assert.equal(latest.error, 'operation_unavailable');
    await render('next-draft');
    assert.equal(latest.selection, undefined);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});


test('native task creation preserves untouched, provider-default and explicit thinking choices', () => {
  for (const level of [undefined, null, 'high'] as const) {
    const configuration = newTaskConfiguration({
      newChatModel: null, pendingNewChatThinkingLevel: level,
      newChatPermissionChoice: undefined, newChatCollaborationMode: 'agent',
      newChatOrchestrationMode: 'default',
    });
    assert.equal(configuration.thinkingLevel, level);
    assert.equal(Object.hasOwn(configuration, 'executorId'), false);
  }
});

test('an executor choice uses its exact model without inheriting native thinking or orchestration', () => {
  const configuration = newTaskConfiguration({
    executorSelection: { executorId: 'external', configuration: { model: 'selected' } },
    newChatModel: { llmConnectionId: 'native', llmConnectionSlug: 'native', model: 'native-model' },
    pendingNewChatThinkingLevel: 'high', newChatPermissionChoice: undefined,
    newChatCollaborationMode: 'plan', newChatOrchestrationMode: 'swarm',
  });
  assert.ok('executorId' in configuration);
  assert.equal(configuration.executorId, 'external');
  assert.deepEqual(configuration.executorConfig, { model: 'selected' });
  assert.equal(Object.hasOwn(configuration, 'thinkingLevel'), false);
  assert.equal(configuration.collaborationMode, 'agent');
  assert.equal(configuration.orchestrationMode, 'default');
});
