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
import { ImageFileReadError } from '@maka/runtime/image-file-reader';
import type { CompleteEvent, TextCompleteEvent, TextDeltaEvent } from '@maka/core/events';
import { foldAssistantDelta } from '@maka/core/events';
import {
  IMAGE_MARKDOWN_MAX_LENGTH,
  type ImageArchiveLimits,
  type ImageDeliveryRequest,
  type ImageDeliveryResult,
  type ImageDeliveryFailure,
} from '@maka/core/image-delivery';
import {
  ImageArchiveQuotaError,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import type { SessionAdmissionGate } from './session-admission-gate.js';
import { chatImageSources } from './chat-image-markdown.js';
import { readyChatImageArtifact } from './chat-image-artifact.js';
import { abortable } from '../client/wait-for-ready.js';
import {
  downloadChatImage,
  ImageSourceError,
  localImagePath,
  type ChatImageBytes,
} from './chat-image-source.js';

interface DeliveryIdentity extends ImageDeliveryRequest {
  readonly sessionId: string;
}
interface DeliveryJob {
  readonly identity: DeliveryIdentity;
  readonly done: Promise<void>;
  run(): Promise<void>;
  cancel(): void;
}
export interface ChatImageDeliveryPorts {
  readonly artifacts: Pick<
    InteractiveArtifactStoreWriter,
    'create' | 'findImageDelivery' | 'deleteOwnedArtifactInSession'
  >;
  readonly admission: SessionAdmissionGate;
  isPresent(sessionId: string): Promise<boolean>;
  readMessage(identity: DeliveryIdentity): Promise<string | undefined>;
  readLocalImage(sessionId: string, path: string, signal: AbortSignal): Promise<ChatImageBytes>;
  acquireResidency(): { release(): void };
  persistenceFailed(error: unknown): void;
  readonly limits?: ImageArchiveLimits;
  readonly download?: typeof downloadChatImage;
}
/** Host owns capture and persistence; clients can only resolve sources already in an assistant message. */
export class ChatImageDeliveryService {
  readonly #jobs = new Map<string, DeliveryJob>();
  readonly #queue: DeliveryJob[] = [];
  readonly #streams = new Map<
    string,
    { turnId: string; text: string; seen: Set<string>; timer?: ReturnType<typeof setTimeout> }
  >();
  readonly #abort = new AbortController();
  #running = 0;
  #closed = false;
  constructor(private readonly ports: ChatImageDeliveryPorts) {}

  observe(sessionId: string, event: TextDeltaEvent | TextCompleteEvent | CompleteEvent): void {
    if (this.#closed) return;
    if (event.type === 'complete') {
      for (const [key, stream] of this.#streams) {
        if (key.startsWith(`${sessionId}\0`) && stream.turnId === event.turnId) {
          clearTimeout(stream.timer);
          this.#streams.delete(key);
        }
      }
      return;
    }
    const key = `${sessionId}\0${event.messageId}`;
    let stream = this.#streams.get(key);
    if (!stream) {
      if (this.#streams.size >= 32) return;
      stream = { turnId: event.turnId, text: '', seen: new Set() };
      this.#streams.set(key, stream);
    }
    if (event.type === 'text_complete') stream.text = event.text;
    else {
      const folded = foldAssistantDelta(stream.text.length, event);
      if (!folded) return;
      stream.text += folded.tail;
    }
    if (stream.text.length > IMAGE_MARKDOWN_MAX_LENGTH) {
      clearTimeout(stream.timer);
      this.#streams.delete(key);
      return;
    }
    const capture = () => {
      stream!.timer = undefined;
      for (const source of chatImageSources(stream!.text)) {
        if (stream!.seen.has(source)) continue;
        stream!.seen.add(source);
        this.#enqueue({ sessionId, turnId: event.turnId, messageId: event.messageId, source });
      }
    };
    if (event.type === 'text_complete') {
      clearTimeout(stream.timer);
      capture();
      this.#streams.delete(key);
    } else if (!stream.timer)
      stream.timer = setTimeout(() => {
        try {
          capture();
        } catch (error) {
          if (!this.#closed) this.ports.persistenceFailed(error);
        }
      }, 250);
  }

  async resolve(identity: DeliveryIdentity): Promise<ImageDeliveryResult> {
    if (this.#closed) return { status: 'unavailable' };
    const record = await this.ports.artifacts.findImageDelivery(
      identity.sessionId,
      identity.turnId,
      identity.messageId,
      identity.source,
    );
    const metadata = record?.imageDelivery;
    if (metadata?.status === 'ready' && !identity.retry)
      return { status: 'ready', artifactId: record!.id };
    if (metadata?.status === 'failed' && !identity.retry)
      return { status: 'failed', reason: metadata.reason! };
    if (this.#jobs.has(deliveryKey(identity))) return { status: 'pending' };
    // A client-provided path is never a read grant. Legacy/restarted deliveries
    // must be found in canonical assistant text before any source is opened.
    if (!metadata) {
      const text = await this.ports.readMessage(identity);
      if (text === undefined || !chatImageSources(text).includes(identity.source))
        return { status: 'unavailable' };
    }
    if (metadata?.status === 'failed' || metadata?.status === 'ready') {
      return this.ports.admission.runOrJoin(identity.sessionId, async () => {
        if (this.#closed) return { status: 'unavailable' };
        if (this.#jobs.has(deliveryKey(identity))) return { status: 'pending' };
        if (this.#jobs.size >= 128) return { status: 'failed', reason: 'queue_full' };
        await this.ports.artifacts.deleteOwnedArtifactInSession(
          identity.sessionId,
          record!.id,
          'tool_result_projection',
        );
        // Capture outlives this admission and takes its own write admissions.
        return this.ports.admission.detach(() => this.#enqueue(identity))
          ? { status: 'pending' }
          : { status: 'failed', reason: 'queue_full' };
      });
    }
    return this.#enqueue(identity)
      ? { status: 'pending' }
      : { status: 'failed', reason: 'queue_full' };
  }

  #enqueue(identity: DeliveryIdentity): boolean {
    const key = deliveryKey(identity);
    if (this.#jobs.has(key)) return true;
    if (this.#closed || this.#jobs.size >= 128) return false;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const residency = this.ports.acquireResidency();
    const finish = () => {
      this.#jobs.delete(key);
      residency.release();
      settle();
    };
    const job: DeliveryJob = {
      identity,
      done,
      cancel: finish,
      run: async () => {
        try {
          await this.#capture(identity);
        } catch (error) {
          if (!this.#abort.signal.aborted) this.ports.persistenceFailed(error);
        } finally {
          finish();
        }
      },
    };
    this.#jobs.set(key, job);
    this.#queue.push(job);
    this.#pump();
    return true;
  }
  #pump(): void {
    while (!this.#closed && this.#running < 2 && this.#queue.length) {
      const job = this.#queue.shift()!;
      this.#running++;
      void job.run().finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }
  async #capture(identity: DeliveryIdentity): Promise<void> {
    const { sessionId, turnId, messageId, source } = identity;
    const existing = await this.ports.artifacts.findImageDelivery(
      sessionId,
      turnId,
      messageId,
      source,
    );
    if (existing?.imageDelivery?.status !== 'pending' && existing) return;
    const metadata = { messageId, source };
    const pendingId = existing?.id ?? `chat_image_request_${deliveryKey(identity)}`;
    const base = {
      sessionId,
      turnId,
      name: 'chat-image',
      source: 'tool_result_projection' as const,
    };
    const publish = async (input: Parameters<InteractiveArtifactStoreWriter['create']>[0]) =>
      this.ports.admission.runOrJoin(sessionId, async () => {
        if (this.#abort.signal.aborted || !(await this.ports.isPresent(sessionId))) return;
        await this.ports.artifacts.create(input);
        // Retain a pending request only until a terminal record is durable.
        // A crash between these writes still replays the terminal record.
        if (input.imageDelivery?.status !== 'pending')
          await this.ports.artifacts.deleteOwnedArtifactInSession(
            sessionId,
            pendingId,
            'tool_result_projection',
          );
      });
    await publish({
      ...base,
      id: pendingId,
      kind: 'file',
      content: '',
      imageDelivery: { ...metadata, status: 'pending' },
    });
    if (this.#abort.signal.aborted || !(await this.ports.isPresent(sessionId))) return;
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(10_000)]);
    let image: ChatImageBytes;
    try {
      const path = localImagePath(source);
      if (path !== undefined)
        image = await abortable(() => this.ports.readLocalImage(sessionId, path, signal), signal);
      else {
        try {
          image = await (this.ports.download ?? downloadChatImage)(source, signal);
        } catch (error) {
          if (
            signal.aborted ||
            (error instanceof ImageSourceError && error.reason !== 'download_failed')
          )
            throw error;
          image = await (this.ports.download ?? downloadChatImage)(source, signal);
        }
      }
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      await publish({
        ...base,
        id: `chat_image_result_${deliveryKey(identity)}`,
        kind: 'file',
        content: '',
        imageDelivery: { ...metadata, status: 'failed', reason: failureReason(error, source) },
      });
      return;
    }
    if (this.#abort.signal.aborted) return;
    if (signal.aborted) {
      await publish({
        ...base,
        id: `chat_image_result_${deliveryKey(identity)}`,
        kind: 'file',
        content: '',
        imageDelivery: {
          ...metadata,
          status: 'failed',
          reason: failureReason(signal.reason, source),
        },
      });
      return;
    }
    try {
      await publish(
        readyChatImageArtifact({
          id: `chat_image_result_${deliveryKey(identity)}`,
          sessionId,
          turnId,
          name: base.name,
          ...metadata,
          image,
          limits: this.ports.limits,
        }),
      );
    } catch (error) {
      if (!(error instanceof ImageArchiveQuotaError)) throw error;
      await publish({
        ...base,
        id: `chat_image_result_${deliveryKey(identity)}`,
        kind: 'file',
        content: '',
        imageDelivery: { ...metadata, status: 'failed', reason: 'quota_exceeded' },
      });
    }
  }
  beginDrain(): void {
    this.#closed = true;
    this.#abort.abort();
    for (const stream of this.#streams.values()) clearTimeout(stream.timer);
    this.#streams.clear();
    for (const job of this.#queue.splice(0)) job.cancel();
  }
  async close(): Promise<void> {
    this.beginDrain();
    await this.waitForIdle();
  }
  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#jobs.values()].map((job) => job.done));
  }
}
function deliveryKey(i: DeliveryIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([i.sessionId, i.turnId, i.messageId, i.source]))
    .digest('hex');
}
function failureReason(error: unknown, source: string): ImageDeliveryFailure {
  if (error instanceof ImageSourceError) return error.reason;
  if (error instanceof ImageFileReadError) return error.reason;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
  if (code === 'EACCES' || code === 'EPERM') return 'not_allowed';
  return /^https?:/i.test(source) ? 'download_failed' : 'read_failed';
}
