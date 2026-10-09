<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements. See the NOTICE file distributed
  with this work for additional information regarding copyright ownership.
  The ASF licenses this file to you under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License. You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

# PR #5969: actual Electron image journey

Run on 2026-10-09, macOS arm64, Node 24.18.1, Electron 43.4.1. The production
implementation is `b535d57b364aace0b62f13bcaea72660563e0642`; the evidence branch
adds only this runner, the PNG fixture, and captured outputs.

The runner launches the built Maka application with a throwaway user-data
directory and the existing deterministic FakeBackend. It sends messages through
the actual composer and receives assistant Markdown through the real session
event stream. The renderer, contextBridge, main process, Runtime Host, HTTPS
downloader, filesystem reader, SQLite archive and attachment-byte reads use
production code. No media/storage method is mocked and no DOM or CSS is replaced.
This does not test a live model provider, a packaged release, Windows or Linux.

The colorful PNG is test input, not a screenshot of a substitute application.
Its bars are labeled stages, not measured performance. All five screenshots
are unedited captures of the running Electron application.

## Results

The single journey completed nine checks recorded in [results.json](results.json):

1. Remote HTTPS image appears automatically without a Load button.
2. Archived metadata and bytes read through the preload bridge match the fixture SHA-256.
3. Clicking the image opens the lightbox; Escape closes it.
4. Local file is read and archived byte-for-byte through the production Host.
5. The original local source is deleted.
6. Application privacy mode is enabled, blocking outbound media before restart.
7. A complete Electron restart replays the local image after source deletion.
8. The restarted application replays the remote archive with privacy mode still enabled.
9. Production CSP retains `img-src 'self' data: blob:`.

Replay checks compare both artifact identities and byte hashes before and after
restart. Archive metadata is inspected through a read-only SQLite connection;
archive bytes are read through the real renderer/preload/main/Host bridge.

## Reproduce

From the evidence branch root, on macOS with Node 24:

```sh
npm ci
npm --workspace @maka/desktop run build:with-deps
mkdir -p .maka-shots
npx esbuild scripts/chat-image-e2e-evidence.ts --bundle --packages=external --platform=node --format=esm --outfile=.maka-shots/chat-image-e2e-evidence.mjs
cd apps/desktop
node ../../.maka-shots/chat-image-e2e-evidence.mjs
```

The fixture helper isolates app state and removes its throwaway user-data
directory after completion. It never opens the user's existing workspace.
The HTTPS fixture is fetched from the abbreviated immutable commit ref
`fc8d30612`, and its SHA-256 is verified independently.

Open the two successful traces with Playwright Trace Viewer:

```sh
npx playwright show-trace docs/images/pr/chat-image-delivery/e2e-20261009/01-capture.trace.zip
npx playwright show-trace docs/images/pr/chat-image-delivery/e2e-20261009/02-replay.trace.zip
```

## Additional observation

A preliminary run using the fixture's full 40-character Git commit hash in
the URL was blocked by the existing display-redaction rule as a sensitive
destination. The final journey uses the short commit ref. This evidence does
not claim that public long-hex URLs or the previously reviewed network trust
boundary have been fixed.
