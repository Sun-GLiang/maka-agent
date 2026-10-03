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
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import * as current from '../dist/main/browser/browser-tools.js';
import { provideBrowserViewHost } from '../dist/main/browser/browser-host.js';
import { resetBrowserSessionsForTest, setBridgeFactoryForTest } from '../dist/main/browser/session.js';
import { withBrowserOriginAdmission } from '../dist/main/browser/browser-origin-admission.js';
import { BrowserOriginLeaseTracker } from '../dist/main/browser/browser-origin-lease.js';
import { runBrowserObservationRegressions } from './browser-observation-regressions.mjs';

// Use unchanged OpenCLI with real native CDP mouse/keyboard transport, not a
// fake click/fill implementation. No user profile, cookies or remote pages.
const { CDPBasePage } = await import(new URL('./browser/base-page.js', import.meta.resolve('@jackwener/opencli')));
let browser, page, cdp, afterEvaluate, afterCdp;
const nativeCalls = [];
class FixturePage extends CDPBasePage {
  async evaluate(js) {
    const result = await page.evaluate(js);
    await afterEvaluate?.(js);
    return result;
  }
  async goto(url) { await page.goto(url); }
  async getCurrentUrl() { return page.url(); }
  async cdp(method, params = {}) {
    nativeCalls.push(method);
    const result = await cdp.send(method, params);
    if (method === 'Runtime.evaluate') await afterEvaluate?.(params.expression);
    await afterCdp?.(method, params);
    return result;
  }
}
const context = { sessionId: 'browser-regression', turnId: 'test', toolCallId: 'test', cwd: process.cwd(), abortSignal: new AbortController().signal, emitOutput() {} };
const invoke = (tool, args) => withBrowserOriginAdmission(
  { sessionId: context.sessionId, url: 'https://fixture.test/pr' }, () => tool.impl(args, context),
);
const observe = args => invoke(current.buildBrowserInspectTool(), args).then(JSON.parse);
async function content(html) { await page.setContent(`<body>${html}</body>`); }
async function replace(selector) {
  await page.evaluate(selector => { const el = document.querySelector(selector); el.replaceWith(el.cloneNode(true)); }, selector);
}
function mutateAfter(marker, mutate) {
  afterEvaluate = async js => {
    if (!js.includes(marker)) return;
    afterEvaluate = undefined;
    await mutate();
  };
}

before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL === 'chromium' ? {} : { channel: process.env.BROWSER_CHANNEL || 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  cdp = await page.context().newCDPSession(page);
  const repositories = label => Array.from({ length: 1000 }, (_, i) => `<a href="/repo/${label}/${i}">${label} repository ${i}</a>`).join('');
  const html = (await readFile(new URL('../perf/browser-observation/fixture.html', import.meta.url), 'utf8'))
    .replace('__HIDDEN_REPOSITORIES__', repositories('css-hidden'))
    .replace('__CLOSED_REPOSITORIES__', repositories('closed-menu'))
    .replace('__OTHER_SUBMITS__', '<button type="submit">Other submit</button>'.repeat(4));
  await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
});
beforeEach(async () => {
  afterEvaluate = undefined;
  afterCdp = undefined;
  nativeCalls.length = 0;
  resetBrowserSessionsForTest();
  const leases = new BrowserOriginLeaseTracker(() => page.url());
  provideBrowserViewHost({
    canDrive: () => true, beginAction: () => undefined, currentUrl: () => page.url(),
    openOriginLease: (_id, approved, kind) => leases.open(approved, kind),
    resolveEndpoint: async () => ({ cdpEndpoint: 'ws://fixture' }),
    releaseSession: async () => {}, disposeSession: async () => {},
  });
  setBridgeFactoryForTest(() => ({ connect: async () => new FixturePage(), close: async () => {}, send: async () => {}, waitForEvent: async () => {} }));
  await invoke(current.buildBrowserNavigateTool(), { url: 'https://fixture.test/pr' });
});
after(async () => {
  resetBrowserSessionsForTest(); setBridgeFactoryForTest(null); provideBrowserViewHost(null);
  await browser?.close();
});

test('production observer passes existing real-DOM regressions', async () => {
  assert.equal(await runBrowserObservationRegressions({ page, invoke, current }), 23);
});

for (const marker of ['const interactive =', 'window.__resolved = matches[0]']) {
  for (const operation of ['click', 'type']) {
    test(`${operation} rejects replacement after ${marker === 'const interactive =' ? 'preflight' : 'OpenCLI resolution'}`, async () => {
      await content('<form onsubmit="event.preventDefault();window.submissions++"><button id="target" onclick="window.clicks++">Create</button><input id="field"></form><script>window.clicks=0;window.submissions=0</script>');
      const selector = operation === 'click' ? '#target' : '#field';
      const ref = (await observe({ selector })).candidates[0].ref;
      mutateAfter(marker, () => replace(selector));
      const output = await invoke(operation === 'click' ? current.buildBrowserClickTool() : current.buildBrowserTypeTool(), { ref, text: 'changed', submit: true });
      assert.match(output, /Action stopped/);
      assert.equal(await page.evaluate('window.clicks'), 0);
      assert.equal(await page.evaluate('window.submissions'), 0);
      assert.equal(await page.locator('#field').inputValue(), '');
      assert.ok(!nativeCalls.includes('Input.insertText'));
    });
  }
}

test('concurrent actions in one conversation cannot overwrite OpenCLI resolved targets', async () => {
  await content('<button id="first" onclick="window.clicks.push(1)">First</button><button id="second" onclick="window.clicks.push(2)">Second</button><script>window.clicks=[]</script>');
  let releaseFirst;
  let firstResolved;
  const waiting = new Promise(resolve => { firstResolved = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  mutateAfter('window.__resolved = matches[0]', async () => { firstResolved(); await gate; });
  const first = invoke(current.buildBrowserClickTool(), { ref: '#first' });
  await waiting;
  const second = invoke(current.buildBrowserClickTool(), { ref: '#second' });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await page.evaluate('window.clicks'), []);
  } finally { releaseFirst(); }
  assert.ok((await Promise.all([first, second])).every(output => output.startsWith('Clicked')));
  assert.deepEqual(await page.evaluate('window.clicks'), [1, 2]);
});

test('visibility and disabled changes after preflight stop the click', async () => {
  for (const property of ['hidden', 'aria-disabled']) {
    await content('<button id="target" onclick="window.clicks++">Create</button><script>window.clicks=0</script>');
    mutateAfter('const interactive =', () => page.evaluate(property => document.querySelector('#target').setAttribute(property, 'true'), property));
    assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /Action stopped/);
    assert.equal(await page.evaluate('window.clicks'), 0);
  }
});

test('ancestor aria-disabled blocks click, fill and submission', async () => {
  await content('<div role="group" aria-disabled="true"><button id="target" onclick="window.clicks++">Delete</button><input id="field"></div><script>window.clicks=0</script>');
  const observed = await observe({ selector: '#target,#field' });
  assert.ok(observed.candidates.every(candidate => candidate.enabled === false));
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /No action taken/);
  assert.match(await invoke(current.buildBrowserTypeTool(), { ref: '#field', text: 'changed', submit: true }), /No action taken/);
  assert.equal(await page.evaluate('window.clicks'), 0);
  assert.equal(await page.locator('#field').inputValue(), '');
});

test('native pointer and Unicode input behavior remain available', async () => {
  await content('<button id="target" onpointerdown="window.pointers++">Open</button><input id="field" aria-label="Title"><script>window.pointers=0</script>');
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /Clicked/);
  assert.equal(await page.evaluate('window.pointers'), 1);
  assert.match(await invoke(current.buildBrowserTypeTool(), { ref: '#field', text: '中文🙂' }), /Verified/);
  assert.equal(await page.locator('#field').inputValue(), '中文🙂');
  assert.ok(nativeCalls.includes('Input.dispatchMouseEvent'));
  assert.ok(nativeCalls.includes('Input.insertText'));
});

test('focus redirection cannot type into another field or trigger a JS fallback', async () => {
  await content(`<input id="target" onfocus="document.querySelector('#other').focus()"><input id="other">`);
  assert.match(await invoke(current.buildBrowserTypeTool(), { ref: '#target', text: 'PRIVATE_TYPED', submit: true }), /Action stopped/);
  assert.equal(await page.locator('#target').inputValue(), '');
  assert.equal(await page.locator('#other').inputValue(), '');
  assert.ok(!nativeCalls.includes('Input.insertText'));
});

test('focus moved by input cannot submit a different field with Enter', async () => {
  await content(`<form onsubmit="event.preventDefault();window.submissions++"><input id="target" oninput="document.querySelector('#other').focus()"><input id="other"></form><script>window.submissions=0</script>`);
  assert.match(await invoke(current.buildBrowserTypeTool(), { ref: '#target', text: 'filled', submit: true }), /Action stopped/);
  assert.equal(await page.locator('#target').inputValue(), 'filled');
  assert.equal(await page.locator('#other').inputValue(), '');
  assert.equal(await page.evaluate('window.submissions'), 0);
});

test('hover layout changes cannot redirect a native click to another control', async () => {
  await page.mouse.move(0, 0);
  await content(`<button id="other" style="position:absolute;left:20px;top:20px;width:100px;height:40px" onclick="window.other++">Other</button><button id="target" style="position:absolute;left:20px;top:20px;width:100px;height:40px" onmouseenter="this.style.left='300px'" onclick="window.target++">Target</button><script>window.target=0;window.other=0</script>`);
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /Action stopped/);
  assert.equal(await page.evaluate('window.target'), 0);
  assert.equal(await page.evaluate('window.other'), 0);
});

test('native clicks on icon and text descendants still reach their clickable parent', async () => {
  await content('<button style="width:300px;height:50px;text-align:left" onpointerdown="window.pointers++" onclick="window.clicks++"><span id="icon">icon</span>Long empty button area</button><script>window.clicks=0;window.pointers=0</script>');
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#icon' }), /Clicked/);
  assert.equal(await page.evaluate('window.clicks'), 1);
  assert.equal(await page.evaluate('window.pointers'), 1);
  assert.ok(nativeCalls.includes('Input.dispatchMouseEvent'));
});

test('contenteditable descendants still fill their focused editor host', async () => {
  await content('<div contenteditable="true" aria-label="Editor"><span id="child">Old</span></div>');
  assert.match(await invoke(current.buildBrowserTypeTool(), { ref: '#child', text: '编辑器🙂' }), /Verified/);
  assert.equal(await page.locator('[contenteditable]').textContent(), '编辑器🙂');
});

test('replacement on pointer-down releases the mouse without clicking the replacement', async () => {
  await content('<button id="target" onpointerdown="this.replaceWith(this.cloneNode(true))" onclick="window.clicks++">Create</button><script>window.clicks=0;window.buttons=-1;document.onmousemove=e=>window.buttons=e.buttons</script>');
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /Action stopped/);
  assert.equal(await page.evaluate('window.clicks'), 0);
  await page.mouse.move(200, 200);
  assert.equal(await page.evaluate('window.buttons'), 0);
});

test('replacement caused by focus cannot receive native input', async () => {
  await content('<input id="field" onfocus="this.replaceWith(this.cloneNode(true))">');
  assert.match(await invoke(current.buildBrowserTypeTool(), { ref: '#field', text: 'changed', submit: true }), /Action stopped/);
  assert.equal(await page.locator('#field').inputValue(), '');
  assert.ok(!nativeCalls.includes('Input.insertText'));
});

test('replacement during input stops Enter and reports potentially completed steps', async () => {
  await content('<form onsubmit="event.preventDefault();window.submissions++"><input id="field" oninput="const copy=this.cloneNode(true);copy.value=this.value;this.replaceWith(copy)"></form><script>window.submissions=0</script>');
  const output = await invoke(current.buildBrowserTypeTool(), { ref: '#field', text: 'filled', submit: true });
  assert.match(output, /Action stopped.*earlier steps may have run/);
  assert.equal(await page.locator('#field').inputValue(), 'filled');
  assert.equal(await page.evaluate('window.submissions'), 0);
});

test('scan continuation reaches controls after more than 5000 hidden matches', async () => {
  await content('<div hidden>'+ '<button>Hidden</button>'.repeat(5001)+'</div><button id="target">Create</button>');
  const first = JSON.parse(await invoke(current.buildBrowserSnapshotTool(), {}));
  assert.equal(first.candidates.length, 0);
  assert.equal(first.nextStart, 5000);
  assert.equal(first.visibleMatchCount, null);
  const next = JSON.parse(await invoke(current.buildBrowserSnapshotTool(), { start: first.nextStart }));
  assert.equal(next.candidates[0].attributes.id, 'target');
  assert.equal(next.nextStart, null);
});

test('candidate/output pagination progresses without skipping returned controls', async () => {
  await content('<button>One</button><button>Two</button><button>Three</button>');
  const names = [];
  let start = 0;
  do {
    const result = await observe({ maxElements: 1, start });
    names.push(...result.candidates.map(candidate => candidate.name));
    assert.ok(result.nextStart === null || result.nextStart > start);
    start = result.nextStart;
  } while (start !== null);
  assert.deepEqual(names, ['One', 'Two', 'Three']);
  await content(Array.from({ length: 100 }, (_, i) => `<button id="control-${i}" name="${'n'.repeat(120)}" role="button" type="button" aria-label="${'a'.repeat(120)}" aria-checked="false" aria-expanded="false">${'b'.repeat(120)}</button>`).join(''));
  const ids = new Set();
  start = 0;
  do {
    const result = await observe({ maxElements: 100, start });
    assert.ok(JSON.stringify(result).length <= 16000);
    for (const candidate of result.candidates) { assert.ok(!ids.has(candidate.attributes.id)); ids.add(candidate.attributes.id); }
    assert.ok(result.nextStart === null || result.nextStart > start);
    start = result.nextStart;
  } while (start !== null);
  assert.equal(ids.size, 100);
});

test('explicit hidden labels and native control states are observable without editable values', async () => {
  await content('<span id="label" hidden>Search terms</span><input id="field" aria-labelledby="label" value="PRIVATE_INPUT"><input id="submit" type="submit" value="Create"><input id="check" type="checkbox"><input id="readonly" readonly value="PRIVATE_READONLY"><select><option id="selected" selected>First</option></select><div contenteditable="true">PRIVATE_EDITABLE</div>');
  await page.evaluate(() => { document.querySelector('#check').checked = true; });
  const result = await observe({});
  assert.equal(result.candidates.find(candidate => candidate.attributes.id === 'field').name, 'Search terms');
  assert.equal(result.candidates.find(candidate => candidate.attributes.id === 'submit').name, 'Create');
  assert.equal(result.candidates.find(candidate => candidate.attributes.id === 'check').checked, true);
  assert.equal(result.candidates.find(candidate => candidate.attributes.id === 'readonly').readOnly, true);
  assert.equal((await observe({ selector: '#selected', visibleOnly: false })).candidates[0].selected, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.match(await invoke(current.buildBrowserTypeTool(), { ref: '#readonly', text: 'changed', submit: true }), /No action taken/);
});

for (const marker of ['window.__resolved = matches[0]', 'retargeted']) {
  test(`a new overlay blocks JS click fallback after ${marker}`, async () => {
    await content('<button id="target" onclick="window.clicks++">Delete</button><script>window.clicks=0</script>');
    mutateAfter(marker, () => page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:white';
      document.body.append(overlay);
    }));
    assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /Action stopped/);
    assert.equal(await page.evaluate('window.clicks'), 0);
  });
}

for (const operation of ['click', 'type']) {
  test(`page scripts cannot forge replacement identity for ${operation}`, async () => {
    await content('<button id="target" onclick="window.clicks++">Delete</button><input id="field"><script>window.clicks=0</script>');
    const selector = operation === 'click' ? '#target' : '#field';
    const ref = (await observe({ selector })).candidates[0].ref;
    await page.evaluate(selector => {
      const original = document.querySelector(selector);
      const replacement = original.cloneNode(true);
      const id = original.getAttribute('data-maka-browser-ref');
      const state = window.__makaBrowserObservationRefs ??= { refs: new WeakMap() };
      state.refs.set(replacement, id);
      original.replaceWith(replacement);
    }, selector);
    const output = await invoke(operation === 'click' ? current.buildBrowserClickTool() : current.buildBrowserTypeTool(), { ref, text: 'PRIVATE_TYPED' });
    assert.match(output, /No action taken.*\n.*stale/s);
    assert.equal(await page.evaluate('window.clicks'), 0);
    assert.equal(await page.locator('#field').inputValue(), '');
  });
}

test('snapshot omits editable headings and headings containing editors', async () => {
  await content('<h1>Public title</h1><div contenteditable="true"><h2>PRIVATE_NESTED</h2></div><h2 contenteditable>PRIVATE_HEADING</h2><h3>Draft: <span contenteditable="plaintext-only">PRIVATE_CHILD</span></h3>');
  const result = JSON.parse(await invoke(current.buildBrowserSnapshotTool(), {}));
  assert.ok(result.context.includes('Public title'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('empty and plaintext-only editors are discoverable and fillable', async () => {
  await content('<div contenteditable id="empty">PRIVATE_EMPTY</div><div contenteditable="plaintext-only" id="plain">PRIVATE_PLAIN</div><div contenteditable="false" id="noneditor">Ordinary text</div>');
  const result = JSON.parse(await invoke(current.buildBrowserSnapshotTool(), {}));
  assert.deepEqual(result.candidates.map(candidate => candidate.attributes.id), ['empty', 'plain']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  for (const candidate of result.candidates) {
    assert.match(await invoke(current.buildBrowserTypeTool(), { ref: candidate.ref, text: '编辑器🙂' }), /Verified/);
    assert.equal(await page.locator('#' + candidate.attributes.id).textContent(), '编辑器🙂');
  }
});

for (const operation of ['click', 'type']) {
  test(`a hostile MutationObserver cannot forge ${operation} identity mid-action`, async () => {
    await content('<button id="target" onclick="window.clicks++">Delete</button><input id="field"><script>window.clicks=0;window.replacements=0</script>');
    const selector = operation === 'click' ? '#target' : '#field';
    const ref = (await observe({ selector })).candidates[0].ref;
    assert.equal(await page.evaluate('typeof window.__makaBrowserObservationRefs'), 'undefined');
    await page.evaluate(selector => {
      // Forge both public attributes and the former main-world identity map
      // as soon as OpenCLI marks its resolved target for native focus/scroll.
      window.__makaBrowserObservationRefs = { refs: new WeakMap() };
      const observer = new MutationObserver(records => {
        if (!records.some(record => record.attributeName === 'data-opencli-cdp-target')) return;
        observer.disconnect();
        const original = document.querySelector(selector);
        const replacement = original.cloneNode(true);
        window.__makaBrowserObservationRefs.refs.set(replacement, original.getAttribute('data-maka-browser-ref'));
        window.__resolved = replacement;
        original.replaceWith(replacement);
        window.replacements++;
      });
      observer.observe(document.querySelector(selector), { attributes: true });
    }, selector);
    const output = await invoke(operation === 'click' ? current.buildBrowserClickTool() : current.buildBrowserTypeTool(), { ref, text: 'PRIVATE_TYPED' });
    assert.match(output, /Action stopped/);
    assert.equal(await page.evaluate('window.replacements'), 1);
    assert.equal(await page.evaluate('window.clicks'), 0);
    assert.equal(await page.locator('#field').inputValue(), '');
  });
}

test('main-world resolved-slot changes cannot redirect structured actions', async () => {
  await content('<button id="target" onclick="window.target++">Target</button><button id="other" onclick="window.other++">Other</button><script>window.target=0;window.other=0</script>');
  mutateAfter('window.__resolved = matches[0]', () => page.evaluate(() => { window.__resolved = document.querySelector('#other'); }));
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /^Clicked/);
  assert.equal(await page.evaluate('window.target'), 1);
  assert.equal(await page.evaluate('window.other'), 0);
});

test('offscreen CSS controls scroll into view before guarded native clicks', async () => {
  await content('<div style="height:2000px"></div><button id="target" onpointerdown="window.pointers++" onclick="window.clicks++">Target</button><script>window.clicks=0;window.pointers=0</script>');
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /^Clicked/);
  assert.equal(await page.evaluate('window.clicks'), 1);
  assert.equal(await page.evaluate('window.pointers'), 1);
});

test('legacy numbered refs remain usable after structured observations and actions', async () => {
  await content('<input id="field" aria-label="Title"><button id="target" onclick="window.clicks++">Target</button><script>window.clicks=0</script>');
  const legacy = await invoke(current.buildBrowserSnapshotTool(), { source: 'opencli' });
  const field = legacy.match(/\[(\d+)\].*id=field/)[1];
  const target = legacy.match(/\[(\d+)\].*id=target/)[1];
  await observe({});
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: '#target' }), /^Clicked/);
  assert.match(await invoke(current.buildBrowserTypeTool(), { ref: `[${field}]`, text: 'Legacy🙂' }), /Verified/);
  assert.match(await invoke(current.buildBrowserClickTool(), { ref: `[${target}]` }), /^Clicked/);
  assert.equal(await page.locator('#field').inputValue(), 'Legacy🙂');
  assert.equal(await page.evaluate('window.clicks'), 2);
});


test('navigation during pointer-down releases the mouse after the isolated context disappears', async () => {
  await content('<button id="target">Navigate</button>');
  afterCdp = async (method, params) => {
    if (method !== 'Input.dispatchMouseEvent' || params.type !== 'mousePressed') return;
    afterCdp = undefined;
    await page.goto('https://fixture.test/next');
  };
  await invoke(current.buildBrowserClickTool(), { ref: '#target' });
  await page.evaluate(() => { window.buttons = -1; document.onmousemove = e => { window.buttons = e.buttons; }; });
  await page.mouse.move(200, 200);
  assert.equal(await page.evaluate('window.buttons'), 0);
});
