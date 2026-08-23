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
import { Readable, Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { runMakaAcpStdioServer } from '../acp/stdio-server.js';

describe('Maka ACP stdio server', () => {
  test('closes the Runtime Host context once after normal EOF', async () => {
    const harness = createHarness([]);

    assert.equal(await harness.run(), 0);
    assert.equal(harness.closeCalls(), 1);
  });

  test('closes the Runtime Host context once after a protocol error', async () => {
    const harness = createHarness(['not json\n']);

    assert.equal(await harness.run(), 0);
    assert.equal(harness.closeCalls(), 1);
  });
});

function createHarness(chunks: string[]) {
  let closes = 0;
  const stdin = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return {
    run: () =>
      runMakaAcpStdioServer(
        { workspaceRoot: '/workspace', clientDataRoot: '/client-data', version: '0.2.0' },
        {
          stdin,
          stdout,
          connectRuntimeHostCli: async () =>
            ({
              close: async () => {
                closes += 1;
              },
            }) as Awaited<
              ReturnType<typeof import('../runtime-host-cli-context.js').connectRuntimeHostCli>
            >,
        },
      ),
    closeCalls: () => closes,
  };
}
