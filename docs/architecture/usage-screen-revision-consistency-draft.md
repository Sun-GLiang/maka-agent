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

# Draft: Revision-consistent Usage screen reads

- Status: Proposed; Storage semantics require review.
- Implementation status: Design only; no runtime behavior changes.
- Delivery scope: [Issue #4058](https://github.com/apache/maka/issues/4058).
- Design constraints: [Storage and protocol rules](https://github.com/apache/maka/discussions/4876).
- Source baseline inspected: `1ae4d5b89` on 2026-09-15.

This document defines the consistency contract for Settings Usage. It does not
set new performance targets, historical-size guarantees, admission budgets, or
latency requirements.

## Problem

On the inspected baseline, Desktop builds one Usage screen from independent
summary, LLM-log, tool-log, and pricing reads. The log reads are drained into
Desktop and provider/model/tool breakdowns are computed there. A Usage write,
repair, pricing mutation, or Host replacement between those reads can therefore
produce one rendered screen whose parts describe different database states.

The renderer now paginates the already-loaded activity array, which reduces the
number of rows rendered at once but does not give the screen a shared Storage
revision. Issue #4058 is about that consistency defect.

## Decision

One initial Storage operation returns the Usage statistics, breakdowns,
pricing/coverage, and first activity page from one read transaction and stamps
the result with one opaque revision. A continuation supplies that revision and
receives a page only when it still matches. A mismatch returns
`revision_changed` without rows.

Host retains no per-reader Usage dataset. Desktop retains the visible result and
the cursor metadata needed for navigation, but it never assembles a new screen
from responses carrying different revisions.

## Scope

This design includes:

- one Storage read transaction for every value installed as the initial screen;
- one opaque Usage-screen revision and complete invalidation coverage;
- revision-checked, query-bound activity continuation;
- Host-generation fencing across reconnect or Host replacement;
- preservation of current accounting, pricing, coverage, activity-filter, and
  historical-retention semantics;
- atomic Desktop installation and an explicit stale-screen state.

This design does not include:

- bounded-admission thresholds or new `limit_exceeded` product behavior;
- a guarantee that exact queries complete for arbitrary history sizes;
- incremental aggregate or completeness projections;
- new latency, memory, scan, sort, or availability targets;
- additional breakdown/pricing pagination or general-purpose query APIs;
- retention changes, retroactive repricing, exports, or coverage UI redesign.

Existing protocol item and encoded-byte limits remain in force. They are wire
safety constraints, not a new performance contract in this design.

## User-visible behavior

### Initial load

Selecting a range obtains one complete screen result. Desktop installs that
result atomically; it never preserves a summary from one attempt while replacing
logs or pricing from another.

If the selected Host changes before the result is installed, Desktop discards
the result and reloads from the new Host. An initial revision race may retry the
whole load a finite number of times. It may not degrade into independently
accepted fragments.

### Activity continuation

The first activity page belongs to the initial screen revision. Each later page
uses the same resolved range, activity filters, query identity, and expected
revision.

When the revision still matches, Storage returns the next page. When it has
changed, Storage returns `revision_changed` without a page. Desktop keeps the
already visible, internally consistent screen, marks it stale, and offers
Refresh. It does not append rows from the new revision or maintain a frozen copy
of the old Storage state.

This means continuous writes may interrupt continuation. The contract guarantees
consistency and bounded retry, not indefinite browsing of an old revision.

## Storage contract

The interface names below are illustrative; Storage review owns their final
placement and naming.

```text
readUsageScreen(resolvedRange, activityFilters)
  -> screen(revision, queryIdentity, summary, provenance,
            providerBreakdown, modelBreakdown, toolBreakdown,
            pricing, activityPage)

readUsageActivityPage(queryIdentity, cursor, expectedRevision)
  -> page(revision, rows, nextCursor, hasMore)
   | revision_changed(expectedRevision, actualRevision)
```

`readUsageScreen` executes its accounting queries and first activity selection
on one SQLite handle inside one read transaction. It does not compose independent
asynchronous store reads whose transactions can observe different states.

`readUsageActivityPage` opens a new read transaction, compares the expected and
actual revisions, and selects the page within that same transaction. It returns
no rows on mismatch. No transaction survives the request or awaits IPC, metadata
hydration, or user input.

The resolved range has fixed `from` and `to` values. `All` also receives a fixed
upper bound for this screen. The query identity binds that range and the activity
filters, so a cursor cannot be reused with a different query.

### Repair ordering

The existing Usage repair authority remains unchanged. An initial request may
ask that writer to perform the existing repair/catch-up pass before the screen
read. The repair transaction ends before the read transaction begins.

Storage derives summary, provenance, and coverage inside the screen transaction;
it does not trust an earlier repair result as a snapshot. A source commit between
repair and read is represented by the revision and coverage observed by the read
transaction. Continuation does not initiate repair; a later repair that changes
the screen invalidates its revision.

## Revision identity

The revision is invalidation metadata, not another copy or authority for Usage
facts. Its concrete representation is a Storage decision and is opaque on the
wire.

It must change in the same committed transaction as every mutation that can
change a screen result, including:

- legacy LLM and tool Usage insert, update, or delete;
- canonical model-call attempt and repair-checkpoint changes;
- source changes that affect pending, unreadable, or completeness evidence;
- pricing override changes;
- supported migration, rebuild, restore, or database replacement that changes
  the interpretation or contents of a screen.

Rollback must roll back invalidation. A no-op need not invalidate. Tokens from a
previous database incarnation or Host generation must not validate merely
because a numeric counter repeats.

Storage review must choose the update mechanism and audit the real writer paths.
An explicit counter and narrowly scoped triggers are implementation alternatives;
this consistency contract does not select between them. Existing pricing
revision and Desktop Host-generation fencing may form part of the opaque screen
revision rather than creating a second pricing owner.

`MAX(ts)`, row count, a request ID, or a full-table hash is not sufficient: the
revision must cheaply detect corrections and changes that do not advance the
maximum timestamp or row count.

## Activity cursor and filters

Activity ordering is newest first with a deterministic, unique tie-breaker. The
logical cursor is:

```text
(timestamp, source, stableStorageIdentity)
```

Displayed IDs are not assumed unique. Storage validates the cursor, its query
identity, and its position in the resolved range. Equal timestamps, duplicate
display IDs, multiple sources, empty pages, and deleted/corrected rows require
contract tests.

Existing activity filters retain their current meaning. Model/provider/tool
substring search and status filtering apply to the selected range before page
selection, not merely to the visible rows. Changing filters starts activity
navigation again and uses a query identity for the new filter values. Headline
statistics and breakdowns continue to describe the selected range, as they do
on the baseline.

Moving activity filtering into Storage is required because Desktop no longer
owns the complete activity array. This document does not add a new search index,
search budget, or matching semantics.

## Accounting and presentation invariants

The unified read reuses the existing canonical and legacy accounting rules. In
particular:

- provider grouping preserves connection identity with the existing fallback;
- model and tool grouping preserve their current keys and calculations;
- token fields retain current cache-read, cache-write, reasoning, and total
  semantics;
- unpriced usage remains distinct from priced zero;
- canonical and legacy contributions retain their existing composition rules;
- Usage history that currently survives Session deletion continues to survive;
- pricing mutations and historical cost interpretation do not change.

Session titles are presentation enrichment, not Usage accounting. If they are
hydrated outside the read transaction, they do not participate in the Usage
revision and may not change totals, ordering, cursor identity, or coverage.

## Host, IPC, and Desktop responsibilities

Storage owns the transaction, revision comparison, accounting composition, and
cursor predicates. Host validates and projects the result but retains no dataset
between requests.

Runtime Host's Usage protocol gains an initial-screen result plus a
revision-checked continuation result. Desktop's existing `usage:summary` IPC
entry point returns the complete initial screen. The compatibility epoch rises
above main when this wire change is implemented.

Desktop owns presentation and request supersession:

- a newer range, filter, Refresh, or Host generation invalidates older replies;
- a complete initial result replaces the previous screen atomically;
- continuation appends only a page carrying the current screen revision;
- `revision_changed` preserves the visible result, marks it stale, and stops
  continuation until Refresh;
- no background loop drains activity pages or rebuilds breakdowns from them.

## Verification contract

Storage tests exercise the selected public screen/page interface with real
SQLite:

- a write before, during, or after the initial read cannot mix revisions;
- repair, source/checkpoint, pricing, legacy, canonical, and tool mutations
  invalidate exactly as selected by the revision contract;
- rollback, no-op, restore, and repeated counter values cannot validate a stale
  token incorrectly;
- continuation compares revision and reads the page in one transaction;
- cursor ordering and query binding cover equal timestamps, duplicate display
  IDs, multiple sources, empty results, filters, corrections, and deletions;
- accounting and coverage match the existing public Usage behavior.

Protocol and Desktop tests cover malformed or mismatched tokens, Host
replacement, delayed replies, rapid range/filter changes, finite initial retry,
atomic screen replacement, stale-screen presentation, and rejection of a page
from another revision. Compatibility tests cover the epoch change.

This design makes no performance claim. Performance benchmarks, admission
limits, and arbitrary-history availability are not acceptance criteria for
issue #4058.

## Relevant implementation seams

- Storage ownership and transactions: `packages/storage/src/usage-stores.ts`.
- SQLite schema and legacy/tool queries: `packages/storage/src/sqlite-usage-schema.ts`
  and `packages/storage/src/sqlite-usage-store.ts`.
- Canonical accounting: `packages/storage/src/model-call-ledger.ts` and
  `packages/storage/src/model-call-usage-sql.ts`.
- Host protocol and coordination:
  `packages/runtime-host/src/protocol/usage-pricing.ts` and
  `packages/runtime-host/src/server/usage-pricing-coordinator.ts`.
- Desktop adaptation: `apps/desktop/src/main/runtime-host-usage-ipc-main.ts`,
  preload contracts, and renderer Usage services/UI.
