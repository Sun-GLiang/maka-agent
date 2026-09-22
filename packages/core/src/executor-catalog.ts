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
