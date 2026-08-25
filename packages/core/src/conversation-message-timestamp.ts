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

type HourCycle = Intl.DateTimeFormatOptions['hourCycle'];

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

function hostHourCycle(): HourCycle | undefined {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
}

function visibleFormatOptions(
  relation: ConversationMessageDateRelation,
  hourCycle: HourCycle | undefined,
): Intl.DateTimeFormatOptions {
  const clock: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    ...(hourCycle === undefined ? {} : { hourCycle }),
  };
  if (relation === 'today') return clock;
  if (relation === 'same_year') {
    return { month: 'short', day: 'numeric', ...clock };
  }
  return { year: 'numeric', month: 'short', day: 'numeric', ...clock };
}

function formatAbsoluteTimestamp(
  date: Date,
  intlLocale: string,
  hourCycle: HourCycle | undefined,
): string {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return date.toISOString();
  }
  return new Intl.DateTimeFormat(intlLocale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(hourCycle === undefined ? {} : { hourCycle }),
  }).format(date);
}

export function formatConversationMessageAbsoluteTimestamp(
  timestamp: number,
  locale: UiLocale,
): string {
  return formatAbsoluteTimestamp(
    new Date(timestamp),
    uiLocaleToIntlLocale(locale),
    hostHourCycle(),
  );
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
  const hourCycle = hostHourCycle();
  const visibleFormatter = new Intl.DateTimeFormat(
    intlLocale,
    visibleFormatOptions(relation, hourCycle),
  );

  return {
    relation,
    visibleText: visibleFormatter.format(date),
    absoluteLabel: formatAbsoluteTimestamp(date, intlLocale, hourCycle),
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
