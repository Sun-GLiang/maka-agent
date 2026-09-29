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

## Official Agent capability gate, 2026-09-29

- Platform: macOS arm64. Client: ACP SDK 1.4.0, Node.js 24.19.0.
- No official Antigravity executable or authenticated Agent home was present in this development environment. The official Google macOS arm64 1.1.1 archive was downloaded from the URL in `docs/antigravity-acp-settings.md`. Its server and helper SHA-256 values matched the already recorded distribution hashes there.
- An isolated, disposable ACP client used a temporary toy directory. `initialize` returned protocol version 1, Agent version `agy_acp_server_1.1.1`, and resume/load capabilities. `session/new` returned JSON-RPC `-32000 Authentication required`. The probe sent no prompt, created no Maka task, did not log an external Session ID, and terminated its process group and toy directory.
- The [official ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) listed version 1.2.1. Its Google macOS arm64 archive contained the matching server and helper (SHA-256 `c93c86c0f505fcdf8b13c695bed26d306141ef5446189d591397074d324db34e` and `1b8a2b712ca312c9769e425b800bfbcceec4770f19736404474d1e8e50d65456`). `initialize` returned Agent version `1.2.1`, protocol version 1 and resume/load capabilities; `session/new` again returned `-32000 Authentication required`. Authentication remains required before a real `configOptions` list can be observed.

The gate is **blocked by authentication**, not proven protocol incompatibility. Real mode IDs, mode/model interaction, confirmation responses, different-directory catalogs, restoration of mode, and the full Desktop acceptance path are **not verified** in this environment. Controlled fixtures below cannot satisfy those real-Agent checklist items. No account or proxy configuration was changed by this work.

## Authenticated official Agent follow-up, 2026-09-29

A later check on macOS arm64 used the official 1.2.1 archive linked by the ACP registry. Its server and helper matched the SHA-256 values above. With the existing authenticated Agent home and a disposable toy workspace:

- A production `AcpExecutor` catalog probe returned 11 real model IDs and three mode IDs: `default`, `auto_edit`, and `yolo`. The current mode was `default`.
- A fresh Session confirmed `gemini-3.8-flash-high` with `default`, then confirmed an idle change to `auto_edit`. Another idle change confirmed `gemini-3.7-flash-high` with `default`. Inspection returned those exact final values.
- After disposing and recreating the executor, inspection reported `restorable`. Explicit restoration retained the same external Session ID and reconfirmed the saved model and mode. The comparison was made in memory; the ID was not logged.
- Synthetic text prompts with both `gemini-3.8-flash-high` and `gemini-3.7-flash-high` failed with `acp_prompt_failed`. The Agent's output contained HTTP 403 and a location restriction. This check therefore does **not** establish successful prompt execution or post-restart context retention.
- A Desktop development build opened in an isolated worktree profile, but authenticated Desktop selection, refresh, idle change, and restart evidence remains outstanding. The isolated profile has no configured external Agent, and the prompt restriction above still blocks the complete task flow.

All probes used a temporary project, sent no private project content, and disposed their Agent processes. No account or network settings were changed. Real discovery, confirmed configuration, and same-Session restoration are now verified; full Desktop and successful prompt acceptance remain open.

## Implementation and controlled checks

The generic executor configuration and catalog now carry optional opaque mode IDs. ACP maps only real `select` mode options from the Agent; omitted mode preserves the Agent default. The same Host query and Desktop picker carry models and modes. Catalogs are keyed by resolved directory, share one bounded probe per directory, and can be invalidated by setup/login, policy changes, expiration, or explicit refresh. The retained task's configuration is inspected independently of draft discovery.

Catalog discovery calls the configured Agent's `session/new` in the selected workspace because ACP exposes configuration options per Session. That Agent may read workspace configuration, run its own startup hooks, or retain the empty probe Session in its own history; the client's disabled filesystem and terminal capabilities do not constrain the Agent's own process. Use this discovery only with an Agent trusted for that workspace. Maka sends no prompt, does not retain the probe as a task, deduplicates concurrent queries for the same directory, and disposes its connection after the probe. The 16-entry limit bounds cached catalogs, not the number of distinct directories being probed at once.

Configuration updates validate the complete target before applying it, use Agent `setConfigOption` confirmations, and attempt a complete rollback on failure. The saved continuity record keeps the confirmed mode while retaining compatibility with PR 3 records containing only `confirmedModel`. Restore compares the Agent's returned configuration against that record and refuses a mismatch.

Controlled tests cover the contract, prompt application, idle mode update, combined-option rollback, same-Session restore, directory cache isolation, refresh, login invalidation, and late notification handling.

## Final validation

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:renderer-architecture`, `npm run check:locale-hygiene`, and `npm run check:asf-headers`: passed.
- `node scripts/run-workspace-tests-parallel.mjs --concurrency=1` with the bundled Node.js 24.19.0 and Python 3.12.14: all workspaces passed. A separate three-workspace concurrent run was stopped after unrelated timing-sensitive Runtime Host integration cases failed under load; it is not counted as passing validation.
- The protocol epoch changed from 198 to 199 for the additive mode and refresh wire fields. `node scripts/protocol-epoch-check.mjs --staged` passed against the complete staged diff.
- Authenticated official-Agent and Desktop end-to-end checks remain blocked by the `session/new` authentication failure above. In particular, this run cannot claim a real mode list, confirmed mode switch, or restart continuation for an authenticated task. Those issue #5103 acceptance items require a signed-in official Agent and a fresh Desktop run.
