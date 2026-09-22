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
This Desktop sequence was repeated after the final rebuild and review fixes on 2026-09-22.

- Selected Antigravity with the separate executor control, retained the main-style model menu,
  browsed all 11 models and selected Gemini 3.8 Flash (High).
- Created a task through the UI. The Agent wrote `add.js` and `add.test.js` and ran Node tests.
  An independent `node --test add.test.js` check also passed (1/1).
- Approved tool permissions and answered the structured alpha/beta question with beta through
  Hosted Forms. The completed transcript recorded the selected answer.
- The rebuilt Desktop task returned `PR2_UI_DONE`; its follow-up recalled `UI_ALPHA_5224` and
  the selected `beta` fixture name correctly. The fixture test independently passed (1/1).
- Changed the model while idle to Gemini 3.7 Flash (High); the menu displayed the confirmed value.
- Started a long response, pressed Stop, and observed cancelled/interrupted settlement.
- Stopped the isolated Host and relaunched Desktop using the same isolated profile. The transcript remained readable;
  the Composer showed process-lost/history-only guidance and a New Task action.

This run found and fixed an integration defect: automatic task naming tried to resolve an executor
as a native LLM connection, which drained the Host and cancelled the prompt. External naming now
uses the first message; unsupported native auxiliary calls fail as configuration errors. Naming and
recap regression tests protect that boundary.

## Rebuilt on current main and final verification

The final 2026-09-22 rebuild uses main commit `e6db756890c36a8d4396241cc4f3a6f180529d20`.
Merge conflicts were resolved against main's executor-specific model/reasoning fields and client
model-selection extension slot. Compatibility epoch **178** follows main's epoch 175.
Native model selection, thinking defaults and the distinction between untouched (`undefined`) and
explicit provider defaults (`null`) remain intact.

The official production Plugin acceptance above was **repeated after this rebuild** with official
ACP 1.1.1. All eleven checks passed, including model confirmation, file edits/tests, original
permission/question option identities, multi-turn context, independent tasks, idle model changes,
cancellation and restart history-only behavior. Existing Google authentication was reused.

Final local validation:

- Clean test build, production renderer build and every workspace type check passed.
- All 13 workspace suites passed: **12,883 Node tests passed, 38 skipped, zero failed**.
  Python: **75 passed, 12 skipped** (87 total). Workspaces ran sequentially.
- After adding the final empty-config/model compatibility edge cases, the complete Host Session
  catalog suite passed again (**67 tests**). The preceding targeted ACP, executor service/backend,
  durable-event mapping and catalog run passed **145 tests**.
- Renderer architecture passed against the exact main base; lint, formatting, Desktop/UI Knip,
  shell hook, locale, ASF header and Windows inventory gates passed.
- Release checks passed (**203 tests**, plus stale-output, notice and metadata checks).

Regression coverage verifies both model input forms, matching/contradictory values, an empty
configuration with an explicit model, unknown models before persistence, model pinning, and
cancellation racing `end_turn`, `max_tokens`, `refusal`, request failure or process crash. The
provider stop reason crosses the service/backend boundary and is stored in the runtime ledger;
timeouts and crashes remain interruption states. Controlled stdio tests also exercise filesystem
and symlink containment, retained identity, helper cleanup and history-only refusal.

## UI screenshots

These are actual Desktop screenshots captured from the isolated fixture profile on the rebuilt
branch. The original captures are hosted as GitHub attachments, not committed repository assets.
The Maka model control keeps main's UI logic. Antigravity has a separate executor selector, the
full 11-model catalog, untruncated selected names, and no Plugin icon in model labels. Both model
popovers have the same fixed height; long catalogs scroll.

| Maka model menu | Completed Antigravity task |
| --- | --- |
| ![Maka model menu](https://github.com/user-attachments/assets/c78dbf70-0e34-49ae-b455-e4bbda8a3971) | ![Antigravity completed task](https://github.com/user-attachments/assets/4fc2827b-feed-4639-9a6a-d50caf203055) |

Public CI, independent human approval and merge remain repository gates. This document does not
mark issue #5103's PR 2 checkbox complete. Cross-process restoration belongs to PR 3; modes and
expanded catalog lifecycle belong to PR 4. Neither is claimed by this PR.
