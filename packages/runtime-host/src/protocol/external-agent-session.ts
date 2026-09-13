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

import {
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const MODEL_VALUE_MAX_LENGTH = 512;
const MODEL_NAME_MAX_LENGTH = 256;
const MODEL_DESCRIPTION_MAX_LENGTH = 2_048;
const MODEL_OPTION_MAX_ITEMS = 128;
const MODEL_CONFIGURATION_MAX_BYTES = 128 * 1024;

export interface ExternalAgentSessionModelQueryInput {
  readonly sessionId: string;
}

export interface ExternalAgentSessionModelUpdateInput extends ExternalAgentSessionModelQueryInput {
  readonly value: string;
}

export interface ExternalAgentSessionModelOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

export interface ExternalAgentSessionModelProjection {
  readonly sessionId: string;
  readonly acpAgentId: 'antigravity';
  readonly configId: string;
  readonly currentValue: string;
  readonly options: readonly ExternalAgentSessionModelOption[];
}

const errors = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
  'operation_conflict',
  'not_found',
  'session_busy',
] as const;

export const EXTERNAL_AGENT_SESSION_OPERATION_SPECS = {
  'external_agents.session.model.query': defineOperation<
    ExternalAgentSessionModelQueryInput,
    ExternalAgentSessionModelProjection,
    (typeof errors)[number]
  >({
    availability: 'ready',
    errors,
    mode: 'query',
    decodeInput: decodeExternalAgentSessionModelQueryInput,
    decodeOutput: decodeExternalAgentSessionModelProjection,
    assertOutputForInput(input, output) {
      if (input.sessionId !== output.sessionId) {
        throw invalidProtocolFrame('External Agent model changed Session identity');
      }
    },
  }),
  'external_agents.session.model.update': defineOperation<
    ExternalAgentSessionModelUpdateInput,
    ExternalAgentSessionModelProjection,
    (typeof errors)[number]
  >({
    availability: 'ready',
    errors,
    mode: 'command',
    decodeInput: decodeExternalAgentSessionModelUpdateInput,
    decodeOutput: decodeExternalAgentSessionModelProjection,
    assertOutputForInput(input, output) {
      if (input.sessionId !== output.sessionId || input.value !== output.currentValue) {
        throw invalidProtocolFrame('External Agent model update did not commit requested value');
      }
    },
  }),
} as const;

export function decodeExternalAgentSessionModelQueryInput(
  value: unknown,
): ExternalAgentSessionModelQueryInput {
  const input = requireExactRecord(value, 'external Agent Session model query', ['sessionId']);
  return { sessionId: requireEntityId(input.sessionId, 'sessionId') };
}

export function decodeExternalAgentSessionModelUpdateInput(
  value: unknown,
): ExternalAgentSessionModelUpdateInput {
  const input = requireExactRecord(value, 'external Agent Session model update', [
    'sessionId',
    'value',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    value: requireString(input.value, 'model value', MODEL_VALUE_MAX_LENGTH),
  };
}

export function decodeExternalAgentSessionModelProjection(
  value: unknown,
): ExternalAgentSessionModelProjection {
  requireEncodedByteLimit(
    value,
    'external Agent Session model projection',
    MODEL_CONFIGURATION_MAX_BYTES,
  );
  const projection = requireExactRecord(value, 'external Agent Session model projection', [
    'sessionId',
    'acpAgentId',
    'configId',
    'currentValue',
    'options',
  ]);
  if (projection.acpAgentId !== 'antigravity') {
    throw invalidProtocolFrame('Invalid external Agent identity');
  }
  if (!Array.isArray(projection.options) || projection.options.length > MODEL_OPTION_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid external Agent model options');
  }
  const options = projection.options.map((item) => {
    const option = requireShapedRecord(
      item,
      'external Agent model option',
      ['value', 'name'],
      ['description'],
    );
    return {
      value: requireString(option.value, 'model value', MODEL_VALUE_MAX_LENGTH),
      name: requireString(option.name, 'model name', MODEL_NAME_MAX_LENGTH),
      ...(option.description === undefined
        ? {}
        : {
            description: requireString(
              option.description,
              'model description',
              MODEL_DESCRIPTION_MAX_LENGTH,
            ),
          }),
    };
  });
  const currentValue = requireString(
    projection.currentValue,
    'current model value',
    MODEL_VALUE_MAX_LENGTH,
  );
  if (!options.some((option) => option.value === currentValue)) {
    throw invalidProtocolFrame('Current external Agent model is not selectable');
  }
  return {
    sessionId: requireEntityId(projection.sessionId, 'sessionId'),
    acpAgentId: 'antigravity',
    configId: requireString(projection.configId, 'configId', 128),
    currentValue,
    options,
  };
}
