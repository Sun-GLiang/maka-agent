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

import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import type { ComposerSlashCommandOption } from '@maka/ui';
import type { getShellCopy } from '../../../locales/shell-copy.js';
import { desktopSlashCommandPresentation } from './slash-command-presentation.js';

type ShellCopy = ReturnType<typeof getShellCopy>['app'];

export function projectDesktopSlashCommands(
  copy: ShellCopy['slashCommands'],
  state: { hasSession: boolean; streaming: boolean },
  readCommands = slashCommandsForSurface,
  present = desktopSlashCommandPresentation,
): ComposerSlashCommandOption[] {
  const presentation = present(copy);
  return readCommands('desktop')
    .filter(
      ({ id, session }) =>
        (session === 'none' || state.hasSession) && !(state.streaming && id === 'compact'),
    )
    .map(({ id }) => ({ id, ...presentation[id] }));
}

export function projectBoundaryUnreadableNotice(
  activeId: string | undefined,
  unreadable: boolean,
  composerHidden: boolean,
  reading: boolean,
  copy: Pick<
    ShellCopy,
    | 'boundaryUnreadableTitle'
    | 'boundaryUnreadableDetail'
    | 'boundaryUnreadableRetry'
    | 'boundaryUnreadableRetrying'
    | 'antigravityHistoryOnlyTitle'
    | 'antigravityHistoryOnlyDetail'
    | 'antigravityHistoryOnlyNewTask'
  >,
  retry: (sessionId: string) => void,
  session?: { executionAvailability?: 'available' | 'history_only' },
  newTask?: () => void,
) {
  if (session?.executionAvailability === 'history_only') {
    return {
      title: copy.antigravityHistoryOnlyTitle,
      detail: copy.antigravityHistoryOnlyDetail,
      retryLabel: copy.antigravityHistoryOnlyNewTask,
      retryPendingLabel: copy.antigravityHistoryOnlyNewTask,
      retryPending: false,
      onRetry: () => newTask?.(),
    };
  }
  if (!activeId || !unreadable || composerHidden) return undefined;
  return {
    title: copy.boundaryUnreadableTitle,
    detail: copy.boundaryUnreadableDetail,
    retryLabel: copy.boundaryUnreadableRetry,
    retryPendingLabel: copy.boundaryUnreadableRetrying,
    retryPending: reading,
    onRetry: () => retry(activeId),
  };
}
