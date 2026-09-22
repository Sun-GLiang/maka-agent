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

import { useState, useEffect, type KeyboardEvent, type ReactNode } from 'react';
import { Popover, Button } from '@astryxdesign/core';
import type { ExecutorCatalogEntry, ExecutorConfiguration } from '@maka/core/executor-catalog';
import type { ProviderType } from '@maka/core/llm-connections';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import { Plug, ICON_SIZE } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { modelMenuGroups } from './chat-model-helpers.js';

export interface ExecutorSelection {
  readonly executorId: string;
  readonly configuration: ExecutorConfiguration;
}
export interface ExecutorModelPickerProps {
  catalog: readonly ExecutorCatalogEntry[];
  selection?: ExecutorSelection;
  nativeLabel: string;
  choices: readonly ChatModelChoice[];
  fixed?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onSelect(selection: ExecutorSelection | undefined): void;
  onNative(input: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }): void | Promise<void>;
  onSetup(): void;
  onRetry(): void;
  onNewTask(): void;
  renderProviderMark?(type: ProviderType): ReactNode;
}

interface ExecutorCopy {
  title: string;
  nativeOperations: string;
  search: string;
  manage: string;
  default: string;
  loading: string;
  unavailable: string;
  authentication_required: string;
  history_only: string;
  fixed: string;
  attachments: string;
  retry: string;
  newTask: string;
}

const EXECUTOR_COPY = {
  en: {
    title: 'Executor and model',
    nativeOperations: 'This operation requires Maka. Start a new Maka task.',
    search: 'Search models',
    manage: 'Manage external agents',
    default: 'Agent default',
    loading: 'Loading models…',
    unavailable: 'Unavailable. Check setup and retry.',
    authentication_required: 'Sign in from External Agents settings.',
    history_only:
      'The external process was lost. History is readable; start a new task to continue.',
    fixed: 'Start a new task to switch executors.',
    attachments:
      'This executor does not support these attachments. Remove them or select Maka. Your draft is preserved.',
    retry: 'Retry',
    newTask: 'New task',
  },
  'zh-CN': {
    title: '执行者与模型',
    nativeOperations: '此操作仅支持 Maka。请新建 Maka 任务。',
    search: '搜索模型',
    manage: '管理外部 Agent',
    default: 'Agent 默认',
    loading: '正在读取模型…',
    unavailable: '当前不可用，请检查设置后重试。',
    authentication_required: '需要登录，请前往外部 Agent 设置。',
    history_only: '外部进程已丢失。历史仍可阅读，请新建任务继续。',
    fixed: '切换执行者需要新建任务。',
    attachments: '此执行者不支持这些附件。请移除附件或选择 Maka，草稿会保留。',
    retry: '重试',
    newTask: '新建任务',
  },
  'zh-TW': {
    title: '執行者與模型',
    nativeOperations: '此操作僅支援 Maka。請建立 Maka 任務。',
    search: '搜尋模型',
    manage: '管理外部 Agent',
    default: 'Agent 預設',
    loading: '正在讀取模型…',
    unavailable: '目前無法使用，請檢查設定後重試。',
    authentication_required: '需要登入，請前往外部 Agent 設定。',
    history_only: '外部程序已遺失。歷史仍可閱讀，請建立新任務繼續。',
    fixed: '切換執行者需要建立新任務。',
    attachments: '此執行者不支援這些附件。請移除附件或選擇 Maka，草稿會保留。',
    retry: '重試',
    newTask: '建立新任務',
  },
} satisfies UiCatalog<ExecutorCopy>;

export function executorCopy(locale: UiLocale): ExecutorCopy {
  return EXECUTOR_COPY[locale];
}

export function ExecutorModelPicker(props: ExecutorModelPickerProps) {
  const locale = useUiLocale();
  const copy = executorCopy(locale);
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState(props.selection?.executorId ?? '');
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);
  const selected = props.catalog.find((entry) => entry.id === props.selection?.executorId);
  const provider = props.catalog.find((entry) => entry.id === browsing);
  const selectedModel = props.selection?.configuration.model;
  const label = props.selection
    ? `${selected?.displayName ?? props.selection.executorId} · ${selected?.models.find((model) => model.id === (selectedModel ?? selected?.currentModel))?.name ?? selectedModel ?? selected?.currentModel ?? copy.default}`
    : props.nativeLabel;
  const choose = (selection: ExecutorSelection | undefined) => {
    props.onSelect(selection);
    setOpen(false);
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
      (event.target as HTMLElement).tagName === 'INPUT'
    )
      return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    ];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  const unavailable = props.selection && selected?.readiness !== 'ready';
  return (
    <div className="maka-executor-control">
      <Popover
        placement="above"
        label={copy.title}
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setBrowsing(props.selection?.executorId ?? '');
            setSearch('');
          }
        }}
        isEnabled={!props.disabled}
        width="min(540px, calc(100vw - 32px))"
        content={
          <div className="maka-executor-picker" onKeyDown={navigate}>
            <nav aria-label={copy.title} className="maka-executor-rail">
              <button
                type="button"
                aria-pressed={!browsing}
                disabled={props.fixed && !!props.selection}
                onClick={() => setBrowsing('')}
              >
                Maka
              </button>
              {props.catalog.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  aria-pressed={browsing === entry.id}
                  disabled={props.fixed && props.selection?.executorId !== entry.id}
                  onClick={() => setBrowsing(entry.id)}
                >
                  {entry.displayName}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onSetup();
                }}
              >
                {copy.manage}
              </button>
              {props.fixed && <small>{copy.fixed}</small>}
            </nav>
            <div className="maka-executor-models">
              <input
                aria-label={copy.search}
                placeholder={copy.search}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {props.loading && <p role="status">{copy.loading}</p>}
              {browsing ? (
                provider?.readiness === 'ready' ? (
                  <div role="group" aria-label={provider.displayName}>
                    {!props.fixed && (
                      <button
                        type="button"
                        onClick={() => choose({ executorId: provider.id, configuration: {} })}
                      >
                        {copy.default}
                        {provider.currentModel
                          ? ` · ${provider.models.find((model) => model.id === provider.currentModel)?.name ?? provider.currentModel}`
                          : ''}
                      </button>
                    )}
                    {provider.models
                      .filter((model) =>
                        `${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((model) => (
                        <button
                          type="button"
                          key={model.id}
                          aria-pressed={
                            props.selection?.executorId === provider.id &&
                            selectedModel === model.id
                          }
                          disabled={props.fixed && !provider.supportsModelChange}
                          onClick={() =>
                            choose({ executorId: provider.id, configuration: { model: model.id } })
                          }
                        >
                          {model.name}
                        </button>
                      ))}
                  </div>
                ) : (
                  <div role="status">
                    <p>{provider ? copy[provider.readiness] : copy.unavailable}</p>
                    <button type="button" disabled={props.loading} onClick={props.onRetry}>
                      {copy.retry}
                    </button>
                  </div>
                )
              ) : (
                modelMenuGroups([...props.choices], locale).map((group) => (
                  <div key={group.heading} role="group" aria-label={group.heading}>
                    <small>
                      {props.renderProviderMark?.(group.providerType)}
                      {group.heading}
                    </small>
                    {group.choices
                      .filter((choice) =>
                        `${choice.label} ${choice.model}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map((choice) => (
                        <button
                          type="button"
                          key={`${choice.connectionId}/${choice.model}`}
                          onClick={() => {
                            void props.onNative({
                              llmConnectionId: choice.connectionId,
                              llmConnectionSlug: choice.connectionSlug,
                              model: choice.model,
                            });
                            choose(undefined);
                          }}
                        >
                          {choice.label}
                        </button>
                      ))}
                  </div>
                ))
              )}
            </div>
          </div>
        }
      >
        <Button
          label={label}
          icon={props.selection ? <Plug size={ICON_SIZE.control} aria-hidden="true" /> : undefined}
          variant="ghost"
          size="sm"
        />
      </Popover>
      {unavailable && (
        <span role="status" className="maka-executor-notice">
          {selected ? copy[selected.readiness] : copy.unavailable}
          {selected?.readiness === 'history_only' ? (
            <button type="button" onClick={props.onNewTask}>
              {copy.newTask}
            </button>
          ) : (
            <>
              <button type="button" onClick={props.onSetup}>
                {copy.manage}
              </button>
              <button type="button" disabled={props.loading} onClick={props.onRetry}>
                {copy.retry}
              </button>
            </>
          )}
        </span>
      )}
      {props.error && (
        <span role="alert">
          {copy.unavailable}
          <button type="button" onClick={props.onRetry}>
            {copy.retry}
          </button>
        </span>
      )}
    </div>
  );
}
