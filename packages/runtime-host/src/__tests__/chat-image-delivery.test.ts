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
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createImageFileReader, ImageFileReadError } from '@maka/runtime/image-file-reader';
import { FilesystemWorkerClientError } from '@maka/runtime/filesystem-worker';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  ChatImageDeliveryService,
  type ChatImageDeliveryPorts,
} from '../server/chat-image-delivery.js';
import { chatImageSources } from '../server/chat-image-markdown.js';
import { checkedChatImage, downloadChatImage } from '../server/chat-image-source.js';
import { IMAGE_DELIVERY_OPERATION_SPECS } from '../protocol/image-delivery.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { createHostExecutionArtifactServices } from '../server/execution-artifacts.js';
import { isImageDeliveryMetadata, isImageDeliverySource } from '@maka/core/image-delivery';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const REQUEST = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  messageId: 'message-1',
  source: '/tmp/image.png',
};
async function fixture(
  limits?: { sessionBytes: number; workspaceBytes: number },
  readLocalImage?: ChatImageDeliveryPorts['readLocalImage'],
  beforeCreate?: (input: Parameters<ChatImageDeliveryPorts['artifacts']['create']>[0]) => void,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-delivery-'));
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner);
  const store = await openInteractiveArtifactStoreForWrite(owner.lease);
  const authority = { store, close: () => store.close() };
  const errors: unknown[] = [];
  let reads = 0;
  let leases = 0;
  const messages = new Map<string, string>();
  let present = true;
  const service = new ChatImageDeliveryService({
    artifacts: {
      create: async (input) => {
        beforeCreate?.(input);
        return authority.store.create(input);
      },
      findImageDelivery: authority.store.findImageDelivery,
      deleteOwnedArtifactInSession: authority.store.deleteOwnedArtifactInSession,
    },
    admission: new SessionAdmissionGate(),
    limits,
    isPresent: async () => present,
    readMessage: async (i) => messages.get(i.messageId),
    readLocalImage: async (sessionId, path, signal) => {
      reads++;
      if (readLocalImage) return readLocalImage(sessionId, path, signal);
      return checkedChatImage(await readFile(path));
    },
    acquireResidency: () => {
      leases++;
      return {
        release: () => {
          leases--;
        },
      };
    },
    persistenceFailed: (error) => errors.push(error),
  });
  return {
    root,
    owner,
    authority,
    service,
    messages,
    errors,
    get reads() {
      return reads;
    },
    get leases() {
      return leases;
    },
    removeSession: () => {
      present = false;
    },
    async close() {
      await service.close();
      authority.close();
      await owner.close();
      await rm(owner.controlDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Host drain releases both capture slots even when a source reader ignores cancellation', {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(undefined, () => new Promise(() => {}));
  try {
    observe(f.service, '/tmp/blocked-1.png');
    observe(f.service, '/tmp/blocked-2.png', 'session-1', 'message-2');
    while (f.reads < 2) await new Promise((resolve) => setImmediate(resolve));
    await t.test(
      'drain stays bounded after both readers have started',
      { timeout: 2000 },
      async () => {
        await f.service.close();
        assert.equal(f.leases, 0);
        assert.deepEqual(f.errors, []);
      },
    );
  } finally {
    await f.close();
  }
});
test('a stalled local source expires within its read budget and can be retried', {
  timeout: 15000,
}, async () => {
  let reads = 0;
  const f = await fixture(undefined, async () => {
    if (++reads === 1) return new Promise(() => {});
    return checkedChatImage(PNG);
  });
  try {
    observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'failed', reason: 'read_failed' });
    assert.equal(f.leases, 0);
    assert.equal((await f.service.resolve({ ...REQUEST, retry: true })).status, 'pending');
    await f.service.waitForIdle();
    assert.equal((await f.service.resolve(REQUEST)).status, 'ready');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
function observe(
  service: ChatImageDeliveryService,
  source: string,
  sessionId = REQUEST.sessionId,
  messageId = REQUEST.messageId,
) {
  service.observe(sessionId, {
    id: 'text-event',
    type: 'text_complete',
    turnId: REQUEST.turnId,
    ts: 1,
    messageId,
    text: `![Screenshot](<${source}>)`,
  });
}
test('parses real Markdown image nodes, including references and balanced destinations, without scanning code or HTML', () => {
  const text = [
    '![one](</tmp/a (1).png>)',
    '![two][pic]',
    '![titled](https://example.com/titled.png "Screenshot title")',
    String.raw`![escaped](/tmp/a\(1\).png)`,
    '',
    '[pic]: https://example.com/a.png',
    '`![code](/tmp/secret.png)`',
    '```md',
    '![fenced](/tmp/secret2.png)',
    '```',
    '<img src="/tmp/html.png">',
    '![incomplete](https://example.com/',
  ].join('\n');
  assert.deepEqual(chatImageSources(text), [
    '/tmp/a (1).png',
    'https://example.com/a.png',
    'https://example.com/titled.png',
    '/tmp/a(1).png',
  ]);
});
test('automatically saves a local delivery without any UI request; deletion and Host restart do not break replay', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'original.png');
    await writeFile(source, PNG);
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.equal(f.reads, 1);
    assert.equal(f.leases, 0);
    assert.deepEqual(f.errors, []);
    await rm(source);
    const input = { ...REQUEST, source };
    const result = await f.service.resolve(input);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    f.authority.close();
    const reopenedStore = await openInteractiveArtifactStoreForWrite(f.owner.lease);
    const reopened = { store: reopenedStore, close: () => reopenedStore.close() };
    try {
      const record = await reopened.store.findImageDelivery(
        input.sessionId,
        input.turnId,
        input.messageId,
        source,
      );
      assert.equal(record?.imageDelivery?.status, 'ready');
      const bytes = await reopened.store.readBinaryInSession(input.sessionId, result.artifactId);
      assert.equal(bytes.ok, true);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
test('encoded local Markdown images are archived under the original source and replay after deletion', async () => {
  const reader = createImageFileReader();
  const f = await fixture(undefined, (_session, path, abortSignal) =>
    reader({ path, cwd: f.root, abortSignal }),
  );
  try {
    const directory = join(f.root, 'My Project');
    await mkdir(directory);
    for (const name of ['screen shot.png', '截图.png', 'literal%20name.png']) {
      const path = join(directory, name);
      const source = `${f.root}/My%20Project/${encodeURIComponent(name)}`;
      await writeFile(path, PNG);
      observe(f.service, source);
      await f.service.waitForIdle();
      await rm(path);
      const result = await f.service.resolve({ ...REQUEST, source });
      assert.equal(result.status, 'ready', source);
      if (result.status !== 'ready') continue;
      const bytes = await f.authority.store.readBinaryInSession(
        REQUEST.sessionId,
        result.artifactId,
      );
      assert.equal(bytes.ok, true);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('encoded project roots are retried through the same workspace boundary', async () => {
  const reader = createImageFileReader();
  const paths: string[] = [];
  const f = await fixture(undefined, (_session, path, abortSignal) => {
    paths.push(path);
    return reader({ path, cwd: join(f.root, 'My Project 中文'), abortSignal });
  });
  try {
    const directory = join(f.root, 'My Project 中文');
    await mkdir(directory);
    const path = join(directory, 'image.png');
    await writeFile(path, PNG);
    const source = `${f.root}/${encodeURIComponent('My Project 中文')}/image.png`;
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.deepEqual(paths, [source, path]);
    await rm(path);
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.equal(paths.length, 2);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('decoding a denied source cannot grant access outside the Read boundary', async () => {
  const reader = createImageFileReader();
  const paths: string[] = [];
  const f = await fixture(undefined, (_session, path, abortSignal) => {
    paths.push(path);
    return reader({ path, cwd: join(f.root, 'workspace'), abortSignal });
  });
  try {
    await mkdir(join(f.root, 'workspace'));
    const path = join(f.root, 'private image.png');
    await writeFile(path, PNG);
    const source = `${f.root}/private%20image.png`;
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
      status: 'failed',
      reason: 'not_allowed',
    });
    assert.deepEqual(paths, [source, path]);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('literal percent filenames retain precedence and file URLs are decoded only once', async () => {
  const paths: string[] = [];
  const reader = createImageFileReader();
  const f = await fixture(undefined, (_session, path, abortSignal) => {
    paths.push(path);
    return reader({ path, cwd: f.root, abortSignal });
  });
  try {
    for (const name of ['literal%20name.png', '100%.png', 'invalid%E4.png']) {
      const path = join(f.root, name);
      await writeFile(path, PNG);
      if (name.includes('%20')) await writeFile(path.replace('%20', ' '), 'wrong source');
      for (const source of [path, pathToFileURL(path).href]) {
        paths.length = 0;
        observe(f.service, source);
        await f.service.waitForIdle();
        assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready', source);
        assert.deepEqual(paths, [path]);
      }
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('encoded local fallback preserves validation and non-path read failures', async () => {
  for (const reason of ['too_large', 'unsupported_mime', 'read_failed'] as const) {
    const paths: string[] = [];
    const f = await fixture(undefined, async (_session, path) => {
      paths.push(path);
      throw new ImageFileReadError(reason);
    });
    try {
      const source = '/tmp/My%20Project/image.png';
      observe(f.service, source);
      await f.service.waitForIdle();
      assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
        status: 'failed',
        reason,
      });
      assert.deepEqual(paths, [source]);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  }
});

test('decoded local images still pass through the Read workspace boundary', async () => {
  const reader = createImageFileReader();
  const paths: string[] = [];
  const f = await fixture(undefined, (_session, path, abortSignal) => {
    paths.push(path);
    return reader({ path, cwd: join(f.root, 'workspace'), abortSignal });
  });
  try {
    await mkdir(join(f.root, 'workspace'));
    await writeFile(join(f.root, 'private image.png'), PNG);
    const source = '%2e%2e/private%20image.png';
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
      status: 'failed',
      reason: 'not_allowed',
    });
    assert.deepEqual(paths, [source, '../private image.png']);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('missing encoded sources never double-decode file URLs or retry invalid escapes', async () => {
  for (const source of [
    'file:///tmp/missing%2520image.png',
    '/tmp/missing%.png',
    '/tmp/missing%E4.png',
    '/tmp/missing%00.png',
  ]) {
    const paths: string[] = [];
    const f = await fixture(undefined, async (_session, path) => {
      paths.push(path);
      throw new ImageFileReadError('not_found');
    });
    try {
      observe(f.service, source);
      await f.service.waitForIdle();
      assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
        status: 'failed',
        reason: 'not_found',
      });
      assert.equal(paths.length, 1, source);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  }
});

test('remote delivery is downloaded once, remains replayable after the origin server disappears, and sends no credentials/referrer', async () => {
  const f = await fixture();
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.referer, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'image/png');
    res.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/image.png`;
  try {
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.deepEqual(f.errors, []);
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.equal(requests, 1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.equal(requests, 1);
  } finally {
    server.close();
    await f.close();
  }
});
test('a supplied path is never a read grant; sources inside code cannot trigger archival', async () => {
  const f = await fixture();
  try {
    f.messages.set(REQUEST.messageId, '`![secret](/tmp/image.png)`');
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'unavailable' });
    f.messages.set(REQUEST.messageId, 'plain text');
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'unavailable' });
    assert.equal(f.reads, 0);
  } finally {
    await f.close();
  }
});
test('transient failure is persisted and is retried only on an explicit request', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'later.png');
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
      status: 'failed',
      reason: 'not_found',
    });
    await writeFile(source, PNG);
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'failed');
    assert.equal(f.reads, 1);
    assert.equal((await f.service.resolve({ ...REQUEST, source, retry: true })).status, 'pending');
    await f.service.waitForIdle();
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.equal(f.reads, 2);
  } finally {
    await f.close();
  }
});

test('truncated HTTP images are rejected, and an explicit retry archives the repaired source', async () => {
  const f = await fixture();
  let content = PNG.subarray(0, 8);
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader('Content-Type', 'image/png');
    res.end(content);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/image.png`;
  const identity = { ...REQUEST, source };
  try {
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve(identity), {
      status: 'failed',
      reason: 'unsupported_mime',
    });
    assert.equal(requests, 1);
    const failed = await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 });
    assert.equal(failed.total, 1);
    assert.equal(failed.records[0]?.imageDelivery?.status, 'failed');
    content = PNG;
    assert.equal((await f.service.resolve({ ...identity, retry: true })).status, 'pending');
    await f.service.waitForIdle();
    const ready = await f.service.resolve(identity);
    assert.equal(ready.status, 'ready');
    assert.equal(requests, 2);
    if (ready.status === 'ready') {
      const bytes = await f.authority.store.readBinaryInSession(
        identity.sessionId,
        ready.artifactId,
      );
      assert.ok(bytes.ok);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    }
    assert.equal(
      (await f.authority.store.listPage(identity.sessionId, { offset: 0, limit: 10 })).total,
      1,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('explicit decode retries replace a legacy ready image and share concurrent capture', async () => {
  const f = await fixture();
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer((_req, res) => {
    requests++;
    void gate.then(() => {
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/image.png`;
  const identity = { ...REQUEST, source };
  try {
    const broken = PNG.subarray(0, 8);
    await f.authority.store.create({
      id: 'legacy-image',
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      kind: 'image',
      name: 'chat-image',
      source: 'tool_result_projection',
      content: broken,
      mimeType: 'image/png',
      imageDelivery: {
        messageId: identity.messageId,
        source,
        status: 'ready',
        contentSha256: createHash('sha256').update(broken).digest('hex'),
      },
    });
    assert.deepEqual(await f.service.resolve(identity), {
      status: 'ready',
      artifactId: 'legacy-image',
    });
    assert.equal(requests, 0);
    const retries = await Promise.all([
      f.service.resolve({ ...identity, retry: true }),
      f.service.resolve({ ...identity, retry: true }),
    ]);
    assert.deepEqual(retries, [{ status: 'pending' }, { status: 'pending' }]);
    release();
    await f.service.waitForIdle();
    const ready = await f.service.resolve(identity);
    assert.equal(ready.status, 'ready');
    assert.equal(requests, 1);
    const page = await f.authority.store.listPage(identity.sessionId, { offset: 0, limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.records[0]?.sizeBytes, PNG.length);
    assert.deepEqual(f.errors, []);
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('Worker read errors retain their image delivery reasons in persisted failures', async () => {
  for (const [reason, expected] of [
    ['not_found', 'not_found'],
    ['filesystem_denied', 'not_allowed'],
    ['image_too_large', 'too_large'],
    ['invalid_image', 'unsupported_mime'],
  ] as const) {
    const reader = createImageFileReader({
      filesystemWorker: {
        execute: async () => {
          throw new FilesystemWorkerClientError({
            reason,
            stage: 'operation',
            message: '读取失败',
          });
        },
      },
    });
    const f = await fixture(undefined, (_session, path, abortSignal) =>
      reader({ path, cwd: process.cwd(), abortSignal }),
    );
    try {
      observe(f.service, REQUEST.source);
      await f.service.waitForIdle();
      assert.deepEqual(await f.service.resolve(REQUEST), { status: 'failed', reason: expected });
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  }
});

test('pending capture survives persistence failure and is removed only after a durable terminal record', async () => {
  let failPublication = true;
  const f = await fixture(
    undefined,
    async () => checkedChatImage(PNG),
    (input) => {
      if (failPublication && input.imageDelivery?.status === 'ready')
        throw new Error('publication failed');
    },
  );
  try {
    observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    const pending = await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 });
    assert.equal(pending.total, 1);
    assert.equal(pending.records[0]?.imageDelivery?.status, 'pending');
    assert.equal(f.errors.length, 1);
    failPublication = false;
    assert.equal((await f.service.resolve(REQUEST)).status, 'pending');
    await f.service.waitForIdle();
    const ready = await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 });
    assert.equal(ready.total, 1);
    assert.equal(ready.records[0]?.imageDelivery?.status, 'ready');
    assert.equal(f.errors.length, 1);
  } finally {
    await f.close();
  }
});

test('a conversation copied during capture resumes and cleans its copied pending record', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(undefined, async () => {
    await gate;
    return checkedChatImage(PNG);
  });
  try {
    observe(f.service, REQUEST.source);
    while (!f.reads) await new Promise<void>((resolve) => setImmediate(resolve));
    await f.authority.store.copyConversationArtifacts({
      sourceSessionId: REQUEST.sessionId,
      targetSessionId: 'session-copy',
      turnIds: [REQUEST.turnId],
    });
    const copied = { ...REQUEST, sessionId: 'session-copy' };
    assert.equal((await f.service.resolve(copied)).status, 'pending');
    release();
    await f.service.waitForIdle();
    for (const sessionId of [REQUEST.sessionId, copied.sessionId]) {
      const page = await f.authority.store.listPage(sessionId, { offset: 0, limit: 10 });
      assert.equal(page.total, 1);
      assert.equal(page.records[0]?.imageDelivery?.status, 'ready');
      const bytes = await f.authority.store.readBinaryInSession(sessionId, page.records[0]!.id);
      assert.ok(bytes.ok);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    }
    assert.deepEqual(f.errors, []);
  } finally {
    release();
    await f.close();
  }
});
test('quota admission is atomic under concurrent jobs and identical content shares bytes across sessions', async () => {
  const f = await fixture({ sessionBytes: PNG.length, workspaceBytes: PNG.length });
  try {
    const source = join(f.root, 'same.png');
    await writeFile(source, PNG);
    observe(f.service, source);
    observe(f.service, source, 'session-2');
    await f.service.waitForIdle();
    const a = await f.service.resolve({ ...REQUEST, source });
    const b = await f.service.resolve({ ...REQUEST, sessionId: 'session-2', source });
    assert.equal(a.status, 'ready');
    assert.equal(b.status, 'ready');
    if (a.status !== 'ready' || b.status !== 'ready') return;
    const ra = (await f.authority.store.getInSession('session-1', a.artifactId)).record!;
    const rb = (await f.authority.store.getInSession('session-2', b.artifactId)).record!;
    assert.equal(
      (await stat(join(f.root, 'artifacts', ra.relativePath))).ino,
      (await stat(join(f.root, 'artifacts', rb.relativePath))).ino,
    );
    const different = join(f.root, 'different.png');
    await writeFile(different, Buffer.concat([PNG, Buffer.from('different')]));
    observe(f.service, different, 'session-1', 'message-2');
    await f.service.waitForIdle();
    assert.deepEqual(
      await f.service.resolve({ ...REQUEST, source: different, messageId: 'message-2' }),
      { status: 'failed', reason: 'quota_exceeded' },
    );
    await f.authority.store.purgeSessionArtifacts('session-1');
    assert.equal((await f.authority.store.readBinaryInSession('session-2', b.artifactId)).ok, true);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
test('copying a conversation carries delivery provenance and saved bytes; it does not read the original source', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'original.png');
    await writeFile(source, PNG);
    observe(f.service, source);
    await f.service.waitForIdle();
    await rm(source);
    await f.authority.store.copyConversationArtifacts({
      sourceSessionId: 'session-1',
      targetSessionId: 'session-copy',
      turnIds: ['turn-1'],
    });
    const original = await f.service.resolve({ ...REQUEST, source });
    const copied = await f.service.resolve({ ...REQUEST, sessionId: 'session-copy', source });
    assert.equal(copied.status, 'ready');
    if (copied.status === 'ready' && original.status === 'ready') {
      const sourceRecord = (await f.authority.store.getInSession('session-1', original.artifactId))
        .record!;
      const targetRecord = (await f.authority.store.getInSession('session-copy', copied.artifactId))
        .record!;
      assert.equal(
        (await stat(join(f.root, 'artifacts', sourceRecord.relativePath))).ino,
        (await stat(join(f.root, 'artifacts', targetRecord.relativePath))).ino,
      );
      await f.authority.store.purgeSessionArtifacts('session-1');
      assert.equal(
        (await f.authority.store.readBinaryInSession('session-copy', copied.artifactId)).ok,
        true,
      );
    }
    assert.equal(f.reads, 1);
  } finally {
    await f.close();
  }
});
test('source readers reject oversized payloads, unsafe MIME and redirects to private networks', async () => {
  assert.throws(() => checkedChatImage(Buffer.alloc(2 * 1024 * 1024 + 1)), /too_large/);
  assert.throws(() => checkedChatImage(Buffer.from('<svg/>')), /unsupported_mime/);
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const source = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/redirect`;
    await assert.rejects(downloadChatImage(source, AbortSignal.timeout(2000)), /not_allowed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('resolver codec rejects excess fields and noncanonical artifact identities', () => {
  const spec = IMAGE_DELIVERY_OPERATION_SPECS['artifact.image.resolve'];
  assert.deepEqual(spec.decodeInput(REQUEST), REQUEST);
  assert.throws(() => spec.decodeInput({ ...REQUEST, arbitraryRead: true }));
  assert.throws(() => spec.decodeOutput({ status: 'ready', artifactId: '../private' }));
});

test('completed turns release unfinished stream slots without archiving partial messages', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 40; i++) {
      f.service.observe('session-1', {
        type: 'text_delta',
        id: `delta-${i}`,
        turnId: `turn-${i}`,
        ts: 1,
        messageId: `partial-${i}`,
        text: '![partial](/tmp/missing.png)',
      });
      f.service.observe('session-1', {
        type: 'complete',
        id: `complete-${i}`,
        turnId: `turn-${i}`,
        ts: 2,
        stopReason: 'end_turn',
      });
    }
    const source = join(f.root, 'final.png');
    await writeFile(source, PNG);
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.equal(f.reads, 1);
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
  } finally {
    await f.close();
  }
});

test('capture, wire and stored metadata share source limits while retaining boundary policies', () => {
  const decode = IMAGE_DELIVERY_OPERATION_SPECS['artifact.image.resolve'].decodeInput;
  const source = '/' + 'a'.repeat(4095);
  assert.deepEqual(chatImageSources(`![x](<${source}>)`), [source]);
  assert.equal(decode({ ...REQUEST, source, messageId: 'm'.repeat(512) }).source, source);
  assert.throws(() => decode({ ...REQUEST, messageId: 'm'.repeat(513) }));
  for (const source of ['', '/' + 'a'.repeat(4096), '/tmp/a\x01.png', '/tmp/a\x7f.png']) {
    assert.equal(isImageDeliverySource(source), false);
    assert.equal(isImageDeliveryMetadata({ messageId: 'm', source, status: 'pending' }), false);
    assert.throws(() => decode({ ...REQUEST, source }));
    assert.deepEqual(chatImageSources(`![x](<${source}>)`), []);
  }
  // Explicit attachment refs belong to UI resolution, not automatic source capture.
  assert.deepEqual(chatImageSources('![x](maka://runtime/attachments/image-1)'), []);
  assert.equal(
    isImageDeliveryMetadata({ messageId: 'm\x01', source: REQUEST.source, status: 'pending' }),
    true,
  );
  assert.throws(() => decode({ ...REQUEST, messageId: 'm\x01' }));
  assert.equal(
    chatImageSources(Array.from({ length: 70 }, (_, i) => `![x](/tmp/${i}.png)`).join('\n')).length,
    64,
  );
});

test('local and downloaded invalid image bytes retain identical failure reasons', async () => {
  const f = await fixture();
  try {
    for (const [bytes, reason] of [
      [PNG.subarray(0, 8), 'unsupported_mime'],
      [new Uint8Array(2 * 1024 * 1024 + 1), 'too_large'],
    ] as const) {
      assert.throws(
        () => checkedChatImage(bytes),
        (error: unknown) => error instanceof Error && 'reason' in error && error.reason === reason,
      );
      const source = join(f.root, 'invalid.png');
      await writeFile(source, bytes);
      await assert.rejects(
        createImageFileReader()({ path: source, cwd: f.root }),
        (error: unknown) => error instanceof Error && 'reason' in error && error.reason === reason,
      );
    }
  } finally {
    await f.close();
  }
});

test('automatic capture and PublishImage share content quota without merging their identities', async () => {
  const limits = { sessionBytes: PNG.length, workspaceBytes: PNG.length };
  const f = await fixture(limits, async () => checkedChatImage(PNG));
  try {
    observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    const automatic = await f.service.resolve(REQUEST);
    assert.equal(automatic.status, 'ready');
    if (automatic.status !== 'ready') return;
    const services = createHostExecutionArtifactServices({
      artifacts: f.authority.store,
      sessionAdmission: new SessionAdmissionGate(),
      sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
      imageArchiveLimits: limits,
      requestDrain: () => assert.fail('shared bytes must not exceed quota or drain'),
    });
    const explicit = await services.publishImage({
      sessionId: REQUEST.sessionId,
      turnId: REQUEST.turnId,
      toolCallId: 'publish-call',
      name: 'published.png',
      bytes: PNG,
      mimeType: 'image/png',
    });
    assert.notEqual(explicit.relativePath, automatic.artifactId);
    const captured = (await f.authority.store.getInSession(REQUEST.sessionId, automatic.artifactId))
      .record!;
    const published = (
      await f.authority.store.getInSession(REQUEST.sessionId, explicit.relativePath)
    ).record!;
    assert.equal(captured.imageDelivery?.contentSha256, published.imageDelivery?.contentSha256);
    assert.equal(captured.imageDelivery?.source, REQUEST.source);
    assert.equal(published.imageDelivery?.source, 'published:publish-call');
    assert.equal(published.imageDelivery?.messageId, 'publish-call');
    assert.equal(published.summary, 'Published chat image');
    assert.equal(
      (await stat(join(f.root, 'artifacts', captured.relativePath))).ino,
      (await stat(join(f.root, 'artifacts', published.relativePath))).ino,
    );
    const page = await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 });
    assert.equal(page.total, 2);
    assert.ok(page.records.every((record) => record.imageDelivery?.status === 'ready'));
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
