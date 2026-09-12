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
import { decodeCanonicalToolResultContent } from '../tool-result-record-schema.js';

test('external tool result decoder preserves ordered mixed snapshots', () => {
  const content = {
    kind: 'external_tool',
    parts: [
      { kind: 'text', text: 'running' },
      { kind: 'file_diff', paths: ['a.ts'], diff: '--- a/a.ts\n+++ b/a.ts' },
      { kind: 'terminal', terminalId: 'terminal-1' },
    ],
  };
  assert.deepEqual(decodeCanonicalToolResultContent(content), content);
  assert.throws(() =>
    decodeCanonicalToolResultContent({ ...content, parts: [...content.parts, { kind: 'other' }] }),
  );
});
