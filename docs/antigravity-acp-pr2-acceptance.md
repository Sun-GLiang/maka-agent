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

# Antigravity ACP PR 2 acceptance

Implementation scope follows the four PR 2 sets in [issue #5103](https://github.com/apache/maka/issues/5103).
No PR 3 restore or PR 4 mode/catalog lifecycle behavior is implied by these results.

## Official Agent environment

- macOS arm64; official `agy_acp_server` **1.1.1** and its adjacent `localharness_external`.
- Official archive: `https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip`.
- Archive SHA-256: `fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189`.
- Run dates: 2026-09-21–22, Asia/Shanghai.
- Existing authenticated Google session was used successfully. Fresh interactive Google sign-in is
  PR 1 evidence and was **not repeated** in this run.
- HTTP(S) proxy environment variables were supplied for this machine's network. No credentials or
  private project files were included in fixtures or evidence.

## Production Plugin acceptance

Loaded the built ACP runtime and Antigravity adapter through the production Plugin platform and
built-in external-agent coordinator, with Plugin storage bound to a temporary Host data root.
The official Agent performed these checks:

1. Authenticated model discovery; subsequent discovery reused the cached catalog.
2. First prompt used the explicit `gemini-3.8-flash-high` configuration, confirmed by inspection.
3. Created and tested fixture code; emitted text, thinking, tool updates and three authoritative
   file diffs. Permission and structured-question forms preserved the Agent's option identities;
   selecting beta returned option ID `2`.
4. A follow-up recalled a synthetic token; an independent task recalled its own different token.
5. An idle model change was confirmed by the Agent.
6. Cancellation settled the active prompt.
7. After closing/recreating the platform with the same Plugin data, inspection returned
   `history_only`; execution refused to create a replacement external Session.

## Desktop acceptance

Launched the built Electron app against an isolated temporary profile and a fixture project.
The isolation harness used the **real Host execution path**, not the fake native-model backend;
`MAKA_CU_REAL_MODEL_E2E` only selected the isolated profile and bounded native computer-use policy.
The external executor used the official binary and production Plugin bundles throughout.

- Opened the existing Composer model menu, browsed Antigravity, retained draft text and selected
  Gemini 3.8 Flash (High).
- Created a task through the UI. The Agent wrote `add.js` and `add.test.js` and ran Node tests.
  An independent `node --test add.test.js` check also passed (1/1).
- Approved tool permissions and answered the structured alpha/beta question with beta through
  Hosted Forms. The completed transcript recorded the selected answer.
- Submitted a follow-up; the Agent recalled the first-turn synthetic token correctly.
- Changed the model while idle to Gemini 3.7 Flash (High); the menu displayed the confirmed value.
- Started a long response, pressed Stop, and observed cancelled/interrupted settlement.
- Closed and relaunched Desktop using the same isolated profile. The transcript remained readable;
  the Composer showed process-lost/history-only guidance and a New Task action.

This run found and fixed an integration defect: automatic task naming tried to resolve an executor
as a native LLM connection, which drained the Host and cancelled the prompt. External naming now
uses the first message; unsupported native auxiliary calls fail as configuration errors. Naming and
recap regression tests protect that boundary.

## Automated coverage and review gate

Controlled SDK/stdio process tests cover retained multi-turn identity, exact option IDs, file and
symlink containment, cancellation settlement/timeouts, process crashes, descendant cleanup, and
history-only after loss. Contract/service tests additionally cover initial configuration, cached
catalog discovery, process-free inspection, per-task configuration isolation, question bridging,
atomic storage, malformed protocol input, and Host admission. Desktop tests cover stale discovery,
confirmed configuration, draft attachment refusal, native picker recovery and history-only UI.

Local validation includes all workspace suites, the production build, workspace type checks,
renderer architecture and hook checks, locale hygiene, ASF headers, Windows inventory, and the
release check (203 tests plus notice/dependency gates). The official binary and temporary test
profiles are kept outside the source tree.

Before the main rebuild below, high-concurrency runs exposed timing failures in existing code-mode,
shell-environment and Host-launcher tests. The code-mode suite (33 tests), complete runtime suite (3,564 tests), and
shell-environment suite (12 tests) passed on rerun. Those Host and Desktop reruns used four test
workers. Desktop passed all 2,777 tests; Host passed 1,989 tests with 12 platform skips (2,001 total).
No production behavior or test threshold was changed to accommodate timing failures.

Public CI, final PR review and merge remain the repository merge gate. This document does not mark
issue #5103's PR 2 checkbox complete or claim cross-process restoration.

## Rebuilt on current main

On 2026-09-22 this implementation was rebuilt on `8bde344b18d2c3b79f8f367d8b3645a4612606fc`
from `apache/maka` main. The rebuild retains main's per-model thinking defaults and the distinction
between untouched (`undefined`) and explicitly requested provider defaults (`null`), target-aware
message submission, and Session-local subscriptions. Executor configuration remains separate from
native model settings. Compatibility epoch 173 follows main's epoch 172. The branch contains the
three implementation commits directly on this base, without the previous history-only merge.

Validation after the rebuild: all 13 workspace suites passed (12,856 Node tests passed,
38 skipped, zero failed; 87 Python tests passed). This includes 2,803 Desktop tests, 1,999 Host
tests with 12 platform skips, and all ACP runtime/adapter tests. Workspaces ran sequentially with
four Node test workers per suite. The production build, all workspace type checks, renderer
architecture against the exact main base, hook checks, locale hygiene, lint/format, ASF headers,
Windows inventory (102 declarations), and release checks (203 tests) passed. New regressions cover
untouched/provider-default/explicit native thinking choices and external configuration isolation.
The locale catalogs now follow main's typed `UiCatalog` convention. The live official-Agent and
Desktop acceptance above predates this rebuild; it was not repeated against the rebuilt commits.
