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
import { BROWSER_ACTION_TARGET_CHANGED } from './browser-observation.js';

interface CdpPage extends IPage {
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Keep observation identity and OpenCLI's resolved element in an isolated world.
 * DOM attributes are shared with the site; JavaScript objects and prototypes are
 * not. Never fall back to the main world if the context is lost or unavailable.
 * Resolve the current top frame on every invocation so navigation cannot reuse
 * an old document's authority. A named world preserves refs between observations.
 * All CDP calls still pass through the caller's Origin and session admission.
 */
export async function browserObservationPage(page: IPage): Promise<IPage> {
  const cdpPage = page as CdpPage;
  if (typeof cdpPage.cdp !== 'function') {
    throw new Error('Structured browser observations require an isolated CDP execution context.');
  }
  const tree = await cdpPage.cdp('Page.getFrameTree') as { frameTree: { frame: { id: string } } };
  const world = await cdpPage.cdp('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: 'maka-browser-observation',
  }) as { executionContextId: number };
  if (!Number.isInteger(world.executionContextId) || world.executionContextId <= 0) {
    // Omitting contextId would silently execute in the page's main world.
    throw new Error('The browser did not provide an isolated execution context.');
  }
  return new Proxy(page, {
    get(target, key, receiver) {
      if (key === 'evaluate') {
        return async (expression: string) => {
          const result = await cdpPage.cdp('Runtime.evaluate', {
            expression,
            contextId: world.executionContextId,
            returnByValue: true,
            awaitPromise: true,
          }).catch((error: unknown) => {
            if (error instanceof Error && /Cannot find context|Execution context was destroyed/.test(error.message)) {
              // Treat document loss like node replacement. The action layer must
              // still release a held mouse button; never retry the old script.
              throw new Error(BROWSER_ACTION_TARGET_CHANGED, { cause: error });
            }
            throw error;
          }) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
          if (result.exceptionDetails) {
            throw new Error('Evaluate error: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Unknown exception'));
          }
          return result.result?.value;
        };
      }
      const member = Reflect.get(target, key, receiver);
      // Preserve this receiver for nested OpenCLI evaluate/CDP calls.
      return typeof member === 'function'
        ? (...args: unknown[]) => Reflect.apply(member, receiver, args)
        : member;
    },
  });
}
