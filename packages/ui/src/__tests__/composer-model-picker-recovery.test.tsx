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
import test from 'node:test';
import { type ComponentProps, type ReactNode, act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { SessionSummary } from '@maka/core/session';
import { Composer, type ComposerHandle } from '../composer.js';
import { deriveComposerModelSwitchAvailability } from '../composer-helpers.js';
import { LocaleProvider } from '../locale-context.js';

const choice: ChatModelChoice = {
  connectionId: 'connection-openrouter',
  connectionSlug: 'openrouter',
  connectionName: 'OpenRouter',
  providerType: 'openrouter',
  providerLabel: 'OpenRouter',
  model: 'openai/gpt-5',
  label: 'GPT-5',
  isDefault: true,
  thinkingLevels: [],
};
const secondChoice: ChatModelChoice = {
  ...choice,
  connectionId: 'connection-second',
  connectionSlug: 'second',
  connectionName: 'Second account',
};

async function withComposer(
  run: (context: {
    document: Document;
    window: Window & { Event: typeof Event };
    composer: ReturnType<typeof createRef<ComposerHandle>>;
    render(node: ReactNode): Promise<void>;
  }) => Promise<void>,
) {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const parsed = parseHTML('<div id="root"></div>');
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & { Event: typeof Event };
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const composer = createRef<ComposerHandle>();

  try {
    await run({
      document,
      window,
      composer,
      render: async (node) => {
        await act(() => root.render(<LocaleProvider locale="en">{node}</LocaleProvider>));
      },
    });
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
}

function click(window: Window & { Event: typeof Event }, element: Element | null | undefined) {
  element?.dispatchEvent(new window.Event('click', { bubbles: true }));
}

test('model switch availability has one priority-ordered contract', () => {
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({ streaming: true, sessionStatus: 'running', pending: true }),
    { available: false, pending: true, reason: 'streaming' },
  );
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({ sessionStatus: 'running', pending: true }),
    { available: false, pending: true, reason: 'running' },
  );
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({ sessionStatus: 'waiting_for_user', pending: true }),
    { available: false, pending: true, reason: 'permission' },
  );
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({ pending: true }),
    { available: false, pending: true, reason: 'pending' },
  );
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({}),
    { available: true, pending: false },
  );
});

test('the recovery handle opens the existing exact account-and-model picker', async () => {
  await withComposer(async ({ document, window, composer, render }) => {
    let selected:
      | Parameters<NonNullable<ComponentProps<typeof Composer>['onModelChange']>>[0]
      | undefined;
    await render(
      <Composer
        ref={composer}
        activeSession={{
          id: 'legacy-session',
          llmConnectionSlug: 'openrouter',
          model: 'openai/gpt-5',
        } as SessionSummary}
        modelChoices={[choice]}
        hideUnavailableCurrentModel
        onModelChange={(input) => { selected = input; }}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    await act(() => composer.current?.openModelPicker());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.equal(items.length, 1, 'the stale legacy target is hidden during identity recovery');
    await act(() => click(window, items[0]));
    assert.deepEqual(selected, {
      llmConnectionId: choice.connectionId,
      llmConnectionSlug: choice.connectionSlug,
      model: choice.model,
    });
  });
});

test('an unavailable current model is display-only in the active-session menu', async () => {
  await withComposer(async ({ document, composer, render }) => {
    await render(
      <Composer
        ref={composer}
        activeSession={{
          id: 'legacy-session',
          llmConnectionId: 'removed-connection',
          llmConnectionSlug: 'removed',
          model: 'removed-model',
        } as SessionSummary}
        activeModelLabel="Removed model"
        modelChoices={[choice]}
        onModelChange={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    await act(() => composer.current?.openModelPicker());
    const unavailable = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.includes('Removed model'));
    assert.ok(unavailable);
    assert.equal(unavailable.getAttribute('aria-disabled'), 'true');
  });
});

test('an active Maka session selects another exact model without sending', async () => {
  await withComposer(async ({ document, window, composer, render }) => {
    let selected:
      | Parameters<NonNullable<ComponentProps<typeof Composer>['onModelChange']>>[0]
      | undefined;
    let sends = 0;
    await render(
      <Composer
        ref={composer}
        activeSession={{
          id: 'menu-session',
          llmConnectionId: choice.connectionId,
          llmConnectionSlug: choice.connectionSlug,
          model: choice.model,
        } as SessionSummary}
        modelChoices={[choice, secondChoice]}
        onModelChange={(input) => { selected = input; }}
        onSend={() => { sends += 1; }}
        onStop={() => undefined}
      />,
    );

    await act(() => composer.current?.openModelPicker());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    await act(() => click(window, items[1]));
    assert.deepEqual(selected, {
      llmConnectionId: secondChoice.connectionId,
      llmConnectionSlug: secondChoice.connectionSlug,
      model: secondChoice.model,
    });
    assert.equal(sends, 0);
  });
});

test('a new Maka task uses the boxed model menu and commits one complete target', async () => {
  await withComposer(async ({ document, window, composer, render }) => {
    const changes: unknown[] = [];
    await render(
      <Composer
        ref={composer}
        modelLabel={choice.label}
        modelChoices={[choice, secondChoice]}
        newTaskExecutionChoice={{
          executor: 'maka',
          makaModel: {
            llmConnectionId: choice.connectionId,
            llmConnectionSlug: choice.connectionSlug,
            model: choice.model,
          },
        }}
        onNewTaskExecutionChoiceChange={(next) => { changes.push(next); }}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    assert.ok(document.querySelector('button[aria-label="Choose executor"]'));
    const trigger = document.querySelector<HTMLButtonElement>(
      'button.maka-new-chat-model-selector[aria-haspopup="menu"]',
    );
    assert.ok(trigger);
    await act(() => click(window, trigger));
    assert.equal(document.querySelectorAll('.maka-model-wheel-viewport').length, 0);
    const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    await act(async () => {
      click(window, options[1]);
      await Promise.resolve();
    });
    assert.deepEqual(changes, [{
      executor: 'maka',
      makaModel: {
        llmConnectionId: secondChoice.connectionId,
        llmConnectionSlug: secondChoice.connectionSlug,
        model: secondChoice.model,
      },
    }]);
  });
});

test('an external Agent session reuses the boxed model menu', async () => {
  await withComposer(async ({ document, window, composer, render }) => {
    let selected: string | undefined;
    await render(
      <Composer
        ref={composer}
        activeSession={{
          id: 'acp-session',
          backend: 'acp',
          externalAgentId: 'antigravity',
          lastMessageAt: 1,
        } as SessionSummary}
        modelChoices={[choice]}
        externalAgentModelConfiguration={{
          currentValue: 'gemini-3.7-flash-high',
          options: [
            { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
            { value: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
          ],
        }}
        onExternalAgentModelChange={(value) => { selected = value; }}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    await act(() => composer.current?.openModelPicker());
    const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.equal(document.querySelectorAll('.maka-model-wheel-viewport').length, 0);
    assert.equal(options.length, 2);
    assert.equal(options.some((item) => item.textContent?.includes('GPT-5')), false);
    await act(async () => {
      click(window, options[1]);
      await Promise.resolve();
    });
    assert.equal(selected, 'gemini-3.1-pro-preview');
  });
});

test('a new Antigravity task can choose an Agent model before the first send', async () => {
  await withComposer(async ({ document, window, composer, render }) => {
    let selected: string | undefined;
    await render(
      <Composer
        ref={composer}
        newTaskExecutionChoice={{
          executor: 'antigravity',
          makaModel: {
            llmConnectionId: choice.connectionId,
            llmConnectionSlug: choice.connectionSlug,
            model: choice.model,
          },
        }}
        onNewTaskExecutionChoiceChange={() => undefined}
        externalAgentModelConfiguration={{
          currentValue: 'gemini-3.7-flash-high',
          options: [
            { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
            { value: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
          ],
        }}
        onExternalAgentModelChange={(value) => { selected = value; }}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );

    await act(() => composer.current?.openModelPicker());
    const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.equal(options.length, 2);
    await act(async () => {
      click(window, options[1]);
      await Promise.resolve();
    });
    assert.equal(selected, 'gemini-3.1-pro-preview');
  });
});
