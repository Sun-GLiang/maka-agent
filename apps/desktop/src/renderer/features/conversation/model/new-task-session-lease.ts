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

/** Owns cleanup between local task creation and acceptance of its first Message. */
export function createNewTaskSessionLease(input: {
  removeSession(sessionId: string): Promise<unknown>;
  retireSession(sessionId: string): void;
  refreshSessions(): Promise<unknown>;
  markExternalAgentDraftConsumed?(draftId: string): void;
  releaseExternalAgentDraft?(draftId: string): Promise<void>;
}) {
  let claim: { sessionId: string; draftId?: string } | undefined;
  return {
    claim(sessionId: string, draftId?: string) {
      if (draftId && sessionId !== draftId) {
        throw new Error('Created external Agent task did not consume its prepared draft');
      }
      if (draftId) input.markExternalAgentDraftConsumed?.(draftId);
      claim = { sessionId, ...(draftId ? { draftId } : {}) };
    },
    commit() {
      claim = undefined;
    },
    async discard() {
      if (!claim) return;
      const discarded = claim;
      claim = undefined;
      try {
        await input.removeSession(discarded.sessionId);
        input.retireSession(discarded.sessionId);
        await input.refreshSessions();
      } catch {
        // Best-effort: a failed cleanup must not replace the real error.
      } finally {
        if (discarded.draftId) {
          await input.releaseExternalAgentDraft?.(discarded.draftId);
        }
      }
    },
  };
}
