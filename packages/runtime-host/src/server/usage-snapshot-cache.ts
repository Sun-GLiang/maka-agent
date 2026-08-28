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

import { randomUUID } from 'node:crypto';
import type { UsageSummaryV2 } from '@maka/core/usage-stats/types';
import type { UsageProvenance } from '@maka/core/usage-ledger-merge';
import type {
  EffectivePricingEntry,
  LlmUsageLogProjection,
  ToolUsageLogProjection,
} from '../protocol/index.js';

export const USAGE_SNAPSHOT_TTL_MS = 5 * 60 * 1_000;
export const USAGE_SNAPSHOT_CAPACITY = 4;
export const USAGE_SNAPSHOT_ACTIVITY_LIMIT = 50_000;

export interface UsageSnapshotCacheOptions {
  readonly now?: () => number;
  readonly createRevision?: () => string;
  readonly ttlMs?: number;
  readonly capacity?: number;
  readonly activityLimit?: number;
}

export interface UsageSnapshotContents {
  readonly summary: UsageSummaryV2;
  readonly provenance: UsageProvenance;
  readonly llmRows: readonly LlmUsageLogProjection[];
  readonly llmTruncated: boolean;
  readonly toolRows: readonly ToolUsageLogProjection[];
  readonly toolTruncated: boolean;
  readonly pricingEntries: readonly EffectivePricingEntry[];
}

export interface RetainedUsageSnapshot extends UsageSnapshotContents {
  readonly revision: string;
}

interface CacheEntry extends RetainedUsageSnapshot {
  readonly expiresAt: number;
}

/** Host-epoch-local, absolute-TTL cache for coherent Settings Usage reads. */
export class UsageSnapshotCache {
  readonly activityLimit: number;
  readonly #now: () => number;
  readonly #createRevision: () => string;
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: UsageSnapshotCacheOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createRevision = options.createRevision ?? randomUUID;
    this.#ttlMs = options.ttlMs ?? USAGE_SNAPSHOT_TTL_MS;
    this.#capacity = options.capacity ?? USAGE_SNAPSHOT_CAPACITY;
    this.activityLimit = options.activityLimit ?? USAGE_SNAPSHOT_ACTIVITY_LIMIT;
    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs <= 0 ||
      !Number.isSafeInteger(this.#capacity) ||
      this.#capacity <= 0 ||
      !Number.isSafeInteger(this.activityLimit) ||
      this.activityLimit <= 0
    ) {
      throw new TypeError('Invalid Usage snapshot cache limits');
    }
  }

  retain(contents: UsageSnapshotContents): RetainedUsageSnapshot {
    const now = this.#now();
    this.#pruneExpired(now);
    while (this.#entries.size >= this.#capacity) {
      const oldestRevision = this.#entries.keys().next().value;
      if (oldestRevision === undefined) break;
      this.#entries.delete(oldestRevision);
    }
    const revision = this.#createRevision();
    if (revision.length === 0 || revision.length > 128 || this.#entries.has(revision)) {
      throw new Error('Usage snapshot revision generator returned an invalid revision');
    }
    const entry: CacheEntry = {
      revision,
      ...contents,
      expiresAt: now + this.#ttlMs,
    };
    this.#entries.set(revision, entry);
    return entry;
  }

  get(revision: string): RetainedUsageSnapshot | undefined {
    const now = this.#now();
    this.#pruneExpired(now);
    const entry = this.#entries.get(revision);
    if (!entry) return undefined;
    // Map insertion order is the LRU order. Reinsert without changing expiresAt:
    // page access affects eviction priority, never the absolute lifetime.
    this.#entries.delete(revision);
    this.#entries.set(revision, entry);
    return entry;
  }

  #pruneExpired(now: number): void {
    for (const [revision, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(revision);
    }
  }
}
