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
import {
  ImageFileError,
  imageFileFailureReason,
  validateImageBytes,
} from '@maka/runtime/image-file';
import {
  isImageDeliverySource,
  isRemoteImageSource,
  type ImageDeliveryFailure,
} from '@maka/core/image-delivery';
import { abortable } from '../client/wait-for-ready.js';
import { usesFetchProxy } from '@maka/runtime/network/scoped-fetch-transport';
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
    throw new ImageSourceError(imageFileFailureReason(error));
  }
}
export function localImagePath(source: string): string | undefined {
  if (isRemoteImageSource(source)) return undefined;
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

/** A missing literal path may be a URL-encoded Markdown destination. File URLs
 * already went through fileURLToPath; never decode them a second time. */
export function decodedLocalImagePath(source: string): string | undefined {
  if (source.startsWith('file:') || isRemoteImageSource(source)) return undefined;
  try {
    const decoded = decodeURIComponent(source);
    return decoded !== source && isImageDeliverySource(decoded) ? decoded : undefined;
  } catch {
    // A literal percent sign or incomplete escape is a valid filesystem name.
    return undefined;
  }
}
/** Pin direct DNS and check each redirect; never send cookies, auth or referer.
 * A configured proxy resolves the original hostname and is trusted to enforce
 * its own egress boundary; local DNS checks cannot pin the proxy's destination. */
export async function downloadChatImage(
  source: string,
  signal: AbortSignal,
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): Promise<ChatImageBytes> {
  let url = new URL(source);
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new ImageSourceError('not_allowed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Fake DNS addresses are routing handles for a named destination, never
    // authority to load a literal private address or a local/metadata hostname.
    // This compatibility exception assumes trusted VPN/TUN routing: a fake-IP
    // answer alone does not prove that the eventual destination is public.
    const namedHost = !isIP(host) && publicHostname(host);
    if (!isIP(host) && !namedHost) throw new ImageSourceError('not_allowed');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await abortable(() => lookup(host, { all: true }), signal);
    if (
      !addresses.length ||
      addresses.some((a) => !publicAddress(a.address) && !(namedHost && fakeAddress(a.address)))
    )
      throw new ImageSourceError('not_allowed');
    const target = addresses[0]!;
    const headers = { accept: 'image/png,image/jpeg,image/webp,image/gif' };
    const proxyFetch =
      options.fetch && usesFetchProxy(options.fetch, url) ? options.fetch : undefined;
    const response = proxyFetch
      ? proxyImageResponse(
          await proxyFetch(url, { signal, headers, redirect: 'manual', credentials: 'omit' }),
        )
      : directImageResponse(
          await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
            const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
              url,
              {
                signal,
                headers,
                lookup: (_host, options, callback) =>
                  options.all
                    ? callback(null, [target])
                    : callback(null, target.address, target.family),
              },
              resolve,
            );
            req.on('error', reject);
            req.end();
          }),
        );
    const location = response.header('location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.close();
      const next = new URL(location, url);
      if (url.protocol === 'https:' && next.protocol !== 'https:')
        throw new ImageSourceError('not_allowed');
      url = next;
      continue;
    }
    if (response.status !== 200) {
      await response.close();
      throw new ImageSourceError('download_failed');
    }
    const length = Number(response.header('content-length'));
    if (length > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) {
      await response.close();
      throw new ImageSourceError('too_large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.chunks) {
      size += chunk.length;
      if (size > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) {
        await response.close();
        throw new ImageSourceError('too_large');
      }
      chunks.push(Buffer.from(chunk));
    }
    return checkedChatImage(Buffer.concat(chunks, size));
  }
  throw new ImageSourceError('download_failed');
}
interface ImageResponse {
  readonly status: number;
  readonly chunks: AsyncIterable<Uint8Array>;
  header(name: string): string | undefined;
  close(): void | Promise<void>;
}
function directImageResponse(response: import('node:http').IncomingMessage): ImageResponse {
  return {
    status: response.statusCode ?? 0,
    chunks: response,
    header: (name) => {
      const value = response.headers[name];
      return typeof value === 'string' ? value : undefined;
    },
    close: () => {
      response.destroy();
    },
  };
}
function proxyImageResponse(response: Response): ImageResponse {
  return {
    status: response.status,
    header: (name) => response.headers.get(name) ?? undefined,
    close: async () => {
      await response.body?.cancel().catch(() => {});
    },
    chunks: (async function* () {
      const reader = response.body?.getReader();
      if (!reader) return;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          yield chunk.value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    })(),
  };
}
function publicHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return (
    name.includes('.') &&
    !/(^|\.)(localhost|local|lan|internal|home|arpa|test|invalid)$/.test(name) &&
    ![
      'metadata.google.internal',
      'metadata.goog',
      'metadata.tencentyun.com',
      'instance-data.ec2.internal',
    ].includes(name)
  );
}
function fakeAddress(address: string): boolean {
  if (isIP(address) === 4) return /^198\.(18|19)\./.test(address);
  if (isIP(address) !== 6) return false;
  // RFC 5180's benchmarking prefix is also used by VPN fake DNS for IPv6.
  const normalized = new URL(`http://[${address}]`).hostname;
  return /^\[2001:2:(?::|0:)/i.test(normalized);
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
  return /^[23][0-9a-f]{3}:/i.test(address) && !fakeAddress(address);
}
