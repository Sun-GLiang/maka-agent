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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptReadingPosition } from '../../renderer/features/conversation/index.js';

test('history loading validates the event-time range before changing UI state', async () => {
  let range = {
    sessionId: 'session-a',
    hasOlder: false,
    hasNewer: true,
    newestSequence: 10,
  };
  let loads = 0;
  let anchorChanges = 0;
  let current = true;
  const controller = {
    store: { range: () => range },
    loadBefore: async () => undefined,
    loadAround: async () => undefined,
    loadLatest: async () => { loads += 1; },
  };
  const loading = { current: false };
  let pending: Parameters<typeof transcriptReadingPosition.loadView>[0];
  const request = () => transcriptReadingPosition.loadHistory({
    controller,
    sessionId: 'session-a',
    target: 'latest',
    maxBytes: 512,
    loading,
    setPending: (next) => { pending = next; },
    onReadingAnchorChange: () => { anchorChanges += 1; },
    isCurrent: () => current,
    onError: () => assert.fail('a skipped load cannot fail'),
  });
  range = { ...range, hasNewer: false };

  assert.equal(request(), true);
  range = { ...range, sessionId: 'session-b' };
  assert.equal(request(), false);
  range = { ...range, sessionId: 'session-a' };
  current = false;
  assert.equal(request(), false);

  assert.equal(loads, 0);
  assert.equal(anchorChanges, 0);
  assert.equal(loading.current, false);
  assert.equal(pending, undefined);
});

test('one history load blocks gap actions across a session switch without moving the spinner', async () => {
  const pending = deferred();
  const cleared = deferred();
  const loading = { current: false };
  let pendingState: Parameters<typeof transcriptReadingPosition.loadView>[0];
  let loads = 0;
  const controller = {
    store: {
      range: () => ({
        sessionId: 'session-a',
        hasOlder: false,
        hasNewer: true,
        newestSequence: 10,
      }),
    },
    loadBefore: async () => undefined,
    loadAround: async () => undefined,
    loadLatest: async () => {
      loads += 1;
      await pending.promise;
    },
  };
  const request = (sessionId: string, target: 'newer' | 'latest') =>
    transcriptReadingPosition.loadHistory({
      controller,
      sessionId,
      target,
      maxBytes: 512,
      loading,
      setPending: (next) => {
        pendingState = next;
        if (!next) cleared.resolve();
      },
      onReadingAnchorChange: () => undefined,
      isCurrent: () => true,
      onError: () => assert.fail('the controlled load cannot fail'),
    });
  assert.equal(request('session-a', 'latest'), true);
  assert.equal(loads, 1);
  assert.deepEqual(transcriptReadingPosition.loadView(pendingState, 'session-a'), {
    blocked: true,
    pendingDirection: 'newer',
  });

  assert.deepEqual(transcriptReadingPosition.loadView(pendingState, 'session-b'), {
    blocked: true,
    pendingDirection: undefined,
  });
  assert.equal(request('session-b', 'newer'), false);
  assert.equal(loads, 1);

  pending.resolve();
  await cleared.promise;
  assert.deepEqual(transcriptReadingPosition.loadView(pendingState, 'session-b'), {
    blocked: false,
    pendingDirection: undefined,
  });
});
