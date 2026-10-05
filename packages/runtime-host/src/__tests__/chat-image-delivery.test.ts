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
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
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
    artifacts: authority.store,
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
  timeout: 2000,
}, async () => {
  const f = await fixture(undefined, () => new Promise(() => {}));
  try {
    observe(f.service, '/tmp/blocked-1.png');
    observe(f.service, '/tmp/blocked-2.png', 'session-1', 'message-2');
    while (f.reads < 2) await new Promise((resolve) => setImmediate(resolve));
    await f.service.close();
    assert.equal(f.leases, 0);
    assert.deepEqual(f.errors, []);
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
    '',
    '[pic]: https://example.com/a.png',
    '`![code](/tmp/secret.png)`',
    '```md',
    '![fenced](/tmp/secret2.png)',
    '```',
    '<img src="/tmp/html.png">',
    '![incomplete](https://example.com/',
  ].join('\n');
  assert.deepEqual(chatImageSources(text), ['/tmp/a (1).png', 'https://example.com/a.png']);
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
