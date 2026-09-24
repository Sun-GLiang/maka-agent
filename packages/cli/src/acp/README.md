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

# ACP live Session behavior

The adapter retains a Runtime Host subscription after the first prompt. Cancellation
and close use the subscription's current root identity, including a Turn started by
another Host client while the ACP attachment was idle. Close releases the subscription
and connection-local ownership; it does not delete or archive the durable Session.

ACP v1 message chunks are append-only. Matching replay and prefix extensions are
supported. If a completed or recovered message changes text or thinking that was
already streamed (including clearing it), the adapter rejects the prompt with
JSON-RPC error `-32603` and `error.data.code: unsupported_stream_revision` and requests
a stop of that prompt's exact live root. It never represents a replacement by inventing
a new message ID or reports `end_turn` for that failed projection. The client may
still display the already delivered partial text; ACP v1 cannot retract it. The
Session remains owned and can accept another prompt or be closed.

Local resource links must identify regular files. Filesystem admission rejects
non-regular files, including POSIX FIFOs, before reading their content.
After live attachment succeeds, the adapter uploads each linked file through the
Host's existing Session Artifact protocol and uses its canonical attachment
reference for Turn admission. Cancellation or close during an upload aborts staged
content and prevents that prompt from starting a Turn.

When a dispatched start loses its response, the adapter retries admission queries
with bounded deadlines instead of replaying the start. Only a matching Turn or
authoritative `not_found` settles admission. Exhausted reads report `outcome_unknown`;
explicit cancellation still returns `cancelled`, with the failed Stop diagnostic
retained. Shutdown can cancel an initial attachment waiting for transcript hydration
or reconnection without waiting for the Host to become available.

## Capabilities

| Feature | ACP v1 behavior |
| --- | --- |
| Session create, list, configure, prompt, cancel, close | Supported through the shared Runtime Host connection. |
| Tools | `tool_call` and cumulative `tool_call_update` snapshots. Host `toolUseId` is the stable `toolCallId`. |
| Questions | Requires the client to advertise `elicitation.form`; each question is an optional string field with option hints and free answers. Missing, blank, or declined answers remain unanswered; cancellation cancels the Turn. |
| Forms | Standard `elicitation/create`, preserving string, number, integer, boolean, enum and multi-enum types and constraints. Defaults are hints, never automatically submitted. Decline and cancel remain distinct answers. |
| Sandbox boundary and client capability approval | Standard `session/request_permission`. The `allow_always` choice explicitly grants only the displayed scope for this Session; `reject_once` denies it. Permission cancellation cancels the Turn. |
| MCP | Session-owned stdio servers supplied in `session/new.mcpServers`; discovered tools and MCP form continuation use the existing MCP manager and Host capability path. |
| Tool `permission` | Standard `session/request_permission`. One-shot allow/deny choices are preserved; eligible tool permissions also expose an explicit allow-for-this-Turn choice. Permission cancellation cancels the Turn. |
| Artifact query, upload, delete | Five concrete private routes include `_maka/artifact/query`, `_maka/artifact/ingest`, and `_maka/artifact/delete`. |
| Memory query and mutation | `_maka/memory/query` and `_maka/memory/mutate` expose the Host bundle contract. |
| Load/resume, replacing all MCP configuration, HTTP/SSE/OAuth | Deferred. |

## Artifact and Memory request extensions

These are Maka-specific JSON-RPC requests over the existing ACP connection. The
params and results are the Runtime Host typed shapes. They are available to
clients that explicitly call them; ACP v1 does not define standard Artifact or
Memory capability fields. Only these five method names are registered. Unknown
methods return `-32601`; malformed params return `-32602`. An optional ACP
`_meta` object is accepted and omitted before strict Host input validation.

| Method | Accepted `kind` values or input |
| --- | --- |
| `_maka/artifact/query` | `list_start`, `list_continue`, `get`, `read_text`, `read_binary`, `read_chunk` |
| `_maka/artifact/ingest` | `begin`, `chunk`, `commit`, `abort` |
| `_maka/artifact/delete` | `{ "sessionId": "...", "artifactId": "..." }` |
| `_maka/memory/query` | `state`, `entries_start`, `entries_continue`, `document_start`, `document_continue` |
| `_maka/memory/mutate` | `remember`, `propose`, `approve`, `reject`, `set_status`, `reset`, `restore_backup`, `replace_begin`, `replace_chunk`, `replace_commit`, `replace_abort` |

For example, after creating an ACP Session, upload bytes in chunks and read the
committed Artifact without any Host-local file path:

```json
{"method":"_maka/artifact/ingest","params":{"kind":"begin","sessionId":"SESSION","uploadId":"CLIENT_UUID","name":"report.bin","mimeType":"application/octet-stream","totalBytes":5,"contentSha256":"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}}
{"method":"_maka/artifact/ingest","params":{"kind":"chunk","sessionId":"SESSION","uploadId":"CLIENT_UUID","offset":0,"chunkBase64":"aGVsbG8="}}
{"method":"_maka/artifact/ingest","params":{"kind":"commit","sessionId":"SESSION","uploadId":"CLIENT_UUID"}}
```

The `committed.attachment.ref` is a `session_file`. Its `relativePath` is
the canonical `artifactId`. Pass that ID and the same `sessionId` to
`_maka/artifact/query` with `kind: "get"` or `"read_chunk"`. For a complete
export, start at `offset: 0`, append decoded `chunkBase64` bytes, and follow
`nextOffset` until it is `null`. `read_text` and `read_binary` are bounded
previews and can report failure; they are not complete export methods. List
continuations retain the returned `revision` and `nextCursor`; a changed
revision is a domain result that asks the client to start a new scan.

Artifact upload chunks are at most 48 KiB, read chunks at most 32 KiB, and one
uploaded attachment at most 50 MiB. The Host owns byte staging, checksum and
offset checks, upload identity, quotas and five-minute upload expiry. An open
upload is tied to its Host connection. Session close waits for its in-flight
Artifact requests and aborts known unfinished uploads; EOF closes the shared
connection and releases Host staging. A completed Artifact remains durable after
close. On reconnect, a prior upload may be gone; the client must use a new
upload identity. The adapter never resends an uncertain command. An interrupted
response reports `request_interrupted` with `reason` and `dispatch`; if
`dispatch` is `dispatched`, inspect Host state before deciding what to do.
Protected execution evidence can reject delete with `operation_conflict`.

Real Read-tool image results expose a bounded `_meta.maka.artifacts` entry
with `artifactId` and `maka://runtime/attachments/...` reference, plus a
visible read hint. Use the Artifact query route with the card's ACP Session ID
to fetch it. Result text and raw output remain subject to normal truncation
and redaction rules; the Artifact bytes are not embedded in the tool card.

Memory queries operate on the Host Memory bundle: `state`, one revision-bound
page of active/archived/proposal entries, or a 32 KiB document chunk for
`memory`/`pending`. Continue with the returned revision and cursor. Semantic
mutations use `expectedRevision`; restore also requires
`expectedBackupRevision`. The multipart replace route uses Host upload IDs,
offsets and SHA-256 integrity checks. Domain results such as
`revision_conflict`, `backup_revision_conflict`, `rejected`, `blocked`,
`safe_mode`, `missing`, and `revision_changed` remain results, not generic
JSON-RPC failures. Host `commit_outcome_unknown` remains an operation error;
clients must query before deciding whether to submit another mutation. A
session-scoped `remember` or `propose` requires a Session
owned by this ACP connection. Entry and proposal ID mutations retain the Host's
bundle-level authorization boundary.

Host policy controls whether Memory can be read or written, including
`enabled`, `agentReadEnabled` and incognito state. A committed, readable
entry is added by the Host to a later applicable Turn's model input. It does not
rewrite a model request already running. The ACP adapter does not assemble
or inject Memory itself.

The adapter saves the capabilities supplied during `initialize`. Missing form
capability, unsupported client methods, or invalid answers explicitly fail the
affected prompt and stop its exact Host Turn. Host owns interaction closure and
the canonical answer, including externally answered or replayed requests. Client
requests are fenced by Session, interaction, Turn/run, and attachment lifetime;
cancel and EOF release local waits even when the client never responds.
After a failed Stop, a cancelled Turn stays fenced even if its ACP prompt has
returned; only an authoritative terminal observation or attachment closure
releases the fence. An idle attachment does not present another client's Turn
interactions through this ACP connection.

## Tool output and completion

ACP projects Runtime Host tool activity as `tool_call` followed by cumulative
`tool_call_update` snapshots. Output, progress and previews update one card,
including when start arrives late. Input previews are labelled as previews. A
complete authoritative result replaces the live output. `contentOmitted` preserves
the existing display and requires transcript reconciliation. Raw input/output is
omitted when completeness cannot be established or its presentation would exceed
the limit. Late progress cannot reopen a terminal tool; authoritative results may
still correct its content. A tool without a result is marked interrupted without
replacing its last displayed output. Only an announced result without a matching
durable record fails a completed prompt.

Each tool retains at most 64 Ki characters and 512 chunks of presentation state.
Truncation is visible, and detected live output sequence gaps are marked. A
prompt may retain at most 1 Mi characters and 4096 tool identities; exceeding
either limit deliberately fails projection, rather than discarding another tool's
presentation. Terminal delivery
releases large payloads and retains bounded identity/digest information.

Before `turn.start`, the Session channel captures a transcript watermark. On
settlement and before successful prompt completion it rereads the target Turn to
the announced upper watermark, using the same subscription's paged transcript and
fragment decoder (the existing 16 MiB range assembly budget applies). Recovery
invalidates reads from the old subscription and starts again at the original cut.
This does not consume another subscription slot. Missing announced results, failed
reads and failed notifications prevent `end_turn`; cancellation and failed Turns
do not wait for missing results. An explicit cancellation still returns `cancelled`
if a notification had already failed. Only the channel decides Turn terminal state; the
registry waits for final projection delivery before returning `end_turn`.

## Session MCP ownership

The executable must be an absolute path. Duplicate server/env names, malformed
args/env and unsupported transports are rejected before starting processes.
Processes use the Session's working directory and the manager's existing
environment, credential exclusion, log redaction, discovery and cleanup behavior.
The configuration stays in memory and never edits user MCP settings.

Creation generates an ID, prepares and validates every requested server, publishes
the Session-scoped capabilities, then dispatches Host `session.create`. One failed
server releases the entire prepared group. A confirmed creation always returns its
ID even if optional configuration presentation fails. If the dispatched creation
response is lost, the error includes `sessionId` and `dispatch: "dispatched"`; the
adapter retains the connection-local reservation and MCP resources. The client can
continue with that ID or close it; creation is never silently retried.

Different Sessions can use the same server/tool names with different processes.
Registration replacement, unregister, disconnection and invocation routing respect
the target Session and owning connection. A default registration and its target
Session registration may not expose the same tool identity. Another Session cannot
borrow the registration through provider fallback. Reconnection republishes the
current tool snapshot without replaying calls, and prompt admission waits for the
current connection and tool revision to be published.
An empty snapshot is published too: it clears contracts lost during disconnection
and retains the Session retirement notification. Empty registrations share the
same per-provider limit as registrations with tools and are released on close.
Host publication checks durable archive/removal state inside its mutation queue;
never-created Session IDs remain valid for preparation, but retired IDs cannot
be republished. Unarchiving permits a fresh publication.

Generic MCP `ask` approval uses `admission: "mcp"` and the existing atomic Session
grant mechanism with `mcp_tool` scope. It does not elevate provider trust or grant
Host path access. Desktop MCP continues to use its existing capability. These wire
changes move the Host compatibility epoch from 175 to 176; grant storage needs no migration.
Close/EOF stops execution, releases subscriptions, unregisters the corresponding
capabilities and closes MCP transports before closing the shared Host connection.
The stdio transport stops its direct child; launchers that spawn further processes
must arrange for those processes to exit themselves.
If a server exits after creation, its tools are withdrawn and later prompts may
continue with the remaining published tools.

For a Zed custom agent, configure an absolute Maka executable with `args: ["--acp"]`
under `agent_servers`, following [Zed's external agent documentation](https://zed.dev/docs/ai/external-agents#custom-agents).
The standard tool and permission flow does not require a private ACP route.
