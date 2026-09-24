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
  agent,
  methods,
  RequestError,
  type AgentApp,
  type ClientCapabilities,
} from '@agentclientprotocol/sdk';
import { HOST_OPERATION_SPECS } from '@maka/runtime-host/protocol';
import type { AcpSessionRegistry } from './session-registry.js';

export interface MakaAcpAgentOptions {
  readonly version: string;
  readonly sessionRegistry: Pick<
    AcpSessionRegistry,
    | 'create'
    | 'list'
    | 'setConfigOption'
    | 'prompt'
    | 'cancel'
    | 'close'
    | 'artifactQuery'
    | 'artifactIngest'
    | 'artifactDelete'
    | 'memoryQuery'
    | 'memoryMutate'
  >;
}

export function createMakaAcpAgent(options: MakaAcpAgentOptions): AgentApp {
  let clientCapabilities: ClientCapabilities = {};
  return agent({ name: 'maka' })
    .onRequest(methods.agent.initialize, ({ params }) => {
      clientCapabilities = structuredClone(params.clientCapabilities ?? {});
      return {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { list: {}, close: {} } },
        authMethods: [],
        agentInfo: { name: 'maka', title: 'Maka', version: options.version },
      };
    })
    .onRequest(methods.agent.session.new, ({ params, signal }) =>
      options.sessionRegistry.create(params, signal),
    )
    .onRequest(methods.agent.session.list, ({ params }) => options.sessionRegistry.list(params))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) =>
      options.sessionRegistry.setConfigOption(params),
    )
    .onRequest(methods.agent.session.prompt, ({ params, signal, client }) =>
      options.sessionRegistry.prompt(params, {
        signal,
        notify: (notification) => client.notify(methods.client.session.update, notification),
        interactions: {
          capabilities: clientCapabilities,
          requestPermission: (params, cancellationSignal) =>
            client.request(methods.client.session.requestPermission, params, {
              cancellationSignal,
            }),
          createElicitation: (params, cancellationSignal) =>
            client.request(methods.client.elicitation.create, params, { cancellationSignal }),
        },
      }),
    )
    .onNotification(methods.agent.session.cancel, ({ params }) =>
      options.sessionRegistry.cancel(params),
    )
    .onRequest(methods.agent.session.close, ({ params }) => options.sessionRegistry.close(params))
    .onRequest(
      '_maka/artifact/query',
      extensionParams('artifact.query', HOST_OPERATION_SPECS['artifact.query'].decodeInput),
      ({ params }) => options.sessionRegistry.artifactQuery(params),
    )
    .onRequest(
      '_maka/artifact/ingest',
      extensionParams('artifact.ingest', HOST_OPERATION_SPECS['artifact.ingest'].decodeInput),
      ({ params }) => options.sessionRegistry.artifactIngest(params),
    )
    .onRequest(
      '_maka/artifact/delete',
      extensionParams('artifact.delete', HOST_OPERATION_SPECS['artifact.delete'].decodeInput),
      ({ params }) => options.sessionRegistry.artifactDelete(params),
    )
    .onRequest(
      '_maka/memory/query',
      extensionParams('memory.query', HOST_OPERATION_SPECS['memory.query'].decodeInput),
      ({ params }) => options.sessionRegistry.memoryQuery(params),
    )
    .onRequest(
      '_maka/memory/mutate',
      extensionParams('memory.mutate', HOST_OPERATION_SPECS['memory.mutate'].decodeInput),
      ({ params }) => options.sessionRegistry.memoryMutate(params),
    );
}

function extensionParams<Input>(
  operation: string,
  decode: (params: unknown) => Input,
): (params: unknown) => Input {
  return (params) => {
    try {
      if (params && typeof params === 'object' && !Array.isArray(params) && '_meta' in params) {
        const record = params as Record<string, unknown>;
        const meta = record._meta;
        if (
          meta !== undefined &&
          meta !== null &&
          (typeof meta !== 'object' || Array.isArray(meta))
        ) {
          throw new Error('Invalid ACP request metadata');
        }
        const { _meta: _ignored, ...domainParams } = record;
        return decode(domainParams);
      }
      return decode(params);
    } catch {
      throw RequestError.invalidParams(
        { source: 'adapter', operation, code: 'invalid_request' },
        `Invalid ${operation} request`,
      );
    }
  };
}
