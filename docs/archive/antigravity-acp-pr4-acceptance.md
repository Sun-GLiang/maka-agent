<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Antigravity ACP PR 4 acceptance

PR 4 follows [issue #5103](https://github.com/apache/maka/issues/5103).
This record separates controlled protocol fixtures from official Agent results.

## Repeatable acceptance procedure, 2026-10-01

Use this procedure for PR [#5826](https://github.com/apache/maka/pull/5826).
The historical runs below are evidence, not a claim that every step passed on the
latest code. Record the tested commit, macOS architecture, Node version, Agent
version and hashes, Desktop build kind, and profile alias before starting.

### Preconditions and automated gate

1. Check out the PR head in an isolated worktree. Create two empty disposable
   projects A and B and a dedicated Desktop profile. Use that **same profile**
   throughout the two-project run and its restarts. Build Desktop from the tested
   commit; record whether it is a development build, unsigned local app, or signed
   distributable. An unsigned app cannot satisfy release-signing acceptance.
2. Use the official Agent and an account eligible to execute prompts. A successful
   connection or sign-in check alone does not establish prompt eligibility. Do not
   change account or network settings to bypass an eligibility error.
3. Run the repository gates below with dependencies installed. Build before running
   compiled tests so stale `dist` output cannot count as evidence. Record each exit
   status and retain logs. Run workspace tests serially for the local acceptance
   gate; record CI separately, with its exact head SHA and job URL.

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run check:renderer-architecture
npm run check:locale-hygiene
npm run check:asf-headers
node scripts/run-workspace-tests-parallel.mjs --concurrency=1
```

Fetch the current PR base before the protocol gate. Pass its fetched ref to
`node scripts/protocol-epoch-check.mjs --base <fetched-base-ref>` and run
`git diff <fetched-base-ref>...HEAD --check`. Reconcile the epoch against that base
before merge; the previous 200 → 201 result is historical evidence.

The affected suites must exercise fresh-Session model-dependent mode availability,
model-only changes removing a saved mode, idle notification drift, combined-option
rollback, retained Session restoration, and per-directory catalog reuse/refresh.
The ACP cases live in `packages/acp-executor-plugin/src/__tests__/acp-executor-plugin.test.ts`;
Host routing cases live in `packages/runtime-host/src/__tests__/session-catalog-coordinator.test.ts`.
Controlled fixtures establish failure/rollback semantics; real Agent runs establish
actual discovery and execution. Keep those results separate.

### Desktop steps and pass criteria

| Step | Action | Required result and evidence |
| --- | --- | --- |
| 1. Configure Agent | In external-Agent settings, select the extracted official Agent directory using the macOS picker, check connection, and verify sign-in. | Executable resolves correctly; both checks succeed. Capture settings status with account details redacted. |
| 2. Discover B | Add both projects through the project picker, select B, then select Antigravity and open model/mode pickers. | Real model and mode choices appear. Record actual IDs from confirmed task state; labels alone do not establish IDs. |
| 3. Refresh A | Switch B → A and refresh A's catalog with the UI refresh/retry control. Select an available model and mode. | Refresh completes; candidates remain usable and selection is displayed. Capture A's project label and picker. |
| 4. Return to B | Switch A → B without manually refreshing B; inspect its pickers. | B's candidates remain available. Capture B's project label and choices. Identical A/B candidates do not prove cache isolation; retain the production-executor cache identity check or controlled isolation test as separate evidence. |
| 5. Execute in B | Create a B task with a real model and `default` (if offered). Send: “Do not read or write files or run commands. Remember synthetic code B-5826-7319. Reply only ACK.” | Task reaches completed with ACK, and task metadata records B's directory and confirmed model/mode. An error or HTTP 403 is blocked/failed execution, never a pass. |
| 6. Execute in A | Switch to A. Create a task with another available model and `auto_edit` (if offered). Send the same no-file-access prompt with code A-5826-2648. | Completed with ACK; metadata records A's directory and confirmed selection. Both steps 5 and 6 must pass in this same profile to close cross-project execution. |
| 7. Confirm idle change | In one completed task, change mode and model while idle. | Agent confirmation and inspected task configuration agree with the selected IDs. Do not treat an optimistic picker label as confirmation. |
| 8. Restart and recall | Quit Desktop normally, reopen the same profile, open that task, and invoke restore if shown. Ask: “Do not read or write files or run commands. What synthetic code did I ask you to remember? Reply only the code.” | Completed with the correct prior code, which is absent from the recall prompt. The restored task retains its confirmed model/mode. Capture the recall answer and restored selection. |
| 9. Verify continuity | Compare external Session ID fingerprints before and after a second normal restart/restore. | Fingerprints match and continuity remains committed. Log only the equality result, never the external Session ID or private continuity record. |

Use actual offered choices if the official Agent catalog changes. Record the chosen
IDs and reason for substitution rather than hard-coding a now-unavailable model.
Save screenshots, task completion status, confirmed selections, and redacted logs
under a run-specific evidence location. Report each step as PASS, FAIL, BLOCKED,
or NOT RUN, with the tested commit. Never promote an earlier profile's success to
a pass for steps 5–6 in a different profile.

### Blocked-run handoff and completion rule

On authentication failure, retain the completed discovery/configuration checks and
resume execution after an eligible account is available. On account/location HTTP
403, record the affected project, model, mode, and error category without account
identifiers; leave cross-project execution open. Rerun steps 2–9 in one profile when
eligibility is restored. If code changes, repeat the affected automated gates and
record the new tested commit. Do not substitute a mock Agent for official-Agent
execution acceptance.

Cross-project acceptance closes only when both project prompts complete in the same
profile. Full behavior acceptance additionally requires confirmed idle changes,
restart recall, same external Session continuity, and passing automated gates on the
tested code. Signed distribution qualification is separate from this feature gate.

### Latest verified status

- Code head `d8d36d71a6346552f5a9c87c3b35728cc6a87a02`: the
  [CI run](https://github.com/apache/maka/actions/runs/36696757301) passed on
  2026-09-30. Verified successful steps include build, typecheck, lint, ASF headers,
  locale hygiene, renderer architecture, protocol epoch guard, affected workspace
  tests, Runtime Host tests, and Desktop e2e. This supersedes “current-head CI
  pending” for that commit; it does not convert historical local typecheck failures
  into local passes or establish real official-Agent prompt execution.
- Real Desktop discovery, B → A → B, A refresh, and B availability: PASS in the
  previously recorded unsigned app/profile. Production executor probes separately
  established per-directory refresh isolation.
- Successful prompt execution in **both** projects of that profile: BLOCKED by
  account/location HTTP 403. Earlier single-project prompt/recall/continuity success
  remains valid separate evidence. The remaining execution checkbox stays open.

## Official Agent capability gate, 2026-09-29

- Platform: macOS arm64. Client: ACP SDK 1.4.0, Node.js 24.19.0.
- No official Antigravity executable or authenticated Agent home was present in this development environment. The official Google macOS arm64 1.1.1 archive was downloaded from the URL in `docs/antigravity-acp-settings.md`. Its server and helper SHA-256 values matched the already recorded distribution hashes there.
- An isolated, disposable ACP client used a temporary toy directory. `initialize` returned protocol version 1, Agent version `agy_acp_server_1.1.1`, and resume/load capabilities. `session/new` returned JSON-RPC `-32000 Authentication required`. The probe sent no prompt, created no Maka task, did not log an external Session ID, and terminated its process group and toy directory.
- The [official ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) listed version 1.2.1. Its Google macOS arm64 archive contained the matching server and helper (SHA-256 `c93c86c0f505fcdf8b13c695bed26d306141ef5446189d591397074d324db34e` and `1b8a2b712ca312c9769e425b800bfbcceec4770f19736404474d1e8e50d65456`). `initialize` returned Agent version `1.2.1`, protocol version 1 and resume/load capabilities; `session/new` again returned `-32000 Authentication required`. Authentication remains required before a real `configOptions` list can be observed.

At this initial gate, authentication blocked observation of real mode IDs, mode/model interaction, confirmation responses, restoration of mode, and the full Desktop acceptance path. The authenticated follow-up below supersedes those initial capability findings. Different-directory catalogs and the full Desktop path remain unverified with the official Agent. No account or proxy configuration was changed by this work.

## Authenticated official Agent follow-up, 2026-09-29

A later check on macOS arm64 used the official 1.2.1 archive linked by the ACP registry. Its server and helper matched the SHA-256 values above. With the existing authenticated Agent home and a disposable toy workspace:

- A production `AcpExecutor` catalog probe returned 11 real model IDs and three mode IDs: `default`, `auto_edit`, and `yolo`. The current mode was `default`.
- A fresh Session confirmed `gemini-3.8-flash-high` with `default`, then confirmed an idle change to `auto_edit`. Another idle change confirmed `gemini-3.7-flash-high` with `default`. Inspection returned those exact final values.
- After disposing and recreating the executor, inspection reported `restorable`. Explicit restoration retained the same external Session ID and reconfirmed the saved model and mode. The comparison was made in memory; the ID was not logged.
- Synthetic text prompts with both `gemini-3.8-flash-high` and `gemini-3.7-flash-high` failed with `acp_prompt_failed`. The Agent's output contained HTTP 403 and a location restriction. This check therefore does **not** establish successful prompt execution or post-restart context retention.
- A Desktop development build opened in an isolated worktree profile, but authenticated Desktop selection, refresh, idle change, and restart evidence remains outstanding. The isolated profile has no configured external Agent, and the prompt restriction above still blocks the complete task flow.

All probes used a temporary project, sent no private project content, and disposed their Agent processes. No account or network settings were changed. At that stage, real discovery, confirmed configuration, and same-Session restoration were verified; full Desktop and successful prompt acceptance were still open.

## Desktop acceptance, 2026-09-30

The Desktop development build ran on macOS arm64 with an isolated user-data directory and two temporary toy folders. The installed Agent was the official 1.2.1 distribution verified above. No private project content was sent to it.

- The macOS file picker disabled selection of the official Mach-O `agy_acp_server.par` file. Desktop now asks for its extracted directory and resolves the server path from that directory. In the real UI, choosing the directory saved the executable path, `Check connection` succeeded, and Google sign-in verification succeeded.
- In the first toy project, the Antigravity picker showed the four model families backed by the real catalog. The production catalog probe returned 11 model IDs. The mode picker showed `Default`, `Auto Edit`, and `YOLO`. A manual refresh retained the selected model.
- A new Desktop task used `gemini-3.7-flash-high` with `auto_edit`. The first synthetic prompt asked the Agent to remember `RIVER-4821` without reading or writing files. The task completed in nine seconds and answered that it had remembered the code.
- While idle, the same task confirmed a change to `default` and `gemini-3.6-flash-high`. After a normal Desktop quit and restart, the task showed a restore action. Restoration completed with that model and mode. A second prompt omitted the code and asked the Agent to recall it; the completed answer was exactly `RIVER-4821`.
- The private Plugin continuity record showed `phase: committed`, two committed prompts, and the confirmed model and mode. A second normal quit and restart again restored the task. A one-way fingerprint comparison of the record before and after that restart confirmed the same external Session ID; the ID was not logged.

An initial attempt to add the second toy project for a Desktop directory-isolation check stalled because the macOS project-folder picker disabled its Open button despite the folder being selected. A later isolated app profile successfully added both projects; the second-project result and remaining switching gap are recorded below.

## P3 follow-up and two-directory Agent check, 2026-09-30

The P3 review identified a configuration-order failure: when a new Session begins on a launch model without a mode option, `configureConversation` rejected the requested mode before selecting a model that does expose it. A similar idle Session drift could make restoration of a saved model and mode fail. Configuration now applies the requested model first, validates dependent options against the Agent's response to that model change, and rolls back if the resulting mode is invalid. A fresh Session merges launch defaults with the requested configuration once; a restored Session retains its saved configuration path.

- Regression tests reproduced both failures before the fix (`acp_config_unavailable: mode`) and pass after it. A third test covers rollback when a mode is invalid after the model switch. The ACP plugin suite passed all 51 tests; the Runtime Host Session catalog coordinator passed all 76 tests.
- The official 1.2.1 Agent was used through the production `AcpExecutor` after Google sign-in. Two separate disposable directories, `/private/tmp/maka-pr5826-project-a` and `/private/tmp/maka-pr5826-project-b`, each returned `ready`, 11 real models, and mode IDs `default`, `auto_edit`, `yolo`. Re-querying each directory returned its cached entry. Explicitly refreshing A returned a new ready entry for A while B still returned its original cached entry. This establishes authenticated per-directory discovery and refresh isolation in the production executor against the real Agent. Both directories returned the same choices, so this does not prove that different workspace configurations produce different catalogs.
- An isolated local `Maka.app` assembled by electron-builder launched and showed the packaged renderer. In that app the extracted official Agent directory was selected with the native picker, connection check succeeded, and Google login verification displayed success. Electron-builder could not finish the macOS arm64 distributable because this machine has no `Developer ID Application` signing identity and the project requires signing. This was an unsigned local app layout, not a completed signed DMG or ZIP.
- After the first isolated app profile stopped responding to desktop automation, a fresh isolated profile successfully registered both toy directories through the native macOS project-folder picker. The official Agent directory was selected in that profile; connection and Google login verification succeeded. With project B selected, the Antigravity picker displayed four real Gemini model families and the `Default`, `Auto Edit`, and `YOLO` modes. Automation initially lost the project-menu target during attempts to switch A ↔ B. A later restart of this same profile completed the switching check described below.
- In the resumed packaged app profile, the project menu switched B → A. A's Antigravity picker showed four Gemini model families. The Desktop `Retry` control started and completed a catalog refresh for A; the candidates remained available. With A selected, `Gemini 3.8 Flash` exposed `Default`, `Auto Edit`, and `YOLO`, and `Auto Edit` could be selected. The menu then switched A → B without manually refreshing B. B still showed the four Gemini families, and `Gemini 3.7 Flash` exposed the same three modes. This verifies the Desktop project-switch and catalog-availability path after an A refresh. Since A and B offer identical candidates, the UI alone cannot prove that B reused its own cache entry; the production `AcpExecutor` object-identity check above establishes A-only refresh at the executor layer.
- A no-file-access prompt was sent in each toy project. The B task recorded `pr5826-project-b`, `gemini-3.7-flash-high`, and `default`; the A task recorded `pr5826-project-a`, `gemini-3.8-flash-high`, and `auto_edit`. Both reached the real Agent and failed with HTTP 403: `Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location.` Thus this profile verifies project and mode routing through task creation, but it does not add successful cross-project prompt execution. The earlier successful prompt and restart-continuation check in the first profile remains separate evidence.
- The Desktop app build passed. The workspace-dependency build stopped at existing `@maka/ui` TypeScript errors involving `@astryxdesign/core` types; the full workspace typecheck is not counted as passing for this follow-up.

## Implementation and controlled checks

The generic executor configuration and catalog now carry optional opaque mode IDs. ACP maps only real `select` mode options from the Agent; omitted mode preserves the Agent default. The same Host query and Desktop picker carry models and modes. Catalogs are keyed by resolved directory, share one bounded probe per directory, and can be invalidated by setup/login, policy changes, expiration, or explicit refresh. The retained task's configuration is inspected independently of draft discovery.

Catalog discovery calls the configured Agent's `session/new` in the selected workspace because ACP exposes configuration options per Session. That Agent may read workspace configuration, run its own startup hooks, or retain the empty probe Session in its own history; the client's disabled filesystem and terminal capabilities do not constrain the Agent's own process. Use this discovery only with an Agent trusted for that workspace. Maka sends no prompt, does not retain the probe as a task, deduplicates concurrent queries for the same directory, and disposes its connection after the probe. The 16-entry limit bounds cached catalogs, not the number of distinct directories being probed at once.

Configuration updates validate the complete target before applying it, use Agent `setConfigOption` confirmations, and attempt a complete rollback on failure. The saved continuity record keeps the confirmed mode while retaining compatibility with PR 3 records containing only `confirmedModel`. Restore compares the Agent's returned configuration against that record and refuses a mismatch.

Controlled tests cover the contract, prompt application, idle mode update, combined-option rollback, same-Session restore, directory cache isolation, refresh, login invalidation, and late notification handling.

## Historical validation (see latest verified status above)

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:renderer-architecture`, `npm run check:locale-hygiene`, and `npm run check:asf-headers`: passed.
- For the 2026-09-30 Desktop picker follow-up, the development build completed and targeted Biome lint passed. A fresh Desktop workspace typecheck still reports errors in unchanged browser tools, notifications, overlays, runtime config, and conversation selector files; those errors are not counted as a pass for this follow-up.
- `node scripts/run-workspace-tests-parallel.mjs --concurrency=1` with the bundled Node.js 24.19.0 and Python 3.12.14: all workspaces passed. A separate three-workspace concurrent run was stopped after unrelated timing-sensitive Runtime Host integration cases failed under load; it is not counted as passing validation.
- The protocol epoch advanced to 201 after merging main's storage-usage (199) and Agent Graph (200) protocol updates, for the additive mode and refresh wire fields. The merge-result protocol epoch guard passed against the updated main.
- The initial unauthenticated `session/new` failure and HTTP 403 prompt restriction were resolved for the first Desktop profile above, which verified selection, authentication, catalog refresh, mode and model changes, a completed prompt, and post-restart continuation. A second isolated profile added both toy projects, switched B → A → B, refreshed A, and still rendered B's real catalog without refreshing B. Production `AcpExecutor` probes separately verified per-directory cache and A-only refresh against the official Agent. New prompts in both projects of the second profile failed with the Agent's account/location HTTP 403, so successful cross-project prompt execution remains unverified.
