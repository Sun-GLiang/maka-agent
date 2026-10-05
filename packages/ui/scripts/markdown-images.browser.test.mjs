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
let appServer, imageServer, browser, appUrl, imageUrl;
let requests = [], failedOnce = false;

before(async () => {
  imageServer = createServer((req, res) => {
    requests.push({ path: req.url, referer: req.headers.referer });
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
      let reads=0; window.imageReads=0; window.deliveryQueries=0; window.deliveryReady=false;
      const race=mode.endsWith('-race');
      const text=mode==='attachment' ? '![Screenshot](maka://runtime/attachments/image-1)' :
        mode==='local' || mode==='local-saved' || race ? '![Screenshot](/tmp/private.png)' :
        '![Screenshot](${imageUrl}/'+(mode==='retry' ? 'retry.png' : 'image.png')+')';
      const root=createRoot(document.getElementById('root'));
      const readBytes=async()=>{
        reads++; window.imageReads=reads; return mode==='attachment' && reads===1 ? {ok:false,reason:'read_failed'} :
          {ok:true,base64:'${png.toString('base64')}',mimeType:'image/png'};
      };
      const resolveDelivery=mode.endsWith('saved') || mode==='saving' || race ? async()=>{
        window.deliveryQueries++;
        if(race) return window.deliveryReady ? {status:'ready',artifactId:'saved-image'} : {status:'unavailable'};
        await new Promise(resolve=>setTimeout(resolve,100));
        return mode==='saving' && window.deliveryQueries===1 ? {status:'pending'} : {status:'ready',artifactId:'saved-image'};
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
      await page.getByRole('button', { name: 'Enlarge image: Screenshot', exact: true }).click();
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

for (const scenario of ['streaming-race', 'settled-race']) {
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
