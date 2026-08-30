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

export class TranscriptFragmentAssemblyError extends Error {
  readonly name = 'TranscriptFragmentAssemblyError';
}

/** The single bounded integrity path for transcript message and semantic-window fragments. */
export class TranscriptFragmentAssembler {
  readonly #data: Buffer;
  #edge: number;
  #released = false;

  constructor(
    readonly direction: 'older' | 'newer',
    readonly totalBytes: number,
    readonly payloadDigest: `sha256:${string}` | null,
    maxBytes = Number.MAX_SAFE_INTEGER,
    private readonly accountAssemblyBytes: (deltaBytes: number) => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > maxBytes) {
      throw new RangeError('Session transcript payload exceeds the local byte limit');
    }
    accountAssemblyBytes(totalBytes);
    try {
      this.#data = Buffer.allocUnsafe(totalBytes);
      this.#edge = direction === 'older' ? totalBytes : 0;
    } catch (error) {
      accountAssemblyBytes(-totalBytes);
      throw error;
    }
  }

  get continuationBytes(): number | null {
    if (this.complete) return null;
    return this.direction === 'older' ? this.#edge : this.totalBytes - this.#edge;
  }

  get complete(): boolean {
    return this.direction === 'older' ? this.#edge === 0 : this.#edge === this.totalBytes;
  }

  accept(byteOffset: number, bytes: Buffer): void {
    if (this.#released)
      throw new TranscriptFragmentAssemblyError('Transcript assembly is released');
    const expectedOffset = this.direction === 'older' ? this.#edge - bytes.byteLength : this.#edge;
    if (
      bytes.byteLength < 1 ||
      byteOffset !== expectedOffset ||
      byteOffset < 0 ||
      byteOffset + bytes.byteLength > this.totalBytes
    ) {
      throw new TranscriptFragmentAssemblyError('Session transcript payload has a fragment gap');
    }
    bytes.copy(this.#data, byteOffset);
    this.#edge = this.direction === 'older' ? byteOffset : byteOffset + bytes.byteLength;
  }

  finish(): Buffer {
    if (!this.complete || this.#released) {
      throw new TranscriptFragmentAssemblyError(
        'Session transcript payload ended before every fragment arrived',
      );
    }
    if (
      this.payloadDigest !== null &&
      `sha256:${createHash('sha256').update(this.#data).digest('hex')}` !== this.payloadDigest
    ) {
      throw new TranscriptFragmentAssemblyError('Session transcript payload digest mismatch');
    }
    return this.#data;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#data.fill(0);
    this.accountAssemblyBytes(-this.totalBytes);
  }
}
