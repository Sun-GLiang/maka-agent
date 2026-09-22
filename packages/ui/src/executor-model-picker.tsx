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

import type { ReactNode } from 'react';
import { Button } from '@astryxdesign/core';
import { Selector, type SelectorOptionData } from '@astryxdesign/core/Selector';
import type { ExecutorCatalogEntry, ExecutorConfiguration } from '@maka/core/executor-catalog';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import { Plug, Settings, ICON_SIZE } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { renderChatModelPickerOption, renderModelPickerValue } from './model-picker-internals.js';

export interface ExecutorSelection {
  readonly executorId: string;
  readonly configuration: ExecutorConfiguration;
}
export interface ExecutorModelPickerProps {
  catalog: readonly ExecutorCatalogEntry[];
  selection?: ExecutorSelection;
  children?: ReactNode;
  presentation?: 'popover' | 'bottom-sheet' | 'wheel';
  isReadOnly?: boolean;
  fixed?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onSelect(selection: ExecutorSelection | undefined): void;
  onSetup(): void;
  onRetry(): void;
  onNewTask(): void;
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
    title: 'Executor',
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
    title: '执行者',
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
    title: '執行者',
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

const NATIVE = '__maka_native__';
const SETUP = '__maka_setup__';

/** Executor selection is independent of Maka's unchanged native model picker. */
export function ExecutorModelPicker(props: ExecutorModelPickerProps) {
  const locale = useUiLocale();
  const copy = executorCopy(locale);
  const modelCopy = getSharedUiCopy(locale).modelPicker;
  const selected = props.catalog.find((entry) => entry.id === props.selection?.executorId);
  const currentModel = props.selection?.configuration.model ?? selected?.currentModel ?? '';
  const unavailable = !!props.selection && selected?.readiness !== 'ready';
  const models: SelectorOptionData[] = (selected?.models ?? []).map((model) => ({
    value: model.id,
    label: model.name,
    description: model.name !== model.id ? model.id : undefined,
  }));
  if (currentModel && !models.some((model) => model.value === currentModel)) {
    models.unshift({ value: currentModel, label: currentModel, disabled: true });
  }
  const options: SelectorOptionData[] = [
    { value: NATIVE, label: 'Maka' },
    ...props.catalog.map((entry) => ({
      value: entry.id,
      label: entry.displayName,
      icon: <Plug size={ICON_SIZE.control} aria-hidden="true" />,
      description: entry.readiness !== 'ready' ? copy[entry.readiness] : undefined,
    })),
    {
      value: SETUP,
      label: copy.manage,
      icon: <Settings size={ICON_SIZE.control} aria-hidden="true" />,
    },
  ];
  if (props.selection && !selected) {
    options.splice(1, 0, { value: props.selection.executorId, label: props.selection.executorId });
  }
  const presentation = props.presentation === 'wheel' ? 'bottom-sheet' : props.presentation;
  return (
    <>
      <Selector
        label={copy.title}
        isLabelHidden
        options={options}
        value={props.selection?.executorId ?? NATIVE}
        variant="ghost"
        size="sm"
        placement="above"
        presentation={presentation}
        isReadOnly={props.isReadOnly}
        isDisabled={props.disabled || props.fixed}
        disabledMessage={props.fixed ? copy.fixed : undefined}
        className="maka-executor-selector"
        onChange={(value) => {
          if (value === SETUP) props.onSetup();
          else if (value === NATIVE) props.onSelect(undefined);
          else if (value !== props.selection?.executorId) {
            props.onSelect({ executorId: value, configuration: {} });
          }
        }}
      />
      {props.selection ? (
        <Selector
          key={props.selection.executorId}
          label={`${selected?.displayName ?? props.selection.executorId} · ${copy.search}`}
          isLabelHidden
          options={models}
          value={currentModel}
          placeholder={copy.default}
          hasSearch
          searchPlaceholder={modelCopy.searchPlaceholder}
          emptyText={<span className="modelPickerChatOption">{modelCopy.empty}</span>}
          emptySearchText={<span className="modelPickerChatOption">{modelCopy.noResults}</span>}
          variant="ghost"
          size="sm"
          placement="above"
          presentation={presentation}
          isReadOnly={props.isReadOnly}
          isDisabled={
            props.disabled || unavailable || (props.fixed && !selected?.supportsModelChange)
          }
          className="maka-model-switcher-trigger maka-external-model-selector"
          onChange={(model) =>
            props.onSelect({ executorId: props.selection!.executorId, configuration: { model } })
          }
          renderOption={renderChatModelPickerOption}
          renderValue={renderModelPickerValue}
        />
      ) : (
        props.children
      )}
      {(unavailable || props.error) && (
        <span role="status" className="maka-executor-notice">
          {selected && selected.readiness !== 'ready' ? copy[selected.readiness] : copy.unavailable}
          {selected?.readiness === 'history_only' ? (
            <Button label={copy.newTask} variant="ghost" size="sm" onClick={props.onNewTask} />
          ) : (
            <>
              <Button label={copy.manage} variant="ghost" size="sm" onClick={props.onSetup} />
              <Button
                label={copy.retry}
                variant="ghost"
                size="sm"
                isDisabled={props.loading}
                onClick={props.onRetry}
              />
            </>
          )}
        </span>
      )}
    </>
  );
}
