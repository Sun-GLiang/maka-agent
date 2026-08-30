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

export function selectTranscriptBuffer(
  bytes: Buffer,
  direction: 'older' | 'newer',
  byteOffset: number | null,
  budget: number,
  invalidOffset: () => Error = () => new RangeError('Invalid transcript byte offset'),
): {
  byteOffset: number;
  data: Buffer;
  complete: boolean;
  nextOffset: number;
} | null {
  if (budget < 1) return null;
  if (direction === 'older') {
    const end = byteOffset ?? bytes.byteLength;
    if (end < 1 || end > bytes.byteLength) throw invalidOffset();
    const start = Math.max(0, end - budget);
    return {
      byteOffset: start,
      data: bytes.subarray(start, end),
      complete: start === 0,
      nextOffset: start,
    };
  }
  const start = byteOffset ?? 0;
  if (start < 0 || start >= bytes.byteLength) throw invalidOffset();
  const end = Math.min(bytes.byteLength, start + budget);
  return {
    byteOffset: start,
    data: bytes.subarray(start, end),
    complete: end === bytes.byteLength,
    nextOffset: end,
  };
}
