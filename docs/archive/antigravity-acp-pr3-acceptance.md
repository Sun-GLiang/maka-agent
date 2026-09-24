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

# Antigravity ACP PR 3 acceptance

PR 3 is tracked by [issue #5103](https://github.com/apache/maka/issues/5103).
The results below are from a new probe, separate from the successful PR 2
execution and earlier cross-process feasibility checks in
[the PR 2 record](antigravity-acp-pr2-acceptance.md).

## Real Agent prerequisite probe, 2026-09-24

- Official macOS arm64 `agy_acp_server.par` **1.1.1** with its matching
  `localharness_external`, ACP SDK **1.4.0**.
- The probe used a temporary toy project with a randomly generated synthetic
  token. An isolated temporary home copied only the existing OAuth token and
  ACP settings into mode-restricted files, but stalled before `session/new`
  completed. The method results below used the existing authenticated Agent
  home with the toy project. No credentials, Session IDs, token values, or
  project contents were recorded.
- `initialize` returned protocol version 1, `loadSession: true`, and
  `sessionCapabilities.resume`. `session/new` returned an external Session ID
  and confirmed `gemini-3.7-flash-high`.
- A fresh process accepted `session/resume` with the same ID and project
  directory and returned the same model. A second independent process also
  accepted `session/resume` for that ID. `session/load` accepted it and sent
  two `user_message_chunk` notifications and an
  `available_commands_update`. No successful Agent output existed to replay
  in this run.
- The first prompt and post-resume prompt each ended with `end_turn` but
  emitted an Agent execution error: the model request returned HTTP 403,
  reporting that the account was not eligible for Gemini Code Assist for
  individuals in the current location. The temporary profile with and without
  explicit HTTP(S) proxy variables stalled before Session creation. Direct access with
  the machine's SOCKS proxy configuration failed because the bundled Python
  lacked `python-socks`. Explicit local HTTP(S) proxy variables allowed
  Session creation but produced the same model 403.
- All probe-owned Agent process groups and temporary profiles were removed.

This probe **does not pass the PR 3 prerequisite gate**. It confirms
cross-process method acceptance, but cannot establish continued model context,
successful replay shape, duplicate or reordered replay behavior, or a crash
window where the Agent advanced beyond Maka's durable history. The 2026-09-12
PR 2 feasibility probe observed one successful output chunk and tool replay;
it did not send a post-resume prompt or establish reconciliation semantics.
Production restoration remains disabled until these behaviors are verified
with an eligible authenticated account and network route.
