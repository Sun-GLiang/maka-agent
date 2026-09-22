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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutorCatalogEntry, ExecutorConfiguration } from '@maka/core/executor-catalog';
import type { SessionSummary } from '@maka/core/session';
import type { ConversationNewTaskTarget } from '../ports.js';
import { useConversationServices } from '../services.js';

export interface ExecutorSelection {
  readonly executorId: string;
  readonly configuration: ExecutorConfiguration;
}

export function useExecutorSelection(input: {
  key: string;
  target?: ConversationNewTaskTarget;
  cwd?: string;
  session?: SessionSummary;
}) {
  const services = useConversationServices();
  const [draft, setDraft] = useState<{ key: string; selection?: ExecutorSelection }>();
  const [snapshot, setSnapshot] = useState<{
    key: string;
    catalog: readonly ExecutorCatalogEntry[];
    loading: boolean;
    error?: string;
  }>();
  const [changing, setChanging] = useState(false);
  const sessionId = input.session?.id;
  const executorId = input.session?.executorId;
  const key = sessionId ?? input.key;
  const current = useRef(key);
  current.current = key;
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const attempt = ++revision.current;
    if (sessionId && !executorId) {
      setSnapshot({ key, catalog: [], loading: false });
      return;
    }
    if (!sessionId && (!input.target || !input.cwd)) return;
    setSnapshot((previous) => ({
      key,
      catalog: previous?.key === key ? previous.catalog : [],
      loading: true,
    }));
    try {
      const catalog = sessionId
        ? ((await services.sessions.getExecutorState?.(sessionId)) ?? [])
        : ((await services.newTasks.getExecutors?.(input.target!, input.cwd!)) ?? []);
      if (current.current === key && revision.current === attempt)
        setSnapshot({ key, catalog, loading: false });
    } catch (error) {
      if (current.current === key && revision.current === attempt)
        setSnapshot({
          key,
          catalog: [],
          loading: false,
          error: error instanceof Error ? error.message : 'Executor unavailable',
        });
    }
  }, [
    key,
    sessionId,
    executorId,
    input.target?.hostId,
    input.target?.profileId,
    input.target?.projectId,
    input.cwd,
    services,
  ]);
  useEffect(() => {
    void refresh();
    const unsubscribe = services.newTasks.subscribeChanges(() => {
      void refresh();
    });
    const unSession = services.subscribeChanges((changedSessionId) => {
      if (sessionId && changedSessionId === sessionId) void refresh();
    });
    // Conversation inspection is process-free, including while a retained process is idle.
    const timer =
      sessionId && executorId
        ? setInterval(() => {
            void refresh();
          }, 3000)
        : undefined;
    return () => {
      revision.current++;
      unsubscribe();
      unSession();
      clearInterval(timer);
    };
  }, [refresh, services, sessionId, executorId]);
  useEffect(() => {
    if (sessionId) setDraft(undefined);
  }, [sessionId]);
  const selection = executorId
    ? { executorId, configuration: input.session?.executorConfig ?? {} }
    : sessionId
      ? undefined
      : draft?.key === input.key
        ? draft.selection
        : undefined;
  const select = async (next: ExecutorSelection | undefined) => {
    if (!sessionId) {
      setDraft({ key: input.key, selection: next });
      return;
    }
    if (!next || next.executorId !== executorId || !services.sessions.setExecutorModelConfiguration)
      return;
    setChanging(true);
    try {
      const result = await services.sessions.setExecutorModelConfiguration(
        sessionId,
        next.configuration,
      );
      if (!result.ok) throw new Error(result.code);
      await refresh();
    } catch (error) {
      if (current.current === key)
        setSnapshot((previous) => ({
          key,
          catalog: previous?.key === key ? previous.catalog : [],
          loading: false,
          error: error instanceof Error ? error.message : 'Executor configuration failed',
        }));
    } finally {
      setChanging(false);
    }
  };
  const catalog = snapshot?.key === key ? snapshot.catalog : [];
  const entry = catalog.find((candidate) => candidate.id === selection?.executorId);
  return {
    selection,
    catalog,
    entry,
    select,
    refresh,
    changing,
    loading: snapshot?.key !== key || snapshot.loading,
    error: snapshot?.key === key ? snapshot.error : undefined,
  };
}
