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
  OperationOutcome,
  WorkspaceTarget,
} from '../../protocol/index.js';
import type { ConnectionContext, OperationHandlerMap } from '../operation-dispatcher.js';
import { WorkspaceResolutionError } from '../workspace-resolver.js';
import {
  AcpModelConfigurationError,
  type AcpAgentBackend,
  type AcpModelConfiguration,
} from './acp-agent-backend.js';

type Key =
  | 'external_agents.draft.model.prepare'
  | 'external_agents.draft.model.update'
  | 'external_agents.draft.release';

interface DraftEntry {
  readonly connectionId: string;
  readonly externalAgentId: ExternalAgentDraftAgentId;
  readonly requestKey: string;
  readonly cwd: string;
  readonly backend: AcpAgentBackend;
}

interface PendingDraft {
  readonly connectionId: string;
  readonly requestKey: string;
  readonly abort: AbortController;
  readonly promise: Promise<OperationOutcome<'external_agents.draft.model.prepare'>>;
}

export interface HostExternalAgentDraftModelCoordinatorInput {
  resolveWorkspace(target: WorkspaceTarget): Promise<{ readonly cwd: string }>;
  prepareBackend(
    externalAgentId: ExternalAgentDraftAgentId,
    draftId: string,
    cwd: string,
  ): Promise<AcpAgentBackend>;
}

/** Owns process-local ACP draft Sessions until a task consumes or releases them. */
export class HostExternalAgentDraftModelCoordinator {
  readonly handlers: Pick<OperationHandlerMap, Key> = {
    'external_agents.draft.model.prepare': (input, context) =>
      this.prepare(input.externalAgentId, input.draftId, input.workspace, context),
    'external_agents.draft.model.update': (input, context) =>
      this.update(input.draftId, input.value, context),
    'external_agents.draft.release': (input, context) =>
      this.release(input.draftId, context.connectionId),
  };

  private readonly drafts = new Map<string, DraftEntry>();
  private readonly pending = new Map<string, PendingDraft>();
  private draining = false;

  constructor(private readonly input: HostExternalAgentDraftModelCoordinatorInput) {}

  has(externalAgentId: ExternalAgentDraftAgentId, draftId: string, cwd: string): boolean {
    const draft = this.drafts.get(draftId);
    if (!draft) return false;
    if (draft.externalAgentId !== externalAgentId || draft.cwd !== cwd) {
      throw new Error('External Agent draft target changed before task creation');
    }
    return true;
  }

  take(
    externalAgentId: ExternalAgentDraftAgentId,
    draftId: string,
    cwd: string,
  ): AcpAgentBackend | undefined {
    const draft = this.drafts.get(draftId);
    if (!draft) return undefined;
    this.drafts.delete(draftId);
    if (draft.externalAgentId !== externalAgentId || draft.cwd !== cwd) {
      void draft.backend.dispose();
      throw new Error('External Agent draft target changed before task creation');
    }
    return draft.backend;
  }

  async beginDrain(): Promise<void> {
    this.draining = true;
    await this.close();
  }

  async releaseConnection(connectionId: string): Promise<void> {
    await Promise.all(
      [...this.drafts]
        .filter(([, draft]) => draft.connectionId === connectionId)
        .map(([draftId]) => this.releaseOwned(draftId)),
    );
    for (const pending of this.pending.values()) {
      if (pending.connectionId === connectionId) pending.abort.abort();
    }
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) pending.abort.abort();
    await Promise.all([...this.drafts.keys()].map((draftId) => this.releaseOwned(draftId)));
  }

  private async prepare(
    externalAgentId: ExternalAgentDraftAgentId,
    draftId: string,
    workspace: WorkspaceTarget,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'external_agents.draft.model.prepare'>> {
    if (this.draining) return failure('host_draining');
    const requestKey = JSON.stringify([externalAgentId, workspace]);
    const existing = this.drafts.get(draftId);
    if (existing) {
      return existing.connectionId === context.connectionId && existing.requestKey === requestKey
        ? success(externalAgentId, draftId, existing.backend.modelConfiguration())
        : failure('operation_conflict');
    }
    const inFlight = this.pending.get(draftId);
    if (inFlight) {
      return inFlight.connectionId === context.connectionId && inFlight.requestKey === requestKey
        ? inFlight.promise
        : failure('operation_conflict');
    }

    const abort = new AbortController();
    const promise = this.prepareNew(
      externalAgentId,
      draftId,
      workspace,
      context.connectionId,
      requestKey,
      abort,
    );
    this.pending.set(draftId, {
      connectionId: context.connectionId,
      requestKey,
      abort,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.pending.get(draftId)?.promise === promise) this.pending.delete(draftId);
    }
  }

  private async prepareNew(
    externalAgentId: ExternalAgentDraftAgentId,
    draftId: string,
    workspace: WorkspaceTarget,
    connectionId: string,
    requestKey: string,
    abort: AbortController,
  ): Promise<OperationOutcome<'external_agents.draft.model.prepare'>> {
    let backend: AcpAgentBackend | undefined;
    try {
      const { cwd } = await this.input.resolveWorkspace(workspace);
      if (abort.signal.aborted || this.draining) return failure('host_draining');
      backend = await this.input.prepareBackend(externalAgentId, draftId, cwd);
      const configuration = await backend.prepare(abort.signal);
      if (abort.signal.aborted || this.draining) {
        await backend.dispose();
        return failure('host_draining');
      }
      this.drafts.set(draftId, {
        connectionId,
        externalAgentId,
        requestKey,
        cwd,
        backend,
      });
      return success(externalAgentId, draftId, configuration);
    } catch (error) {
      await backend?.dispose().catch(() => undefined);
      return failure(errorCode(error));
    }
  }

  private async update(
    draftId: string,
    value: string,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'external_agents.draft.model.update'>> {
    const draft = this.drafts.get(draftId);
    if (!draft) return failure('not_found');
    if (draft.connectionId !== context.connectionId) return failure('operation_conflict');
    try {
      return success(draft.externalAgentId, draftId, await draft.backend.setModel(value));
    } catch (error) {
      return failure(errorCode(error));
    }
  }

  private async release(
    draftId: string,
    connectionId: string,
  ): Promise<OperationOutcome<'external_agents.draft.release'>> {
    const draft = this.drafts.get(draftId);
    const pending = this.pending.get(draftId);
    if (
      (draft && draft.connectionId !== connectionId) ||
      (pending && pending.connectionId !== connectionId)
    ) {
      return failure('operation_conflict');
    }
    pending?.abort.abort();
    const released = await this.releaseOwned(draftId);
    return { ok: true, result: { draftId, released: released || Boolean(pending) } };
  }

  private async releaseOwned(draftId: string): Promise<boolean> {
    const draft = this.drafts.get(draftId);
    if (!draft) return false;
    this.drafts.delete(draftId);
    await draft.backend.dispose();
    return true;
  }
}

function success(
  externalAgentId: ExternalAgentDraftAgentId,
  draftId: string,
  configuration: AcpModelConfiguration | undefined,
): OperationOutcome<'external_agents.draft.model.prepare'> {
  return configuration
    ? {
        ok: true,
        result: {
          draftId,
          externalAgentId,
          ...configuration,
        } satisfies ExternalAgentDraftModelProjection,
      }
    : failure('operation_unavailable');
}

function errorCode(error: unknown) {
  if (error instanceof WorkspaceResolutionError) return error.code;
  if (error instanceof AcpModelConfigurationError) {
    if (error.code === 'busy') return 'session_busy' as const;
    if (error.code === 'invalid_value') return 'invalid_request' as const;
    return 'operation_unavailable' as const;
  }
  return 'internal_failure' as const;
}

function failure(
  code:
    | 'host_draining'
    | 'operation_unavailable'
    | 'invalid_request'
    | 'internal_failure'
    | 'operation_conflict'
    | 'not_found'
    | 'session_busy',
): {
  readonly ok: false;
  readonly error: { readonly code: typeof code; readonly message: string };
} {
  return { ok: false, error: { code, message: `External Agent draft model: ${code}` } };
}
