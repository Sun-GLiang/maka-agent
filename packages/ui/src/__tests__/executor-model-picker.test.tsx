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
import { act } from 'react';
import { ExecutorModelPicker, type ExecutorModelPickerProps } from '../executor-model-picker.js';
import { LocaleProvider } from '../locale-context.js';
import { installTranscriptDom } from './transcript-test-dom.js';

const catalog: ExecutorModelPickerProps['catalog'] = [
  {
    id: 'external',
    displayName: 'External',
    readiness: 'ready',
    models: [{ id: 'model-1', name: 'Provider model' }],
    currentModel: 'model-1',
    supportsAttachments: false,
    supportsModelChange: true,
  },
];
const choices: ExecutorModelPickerProps['choices'] = [
  {
    connectionId: 'native',
    connectionSlug: 'native',
    connectionName: 'My account',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'native-model',
    label: 'Native model',
    isDefault: true,
    thinkingLevels: [],
  },
];

test('browsing executors does not commit a choice; choosing a model commits its original identity', async () => {
  const dom = installTranscriptDom();
  const selected: unknown[] = [],
    native: unknown[] = [];
  const props: ExecutorModelPickerProps = {
    catalog,
    choices,
    nativeLabel: 'Native model',
    onSelect: (value) => selected.push(value),
    onNative: (value) => {
      native.push(value);
    },
    onSetup() {},
    onRetry() {},
    onNewTask() {},
  };
  const click = async (label: string) => {
    const button = [...dom.document.querySelectorAll('button')].find(
      (b) => b.textContent === label,
    );
    assert.ok(button, `Missing ${label}`);
    await act(() => {
      button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
  };
  try {
    await dom.render(
      <LocaleProvider locale="en">
        <ExecutorModelPicker {...props} />
      </LocaleProvider>,
    );
    await click('Native model');
    await click('External');
    assert.deepEqual(selected, []);
    await click('Provider model');
    assert.deepEqual(selected, [{ executorId: 'external', configuration: { model: 'model-1' } }]);
    assert.deepEqual(native, []);
    await dom.render(
      <LocaleProvider locale="en">
        <ExecutorModelPicker
          {...props}
          selection={{ executorId: 'external', configuration: { model: 'model-1' } }}
        />
      </LocaleProvider>,
    );
    await click('External · Provider model');
    await click('Maka');
    assert.ok(dom.document.body.textContent?.includes('My account'));
    await click('Native model');
    assert.deepEqual(native, [
      { llmConnectionId: 'native', llmConnectionSlug: 'native', model: 'native-model' },
    ]);
    assert.equal(selected.at(-1), undefined);
  } finally {
    await dom.cleanup();
  }
});

test('history-only state offers a new task without permitting executor replacement', async () => {
  const dom = installTranscriptDom();
  let newTasks = 0;
  try {
    await dom.render(
      <LocaleProvider locale="zh-TW">
        <ExecutorModelPicker
          catalog={[{ ...catalog[0]!, readiness: 'history_only' }]}
          choices={choices}
          nativeLabel="Native model"
          selection={{ executorId: 'external', configuration: { model: 'model-1' } }}
          fixed
          onSelect={() => assert.fail('History cannot change executor')}
          onNative={() => assert.fail('History cannot switch to Maka')}
          onSetup={() => {}}
          onRetry={() => {}}
          onNewTask={() => {
            newTasks++;
          }}
        />
      </LocaleProvider>,
    );
    assert.ok(dom.document.body.textContent?.includes('歷史仍可閱讀'));
    const button = [...dom.document.querySelectorAll('button')].find(
      (b) => b.textContent === '建立新任務',
    );
    assert.ok(button);
    await act(() => {
      button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
    assert.equal(newTasks, 1);
  } finally {
    await dom.cleanup();
  }
});
