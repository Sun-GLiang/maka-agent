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
  TaskEntryExternalAgentReadiness,
  TaskEntryExternalAgentService,
  TaskEntryHostRef,
} from '../ports.js';

const TERMINAL_PHASES = new Set(['succeeded', 'failed', 'cancelled']);

/** Restore process-local ACP authentication before a first-send Session exists. */
export async function ensureAntigravityExecutionReady(
  service: TaskEntryExternalAgentService,
  host: TaskEntryHostRef,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 250)),
): Promise<TaskEntryExternalAgentReadiness> {
  const authentication = await service.authentication(host);
  if (authentication.status === 'verified') return { status: 'ready' };
  if (!authentication.executable)
    return { status: 'setup_required', reason: 'not_configured' };

  const attemptId = service.createAttemptId();
  let projection = await service.start({
    attemptId,
    action: 'login',
    expectedExecutable: authentication.executable,
  }, host);
  while (!TERMINAL_PHASES.has(projection.phase)) {
    await wait();
    projection = await service.query(attemptId, host);
  }
  if (projection.phase === 'failed') {
    return {
      status: 'setup_required',
      reason: 'login_failed',
      ...(projection.failure ? { failure: projection.failure } : {}),
    };
  }
  if (projection.phase === 'cancelled')
    return { status: 'setup_required', reason: 'login_cancelled' };

  const verified = await service.authentication(host);
  return verified.status === 'verified' && verified.executable === authentication.executable
    ? { status: 'ready' }
    : { status: 'setup_required', reason: 'verification_failed' };
}
