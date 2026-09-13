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

import type {
  ExternalAgentDraftAgentId,
  ExternalAgentDraftModelProjection,
} from '@maka/runtime-host/protocol';
import type { NewTaskExecutionChoice } from '@maka/ui';

interface ExternalAgentDraftPort {
  readonly selectors: {
    readonly externalAgentDraft: {
      readonly draftId?: string;
      readonly configuration?: ExternalAgentDraftModelProjection;
    };
  };
  readonly commands: {
    setExternalAgentDraft(externalAgentId: ExternalAgentDraftAgentId | undefined): void;
    selectExternalAgentDraftModel(value: string): Promise<void>;
    markExternalAgentDraftConsumed(draftId: string): void;
    releaseExternalAgentDraft(draftId: string): Promise<void>;
  };
}

/** Adapts any external-Agent candidate provider to the shell's one draft contract. */
export function bindExternalAgentDraft(
  port: ExternalAgentDraftPort,
  choice: NewTaskExecutionChoice,
) {
  const draft = port.selectors.externalAgentDraft;
  const externalAgentId = choice.executor === 'antigravity' ? 'antigravity' : undefined;
  return {
    choice: {
      ...choice,
      ...(externalAgentId && draft.draftId ? { externalAgentDraftId: draft.draftId } : {}),
    },
    configuration: draft.configuration,
    ready: !externalAgentId || Boolean(draft.draftId),
    selectModel: port.commands.selectExternalAgentDraftModel,
    chatActions: {
      markNewTaskExternalAgentDraftConsumed: port.commands.markExternalAgentDraftConsumed,
      releaseNewTaskExternalAgentDraft: port.commands.releaseExternalAgentDraft,
    },
    select(next: NewTaskExecutionChoice, commit: (value: NewTaskExecutionChoice) => void) {
      port.commands.setExternalAgentDraft(
        next.executor === 'antigravity' ? 'antigravity' : undefined,
      );
      commit(next);
    },
    clear(commit: () => void) {
      port.commands.setExternalAgentDraft(undefined);
      commit();
    },
    composer(
      activeId: string | undefined,
      active: {
        readonly externalAgentModelConfiguration?: Pick<
          ExternalAgentDraftModelProjection,
          'currentValue' | 'options'
        >;
        readonly onExternalAgentModelChange?: (value: string) => void | Promise<void>;
      },
      hardBlocked: boolean,
    ) {
      return {
        externalAgentModelConfiguration: activeId
          ? active.externalAgentModelConfiguration
          : draft.configuration,
        onExternalAgentModelChange: activeId
          ? active.onExternalAgentModelChange
          : port.commands.selectExternalAgentDraftModel,
        sendBlocked: hardBlocked || (!activeId && Boolean(externalAgentId) && !draft.draftId),
      };
    },
  };
}
