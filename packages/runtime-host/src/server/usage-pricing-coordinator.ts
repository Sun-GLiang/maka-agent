/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash } from 'node:crypto';
import { resolveUsageRange } from '@maka/core/model-call-usage-projection';
import type {
  PricingConfig,
  ToolInvocationRecord,
  UsageBucket,
  UsageLogRow,
  UsageQuery,
} from '@maka/core/usage-stats/types';
import { comparePricingModelKeys } from '@maka/core/usage-stats/pricing';
import {
  mergeUsageBuckets,
  mergeUsageLogs,
  mergeUsageSummary,
  type CanonicalUsageSource,
  type UsageProvenance,
} from '@maka/core/usage-ledger-merge';
import { BUILTIN_PRICING } from '@maka/runtime/telemetry';
import {
  authenticateInteractiveUsageStoresWriter,
  classifyInteractiveUsageStoresFailure,
  type InteractiveUsageStoresFailureClassification,
  type InteractiveUsageStoresWriter,
} from '@maka/storage/usage-stores';
import {
  encodePricingQueryResult,
  encodeUsageQueryResult,
  PRICING_PAGE_MAX_BYTES,
  PRICING_PAGE_MAX_ITEMS,
  USAGE_PAGE_MAX_BYTES,
  USAGE_PAGE_MAX_ITEMS,
  USAGE_PROJECTION_TEXT_MAX_BYTES,
  type OperationOutcome,
  type EffectivePricingEntry,
  type PricingMutateInput,
  type PricingQueryInput,
  type PricingQueryResult,
  type LlmUsageLogProjection,
  type ToolUsageLogProjection,
  type UsageLogProjection,
  type UsageQueryInput,
  type UsageQueryResult,
} from '../protocol/index.js';
import type { ConnectionContext, UsagePricingOperationHandlerMap } from './operation-dispatcher.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { readCanonicalUsage } from './canonical-usage-reader.js';
import {
  UsageSnapshotCache,
  UsageSnapshotCapacityError,
  type UsageSnapshotCacheOptions,
} from './usage-snapshot-cache.js';

/** Root-scoped projection over the authentic lease-bound usage stores. */
export class HostUsagePricingCoordinator {
  readonly handlers: UsagePricingOperationHandlerMap = {
    'usage.query': (input, context) => this.#queryUsage(input, context),
    'usage.snapshot.release': async (input, context) => {
      this.#usageSnapshots.release(context.connectionId, input.revision);
      return { ok: true, result: { released: true } };
    },
    'pricing.query': (input) => this.#queryPricing(input),
    'pricing.mutate': (input) => this.#mutatePricing(input),
  };

  readonly #stores: InteractiveUsageStoresWriter;
  readonly #requestDrain: () => void;
  readonly #activation: RuntimePolicyActivationGate;
  readonly #onCommittedPricingMutation: () => void;
  readonly #usageSnapshots: UsageSnapshotCache;
  #poisonDrainRequested = false;

  constructor(
    stores: InteractiveUsageStoresWriter,
    requestDrain: () => void,
    activation: RuntimePolicyActivationGate,
    onCommittedPricingMutation: () => void = () => {},
    usageSnapshotOptions: UsageSnapshotCacheOptions = {},
  ) {
    this.#stores = authenticateInteractiveUsageStoresWriter(stores);
    this.#requestDrain = requestDrain;
    this.#activation = activation;
    this.#onCommittedPricingMutation = onCommittedPricingMutation;
    this.#usageSnapshots = new UsageSnapshotCache(usageSnapshotOptions);
  }

  releaseConnection(connectionId: string): void {
    this.#usageSnapshots.releaseConnection(connectionId);
  }

  /**
   * Reads the canonical ledger for the window a query addresses (#1679). The
   * range is resolved once here so both sources answer the same window.
   */
  async #canonicalUsage(
    query: UsageQuery,
    now: number,
    repair = true,
  ): Promise<CanonicalUsageSource> {
    return readCanonicalUsage(this.#stores, query, now, repair);
  }

  async #queryUsage(
    input: UsageQueryInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'usage.query'>> {
    try {
      const now = Date.now();
      if (input.kind === 'snapshot_start') {
        return {
          ok: true,
          result: await this.#startUsageSnapshot(context.connectionId, input.range, now),
        };
      }
      if (input.kind === 'snapshot_logs') {
        const snapshot = this.#usageSnapshots.get(context.connectionId, input.revision);
        if (!snapshot) return usageRevisionChanged(input.revision);
        const rows = input.source === 'llm' ? snapshot.llmRows : snapshot.toolRows;
        if ((input.offset ?? 0) > rows.length) return invalidUsageOffset();
        return {
          ok: true,
          result: usageSnapshotLogPage(
            input.revision,
            input.source,
            rows,
            input.offset ?? 0,
            input.limit ?? USAGE_PAGE_MAX_ITEMS,
            input.source === 'llm' ? snapshot.llmTruncated : snapshot.toolTruncated,
          ),
        };
      }
      if (input.kind === 'snapshot_pricing') {
        const snapshot = this.#usageSnapshots.get(context.connectionId, input.revision);
        if (!snapshot) return usageRevisionChanged(input.revision);
        if ((input.offset ?? 0) > snapshot.pricingEntries.length) return invalidUsageOffset();
        return {
          ok: true,
          result: usageSnapshotPricingPage(
            input.revision,
            snapshot.pricingEntries,
            input.offset ?? 0,
            input.limit ?? PRICING_PAGE_MAX_ITEMS,
          ),
        };
      }
      if (input.kind === 'summary') {
        const merged = mergeUsageSummary(
          await this.#stores.telemetry.summary(input.query),
          await this.#canonicalUsage(input.query, now),
          input.query,
          now,
        );
        const { provenance, ...summary } = merged;
        return {
          ok: true,
          result: encodeUsageQueryResult({ kind: 'summary', summary, provenance }),
        };
      }
      if (input.kind === 'buckets') {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? USAGE_PAGE_MAX_ITEMS;
        const legacy = await this.#stores.telemetry.buckets(input.query, input.groupBy);
        // Tool buckets group tool invocations, which the model-call ledger does
        // not describe; there is nothing canonical to merge into them.
        const merged =
          input.groupBy === 'tool'
            ? { buckets: [...legacy], provenance: EMPTY_PROVENANCE }
            : mergeUsageBuckets(
                legacy,
                // Only the first page repairs; later pages reuse it.
                await this.#canonicalUsage(input.query, now, offset === 0),
                input.query,
                input.groupBy,
                now,
              );
        if (offset > merged.buckets.length) return invalidUsageOffset();
        return {
          ok: true,
          result: encodeUsageQueryResult(
            usagePage(
              'buckets',
              merged.buckets.map(projectUsageBucket),
              merged.buckets.length,
              offset,
              limit,
              merged.provenance,
            ),
          ),
        };
      }
      const offset = input.offset ?? 0;
      const limit = input.limit ?? USAGE_PAGE_MAX_ITEMS;
      if (input.source === 'tool') {
        const page = await this.#stores.telemetry.toolLogs(input.query, offset, limit);
        if (offset > page.total) return invalidUsageOffset();
        return {
          ok: true,
          result: encodeUsageQueryResult(
            usageLogPage('tool', page.rows.map(projectToolUsageLog), page.total, offset, limit),
          ),
        };
      }
      // Both sources are newest-first, so the merged page can only be drawn
      // from each source's own first `offset + limit` rows.
      const legacy = await this.#stores.telemetry.logs(input.query, 0, offset + limit);
      const merged = mergeUsageLogs(
        legacy,
        // Only the first page repairs; later pages reuse it.
        await this.#canonicalUsage(input.query, now, offset === 0),
        input.query,
        now,
        offset,
        limit,
      );
      if (offset > merged.total) return invalidUsageOffset();
      return {
        ok: true,
        result: encodeUsageQueryResult(
          usageLogPage(
            'llm',
            merged.rows.map(projectUsageLog),
            merged.total,
            offset,
            limit,
            merged.provenance,
          ),
        ),
      };
    } catch (error) {
      if (error instanceof UsageSnapshotCapacityError) {
        return {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Usage snapshot capacity is occupied',
          },
        };
      }
      return this.#mapReadFailure<'usage.query'>(error, 'Usage authority');
    }
  }

  async #startUsageSnapshot(
    connectionId: string,
    range: UsageQuery['range'],
    now: number,
  ): Promise<Extract<UsageQueryResult, { kind: 'snapshot_started' }>> {
    const query: UsageQuery = { range: resolveUsageRange(range, now) };
    const captureLimit = this.#usageSnapshots.activityLimit + 1;
    const captured = await this.#stores.captureUsageSnapshot({
      query,
      activityLimit: captureLimit,
    });
    const canonical: CanonicalUsageSource = {
      attempts: captured.canonical.attempts,
      unreadableRecords: captured.canonical.unreadableRecords + captured.repair.unreadableEvents,
      pendingRepairs: captured.repair.pendingRuns,
    };
    const mergedSummary = mergeUsageSummary(captured.legacySummary, canonical, query, now);
    const { provenance, ...summary } = mergedSummary;
    const mergedLogs = mergeUsageLogs(
      captured.legacyLlmLogs,
      canonical,
      query,
      now,
      0,
      captureLimit,
    );
    const retained = this.#usageSnapshots.retain(connectionId, {
      summary,
      provenance,
      llmRows: mergedLogs.rows.slice(0, this.#usageSnapshots.activityLimit).map(projectUsageLog),
      llmTruncated: mergedLogs.total > this.#usageSnapshots.activityLimit,
      toolRows: captured.toolLogs.rows
        .slice(0, this.#usageSnapshots.activityLimit)
        .map(projectToolUsageLog),
      toolTruncated: captured.toolLogs.total > this.#usageSnapshots.activityLimit,
      pricingEntries: projectEffectivePricingEntries(captured.pricing.overrides),
    });
    return encodeUsageQueryResult({
      kind: 'snapshot_started',
      revision: retained.revision,
      summary: retained.summary,
      provenance: retained.provenance,
    }) as Extract<UsageQueryResult, { kind: 'snapshot_started' }>;
  }

  async #queryPricing(input: PricingQueryInput): Promise<OperationOutcome<'pricing.query'>> {
    try {
      const snapshot = await this.#stores.pricing.snapshot();
      if (input.kind === 'continue' && input.revision !== snapshot.revision) {
        return {
          ok: true,
          result: encodePricingQueryResult({
            kind: 'revision_changed',
            expectedRevision: input.revision,
            actualRevision: snapshot.revision,
          }),
        };
      }
      const entries = projectEffectivePricingEntries(snapshot.overrides);
      const offset = input.kind === 'start' ? 0 : input.offset;
      if (offset > entries.length || (input.kind === 'continue' && offset === entries.length)) {
        return {
          ok: false,
          error: { code: 'invalid_request', message: 'Pricing offset is invalid' },
        };
      }
      return {
        ok: true,
        result: createPricingPage(snapshot.revision, entries, offset),
      };
    } catch (error) {
      return this.#mapReadFailure<'pricing.query'>(error, 'Pricing authority');
    }
  }

  async #mutatePricing(input: PricingMutateInput): Promise<OperationOutcome<'pricing.mutate'>> {
    return this.#activation.runMutation(() => this.#mutatePricingWithinActivation(input));
  }

  async #mutatePricingWithinActivation(
    input: PricingMutateInput,
  ): Promise<OperationOutcome<'pricing.mutate'>> {
    try {
      const stored =
        input.mutation.kind === 'upsert'
          ? await this.#stores.pricing.upsert(input.expectedRevision, input.mutation.pricing)
          : await this.#stores.pricing.delete(input.expectedRevision, input.mutation.modelKey);
      if (stored.changed) this.#onCommittedPricingMutation();
      return {
        ok: true,
        result: {
          kind: stored.changed ? 'committed' : 'unchanged',
          revision: stored.snapshot.revision,
        },
      };
    } catch (error) {
      const failure = classifyInteractiveUsageStoresFailure(error);
      if (failure.kind === 'commit_outcome_unknown') {
        this.#onCommittedPricingMutation();
      }
      return this.#mapMutationFailure(failure);
    }
  }

  #mapMutationFailure(
    failure: InteractiveUsageStoresFailureClassification,
  ): OperationOutcome<'pricing.mutate'> {
    switch (failure.kind) {
      case 'revision_conflict':
        return {
          ok: true,
          result: {
            kind: 'revision_conflict',
            expectedRevision: failure.expectedRevision,
            actualRevision: failure.actualRevision,
          },
        };
      case 'invalid_request':
        return {
          ok: false,
          error: { code: 'invalid_request', message: 'Pricing mutation is invalid' },
        };
      case 'lifecycle':
        return {
          ok: false,
          error: { code: 'host_draining', message: 'Runtime Host is draining' },
        };
      case 'commit_outcome_unknown':
        this.#requestPoisonDrain();
        return {
          ok: false,
          error: {
            code: 'commit_outcome_unknown',
            message: 'Pricing mutation commit outcome is unknown',
          },
        };
      case 'persistence_failed':
        if (failure.needsDrain) this.#requestPoisonDrain();
        return {
          ok: false,
          error: {
            code: 'persistence_failed',
            message: 'Pricing authority persistence failed',
          },
        };
      case 'unknown':
        throw failure.error;
    }
  }

  #mapReadFailure<K extends 'usage.query' | 'pricing.query'>(
    error: unknown,
    authority: string,
  ): OperationOutcome<K> {
    const failure = classifyInteractiveUsageStoresFailure(error);
    switch (failure.kind) {
      case 'invalid_request':
        return {
          ok: false,
          error: { code: 'invalid_request', message: `${authority} request is invalid` },
        } as OperationOutcome<K>;
      case 'lifecycle':
        return {
          ok: false,
          error: { code: 'host_draining', message: 'Runtime Host is draining' },
        } as OperationOutcome<K>;
      case 'commit_outcome_unknown':
        this.#requestPoisonDrain();
        return {
          ok: false,
          error: { code: 'persistence_failed', message: `${authority} persistence failed` },
        } as OperationOutcome<K>;
      case 'persistence_failed':
        if (failure.needsDrain) this.#requestPoisonDrain();
        return {
          ok: false,
          error: { code: 'persistence_failed', message: `${authority} persistence failed` },
        } as OperationOutcome<K>;
      case 'revision_conflict':
        throw error;
      case 'unknown':
        throw failure.error;
    }
  }

  #requestPoisonDrain(): void {
    if (this.#poisonDrainRequested) return;
    this.#poisonDrainRequested = true;
    this.#requestDrain();
  }
}

/** Provenance of a result the model-call ledger has nothing to say about. */
const EMPTY_PROVENANCE: UsageProvenance = {
  coverage: {
    attempts: 0,
    pricedAttempts: 0,
    unpricedAttempts: 0,
    usageReportedAttempts: 0,
    usagePartialAttempts: 0,
    usageMissingAttempts: 0,
  },
  legacyRecords: 0,
  unreadableRecords: 0,
  pendingRepairs: 0,
};

function invalidUsageOffset(): OperationOutcome<'usage.query'> {
  return {
    ok: false,
    error: { code: 'invalid_request', message: 'Usage offset is invalid' },
  };
}

function usageRevisionChanged(revision: string): OperationOutcome<'usage.query'> {
  return {
    ok: true,
    result: encodeUsageQueryResult({ kind: 'revision_changed', expectedRevision: revision }),
  };
}

function usageSnapshotLogPage(
  revision: string,
  source: 'llm' | 'tool',
  allRows: readonly UsageLogProjection[],
  offset: number,
  limit: number,
  truncated: boolean,
): Extract<UsageQueryResult, { kind: 'snapshot_logs' }> {
  const rows = fitBoundedPageItems(
    allRows.slice(offset, offset + limit),
    offset < allRows.length,
    USAGE_PAGE_MAX_BYTES,
    (candidate) => {
      const nextOffset = offset + candidate.length;
      return {
        kind: 'snapshot_logs',
        revision,
        source,
        rows: candidate,
        offset,
        total: allRows.length,
        nextOffset: nextOffset < allRows.length ? nextOffset : null,
        truncated,
      } as const;
    },
    'Canonical Usage snapshot item',
  );
  const nextOffset = offset + rows.length;
  return encodeUsageQueryResult({
    kind: 'snapshot_logs',
    revision,
    source,
    rows,
    offset,
    total: allRows.length,
    nextOffset: nextOffset < allRows.length ? nextOffset : null,
    truncated,
  } as Extract<UsageQueryResult, { kind: 'snapshot_logs' }>) as Extract<
    UsageQueryResult,
    { kind: 'snapshot_logs' }
  >;
}

function usageSnapshotPricingPage(
  revision: string,
  allEntries: readonly EffectivePricingEntry[],
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'snapshot_pricing' }> {
  const entries = fitBoundedPageItems(
    allEntries.slice(offset, offset + limit),
    offset < allEntries.length,
    PRICING_PAGE_MAX_BYTES,
    (candidate) => {
      const nextOffset = offset + candidate.length;
      return {
        kind: 'snapshot_pricing',
        revision,
        entries: candidate,
        offset,
        total: allEntries.length,
        nextOffset: nextOffset < allEntries.length ? nextOffset : null,
      } as const;
    },
    'Canonical Usage snapshot pricing entry',
  );
  const nextOffset = offset + entries.length;
  return encodeUsageQueryResult({
    kind: 'snapshot_pricing',
    revision,
    entries,
    offset,
    total: allEntries.length,
    nextOffset: nextOffset < allEntries.length ? nextOffset : null,
  }) as Extract<UsageQueryResult, { kind: 'snapshot_pricing' }>;
}

function createPricingPage(
  revision: number,
  entries: readonly EffectivePricingEntry[],
  offset: number,
): PricingQueryResult {
  const items = fitBoundedPageItems(
    entries.slice(offset, offset + PRICING_PAGE_MAX_ITEMS),
    offset < entries.length,
    PRICING_PAGE_MAX_BYTES,
    (candidate) => {
      const nextOffset = offset + candidate.length;
      return {
        kind: 'page',
        revision,
        offset,
        entries: candidate,
        nextOffset: nextOffset < entries.length ? nextOffset : null,
      } satisfies PricingQueryResult;
    },
    'Canonical pricing entry',
  );
  const nextOffset = offset + items.length;
  return encodePricingQueryResult({
    kind: 'page',
    revision,
    offset,
    entries: items,
    nextOffset: nextOffset < entries.length ? nextOffset : null,
  });
}

function projectEffectivePricingEntries(
  overrides: readonly Readonly<PricingConfig>[],
): readonly EffectivePricingEntry[] {
  const builtinsByKey = new Map(BUILTIN_PRICING.map((pricing) => [pricing.modelKey, pricing]));
  const overridesByKey = new Map(overrides.map((pricing) => [pricing.modelKey, pricing]));
  const modelKeys = new Set([...builtinsByKey.keys(), ...overridesByKey.keys()]);

  return [...modelKeys].sort(comparePricingModelKeys).map((modelKey) => {
    const override = overridesByKey.get(modelKey);
    if (override) {
      return {
        pricing: override,
        source: 'custom',
        resetEffect: builtinsByKey.has(modelKey) ? 'restore_builtin' : 'become_unpriced',
      };
    }
    return { pricing: builtinsByKey.get(modelKey)!, source: 'builtin' };
  });
}

function usagePage(
  kind: 'buckets',
  allItems: readonly UsageBucket[],
  total: number,
  offset: number,
  limit: number,
  provenance: UsageProvenance,
): Extract<UsageQueryResult, { kind: 'buckets' }> {
  const source = allItems.slice(offset, offset + limit);
  const items = fitBoundedPageItems(
    source,
    offset < total,
    USAGE_PAGE_MAX_BYTES,
    (candidate) => {
      const nextOffset = offset + candidate.length;
      return bucketPageResult(
        candidate,
        total,
        offset,
        nextOffset < total ? nextOffset : null,
        provenance,
      );
    },
    'Canonical usage item',
  );
  const nextOffset = offset + items.length;
  return bucketPageResult(items, total, offset, nextOffset < total ? nextOffset : null, provenance);
}

function bucketPageResult(
  items: readonly UsageBucket[],
  total: number,
  offset: number,
  nextOffset: number | null,
  provenance: UsageProvenance,
): Extract<UsageQueryResult, { kind: 'buckets' }> {
  return { kind: 'buckets', buckets: items, offset, total, nextOffset, provenance };
}

function usageLogPage(
  source: 'llm',
  allItems: readonly LlmUsageLogProjection[],
  total: number,
  offset: number,
  limit: number,
  provenance: UsageProvenance,
): Extract<UsageQueryResult, { kind: 'logs'; source: 'llm' }>;
function usageLogPage(
  source: 'tool',
  allItems: readonly ToolUsageLogProjection[],
  total: number,
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'logs'; source: 'tool' }>;
function usageLogPage(
  source: 'llm' | 'tool',
  allItems: readonly UsageLogProjection[],
  total: number,
  offset: number,
  limit: number,
  provenance?: UsageProvenance,
): Extract<UsageQueryResult, { kind: 'logs' }> {
  const items = fitBoundedPageItems(
    allItems.slice(0, limit),
    offset < total,
    USAGE_PAGE_MAX_BYTES,
    (candidate) => {
      const nextOffset = offset + candidate.length;
      return logPageResult(
        source,
        candidate,
        total,
        offset,
        nextOffset < total ? nextOffset : null,
        provenance,
      );
    },
    'Canonical usage item',
  );
  const nextOffset = offset + items.length;
  return logPageResult(
    source,
    items,
    total,
    offset,
    nextOffset < total ? nextOffset : null,
    provenance,
  );
}

function fitBoundedPageItems<T>(
  candidates: readonly T[],
  itemRequired: boolean,
  maxBytes: number,
  createPage: (items: readonly T[]) => unknown,
  itemLabel: string,
): T[] {
  const items: T[] = [];
  for (const item of candidates) {
    const next = [...items, item];
    if (jsonBytes(createPage(next)) > maxBytes) break;
    items.push(item);
  }
  if (items.length === 0 && itemRequired) {
    throw new Error(`${itemLabel} exceeds the wire page limit`);
  }
  return items;
}

function logPageResult(
  source: 'llm' | 'tool',
  rows: readonly UsageLogProjection[],
  total: number,
  offset: number,
  nextOffset: number | null,
  provenance: UsageProvenance | undefined,
): Extract<UsageQueryResult, { kind: 'logs' }> {
  return {
    kind: 'logs',
    source,
    rows,
    offset,
    total,
    nextOffset,
    ...(provenance ? { provenance } : {}),
  } as Extract<UsageQueryResult, { kind: 'logs' }>;
}

function projectUsageBucket(bucket: UsageBucket): UsageBucket {
  return {
    ...bucket,
    key: projectIdentity(bucket.key),
    label: projectText(bucket.label),
  };
}

function projectUsageLog(row: UsageLogRow): LlmUsageLogProjection {
  const cacheMissInputSource = (row as UsageLogRow & { readonly cacheMissInputSource?: unknown })
    .cacheMissInputSource;
  return {
    source: 'llm',
    id: projectIdentity(row.id),
    ts: row.ts,
    ...(row.callKind === undefined ? {} : { callKind: row.callKind }),
    ...(row.callId === undefined ? {} : { callId: projectIdentity(row.callId) }),
    ...(row.connectionSlug === undefined
      ? {}
      : { connectionSlug: projectIdentity(row.connectionSlug) }),
    providerId: projectIdentity(row.providerId),
    modelId: projectIdentity(row.modelId),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheMissTokens: row.cacheMissTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    ...(cacheMissInputSource === 'explicit' || cacheMissInputSource === 'derived'
      ? { cacheMissInputSource }
      : {}),
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    ...(row.costUsd === undefined ? {} : { costUsd: row.costUsd }),
    ...(row.costBasis === undefined ? {} : { costBasis: row.costBasis }),
    latencyMs: row.latencyMs,
    status: row.status,
    ...(row.errorClass === undefined ? {} : { errorClass: projectText(row.errorClass) }),
    ...(row.sessionId === undefined ? {} : { sessionId: projectIdentity(row.sessionId) }),
    ...(row.turnId === undefined ? {} : { turnId: projectIdentity(row.turnId) }),
  };
}

function projectToolUsageLog(
  row: ToolInvocationRecord & {
    readonly id: string;
    readonly bytesIn: number;
    readonly bytesOut: number;
    readonly ts: number;
  },
): ToolUsageLogProjection {
  return {
    source: 'tool',
    id: projectIdentity(row.id),
    ts: row.ts,
    ...(row.toolCallId === undefined ? {} : { toolCallId: projectIdentity(row.toolCallId) }),
    toolName: projectIdentity(row.toolName),
    ...(row.providerId === undefined ? {} : { providerId: projectIdentity(row.providerId) }),
    ...(row.modelId === undefined ? {} : { modelId: projectIdentity(row.modelId) }),
    durationMs: row.durationMs,
    status: row.status,
    ...(row.errorClass === undefined ? {} : { errorClass: projectText(row.errorClass) }),
    ...(row.argsSummary === undefined ? {} : { argsSummary: projectText(row.argsSummary) }),
    ...(row.resultSummary === undefined
      ? {}
      : {
          resultSummary: {
            ...row.resultSummary,
            kind: projectText(row.resultSummary.kind),
            ...(row.resultSummary.status === undefined
              ? {}
              : { status: projectText(row.resultSummary.status) }),
          },
        }),
    bytesIn: row.bytesIn,
    bytesOut: row.bytesOut,
    startedAt: row.startedAt,
    ...(row.sessionId === undefined ? {} : { sessionId: projectIdentity(row.sessionId) }),
    ...(row.turnId === undefined ? {} : { turnId: projectIdentity(row.turnId) }),
  };
}

const IDENTITY_HASH_HEX_CHARS = 16;
const IDENTITY_HASH_SEPARATOR = '~';
const IDENTITY_HASH_SUFFIX_BYTES = IDENTITY_HASH_SEPARATOR.length + IDENTITY_HASH_HEX_CHARS;

function projectIdentity(value: string): string {
  const prefixMaxBytes = USAGE_PROJECTION_TEXT_MAX_BYTES - IDENTITY_HASH_SUFFIX_BYTES;
  let projected = '';
  let prefix = '';
  let bytes = 0;
  let prefixBytes = 0;
  let canonicalized = false;
  let prefixTruncated = false;
  let truncated = false;

  for (const codePoint of value) {
    const canonical = projectCodePoint(codePoint);
    if (canonical !== codePoint) canonicalized = true;
    const size = Buffer.byteLength(canonical, 'utf8');
    if (!truncated && bytes + size <= USAGE_PROJECTION_TEXT_MAX_BYTES) {
      projected += canonical;
      bytes += size;
    } else {
      truncated = true;
    }
    if (!prefixTruncated && prefixBytes + size <= prefixMaxBytes) {
      prefix += canonical;
      prefixBytes += size;
    } else {
      prefixTruncated = true;
    }
  }

  if (!truncated && !canonicalized) return projected || '\ufffd';
  const hashSuffix =
    IDENTITY_HASH_SEPARATOR +
    createHash('sha256').update(value, 'utf16le').digest('hex').slice(0, IDENTITY_HASH_HEX_CHARS);
  return prefix + hashSuffix;
}

function projectText(value: string): string {
  let projected = '';
  let bytes = 0;
  for (const codePoint of value) {
    const canonical = projectCodePoint(codePoint);
    const size = Buffer.byteLength(canonical, 'utf8');
    if (bytes + size > USAGE_PROJECTION_TEXT_MAX_BYTES) break;
    projected += canonical;
    bytes += size;
  }
  return projected || '\ufffd';
}

function projectCodePoint(codePoint: string): string {
  const scalar = codePoint.codePointAt(0);
  return scalar !== undefined && (scalar <= 0x1f || (scalar >= 0x7f && scalar <= 0x9f))
    ? '\ufffd'
    : codePoint;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
