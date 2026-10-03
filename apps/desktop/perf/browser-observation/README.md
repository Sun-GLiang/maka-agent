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

# Browser observation regression and measurement

## What changed

- `browser_snapshot` defaults to a bounded list of rendered controls and headings. `selector` scopes a unique form/dialog, and `maxElements` limits candidates. Both observation tools accept `start`; continue with the returned `nextStart` and unchanged scope/selector/limit, restarting at zero after document changes. Hidden nodes cannot permanently consume the scan budget. Closed menus, CSS-hidden controls and hidden input identifiers are excluded. `display:contents` descendants and children overriding inherited visibility remain observable.
- `browser_inspect` reports exact CSS match counts, rendered-match counts, candidate names, attributes, inherited enabled/readonly state, native checked/selected state and actionable CSS references. Explicit ARIA naming references can use hidden labels. References persist across observations of the same node, but not navigation/reload or replacement nodes.
- Structured observations and CSS actions run in a named CDP isolated world. The site can see reference attributes but cannot write their identity map or OpenCLI resolved-element slot. Legacy numbered refs retain their original execution environment.
- CSS click/type requests pin the uniquely observed node, serialize actions per conversation, and validate identity and effective enabled state throughout OpenCLI evaluation and native input. Native text/Enter requires the intended focus; native mouse events must still hit the intended target after hover/layout changes. Hit-testing also guards the DOM click fallback; offscreen targets are scrolled into view first. OpenCLI fallback cannot bypass a rejected receiver. Ambiguous requests return candidates without clicking, filling or pressing Enter. Markdown extraction refuses ambiguous regions rather than silently reading the first match, and includes recovery candidates.
- Observation uses the existing BrowserSession visibility and Origin-lease admission. Editable input values and editor content (including editable headings and headings containing editors) are omitted; empty and plaintext-only contenteditable hosts are discoverable; displayed submit/button/reset labels remain observable. Visibility scans are limited to 5,000 matches per page and output to 16,000 characters. Matching uses the normal DOM selector query to obtain an exact total; partial visible counts are null. Candidate and output truncation provide continuation offsets.
- `source: "opencli"` preserves a capped legacy snapshot for OpenCLI's supported shadow/iframe observations. It cannot be combined with scoped visible-snapshot arguments. OpenCLI itself is unchanged.

Rendered visibility is distinct from viewport visibility: offscreen rendered controls may be returned and OpenCLI can scroll to them. The structured observer covers the current document; it does not pierce shadow roots or iframe documents. Use the explicit legacy mode when those observations are required. Legacy numbered actions retain OpenCLI's resolver; the new CSS identity checks apply to structured references and CSS actions. Native event dispatch remains asynchronous: if a page changes after earlier input steps, the tool stops further actions and reports that prior effects may have occurred; it cannot roll them back.

## Reproduce

From the repository root, with workspace dependencies prepared:

```sh
npm --workspace @maka/desktop run build:test
npm --workspace @maka/desktop run typecheck
npm --workspace @maka/desktop run test:dist
npm --workspace @maka/desktop run test:browser-observation
npm --workspace @maka/desktop run smoke:browser:run
BROWSER_MEASURE_TRIALS=30 npm --workspace @maka/desktop run measure:browser-observation
```

The browser regression target and measurement default to system Chrome. CI runs the regression target against installed Playwright Chromium on the Desktop e2e lane; it does not require the historical baseline Git object. The regression target uses unchanged OpenCLI CDPBasePage with native mouse/keyboard transport; the timing replay uses BasePage fixture adapters without native input. Use `BROWSER_CHANNEL=chromium` with an installed Playwright Chromium. `BROWSER_MEASURE_OUTPUT=/path/to/result.json` optionally saves machine-readable results. `BROWSER_BASELINE_REF` overrides the baseline Git revision; the default is `4c79e3910e106c3af589ffb429143dd4de47d7d3`.

## Method

The browser only accesses a locally fulfilled `https://fixture.test` page. There are no GitHub requests, cookies, credentials, real submissions or LLM calls.

Both versions run their production tool implementations, the shared BrowserSession wrapper, and the **same unchanged OpenCLI BasePage** over a real Chromium/Playwright evaluation transport. The baseline tool source is read from the pinned Git revision and transpiled into a temporary, ignored build file. The view Host/bridge are fixture adapters, so approval UI and cross-process Client Capability transport are not timed.

The fixture contains 2,000 links in CSS-hidden/closed repository menus, a PR form, five matching submit buttons (one rendered), title/body fields, a preview, and a draft/ready selection menu. The baseline workflow deterministically replays classes of failed selectors observed in the earlier PR session. It is **not the optimal possible old-tool workflow**. The new workflow chooses fields/menu options by observed accessible names and returned refs, not guessed field IDs. Both workflows must fill the same values, choose ready-for-review and submit exactly once.

One warm-up per version precedes 30 measured runs per version. Order alternates to reduce scheduling/cache bias. Reported values are medians. Snapshot/output sizes are raw tool-response bytes, **not model token counts**; Runtime Host tool-result archiving is not part of this benchmark.

## Recorded result

The following timing and byte counts were recorded before the isolated-world and hit-testing follow-up; rerun the replay to measure those additional CDP checks.

Environment: macOS, Node `v24.19.0`, Chrome `154.0.8037.59`, OpenCLI `1.8.8`, viewport `960×720`. Baseline: `4c79e3910e106c3af589ffb429143dd4de47d7d3`.

Both initial snapshots observe the whole document: old default DOM tree versus new default rendered-control snapshot. The improvement does not rely on giving only the new version a manually selected form scope.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Tool calls to complete the fixture workflow | 17 | 11 | −35.3% |
| Failed locator calls | 6 | 0 | Eliminated |
| First snapshot response bytes | 105,035 | 2,425 | −97.7% |
| Total tool-response bytes | 106,060 | 4,038 | −96.2% |
| Cumulative tool execution time, median | 46.26 ms | 40.15 ms | −13.2% |

The real-browser regression driver also passed **24 checks** for hidden menus, hidden/password values, visibility overrides, `display:contents`, exact match counts, no-action ambiguity handling, stale/replacement refs, disabled targets, invalid-selector injection, scan/output limits and ambiguous scope rejection.

Follow-up verification (2026-10-01): **3,078 Desktop tests passed**; **2,183 Runtime Host tests passed, 12 platform-specific tests skipped**; the automated browser target passed **20 tests**, including the shared 23 DOM assertions (the replay adds its historical-baseline check for 24). Real Electron smoke passed **28 checks**, including the production tool wrappers over the actual bridge. Root build/typechecking, lint/format, affected tests and ASF headers passed. Native regressions include post-preflight/resolution replacement, redirected focus, hover/layout changes, pointer cleanup, concurrent actions, scan/output pagination, and icon/editor/Unicode compatibility.

Review fixes (2026-10-03): **3,080 Desktop tests**, **32 real-Chrome tests** and **28 real-Electron smoke checks** passed. New coverage includes overlays before JS fallback, forged refs before and during click/type, main-world resolved-slot tampering, editable headings, empty/plaintext-only editors, offscreen native clicks, legacy numbered refs after isolated observations, lost-context mouse release, and refusing to evaluate without an isolated context. Root build/typecheck, lint/format, Desktop/UI knip and ASF headers passed. A one-trial replay smoke retained 17 → 11 tool calls and 6 → 0 locator failures; it is not a new timing benchmark.

## Interpretation and limits

The main expected benefit is fewer observation/locator-recovery cycles and more actionable information per response, not the small millisecond savings in tool execution itself. The earlier PR trace spent almost all time on sequential model requests, not browser execution.

This controlled replay demonstrates reduced failure/call counts for the historical failure pattern, but does **not** prove that an autonomous agent will always choose the correct new tool or that real GitHub/LLM end-to-end latency improves by the same percentages. No claim is made that the previous 8m48s task now takes 31ms. A live before/after agent experiment is still needed to measure that separately.

These are Desktop main-process changes. Rebuild/restart a version from this branch to use the new tools; an already running Desktop does not hot-replace its browser implementation.
