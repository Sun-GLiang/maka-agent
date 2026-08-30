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
import {
  classifySharedSessionTranscriptVisibility,
  SHARED_SESSION_TRANSCRIPT_VISIBILITY_POLICY_VERSION,
  type StoredMessage,
  type SystemNoteMessage,
} from '../session.js';

test('shared transcript visibility is closed over every StoredMessage type', () => {
  const expected = {
    user: 'visible',
    assistant: 'visible',
    tool_call: 'visible',
    tool_result: 'visible',
    turn_state: 'visible',
    token_usage: 'visible',
    permission_decision: 'hidden',
    workhub_coordination: 'hidden',
  } as const satisfies Record<Exclude<StoredMessage['type'], 'system_note'>, 'visible' | 'hidden'>;

  for (const [type, visibility] of Object.entries(expected)) {
    assert.equal(
      classifySharedSessionTranscriptVisibility({
        type: type as Exclude<StoredMessage['type'], 'system_note'>,
      }),
      visibility,
    );
  }
  assert.equal(SHARED_SESSION_TRANSCRIPT_VISIBILITY_POLICY_VERSION, 1);
});

test('shared transcript visibility makes an explicit decision for every system-note kind', () => {
  const expected = {
    session_start: 'hidden',
    session_resume: 'hidden',
    mode_change: 'hidden',
    model_change: 'hidden',
    context_compacted: 'visible',
    context_compaction_failed_open: 'visible',
    step_limit: 'visible',
    error: 'hidden',
    abort: 'hidden',
  } as const satisfies Record<SystemNoteMessage['kind'], 'visible' | 'hidden'>;

  for (const [kind, visibility] of Object.entries(expected)) {
    assert.equal(
      classifySharedSessionTranscriptVisibility({
        type: 'system_note',
        kind: kind as SystemNoteMessage['kind'],
      }),
      visibility,
    );
  }
});
