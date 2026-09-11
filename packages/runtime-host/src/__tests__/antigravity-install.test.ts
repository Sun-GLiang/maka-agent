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
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installAntigravity } from '../server/acp/antigravity-install.js';
import { AcpSetupError } from '../server/acp/connection.js';
import { ANTIGRAVITY_ACP_RELEASE } from '../protocol/external-agent-setup.js';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(
  run: (input: {
    root: string;
    zip: Buffer;
    evidence: Parameters<typeof installAntigravity>[1];
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-install-test-'));
  try {
    await writeFile(join(root, 'agy_acp_server.par'), 'test server');
    await writeFile(join(root, 'localharness_external'), 'test helper');
    execFileSync(
      '/usr/bin/zip',
      ['-q', 'agent.zip', 'agy_acp_server.par', 'localharness_external'],
      { cwd: root },
    );
    const zip = await readFile(join(root, 'agent.zip'));
    await run({
      root,
      zip,
      evidence: {
        archiveBytes: zip.length,
        sha256: sha(zip),
        serverSha256: sha('test server'),
        helperSha256: sha('test helper'),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const supported = { skip: process.platform !== 'darwin' };
test(
  'installs a verified archive atomically and reuses both verified executables',
  supported,
  async () =>
    fixture(async ({ root, zip, evidence }) => {
      let requests = 0;
      const phases: string[] = [];
      const input = {
        directory: join(root, 'managed'),
        signal: new AbortController().signal,
        fetch: (async (url, init) => {
          requests++;
          assert.equal(url, ANTIGRAVITY_ACP_RELEASE.url);
          assert.equal(init?.redirect, 'error');
          return new Response(new Uint8Array(zip));
        }) as typeof fetch,
        onProgress: (phase: string) => phases.push(phase),
      };
      const executable = await installAntigravity(input, evidence);
      assert.equal(await readFile(executable, 'utf8'), 'test server');
      assert.equal((await stat(executable)).mode & 0o777, 0o700);
      assert.equal(await installAntigravity(input, evidence), executable);
      assert.equal(requests, 1);
      assert.ok(phases.includes('installing'));
      assert.deepEqual(await readdir(input.directory), ['1.1.1']);
      await writeFile(executable, 'tampered');
      await assert.rejects(
        installAntigravity(input, evidence),
        (e: unknown) => e instanceof AcpSetupError && e.failure === 'integrity_failed',
      );
      assert.equal(requests, 1, 'never silently replace a mismatched existing installation');
    }),
);
test(
  'rejects truncated, oversized, and hash-mismatched downloads before extraction',
  supported,
  async () =>
    fixture(async ({ root, zip, evidence }) => {
      for (const body of [
        zip.subarray(0, 10),
        Buffer.concat([zip, Buffer.from('extra')]),
        Buffer.alloc(zip.length),
      ]) {
        const directory = join(root, 'bad');
        await assert.rejects(
          installAntigravity(
            {
              directory,
              signal: new AbortController().signal,
              fetch: (async () => new Response(new Uint8Array(body))) as typeof fetch,
              onProgress() {},
            },
            evidence,
          ),
          (e: unknown) => e instanceof AcpSetupError && e.failure === 'integrity_failed',
        );
        assert.deepEqual(await readdir(directory), []);
      }
    }),
);
test(
  'cancels a stalled download and removes its staging directory before settling',
  supported,
  async () =>
    fixture(async ({ root, zip, evidence }) => {
      const abort = new AbortController();
      const directory = join(root, 'cancel');
      await assert.rejects(
        installAntigravity(
          {
            directory,
            signal: abort.signal,
            fetch: (async () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(zip.subarray(0, 10)));
                  },
                }),
              )) as typeof fetch,
            onProgress(_phase, percent) {
              if (percent > 0) abort.abort();
            },
          },
          evidence,
        ),
      );
      assert.deepEqual(await readdir(directory), []);
    }),
);
test('rejects modified extracted members even when the archive hash matches', supported, async () =>
  fixture(async ({ root, zip, evidence }) => {
    const directory = join(root, 'members');
    await assert.rejects(
      installAntigravity(
        {
          directory,
          signal: new AbortController().signal,
          fetch: (async () => new Response(new Uint8Array(zip))) as typeof fetch,
          onProgress() {},
        },
        { ...evidence!, serverSha256: sha('different') },
      ),
      (e: unknown) => e instanceof AcpSetupError && e.failure === 'integrity_failed',
    );
    assert.deepEqual(await readdir(directory), []);
  }),
);
