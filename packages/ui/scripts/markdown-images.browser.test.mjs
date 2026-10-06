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

// Chromium owns image requests and CSP enforcement; fake DOM tests cannot
// detect an allowed Markdown URL that the desktop policy blocks.
// Run after building @maka/ui: node --test packages/ui/scripts/markdown-images.browser.test.mjs
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const badge = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFAAAAAUCAYAAAAa2LrXAAAATklEQVR4nO3OsQ0AIAzAsJ7O5/QIhsgSg3fPnLnfgzygywO6PKDLA7o8oMsDujygywO6PKDLA7o8oMsDujygywO6PKDLA7o8oMsDujyAW5KWWkgoVkkSAAAAAElFTkSuQmCC', 'base64');
let appServer, imageServer, browser, appUrl, imageUrl;
let requests = [], failedOnce = false;
let releaseImage;
let releaseAttachment;
const delayedImage = new Promise(resolve => { releaseImage = resolve; });
const delayedAttachment = new Promise(resolve => { releaseAttachment = resolve; });

before(async () => {
  const screenshot = await readFile(new URL('../../../docs/images/pr/chat-image-delivery/after.png', import.meta.url));
  imageServer = createServer((req, res) => {
    requests.push({ path: req.url, referer: req.headers.referer });
    if (req.url === '/delayed.png') {
      void delayedImage.then(() => { res.setHeader('Content-Type', 'image/png'); res.end(screenshot); });
      return;
    }
    if (req.url === '/screenshot.png') {
      res.setHeader('Content-Type', 'image/png'); res.end(screenshot); return;
    }
    if (req.url === '/badge.png') {
      res.setHeader('Content-Type', 'image/png'); res.end(badge); return;
    }
    if (req.url === '/retry.png' && !failedOnce) {
      failedOnce = true;
      res.writeHead(404).end();
    } else {
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
    }
  });
  await new Promise(resolve => imageServer.listen(0, '127.0.0.1', resolve));
  imageUrl = `http://127.0.0.1:${imageServer.address().port}`;
  const destinations = {
    'badge-remote': `Build ![Badge](${imageUrl}/badge.png) passing.`,
    'badge-saved': `Build ![Badge](${imageUrl}/badge.png) passing.`,
    'badge-saving': `Build ![Badge](${imageUrl}/badge.png) passing.`,
    'angle-saved': '![Screenshot](</tmp/my image.png>)',
    'title-saved': `![Screenshot](${imageUrl}/image.png "Screenshot title")`,
    'escaped-saved': String.raw`![Screenshot](/tmp/a\(1\).png)`,
    'reference-saved': '![Screenshot][picture]\n\n[picture]: </tmp/my "image".png>',
    'attachment-title': '![Screenshot](maka://runtime/attachments/image-1 "Screenshot title")',
    'geometry-remote': `![Screenshot](${imageUrl}/delayed.png)\n\nFollowing paragraph`,
    'geometry-saved': '![Screenshot](/tmp/private.png)\n\nFollowing paragraph',
    'streaming-angle-race': '![Screenshot](</tmp/my image.png>)',
    screenshot: `![Screenshot](${imageUrl}/screenshot.png)`,
  };
  const canonicalSources = {
    'angle-saved': ['/tmp/my image.png'],
    'title-saved': [`${imageUrl}/image.png`],
    'escaped-saved': ['/tmp/a(1).png'],
    'reference-saved': ['/tmp/my "image".png'],
    'geometry-saved': ['/tmp/private.png'],
    'streaming-angle-race': ['/tmp/my image.png'],
  };
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Theme} from '@astryxdesign/core';
      import {makaTheme} from './apps/desktop/src/renderer/astryx-theme/maka.js';
      import {MarkdownBody} from './packages/ui/dist/markdown-body.js';
      import {LocaleProvider} from './packages/ui/dist/locale-context.js';
      import {ImageDeliveryProvider} from './packages/ui/dist/image-delivery.js';
      import {SessionAttachmentProvider} from './packages/ui/dist/attachment-image.js';
      import './apps/desktop/src/renderer/styles.css';
      const mode=new URLSearchParams(location.search).get('case') || 'remote';
      const destinations=${JSON.stringify(destinations)};
      const canonicalSources=${JSON.stringify(canonicalSources)};
      let reads=0; window.imageReads=0; window.deliveryQueries=0; window.deliveryReady=false; window.deliveryRetries=0;
      const race=mode.endsWith('-race');
      const text=destinations[mode] ?? (mode==='attachment' ? '![Screenshot](maka://runtime/attachments/image-1)' :
        mode==='local' || mode==='local-saved' || race ? '![Screenshot](/tmp/private.png)' :
        '![Screenshot](${imageUrl}/'+(mode==='retry' ? 'retry.png' : 'image.png')+')');
      const root=createRoot(document.getElementById('root'));
      const readBytes=async()=>{
        if(mode==='geometry-saved') await fetch('/release-attachment');
        reads++; window.imageReads=reads; return (mode==='attachment' || mode==='read-retry-saved') && reads===1 ? {ok:false,reason:'read_failed'} :
          {ok:true,base64:mode.startsWith('badge-') ? '${badge.toString('base64')}' : mode==='geometry-saved' ? '${screenshot.toString('base64')}' : mode==='corrupt-saved' && !window.deliveryRetries ? 'iVBORw0KGgo=' : '${png.toString('base64')}',mimeType:'image/png'};
      };
      const resolveDelivery=mode.endsWith('saved') || mode.endsWith('saving') || race ? async(_session,request)=>{
        window.deliveryQueries++;
        window.deliverySource=request.source;
        if(canonicalSources[mode] && !canonicalSources[mode].includes(request.source)) return {status:'unavailable'};
        if(request.retry) window.deliveryRetries++;
        if(race) return window.deliveryReady ? {status:'ready',artifactId:'saved-image'} : {status:'unavailable'};
        await new Promise(resolve=>setTimeout(resolve,100));
        return mode.endsWith('saving') && window.deliveryQueries===1 ? {status:'pending'} : {status:'ready',artifactId:'saved-image'};
      } : undefined;
      const render=(streaming=race)=>root.render(
        React.createElement(Theme,{theme:makaTheme,mode:'light'},
          React.createElement(LocaleProvider,{locale:'en'},
            React.createElement(SessionAttachmentProvider,{sessionId:'session',readBytes},
              React.createElement(ImageDeliveryProvider,{sessionId:'session',resolve:resolveDelivery},
              React.createElement('div',{style:mode==='offscreen' ? {paddingTop:'2500px'} : {}},
                React.createElement(MarkdownBody,{text,streaming,settledText:race ? text : undefined,imageIdentity:{turnId:'turn',messageId:'message'}})))))));
      window.finishStream=()=>render(false);
      render();
    `, resolveDir: root, loader: 'js' },
    bundle: true, write: false, outdir: '/virtual', format: 'iife',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  const index = await readFile(new URL('../../../apps/desktop/src/renderer/index.html', import.meta.url), 'utf8');
  const csp = index.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  appServer = createServer((req, res) => {
    if (req.url === '/release-attachment') { void delayedAttachment.then(() => res.end()); return; }
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); }
    else if (req.url === '/app.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/app.css"></head><body><main id="root"></main><script src="/app.js"></script></body></html>`);
    }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  releaseImage(); releaseAttachment();
  await browser?.close();
  for (const server of [appServer, imageServer]) if (server) await new Promise(resolve => server.close(resolve));
});

async function pageFor(scenario) {
  const page = await browser.newPage({ viewport: { width: 720, height: 600 } });
  page.setDefaultTimeout(5000);
  await page.goto(`${appUrl}/?case=${scenario}`);
  return page;
}

async function loaded(page) {
  await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth === 1));
}

test('remote image loads automatically under the actual desktop CSP, without sending a referrer', async () => {
  requests = [];
  const page = await pageFor('remote');
  try {
    assert.equal(await page.getByRole('button', { name: 'Load image', exact: true }).count(), 0);
    await loaded(page);
    assert.deepEqual(requests, [{ path: '/image.png', referer: undefined }]);
    // Astryx Button keeps an empty live region for asynchronous actions.
    await page.getByText('Loading image…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('status').filter({ hasText: /\S/ }).count(), 0);
  } finally { await page.close(); }
});

test('failed remote image has a working retry control instead of a broken image icon', async () => {
  failedOnce = false;
  const page = await pageFor('retry');
  try {
    await page.getByText('Could not load the image. Try again.').waitFor();
    assert.equal(await page.locator('img').count(), 0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await loaded(page);
  } finally { await page.close(); }
});

test('attachment read failure recovers in place, and local paths explain how to provide an image', async () => {
  const page = await pageFor('attachment');
  try {
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await loaded(page);
    assert.match(await page.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
    await page.goto(`${appUrl}/?case=local`);
    await page.getByText('This image address cannot be displayed. Send the image as a chat attachment.').waitFor();
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Load image' }).count(), 0);
  } finally { await page.close(); }
});

test('a saved image decode failure invalidates both caches and recaptures its source on retry', async () => {
  const page = await pageFor('corrupt-saved');
  try {
    await page.getByText('Could not load the image. Try again.').waitFor();
    assert.equal(await page.evaluate(() => window.imageReads), 1);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(() => [...document.images].some(img => img.src.startsWith('data:image/png;') && img.naturalWidth === 1));
    assert.equal(await page.evaluate(() => window.deliveryRetries), 1);
    assert.equal(await page.evaluate(() => window.deliveryQueries), 2);
    assert.equal(await page.evaluate(() => window.imageReads), 2);
  } finally { await page.close(); }
});

test('a transient saved attachment read retries its bytes without invalidating archival or touching origin', async () => {
  requests = [];
  const page = await pageFor('read-retry-saved');
  try {
    await page.getByText('Could not load the image. Try again.').waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await loaded(page);
    assert.equal(await page.evaluate(() => window.deliveryRetries), 0);
    assert.equal(await page.evaluate(() => window.deliveryQueries), 1);
    assert.equal(await page.evaluate(() => window.imageReads), 2);
    assert.deepEqual(requests, []);
  } finally { await page.close(); }
});

for (const scenario of ['remote-saved', 'local-saved']) {
  test(`${scenario}: saved mapping avoids the original source and the image supports zoom`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      await loaded(page);
      assert.deepEqual(requests, []);
      assert.equal(await page.evaluate(() => window.imageReads), 1);
      assert.equal(await page.locator('img').count(), 1);
      assert.match(await page.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
      await page.getByRole('button', { name: 'Enlarge image: Screenshot', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.images.length > 1);
    } finally { await page.close(); }
  });
}
test('offscreen image performs no image request until it approaches the viewport', async () => {
  requests = [];
  const page = await pageFor('offscreen');
  try {
    // Let React effects and the initial IntersectionObserver callback complete.
    await page.getByText('Loading image…').waitFor();
    assert.deepEqual(requests, []);
    assert.equal(await page.locator('img').count(), 0);
    await page.locator('[data-maka-image-state]').scrollIntoViewIfNeeded();
    await loaded(page);
    assert.deepEqual(requests, [{ path: '/image.png', referer: undefined }]);
  } finally { await page.close(); }
});

test('a new remote image previews during archival and switches to saved bytes after background completion', async () => {
  requests = [];
  const page = await pageFor('saving');
  try {
    await loaded(page);
    await page.getByText('Saving image…').waitFor();
    assert.equal(requests.length, 1);
    await page.waitForFunction(() => [...document.images].some(img=>img.src.startsWith('data:image/png;') && img.naturalWidth===1));
    await page.getByText('Loading image…', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('Saving image…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('status').filter({ hasText: /\S/ }).count(), 0);
    assert.equal(await page.evaluate(() => window.deliveryQueries), 2);
    assert.equal(requests.length, 1);
  } finally { await page.close(); }
});

for (const scenario of ['streaming-race', 'settled-race', 'streaming-angle-race']) {
  test(`${scenario}: an unavailable live source recovers in place once Host archival completes`, async () => {
    const page = await pageFor(scenario);
    try {
      await page.waitForFunction(() => window.deliveryQueries === 1);
      if (scenario === 'settled-race') {
        await page.evaluate(() => window.finishStream());
        await page.waitForFunction(() => window.deliveryQueries >= 2);
      }
      await page.evaluate(() => { window.deliveryReady = true; });
      await loaded(page);
      assert.equal(await page.evaluate(() => window.imageReads), 1);
      assert.match(await page.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
      assert.equal(await page.locator('img').count(), 1);
    } finally { await page.close(); }
  });
}

for (const scenario of ['angle-saved', 'title-saved', 'escaped-saved', 'reference-saved', 'attachment-title']) {
  test(`${scenario}: standard Markdown destinations resolve to saved bytes without origin requests`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      await loaded(page);
      assert.match(await page.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
      assert.deepEqual(requests, []);
      assert.equal(await page.evaluate(() => window.imageReads), 1);
      if (scenario !== 'attachment-title') {
        assert.equal(await page.evaluate(() => window.deliveryQueries), 1);
      }
    } finally { await page.close(); }
  });
}

for (const scenario of ['geometry-remote', 'geometry-saved']) {
  test(`${scenario}: loading and ready images preserve the position of subsequent content`, async () => {
    const page = await pageFor(scenario);
    try {
      await page.getByText('Loading image…', { exact: true }).waitFor();
      const before = await page.getByText('Following paragraph', { exact: true }).boundingBox();
      if (scenario === 'geometry-remote') releaseImage(); else releaseAttachment();
      await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth > 1));
      await page.getByText('Loading image…', { exact: true }).waitFor({ state: 'hidden' });
      const after = await page.getByText('Following paragraph', { exact: true }).boundingBox();
      assert.equal(after.y, before.y);
    } finally {
      if (scenario === 'geometry-remote') releaseImage(); else releaseAttachment();
      await page.close();
    }
  });
}

test('image frames fit narrow viewports without distorting screenshots or limiting the enlarged preview', async () => {
  const page = await pageFor('screenshot');
  try {
    await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth > 1));
    for (const width of [720, 360]) {
      await page.setViewportSize({ width, height: 600 });
      const geometry = await page.locator('.maka-markdown-image-preview img').evaluate(image => {
        const frame = image.closest('.maka-markdown-image-frame').getBoundingClientRect();
        const box = image.getBoundingClientRect();
        return { frame: { x: frame.x, y: frame.y, right: frame.right, bottom: frame.bottom },
          box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
          ratio: image.naturalWidth / image.naturalHeight };
      });
      assert.ok(Math.abs(geometry.box.width / geometry.box.height - geometry.ratio) < 0.01);
      assert.ok(geometry.box.x >= geometry.frame.x && geometry.box.right <= geometry.frame.right + 1);
      assert.ok(geometry.box.y >= geometry.frame.y && geometry.box.bottom <= geometry.frame.bottom + 1);
      assert.ok(geometry.frame.right <= width);
    }
    await page.getByRole('button', { name: 'Enlarge image: Screenshot', exact: true }).click();
    await page.waitForFunction(() => document.images.length > 1);
    assert.equal(await page.locator('.maka-markdown-image-preview > img').count(), 1);
    const dialog = await page.getByRole('dialog').boundingBox();
    const frame = await page.locator('.maka-markdown-image-frame').boundingBox();
    assert.ok(dialog.height > frame.height);
    assert.equal(await page.getByRole('dialog').locator('img').getAttribute('src'), await page.locator('.maka-markdown-image-preview > img').getAttribute('src'));
  } finally { await page.close(); }
});

for (const scenario of ['badge-remote', 'badge-saved', 'badge-saving']) {
  test(`${scenario}: a badge keeps its intrinsic size and surrounding text on one line`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth === 80));
      if (scenario === 'badge-saving') {
        await page.waitForFunction(() => [...document.images].some(image => image.src.startsWith('data:') && image.naturalWidth === 80));
      }
      const geometry = await page.locator('.maka-markdown-image-resource').evaluate(element => {
        const box = element.getBoundingClientRect();
        const paragraph = element.closest('[role="paragraph"]');
        const textBoxes = [...paragraph.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()).map(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return range.getBoundingClientRect().y;
        });
        return { width: box.width, height: box.height, textBoxes };
      });
      assert.equal(geometry.width, 80);
      assert.equal(geometry.height, 20);
      assert.equal(geometry.textBoxes.length, 2);
      assert.equal(geometry.textBoxes[0], geometry.textBoxes[1]);
      if (scenario === 'badge-saved') assert.deepEqual(requests, []);
      if (scenario === 'badge-remote') {
        await page.locator('.maka-markdown-image-preview').hover();
        await page.getByRole('button', { name: 'Enlarge image: Badge', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Enlarge image: Badge', exact: true }).focus();
        await page.keyboard.press('Enter');
      }
      await page.getByRole('dialog').waitFor();
    } finally { await page.close(); }
  });
}
