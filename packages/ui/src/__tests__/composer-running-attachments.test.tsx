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
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

test('accepts a pasted image while the current turn is running', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  window.getSelection = () => null;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const attached: File[][] = [];

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          streaming
          onAttachFilePaths={(files) => {
            attached.push(files);
          }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));

    const form = container.querySelector('form');
    assert.equal(form?.getAttribute('data-maka-file-drop-target'), 'true');
    const input = container.querySelector<HTMLElement>('[role="textbox"]');
    assert.ok(input);
    const image = new window.File(['image'], 'screenshot.png', { type: 'image/png' });
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [image],
        getData: () => '',
      },
    });

    await act(async () => {
      input.dispatchEvent(paste);
      await Promise.resolve();
    });

    assert.equal(paste.defaultPrevented, true);
    assert.deepEqual(attached, [[image]]);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
