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
import { act, useState } from 'react';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import {
  ExecutorModelPicker,
  type ExecutorSelection,
  type ExecutorModelPickerProps,
} from '../executor-model-picker.js';
import { NewChatModelPicker } from '../chat-model-switcher.js';
import { Composer } from '../composer.js';
import { exactModelChoiceValue } from '../chat-model-helpers.js';
import { LocaleProvider } from '../locale-context.js';
import { installTranscriptDom } from './transcript-test-dom.js';

const catalog: ExecutorModelPickerProps['catalog'] = [
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    readiness: 'ready',
    models: Array.from({ length: 32 }, (_, index) => ({
      id: `model-${index}`,
      name: `Agent model ${index}`,
    })),
    currentModel: 'model-0',
    supportsAttachments: false,
    supportsModelChange: true,
  },
];
const choices: ChatModelChoice[] = [
  {
    connectionId: 'native',
    connectionSlug: 'native',
    connectionName: 'My account',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'native-model',
    label: 'Native model',
    description: 'Native model description',
    isDefault: true,
    thinkingLevels: [],
  },
  {
    connectionId: 'native',
    connectionSlug: 'native',
    connectionName: 'My account',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'native-model-2',
    label: 'Native model 2',
    description: 'Alternative native model',
    isDefault: false,
    thinkingLevels: [],
  },
];

test('the Composer native fallback commits Maka after browsing an external executor', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  const selected: unknown[] = [];
  function Harness() {
    const [selection, setSelection] = useState<ExecutorSelection>();
    const [model, setModel] = useState({
      llmConnectionId: 'native', llmConnectionSlug: 'native', model: 'native-model',
    });
    return (
      <LocaleProvider locale="en">
        <Composer
          executorPicker={{
            catalog, selection,
            onSelect: (next) => { selected.push(next); setSelection(next); },
            onSetup: () => {}, onRetry: () => {}, onNewTask: () => {},
          }}
          modelChoices={choices}
          newChatModel={model}
          onPickNewChatModel={setModel}
          onSend={() => assert.fail('Selecting a model must not send the draft')}
          onStop={() => {}}
        />
      </LocaleProvider>
    );
  }
  const click = async (element: Element | null | undefined) => {
    assert.ok(element);
    await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
  };
  const button = (text: string) => [...dom.document.querySelectorAll('button')].find(
    (element) => element.textContent === text,
  );
  try {
    await dom.render(<Harness />);
    await click(dom.document.querySelector('.maka-executor-selector'));
    await click(button('Antigravity'));
    assert.equal(selected.length, 0, 'browsing must not change the executor');
    await click([...dom.document.querySelectorAll('.maka-executor-picker-model')].find(
      (element) => element.textContent?.includes('Agent model 31'),
    ));
    assert.deepEqual(selected, [{ executorId: 'antigravity', configuration: { model: 'model-31' } }]);
    await click(dom.document.querySelector('.maka-executor-selector'));
    await click(button('Maka'));
    assert.equal(selected.length, 1, 'browsing back to Maka must not commit it');
    await click(dom.document.querySelector('.maka-new-chat-model-selector [aria-haspopup="listbox"]'));
    await click([...dom.document.querySelectorAll('[role="option"]')].find(
      (element) => element.textContent?.includes('Native model 2'),
    ));
    assert.equal(selected.length, 2);
    assert.equal(selected.at(-1), undefined, 'the native choice must clear the external executor');
    assert.ok(!dom.document.querySelector('.maka-executor-selector')?.textContent?.includes('Antigravity'));
  } finally {
    await dom.cleanup();
  }
});

test('executor choice keeps the native picker intact and exposes every external model with exact identity', async () => {
  const dom = installTranscriptDom();
  const selected: unknown[] = [];
  function Harness() {
    const [selection, setSelection] = useState<ExecutorSelection>();
    return (
      <LocaleProvider locale="en">
        <ExecutorModelPicker
          catalog={catalog}
          selection={selection}
          onSelect={(value) => {
            selected.push(value);
            setSelection(value);
          }}
          onSetup={() => {}}
          onRetry={() => {}}
          onNewTask={() => {}}
        >
          <NewChatModelPicker
            label="Native model"
            choices={choices}
            currentValue={exactModelChoiceValue('native', 'native', 'native-model')}
            currentProviderType="openai"
            renderProviderMark={() => <span data-native-mark>Provider icon</span>}
            onPick={() => {
              selected.push(undefined);
              setSelection(undefined);
            }}
          />
        </ExecutorModelPicker>
      </LocaleProvider>
    );
  }
  let activeList = '';
  const click = async (selector: string) => {
    const element = dom.document.querySelector<HTMLElement>(selector);
    assert.ok(element, selector);
    activeList = element.getAttribute('aria-controls') ?? '';
    await act(async () => {
      element.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
  };
  const choose = async (text: string) => {
    const row = [
      ...dom.document.getElementById(activeList)!.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((row) => row.textContent?.includes(text));
    assert.ok(row, text);
    await act(async () => {
      row.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
  };
  try {
    await dom.render(<Harness />);
    await click('.maka-executor-selector');
    assert.ok(dom.document.querySelector('[data-native-mark]'));
    const antigravity = [...dom.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Antigravity'),
    );
    assert.ok(antigravity);
    await act(async () => {
      antigravity.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
    assert.equal(selected.length, 0, 'browsing an executor does not commit it');
    const rows = [
      ...dom.document.querySelectorAll<HTMLElement>('.maka-executor-picker-model[role="option"]'),
    ];
    assert.equal(rows.length, 33, 'the provider default and full catalog are rendered');
    for (const model of catalog[0]!.models)
      assert.ok(rows.some((row) => row.textContent?.includes(model.name)));
    assert.equal(rows[1]?.getAttribute('aria-selected'), 'true', 'provider default is reflected');
    const model31 = rows.find((row) => row.textContent?.includes('Agent model 31'));
    assert.ok(model31);
    await act(async () => {
      model31.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
    assert.deepEqual(selected.at(-1), {
      executorId: 'antigravity',
      configuration: { model: 'model-31' },
    });
    await click('.maka-executor-selector');
    const maka = [...dom.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Maka',
    );
    assert.ok(maka);
    await act(async () => {
      maka.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
    assert.deepEqual(selected.at(-1), {
      executorId: 'antigravity',
      configuration: { model: 'model-31' },
    });
    await click('.maka-new-chat-model-selector [aria-haspopup="listbox"]');
    assert.ok(dom.document.body.textContent?.includes('My account'));
    assert.ok(dom.document.body.textContent?.includes('Native model description'));
    await choose('Native model 2');
    assert.equal(selected.at(-1), undefined);
    assert.ok(
      dom.document
        .querySelector('.maka-new-chat-model-selector')
        ?.textContent?.includes('Native model'),
    );
  } finally {
    await dom.cleanup();
  }
});

test('history-only state keeps the executor fixed and offers a new task', async () => {
  const dom = installTranscriptDom();
  let newTasks = 0;
  try {
    await dom.render(
      <LocaleProvider locale="zh-TW">
        <ExecutorModelPicker
          catalog={[{ ...catalog[0]!, readiness: 'history_only' }]}
          selection={{ executorId: 'antigravity', configuration: { model: 'model-0' } }}
          fixed
          onSelect={() => assert.fail('History cannot change executor')}
          onSetup={() => {}}
          onRetry={() => {}}
          onNewTask={() => {
            newTasks++;
          }}
        />
      </LocaleProvider>,
    );
    assert.ok(dom.document.body.textContent?.includes('歷史仍可閱讀'));
    const executorTrigger = dom.document.querySelector('.maka-executor-selector');
    assert.notEqual(executorTrigger?.getAttribute('aria-disabled'), 'true');
    const button = [...dom.document.querySelectorAll('button')].find(
      (b) => b.textContent === '建立新任務',
    );
    assert.ok(button);
    await act(() => button.dispatchEvent(new dom.window.Event('click', { bubbles: true })));
    assert.equal(newTasks, 1);
  } finally {
    await dom.cleanup();
  }
});

test('unavailable executors can be inspected but never committed', async () => {
  const dom = installTranscriptDom();
  const selections: unknown[] = [];
  try {
    await dom.render(
      <LocaleProvider locale="en">
        <ExecutorModelPicker
          catalog={[{ ...catalog[0]!, readiness: 'authentication_required' }]}
          nativeLabel="Native model"
          onSelect={(selection) => {
            selections.push(selection);
          }}
          onSetup={() => {}}
          onRetry={() => {}}
          onNewTask={() => {}}
        >
          <span>Native models</span>
        </ExecutorModelPicker>
      </LocaleProvider>,
    );
    const trigger = dom.document.querySelector<HTMLElement>('.maka-executor-selector');
    assert.ok(trigger);
    await act(() => trigger.dispatchEvent(new dom.window.Event('click', { bubbles: true })));
    const entry = [...dom.document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Antigravity'),
    );
    assert.ok(entry);
    await act(() => entry.dispatchEvent(new dom.window.Event('click', { bubbles: true })));
    assert.match(dom.document.body.textContent ?? '', /Sign in from External Agents settings/);
    assert.deepEqual(selections, []);
  } finally {
    await dom.cleanup();
  }
});
