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

import { useSyncExternalStore } from 'react';
import {
  nextConversationMessageTimestampRefreshDelay,
  presentConversationMessageTimestamp,
} from '@maka/core/conversation-message-timestamp';
import { useUiLocale } from './locale-context.js';

let midnightRefreshTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
const midnightRefreshListeners = new Set<() => void>();

function scheduleMidnightRefresh() {
  if (midnightRefreshTimer !== undefined || midnightRefreshListeners.size === 0) return;
  const delay = nextConversationMessageTimestampRefreshDelay();
  if (delay === null) return;
  midnightRefreshTimer = globalThis.setTimeout(() => {
    midnightRefreshTimer = undefined;
    for (const listener of midnightRefreshListeners) listener();
    scheduleMidnightRefresh();
  }, delay);
}

function subscribeToMidnightRefresh(listener: () => void) {
  midnightRefreshListeners.add(listener);
  scheduleMidnightRefresh();
  return () => {
    midnightRefreshListeners.delete(listener);
    if (midnightRefreshListeners.size === 0 && midnightRefreshTimer !== undefined) {
      globalThis.clearTimeout(midnightRefreshTimer);
      midnightRefreshTimer = undefined;
    }
  };
}

function getLocalDayStart() {
  const localDay = new Date(Date.now());
  localDay.setHours(0, 0, 0, 0);
  return localDay.getTime();
}

export function ConversationMessageTimestamp(props: { value: number }) {
  const locale = useUiLocale();
  const localDayStart = useSyncExternalStore(
    subscribeToMidnightRefresh,
    getLocalDayStart,
    getLocalDayStart,
  );

  const presentation = presentConversationMessageTimestamp(props.value, localDayStart, locale);
  if (!presentation) return null;

  return (
    <span
      className="maka-message-time-presentation"
      data-date-relation={presentation.relation}
    >
      <span className="maka-message-time-visual" aria-hidden="true">
        <time className="maka-message-time-inline" dateTime={presentation.isoDateTime}>
          {presentation.visibleText}
        </time>
      </span>
      <span className="maka-visually-hidden">{presentation.absoluteLabel}</span>
    </span>
  );
}
