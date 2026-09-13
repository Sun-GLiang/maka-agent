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

import type { ExternalAgentId } from '@maka/core/session';
import { requireEntityId, requireExactRecord, requireString } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { decodeExternalAgentSessionModelProjection } from './external-agent-session.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';
import { decodeWorkspaceTarget, type WorkspaceTarget } from './workspace.js';

export type ExternalAgentDraftAgentId = ExternalAgentId;

export interface ExternalAgentDraftModelPrepareInput {
  readonly draftId: string;
  readonly externalAgentId: ExternalAgentDraftAgentId;
  readonly workspace: WorkspaceTarget;
}

export interface ExternalAgentDraftModelUpdateInput {
  readonly draftId: string;
  readonly value: string;
}

export interface ExternalAgentDraftReleaseInput {
  readonly draftId: string;
}

export interface ExternalAgentDraftModelProjection {
  readonly draftId: string;
  readonly externalAgentId: ExternalAgentDraftAgentId;
  readonly configId: string;
  readonly currentValue: string;
  readonly options: readonly {
    readonly value: string;
    readonly name: string;
    readonly description?: string;
  }[];
}

export interface ExternalAgentDraftReleaseProjection {
  readonly draftId: string;
  readonly released: boolean;
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

export const EXTERNAL_AGENT_DRAFT_OPERATION_SPECS = {
  'external_agents.draft.model.prepare': defineHostPathOperation<
    ExternalAgentDraftModelPrepareInput,
    ExternalAgentDraftModelProjection,
    (typeof errors)[number]
  >(
    {
      availability: 'ready',
      errors,
      mode: 'command',
      decodeInput: decodeExternalAgentDraftModelPrepareInput,
      decodeOutput: decodeExternalAgentDraftModelProjection,
      assertOutputForInput(input, output) {
        assertDraftIdentity(input, output);
        if (input.externalAgentId !== output.externalAgentId) {
          throw invalidProtocolFrame('External Agent draft changed Agent identity');
        }
      },
    },
    (input) => input.workspace.kind === 'host_path',
  ),
  'external_agents.draft.model.update': defineOperation<
    ExternalAgentDraftModelUpdateInput,
    ExternalAgentDraftModelProjection,
    (typeof errors)[number]
  >({
    availability: 'ready',
    errors,
    mode: 'command',
    decodeInput: decodeExternalAgentDraftModelUpdateInput,
    decodeOutput: decodeExternalAgentDraftModelProjection,
    assertOutputForInput(input, output) {
      assertDraftIdentity(input, output);
      if (input.value !== output.currentValue) {
        throw invalidProtocolFrame(
          'External Agent draft model update did not commit requested value',
        );
      }
    },
  }),
  'external_agents.draft.release': defineOperation<
    ExternalAgentDraftReleaseInput,
    ExternalAgentDraftReleaseProjection,
    (typeof errors)[number]
  >({
    availability: 'ready',
    errors,
    mode: 'control',
    decodeInput: decodeExternalAgentDraftReleaseInput,
    decodeOutput: decodeExternalAgentDraftReleaseProjection,
    assertOutputForInput: assertDraftIdentity,
  }),
} as const;

export function decodeExternalAgentDraftModelPrepareInput(
  value: unknown,
): ExternalAgentDraftModelPrepareInput {
  const input = requireExactRecord(value, 'external Agent draft model prepare input', [
    'draftId',
    'externalAgentId',
    'workspace',
  ]);
  return {
    draftId: requireEntityId(input.draftId, 'draftId'),
    externalAgentId: decodeExternalAgentDraftAgentId(input.externalAgentId),
    workspace: decodeWorkspaceTarget(input.workspace),
  };
}

export function decodeExternalAgentDraftModelUpdateInput(
  value: unknown,
): ExternalAgentDraftModelUpdateInput {
  const input = requireExactRecord(value, 'external Agent draft model update input', [
    'draftId',
    'value',
  ]);
  return {
    draftId: requireEntityId(input.draftId, 'draftId'),
    value: requireString(input.value, 'model value', 512),
  };
}

export function decodeExternalAgentDraftReleaseInput(
  value: unknown,
): ExternalAgentDraftReleaseInput {
  const input = requireExactRecord(value, 'external Agent draft release input', ['draftId']);
  return { draftId: requireEntityId(input.draftId, 'draftId') };
}

export function decodeExternalAgentDraftModelProjection(
  value: unknown,
): ExternalAgentDraftModelProjection {
  const input = requireExactRecord(value, 'external Agent draft model projection', [
    'draftId',
    'externalAgentId',
    'configId',
    'currentValue',
    'options',
  ]);
  const draftId = requireEntityId(input.draftId, 'draftId');
  const sessionProjection = decodeExternalAgentSessionModelProjection({
    sessionId: draftId,
    acpAgentId: input.externalAgentId,
    configId: input.configId,
    currentValue: input.currentValue,
    options: input.options,
  });
  const {
    sessionId: _sessionId,
    acpAgentId: externalAgentId,
    ...configuration
  } = sessionProjection;
  return {
    draftId,
    externalAgentId,
    ...configuration,
  };
}

export function decodeExternalAgentDraftReleaseProjection(
  value: unknown,
): ExternalAgentDraftReleaseProjection {
  const input = requireExactRecord(value, 'external Agent draft release projection', [
    'draftId',
    'released',
  ]);
  if (typeof input.released !== 'boolean') {
    throw invalidProtocolFrame('Invalid external Agent draft release state');
  }
  return {
    draftId: requireEntityId(input.draftId, 'draftId'),
    released: input.released,
  };
}

function assertDraftIdentity(
  input: { readonly draftId: string },
  output: { readonly draftId: string },
): void {
  if (input.draftId !== output.draftId) {
    throw invalidProtocolFrame('External Agent draft changed identity');
  }
}

function decodeExternalAgentDraftAgentId(value: unknown): ExternalAgentDraftAgentId {
  if (value !== 'antigravity') throw invalidProtocolFrame('Invalid external Agent identity');
  return value;
}
