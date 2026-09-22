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

import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { methods, type ClientApp, type ClientConnection } from '@agentclientprotocol/sdk';
import type { PluginExecutorContext } from '@maka/runtime/plugin-executor-service';
import {
  AcpExecutor,
  type AcpAgentAdapter,
  type AcpConnectionFactory,
  type AcpConversationStateStore,
} from '../index.js';

const adapter: AcpAgentAdapter<{ executable: string; model?: string }> = {
  id: 'fixture-acp',
  displayName: 'Fixture',
  configure: (config) => ({
    launch: {
      executable: config.executable,
      ...(config.model ? { initialConfig: { model: config.model } } : {}),
    },
  }),
};

test('runtime retains one ACP process and Session across prompts', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable, model: 'fast' },
    {
      createConnection: protocol.factory,
    },
  );
  const events: unknown[] = [];
  const context = executorContext(events);
  try {
    assert.deepEqual(await executor.execute(request('first'), context), {
      status: 'completed',
      text: 'reply:first',
    });
    assert.deepEqual(await executor.execute(request('second'), context), {
      status: 'completed',
      text: 'reply:second',
    });
    assert.equal(protocol.connections, 1);
    assert.equal(protocol.sessions, 1);
    assert.equal(protocol.prompts, 2);
    assert.equal(protocol.selectedModel, 'fast');
    assert.equal(
      (
        events.find((event) => (event as { type: string }).type === 'tool_result') as {
          content: { kind: string; paths: string[]; diff: string };
        }
      ).content.kind,
      'file_diff',
    );
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.equal(protocol.disposals, 1);
});

test('runtime rejects a historical conversation after process continuity was lost', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const marked = new Set<string>();
  const state: AcpConversationStateStore = {
    has: async (key, cwd) => marked.has(`${key}\0${cwd}`),
    mark: async (key, cwd) => {
      marked.add(`${key}\0${cwd}`);
    },
  };
  const first = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
      state,
    },
  );
  try {
    assert.equal((await first.execute(request('first'), executorContext([]))).status, 'completed');
    await first.dispose();
    const restarted = new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        createConnection: protocol.factory,
        state,
      },
    );
    try {
      assert.deepEqual(await restarted.execute(request('second'), executorContext([])), {
        status: 'failed',
        message: 'ACP conversation is history-only after the Plugin or Host was restarted',
        code: 'acp_history_only',
        recoverable: false,
      });
      assert.equal(protocol.connections, 1);
    } finally {
      await restarted.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const stopReason of [
  'cancelled',
  'end_turn',
  'max_tokens',
  'refusal',
  'request_error',
  'process_crash',
]) {
  test(`runtime drains cancellation and preserves ${stopReason}`, async () => {
    const fixture = await executableFixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let cancellations = 0;
    let crash!: (error: Error) => void;
    const failed = new Promise<never>((_resolve, reject) => {
      crash = reject;
    });
    const factory: AcpConnectionFactory = (input) => {
      input.configureClient(chainableApp());
      return {
        connection: {
          agent: {
            request: async (method: string) => {
              if (method === methods.agent.initialize) return { protocolVersion: 1 };
              if (method === methods.agent.session.new) return { sessionId: 'acp-session' };
              if (method === methods.agent.session.prompt) {
                started();
                await settled;
                if (stopReason === 'request_error') throw new Error('request failed');
                return { stopReason };
              }
              throw new Error(`Unexpected ACP method: ${method}`);
            },
            notify: async () => {
              cancellations += 1;
              if (stopReason === 'process_crash') crash(new Error('process exited'));
              else settle();
            },
          },
          close: () => undefined,
        } as unknown as ClientConnection,
        failed,
        dispose: async () => undefined,
      };
    };
    const executor = new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      { createConnection: factory },
    );
    const abort = new AbortController();
    const execution = executor.execute(request('cancel'), executorContext([], abort.signal));
    await ready;
    abort.abort(new Error('user_stop'));
    try {
      assert.deepEqual(await execution, {
        status: 'cancelled',
        ...(['request_error', 'process_crash'].includes(stopReason)
          ? { reason: 'crash', providerStopReason: 'acp_execution_failed' }
          : { providerStopReason: stopReason }),
      });
      assert.equal(cancellations, 1);
    } finally {
      await executor.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const selection of [
  { model: 'fast' },
  { configuration: { model: 'fast' } },
  { model: 'fast', configuration: { model: 'fast' } },
  { model: 'fixture-acp', configuration: {} },
  { model: 'removed' },
  { model: 'default', configuration: { model: 'fast' } },
]) {
  test(`runtime consumes or rejects the exact model selection ${JSON.stringify(selection)}`, async () => {
    const fixture = await executableFixture();
    const protocol = fakeProtocol();
    const executor = new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      { createConnection: protocol.factory },
    );
    try {
      const result = await executor.execute(
        { ...request('model'), ...selection },
        executorContext([]),
      );
      const invalid = selection.model === 'removed' || selection.model === 'default';
      assert.equal(result.status, invalid ? 'failed' : 'completed');
      assert.equal(protocol.prompts, invalid ? 0 : 1);
      if (!invalid && selection.model !== 'fixture-acp')
        assert.equal(protocol.selectedModel, 'fast');
      if (invalid && result.status === 'failed') assert.equal(result.code, 'acp_config_invalid');
    } finally {
      await executor.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test('discovery shares a disposable probe, does not mark a task, and first prompt applies the task model', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  let marks = 0;
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
      state: {
        has: async () => false,
        mark: async () => {
          marks++;
        },
      },
    },
  );
  try {
    const [a, b] = await Promise.all([
      executor.discover({ cwd: fixture.root, signal: new AbortController().signal }),
      executor.discover({ cwd: fixture.root, signal: new AbortController().signal }),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.readiness, 'ready');
    assert.equal(a.currentModel, 'default');
    assert.deepEqual(
      a.models.map((model) => model.id),
      ['default', 'fast'],
    );
    assert.equal(protocol.connections, 1);
    assert.equal(protocol.disposals, 1);
    assert.equal(marks, 0);
    assert.equal(protocol.prompts, 0);
    assert.equal(
      (
        await executor.execute(
          { ...request('selected'), configuration: { model: 'fast' } },
          executorContext([]),
        )
      ).status,
      'completed',
    );
    assert.equal(protocol.selectedModel, 'fast');
    assert.equal(marks, 1);
    assert.equal(protocol.connections, 2);
    const before = protocol.connections;
    const status = await executor.inspectConversation({
      conversationKey: 'session-a',
      cwd: fixture.root,
    });
    assert.equal(status.currentModel, 'fast');
    assert.equal(protocol.connections, before);
    await executor.configureConversation(
      { conversationKey: 'session-a', cwd: fixture.root, configuration: { model: 'default' } },
      new AbortController().signal,
    );
    assert.equal(protocol.selectedModel, 'default');
    await assert.rejects(
      () =>
        executor.configureConversation(
          { conversationKey: 'session-a', cwd: fixture.root, configuration: { model: 'removed' } },
          new AbortController().signal,
        ),
      /unavailable/u,
    );
    assert.equal(protocol.selectedModel, 'default');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('questions retain option identity and output updates retain arrival order', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const executor = new AcpExecutor(
    { ...adapter, permissionKind: () => 'question' },
    { executable: fixture.executable },
    { createConnection: protocol.factory },
  );
  const events: unknown[] = [];
  try {
    const result = await executor.execute(request('question'), {
      ...executorContext(events),
      requestPermission: async (request) => {
        assert.equal(request.kind, 'question');
        assert.equal(request.options[0]?.optionId, 'allow_once');
        events.push({ type: 'question' });
        return { outcome: 'selected', optionId: 'allow_once' };
      },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(
      events.map((event) => (event as { type: string }).type),
      ['question', 'output_delta', 'tool_start', 'tool_result'],
    );
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function request(text: string) {
  return {
    sessionId: 'session-a',
    turnId: `turn-${text}`,
    conversationKey: 'session-a',
    cwd: process.cwd(),
    text,
  };
}

function executorContext(
  events: unknown[],
  signal = new AbortController().signal,
): PluginExecutorContext {
  return {
    signal,
    emit: (event) => events.push(event),
    requestPermission: async (request) => {
      assert.equal(request.title, 'Allow edit?');
      return { outcome: 'selected', optionId: 'allow_once' };
    },
  };
}

async function executableFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-runtime-'));
  const executable = join(root, 'agent');
  await writeFile(executable, 'fixture');
  await chmod(executable, 0o700);
  return { root, executable };
}

function chainableApp() {
  const app = {
    onNotification() {
      return app;
    },
    onRequest() {
      return app;
    },
  };
  return app as unknown as ClientApp;
}

function fakeProtocol(): {
  readonly factory: AcpConnectionFactory;
  connections: number;
  sessions: number;
  prompts: number;
  disposals: number;
  selectedModel?: string;
} {
  const fixture = {
    connections: 0,
    sessions: 0,
    prompts: 0,
    disposals: 0,
    selectedModel: undefined as string | undefined,
    factory: undefined as unknown as AcpConnectionFactory,
  };
  fixture.factory = (input) => {
    fixture.connections += 1;
    const notifications = new Map<string, (input: { params: never }) => unknown>();
    const requests = new Map<string, (input: { params: never }) => unknown>();
    const app = {
      onNotification(method: string, handler: (input: { params: never }) => unknown) {
        notifications.set(method, handler);
        return app;
      },
      onRequest(method: string, handler: (input: { params: never }) => unknown) {
        requests.set(method, handler);
        return app;
      },
    } as unknown as ClientApp;
    input.configureClient(app);
    const connection = {
      agent: {
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === methods.agent.initialize) return { protocolVersion: 1 };
          if (method === methods.agent.session.new) {
            fixture.sessions += 1;
            return {
              sessionId: 'acp-session',
              configOptions: [
                {
                  type: 'select',
                  id: 'model',
                  name: 'Model',
                  currentValue: 'default',
                  options: [
                    { value: 'default', name: 'Default' },
                    { value: 'fast', name: 'Fast' },
                  ],
                },
              ],
            };
          }
          if (method === methods.agent.session.setConfigOption) {
            fixture.selectedModel = String(params.value);
            return {
              configOptions: [
                {
                  type: 'select',
                  id: 'model',
                  name: 'Model',
                  currentValue: params.value,
                  options: [
                    { value: 'default', name: 'Default' },
                    { value: 'fast', name: 'Fast' },
                  ],
                },
              ],
            };
          }
          if (method === methods.agent.session.prompt) {
            fixture.prompts += 1;
            const text = (params.prompt as Array<{ text: string }>)[0]!.text;
            await requests.get(methods.client.session.requestPermission)?.({
              params: {
                sessionId: 'acp-session',
                toolCall: { toolCallId: `tool-${text}`, title: 'Allow edit?' },
                options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
              } as never,
            });
            notifications.get(methods.client.session.update)?.({
              params: {
                sessionId: 'acp-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `reply:${text}` },
                },
              } as never,
            });
            notifications.get(methods.client.session.update)?.({
              params: {
                sessionId: 'acp-session',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: `tool-${text}`,
                  title: 'Edit file',
                  kind: 'edit',
                  status: 'in_progress',
                },
              } as never,
            });
            notifications.get(methods.client.session.update)?.({
              params: {
                sessionId: 'acp-session',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: `tool-${text}`,
                  status: 'completed',
                  content: [{ type: 'diff', path: 'README.md', oldText: 'old', newText: 'new' }],
                },
              } as never,
            });
            return { stopReason: 'end_turn' };
          }
          throw new Error(`Unexpected ACP method: ${method}`);
        },
        notify: async () => undefined,
      },
      close: () => undefined,
    } as unknown as ClientConnection;
    return {
      connection,
      failed: new Promise<never>(() => undefined),
      dispose: async () => {
        fixture.disposals += 1;
      },
    };
  };
  return fixture;
}
