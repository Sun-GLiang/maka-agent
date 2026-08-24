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

import { useEffect, useState } from 'react';
import { Timestamp } from '@astryxdesign/core';
import {
  nextConversationMessageTimestampRefreshDelay,
  presentConversationMessageTimestamp,
} from '@maka/core/conversation-message-timestamp';
import { useUiLocale } from './locale-context.js';

export function ConversationMessageTimestamp(props: { value: number }) {
  const locale = useUiLocale();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const delay = nextConversationMessageTimestampRefreshDelay(now);
    if (delay === null) return;
    const timer = globalThis.setTimeout(() => setNow(Date.now()), delay);
    return () => globalThis.clearTimeout(timer);
  }, [now]);

  const presentation = presentConversationMessageTimestamp(props.value, now, locale);
  if (!presentation) return null;

  return (
    <span
      className="maka-message-time-presentation"
      data-date-relation={presentation.relation}
    >
      <span className="maka-message-time-visual" aria-hidden="true">
        {presentation.datePrefix ? (
          <span className="maka-message-date-prefix">{presentation.datePrefix}</span>
        ) : null}
        <Timestamp
          className="maka-message-time-inline"
          value={props.value}
          format="time"
        />
      </span>
      <span className="maka-visually-hidden">{presentation.absoluteLabel}</span>
    </span>
  );
}
