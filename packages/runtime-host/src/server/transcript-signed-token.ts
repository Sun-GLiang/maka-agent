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

import { createHmac, timingSafeEqual } from 'node:crypto';

export type TranscriptSignedTokenDomain = 'legacy-page' | 'snapshot' | 'positions' | 'window';

export class TranscriptSignedTokenError extends Error {
  readonly name = 'TranscriptSignedTokenError';
}

export function encodeTranscriptSignedToken(
  domain: TranscriptSignedTokenDomain,
  value: unknown,
  secret: Buffer,
): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${payload}.${sign(domain, payload, secret).toString('base64url')}`;
}

export function decodeTranscriptSignedToken(
  domain: TranscriptSignedTokenDomain,
  value: string,
  secret: Buffer,
): unknown {
  try {
    const parts = value.split('.');
    if (parts.length !== 2) throw new Error('invalid token envelope');
    const [payload, signatureValue] = parts as [string, string];
    const bytes = Buffer.from(payload, 'base64url');
    const signature = Buffer.from(signatureValue, 'base64url');
    const expected = sign(domain, payload, secret);
    if (
      bytes.toString('base64url') !== payload ||
      signature.toString('base64url') !== signatureValue ||
      signature.byteLength !== expected.byteLength ||
      !timingSafeEqual(signature, expected)
    ) {
      throw new Error('invalid token signature');
    }
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new TranscriptSignedTokenError('Invalid transcript token', { cause });
  }
}

function sign(domain: TranscriptSignedTokenDomain, payload: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret)
    .update(`maka:session-transcript:${domain}:v1\0`, 'utf8')
    .update(payload, 'utf8')
    .digest();
}
