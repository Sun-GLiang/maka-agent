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
import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import {
  RequestError,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
} from '@agentclientprotocol/sdk';
import {
  readRuntimeHostSessionCatalogPage,
  RuntimeHostCatalogReadError,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  RuntimeHostSessionCatalogRevisionChangedError,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
  type RuntimeHostSessionCatalogPageCursor,
} from '@maka/runtime-host/client';
import {
  SESSION_CATALOG_CURSOR_MAX_BYTES,
  SESSION_CATALOG_CWD_MAX_BYTES,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
  type SubscriptionOpenInput,
} from '@maka/runtime-host/protocol';

const ACP_SESSION_CURSOR_VERSION = 1 as const;
const ACP_SESSION_CURSOR_MAX_BYTES = 8 * 1024;

interface AcpSessionSubscription extends AsyncIterable<SubscriptionFrame> {
  readonly snapshot: SessionContinuitySnapshot;
  close(): Promise<void>;
}

export interface AcpSessionRegistryConnection {
  readonly request: RuntimeHostConnection['request'];
  openSessionSubscriptionOnce(
    input: SubscriptionOpenInput,
    timeoutMs?: number,
  ): Promise<AcpSessionSubscription>;
  close(): Promise<void>;
}

export interface AcpSessionRegistryOptions {
  readonly connect: () => Promise<AcpSessionRegistryConnection>;
  readonly newSessionId?: () => string;
}

export interface AcpSessionRegistryFailure {
  readonly source: 'runtime_host';
  readonly operation: 'subscription.consume';
  readonly code: string;
  readonly reason?: string;
}

export interface AcpSessionRegistryInspection {
  readonly snapshot: SessionContinuitySnapshot;
  readonly failure?: AcpSessionRegistryFailure;
}

interface AcpSessionRecord {
  readonly sessionId: string;
  readonly subscription: AcpSessionSubscription;
  snapshot: SessionContinuitySnapshot;
  failure?: AcpSessionRegistryFailure;
  consumerTask: Promise<void>;
  closing: boolean;
}

/** Owns all Runtime Host resources associated with one ACP connection. */
export class AcpSessionRegistry {
  readonly #connect: () => Promise<AcpSessionRegistryConnection>;
  readonly #newSessionId: () => string;
  readonly #records = new Map<string, AcpSessionRecord>();
  readonly #inFlightOperations = new Set<Promise<unknown>>();
  #connection: AcpSessionRegistryConnection | undefined;
  #connectTask: Promise<AcpSessionRegistryConnection> | undefined;
  #closing = false;
  #connectionCloseTask: Promise<void> | undefined;
  #disposeTask: Promise<void> | undefined;

  constructor(options: AcpSessionRegistryOptions) {
    this.#connect = options.connect;
    this.#newSessionId = options.newSessionId ?? randomUUID;
  }

  async create(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.#assertOpen();
    validateNewSessionParams(params);
    return this.#track(this.#create(params));
  }

  async list(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.#assertOpen();
    return this.#track(this.#list(params));
  }

  inspect(sessionId: string): AcpSessionRegistryInspection | undefined {
    const record = this.#records.get(sessionId);
    if (!record) return undefined;
    return {
      snapshot: structuredClone(record.snapshot),
      ...(record.failure ? { failure: { ...record.failure } } : {}),
    };
  }

  dispose(): Promise<void> {
    this.#closing = true;
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #create(params: NewSessionRequest): Promise<NewSessionResponse> {
    const connection = await this.#getConnection();
    const sessionId = this.#newSessionId();
    try {
      await connection.request('session.create', {
        sessionId,
        workspace: { kind: 'host_path', path: params.cwd },
        modelTarget: { kind: 'default' },
      });
    } catch (error) {
      throw requestErrorFromRuntimeHost(error, 'session.create', { sessionId });
    }

    let subscription: AcpSessionSubscription;
    try {
      subscription = await connection.openSessionSubscriptionOnce({
        sessionId,
        transcript: { kind: 'none' },
      });
    } catch (error) {
      throw RequestError.internalError(
        {
          ...runtimeHostErrorData(error, 'subscription.open'),
          sessionId,
          durableSessionCreated: true,
        },
        'Runtime Host subscription could not be opened for the durable session',
      );
    }

    if (this.#closing) {
      try {
        await subscription.close();
      } catch {
        await this.#closeOwnedConnection();
      }
      throw RequestError.internalError(
        {
          source: 'runtime_host',
          operation: 'subscription.open',
          code: 'registry_closed',
          sessionId,
          durableSessionCreated: true,
        },
        'ACP connection closed while the durable session was being attached',
      );
    }

    const record: AcpSessionRecord = {
      sessionId,
      subscription,
      snapshot: structuredClone(subscription.snapshot),
      consumerTask: Promise.resolve(),
      closing: false,
    };
    this.#records.set(sessionId, record);
    record.consumerTask = this.#consume(record);
    return { sessionId };
  }

  async #consume(record: AcpSessionRecord): Promise<void> {
    try {
      for await (const frame of record.subscription) {
        if (frame.kind === 'subscription.session_projection') {
          record.snapshot = structuredClone(frame.snapshot);
        }
      }
      if (!record.closing) {
        record.failure = {
          source: 'runtime_host',
          operation: 'subscription.consume',
          code: 'subscription_closed',
        };
      }
    } catch (error) {
      if (!record.closing) {
        record.failure = runtimeHostSubscriptionFailure(error);
      }
    }
  }

  async #list(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cursor = params.cursor == null ? undefined : decodeAcpSessionCursor(params.cursor);
    const requestedCwd = params.cwd == null ? undefined : await normalizeCwd(params.cwd);
    if (cursor && requestedCwd !== undefined && cursor.cwd !== requestedCwd) {
      throw RequestError.invalidParams(
        { reason: 'cursor_cwd_mismatch' },
        'cursor was created for a different cwd filter',
      );
    }
    const cwd = requestedCwd ?? cursor?.cwd ?? null;
    const connection = await this.#getConnection();
    let page;
    try {
      page = await readRuntimeHostSessionCatalogPage(
        connection,
        cursor ? { revision: cursor.revision, cursor: cursor.cursor } : undefined,
      );
    } catch (error) {
      if (error instanceof RuntimeHostSessionCatalogRevisionChangedError) {
        throw RequestError.invalidParams(
          { reason: 'stale_cursor' },
          'session catalog changed; restart listing from the first page',
        );
      }
      throw requestErrorFromRuntimeHost(error, 'session.catalog.query');
    }

    const sessions = page.sessions.flatMap((session) => {
      if ('kind' in session || (cwd !== null && session.workspace.hostCwd !== cwd)) return [];
      const updatedAt = isoTimestamp(session.activityAt);
      return [
        {
          sessionId: session.id,
          cwd: session.workspace.hostCwd,
          title: session.name,
          ...(updatedAt ? { updatedAt } : {}),
        },
      ];
    });
    return {
      sessions,
      ...(page.nextCursor
        ? { nextCursor: encodeAcpSessionCursor({ ...page.nextCursor, cwd }) }
        : {}),
    };
  }

  async #dispose(): Promise<void> {
    const records = [...this.#records.values()];
    for (const record of records) record.closing = true;
    const subscriptionCloses = records.map((record) =>
      Promise.resolve().then(() => record.subscription.close()),
    );
    const connectionClose = this.#closeOwnedConnection();
    await Promise.allSettled([...subscriptionCloses, connectionClose]);
    await Promise.allSettled([...this.#inFlightOperations]);
    await Promise.allSettled(records.map((record) => record.consumerTask));
    this.#records.clear();
  }

  #closeOwnedConnection(): Promise<void> {
    const connection = this.#connection;
    const connectTask = this.#connectTask;
    if (!connection && !connectTask) return Promise.resolve();
    this.#connectionCloseTask ??= connection
      ? Promise.resolve().then(() => connection.close())
      : connectTask!.then(
          (connected) => connected.close(),
          () => undefined,
        );
    return this.#connectionCloseTask;
  }

  async #getConnection(): Promise<AcpSessionRegistryConnection> {
    this.#assertOpen();
    if (this.#connection) return this.#connection;
    const connectTask = (this.#connectTask ??= Promise.resolve().then(() => this.#connect()));
    let connection: AcpSessionRegistryConnection;
    try {
      connection = await connectTask;
    } catch {
      if (this.#connectTask === connectTask) this.#connectTask = undefined;
      if (this.#closing) throw registryClosedError('connect');
      throw RequestError.internalError(
        {
          source: 'runtime_host',
          operation: 'connect',
          code: 'connection_failed',
        },
        'Runtime Host connection failed',
      );
    }
    if (this.#closing) {
      await this.#closeOwnedConnection().catch(() => undefined);
      throw registryClosedError('connect');
    }
    this.#connection ??= connection;
    return this.#connection;
  }

  async #track<T>(operation: Promise<T>): Promise<T> {
    this.#inFlightOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.#inFlightOperations.delete(operation);
    }
  }

  #assertOpen(): void {
    if (!this.#closing) return;
    throw registryClosedError('subscription.open');
  }
}

function registryClosedError(operation: 'connect' | 'subscription.open'): RequestError {
  return RequestError.internalError(
    { source: 'runtime_host', operation, code: 'registry_closed' },
    'ACP session registry is closed',
  );
}

function validateNewSessionParams(params: NewSessionRequest): void {
  assertBoundedAbsoluteCwd(params.cwd);
  if (params.mcpServers.length > 0) {
    throw RequestError.invalidParams(
      { field: 'mcpServers', reason: 'unsupported' },
      'MCP servers are not supported by this ACP adapter yet',
    );
  }
  if ((params.additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams(
      { field: 'additionalDirectories', reason: 'unsupported' },
      'Additional directories are not supported by this ACP adapter yet',
    );
  }
}

function requestErrorFromRuntimeHost(
  error: unknown,
  operation: 'session.create' | 'session.catalog.query',
  extra: Record<string, unknown> = {},
): RequestError {
  const data = { ...runtimeHostErrorData(error, operation), ...extra };
  if (error instanceof RuntimeHostOperationError && error.code === 'invalid_request') {
    return RequestError.invalidParams(data, 'Runtime Host rejected the request');
  }
  return RequestError.internalError(data, 'Runtime Host request failed');
}

function runtimeHostErrorData(error: unknown, operation: string): Record<string, unknown> {
  if (error instanceof RuntimeHostOperationError) {
    return {
      source: 'runtime_host',
      operation: error.operation,
      code: error.code,
    };
  }
  if (error instanceof RuntimeHostRequestInterruptedError) {
    return {
      source: 'runtime_host',
      operation: error.operation,
      code: 'request_interrupted',
      reason: error.reason,
      dispatch: error.dispatch,
    };
  }
  if (error instanceof RuntimeHostSubscriptionError) {
    return {
      source: 'runtime_host',
      operation,
      code: 'subscription_failure',
      reason: error.reason,
    };
  }
  if (error instanceof RuntimeHostCatalogReadError) {
    return {
      source: 'runtime_host',
      operation,
      code: 'catalog_read_failure',
      reason: error.reason,
    };
  }
  return { source: 'runtime_host', operation, code: 'internal_failure' };
}

function runtimeHostSubscriptionFailure(error: unknown): AcpSessionRegistryFailure {
  if (error instanceof RuntimeHostSubscriptionError) {
    return {
      source: 'runtime_host',
      operation: 'subscription.consume',
      code: 'subscription_failure',
      reason: error.reason,
    };
  }
  return {
    source: 'runtime_host',
    operation: 'subscription.consume',
    code: 'internal_failure',
  };
}

interface AcpSessionCursor extends RuntimeHostSessionCatalogPageCursor {
  readonly v: typeof ACP_SESSION_CURSOR_VERSION;
  readonly cwd: string | null;
}

function encodeAcpSessionCursor(
  cursor: RuntimeHostSessionCatalogPageCursor & { readonly cwd: string | null },
): string {
  const encoded = Buffer.from(
    JSON.stringify({ v: ACP_SESSION_CURSOR_VERSION, ...cursor }),
    'utf8',
  ).toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > ACP_SESSION_CURSOR_MAX_BYTES) {
    throw RequestError.internalError(
      {
        source: 'runtime_host',
        operation: 'session.catalog.query',
        code: 'cursor_too_large',
      },
      'Runtime Host cursor cannot be represented safely in ACP',
    );
  }
  return encoded;
}

function decodeAcpSessionCursor(encoded: string): AcpSessionCursor {
  try {
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > ACP_SESSION_CURSOR_MAX_BYTES) {
      throw new Error('cursor size is invalid');
    }
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error('cursor encoding is invalid');
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('cursor body is invalid');
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 4 ||
      record.v !== ACP_SESSION_CURSOR_VERSION ||
      typeof record.revision !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(record.revision) ||
      typeof record.cursor !== 'string' ||
      record.cursor.length === 0 ||
      Buffer.byteLength(record.cursor, 'utf8') > SESSION_CATALOG_CURSOR_MAX_BYTES ||
      !validCursorCwd(record.cwd)
    ) {
      throw new Error('cursor fields are invalid');
    }
    return {
      v: ACP_SESSION_CURSOR_VERSION,
      revision: record.revision as RuntimeHostSessionCatalogPageCursor['revision'],
      cursor: record.cursor,
      cwd: record.cwd,
    };
  } catch {
    throw RequestError.invalidParams({ reason: 'invalid_cursor' }, 'cursor is invalid');
  }
}

function validCursorCwd(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      isAbsolute(value) &&
      normalize(value) === value &&
      Buffer.byteLength(value, 'utf8') <= SESSION_CATALOG_CWD_MAX_BYTES)
  );
}

async function normalizeCwd(cwd: string): Promise<string> {
  assertBoundedAbsoluteCwd(cwd);
  const lexical = normalize(cwd);
  try {
    return await realpath(lexical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return lexical;
    throw RequestError.internalError(
      {
        source: 'filesystem',
        operation: 'cwd.realpath',
        code: code ?? 'internal_failure',
      },
      'cwd could not be canonicalized',
    );
  }
}

function assertBoundedAbsoluteCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw RequestError.invalidParams(
      { field: 'cwd', reason: 'must_be_absolute' },
      'cwd must be an absolute path',
    );
  }
  if (Buffer.byteLength(cwd, 'utf8') > SESSION_CATALOG_CWD_MAX_BYTES) {
    throw RequestError.invalidParams(
      { field: 'cwd', reason: 'too_large' },
      'cwd exceeds the Runtime Host path limit',
    );
  }
}

function isoTimestamp(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
