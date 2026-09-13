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
  ExternalAgentSessionModelProjection,
  OperationOutcome,
} from '../../protocol/index.js';
import type { OperationHandlerMap } from '../operation-dispatcher.js';
import {
  AcpModelConfigurationError,
  type AcpAgentBackend,
  type AcpModelConfiguration,
} from './acp-agent-backend.js';

type Key = 'external_agents.session.model.query' | 'external_agents.session.model.update';

export class HostExternalAgentSessionModelCoordinator {
  readonly handlers: Pick<OperationHandlerMap, Key> = {
    'external_agents.session.model.query': (input) => this.query(input.sessionId),
    'external_agents.session.model.update': (input) => this.update(input.sessionId, input.value),
  };

  constructor(private readonly resolve: (sessionId: string) => AcpAgentBackend | undefined) {}

  private async query(sessionId: string): Promise<OperationOutcome<Key>> {
    const backend = this.resolve(sessionId);
    if (!backend) return failure('not_found');
    const configuration = backend.modelConfiguration();
    if (!configuration) return failure('operation_unavailable');
    return { ok: true, result: projection(sessionId, configuration) };
  }

  private async update(sessionId: string, value: string): Promise<OperationOutcome<Key>> {
    const backend = this.resolve(sessionId);
    if (!backend) return failure('not_found');
    try {
      return { ok: true, result: projection(sessionId, await backend.setModel(value)) };
    } catch (error) {
      if (error instanceof AcpModelConfigurationError) {
        if (error.code === 'busy') return failure('session_busy');
        if (error.code === 'invalid_value') return failure('invalid_request');
        return failure('operation_unavailable');
      }
      return failure('internal_failure');
    }
  }
}

function projection(
  sessionId: string,
  configuration: AcpModelConfiguration,
): ExternalAgentSessionModelProjection {
  return { sessionId, acpAgentId: 'antigravity', ...configuration };
}

function failure(
  code:
    | 'not_found'
    | 'operation_unavailable'
    | 'invalid_request'
    | 'session_busy'
    | 'internal_failure',
): Extract<OperationOutcome<Key>, { readonly ok: false }> {
  return { ok: false, error: { code, message: `External Agent Session model: ${code}` } };
}
