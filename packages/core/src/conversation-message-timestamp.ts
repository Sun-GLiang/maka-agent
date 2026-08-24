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

import { uiLocaleToIntlLocale, type UiLocale } from './ui-locale.js';

export type ConversationMessageDateRelation = 'today' | 'same_year' | 'other_year';

export interface ConversationMessageTimestampPresentation {
  relation: ConversationMessageDateRelation;
  visibleText: string;
  absoluteLabel: string;
  isoDateTime: string;
}

function localDateRelation(date: Date, now: Date): ConversationMessageDateRelation {
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return 'today';
  }
  return date.getFullYear() === now.getFullYear() ? 'same_year' : 'other_year';
}

function visibleFormatOptions(
  relation: ConversationMessageDateRelation,
): Intl.DateTimeFormatOptions {
  const clock: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (relation === 'today') return clock;
  if (relation === 'same_year') {
    return { month: 'short', day: 'numeric', ...clock };
  }
  return { year: 'numeric', month: 'short', day: 'numeric', ...clock };
}

export function presentConversationMessageTimestamp(
  timestamp: number,
  now: number = Date.now(),
  locale: UiLocale = 'zh',
): ConversationMessageTimestampPresentation | undefined {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return undefined;
  const date = new Date(timestamp);
  const nowDate = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(nowDate.getTime())) return undefined;

  const relation = localDateRelation(date, nowDate);
  const intlLocale = uiLocaleToIntlLocale(locale);
  const visibleFormatter = new Intl.DateTimeFormat(intlLocale, visibleFormatOptions(relation));

  return {
    relation,
    visibleText: visibleFormatter.format(date),
    absoluteLabel: new Intl.DateTimeFormat(intlLocale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date),
    isoDateTime: date.toISOString(),
  };
}

export function nextConversationMessageTimestampRefreshDelay(
  now: number = Date.now(),
): number | null {
  if (!Number.isFinite(now)) return null;
  const nextMidnight = new Date(now);
  if (Number.isNaN(nextMidnight.getTime())) return null;
  nextMidnight.setHours(24, 0, 0, 0);
  const delay = nextMidnight.getTime() - now;
  return Number.isFinite(delay) && delay > 0 ? delay : null;
}
