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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskEntryHostRef, TaskEntryTarget } from '../ports.js';
import { useTaskEntryServices } from '../services-context.js';

interface DraftState {
  readonly key: string;
  readonly draftId: string;
  readonly pending: boolean;
  readonly configuration?: ExternalAgentDraftModelProjection;
}

export interface ExternalAgentDraftModel {
  readonly draftId?: string;
  readonly configuration?: ExternalAgentDraftModelProjection;
  readonly pending: boolean;
  selectModel(value: string): Promise<void>;
  markConsumed(draftId: string): void;
  releaseConsumed(draftId: string): Promise<void>;
}

/** Owns one pre-send ACP Session and promotes its identity into the first task. */
export function useExternalAgentDraftModel(input: {
  readonly externalAgentId?: ExternalAgentDraftAgentId;
  readonly target?: TaskEntryTarget;
  readonly cwd?: string;
  ensureReady(
    externalAgentId: ExternalAgentDraftAgentId,
    host: TaskEntryHostRef,
  ): Promise<boolean>;
  onError(error: unknown): void;
}): ExternalAgentDraftModel {
  const service = useTaskEntryServices().externalAgent;
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<DraftState>();
  const consumed = useRef(new Set<string>());
  const externalAgentId = input.externalAgentId;
  const projectId = input.target?.projectId;
  const profileId = input.target?.profileId;
  const hostId = input.target?.hostId;
  const key = externalAgentId && profileId && hostId && (projectId !== null || input.cwd)
    ? `${externalAgentId}:${profileId}:${hostId}:${projectId ?? input.cwd}`
    : undefined;

  useEffect(() => {
    if (!key || !service || !externalAgentId || !profileId || !hostId) {
      setState(undefined);
      return;
    }
    const host = { profileId, hostId };
    const draftId = service.createAttemptId();
    let cancelled = false;
    setState({ key, draftId, pending: true });
    void (async () => {
      try {
        if (!(await input.ensureReady(externalAgentId, host))) {
          if (!cancelled) setState({ key, draftId, pending: false });
          return;
        }
        const workspace = typeof projectId === 'string'
          ? { kind: 'project' as const, projectId }
          : { kind: 'host_path' as const, path: input.cwd! };
        const configuration = await service.prepareDraftModel(
          { draftId, externalAgentId, workspace },
          host,
        );
        if (cancelled) {
          await service.releaseDraft(draftId, host).catch(() => undefined);
          return;
        }
        setState({ key, draftId, pending: false, configuration });
      } catch (error) {
        if (!cancelled) {
          setState({ key, draftId, pending: false });
          input.onError(error);
        }
      }
    })();
    return () => {
      cancelled = true;
      const wasConsumed = consumed.current.delete(draftId);
      if (!wasConsumed) {
        void service.releaseDraft(draftId, host).catch(() => undefined);
      }
    };
  }, [
    externalAgentId,
    hostId,
    input.cwd,
    input.ensureReady,
    input.onError,
    key,
    profileId,
    projectId,
    retryRevision,
    service,
  ]);

  const selectModel = useCallback(async (value: string): Promise<void> => {
    const current = state;
    if (!current?.configuration || current.pending || !service || !profileId || !hostId) return;
    try {
      setState((latest) => latest?.draftId === current.draftId
        ? { ...latest, pending: true }
        : latest);
      const configuration = await service.updateDraftModel(
        current.draftId,
        value,
        { profileId, hostId },
      );
      setState((latest) => latest?.draftId === current.draftId
        ? { ...latest, pending: false, configuration }
        : latest);
    } catch (error) {
      setState((latest) => latest?.draftId === current.draftId
        ? { ...latest, pending: false }
        : latest);
      input.onError(error);
    }
  }, [hostId, input.onError, profileId, service, state]);

  const markConsumed = useCallback((draftId: string): void => {
    consumed.current.add(draftId);
  }, []);

  const releaseConsumed = useCallback(async (draftId: string): Promise<void> => {
    if (!service || !profileId || !hostId) return;
    consumed.current.delete(draftId);
    await service.releaseDraft(draftId, { profileId, hostId }).catch(() => undefined);
    setState((current) => current?.draftId === draftId ? undefined : current);
    setRetryRevision((current) => current + 1);
  }, [hostId, profileId, service]);

  return useMemo(() => ({
    draftId: state?.configuration && !state.pending ? state.draftId : undefined,
    configuration: state?.configuration,
    pending: state?.pending ?? false,
    selectModel,
    markConsumed,
    releaseConsumed,
  }), [markConsumed, releaseConsumed, selectModel, state]);
}
