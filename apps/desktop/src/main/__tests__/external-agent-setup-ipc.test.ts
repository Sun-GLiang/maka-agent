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
import type { IpcMainInvokeEvent } from 'electron';
import { registerExternalAgentSetupIpc } from '../external-agent-setup-ipc-main.js';
import { RuntimeHostOAuthPresentation } from '../runtime-host-oauth-presentation.js';
import type { ExternalAgentSetupProjection } from '@maka/runtime-host/protocol';

test('external setup shares browser presentation without accepting a stale attempt URL', async () => {
  const opened: string[] = [];
  const presentation = new RuntimeHostOAuthPresentation(async (url) => {
    opened.push(url);
  });
  const pending = presentation.expect('new-attempt', 'new-attempt');
  await assert.rejects(
    presentation.openExternal(
      'https://accounts.google.com/old',
      'old-attempt',
      new AbortController().signal,
    ),
  );
  assert.deepEqual(opened, []);
  await presentation.openExternal(
    'https://accounts.google.com/new',
    'new-attempt',
    new AbortController().signal,
  );
  assert.deepEqual(await pending.presented, { stateHint: 'new-attempt' });
  assert.deepEqual(opened, ['https://accounts.google.com/new']);
});
test('setup IPC registers an expectation before start and releases it on terminal result or cancel', async () => {
  type Handler = Parameters<
    Parameters<typeof registerExternalAgentSetupIpc>[0]['ipcMain']['handle']
  >[1];
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const presentation = new RuntimeHostOAuthPresentation(async (url) => {
    opened.push(url);
  });
  let phase: ExternalAgentSetupProjection['phase'] = 'connecting';
  let attempts = 0;
  const input = { attemptId: 'attempt-1', action: 'login' as const, expectedExecutable: '/agent' };
  registerExternalAgentSetupIpc({
    selectExecutable: async () => "/existing/agy_acp_server.par",
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    presentation,
    client: {
      startExternalAgentSetup: async (value) => {
        attempts++;
        await presentation.openExternal(
          'https://accounts.google.com/test',
          value.attemptId,
          new AbortController().signal,
        );
        return { ...value, phase };
      },
      queryExternalAgentSetup: async () => ({ ...input, phase }),
      cancelExternalAgentSetup: async () => ({ ...input, phase: 'cancelled' }),
    },
  });
  const invoke = (channel: string, input: unknown) =>
    handlers.get(channel)!({} as IpcMainInvokeEvent, input);
  assert.equal(await invoke('external-agents:select-executable', undefined), '/existing/agy_acp_server.par');
  assert.deepEqual(opened, []);
  await invoke('external-agents:setup:start', input);
  assert.equal(attempts, 1);
  assert.equal(opened.length, 1);
  phase = 'succeeded';
  await invoke('external-agents:setup:query', { attemptId: input.attemptId });
  await invoke('external-agents:setup:start', { ...input, attemptId: 'attempt-2' });
  await invoke('external-agents:setup:cancel', { attemptId: 'attempt-2' });
  const next = presentation.expect('regular-oauth');
  next.cancel();
});
