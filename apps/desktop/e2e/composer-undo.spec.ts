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

import type { Locator } from '@playwright/test';
import { expect, test, COMPOSER_INPUT } from './fixtures';

const TYPED = 'x';
const PASTED = '中文 <tag>& "quoted"\r\nhttps://example.test/path?x=1&y=2\n第二行 <>&';
const PASTED_AS_PLAIN_TEXT = PASTED.replace(/\r\n/g, '\n');
const UNDO_SHORTCUT = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

async function expectComposerText(
  composer: Locator,
  expected: string,
): Promise<void> {
  await expect
    .poll(() => composer.evaluate((element) => element.innerText.replace(/\r\n/g, '\n')))
    .toBe(expected);
}

test('plain-text paste is undone separately from prior typing', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);

  await composer.click();
  await page.keyboard.type(TYPED);
  await expectComposerText(composer, TYPED);

  await composer.evaluate((element, pasted) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', pasted);
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  }, PASTED);
  await expectComposerText(composer, `${TYPED}${PASTED_AS_PLAIN_TEXT}`);

  await page.keyboard.press(UNDO_SHORTCUT);
  await expectComposerText(composer, TYPED);

  await page.keyboard.press(UNDO_SHORTCUT);
  await expectComposerText(composer, '');

  await page.keyboard.press(UNDO_SHORTCUT);
  await expectComposerText(composer, '');
});
