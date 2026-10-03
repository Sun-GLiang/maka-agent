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

import type { IPage } from '@jackwener/opencli/types';
import { browserObservationPage } from './browser-observation-world.js';
import {
  BROWSER_ACTION_TARGET_CHANGED,
  browserActionValidationJs,
  browserObservationJs,
  type BrowserObservation,
} from './browser-observation.js';

interface BrowserTargetActionResult<T> {
  outcome?: T;
  diagnostics?: BrowserObservation;
  stopped?: boolean;
}

interface BrowserTargetActionOptions {
  sessionId: string;
  abortSignal?: AbortSignal;
  typing?: boolean;
}

// OpenCLI shares its resolved-element slot across a page's action steps. Keep
// concurrent click/type calls in one conversation from overwriting each other.
const actionQueues = new Map<string, Promise<void>>();

export async function runBrowserTargetAction<T>(
  page: IPage,
  ref: string,
  action: (page: IPage, ref: string) => Promise<T>,
  options: BrowserTargetActionOptions,
): Promise<BrowserTargetActionResult<T>> {
  const previous = actionQueues.get(options.sessionId) ?? Promise.resolve();
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => finished);
  actionQueues.set(options.sessionId, tail);
  try {
    await previous;
    options.abortSignal?.throwIfAborted();
    return await actOnBrowserTarget(page, ref, action, options.typing ?? false);
  } finally {
    release();
    if (actionQueues.get(options.sessionId) === tail) actionQueues.delete(options.sessionId);
  }
}

/** Pin a unique CSS target, then preserve its identity throughout OpenCLI's transport. */
async function actOnBrowserTarget<T>(
  page: IPage,
  ref: string,
  action: (page: IPage, ref: string) => Promise<T>,
  typing: boolean,
): Promise<BrowserTargetActionResult<T>> {
  // Legacy numbered refs keep OpenCLI's shadow/iframe-aware resolver.
  if (/^\d+$/.test(ref)) return { outcome: await action(page, ref) };
  page = await browserObservationPage(page);
  const observation = await page.evaluate<BrowserObservation>(browserObservationJs({
    selector: ref, visibleOnly: false, maxElements: 8,
  }));
  const candidate = observation.candidates[0];
  if (ref.trim().startsWith('[data-maka-browser-ref=') && observation.matchCount === 1 && candidate?.ref !== ref.trim()) {
    observation.error = 'The ref is stale: its element was replaced or the document reference state changed.';
  }
  if (observation.error || observation.matchCount !== 1 || !candidate?.visible || !candidate.enabled || (typing && candidate.readOnly)) {
    if (observation.matchCount === 0 && !observation.error) {
      const nearby = await page.evaluate<BrowserObservation>(browserObservationJs({ maxElements: 12 }));
      observation.candidates = nearby.candidates;
      observation.error = 'No target matched. The ref may be stale after reload/navigation; these are current visible controls.';
    }
    return { diagnostics: observation };
  }
  const validation = browserActionValidationJs(candidate.ref, typing, { hitTest: !typing });
  let pressedMouse: Record<string, unknown> | undefined;
  let invalidated = false;
  const checkedPage = new Proxy(page, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver);
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        try {
          if (invalidated) throw new Error(BROWSER_ACTION_TARGET_CHANGED);
          if (key === 'evaluate' && typeof args[0] === 'string') {
            // Check identity in the same JS turn as each resolver/action step.
            args[0] = `${validation};\n${args[0]}`;
          } else if (key === 'nativeClick' || key === 'nativeType' || key === 'pressKey' ||
            (key === 'cdp' && /^(Input\.|DOM\.(focus|scrollIntoViewIfNeeded)$)/.test(String(args[0])))) {
            const event = args[1] as Record<string, unknown> | undefined;
            const focus = typing && (key === 'nativeType' || key === 'pressKey' ||
              (key === 'cdp' && (args[0] === 'Input.insertText' || args[0] === 'Input.dispatchKeyEvent')));
            const point = key === 'nativeClick' ? { x: Number(args[0]), y: Number(args[1]) }
              : key === 'cdp' && args[0] === 'Input.dispatchMouseEvent' && event?.type !== 'mouseMoved'
                ? { x: Number(event?.x), y: Number(event?.y) } : undefined;
            const checkedPoint = await page.evaluate<{ x: number; y: number } | undefined>(
              browserActionValidationJs(candidate.ref, typing, { focus, point, targetCenter: key === 'nativeClick' }),
            );
            if (key === 'nativeClick' && checkedPoint) args = [checkedPoint.x, checkedPoint.y];
          }
          // The receiver keeps nested OpenCLI evaluation and CDP calls guarded.
          const value = await Reflect.apply(member, receiver, args);
          if (key === 'cdp' && args[0] === 'Input.dispatchMouseEvent') {
            const event = args[1] as Record<string, unknown>;
            if (event.type === 'mousePressed') pressedMouse = event;
            if (event.type === 'mouseReleased') pressedMouse = undefined;
          }
          return value;
        } catch (error) {
          // OpenCLI catches native transport errors and tries a JS fallback.
          // A rejected actual receiver must stop that fallback as well.
          if (error instanceof Error && error.message.includes(BROWSER_ACTION_TARGET_CHANGED)) invalidated = true;
          throw error;
        }
      };
    },
  }) as IPage;
  try {
    if (!typing) {
      // Bring offscreen controls into view before enforcing hit-testing on every
      // OpenCLI evaluation, including its DOM click fallback. Identity validation
      // and scrolling share one JS turn; later layout changes stop the action.
      await page.evaluate(`${browserActionValidationJs(candidate.ref)};
        document.querySelector(${JSON.stringify(candidate.ref)}).scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });`);
    }
    return { outcome: await action(checkedPage, candidate.ref) };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(BROWSER_ACTION_TARGET_CHANGED)) throw error;
    // A pointer-down handler may replace the target before mouse-up. Release
    // outside the page instead of leaving the physical button held or clicking
    // a replacement node. Origin/visibility admission still guards this cleanup.
    const nativePage = page as IPage & { cdp?: (method: string, params: Record<string, unknown>) => Promise<unknown> };
    if (pressedMouse && nativePage.cdp) {
      await nativePage.cdp('Input.dispatchMouseEvent', { ...pressedMouse, type: 'mouseReleased', x: -1, y: -1, clickCount: 0 });
    }
    // Navigation may have destroyed the action's isolated context. Observe the
    // current document for recovery, without retrying any mutation there.
    const diagnostics = await (await browserObservationPage(page)).evaluate<BrowserObservation>(browserObservationJs({ maxElements: 12 }));
    diagnostics.error = 'The target changed, became hidden/disabled, was replaced, or lost native focus/hit-testing during the action.';
    return { diagnostics, stopped: true };
  }
}
