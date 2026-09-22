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

import { isExecutorId } from './executor-id.js';

/** Provider-owned choices; no model Connection or external protocol identity crosses this seam. */
export interface ExecutorConfiguration {
  readonly model?: string;
}

export type ExecutorReadiness =
  | 'ready'
  | 'unavailable'
  | 'authentication_required'
  | 'history_only';

export interface ExecutorModelChoice {
  readonly id: string;
  readonly name: string;
}

export interface ExecutorCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly readiness: ExecutorReadiness;
  readonly models: readonly ExecutorModelChoice[];
  readonly currentModel?: string;
  readonly supportsAttachments: boolean;
  readonly supportsModelChange: boolean;
  readonly message?: string;
}

export function isExecutorConfiguration(value: unknown): value is ExecutorConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === 'model') &&
    (record.model === undefined ||
      (typeof record.model === 'string' &&
        record.model.length > 0 &&
        record.model.length <= 1024 &&
        !/[\0\r\n]/u.test(record.model)))
  );
}

export function normalizeCatalogEntry(
  value: ExecutorCatalogEntry,
  id: string,
): ExecutorCatalogEntry {
  if (
    !value ||
    !isExecutorId(id) ||
    value.id !== id ||
    !isCatalogText(value.displayName) ||
    !['ready', 'unavailable', 'authentication_required', 'history_only'].includes(
      value.readiness,
    ) ||
    !Array.isArray(value.models) ||
    value.models.length > 256 ||
    !Array.from(value.models).every(
      (model) =>
        model &&
        isExecutorConfiguration({ model: model.id }) &&
        typeof model.id === 'string' &&
        isCatalogText(model.name),
    ) ||
    new Set(value.models.map((model) => model.id)).size !== value.models.length ||
    !isExecutorConfiguration({ model: value.currentModel }) ||
    (value.message !== undefined && !isCatalogText(value.message)) ||
    typeof value.supportsAttachments !== 'boolean' ||
    typeof value.supportsModelChange !== 'boolean'
  )
    throw new TypeError('Executor catalog is invalid');
  return Object.freeze({
    id,
    displayName: value.displayName,
    readiness: value.readiness,
    models: Object.freeze(value.models.map(({ id, name }) => Object.freeze({ id, name }))),
    ...(value.currentModel !== undefined ? { currentModel: value.currentModel } : {}),
    ...(value.message !== undefined ? { message: value.message } : {}),
    supportsAttachments: value.supportsAttachments,
    supportsModelChange: value.supportsModelChange,
  });
}

function isCatalogText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8_192 && !/[\0\r]/u.test(value);
}
