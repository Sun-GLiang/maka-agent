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
import { constants } from 'node:fs';
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  methods,
  type ClientApp,
  type ClientConnection,
  type RequestPermissionRequest,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  AgentBackend,
  BackendSendInput,
  HostedFormSettlement,
} from '@maka/core/backend-types';
import type { FormRequestEvent, SessionEvent, ToolResultContent } from '@maka/core/events';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { AcpConnectionError, createAcpConnection, type AcpConnectionOwner } from './connection.js';

const CANCEL_TIMEOUT_MS = 15_000;
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

interface ToolSnapshot {
  readonly id: string;
  title: string;
  name?: string;
  kind?: ToolCall['kind'];
  status?: ToolCall['status'];
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
  started: boolean;
  terminal: boolean;
}

interface PendingPermission {
  readonly requestId: string;
  readonly settle: (outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }) => void;
  readonly hostedSettlement: HostedFormSettlement;
}

export interface AcpAgentBackendInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly releaseResidency: () => void;
  readonly onCleanupFailure: () => void;
}

/** One official ACP process and protocol Session, retained across turns for one Maka Session. */
export class AcpAgentBackend implements AgentBackend {
  readonly kind = 'acp' as const;
  readonly sessionId: string;
  private readonly cwd: string;
  private readonly input: AcpAgentBackendInput;
  private owner?: AcpConnectionOwner;
  private connection?: ClientConnection;
  private acpSessionId?: string;
  private initialization?: Promise<void>;
  private current?: {
    readonly turnId: string;
    readonly queue: EventQueue;
    readonly textByMessage: Map<string, string>;
    readonly thinkingByMessage: Map<string, string>;
    readonly tools: Map<string, ToolSnapshot>;
    readonly hostedInteraction: BackendSendInput['hostedInteraction'];
    readonly promptSettled: Promise<void>;
    cancelledWithPendingPermission: boolean;
    settlePrompt(): void;
  };
  private pendingPermissions = new Map<string, PendingPermission>();
  private stopping = false;
  private lost = false;
  private disposed = false;

  constructor(input: AcpAgentBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.cwd = resolve(input.cwd);
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.disposed || this.lost) throw new Error('ACP Session is no longer available');
    if (this.current) throw new Error('ACP Session is busy');
    if (input.attachments?.length) throw new Error('ACP supports project files and text only');
    await this.ensureInitialized();
    const queue = new EventQueue();
    let settlePrompt!: () => void;
    const promptSettled = new Promise<void>((resolvePrompt) => {
      settlePrompt = resolvePrompt;
    });
    const active = {
      turnId: input.turnId,
      queue,
      textByMessage: new Map<string, string>(),
      thinkingByMessage: new Map<string, string>(),
      tools: new Map<string, ToolSnapshot>(),
      hostedInteraction: input.hostedInteraction,
      promptSettled,
      cancelledWithPendingPermission: false,
      settlePrompt,
    };
    this.current = active;
    this.stopping = false;
    void this.runPrompt(input, active).catch((error) => queue.fail(error));
    try {
      for await (const event of queue) yield event;
    } finally {
      if (this.current === active) this.current = undefined;
    }
  }

  async stop(_reason: 'user_stop' | 'redirect'): Promise<void> {
    const active = this.current;
    if (!active || !this.connection || !this.acpSessionId) return;
    this.stopping = true;
    active.cancelledWithPendingPermission = this.pendingPermissions.size > 0;
    for (const permission of this.pendingPermissions.values()) {
      permission.settle({ outcome: 'cancelled' });
      await permission.hostedSettlement.applyClosure('turn_stopped').catch(() => undefined);
    }
    this.pendingPermissions.clear();
    await this.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.acpSessionId,
    });
    const completed = await Promise.race([
      active.promptSettled.then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), CANCEL_TIMEOUT_MS)),
    ]);
    if (!completed) {
      this.lost = true;
      await this.releaseOwner();
      active.queue.push(event(active.turnId, 'abort', { reason: 'timeout' }));
      active.queue.finish();
    }
  }

  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {
    throw new Error('ACP permissions use hosted forms');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const permission of this.pendingPermissions.values()) {
      permission.settle({ outcome: 'cancelled' });
      await permission.hostedSettlement.applyClosure('producer_cancelled').catch(() => undefined);
    }
    this.pendingPermissions.clear();
    await this.releaseOwner();
    this.input.releaseResidency();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initialize();
    return this.initialization;
  }

  private async initialize(): Promise<void> {
    const owner = createAcpConnection({
      executable: this.input.executable,
      cwd: dirname(this.input.executable),
      env: {
        ...this.input.env,
        BROWSER: '/usr/bin/true',
        PYTHONUNBUFFERED: '1',
        ANTIGRAVITY_HARNESS_PATH: resolve(dirname(this.input.executable), 'localharness_external'),
      },
      onStderr: () => {},
      configureClient: (app) => this.configureClient(app),
    });
    this.owner = owner;
    this.connection = owner.connection;
    try {
      const initialized = await owner.connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      });
      if (initialized.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
      const session = await owner.connection.agent.request(methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers: [],
      });
      this.acpSessionId = session.sessionId;
      void owner.failed.catch((error) => this.failConnection(error));
    } catch (error) {
      this.lost = true;
      await this.releaseOwner();
      throw error;
    }
  }

  private configureClient(app: ClientApp): void {
    app
      .onNotification(methods.client.session.update, ({ params }) => {
        if (params.sessionId === this.acpSessionId) this.acceptUpdate(params.update);
      })
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
        this.assertAcpSession(params.sessionId);
        const path = await this.checkedPath(params.path, false);
        const info = await stat(path);
        if (info.size > MAX_TEXT_FILE_BYTES) throw new Error('ACP text file is too large');
        const text = await readFile(path, 'utf8');
        const start = params.line ? params.line - 1 : 0;
        return {
          content:
            params.line || params.limit
              ? text
                  .split('\n')
                  .slice(start, params.limit ? start + params.limit : undefined)
                  .join('\n')
              : text,
        };
      })
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        this.assertAcpSession(params.sessionId);
        if (Buffer.byteLength(params.content) > MAX_TEXT_FILE_BYTES)
          throw new Error('ACP text file is too large');
        const path = await this.checkedPath(params.path, true);
        await writeFile(path, params.content, 'utf8');
        return {};
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) =>
        this.requestPermission(params),
      );
  }

  private async runPrompt(
    input: BackendSendInput,
    active: NonNullable<AcpAgentBackend['current']>,
  ): Promise<void> {
    try {
      const response = await this.connection!.agent.request(methods.agent.session.prompt, {
        sessionId: this.acpSessionId!,
        prompt: [{ type: 'text', text: promptText(input) }],
      });
      this.flushCompletedMessages(active);
      const message = [...active.textByMessage.values()].join('').trim();
      const executionFailed = message.startsWith('Agent execution error:');
      const stopReason = executionFailed
        ? 'error'
        : response.stopReason === 'cancelled'
          ? 'user_stop'
          : mapStopReason(response.stopReason);
      active.queue.push(event(active.turnId, 'complete', { stopReason }));
      active.queue.finish();
      // Antigravity 1.1.1 can return a cancelled prompt while leaving its input
      // step unregistered after a permission form was pending. Do not present
      // that process as resumable: a follow-up would otherwise end silently.
      if (response.stopReason === 'cancelled' && active.cancelledWithPendingPermission) {
        this.lost = true;
        await this.releaseOwner();
      }
    } catch (error) {
      // A transport failure after cancel is not an acknowledged cancellation.
      this.lost = true;
      active.queue.fail(error);
    } finally {
      active.settlePrompt();
    }
  }

  private acceptUpdate(update: SessionUpdate): void {
    const active = this.current;
    if (!active) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const messageId = update.messageId ?? `acp-message-${active.turnId}`;
      active.textByMessage.set(messageId, (active.textByMessage.get(messageId) ?? '') + update.content.text);
      active.queue.push(event(active.turnId, 'text_delta', { messageId, text: update.content.text }));
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      const messageId = update.messageId ?? `acp-thinking-${active.turnId}`;
      active.thinkingByMessage.set(
        messageId,
        (active.thinkingByMessage.get(messageId) ?? '') + update.content.text,
      );
      active.queue.push(event(active.turnId, 'thinking_delta', { messageId, text: update.content.text }));
      return;
    }
    if (update.sessionUpdate === 'tool_call') this.acceptTool(update, false);
    if (update.sessionUpdate === 'tool_call_update') this.acceptTool(update, true);
  }

  private acceptTool(update: ToolCall | ToolCallUpdate, partial: boolean): void {
    const active = this.current;
    if (!active) return;
    const previous = active.tools.get(update.toolCallId);
    const snapshot: ToolSnapshot = previous ?? {
      id: update.toolCallId,
      title: 'External tool',
      content: [],
      started: false,
      terminal: false,
    };
    if ('title' in update && update.title != null) snapshot.title = update.title;
    if (update.name != null) snapshot.name = update.name;
    if (update.kind != null) snapshot.kind = update.kind;
    if (update.status != null) snapshot.status = update.status;
    if (update.content != null) snapshot.content = [...update.content];
    if (update.rawInput !== undefined) snapshot.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) snapshot.rawOutput = update.rawOutput;
    active.tools.set(snapshot.id, snapshot);
    if (!snapshot.started) {
      snapshot.started = true;
      active.queue.push(
        event(active.turnId, 'tool_start', {
          toolUseId: snapshot.id,
          toolName: snapshot.name ?? snapshot.kind ?? 'external_tool',
          displayName: snapshot.title,
          args: snapshot.rawInput ?? {},
          providerExecuted: true,
          origin: 'provider',
          modelVisibility: 'hidden',
        }),
      );
    }
    if (partial && snapshot.status !== 'completed' && snapshot.status !== 'failed') {
      active.queue.push(
        event(active.turnId, 'tool_progress', {
          toolUseId: snapshot.id,
          chunk: summarizeToolContent(snapshot.content),
          origin: 'provider',
          modelVisibility: 'hidden',
        }),
      );
    }
    if (!snapshot.terminal && (snapshot.status === 'completed' || snapshot.status === 'failed')) {
      snapshot.terminal = true;
      active.queue.push(
        event(active.turnId, 'tool_result', {
          toolUseId: snapshot.id,
          providerExecuted: true,
          providerOutput: snapshot.rawOutput,
          isError: snapshot.status === 'failed',
          content: terminalToolContent(snapshot),
          origin: 'provider',
          modelVisibility: 'hidden',
        }),
      );
    }
  }

  private async requestPermission(params: RequestPermissionRequest) {
    this.assertAcpSession(params.sessionId);
    const active = this.current;
    if (!active?.hostedInteraction) return { outcome: { outcome: 'cancelled' as const } };
    const requestId = randomUUID();
    const request: FormRequestEvent = {
      type: 'form_request',
      id: randomUUID(),
      turnId: active.turnId,
      ts: Date.now(),
      requestId,
      toolUseId: params.toolCall.toolCallId,
      message: params.toolCall.title ?? 'Antigravity requests permission',
      requester: { name: 'Antigravity', source: 'ACP' },
      fields: [
        {
          kind: 'single_select',
          name: 'optionId',
          label: 'Permission',
          required: true,
          options: params.options.map((option) => ({ value: option.optionId, label: option.name })),
        },
      ],
    };
    let resolveOutcome!: PendingPermission['settle'];
    const outcome = new Promise<Parameters<PendingPermission['settle']>[0]>((resolvePermission) => {
      resolveOutcome = resolvePermission;
    });
    let settled = false;
    const settle = (value: Parameters<PendingPermission['settle']>[0]) => {
      if (settled) return;
      settled = true;
      this.pendingPermissions.delete(requestId);
      resolveOutcome(value);
    };
    const hostedSettlement: HostedFormSettlement = {
      applyAnswer: async (answer) => {
        if (answer.action !== 'accept') return settle({ outcome: 'cancelled' });
        const selected = answer.values.optionId;
        if (typeof selected !== 'string' || !params.options.some((option) => option.optionId === selected))
          return settle({ outcome: 'cancelled' });
        settle({ outcome: 'selected', optionId: selected });
      },
      applyClosure: async () => settle({ outcome: 'cancelled' }),
    };
    this.pendingPermissions.set(requestId, { requestId, settle, hostedSettlement });
    try {
      await active.hostedInteraction.admitFormRequest({ request, settlement: hostedSettlement });
      active.queue.push(request);
      return { outcome: await outcome };
    } catch (error) {
      settle({ outcome: 'cancelled' });
      throw error;
    }
  }

  private flushCompletedMessages(active: NonNullable<AcpAgentBackend['current']>): void {
    for (const [messageId, text] of active.textByMessage) {
      active.queue.push(event(active.turnId, 'text_complete', { messageId, text }));
    }
    for (const [messageId, text] of active.thinkingByMessage) {
      active.queue.push(event(active.turnId, 'thinking_complete', { messageId, text }));
    }
  }

  private assertAcpSession(sessionId: string): void {
    if (!this.acpSessionId || sessionId !== this.acpSessionId) throw new Error('Unknown ACP Session');
  }

  private async checkedPath(path: string, forWrite: boolean): Promise<string> {
    if (!isAbsolute(path)) throw new Error('ACP file path must be absolute');
    const candidate = resolve(path);
    let resolvedPath: string;
    if (!forWrite) {
      resolvedPath = await realpath(candidate);
    } else {
      try {
        // Existing symlinks must be resolved before the containment decision.
        resolvedPath = await realpath(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        resolvedPath = resolve(await realpath(dirname(candidate)), basename(candidate));
      }
    }
    const rel = relative(await realpath(this.cwd), resolvedPath);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('ACP file path leaves the workspace');
    if (!forWrite) await access(resolvedPath, constants.R_OK);
    return resolvedPath;
  }

  private failConnection(error: unknown): void {
    if (this.disposed) return;
    this.lost = true;
    const active = this.current;
    if (active) active.queue.fail(error instanceof Error ? error : new AcpConnectionError('connection_failed'));
  }

  private async releaseOwner(): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    try {
      await owner.dispose();
      this.owner = undefined;
      this.connection = undefined;
    } catch (error) {
      this.input.onCleanupFailure();
      throw error;
    }
  }
}

function promptText(input: BackendSendInput): string {
  const sections = [input.text];
  for (const quote of input.quotes ?? []) sections.push(`Quoted context:\n${quote.text}`);
  for (const reference of input.directoryReferences ?? [])
    sections.push(`Project directory reference: ${reference.path}`);
  return sections.filter(Boolean).join('\n\n');
}

function terminalToolContent(snapshot: ToolSnapshot): ToolResultContent {
  const diffs = snapshot.content.filter((item): item is Extract<ToolCallContent, { type: 'diff' }> => item.type === 'diff');
  if (diffs.length) {
    return {
      kind: 'file_diff',
      paths: diffs.map((diff) => diff.path),
      diff: diffs
        .map((diff) => `--- a/${diff.path}\n+++ b/${diff.path}\n${diff.oldText}\n${diff.newText}`)
        .join('\n\n'),
    };
  }
  const text = summarizeToolContent(snapshot.content);
  return text ? { kind: 'text', text } : { kind: 'json', value: snapshot.rawOutput ?? null };
}

function summarizeToolContent(content: readonly ToolCallContent[]): string {
  return content
    .map((item) => {
      if (item.type === 'diff') return `Updated ${item.path}`;
      if (item.type === 'terminal') return `Terminal ${item.terminalId}`;
      return item.content.type === 'text' ? item.content.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function mapStopReason(reason: string): 'end_turn' | 'max_tokens' | 'error' {
  if (reason === 'end_turn') return 'end_turn';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'error';
}

function event<T extends SessionEvent['type']>(
  turnId: string,
  type: T,
  fields: Omit<Extract<SessionEvent, { type: T }>, 'id' | 'turnId' | 'ts' | 'type'>,
): Extract<SessionEvent, { type: T }> {
  return { type, id: randomUUID(), turnId, ts: Date.now(), ...fields } as Extract<
    SessionEvent,
    { type: T }
  >;
}

class EventQueue implements AsyncIterable<SessionEvent> {
  private values: SessionEvent[] = [];
  private waiters: Array<(result: IteratorResult<SessionEvent>) => void> = [];
  private ended = false;
  private failure?: unknown;

  push(value: SessionEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }
  finish(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  fail(error: unknown): void {
    this.failure = error;
    this.finish();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    while (true) {
      const value = this.values.shift();
      if (value) yield value;
      else if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      } else {
        const next = await new Promise<IteratorResult<SessionEvent>>((resolveNext) =>
          this.waiters.push(resolveNext),
        );
        if (next.done) {
          if (this.failure) throw this.failure;
          return;
        }
        yield next.value;
      }
    }
  }
}
