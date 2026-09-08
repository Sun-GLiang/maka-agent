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

# Draft: Revision-consistent, bounded Usage screen reads

- Status: Proposed; Storage semantics and product scope require review.
- Implementation status: Design only; no runtime behavior changes.
- Delivery scope: [Issue #4058](https://github.com/apache/maka/issues/4058).
- Design constraints: [Storage and protocol rules](https://github.com/apache/maka/discussions/4876).
- Source baseline inspected: `93a8dd785` on 2026-09-08.

This document describes a proposed cross-package contract. Implementation tasks,
review questions, and progress belong in the accompanying draft pull request.
It is not an accepted architecture decision or a claim of measured performance.

## Decision boundary

The core direction follows the [maintainer's P1 review](https://github.com/apache/maka/pull/4068#pullrequestreview-5124372706):
a single-transaction first screen, narrow SQL aggregation, bounded on-demand
activity pages, and revision-checked continuation without a retained Host dataset.

The concrete Storage boundaries and implementation mechanisms remain for
likun (@likun666661) to decide before production implementation begins. This
includes the query interface, revision identity and writer coverage, schema and
indexes, cursor comparator, repair/read ordering, source-accounting composition,
and scan/sort budget enforcement on the project's SQLite setup. The mechanisms
below are candidates for that review, not decisions already made on his behalf.

Activity filtering, additional breakdown/pricing pagination, and the automatic
refresh policy also need product-scope confirmation. Their required Storage
support is subject to likun's review. Tests for candidate mechanisms apply only
if those mechanisms are selected; the core consistency and bounded-read
requirements remain mandatory.

## User outcome

Selecting a Usage range displays summary cards, provider/model/tool breakdowns,
pricing information, and one bounded activity page from one database revision.
Selecting **All** expands the statistical time window; it does not cause Desktop
to retrieve every activity record. Additional pages are fetched only on demand.

If the underlying revision changes while the user browses, the screen reports
that its data changed and obtains a new first-page result. It never combines a
new activity page with older summary or pricing data.

## Scope and invariants

1. Storage owns the transaction, aggregation, source composition, cursor
   predicates, completeness metadata, and revision comparison behind one query
   interface. Host performs protocol projection; Desktop handles presentation.
2. All values in an initial screen result are read on the same SQLite handle in
   one short read transaction. No transaction survives a request or awaits IPC,
   session metadata I/O, or user input.
3. Subsequent reads compare the expected revision and read their data inside
   the same transaction. A mismatch returns `revision_changed` without a page.
4. Every variable-length output has item, text, and encoded-byte limits.
   Activity limits apply before record payloads enter application memory.
5. The renderer retains the visible page and bounded navigation metadata. It
   does not prefetch until exhaustion or compute statistics from loaded rows.
6. Usage records, canonical accounting rules, pricing mutation semantics, and
   repair ownership stay with their existing durable owners.

The core product scope includes activity pagination and a visible revision-change
state. Server-side activity filtering and additional breakdown/pricing pagination
are candidate extensions whose scope still needs confirmation for #4058. Exports,
retention-policy changes, retroactive repricing, and general-purpose query
infrastructure are outside this design.

## Storage query interface

The candidate interface below illustrates the core contract and optional list
pagination together. The section parameter and individual breakdown/pricing page
fields are not fixed interface requirements; likun will determine the Storage
query boundary after scope confirmation. Wire names are also provisional:

```text
readUsageScreen(range, activityFilters, budget)
  -> screen(revision, resolvedRange, summary, provenance,
            providersPage, modelsPage, toolsPage, pricingPage, activityPage)

readUsagePage(query, section, cursor, expectedRevision, budget)
  -> page(revision, rows, nextCursor, hasMore, completeness)
   | revision_changed
   | limit_exceeded
```

`range` resolves once to concrete `from`/`to` timestamps, including a fixed upper
bound for All. The returned query identity binds the resolved range and activity
filters; continuation must not resolve a moving range again. Activity filters
apply to the activity table, while headline statistics and breakdowns continue
to describe the selected time range. This preserves that distinction in the UI.

Breakdown and pricing collections must have bounded output. Paging them is one
candidate, subject to scope confirmation; a large number of providers, models,
tools, or overrides must not turn the initial response into an unbounded array.
If selected, their continuation reads use the same revision check and are
requested by the user, not drained by a background loop. Exact summary
counts are statistical results; pagination uses `hasMore`, without a separate
full scan solely to compute a table's exact total or omitted count.

## Transaction and repair ordering

One candidate ordering admits at most one repair pass through the existing
Usage writer, using its existing run/event limits, and commits it before the
initial screen read transaction. likun will determine the repair/read boundary
and how the existing repair authority participates. Repair is a write and must
not be hidden inside a read-only transaction. The screen read does not repeatedly repair until history is caught up.

Inside the read transaction, Storage reads the revision and all requested
projections, including the coverage/completeness state associated with that
revision. A repair result returned before the transaction is not sufficient
evidence that the transaction's data is complete: a new source event can commit
between repair and read. Durable checkpoint/source state must describe that
condition without an unbounded scan. Failure and incompleteness retain the
project's existing accounting semantics; they cannot silently become zero spend.

In this candidate ordering, page continuation performs no new repair pass.
Independently committed repair or source changes invalidate the expected revision when they affect the screen.
The read transaction ends before optional session-title hydration or transport
encoding. Metadata labels are presentation enrichment: only returned page IDs
are hydrated with bounded concurrency, and labels are outside the Usage revision.
If strict title consistency is required, that is a separate scope decision.

## Revision identity

One candidate is a root-scoped durable Usage change counter read alongside the
existing pricing revision, bound on the wire to the Host generation and a query
identity. It would be invalidation metadata, not a second collection of Usage
facts. This is not a preferred or required mechanism: likun will determine the
cheapest correct revision identity and writer coverage.

If a counter is selected, it must advance in the same committed transaction as
any mutation that changes a screen result. Any selected mechanism must detect
relevant changes, including:

- canonical attempt insert/update/delete, including correction of an older row;
- legacy LLM and tool record insert/update/delete;
- repair checkpoint or unreadable-evidence changes affecting provenance;
- relevant source-event changes that make previously complete coverage pending;
- supported migration/rebuild operations that change query interpretation.

Pricing changes use the pricing owner's existing revision. Built-in pricing and
interpretation changes are fenced by Host generation/compatibility. Rollback
must roll back invalidation as well. No-op mutations need not invalidate.

Storage review must enumerate real writer paths, including cascade deletion
and repair, before choosing the revision mechanism. If a counter is selected,
write-admission updates and narrowly scoped SQLite triggers are alternatives
for likun to assess. A root-wide counter would be conservative: writes
outside the selected range may also invalidate it. Range-specific revisions are
not a prerequisite, but invalidation frequency must be measured under active use.

Neither `MAX(ts)`, row count, a random request ID, nor a full-table hash supplies
the required cheap, mutation-sensitive revision. Reconnect, Host replacement,
and a supported database restore must invalidate earlier tokens even if a
durable counter value repeats. Page tokens are validated as untrusted inputs;
an invalid token/query combination is `invalid_request`, not an empty page.

## Query projections and accounting semantics

Canonical model calls already have typed columns and SQL aggregate fragments in
`packages/storage/src/model-call-usage-sql.ts`, used by `model-call-ledger.ts`.
Reuse their token, status, price, and coverage rules. The existing generic bucket
grouping is not automatically the Settings screen's grouping contract.

Legacy LLM and tool tables still contain `record_json` with limited indexed
columns. The proposed direction is to maintain the narrow scalar columns needed
for filtering, aggregation, ordering, and a bounded display projection alongside
their existing records. Avoid routing screen reads through helpers that decode
every JSON record. Indexes, migration cost, and scalar-column ownership need
review before fixing the schema.

If schema changes are selected, any migration must preserve historical records.
Some Usage rows intentionally survive Session deletion and cannot be reconstructed by replaying surviving
AgentRun events. Any scalar backfill is an explicit, resumable migration with a
watermark and bounded batches, not work performed by clicking All. The migration
marker belongs to the schema owner and is retired there after completion. Query
admission while a backfill is incomplete must be explicit; it cannot return a
partial total as complete or fall back to an unbounded JSON traversal.

The logical model-call query composes legacy and canonical contributions using
the existing source-accounting rules. Legacy history remains additive; history
compaction still writes legacy records on this baseline. Do not assume the
canonical table replaces those facts, infer deduplication from display IDs, or
invent missing legacy usage/cost classifications.

SQL projections must preserve:

| Concern | Required result |
| --- | --- |
| Provider breakdown | Settings connection identity: `connectionSlug` with provider fallback; distinct configured connections remain distinct |
| Model breakdown | Preserve Settings model-key semantics unless a product change is agreed |
| Tool breakdown | Calls, success/error counts, and weighted duration average over the selected range |
| Token accounting | Existing cache-read clamping, cache-write, reasoning, and total-token rules |
| Costs | Missing/unpriced is distinct from priced zero; recorded costs are not retroactively recomputed from current pricing |
| Coverage | Canonical coverage, legacy contribution, unreadable records, and pending repair remain visible |
| Empty ranges | Empty pages and valid zero counts, with no invented complete/free-spend claim |

If group pagination is selected, aggregate over the composed scalar relation
before paginating groups. Taking each source's top groups independently and merging them can omit the true top
combined group. Use deterministic group ordering with a unique tie-breaker.

## Activity cursor and filters

The conceptual cursor is `(timestamp, stableUniqueKey)`, ordered newest first
with a deterministic tie-breaker. Existing legacy/tool indexes are `(ts DESC,
id)`, but `storage_key`, not the displayed `id`, is their primary key. Therefore
`(ts, id)` alone must not be assumed unique.

A proposed logical identity is `(source, storage_key)` for legacy/tool rows and
`(source, attempt_id)` for canonical rows. The cursor includes the timestamp and
that source-qualified identity. Storage can seek independently into each indexed
source and merge only bounded candidate pages. The physical index ordering must
match the comparator, including the tie direction; tests cover equal timestamps
and repeated display IDs across and within sources.

If activity filtering is included, filters must apply in Storage before
pagination; the query/index strategy remains for likun to decide. Current
activity search is a case-insensitive substring over model/provider/tool names plus a status filter.
It must search the requested range, not only the visible page. Scalar columns
avoid JSON decoding, but an arbitrary substring is not made indexable by an
ordinary B-tree. Preserve the semantics with a bounded scan/time outcome, or
agree an appropriate search index before implementation; do not silently switch
to exact matching. Low-selectivity filters need their own query-plan evidence.

## Budgets and encoded size

Proposed starting limits reuse the existing activity ceiling of 100 items per
page and 48 KiB per activity page, with bounded text fields. Any selected
group/pricing pages and the complete screen envelope require separate explicit caps in the protocol;
multiple individually valid fragments must still fit the total frame budget.
These are output limits, not a claim that SQL execution is constant-time.

SQL selects scalar projections and a bounded number of candidate keys before
reading large payloads. A row's conservative byte bound includes UTF-8 content,
JSON escaping, field overhead, and optional enrichment. A bounded SQL prefix can
use those per-row bounds to stop before exceeding the page budget; it must not
calculate a running sum over the entire historical range just to choose a page.
Any supporting stored measurements must be updated with their source values.

Only selected projections enter application memory. Encode each normalized item
once and reuse its measurement for that value and boundary, reserving envelope
overhead and checking the final frame separately. An oversized item must produce
a defined bounded projection or `limit_exceeded`, never a silent omission or an
empty page that repeats the same cursor forever. `hasMore` can use a bounded
lookahead key rather than decoding the next large record.

## Host, IPC, and renderer behavior

The initial screen result is delivered through Desktop's existing `usage:summary`
IPC entry point. Runtime Host's Usage protocol gets an initial-screen query and
revision-checked page queries; preload and renderer services expose explicit
on-demand continuation. Operation names and codecs are finalized together.

Host retains no per-reader dataset between requests. It validates query/cursor
budgets and projects the Storage result. Desktop does not aggregate activity
rows, drain page cursors, or fetch all pricing/group pages behind the UI.

The renderer uses query tickets and Host-generation fencing for both initial
and continuation requests. An older range/filter response cannot overwrite the
newer selection. A Host change clears all prior data and navigation tokens.

On `revision_changed`, discard the pending continuation, mark the visible screen
as stale, and reload the first screen with a bounded automatic-refresh policy.
The retry count remains subject to product-scope confirmation; at most one
automatic reload per user action is a candidate, not a fixed requirement. Install
the complete new screen atomically. Do not append new rows to old statistics.
After the agreed retry budget is exhausted, a failed refresh retains an explicitly
stale screen with manual Refresh available; it never retries indefinitely.
Continuous writes may interrupt browsing, so that trade-off must be exercised under live activity.

The UI shows page counts or “more available” instead of presenting the currently
loaded row count as the historical total. Range/filter changes reset pagination.
If breakdown/pricing pagination is selected, its navigation is visible.
Navigation memory has a fixed bound and never grows with all visited activity rows.

## All-range performance contract

Application-side activity memory, payload decoding, and network output scale
with the page budget, not the number of historical calls. Additional pages must
seek from their cursor without an increasing offset-prefix read.

Exact all-time aggregates can still scan narrow indexed columns. SQL `GROUP BY`
may also sort many groups. The proposal does not promise constant-time All reads
or a fixed latency improvement without measurement. Query-plan and timing
evidence must inform likun's decision on the concrete scan/sort work boundaries
and enforcement mechanism under #4876. This draft does not mandate a new query
interruption facility or a particular typed budget outcome. If execution limits
are selected, they must actually bound or interrupt the relevant work on the
project's synchronous SQLite setup; a timer that fires only after a blocking
query returns is not enforcement.

If exact aggregation cannot meet the agreed work/interactive budget, ask likun
to assess alternatives, such as an incrementally maintained aggregate projection
or an explicitly limited outcome, and confirm scope before implementing them.
Never present partial aggregate results as complete. No latency threshold is claimed as an existing project guarantee.

## Verification contract

Storage tests exercise the public screen/page interface selected in review with
real SQLite. Mechanism-specific cases are conditional on the confirmed scope:

- concurrent append, correction, delete, pricing update, and repair cannot mix
  revisions; rollback and no-op behavior match the selected revision contract;
- pending-source evidence and checkpoint changes report correct completeness;
- canonical, legacy, and tool fixtures retain the accounting semantics above;
- equal timestamps, duplicate display IDs, sparse filters, deleted rows, empty
  pages, and Unicode/oversized fields preserve ordering and cursor progress;
- if included, extra group/pricing pages remain bounded and revision-checked;
- if needed, migrations preserve history after Session deletion; any backfill
  resumes from a watermark.

Protocol/IPC tests cover correlation, malformed tokens, query/Host mismatch,
item/byte/envelope ceilings, typed failure paths, and old/new epoch rejection.
Renderer tests cover rapid range changes, A → B → A, delayed page replies,
filter changes, atomic refresh, and continuously changing revisions. The Runtime
Host compatibility epoch is raised above main when the wire implementation lands;
this design-only change does not reserve or bump an epoch.

Performance evidence uses deterministic 10k, 50k, and 250k mixed-source records,
high-cardinality breakdowns, any included sparse filters, and a pending-repair
fixture. Record
cold/warm first-screen latency, aggregate versus activity SQL time, query plans,
decoded row counts, payload bytes, and Host/Desktop peak memory. Check first and
deep pages, local and delayed transport, and All under ongoing writes. Compare
with the same main baseline and fixture; do not substitute passing unit tests
for measured latency or claim a 50k-row test that was not run.

## Relevant implementation seams

- Storage ownership and transactions: `packages/storage/src/usage-stores.ts`.
- SQLite schema and legacy/tool queries: `sqlite-usage-schema.ts` and
  `sqlite-usage-store.ts` in that package.
- Canonical SQL rules: `model-call-ledger.ts` and `model-call-usage-sql.ts`.
- Accounting vocabulary: `packages/core/src/usage-ledger-merge.ts` and
  `packages/core/src/usage-stats/`.
- Host queries and codecs: `packages/runtime-host/src/server/usage-pricing-coordinator.ts`
  and `packages/runtime-host/src/protocol/usage-pricing.ts`.
- Desktop adaptation: `apps/desktop/src/main/runtime-host-usage-ipc-main.ts`,
  `runtime-host-client.ts`, preload contracts, and renderer Usage services/UI.
