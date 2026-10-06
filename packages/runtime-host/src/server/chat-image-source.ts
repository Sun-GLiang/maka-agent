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

import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_IMAGE_PREVIEW_MAX_BYTES } from '@maka/core/artifacts';
import { ImageFileError, validateImageBytes } from '@maka/runtime/image-file';
import type { ImageDeliveryFailure } from '@maka/core/image-delivery';
export class ImageSourceError extends Error {
  constructor(readonly reason: ImageDeliveryFailure) {
    super(reason);
  }
}
export interface ChatImageBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}
export function checkedChatImage(bytes: Uint8Array): ChatImageBytes {
  try {
    return validateImageBytes(bytes, 'chat');
  } catch (error) {
    if (!(error instanceof ImageFileError)) throw error;
    throw new ImageSourceError(
      error.code === 'ERR_IMAGE_TOO_LARGE' ? 'too_large' : 'unsupported_mime',
    );
  }
}
export function localImagePath(source: string): string | undefined {
  if (/^https?:/i.test(source)) return undefined;
  if (source.startsWith('file:')) {
    try {
      return fileURLToPath(source);
    } catch {
      throw new ImageSourceError('not_allowed');
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source))
    throw new ImageSourceError('not_allowed');
  return source;
}
/** Pin DNS at connection time and check each redirect; never send cookies, auth or referer. */
export async function downloadChatImage(
  source: string,
  signal: AbortSignal,
): Promise<ChatImageBytes> {
  let url = new URL(source);
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new ImageSourceError('not_allowed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Literal loopback supports images served by this execution Host. Other private
    // networks and DNS names resolving to them are never automatically fetched.
    const literalLoopback = host === '127.0.0.1' || host === '::1';
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await abortableLookup(host, signal);
    if (!addresses.length || (!literalLoopback && addresses.some((a) => !publicAddress(a.address))))
      throw new ImageSourceError('not_allowed');
    const target = addresses[0]!;
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          signal,
          headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
          lookup: (_host, options, callback) =>
            options.all ? callback(null, [target]) : callback(null, target.address, target.family),
        },
        resolve,
      );
      req.on('error', reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      response.destroy();
      const next = new URL(response.headers.location, url);
      if (url.protocol === 'https:' && next.protocol !== 'https:')
        throw new ImageSourceError('not_allowed');
      url = next;
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new ImageSourceError('download_failed');
    }
    const length = Number(response.headers['content-length']);
    if (length > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) {
      response.destroy();
      throw new ImageSourceError('too_large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) {
        response.destroy();
        throw new ImageSourceError('too_large');
      }
      chunks.push(Buffer.from(chunk));
    }
    return checkedChatImage(Buffer.concat(chunks, size));
  }
  throw new ImageSourceError('download_failed');
}
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a > 0 &&
      a !== 10 &&
      a !== 127 &&
      a < 224 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && b === 168) &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19))
    );
  }
  // Only global-unicast IPv6 is eligible. Mapped IPv4/ULA/link-local are excluded.
  return /^[23][0-9a-f]{3}:/i.test(address);
}

function abortableLookup(host: string, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<import('node:dns').LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void lookup(host, { all: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
