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
import { afterEach, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import { createDefaultSettings } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import type {
  ExternalAgentSetupProjection,
  ExternalAgentSetupStart,
} from '@maka/runtime-host/protocol';
import {
  ExternalAgentsSettingsPage,
  ExternalAgentSettingsServicesProvider,
} from '../../renderer/features/external-agent-settings/index.js';
import { createDesktopExternalAgentSettingsServices } from '../../renderer/platform/desktop/create-external-agent-settings-services.js';
import { RuntimeHostSettingsTarget } from '../../renderer/settings/runtime-host-settings-target.js';

let root: Root | undefined;
const globals = [
  'window',
  'document',
  'HTMLElement',
  'HTMLIFrameElement',
  'Node',
  'Event',
  'CSS',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
];
const original = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)]));
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  Object.assign(globalThis, original);
});
async function mount(
  input: {
    locale?: UiLocale;
    list?: boolean;
    executable?: string;
    remote?: boolean;
    start?: (value: ExternalAgentSetupStart) => Promise<ExternalAgentSetupProjection>;
  } = {},
) {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  });
  Object.assign(window, { matchMedia, getComputedStyle });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    getComputedStyle,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class {},
    Node: window.Node,
    Event: window.Event,
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const starts: ExternalAgentSetupStart[] = [];
  const cancels: string[] = [];
  Object.assign(window, {
    maka: {
      app: { info: async () => ({ platform: 'darwin', arch: 'arm64' }) },
      runtimeHostProfiles: {
        getSnapshot: async () => ({
          entries: [{ profile: { id: 'local', kind: input.remote ? 'remote' : 'local' } }],
        }),
      },
      externalAgents: {
        start: async (value: ExternalAgentSetupStart) => {
          starts.push(value);
          return input.start ? input.start(value) : { ...value, phase: 'succeeded' };
        },
        query: async () => ({ ...starts[0], phase: 'succeeded' }),
        cancel: async (id: string) => {
          cancels.push(id);
          return { ...starts[0], phase: 'cancelled' };
        },
      },
    },
  });
  const settings = createDefaultSettings();
  settings.externalAgents.antigravity.executable = input.executable ?? '/agent/agy_acp_server.par';
  root = createRoot(document.getElementById('root')!);
  const services = createDesktopExternalAgentSettingsServices();
  const render = async (
    generation: string,
    executable = settings.externalAgents.antigravity.executable,
  ) => {
    await act(async () =>
      root!.render(
        createElement(LocaleProvider, {
          locale: input.locale ?? 'en',
          children: createElement(AstryxLocaleProvider, {
            children: createElement(RuntimeHostSettingsTarget, {
              host: { profileId: 'local', hostId: 'host-1' },
              generation,
              children: createElement(ExternalAgentSettingsServicesProvider, {
                services,
                children: createElement(ExternalAgentsSettingsPage, {
                  settings: { ...settings, externalAgents: { antigravity: { executable } } },
                  onUpdate: async () => ({ settings }),
                }),
              }),
            }),
          }),
        }),
      ),
    );
  };
  await render('generation-1');
  if (!input.list)
    await act(async () => {
      const entry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.includes('Antigravity'),
      );
      assert.ok(entry);
      entry.click();
    });
  return {
    document,
    starts,
    cancels,
    render,
    button: (label: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === label,
      );
      assert.ok(button, label);
      return button;
    },
  };
}
for (const [locale, label] of [
  ['en', 'Check connection'],
  ['zh-CN', '检查连接'],
  ['zh-TW', '檢查連線'],
] as const) {
  test(`${locale}: setup is available through the existing Settings controls`, async () => {
    const page = await mount({ locale });
    assert.equal(page.button(label).disabled, false);
    await act(async () => {
      page.button(label).click();
      page.button(label).click();
    });
    assert.equal(page.starts.length, 1, 'synchronous action guard prevents double start');
    assert.equal(page.starts[0].action, 'check');
    assert.match(page.document.body.textContent ?? '', /Connection successful|连接成功|連線成功/);
    assert.doesNotMatch(
      page.document.body.textContent ?? '',
      /Google sign-in completed|Google 登录已完成|Google 登入已完成/,
    );
  });
}
test('remote targets cannot start an external agent', async () => {
  const page = await mount({ remote: true });
  assert.equal(page.button('Check connection').disabled, true);
  assert.match(page.document.body.textContent ?? '', /local macOS Apple Silicon/);
});
test('Host generation change cancels an in-flight start and ignores its late response', async () => {
  let finish!: (value: ExternalAgentSetupProjection) => void;
  const pending = new Promise<ExternalAgentSetupProjection>((resolve) => {
    finish = resolve;
  });
  const page = await mount({ start: () => pending });
  await act(async () => page.button('Sign in with Google').click());
  assert.equal(page.starts.length, 1);
  await page.render('generation-2');
  assert.equal(page.cancels.length, 1);
  await act(async () => {
    finish({ ...page.starts[0], phase: 'succeeded' });
    await pending;
  });
  assert.equal(page.cancels.length, 2, 'cancel again after delayed admission');
  assert.doesNotMatch(page.document.body.textContent ?? '', /Google sign-in completed/);
});
test('changing saved configuration clears the previous success', async () => {
  const page = await mount();
  await act(async () => page.button('Check connection').click());
  await page.render('generation-1', '/another/agent');
  assert.doesNotMatch(page.document.body.textContent ?? '', /Connection successful/);
});

test('browser failure can retry with a fresh attempt and authenticate independently of check', async () => {
  let count = 0;
  const page = await mount({
    start: async (input) =>
      ++count === 1
        ? { ...input, phase: 'failed', failure: 'browser_failed' }
        : { ...input, phase: 'succeeded' },
  });
  await act(async () => page.button('Sign in with Google').click());
  assert.match(page.document.body.textContent ?? '', /sign-in link could not be opened/i);
  await act(async () => page.button('Retry').click());
  assert.equal(page.starts.length, 2);
  assert.notEqual(page.starts[0].attemptId, page.starts[1].attemptId);
  assert.equal(page.starts[1].action, 'login');
  assert.match(page.document.body.textContent ?? '', /Google sign-in completed/);
});

test('clearing the saved configuration disables setup', async () => {
  const page = await mount();
  await page.render('generation-1', '');
  assert.equal(page.button('Check connection').disabled, true);
  assert.equal(page.button('Sign in with Google').disabled, true);
  assert.equal(page.starts.length, 0);
});

test('changing configuration away and back still invalidates an older attempt', async () => {
  let finish!: (value: ExternalAgentSetupProjection) => void;
  const pending = new Promise<ExternalAgentSetupProjection>((resolve) => {
    finish = resolve;
  });
  const page = await mount({ start: () => pending });
  await act(async () => page.button('Check connection').click());
  await page.render('generation-1', '/another/agent');
  await page.render('generation-1', '/agent/agy_acp_server.par');
  await act(async () => {
    finish({ ...page.starts[0], phase: 'succeeded' });
    await pending;
  });
  assert.doesNotMatch(page.document.body.textContent ?? '', /Connection successful/);
});

test('agent list uses a brand mark and opens a setup detail with a back action', async () => {
  const page = await mount({ list: true });
  assert.equal(page.document.querySelectorAll('input').length, 0);
  assert.match(page.document.querySelector('img')?.getAttribute('src') ?? '', /antigravity.svg/);
  const row = [...page.document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes('Antigravity'),
  )!;
  await act(async () => row.click());
  assert.equal(page.button('Check connection').disabled, false);
  const back = page.document.querySelector<HTMLButtonElement>(
    'button[aria-label="Back to external agents"]',
  );
  assert.ok(back);
  await act(async () => back.click());
  assert.equal(page.document.querySelectorAll('input').length, 0);
});

test('saved program uses the model detail edit row and disables setup while editing', async () => {
  const page = await mount();
  assert.equal(page.document.querySelectorAll('input').length, 0);
  assert.match(page.document.body.textContent ?? '', /Program path/);
  await act(async () => page.button('Change').click());
  assert.equal(page.document.querySelector('input')?.value, '/agent/agy_acp_server.par');
  assert.equal(page.button('Check connection').disabled, true);
  assert.equal(page.button('Sign in with Google').disabled, true);
  await act(async () => page.button('Cancel').click());
  assert.equal(page.document.querySelectorAll('input').length, 0);
  assert.equal(page.button('Check connection').disabled, false);
  assert.equal(page.starts.length, 0);
});

test('first setup explains the separate program and offers the official download', async () => {
  const page = await mount({ executable: '' });
  assert.match(page.document.body.textContent ?? '', /desktop app alone is not enough/);
  const download = page.document.querySelector('a[href*="dl.google.com/agy-extensions/"]');
  assert.ok(download);
  assert.match(download.textContent ?? '', /macOS Apple Silicon/);
  assert.ok(page.document.querySelector('input'));
  assert.equal(page.button('Save').disabled, true);
  assert.equal(page.button('Check connection').disabled, true);
  assert.equal(page.button('Sign in with Google').disabled, true);
});
