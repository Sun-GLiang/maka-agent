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
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import acpPackage, { AcpExecutor } from '@maka/acp-executor-plugin';
import { AdmissionLimiter } from '@maka/runtime/admission-limiter';
import { MakaCompositionLoader } from '@maka/runtime/plugin-composition-loader';
import { PluginStorageService } from '@maka/runtime/plugin-data-services';
import { PluginExecutorService } from '@maka/runtime/plugin-executor-service';
import { Context } from '@maka/runtime/plugin-kernel';
import { HostPluginDataRuntime } from '../server/plugin-data-runtime.js';
import { HostPluginPlatform } from '../server/plugin-platform.js';
import { withPluginScratchDirectory } from '../server/plugin-scratch-directory.js';

test('removed ACP plugins retain failed cleanup through repeated Platform shutdown', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-acp-unload-'));
  const evidence = join(directory, 'agent.json');
  const script = join(directory, 'agent.cjs');
  await writeFile(
    script,
    `
const fs = require('node:fs');
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
// Remain alive after failed termination closes stdio, as a detached helper could.
setInterval(() => {}, 1000);
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send(message.id, {protocolVersion: 1});
  if (message.method === 'session/new') {
    fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({pid: process.pid, cwd: message.params.cwd}));
    send(message.id, {sessionId: 'fixture', configOptions: []});
  }
});
`,
  );
  const root = new Context();
  const executors = new PluginExecutorService(root);
  const storage = new PluginStorageService(root);
  storage.bindRuntime(new HostPluginDataRuntime(directory));
  const loader = new MakaCompositionLoader({ root });
  const platform = new HostPluginPlatform(directory, { composition: loader });
  const providers = new Set<AcpExecutor>();
  const dispose = AcpExecutor.prototype.dispose;
  t.mock.method(AcpExecutor.prototype, 'dispose', function (this: AcpExecutor) {
    providers.add(this);
    return dispose.call(this);
  });
  let admission: AdmissionLimiter | undefined;
  const acquire = AdmissionLimiter.prototype.acquire;
  t.mock.method(
    AdmissionLimiter.prototype,
    'acquire',
    function (this: AdmissionLimiter, signal: AbortSignal) {
      admission = this;
      return acquire.call(this, signal);
    },
  );
  let blockTermination = true;
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: number | NodeJS.Signals) => {
    if (blockTermination && pid < 0 && signal !== 0) {
      const agent = JSON.parse(readFileSync(evidence, 'utf8')) as { pid: number };
      if (pid === -agent.pid) return true;
    }
    return kill(pid, signal);
  });
  t.mock.method(console, 'warn', () => undefined);
  try {
    await loader.install(acpPackage);
    await loader.install({
      packageId: 'cleanup-adapter',
      host: (ctx: Context) =>
        ctx.acp.register(
          ctx,
          {
            id: 'cleanup-agent',
            displayName: 'Cleanup agent',
            configure: () => ({ launch: { executable: process.execPath, args: [script] } }),
          },
          {},
        ),
    });
    await loader.create('profile', {
      id: 'acp-runtime',
      packageId: 'acp-executor',
      children: [{ id: 'adapter', packageId: 'cleanup-adapter' }],
    });
    const [entry] = await executors.catalog({ cwd: directory });
    assert.equal(entry?.readiness, 'unavailable');
    const agent = JSON.parse(await readFile(evidence, 'utf8')) as { pid: number; cwd: string };
    assert.equal(admission?.activeCount, 1);

    await loader.remove('adapter');
    assert.deepEqual(executors.list('session-a'), []);
    assert.equal(root.kernelFibers().length, 3, 'removed adapter must remain owned for cleanup');
    assert.equal(admission?.activeCount, 1);
    kill(agent.pid, 0);
    await assert.rejects(
      withPluginScratchDirectory(dirname(agent.cwd), AbortSignal.timeout(100), async () =>
        assert.fail('lease is still owned'),
      ),
      { name: 'AbortError' },
    );

    const closing = platform.close();
    assert.equal(platform.close(), closing, 'concurrent callers share the failed attempt');
    await assert.rejects(closing, /Unable to close every Plugin Platform resource/u);
    assert.equal(admission?.activeCount, 1);
    kill(agent.pid, 0);
    blockTermination = false;
    const retry = platform.close();
    assert.notEqual(retry, closing);
    assert.equal(platform.close(), retry);
    await retry;
    await platform.close();
    assert.equal(admission?.activeCount, 0);
    assert.equal(root.kernelFibers().length, 0);
    assert.throws(() => kill(-agent.pid, 0), { code: 'ESRCH' });
    await withPluginScratchDirectory(
      dirname(agent.cwd),
      AbortSignal.timeout(1_000),
      async () => {},
    );
  } finally {
    blockTermination = false;
    // Even an ablation against the old kernel must not leave a real process or lease behind.
    await Promise.all([...providers].map((provider) => dispose.call(provider)));
    await loader.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
