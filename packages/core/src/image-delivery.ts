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

/** Client-safe delivery contract. No filesystem or networking capabilities live here. */
export const IMAGE_DELIVERY_FAILURES = [
  'not_found',
  'not_allowed',
  'too_large',
  'unsupported_mime',
  'quota_exceeded',
  'download_failed',
  'read_failed',
  'queue_full',
] as const;
export type ImageDeliveryFailure = (typeof IMAGE_DELIVERY_FAILURES)[number];
export interface ImageDeliveryRequest {
  readonly turnId: string;
  readonly messageId: string;
  readonly source: string;
  readonly retry?: boolean;
}
export type ImageDeliveryResult =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly artifactId: string }
  | { readonly status: 'failed'; readonly reason: ImageDeliveryFailure }
  | { readonly status: 'unavailable' };
/** Stored with its Artifact, so session copy/export carries both provenance and bytes. */
export interface ImageDeliveryMetadata {
  readonly messageId: string;
  readonly source: string;
  readonly status: 'pending' | 'ready' | 'failed';
  readonly reason?: ImageDeliveryFailure;
  readonly contentSha256?: string;
}
export interface ImageArchiveLimits {
  readonly sessionBytes: number;
  readonly workspaceBytes: number;
}
export const DEFAULT_IMAGE_ARCHIVE_LIMITS: ImageArchiveLimits = Object.freeze({
  sessionBytes: 100 * 1024 * 1024,
  workspaceBytes: 1024 * 1024 * 1024,
});
export function isImageDeliveryMetadata(value: unknown): value is ImageDeliveryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).every((k) =>
      ['messageId', 'source', 'status', 'reason', 'contentSha256'].includes(k),
    ) &&
    typeof v.messageId === 'string' &&
    v.messageId.length > 0 &&
    v.messageId.length <= 512 &&
    typeof v.source === 'string' &&
    v.source.length > 0 &&
    v.source.length <= 4096 &&
    ['pending', 'ready', 'failed'].includes(String(v.status)) &&
    (v.reason === undefined ||
      IMAGE_DELIVERY_FAILURES.includes(v.reason as ImageDeliveryFailure)) &&
    (v.contentSha256 === undefined ||
      (typeof v.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(v.contentSha256))) &&
    (v.status === 'failed' ? v.reason !== undefined : v.reason === undefined) &&
    (v.status === 'ready' ? v.contentSha256 !== undefined : v.contentSha256 === undefined) &&
    !/[\x00-\x1f\x7f]/.test(v.source as string)
  );
}
