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
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';
import { useShellChatModel } from '../../renderer/use-shell-chat-model.js';
import {
  createActionsDeps,
  installWindow,
} from './app-shell-chat-actions-fixture.js';

const DEFAULT_CHOICE: ChatModelChoice = {
  connectionId: 'default-id',
  connectionSlug: 'default-connection',
  connectionName: 'Default connection',
  providerType: 'openai-compatible',
  providerLabel: 'Default provider',
  model: 'default-model',
  label: 'Default model',
  isDefault: true,
  thinkingLevels: [],
};
const SELECTED_CHOICE: ChatModelChoice = {
  ...DEFAULT_CHOICE,
  connectionId: 'selected-id',
  connectionSlug: 'selected-connection',
  connectionName: 'Selected connection',
  model: 'selected-model',
  label: 'Selected model',
};

test('selecting a Maka model commits one target and first send uses that exact model', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  let latest: ReturnType<typeof useShellChatModel> | undefined;

  function Probe() {
    latest = useShellChatModel({
      uiLocale: 'en',
      connections: [],
      chatModelChoices: [DEFAULT_CHOICE, SELECTED_CHOICE],
      sessionSendOutcome: undefined,
      defaultConnection: DEFAULT_CHOICE.connectionSlug,
      newTaskKey: 'target',
      activeSession: undefined,
      sessionHealthSession: undefined,
      persistedComposerDefaults: null,
      usePersistedComposerDefaults: false,
      connectionSnapshotReady: true,
      modelPickerDisabled: false,
      openSettingsSection: assert.fail,
      openModelPicker: assert.fail,
      refreshModelChoices: assert.fail,
    });
    return null;
  }

  try {
    await act(() => root.render(createElement(Probe)));
    assert.ok(latest);
    await act(() => latest?.selectNewTaskExecutionChoice({
      ...latest!.newTaskExecutionChoice,
      executor: 'antigravity',
    }));
    assert.equal(latest.newTaskExecutionChoice.executor, 'antigravity');

    await act(() => latest?.selectNewTaskExecutionChoice({
      executor: 'maka',
      makaModel: {
        llmConnectionId: SELECTED_CHOICE.connectionId,
        llmConnectionSlug: SELECTED_CHOICE.connectionSlug,
        model: SELECTED_CHOICE.model,
      },
    }));
    assert.deepEqual(latest.newTaskExecutionChoice, {
      executor: 'maka',
      makaModel: {
        llmConnectionId: SELECTED_CHOICE.connectionId,
        llmConnectionSlug: SELECTED_CHOICE.connectionSlug,
        model: SELECTED_CHOICE.model,
      },
    });

    let createInput: unknown;
    const restoreWindow = installWindow({
      newTasks: {
        create: async (_target: unknown, input: unknown) => {
          createInput = input;
          return { id: 'session-1' };
        },
      },
      sessions: {
        submitMessage: async () => ({
          ok: true,
          attachments: [],
          skillInvocation: { loaded: [], failed: [], receipts: [] },
        }),
      },
    });
    try {
      const sent = await createAppShellChatActions({
        ...createActionsDeps(),
        newTaskExecutionChoice: latest.newTaskExecutionChoice,
      }).send('hello');
      assert.equal(sent, true);
    } finally {
      restoreWindow();
    }
    assert.deepEqual(createInput, {
      name: 'New Chat',
      llmConnectionId: SELECTED_CHOICE.connectionId,
      llmConnectionSlug: SELECTED_CHOICE.connectionSlug,
      model: SELECTED_CHOICE.model,
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    });
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
