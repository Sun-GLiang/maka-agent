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
import { describe, it } from 'node:test';
import {
  nextConversationMessageTimestampRefreshDelay,
  presentConversationMessageTimestamp,
} from '../conversation-message-timestamp.js';

const TODAY_NOW = new Date(2026, 7, 24, 20, 0, 0).getTime();

describe('conversation message timestamp presentation', () => {
  it('shows only the clock for a message on the same local calendar day', () => {
    const timestamp = new Date(2026, 7, 24, 14, 30, 0).getTime();
    const result = presentConversationMessageTimestamp(timestamp, TODAY_NOW, 'zh');

    assert.ok(result);
    assert.equal(result.relation, 'today');
    assert.equal(result.datePrefix, '');
    assert.equal(result.fallbackText, '14:30');
    assert.equal(result.isoDateTime, new Date(timestamp).toISOString());
  });

  it('adds month and day but omits the year across days in the same local year', () => {
    const timestamp = new Date(2026, 7, 23, 14, 30, 0).getTime();
    const result = presentConversationMessageTimestamp(timestamp, TODAY_NOW, 'zh');

    assert.ok(result);
    assert.equal(result.relation, 'same_year');
    assert.equal(result.datePrefix, '8月23日 ');
    assert.equal(result.fallbackText, '8月23日 14:30');
    assert.doesNotMatch(result.fallbackText, /2026/);
  });

  it('adds the year when the local calendar years differ', () => {
    const timestamp = new Date(2025, 7, 23, 14, 30, 0).getTime();
    const result = presentConversationMessageTimestamp(timestamp, TODAY_NOW, 'zh');

    assert.ok(result);
    assert.equal(result.relation, 'other_year');
    assert.equal(result.datePrefix, '2025年8月23日 ');
    assert.equal(result.fallbackText, '2025年8月23日 14:30');
    assert.match(result.absoluteLabel, /2025/);
  });

  it('localizes English date punctuation without putting the current year back', () => {
    const timestamp = new Date(2026, 7, 23, 14, 30, 0).getTime();
    const result = presentConversationMessageTimestamp(timestamp, TODAY_NOW, 'en');

    assert.ok(result);
    assert.equal(result.relation, 'same_year');
    assert.match(result.fallbackText, /Aug 23/);
    assert.doesNotMatch(result.fallbackText, /2026/);
    assert.ok(result.datePrefix.length > 'Aug 23'.length);
  });

  it('uses calendar boundaries instead of elapsed 24-hour buckets', () => {
    const beforeMidnight = new Date(2026, 7, 23, 23, 59, 0).getTime();
    const afterMidnight = new Date(2026, 7, 24, 0, 1, 0).getTime();
    const result = presentConversationMessageTimestamp(beforeMidnight, afterMidnight, 'zh');

    assert.ok(result);
    assert.equal(result.relation, 'same_year');
  });

  it('rejects invalid timestamps and invalid reference clocks', () => {
    assert.equal(presentConversationMessageTimestamp(Number.NaN, TODAY_NOW, 'zh'), undefined);
    assert.equal(
      presentConversationMessageTimestamp(TODAY_NOW, Number.POSITIVE_INFINITY, 'zh'),
      undefined,
    );
  });

  it('schedules the next refresh at the next local midnight', () => {
    const now = new Date(2026, 0, 15, 23, 59, 30).getTime();
    assert.equal(nextConversationMessageTimestampRefreshDelay(now), 30_000);
    assert.equal(nextConversationMessageTimestampRefreshDelay(Number.NaN), null);
  });
});
