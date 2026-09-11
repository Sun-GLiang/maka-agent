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

# Antigravity ACP setup (PR1)

Settings → External Agents configures a separately installed official ACP distribution on a local macOS arm64 Runtime Host. Place `agy_acp_server.par` and its matching executable `localharness_external` in the same directory, save the server's absolute path, then check the connection or sign in with Google. Installing the Antigravity IDE alone does not supply this setup's executable configuration. Maka does not install the distribution.

Only the executable path is persisted in RuntimePolicy document schema 4. Schemas 2 and 3 migrate with an empty path. Setup requests compare the saved path before admission; editing it invalidates displayed results. Connection success does not establish authentication. Official credentials remain under the official process's control, outside Maka's credential store.

The Host directly uses ACP SDK 1.4.0. Setup initializes the process without file or terminal capabilities and never creates a session or sends a prompt. Login selects the observed `oauth-personal` method. Its stderr authorization link is forwarded through the existing Desktop `oauth_presentation` capability. The subprocess environment sets `BROWSER=/usr/bin/true` to suppress the official process's own browser launch and `ANTIGRAVITY_HARNESS_PATH` to its sibling helper. No raw authentication output is retained by Maka.

One attempt runs at a time. Duplicate IDs return the existing attempt; retries use new IDs. Page/Host changes, client disconnect, timeout, drain and shutdown cancel the attempt. Terminal results follow bounded process-tree cleanup, including SIGKILL escalation. Failed cleanup drains the Host. Terminal attempt history is in memory and bounded to 32 records. Handshake timeout is 30 seconds; authentication timeout is five minutes.

## Official behavior observed on 2026-09-10

Source: [Google's official macOS arm64 ACP 1.1.1 archive](https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip).

- `initialize` returned protocol 1 and agent version `agy_acp_server_1.1.1`.
- Advertised methods: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`. PR1 uses only Google personal OAuth.
- `authenticate` printed `Open the following link to authenticate the ACP server: ` followed by an HTTPS Google authorization URL to stderr. Unbuffered stderr was sufficient; no stdout prefix rewriting was needed.
- A real Desktop using isolated data saved the path and completed the connection check, displaying that login was unverified. A real login reached browser authorization; cancellation returned a cancelled state with no remaining server or helper process.
- The user completed Google browser authorization. The official authenticate request then returned JSON-RPC error -32000: account ineligible because Antigravity is unavailable in the current location. This observed response maps to the sanitized account_ineligible result. That initial account-eligibility blocker was cleared in the successful real-agent acceptance run below.

SHA-256 of the verified distribution files:

```text
agy_acp_server.par    9d900b93031fc42397f88206e14eba4193729bbef631a70b18e7a19631a6dfac
localharness_external e0a8ef9d80a1ffb178f945159dda33f73d4a5be65516642542352584b834fa2a
```

## Successful real-agent acceptance on 2026-09-11

The same official ACP 1.1.1 distribution was exercised through the built Desktop and its real Runtime Host in an isolated application data directory. The Google account holder completed browser authorization; no credentials were copied into Maka or into fixtures. A separate sanitized SDK probe confirmed protocol 1, agent version `agy_acp_server_1.1.1`, an empty successful `authenticate` result (`{}`), and completed process cleanup.

- **Initial login:** the official SDK authenticate request completed successfully, and Desktop displayed “Google 登录已完成。” only after setup cleanup. No `agy_acp_server.par` or `localharness_external` process remained.
- **Restart:** Desktop and its Host were both stopped and restarted. The saved executable path survived; login status initially remained unverified. A connection check succeeded without claiming authentication. A subsequent login succeeded without another browser authorization, exercising the official credential state.
- **Cancel and retry:** a real login was cancelled while connecting. Desktop reached the cancelled state, the process exited, and Retry completed a new successful login.
- **Page departure:** returning to the agent list during login released the process. Reopening setup showed unverified status rather than a stale result.
- **Client quit request:** SIGTERM was delivered to the isolated Desktop while an official setup process was observed running. The setup process exited; remaining test-application processes were subsequently stopped separately.
- **Host shutdown:** SIGTERM was delivered to the owning Host while its official setup process was observed running. Both Host and setup process exited; the Desktop generation reset without retaining the old result.

These are PR1 setup checks only: no external task, prompt, model selection or session restoration was exercised. Switching to a different configured Host target remains covered by controlled generation/ownership tests, not a separate real remote-Host acceptance run.

![Desktop after successful official Google authentication](./images/pr/antigravity-login-success.png)

## Regression evidence

Controlled tests use real SDK stdio subprocesses for handshake, split authentication output, rejection, crash, timeout, browser failure, cancellation and a helper ignoring SIGTERM. Coordinator tests cover deduplication, saved-path admission, platform/ownership restrictions, disconnect/drain and browser addressing. Desktop tests cover all three locales, double-click guards, stale Host generations, changed configuration and retry with a new attempt.

The affected package builds, Desktop type checks, renderer architecture check against main, protocol epoch check (135 → 136), third-party notices check, existing OAuth tests and the CLI ACP server regression suite pass. No task execution, model catalog, session restoration or additional workspace package is introduced.

On 2026-09-11, full repository build and typecheck, lint, format, Desktop/UI Knip and ASF header checks passed. The first full `npm test` run found an outdated CLI remote-owner exclusion assertion and four Host failures (three readiness timeouts and one Run-state assertion). The CLI assertion now includes all three local-only setup operations; no remote grants were added. The complete CLI suite then passed (926 passed, 3 skipped). All four affected Host files passed with file concurrency 1 (58 tests), and the complete Host suite passed independently with its normal test command (1,842 passed, 12 skipped). Other workspace suites passed in the initial full run. The original concurrent `npm test` invocation was not green; these independent reruns are recorded separately rather than claiming a clean full concurrent run.
