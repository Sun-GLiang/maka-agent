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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { ConversationMessageTimestamp } from '../conversation-message-timestamp.js';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

afterEach(() => {
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function renderTimestamp(value: number, now: number) {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <ConversationMessageTimestamp value={value} />
      </LocaleProvider>,
    );
    return parseHTML(`<html><body>${markup}</body></html>`).document;
  } finally {
    Date.now = originalNow;
  }
}

test('renders the complete visual timestamp from the UI locale', () => {
  const now = new Date(2026, 7, 24, 20, 0, 0).getTime();
  const value = new Date(2025, 7, 23, 14, 30, 0).getTime();
  const document = renderTimestamp(value, now);
  const presentation = document.querySelector('.maka-message-time-presentation');

  assert.ok(presentation);
  assert.equal(presentation.getAttribute('data-date-relation'), 'other_year');
  const time = presentation.querySelector('time');
  assert.ok(time);
  assert.equal(time.textContent, '2025年8月23日 14:30');
  assert.equal(time.getAttribute('dateTime'), new Date(value).toISOString());
  assert.equal(presentation.querySelector('.maka-message-date-prefix'), null);
  assert.equal(presentation.querySelector('[aria-hidden="true"]') !== null, true);
  assert.match(
    presentation.querySelector('.maka-visually-hidden')?.textContent ?? '',
    /2025/,
  );
});

test('renders only the UI-localized clock for a message from today', () => {
  const now = new Date(2026, 7, 24, 20, 0, 0).getTime();
  const value = new Date(2026, 7, 24, 14, 30, 0).getTime();
  const document = renderTimestamp(value, now);

  assert.equal(
    document.querySelector('.maka-message-time-presentation')?.getAttribute('data-date-relation'),
    'today',
  );
  assert.equal(document.querySelector('time')?.textContent, '14:30');
});

test('TurnView routes original and steering user timestamps through the adapter', () => {
  const now = new Date(2026, 7, 24, 20, 0, 0).getTime();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const turn: TurnViewModel = {
      turnId: 'turn-1',
      status: 'completed',
      partialOutputRetained: false,
      user: {
        id: 'original',
        role: 'user',
        text: 'original request',
        ts: new Date(2026, 7, 24, 14, 30, 0).getTime(),
      },
      tools: [],
      notes: [],
      startedAt: now,
      timeline: [
        {
          kind: 'user',
          message: {
            id: 'steer-1',
            role: 'user',
            text: 'steering request',
            ts: new Date(2025, 7, 23, 14, 30, 0).getTime(),
          },
          messageId: 'steer-1',
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <TurnView turn={turn} />
      </LocaleProvider>,
    );
    const document = parseHTML(`<html><body>${markup}</body></html>`).document;
    assert.deepEqual(
      [...document.querySelectorAll('.maka-message-time-presentation')].map((node) =>
        node.getAttribute('data-date-relation'),
      ),
      ['today', 'other_year'],
    );
  } finally {
    Date.now = originalNow;
  }
});

test('shares one local-midnight timer across mounted timestamps', async () => {
  const start = new Date(2026, 0, 15, 23, 59, 50).getTime();
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const midnightTimers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  let midnightTimerCount = 0;
  let midnightTimerClearCount = 0;
  Date.now = () => start;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 10_000) {
      midnightTimerCount += 1;
      midnightTimers.add(timer);
    }
    return timer;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof globalThis.setTimeout>) => {
    if (midnightTimers.delete(timer)) midnightTimerClearCount += 1;
    return originalClearTimeout(timer);
  }) as typeof globalThis.clearTimeout;

  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(() => {
      root.render(
        <LocaleProvider locale="zh">
          <ConversationMessageTimestamp value={start - 1_000} />
          <ConversationMessageTimestamp value={start - 2_000} />
        </LocaleProvider>,
      );
    });
    assert.equal(midnightTimerCount, 1);

    await act(() => root.render(null));
    assert.equal(midnightTimerClearCount, 1);

    await act(() => {
      root.render(
        <LocaleProvider locale="zh">
          <ConversationMessageTimestamp value={start - 1_000} />
        </LocaleProvider>,
      );
    });
    assert.equal(midnightTimerCount, 2);
  } finally {
    await act(() => root.unmount());
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('rechecks the local day when subscription crosses midnight', async () => {
  const beforeMidnight = new Date(2026, 0, 15, 23, 59, 59, 999).getTime();
  const afterMidnight = new Date(2026, 0, 16, 0, 0, 0).getTime();
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const midnightTimerSentinel = {} as ReturnType<typeof globalThis.setTimeout>;
  let currentNow = beforeMidnight;
  Date.now = () => currentNow;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 1) {
      currentNow = afterMidnight;
      return midnightTimerSentinel;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof globalThis.setTimeout>) => {
    if (timer === midnightTimerSentinel) return;
    return originalClearTimeout(timer);
  }) as typeof globalThis.clearTimeout;

  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(() => {
      root.render(
        <LocaleProvider locale="zh">
          <ConversationMessageTimestamp value={beforeMidnight} />
        </LocaleProvider>,
      );
    });
    assert.equal(
      container.querySelector('.maka-message-time-presentation')?.getAttribute('data-date-relation'),
      'same_year',
    );
  } finally {
    await act(() => root.unmount());
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('reclassifies a mounted timestamp after local midnight', async (context) => {
  const start = new Date(2026, 0, 15, 23, 59, 50).getTime();
  const value = new Date(2026, 0, 15, 23, 59, 30).getTime();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(() => {
      root.render(
        <LocaleProvider locale="zh">
          <ConversationMessageTimestamp value={value} />
        </LocaleProvider>,
      );
    });
    assert.equal(
      container.querySelector('.maka-message-time-presentation')?.getAttribute('data-date-relation'),
      'today',
    );

    await act(() => context.mock.timers.tick(10_000));
    assert.equal(
      container.querySelector('.maka-message-time-presentation')?.getAttribute('data-date-relation'),
      'same_year',
    );
  } finally {
    await act(() => root.unmount());
    context.mock.timers.reset();
  }
});
