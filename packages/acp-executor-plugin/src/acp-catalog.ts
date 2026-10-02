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

import type { ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import type { AdmissionLimiter } from '@maka/runtime/admission-limiter';

const CATALOG_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Instance-scoped candidates. Only a retained task Session owns workspace configuration. */
export class AcpCatalog {
  #cached?: { entry: ExecutorCatalogEntry; expires: number };
  #pending?: { controller: AbortController; promise: Promise<ExecutorCatalogEntry> };
  #tail?: Promise<ExecutorCatalogEntry>;
  readonly #operations = new Set<Promise<ExecutorCatalogEntry>>();
  #revision = 0;
  #disposed = false;

  constructor(
    private readonly admission: AdmissionLimiter,
    private readonly probe: (signal: AbortSignal) => Promise<ExecutorCatalogEntry>,
    private readonly unavailable: () => ExecutorCatalogEntry,
  ) {}

  async get(signal: AbortSignal, refresh = false): Promise<ExecutorCatalogEntry> {
    signal.throwIfAborted();
    if (this.#disposed) return this.unavailable();
    if (refresh) this.invalidate();
    if (this.#cached && this.#cached.expires > Date.now()) return this.#cached.entry;
    if (!this.#pending) {
      const revision = this.#revision;
      const controller = new AbortController();
      const startup = AbortSignal.any([controller.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
      const previous = this.#tail;
      const run = async () => {
        try {
          // A refresh must drain the superseded process before starting its replacement.
          await previous;
          startup.throwIfAborted();
          const permit = await this.admission.acquire(startup);
          let entry: ExecutorCatalogEntry;
          try {
            startup.throwIfAborted();
            // probe settles only after its process and temporary directory have been disposed.
            entry = await this.probe(startup);
          } finally {
            permit.release();
          }
          if (startup.aborted || revision !== this.#revision || this.#disposed)
            return this.unavailable();
          if (entry.readiness === 'ready')
            this.#cached = { entry, expires: Date.now() + CATALOG_TTL_MS };
          return entry;
        } catch {
          return this.unavailable();
        }
      };
      const promise = run().finally(() => {
        this.#operations.delete(promise);
        if (this.#pending?.promise === promise) this.#pending = undefined;
        if (this.#tail === promise) this.#tail = undefined;
      });
      this.#pending = { controller, promise };
      this.#tail = promise;
      this.#operations.add(promise);
    }
    let pending = this.#pending.promise;
    while (true) {
      const result = await waitForSignal(pending, signal);
      if (result.readiness !== 'unavailable' || this.#disposed) return result;
      if (this.#cached && this.#cached.expires > Date.now()) return this.#cached.entry;
      const replacement = this.#pending?.promise;
      if (!replacement || replacement === pending) return result;
      pending = replacement;
    }
  }

  invalidate(): void {
    this.#revision++;
    this.#cached = undefined;
    this.#pending?.controller.abort(new Error('ACP catalog invalidated'));
    this.#pending = undefined;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.invalidate();
    await Promise.allSettled(this.#operations);
  }
}

/** A caller can stop waiting without cancelling a probe shared by other drafts. */
async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
