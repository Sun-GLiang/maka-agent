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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const UI_SRC = resolve(import.meta.dirname, '..', '..', 'src');

test('message timestamps reserve layout and reveal only on message intent', async () => {
  const css = (await readFile(resolve(UI_SRC, 'styles.css'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const resting = /\.maka-message-time-presentation\s*\{([^}]*)\}/.exec(css);
  assert.ok(resting, 'the timestamp presentation rule is missing');
  assert.match(resting[1], /display\s*:\s*inline-flex/);
  assert.match(resting[1], /opacity\s*:\s*0/);
  assert.doesNotMatch(resting[1], /display\s*:\s*none|visibility\s*:\s*hidden/);

  const reveal = new RegExp(
    String.raw`\.maka-user-message:hover\s+\.maka-message-time-presentation\s*,\s*` +
      String.raw`\.maka-user-message:focus-within\s+\.maka-message-time-presentation\s*\{([^}]*)\}`,
  ).exec(css);
  assert.ok(reveal, 'hover and focus-within must share the timestamp reveal rule');
  assert.match(reveal[1], /opacity\s*:\s*1/);
});
