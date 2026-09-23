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

# ACP validation record

## PR6 review repair — September 23, 2026

This follow-up starts at PR #5621 head `fd2e6a68` in a separate worktree. The
older PR6 results below describe that original head; the results in this
section describe the repaired tree.

Four regressions were demonstrated before repair. Three added registry tests
failed on the original head: an owned but unattached Session leaked a newly
opened subscription after historical replay failed; unsupported restored
elicitation left the Host Turn waiting; and a cancelled restored question
submitted its late answer when Stop failed. An MCP test held the idle check,
admitted another client's Turn, then showed that replacement was still
accepted. After repair, those regressions pass. The cancellation suite also
checks restored permission selections and a newly arriving interaction ID.

The adapter now fences an adopted Turn's interaction broker before Stop, using
the observed Session, Turn, and run identity. An adopted observation failure
stops that exact active Host Turn and reports `observation_failed` without
inventing an interaction answer. The restored interaction regressions cover
unsupported elicitation capability and method, invalid answers, and output
delivery failure. Load failure closes only the attachment it opened,
independently of prior Session ownership; retry succeeds. MCP config
changes stage a new manager while the old process remains callable, then use
an opt-in Host capability replacement that checks active and pending root
admission at its commit point. Normal dynamic tool-list publication remains
unchanged. This wire contract advances the Runtime Host compatibility epoch
from 178 to 179. Shared context construction and canonical JSON reuse remove
the two review-noted duplications.

Validation after repair on macOS and Node 24.19.0:

| Check | Result |
| --- | --- |
| Full CLI dist suite | 1194 passed, 3 skipped, 0 failed; includes official SDK and real Host multi-client ACP child-process flows, prompt/load/resume, branch/revision, MCP, TUI and close/EOF tests. A second Host client starts a live Turn after the idle read and the Host rejects the staged MCP replacement. |
| Full Runtime Host dist suite | 2054 passed, 12 skipped, 0 failed. |
| Full Runtime dist suite | 3516 passed, 14 skipped, 0 failed. |
| Full Desktop main dist suite | 2815 passed, 0 failed. |
| Full Eval dist suite | 114 passed, 1 skipped, 0 failed; its 87 Python tests also passed. |
| `npm run lint`, `npm run format:check`, `npm run build`, `npm run typecheck` | Passed across the workspaces. |
| Desktop/UI knip, ASF headers, CLI notices, protocol epoch guard, `git diff --check` | Passed. |

The first repository-wide `npm test` ran workspaces concurrently and had
unrelated fixed-deadline failures in Runtime, Desktop, and Eval. Every failing
test passed when rerun in isolation; their complete workspace suites then
passed serially as recorded above. The existing Zed third-party smoke below
was performed on the original PR6 head. A new isolated Zed 1.20.2 smoke was
attempted, but UI automation could not operate its project window, so no
post-repair Zed result is claimed. The temporary Host and model fixture were
closed and removed.

The Desktop Electron E2E run passed 30 tests and failed 4 in Side Chat and
WorkHub UI flows. An isolated retry passed the reconstruction case but still
failed 3: two screenshot timeouts and a missing WorkHub dock backdrop. This
follow-up does not change Desktop UI files; these failures remain unverified
against the original PR head.

## PR6 local implementation — September 23, 2026

Base: Apache `main` at `b004473ed`, on isolated branch
`feat/acp-session-restore`. The original Antigravity checkout was not
modified. This local implementation adds standard `session/load` and
`session/resume`, durable replay and live Turn attachment, complete stdio MCP
reconfiguration, explicit `_maka/turn/resume`, and Session branch/revision
create/abandon routes. Prompt and restored Turns now share the production
`AcpTurnObservation` consumer and the existing Session channel, mapper,
interaction broker, and MCP publication path.

The follow-up hardens MCP replacement on an already attached Session: when
the Host reports an active Turn, a changed stdio configuration returns
`session_busy` before the existing MCP manager stops its processes or changes
the publication. Equivalent configuration still reuses the live process.
Official SDK and real Host tests now also cover a live Turn's historical
prefix followed by new output without duplicate chunks, a pending permission
answered after a second ACP process loads the Session, and explicit execution
of a ready interrupted Turn. A required MCP tool missing from the replacement
provider leaves the interrupted Turn `parked/safety_check_failed`; restoring
the matching server makes explicit resume start. Repeated load replays history
while repeated resume does not. A revision target remains usable after prompt
and returns `retained` when abandoned; an unused target returns `abandoned`. A failed
historical page read releases the newly opened subscription.

On this follow-up, the complete CLI dist suite passed 1185 tests with 3
skipped and no failures. CLI build and typecheck, repository lint and format,
and `git diff --check` passed. The earlier Desktop E2E and Zed smoke results
below were not repeated because this follow-up changes only CLI code, tests,
and ACP documentation.

The official ACP SDK child-process test crossed two ACP processes against one
real Runtime Host: process A created and prompted a Session, then process B
loaded it with changed MCP configuration, resumed it with an empty MCP list,
prompted it, queried a parked Turn resume, branched and prompted the target,
created revision targets, prompted one, retained it on abandon, and abandoned
the unused target. The real Host revision and
Turn/capability suites passed 104 tests. Focused registry tests include
multi-page replay (including a fragment-only page), live/history overlap,
pending interaction restoration, close during load, exact lost-response Turn
identity, and copy revision conflict/unknown target identity.

The final full CLI dist suite passed 1178 tests with 3 skipped and no failures.
The focused ACP suite passed 214 tests before the last two registry regressions;
the final registry suite passed 89 tests. The production workspace build and
workspace typecheck passed, as did lint, format, ASF headers, CLI notices,
Desktop/UI knip, and `git diff --check`. Runtime Host source and protocol did not
change, so no compatibility epoch update was required.

Desktop Electron E2E passed all 34 tests. Zed 1.20.2 passed a third-party smoke
with a disposable project and user-data directory, an isolated Runtime Host,
and a local deterministic model fixture. In Zed, the custom ACP agent created
a Session and answered a prompt. Reloading the agent opened a new ACP process;
its logs showed `session/load`, historical `session/update` replay, and a
successful load response. Zed kept the prior exchange visible, and a second
prompt on the restored Session completed with `stopReason: "end_turn"`. The
temporary Zed settings were restored after the smoke run.

The first GitHub CI rerun exposed a test-only scheduling race: a replay-overlap
test exhausted 100 event-loop checks before its fake transcript page read began.
The fake subscription now signals page-read entry directly. The focused test
and the complete CLI dist suite passed after this correction.

# PR5 validation record

## Follow-up main refresh

Merged Apache main `e6db756890c36a8d4396241cc4f3a6f180529d20`. Main now uses
epoch 175 for executor-model protocol changes; Session MCP advances it to 176,
preserving the complete main protocol history and both lifecycle fixes below.
The protocol epoch guard passed against that main commit.

On this merge result, `build:test`, the production build, workspace typechecking,
lint, format and Desktop/UI knip passed. The full Runtime Host dist suite passed
2006 tests with 12 skipped; the full CLI dist suite passed 1155 tests with 3
skipped. Neither suite had failures or cancellations. Desktop E2E was not rerun.

## September 22 conflict resolution and review

Merged Apache main `8bde344b18d2c3b79f8f367d8b3645a4612606fc`, preserving its
usage timestamp protocol change and moving Session-scoped MCP compatibility
from epoch 172 to 173. The protocol epoch guard passed against that main commit.

After a clean dependency install and application of the repository patches,
`npm run build:test`, `npm run build`, workspace typechecking, lint, format,
Desktop/UI knip, ASF headers and CLI third-party notices passed. The affected
ACP, MCP publication, TUI MCP, Host capability/composition/retirement and Core
grant suites passed 453 tests, including the real Host ACP child-process tests.
Full workspace tests and Desktop E2E were not rerun.

Review still identified two reproducible P2 lifecycle gaps: a replacement queued
after Session retirement can recreate its registration without notifying the
Client of retirement; and an empty MCP snapshot after a connection loss does not
withdraw the Host's lost binding, blocking subsequent prompt admission. These
findings were fixed in `7a1874d5a`: publication consults durable Session lifecycle
state inside the mutation lane, and ACP publishes an explicit empty scoped
registration to reconcile lost contracts while retaining retirement notification.
Both focused regression tests failed before the behavior changes and pass after
them. Additional tests cover a real MCP process killed while disconnected,
durable archive/removal and unarchive behavior, pre-creation publication, and
the registration bound for both empty and populated scopes.

On the fix commit, the complete Runtime Host dist suite passed 2006 tests with
12 skipped, and the complete CLI dist suite passed 1154 tests with 3 skipped;
both had zero failures or cancellations. The Core capability-grant test passed.
`npm run build:test`, `npm run build`, workspace typechecking, lint, format,
Desktop/UI knip, ASF headers, CLI third-party notices and the protocol epoch
guard all passed again. Standards and Spec reviews found no further actionable
P-level issues in the fix. Desktop E2E and other complete workspace suites were
not rerun; independent human review remains required.

## September 20 review follow-up

The γ branch was rebased onto Apache main `879e0a4bc`; its Host compatibility
epoch advances from 171 to 172. Session capability registrations now have a
per-provider limit, Session retirement is serialized with registration changes,
and a crashed MCP server no longer blocks later prompt admission after its tool
withdrawal has been published. The ACP documentation now states the stdio
transport's direct-child cleanup guarantee without promising cleanup of every
process a launcher may spawn.

`node scripts/protocol-epoch-check.mjs --base upstream/main` and the full
`npm run build:test` passed. The affected Runtime Host tests passed 153/153,
the ACP Session MCP tests passed 14/14, and all five real Host/ACP child-process
tests passed. Lint and format checks passed. The isolated worktree needed the
repository's dependency patches after `npm ci --ignore-scripts`; without those
patches, UI typechecking failed on patched dependency APIs.

This file retains the September 15 validation history of the original combined
PR #5222. The implementation is now split into α (tool projection), β (ACP
interactions), and γ (Session-scoped MCP). The unrelated Side Chat E2E flake
change described below is **not** included in these three branches. The original
commit and branch references below describe that historical run, not the new
stacked PR heads.

On the rebuilt split γ head based on Apache main `852a9748d`, `npm run build:test`,
workspace `npm run typecheck`, `npm run lint`, `npm run format:check`, ASF headers,
CLI third-party notices, and the protocol epoch guard (166 → 167) pass. All five
official-SDK real Host/MCP child-process tests pass, as do 50 targeted Runtime Host
capability tests and the Core MCP grant test. The full CLI `test:dist` reached 1148
passed and 3 skipped; its two failures are the unrelated local managed-Host
cold-start cases, which fail with the same `connect_failed` result on a clean
`852a9748d` control worktree. α independently has an official-SDK real Host
builtin-tool test; β adds the Stop-failure cancellation regression and stdio
interaction failure coverage. Full Runtime Host, Core and Desktop E2E suites have
not been repeated on the rebuilt split stack.

Validated on macOS with Node 24.19.0 and ACP SDK 1.4.0.
Branch: `feat/acp-tools-interactions-mcp`.
After PR #4862 merged, the branch was rebuilt as one PR5 commit and was most recently
refreshed onto Apache main commit `5f4614bfdba710fad44699bbd879e78806ab54da`.
Scope follows the [PR5 checklist](https://github.com/apache/maka/issues/3132#issuecomment-5386735709)
and the approved implementation plan.

The September 15 refresh also closes the remaining review races around cancelled
Turn interaction fences, authoritative Session registration retirement and failed
Turn tool-terminal delivery. Main had advanced the compatibility epoch to 154, so
the combined Session-scoped capability contract advances it once more to 155.

## Automated results

| Validation | Result |
| --- | --- |
| `npm run build` | Passed, including Desktop renderer and its notice attestation. |
| `npm run typecheck` | Passed across all workspaces after rebuilding workspace declarations. |
| `npm run check:cli-third-party-notices` | Passed. |
| `node scripts/protocol-epoch-check.mjs --base review/latest-main-5222` | Passed: changed protocol, epoch 154 → 155. |
| `node --test scripts/protocol-epoch-check.test.mjs` | 17 passed. |
| `npm run lint` / `npm run format:check` | Passed (3605 linted files, 2135 formatted files). |
| `git diff --check review/latest-main-5222...HEAD` | Passed. |
| MCP workspace tests | 250 passed. |
| Runtime Host workspace tests | 1946 passed, 12 skipped, including UDS scope isolation and existing Desktop/default registrations. |
| Core grant decoder test | Passed, including `mcp` and retained `desktop_mcp`. |
| CLI workspace tests | 1118 passed, 3 skipped, including the real ACP process boundary and all PR5 unit/integration suites. |
| Desktop and UI `knip` checks | Passed. |
| Desktop E2E | Current budget check passed with 38 tests in 22 files. The original Side Chat follow-up acceptance passed 10/10 under an isolated stress loop and in its then-current full suite; the detailed historical evidence remains below. |

The first CLI run overlapped the full MCP E2E suite and one child-cleanup assertion
hit its five-second test deadline. The failed case passed alone in 91 ms; the full
CLI suite then passed without concurrent load, including the same case in 187 ms.

The first GitHub Desktop E2E run exposed a test-side interaction race: an
optimistic queue row could appear before the Composer released its single-flight
send slot, so the test's immediate next Enter was correctly ignored. The same
missing readiness boundary also reproduced locally after a queue edit and before
dragging (1 failure in 10 runs). The E2E now waits for the actual enabled Send or
draggable control before acting; the same isolated loop then passed 10/10. The
full local suite passed 33 tests including this case; two unrelated macOS-native
focus/screenshot cases timed out once and both passed immediately when rerun.

## Real ACP process boundary

`acp-tools-child-process.test.ts` uses the official SDK, a real ACP child process,
a real execution Runtime Host, local model HTTP fixtures and actual stdio MCP
processes. Its five passing cases establish:

1. `create → prompt → tool_search → MCP ask permission → Session grant → tool result → end_turn → close`.
2. Modern MCP `inputRequired → elicitation/form → typed answer → same-call continuation`,
   with private continuation state excluded from the ACP transcript.
3. Parallel Sessions with the same server/tool names return distinct public
   fingerprints of their isolated environments and retain separate grants;
   closing one Session leaves the other's tools callable.
4. A client permission handler that never responds does not prevent
   `session/cancel`, `session/close`, or stdin EOF cleanup.
5. Fifteen retained ordinary Session attachments plus a sixteenth MCP Session
   complete MCP authorization and authoritative result reconciliation. A
   seventeenth attachment is then rejected by Host `operation_conflict`, proving
   reconciliation did not require another subscription slot.

The existing `acp-child-process.test.ts` real-process suite also passed its Session,
configuration, capacity, recovery, streaming, cancellation and EOF checks.

## Zed status

Zed 1.19.2 opened a disposable project containing the custom `Maka PR5 Validation`
agent and forwarded the existing `fixture` stdio MCP server. Under Zed's `Ask`
permission mode, the prompt `Run the configured MCP echo tool and return its result.`
completed the standard UI flow:

1. Zed displayed the `tool_search` card and then the `echo` card.
2. Zed displayed `Authorize a Session capability` with `capability: "mcp"`,
   `scope.kind: "mcp_tool"`, `serverId: "fixture"` and `toolName: "echo"`.
3. Selecting `Allow this scope for this Session` resumed the same Turn.
4. The `echo` card completed and Zed displayed the final assistant text
   `Zed PR5 MCP tool and permission flow completed.`

The captured ACP stream independently records the permission request, the answered
`allow` decision, and the authoritative terminal tool update with
`resultPending: false`. Its content and `rawOutput` both contain
`Zed PR5 MCP result verified`, followed by the prompt response
`{"stopReason":"end_turn"}`. This completes the remaining standard Zed
tool/permission acceptance without a private ACP route.
