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

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IPage } from '@jackwener/opencli/types';
import { browserObservationPage } from '../browser/browser-observation-world.js';

test('structured observations never fall back to an unisolated page evaluator', async () => {
  let evaluated = false;
  const page = { evaluate: async () => { evaluated = true; } } as unknown as IPage;
  await assert.rejects(browserObservationPage(page), /isolated CDP execution context/);
  assert.equal(evaluated, false);
});

test('a missing isolated context cannot result in default-world Runtime.evaluate', async () => {
  for (const executionContextId of [undefined, 0, -1, NaN]) {
    const page = {
      cdp: async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId };
        assert.fail(`Unexpected evaluation without an isolated context: ${method}`);
      },
      evaluate: async () => { assert.fail('The page evaluator must never be used'); },
    } as unknown as IPage;
    await assert.rejects(browserObservationPage(page), /did not provide an isolated execution context/);
  }
});
