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
import type { DatabaseSync } from 'node:sqlite';
import { SQLITE_SESSION_MESSAGE_CHUNK_BYTES } from './sqlite-session-metadata-schema.js';

export class StoredSessionMessageIncompatibleError extends Error {
  readonly name = 'StoredSessionMessageIncompatibleError';
  readonly code = 'stored_session_message_incompatible';

  constructor(
    readonly sessionId: string,
    readonly sequence: number,
    options?: ErrorOptions,
  ) {
    super(`Stored Session message ${sequence} for ${sessionId} is incompatible`, options);
  }
}

export interface TranscriptRecordSlice {
  readonly sequence: number;
  readonly byteOffset: number;
  readonly totalBytes: number;
  readonly byteLength: number;
  readonly chunked: boolean;
  readonly payloadDigest: `sha256:${string}` | null;
}

export function planForwardTranscriptSlice(
  totalBytes: number,
  byteOffset: number,
  availableBytes: number,
  alignmentBytes = 1,
): number {
  const remainingBytes = totalBytes - byteOffset;
  if (remainingBytes <= availableBytes) return remainingBytes;
  return Math.floor(availableBytes / alignmentBytes) * alignmentBytes;
}

/**
 * The single physical byte-slice primitive shared by the public transcript
 * pager and the package-private scalar identity recovery scanner.
 */
export function readTranscriptSlices(
  db: DatabaseSync,
  sessionId: string,
  slices: readonly TranscriptRecordSlice[],
): Map<number, Buffer> {
  if (slices.length === 0) return new Map();
  const chunkedSlices = slices.filter((slice) => slice.chunked);
  const values = chunkedSlices.map(() => '(?, ?, ?)').join(', ');
  const parameters = chunkedSlices.flatMap((slice) => [
    slice.sequence,
    Math.floor(slice.byteOffset / SQLITE_SESSION_MESSAGE_CHUNK_BYTES),
    Math.floor((slice.byteOffset + slice.byteLength - 1) / SQLITE_SESSION_MESSAGE_CHUNK_BYTES),
  ]);
  const rows =
    chunkedSlices.length === 0
      ? []
      : (db
          .prepare(
            `
        WITH requested(sequence, first_chunk, last_chunk) AS (VALUES ${values})
        SELECT requested.sequence, chunk.chunk_index, chunk.data, chunk.sha256
        FROM requested
        INNER JOIN session_message_chunks AS chunk
          ON chunk.session_id = ?
          AND chunk.sequence = requested.sequence
          AND chunk.chunk_index BETWEEN requested.first_chunk AND requested.last_chunk
        ORDER BY requested.sequence, chunk.chunk_index
      `,
          )
          .all(...parameters, sessionId) as Array<{
          sequence?: unknown;
          chunk_index?: unknown;
          data?: unknown;
          sha256?: unknown;
        }>);
  const rowsBySequence = new Map<number, typeof rows>();
  for (const row of rows) {
    const sequence = requireStoredMessageSequence(row.sequence, sessionId);
    const grouped = rowsBySequence.get(sequence);
    if (grouped) grouped.push(row);
    else rowsBySequence.set(sequence, [row]);
  }
  const result = new Map<number, Buffer>();
  for (const slice of slices) {
    if (!slice.chunked) continue;
    const selected = rowsBySequence.get(slice.sequence) ?? [];
    const firstChunk = Math.floor(slice.byteOffset / SQLITE_SESSION_MESSAGE_CHUNK_BYTES);
    const lastChunk = Math.floor(
      (slice.byteOffset + slice.byteLength - 1) / SQLITE_SESSION_MESSAGE_CHUNK_BYTES,
    );
    if (selected.length !== lastChunk - firstChunk + 1) {
      throw new StoredSessionMessageIncompatibleError(sessionId, slice.sequence);
    }
    const chunks: Buffer[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const row = selected[index]!;
      if (
        row.chunk_index !== firstChunk + index ||
        !(row.data instanceof Uint8Array) ||
        typeof row.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(row.sha256)
      ) {
        throw new StoredSessionMessageIncompatibleError(sessionId, slice.sequence);
      }
      const chunk = Buffer.from(row.data);
      const expectedLength =
        row.chunk_index === Math.ceil(slice.totalBytes / SQLITE_SESSION_MESSAGE_CHUNK_BYTES) - 1
          ? slice.totalBytes - row.chunk_index * SQLITE_SESSION_MESSAGE_CHUNK_BYTES
          : SQLITE_SESSION_MESSAGE_CHUNK_BYTES;
      if (
        chunk.byteLength !== expectedLength ||
        createHash('sha256').update(chunk).digest('hex') !== row.sha256
      ) {
        throw new StoredSessionMessageIncompatibleError(sessionId, slice.sequence);
      }
      chunks.push(chunk);
    }
    const joined = Buffer.concat(chunks);
    const start = slice.byteOffset - firstChunk * SQLITE_SESSION_MESSAGE_CHUNK_BYTES;
    const data = joined.subarray(start, start + slice.byteLength);
    if (data.byteLength !== slice.byteLength) {
      throw new StoredSessionMessageIncompatibleError(sessionId, slice.sequence);
    }
    result.set(slice.sequence, data);
  }
  const inlineSlices = slices.filter((slice) => !slice.chunked);
  if (inlineSlices.length > 0) {
    const inlineValues = inlineSlices.map(() => '(?, ?, ?)').join(', ');
    const inlineParameters = inlineSlices.flatMap((slice) => [
      slice.sequence,
      slice.byteOffset + 1,
      slice.byteLength,
    ]);
    const inlineRows = db
      .prepare(
        `
          WITH requested(sequence, byte_start, byte_length) AS (VALUES ${inlineValues})
          SELECT requested.sequence,
            substr(CAST(message.record_json AS BLOB), requested.byte_start, requested.byte_length)
              AS data
          FROM requested
          INNER JOIN session_messages AS message
            ON message.session_id = ? AND message.sequence = requested.sequence
        `,
      )
      .all(...inlineParameters, sessionId) as Array<{
      sequence?: unknown;
      data?: unknown;
    }>;
    for (const row of inlineRows) {
      const sequence = requireStoredMessageSequence(row.sequence, sessionId);
      if (!(row.data instanceof Uint8Array)) {
        throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
      }
      result.set(sequence, Buffer.from(row.data));
    }
  }
  return result;
}

export function requireStoredMessageSequence(value: unknown, sessionId: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StoredSessionMessageIncompatibleError(sessionId, -1);
  }
  return value as number;
}
