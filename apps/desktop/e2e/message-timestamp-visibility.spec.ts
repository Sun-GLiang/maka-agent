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

import { COMPOSER_INPUT, expect, test } from './fixtures';

const PROMPT = 'timestamp hover probe';

function messageBox(page: import('@playwright/test').Page) {
  return page.locator('.maka-user-message', { hasText: PROMPT }).last();
}

async function roundedBox(locator: import('@playwright/test').Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  });
}

test('reveals a same-day timestamp on hover and focus without moving the message', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(PROMPT);
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: timestamp hover probe/)).toBeVisible();

  const message = messageBox(page);
  const timestamp = message.locator('.maka-message-time-presentation');
  const visual = timestamp.locator('.maka-message-time-visual');
  await expect(timestamp).toHaveCSS('opacity', '0');
  await expect(visual).not.toContainText(/[年月日]|\b20\d{2}\b/);
  const before = await roundedBox(message);

  await message.hover();
  await expect(timestamp).toHaveCSS('opacity', '1');
  expect(await roundedBox(message)).toEqual(before);

  await composer.hover();
  await expect(timestamp).toHaveCSS('opacity', '0');

  const copyButton = message.getByRole('button', {
    name: new RegExp(`复制消息：${PROMPT}`),
  });
  await copyButton.focus();
  await expect(timestamp).toHaveCSS('opacity', '1');
  expect(await roundedBox(message)).toEqual(before);
});
