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

// Compatibility barrel for the package-private PR1 seam. Responsibilities
// live in separate authority, recovery, and immutable snapshot modules.
export {
  ensureTurnIndexRows,
  invalidateSessionTurnPositionIndex,
  recordAppendedSessionTurnMetadata,
  recordRootTurnAdmissionForPositionIndex,
  recordRootTurnAdmissionsPurgedForPositionIndex,
} from './session-turn-position-authority.js';
export {
  SESSION_TURN_POSITION_BODY_MAX_BYTES,
  SESSION_TURN_POSITION_BODY_MAX_RECORDS,
  SESSION_TURN_POSITION_BODY_MAX_TURNS,
  SESSION_TURN_POSITION_BUILD_MAX_POSITIONS,
  SESSION_TURN_POSITION_MAX_PAGE_BYTES,
  SESSION_TURN_POSITION_MAX_PAGE_POSITIONS,
  advanceSessionTurnPositionOrdinalBuild,
  allocateOrRequireSessionTurnPositionSnapshot,
  markSessionTurnRecoveryComplete,
  pageReadySessionTurnPositionSnapshot,
  readSessionTurnMembershipPreflight,
  reclaimSessionTurnPositionSnapshotsForNewOwner,
  releaseSessionTurnPositionSnapshot,
  requireSnapshot,
  snapshotKeyFromRow,
  type SessionTurnPositionBuildPhase,
  type SessionTurnPositionSnapshotRow,
} from './session-turn-position-snapshots.js';
