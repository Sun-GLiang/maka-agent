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
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import type { FormRequestEvent, SessionEvent, ToolResultContent } from '@maka/core/events';
import { redactSecrets } from '@maka/core/redaction';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { AcpConnectionError, createAcpConnection, type AcpConnectionOwner } from './connection.js';

const CANCEL_TIMEOUT_MS = 15_000;
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ACP_ERROR_MESSAGE_BYTES = 2 * 1024;
const MAX_ACP_STDERR_BYTES = 8 * 1024;

type AcpFailureStage = 'connection' | 'initialize' | 'session_new' | 'prompt' | 'transport';

class AcpAgentExecutionError extends Error {
  constructor(
    readonly stage: AcpFailureStage,
    readonly original: unknown,
  ) {
    super(errorMessage(original), { cause: original });
    this.name = 'AcpAgentExecutionError';
  }
}

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
  readonly settle: (
    outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string },
  ) => void;
  readonly hostedSettlement: HostedFormSettlement;
}

export interface AcpAgentBackendInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly releaseResidency: () => void;
  readonly onCleanupFailure: () => void;
  readonly onUnavailable: () => void;
  readonly createConnection?: (
    input: Parameters<typeof createAcpConnection>[0],
  ) => AcpConnectionOwner;
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
    readonly initializationAbort: AbortController;
    cancelRequested: boolean;
    promptDispatched: boolean;
    cancelledWithPendingPermission: boolean;
    settlePrompt(): void;
  };
  private pendingPermissions = new Map<string, PendingPermission>();
  private stopping = false;
  private lost = false;
  private disposed = false;
  private unavailableReported = false;
  private stderrTail = '';

  constructor(input: AcpAgentBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.cwd = resolve(input.cwd);
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.disposed || this.lost) throw new Error('ACP Session is no longer available');
    if (this.current) throw new Error('ACP Session is busy');
    if (input.attachments?.length) throw new Error('ACP supports project files and text only');
    this.stderrTail = '';
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
      initializationAbort: new AbortController(),
      cancelRequested: false,
      promptDispatched: false,
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
    if (!active) return;
    this.stopping = true;
    active.cancelRequested = true;
    active.cancelledWithPendingPermission = this.pendingPermissions.size > 0;
    const permissionClosures = [...this.pendingPermissions.values()].map((permission) => {
      permission.settle({ outcome: 'cancelled' });
      return permission.hostedSettlement.applyClosure('turn_stopped').catch(() => undefined);
    });
    this.pendingPermissions.clear();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cancellation = Promise.all(permissionClosures).then(async () => {
      if (this.connection && this.acpSessionId) {
        await this.connection.agent.notify(methods.agent.session.cancel, {
          sessionId: this.acpSessionId,
        });
      } else {
        active.initializationAbort.abort();
      }
      await active.promptSettled;
      return true as const;
    });
    const completed = await Promise.race([
      cancellation,
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), CANCEL_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!completed) {
      this.markUnavailable();
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
    this.reportUnavailable();
    for (const permission of this.pendingPermissions.values()) {
      permission.settle({ outcome: 'cancelled' });
      await permission.hostedSettlement.applyClosure('producer_cancelled').catch(() => undefined);
    }
    this.pendingPermissions.clear();
    await this.releaseOwner();
    this.input.releaseResidency();
  }

  private async ensureInitialized(cancellationSignal: AbortSignal): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initialize(cancellationSignal);
    return this.initialization;
  }

  private async initialize(cancellationSignal: AbortSignal): Promise<void> {
    let stage: AcpFailureStage = 'connection';
    try {
      const owner = (this.input.createConnection ?? createAcpConnection)({
        executable: this.input.executable,
        cwd: dirname(this.input.executable),
        env: {
          ...this.input.env,
          BROWSER: '/usr/bin/true',
          PYTHONUNBUFFERED: '1',
          ANTIGRAVITY_HARNESS_PATH: resolve(
            dirname(this.input.executable),
            'localharness_external',
          ),
        },
        onStderr: (chunk) => this.captureStderr(chunk),
        configureClient: (app) => this.configureClient(app),
      });
      this.owner = owner;
      this.connection = owner.connection;
      stage = 'initialize';
      const initialized = await owner.connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false,
          },
        },
        { cancellationSignal },
      );
      if (initialized.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
      stage = 'session_new';
      const session = await owner.connection.agent.request(
        methods.agent.session.new,
        { cwd: this.cwd, mcpServers: [] },
        { cancellationSignal },
      );
      this.acpSessionId = session.sessionId;
      void owner.failed.catch((error) => this.failConnection(error));
    } catch (error) {
      this.markUnavailable();
      const failure = new AcpAgentExecutionError(stage, error);
      try {
        await this.releaseOwner();
      } catch (cleanupError) {
        throw new AcpAgentExecutionError(
          stage,
          new AggregateError([error, cleanupError], errorMessage(error)),
        );
      }
      throw failure;
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
      await this.ensureInitialized(active.initializationAbort.signal);
      if (active.cancelRequested) {
        active.queue.push(
          event(active.turnId, 'complete', {
            stopReason: 'user_stop',
            providerStopReason: 'cancelled_before_prompt',
          }),
        );
        active.queue.finish();
        return;
      }
      active.promptDispatched = true;
      const response = await this.connection!.agent.request(methods.agent.session.prompt, {
        sessionId: this.acpSessionId!,
        prompt: [{ type: 'text', text: promptText(input) }],
      });
      this.flushCompletedMessages(active);
      const message = [...active.textByMessage.values()].join('').trim();
      const executionFailed = message.startsWith('Agent execution error:');
      if (executionFailed) {
        active.queue.push(
          event(active.turnId, 'error', {
            recoverable: false,
            code: 'acp_agent_execution_failed',
            reason: 'acp_agent_execution_failed',
            message: safeErrorMessage(message),
            details: { stage: 'prompt', providerStopReason: response.stopReason },
          }),
        );
      }
      const stopReason = executionFailed
        ? 'error'
        : response.stopReason === 'cancelled'
          ? 'user_stop'
          : mapAcpStopReason(response.stopReason);
      active.queue.push(
        event(active.turnId, 'complete', {
          stopReason,
          providerStopReason: response.stopReason,
        }),
      );
      active.queue.finish();
      // Antigravity 1.1.1 can return a cancelled prompt while leaving its input
      // step unregistered after a permission form was pending. Do not present
      // that process as resumable: a follow-up would otherwise end silently.
      if (response.stopReason === 'cancelled' && active.cancelledWithPendingPermission) {
        this.markUnavailable();
        await this.releaseOwner();
      }
    } catch (error) {
      if (active.cancelRequested) {
        this.markUnavailable();
        await this.releaseOwner().catch(() => undefined);
        active.queue.push(
          event(active.turnId, 'complete', {
            stopReason: 'user_stop',
            providerStopReason: active.promptDispatched
              ? 'cancelled_during_prompt'
              : 'cancelled_during_startup',
          }),
        );
        active.queue.finish();
        return;
      }
      // A transport failure after cancel is not an acknowledged cancellation.
      this.markUnavailable();
      const failure =
        error instanceof AcpAgentExecutionError
          ? error
          : new AcpAgentExecutionError(active.promptDispatched ? 'prompt' : 'transport', error);
      this.failActiveTurn(active, failure);
    } finally {
      active.settlePrompt();
    }
  }

  private acceptUpdate(update: SessionUpdate): void {
    const active = this.current;
    if (!active) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const messageId = update.messageId ?? `acp-message-${active.turnId}`;
      active.textByMessage.set(
        messageId,
        (active.textByMessage.get(messageId) ?? '') + update.content.text,
      );
      active.queue.push(
        event(active.turnId, 'text_delta', { messageId, text: update.content.text }),
      );
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      const messageId = update.messageId ?? `acp-thinking-${active.turnId}`;
      active.thinkingByMessage.set(
        messageId,
        (active.thinkingByMessage.get(messageId) ?? '') + update.content.text,
      );
      active.queue.push(
        event(active.turnId, 'thinking_delta', { messageId, text: update.content.text }),
      );
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
          content: projectAcpToolContent(snapshot.content, snapshot.rawOutput),
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
        if (
          typeof selected !== 'string' ||
          !params.options.some((option) => option.optionId === selected)
        )
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
    if (!this.acpSessionId || sessionId !== this.acpSessionId)
      throw new Error('Unknown ACP Session');
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
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw new Error('ACP file path leaves the workspace');
    if (!forWrite) await access(resolvedPath, constants.R_OK);
    return resolvedPath;
  }

  private failConnection(error: unknown): void {
    if (this.disposed) return;
    this.markUnavailable();
    const active = this.current;
    if (active) {
      this.failActiveTurn(
        active,
        new AcpAgentExecutionError(
          'transport',
          error instanceof Error ? error : new AcpConnectionError('connection_failed'),
        ),
      );
    }
  }

  private failActiveTurn(
    active: NonNullable<AcpAgentBackend['current']>,
    failure: AcpAgentExecutionError,
  ): void {
    const code = `acp_${failure.stage}_failed`;
    const details: Record<string, unknown> = { stage: failure.stage };
    const jsonRpcCode = errorCode(failure.original);
    if (jsonRpcCode !== undefined) details.jsonRpcCode = jsonRpcCode;
    const stderr = this.safeStderr();
    if (stderr) details.stderr = stderr;
    active.queue.push(
      event(active.turnId, 'error', {
        recoverable: false,
        code,
        reason: code,
        message: `Antigravity ACP ${failure.stage} failed: ${safeErrorMessage(failure.original)}`,
        details,
      }),
    );
    active.queue.push(
      event(active.turnId, 'complete', {
        stopReason: 'error',
        providerStopReason: code,
      }),
    );
    active.queue.finish();
  }

  private captureStderr(chunk: Buffer): void {
    this.stderrTail = utf8Tail(
      redactSecrets(`${this.stderrTail}${chunk.toString('utf8')}`),
      MAX_ACP_STDERR_BYTES,
    );
  }

  private safeStderr(): string {
    return truncateUtf8(redactSecrets(this.stderrTail.trim()), MAX_ACP_STDERR_BYTES);
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

  private markUnavailable(): void {
    this.lost = true;
    this.reportUnavailable();
  }

  private reportUnavailable(): void {
    if (this.unavailableReported) return;
    this.unavailableReported = true;
    this.input.onUnavailable();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function safeErrorMessage(error: unknown): string {
  return truncateUtf8(redactSecrets(errorMessage(error)), MAX_ACP_ERROR_MESSAGE_BYTES);
}

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.length > 0) {
    return truncateUtf8(redactSecrets(code), 256);
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const nestedCode = errorCode(nested);
      if (nestedCode !== undefined) return nestedCode;
    }
  }
  return undefined;
}

function promptText(input: BackendSendInput): string {
  const sections = [input.text];
  for (const quote of input.quotes ?? []) sections.push(`Quoted context:\n${quote.text}`);
  for (const reference of input.directoryReferences ?? [])
    sections.push(`Project directory reference: ${reference.path}`);
  return sections.filter(Boolean).join('\n\n');
}

export function projectAcpToolContent(
  content: readonly ToolCallContent[],
  rawOutput?: unknown,
): ToolResultContent {
  const parts: Array<Extract<ToolResultContent, { kind: 'external_tool' }>['parts'][number]> = [];
  for (const item of content) {
    if (item.type === 'diff') {
      parts.push({
        kind: 'file_diff',
        paths: [item.path],
        diff: createWholeFileDiff(item.path, item.oldText ?? '', item.newText ?? ''),
      });
      continue;
    }
    if (item.type === 'terminal') {
      if (item.terminalId) parts.push({ kind: 'terminal', terminalId: item.terminalId });
      continue;
    }
    if (item.content.type === 'text') parts.push({ kind: 'text', text: item.content.text });
  }
  if (parts.length === 1 && parts[0]?.kind === 'text') return parts[0];
  if (parts.length === 1 && parts[0]?.kind === 'file_diff') return parts[0];
  return parts.length
    ? { kind: 'external_tool', parts }
    : { kind: 'json', value: rawOutput ?? null };
}

function createWholeFileDiff(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
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

export function mapAcpStopReason(
  reason: string,
): 'end_turn' | 'max_tokens' | 'step_limit' | 'error' {
  if (reason === 'end_turn') return 'end_turn';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'max_turn_requests') return 'step_limit';
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
