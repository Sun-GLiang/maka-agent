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
  type AcpContinuityRecord,
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

function durableState() {
  const values = new Map<string, unknown>();
  let rejectCommit = false;
  const state: AcpConversationStateStore = {
    has: async (key) => values.has(key),
    mark: async (key, cwd) => {
      values.set(key, { version: 1, cwd });
    },
    read: async (key) => structuredClone(values.get(key)),
    write: async (key, record) => {
      if (rejectCommit && record.phase === 'committed') throw new Error('Commit unavailable');
      values.set(key, structuredClone(record));
    },
  };
  return {
    state,
    values,
    rejectCommit: () => {
      rejectCommit = true;
    },
    record: (key = 'session-a') => values.get(key) as AcpContinuityRecord,
  };
}

test('durably acknowledged ACP Session resumes the same external ID without replay or session/new', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.supportsRestore = true;
  const storage = durableState();
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        state: storage.state,
        createConnection: protocol.factory,
      },
    );
  const first = make();
  try {
    assert.equal((await first.execute(request('first'), executorContext([]))).status, 'completed');
    assert.equal(storage.record().phase, 'prompt_pending');
    await first.acknowledgeExecution('session-a', 'turn-first');
    assert.equal(storage.record().phase, 'committed');
    assert.equal(storage.record().committedPrompts, 1);
    await first.dispose();
    const restored = make();
    try {
      assert.equal(
        (await restored.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
          .readiness,
        'restorable',
      );
      await restored.configureConversation(
        { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'default' } },
        new AbortController().signal,
      );
      assert.equal(protocol.sessions, 1);
      assert.equal(protocol.resumes, 1);
      assert.equal(protocol.loads, 0);
      assert.equal(
        (await restored.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
          .readiness,
        'ready',
      );
      assert.equal(
        (await restored.execute(request('second'), executorContext([]))).status,
        'completed',
      );
      await restored.acknowledgeExecution('session-a', 'turn-second');
      assert.equal(storage.record().committedPrompts, 2);
      assert.equal(protocol.sessions, 1);
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('unacknowledged prompt loads replay as restoration and exposes history gap without a second prompt', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.supportsRestore = true;
  const storage = durableState();
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        state: storage.state,
        createConnection: protocol.factory,
      },
    );
  const first = make();
  try {
    assert.equal((await first.execute(request('first'), executorContext([]))).status, 'completed');
    await first.dispose();
    const restored = make();
    const events: unknown[] = [];
    try {
      assert.equal(
        (await restored.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
          .readiness,
        'history_gap',
      );
      const result = await restored.execute(request('new-input'), executorContext(events));
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') assert.equal(result.code, 'acp_history_gap');
      assert.deepEqual(events, []);
      assert.equal(protocol.loads, 1);
      assert.equal(protocol.resumes, 0);
      assert.equal(protocol.sessions, 1);
      assert.equal(protocol.prompts, 1);
      assert.equal(storage.record().phase, 'history_gap');
      assert.equal(storage.record().gapEvidence?.replayedUserChunks, 1);
    } finally {
      await restored.dispose();
    }
    const reopened = make();
    try {
      const repeated = await reopened.execute(request('still-blocked'), executorContext(events));
      assert.equal(repeated.status, 'failed');
      if (repeated.status === 'failed') assert.equal(repeated.code, 'acp_history_gap');
      assert.equal(protocol.loads, 1);
      assert.equal(protocol.prompts, 1);
    } finally {
      await reopened.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('late restored-session updates stay quarantined while the history gap is persisted', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.supportsRestore = true;
  const storage = durableState();
  let releaseGapWrite!: () => void;
  const gapWriteBlocked = new Promise<void>((resolve) => {
    releaseGapWrite = resolve;
  });
  let gapWriteStarted!: () => void;
  const gapWriteReached = new Promise<void>((resolve) => {
    gapWriteStarted = resolve;
  });
  const state: AcpConversationStateStore = {
    ...storage.state,
    write: async (key, record) => {
      if (record.phase === 'history_gap') {
        gapWriteStarted();
        await gapWriteBlocked;
      }
      await storage.state.write!(key, record);
    },
  };
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      { state, createConnection: protocol.factory },
    );
  const first = make();
  const blockedWrite = join(process.cwd(), 'node_modules/.maka-acp-restore-write');
  try {
    assert.equal((await first.execute(request('first'), executorContext([]))).status, 'completed');
    await first.dispose();
    const restored = make();
    const events: unknown[] = [];
    try {
      const execution = restored.execute(request('unsent-new-turn'), executorContext(events));
      await gapWriteReached;
      protocol.notifyUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'LATE OLD EXTERNAL OUTPUT' },
      });
      protocol.notifyUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'late-old-tool',
        title: 'Historical tool',
      });
      assert.deepEqual(await protocol.requestPermission(), { outcome: { outcome: 'cancelled' } });
      await Promise.all([
        assert.rejects(protocol.readTextFile(join(process.cwd(), 'package.json')), {
          code: 'acp_history_gap',
        }),
        assert.rejects(protocol.writeTextFile(blockedWrite, 'must not be written'), {
          code: 'acp_history_gap',
        }),
      ]);
      releaseGapWrite();
      const result = await execution;
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') assert.equal(result.code, 'acp_history_gap');
      assert.deepEqual(events, []);
      assert.equal(protocol.prompts, 1);
      assert.equal(storage.record().phase, 'history_gap');
    } finally {
      releaseGapWrite();
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await rm(blockedWrite, { force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('failed restore permits explicit retry and never creates a replacement Session', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.supportsRestore = true;
  const storage = durableState();
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        state: storage.state,
        createConnection: protocol.factory,
      },
    );
  const first = make();
  try {
    await first.execute(request('first'), executorContext([]));
    await first.acknowledgeExecution('session-a', 'turn-first');
    await first.dispose();
    const restored = make();
    const input = {
      conversationKey: 'session-a',
      cwd: process.cwd(),
      configuration: { model: 'default' },
    };
    try {
      protocol.restoreFailure = true;
      await assert.rejects(restored.configureConversation(input, new AbortController().signal));
      assert.equal((await restored.inspectConversation(input)).readiness, 'restore_failed');
      protocol.restoreFailure = false;
      await restored.configureConversation(input, new AbortController().signal);
      assert.equal((await restored.inspectConversation(input)).readiness, 'ready');
      assert.equal(protocol.sessions, 1);
      assert.equal(protocol.resumes, 1);
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('missing restore capability, corrupted record and changed executable fail closed', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.supportsRestore = true;
  const storage = durableState();
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        state: storage.state,
        createConnection: protocol.factory,
      },
    );
  const first = make();
  try {
    await first.execute(request('first'), executorContext([]));
    await first.acknowledgeExecution('session-a', 'turn-first');
    await first.dispose();
    const input = {
      conversationKey: 'session-a',
      cwd: process.cwd(),
      configuration: { model: 'default' },
    };
    protocol.supportsRestore = false;
    const unsupported = make();
    await assert.rejects(unsupported.configureConversation(input, new AbortController().signal));
    await unsupported.dispose();
    protocol.supportsRestore = true;
    await writeFile(fixture.executable, 'changed fixture');
    const changed = make();
    await assert.rejects(changed.configureConversation(input, new AbortController().signal));
    assert.equal((await changed.inspectConversation(input)).readiness, 'restore_failed');
    await writeFile(fixture.executable, 'fixture');
    await changed.configureConversation(input, new AbortController().signal);
    assert.equal((await changed.inspectConversation(input)).readiness, 'ready');
    await changed.dispose();
    storage.values.set('session-a', { version: 2, cwd: process.cwd(), sessionId: 'acp-session' });
    const corrupt = make();
    assert.equal((await corrupt.inspectConversation(input)).readiness, 'history_only');
    assert.equal((await corrupt.execute(request('second'), executorContext([]))).status, 'failed');
    await corrupt.dispose();
    assert.equal(protocol.sessions, 1);
    assert.equal(protocol.prompts, 1);
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('failed Plugin acknowledgement leaves a visible gap', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.supportsRestore = true;
  const storage = durableState();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      state: storage.state,
      createConnection: protocol.factory,
    },
  );
  try {
    await executor.execute(request('first'), executorContext([]));
    storage.rejectCommit();
    await assert.rejects(executor.acknowledgeExecution('session-a', 'turn-first'));
    assert.equal(
      (await executor.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
        .readiness,
      'history_gap',
    );
    assert.equal(storage.record().phase, 'prompt_pending');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a terminal result abandoned before durable consumption becomes a history gap', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const storage = durableState();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { state: storage.state, createConnection: protocol.factory },
  );
  try {
    assert.equal(
      (await executor.execute(request('first'), executorContext([]))).status,
      'completed',
    );
    await executor.abandonExecution('session-a', 'turn-first');
    assert.equal(storage.record().phase, 'history_gap');
    assert.equal(
      (await executor.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
        .readiness,
      'history_gap',
    );
    const blocked = await executor.execute(request('second'), executorContext([]));
    assert.equal(blocked.status, 'failed');
    if (blocked.status === 'failed') assert.equal(blocked.code, 'acp_history_gap');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fresh configure initialization failure remains retryable', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const storage = durableState();
  let rejectRead = true;
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
      state: {
        ...storage.state,
        read: async (key) => {
          if (rejectRead) throw new Error('Storage unavailable');
          return await storage.state.read!(key);
        },
      },
    },
  );
  const input = {
    conversationKey: 'session-a',
    cwd: process.cwd(),
    configuration: { model: 'default' },
  };
  try {
    await assert.rejects(
      executor.configureConversation(input, new AbortController().signal),
      /Storage unavailable/u,
    );
    rejectRead = false;
    assert.equal((await executor.inspectConversation(input)).readiness, 'ready');
    await executor.configureConversation(input, new AbortController().signal);
    assert.equal((await executor.inspectConversation(input)).readiness, 'ready');
    assert.equal(protocol.sessions, 1);
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('concurrent restore retries share one replacement Session', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.supportsRestore = true;
  const storage = durableState();
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      { state: storage.state, createConnection: protocol.factory },
    );
  const first = make();
  try {
    await first.execute(request('first'), executorContext([]));
    await first.acknowledgeExecution('session-a', 'turn-first');
    await first.dispose();
    const restored = make();
    const input = {
      conversationKey: 'session-a',
      cwd: process.cwd(),
      configuration: { model: 'default' },
    };
    try {
      protocol.restoreFailure = true;
      await assert.rejects(restored.configureConversation(input, new AbortController().signal));
      protocol.restoreFailure = false;
      const retries = await Promise.allSettled([
        restored.configureConversation(input, new AbortController().signal),
        restored.configureConversation(input, new AbortController().signal),
      ]);
      assert.equal(retries.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(protocol.resumes, 1);
      assert.equal((await restored.inspectConversation(input)).readiness, 'ready');
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

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

test('a terminal ACP tool update retains both output text and its file diff', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
    },
  );
  const events: Array<{ type: string; text?: string; content?: { kind: string } }> = [];
  try {
    assert.equal(
      (await executor.execute(request('mixed'), executorContext(events))).status,
      'completed',
    );
    assert.equal(events.find((event) => event.type === 'tool_output_delta')?.text, '1 test failed');
    assert.equal(events.find((event) => event.type === 'tool_result')?.content?.kind, 'file_diff');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a mixed terminal update emits only text not already streamed', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
    },
  );
  const events: Array<{ type: string; text?: string }> = [];
  try {
    assert.equal(
      (await executor.execute(request('mixed-progress'), executorContext(events))).status,
      'completed',
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'tool_output_delta').map((event) => event.text),
      ['Running tests…', '\n1 test failed'],
    );
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
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

test('a continuity write failure cannot start an ACP Session and remains retryable', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  let writes = 0;
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
      state: {
        has: async () => false,
        mark: async () => {
          if (++writes === 1) throw new Error('Storage unavailable');
        },
      },
    },
  );
  try {
    assert.equal((await executor.execute(request('first'), executorContext([]))).status, 'failed');
    assert.equal(protocol.sessions, 0, 'no Agent Session was created before the durable write');
    assert.equal(
      (await executor.execute(request('retry'), executorContext([]))).status,
      'completed',
    );
    assert.equal(protocol.sessions, 1);
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an uncertain session/new response remains history-only after restart', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.sessionCreationFailure = 'once';
  const marked = new Set<string>();
  const state: AcpConversationStateStore = {
    has: async (key) => marked.has(key),
    mark: async (key) => {
      marked.add(key);
    },
  };
  const createExecutor = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        createConnection: protocol.factory,
        state,
      },
    );
  const first = createExecutor();
  try {
    assert.equal((await first.execute(request('first'), executorContext([]))).status, 'failed');
    assert.equal(marked.has('session-a'), true);
    assert.equal(protocol.sessions, 1);
    await first.dispose();
    const restarted = createExecutor();
    try {
      assert.equal(
        (await restarted.inspectConversation({ conversationKey: 'session-a', cwd: fixture.root }))
          .readiness,
        'history_only',
      );
      assert.equal(
        (await restarted.execute(request('retry'), executorContext([]))).status,
        'failed',
      );
      assert.equal(protocol.sessions, 1, 'the uncertain external Session was not replaced');
    } finally {
      await restarted.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a failed first model change cannot replace an established ACP Session after restart', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.configurationFailure = 'once';
  const marked = new Set<string>();
  const state: AcpConversationStateStore = {
    has: async (key) => marked.has(key),
    mark: async (key) => {
      marked.add(key);
    },
  };
  const createExecutor = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        createConnection: protocol.factory,
        state,
      },
    );
  const first = createExecutor();
  try {
    const input = { ...request('first'), configuration: { model: 'fast' } };
    assert.equal((await first.execute(input, executorContext([]))).status, 'failed');
    assert.equal(protocol.sessions, 1);
    assert.equal(protocol.prompts, 0);
    assert.equal(marked.has(input.conversationKey), true);
    await first.dispose();

    const restarted = createExecutor();
    try {
      const result = await restarted.execute(input, executorContext([]));
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') assert.equal(result.code, 'acp_history_only');
      assert.equal(protocol.sessions, 1, 'the established ACP Session was not replaced');
    } finally {
      await restarted.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const startupFailure of ['request', 'crash', 'abort'] as const) {
  test(`a pre-session ${startupFailure} failure is cleaned up and can be retried`, async () => {
    const fixture = await executableFixture();
    const protocol = fakeProtocol();
    const abort = new AbortController();
    let attempts = 0;
    let disposals = 0;
    let marks = 0;
    const executor = new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        state: {
          has: async () => false,
          mark: async () => {
            marks++;
          },
        },
        createConnection: (input) => {
          if (++attempts > 1) return protocol.factory(input);
          input.configureClient(chainableApp());
          let crash!: (error: Error) => void;
          const failed = new Promise<never>((_resolve, reject) => {
            crash = reject;
          });
          return {
            failed,
            dispose: async () => {
              disposals++;
            },
            connection: {
              agent: {
                request: async (method: string) => {
                  assert.equal(method, methods.agent.initialize);
                  if (startupFailure === 'abort') {
                    abort.abort(new DOMException('Stopped during startup', 'AbortError'));
                    throw abort.signal.reason;
                  }
                  if (startupFailure === 'crash') {
                    crash(new Error('Process exited before initialization'));
                    return await new Promise(() => {});
                  }
                  throw new Error('Temporary initialization failure');
                },
              },
            } as unknown as ClientConnection,
          };
        },
      },
    );
    try {
      const first = await executor.execute(request('first'), executorContext([], abort.signal));
      assert.equal(first.status, startupFailure === 'abort' ? 'cancelled' : 'failed');
      assert.equal(disposals, 1);
      assert.equal(marks, 0, 'no external session was established');
      assert.equal(
        (await executor.inspectConversation({ conversationKey: 'session-a', cwd: fixture.root }))
          .readiness,
        'ready',
      );
      assert.equal(
        (await executor.execute(request('retry'), executorContext([]))).status,
        'completed',
      );
      assert.equal(attempts, 2);
      assert.equal(protocol.sessions, 1);
      assert.equal(protocol.prompts, 1);
      assert.equal(marks, 1);
    } finally {
      await executor.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

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
    const storage = durableState();
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
      { createConnection: factory, state: storage.state },
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
      assert.equal(storage.record().phase, 'prompt_pending');
      await executor.acknowledgeExecution('session-a', 'turn-cancel');
      const uncertain = ['request_error', 'process_crash'].includes(stopReason);
      assert.equal(storage.record().phase, uncertain ? 'prompt_pending' : 'committed');
      await executor.disposeConversation('session-a');
      assert.equal(
        (await executor.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
          .readiness,
        uncertain ? 'restore_failed' : 'restorable',
      );
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
      cwd: process.cwd(),
    });
    assert.equal(status.currentModel, 'fast');
    assert.equal(protocol.connections, before);
    await executor.configureConversation(
      { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'default' } },
      new AbortController().signal,
    );
    assert.equal(protocol.selectedModel, 'default');
    await assert.rejects(
      () =>
        executor.configureConversation(
          { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'removed' } },
          new AbortController().signal,
        ),
      /unavailable/u,
    );
    assert.equal(protocol.selectedModel, 'default');
    assert.equal(
      (await executor.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
        .readiness,
      'ready',
    );
    assert.equal(
      (await executor.execute(request('after-invalid-model'), executorContext([]))).status,
      'completed',
    );
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a catalog caller can cancel without owning or leaking the shared probe', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.holdInitialize = true;
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: protocol.factory },
  );
  const abort = new AbortController();
  try {
    const discovery = executor.discover({ cwd: fixture.root, signal: abort.signal });
    for (let attempt = 0; attempt < 20 && protocol.connections === 0; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(protocol.connections, 1);
    abort.abort(new Error('Catalog caller cancelled'));
    await assert.rejects(discovery, /caller cancelled/u);
    assert.equal(protocol.disposals, 0, 'caller cancellation must not own the shared probe');
  } finally {
    await executor.dispose();
    assert.equal(protocol.disposals, 1, 'provider disposal must abort and drain the shared probe');
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refresh redirects callers awaiting the superseded catalog probe', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.holdInitialize = true;
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: protocol.factory },
  );
  try {
    const waiting = executor.discover({
      cwd: fixture.root,
      signal: new AbortController().signal,
    });
    for (let attempt = 0; attempt < 20 && protocol.connections === 0; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(protocol.connections, 1);
    protocol.holdInitialize = false;
    const refreshed = executor.discover({
      cwd: fixture.root,
      signal: new AbortController().signal,
      refresh: true,
    });
    const [waitingResult, refreshedResult] = await Promise.all([waiting, refreshed]);
    assert.equal(waitingResult.readiness, 'ready');
    assert.deepEqual(waitingResult, refreshedResult);
    assert.equal(protocol.connections, 2);
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('ACP modes remain distinct from models across discovery, prompt, idle change and restoration', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.hasMode = true;
  protocol.supportsRestore = true;
  const storage = durableState();
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      {
        createConnection: protocol.factory,
        state: storage.state,
      },
    );
  const first = make();
  try {
    const catalog = await first.discover({
      cwd: fixture.root,
      signal: new AbortController().signal,
    });
    assert.deepEqual(
      catalog.modes?.map((mode) => mode.id),
      ['ask', 'auto'],
    );
    assert.equal(catalog.currentMode, 'ask');
    assert.equal(catalog.supportsModeChange, true);
    const requestWithMode = { ...request('first'), configuration: { model: 'fast', mode: 'auto' } };
    assert.equal((await first.execute(requestWithMode, executorContext([]))).status, 'completed');
    assert.deepEqual(protocol.promptModels, ['fast']);
    assert.deepEqual(protocol.promptModes, ['auto']);
    assert.equal(storage.record().confirmedMode, 'auto');
    await first.acknowledgeExecution('session-a', 'turn-first');
    await first.configureConversation(
      { conversationKey: 'session-a', cwd: process.cwd(), configuration: { mode: 'ask' } },
      new AbortController().signal,
    );
    assert.equal(protocol.selectedModel, 'fast');
    assert.equal(protocol.selectedMode, 'ask');
    assert.equal(storage.record().confirmedMode, 'ask');
    await assert.rejects(
      first.configureConversation(
        { conversationKey: 'session-a', cwd: process.cwd(), configuration: { mode: 'invented' } },
        new AbortController().signal,
      ),
    );
    assert.equal(protocol.selectedMode, 'ask');
    await first.dispose();
    protocol.selectedModel = 'default';
    protocol.selectedMode = 'auto';
    const restored = make();
    try {
      const saved = await restored.inspectConversation({
        conversationKey: 'session-a',
        cwd: process.cwd(),
        configuration: { model: 'fast', mode: 'ask' },
      });
      assert.equal(saved.readiness, 'restorable');
      assert.deepEqual(
        saved.models.map((model) => model.id),
        ['fast'],
      );
      assert.deepEqual(
        saved.modes?.map((mode) => mode.id),
        ['ask'],
      );
      await restored.configureConversation(
        {
          conversationKey: 'session-a',
          cwd: process.cwd(),
          configuration: { model: 'fast', mode: 'ask' },
        },
        new AbortController().signal,
      );
      assert.equal(
        (await restored.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
          .currentMode,
        'ask',
      );
      assert.equal(protocol.selectedModel, 'fast');
      assert.equal(protocol.selectedMode, 'ask');
      assert.equal(
        protocol.sessions,
        2,
        'one catalog probe and one retained Session; restore does not create another',
      );
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('merged configuration preserves the model when a mode change opens a fresh Session', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.hasMode = true;
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: protocol.factory },
  );
  try {
    assert.deepEqual(
      await executor.configureConversation(
        {
          conversationKey: 'session-a',
          cwd: process.cwd(),
          configuration: { model: 'fast', mode: 'auto' },
        },
        new AbortController().signal,
      ),
      { model: 'fast', mode: 'auto' },
    );
    assert.equal(protocol.selectedModel, 'fast');
    assert.equal(protocol.selectedMode, 'auto');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a fresh Session selects a model before validating a mode unavailable on the launch model', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.hasMode = true;
  protocol.dropModeForModel = 'default';
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable, model: 'default' },
    { createConnection: protocol.factory },
  );
  try {
    assert.deepEqual(
      await executor.configureConversation(
        {
          conversationKey: 'session-a',
          cwd: process.cwd(),
          configuration: { model: 'fast', mode: 'auto' },
        },
        new AbortController().signal,
      ),
      { model: 'fast', mode: 'auto' },
    );
    assert.equal(protocol.sessions, 1);
    assert.equal(protocol.selectedModel, 'fast');
    assert.equal(protocol.selectedMode, 'auto');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an idle model drift does not block restoring the saved mode with a model change', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.hasMode = true;
  protocol.dropModeForModel = 'default';
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: protocol.factory },
  );
  try {
    await executor.configureConversation(
      {
        conversationKey: 'session-a',
        cwd: process.cwd(),
        configuration: { model: 'fast', mode: 'auto' },
      },
      new AbortController().signal,
    );
    protocol.notifyConfiguration('default');
    assert.deepEqual(
      await executor.configureConversation(
        {
          conversationKey: 'session-a',
          cwd: process.cwd(),
          configuration: { model: 'fast', mode: 'auto' },
        },
        new AbortController().signal,
      ),
      { model: 'fast', mode: 'auto' },
    );
    assert.equal(protocol.sessions, 1);
    assert.equal(protocol.selectedModel, 'fast');
    assert.equal(protocol.selectedMode, 'auto');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an invalid mode after changing models rolls the Agent back to its prior selection', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.hasMode = true;
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: protocol.factory },
  );
  try {
    await executor.configureConversation(
      { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'default' } },
      new AbortController().signal,
    );
    await assert.rejects(
      executor.configureConversation(
        {
          conversationKey: 'session-a',
          cwd: process.cwd(),
          configuration: { model: 'fast', mode: 'invented' },
        },
        new AbortController().signal,
      ),
      { code: 'acp_config_invalid' },
    );
    assert.equal(protocol.selectedModel, 'default');
    assert.equal(protocol.selectedMode, 'ask');
    assert.equal(
      (await executor.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
        .readiness,
      'ready',
    );
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('confirmed configuration clears a mode removed by a model change', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.hasMode = true;
  protocol.supportsRestore = true;
  const storage = durableState();
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      { createConnection: protocol.factory, state: storage.state },
    );
  const first = make();
  try {
    assert.equal(
      (
        await first.execute(
          { ...request('first'), configuration: { model: 'default', mode: 'ask' } },
          executorContext([]),
        )
      ).status,
      'completed',
    );
    await first.acknowledgeExecution('session-a', 'turn-first');
    protocol.dropModeForModel = 'fast';
    assert.deepEqual(
      await first.configureConversation(
        { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'fast' } },
        new AbortController().signal,
      ),
      { model: 'fast' },
    );
    assert.equal(storage.record().confirmedModel, 'fast');
    assert.equal(storage.record().confirmedMode, undefined);
    await first.dispose();

    const restored = make();
    try {
      assert.deepEqual(
        await restored.configureConversation(
          { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'fast' } },
          new AbortController().signal,
        ),
        { model: 'fast' },
      );
      assert.equal(
        (
          await restored.execute(
            { ...request('second'), configuration: { model: 'fast' } },
            executorContext([]),
          )
        ).status,
        'completed',
      );
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a fresh Session confirms a model-only change that removes the saved mode', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.hasMode = true;
  protocol.dropModeForModel = 'fast';
  const storage = durableState();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: protocol.factory, state: storage.state },
  );
  try {
    assert.deepEqual(
      await executor.configureConversation(
        {
          conversationKey: 'session-a',
          cwd: process.cwd(),
          configuration: { model: 'fast', mode: 'ask' },
        },
        new AbortController().signal,
      ),
      { model: 'fast' },
    );
    assert.equal(protocol.selectedModel, 'fast');
    assert.equal(storage.record().confirmedModel, 'fast');
    assert.equal(storage.record().confirmedMode, undefined);
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('a failed second configuration option restores both model and mode', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.hasMode = true;
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: protocol.factory },
  );
  try {
    assert.equal(
      (await executor.execute(request('first'), executorContext([]))).status,
      'completed',
    );
    protocol.configurationFailure = 'mode_once';
    await assert.rejects(
      executor.configureConversation(
        {
          conversationKey: 'session-a',
          cwd: process.cwd(),
          configuration: { model: 'fast', mode: 'auto' },
        },
        new AbortController().signal,
      ),
    );
    assert.equal(protocol.selectedModel, 'default');
    assert.equal(protocol.selectedMode, 'ask');
    const state = await executor.inspectConversation({
      conversationKey: 'session-a',
      cwd: process.cwd(),
    });
    assert.equal(state.readiness, 'ready');
    assert.equal(state.currentModel, 'default');
    assert.equal(state.currentMode, 'ask');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('late configuration notifications are reasserted before the next change', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
    },
  );
  try {
    assert.equal(
      (await executor.execute(request('first'), executorContext([]))).status,
      'completed',
    );
    await executor.configureConversation(
      { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'fast' } },
      new AbortController().signal,
    );
    protocol.notifyConfiguration('default');
    assert.equal(
      (await executor.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
        .currentModel,
      'default',
    );
    await executor.configureConversation(
      { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'fast' } },
      new AbortController().signal,
    );
    assert.equal(protocol.selectedModel, 'fast');
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('catalog reuse is scoped to cwd and refresh only replaces that scope', async () => {
  const fixture = await executableFixture();
  const other = await mkdtemp(join(tmpdir(), 'maka-acp-catalog-other-'));
  const protocol = fakeProtocol();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    {
      createConnection: protocol.factory,
    },
  );
  const signal = new AbortController().signal;
  try {
    await Promise.all([
      executor.discover({ cwd: fixture.root, signal }),
      executor.discover({ cwd: fixture.root, signal }),
    ]);
    assert.equal(protocol.connections, 1);
    await executor.discover({ cwd: other, signal });
    assert.equal(protocol.connections, 2);
    await executor.discover({ cwd: fixture.root, signal });
    assert.equal(protocol.connections, 2);
    await executor.discover({ cwd: fixture.root, signal, refresh: true });
    assert.equal(protocol.connections, 3);
    await executor.discover({ cwd: other, signal });
    assert.equal(protocol.connections, 3, 'refreshing one cwd must retain another cwd cache');
    executor.invalidateCatalog();
    await executor.discover({ cwd: other, signal });
    assert.equal(protocol.connections, 4);
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

for (const failure of ['response_lost', 'timeout'] as const) {
  test(`an applied model change with ${failure} prevents prompts using stale configuration`, async () => {
    const fixture = await executableFixture();
    const protocol = fakeProtocol();
    const executor = new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      { createConnection: protocol.factory },
    );
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const selectedRequest = { ...request('first'), configuration: { model: 'default' } };
      assert.equal(
        (await executor.execute(selectedRequest, executorContext([]))).status,
        'completed',
      );
      protocol.configurationFailure = failure;
      timeout = setTimeout(() => abort.abort(new DOMException('Timed out', 'TimeoutError')), 50);
      await assert.rejects(
        executor.configureConversation(
          { conversationKey: 'session-a', cwd: process.cwd(), configuration: { model: 'fast' } },
          abort.signal,
        ),
      );
      // The external mutation happened even though no matching confirmation arrived.
      assert.equal(protocol.selectedModel, failure === 'timeout' ? 'fast' : 'default');
      assert.equal(
        (await executor.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
          .readiness,
        'history_only',
      );
      assert.equal((await executor.execute(selectedRequest, executorContext([]))).status, 'failed');
      assert.deepEqual(protocol.promptModels, ['default']);
      assert.equal(protocol.connections, 1);
      assert.equal(protocol.disposals, 1);
    } finally {
      clearTimeout(timeout);
      await executor.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

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
      [
        'question',
        'output_delta',
        'tool_start',
        'tool_output_delta',
        'tool_output_delta',
        'tool_result',
      ],
    );
    assert.deepEqual(
      events
        .filter((event) => (event as { type: string }).type === 'tool_output_delta')
        .map((event) => (event as { text: string }).text),
      ['Running', ' tests…'],
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
  selectedMode?: string;
  hasMode: boolean;
  dropModeForModel?: string;
  notifyDuringPromptModel?: string;
  holdInitialize: boolean;
  configurationFailure?: 'response_lost' | 'unconfirmed' | 'timeout' | 'once' | 'mode_once';
  sessionCreationFailure?: 'once';
  promptModels: string[];
  promptModes: Array<string | undefined>;
  supportsRestore: boolean;
  restoreFailure?: boolean;
  resumes: number;
  loads: number;
  notifyUpdate(update: unknown): void;
  requestPermission(): Promise<unknown>;
  readTextFile(path: string): Promise<unknown>;
  writeTextFile(path: string, content: string): Promise<unknown>;
  notifyConfiguration(model: string): void;
} {
  const fixture = {
    connections: 0,
    sessions: 0,
    prompts: 0,
    disposals: 0,
    selectedModel: undefined as string | undefined,
    selectedMode: 'ask',
    hasMode: false,
    dropModeForModel: undefined as string | undefined,
    notifyDuringPromptModel: undefined as string | undefined,
    holdInitialize: false,
    configurationFailure: undefined as
      | 'response_lost'
      | 'unconfirmed'
      | 'timeout'
      | 'once'
      | 'mode_once'
      | undefined,
    sessionCreationFailure: undefined as 'once' | undefined,
    promptModels: [] as string[],
    promptModes: [] as Array<string | undefined>,
    supportsRestore: false,
    restoreFailure: false,
    resumes: 0,
    loads: 0,
    notifyUpdate: (_update: unknown): void => {},
    requestPermission: async (): Promise<unknown> => undefined,
    readTextFile: async (_path: string): Promise<unknown> => undefined,
    writeTextFile: async (_path: string, _content: string): Promise<unknown> => undefined,
    notifyConfiguration: (_model: string): void => {},
    factory: undefined as unknown as AcpConnectionFactory,
  };
  const configOptions = () => [
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      currentValue: fixture.selectedModel ?? 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'fast', name: 'Fast' },
      ],
    },
    ...(fixture.hasMode &&
    (fixture.dropModeForModel === undefined ||
      (fixture.selectedModel ?? 'default') !== fixture.dropModeForModel)
      ? [
          {
            type: 'select',
            id: 'mode',
            category: 'mode',
            name: 'Mode',
            currentValue: fixture.selectedMode,
            options: [
              { value: 'ask', name: 'Ask before edits' },
              { value: 'auto', name: 'Autonomous' },
            ],
          },
        ]
      : []),
  ];
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
    fixture.notifyUpdate = (update) => {
      notifications.get(methods.client.session.update)?.({
        params: { sessionId: 'acp-session', update } as never,
      });
    };
    fixture.requestPermission = async () =>
      await requests.get(methods.client.session.requestPermission)?.({
        params: {
          sessionId: 'acp-session',
          toolCall: { toolCallId: 'late-old-tool', title: 'Allow edit?' },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        } as never,
      });
    fixture.readTextFile = async (path) =>
      await requests.get(methods.client.fs.readTextFile)?.({
        params: { sessionId: 'acp-session', path } as never,
      });
    fixture.writeTextFile = async (path, content) =>
      await requests.get(methods.client.fs.writeTextFile)?.({
        params: { sessionId: 'acp-session', path, content } as never,
      });
    fixture.notifyConfiguration = (model) => {
      fixture.selectedModel = model;
      notifications.get(methods.client.session.update)?.({
        params: {
          sessionId: 'acp-session',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [
              {
                type: 'select',
                id: 'model',
                name: 'Model',
                currentValue: model,
                options: [
                  { value: 'default', name: 'Default' },
                  { value: 'fast', name: 'Fast' },
                ],
              },
            ],
          },
        } as never,
      });
    };
    const connection = {
      agent: {
        request: async (
          method: string,
          params: Record<string, unknown>,
          options?: { cancellationSignal?: AbortSignal },
        ) => {
          if (method === methods.agent.initialize) {
            if (fixture.holdInitialize) {
              const signal = options!.cancellationSignal!;
              signal.throwIfAborted();
              await new Promise((_, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              );
            }
            return {
              protocolVersion: 1,
              agentCapabilities: fixture.supportsRestore
                ? { loadSession: true, sessionCapabilities: { resume: {} } }
                : {},
            };
          }
          if (method === methods.agent.session.resume || method === methods.agent.session.load) {
            assert.equal(params.sessionId, 'acp-session');
            assert.equal(params.cwd, process.cwd());
            if (fixture.restoreFailure) throw new Error('Session unavailable');
            if (method === methods.agent.session.resume) fixture.resumes += 1;
            else {
              fixture.loads += 1;
              for (const update of [
                { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first' } },
                { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay' } },
                { sessionUpdate: 'tool_call', toolCallId: 'replay-tool', title: 'Historical tool' },
              ])
                notifications.get(methods.client.session.update)?.({
                  params: { sessionId: 'acp-session', update } as never,
                });
            }
            return { configOptions: configOptions() };
          }
          if (method === methods.agent.session.new) {
            fixture.sessions += 1;
            if (fixture.sessionCreationFailure === 'once') {
              fixture.sessionCreationFailure = undefined;
              throw new Error('Session creation response was lost');
            }
            return { sessionId: 'acp-session', configOptions: configOptions() };
          }
          if (method === methods.agent.session.setConfigOption) {
            if (params.configId === 'mode') fixture.selectedMode = String(params.value);
            else fixture.selectedModel = String(params.value);
            if (
              fixture.configurationFailure === 'once' ||
              (fixture.configurationFailure === 'mode_once' && params.configId === 'mode')
            ) {
              fixture.configurationFailure = undefined;
              throw new Error('Transient rejection after mutation');
            }
            if (fixture.configurationFailure === 'response_lost')
              throw new Error('Configuration response lost after applying the model');
            if (fixture.configurationFailure === 'timeout') {
              const signal = options!.cancellationSignal!;
              signal.throwIfAborted();
              await new Promise((_, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              );
            }
            return {
              configOptions:
                fixture.configurationFailure === 'unconfirmed'
                  ? configOptions().map((option) =>
                      option.id === params.configId
                        ? { ...option, currentValue: option.id === 'mode' ? 'ask' : 'default' }
                        : option,
                    )
                  : configOptions(),
            };
          }
          if (method === methods.agent.session.prompt) {
            fixture.prompts += 1;
            fixture.promptModels.push(fixture.selectedModel ?? 'default');
            fixture.promptModes.push(fixture.selectedMode);
            if (fixture.notifyDuringPromptModel)
              fixture.notifyConfiguration(fixture.notifyDuringPromptModel);
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
                  ...(text === 'question'
                    ? {
                        content: [{ type: 'content', content: { type: 'text', text: 'Running' } }],
                      }
                    : {}),
                },
              } as never,
            });
            if (text === 'question' || text === 'mixed-progress') {
              for (const output of ['Running tests…', 'Running tests…'])
                notifications.get(methods.client.session.update)?.({
                  params: {
                    sessionId: 'acp-session',
                    update: {
                      sessionUpdate: 'tool_call_update',
                      toolCallId: `tool-${text}`,
                      status: 'in_progress',
                      content: [{ type: 'content', content: { type: 'text', text: output } }],
                    },
                  } as never,
                });
            }
            notifications.get(methods.client.session.update)?.({
              params: {
                sessionId: 'acp-session',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: `tool-${text}`,
                  status: 'completed',
                  content: [
                    { type: 'diff', path: 'README.md', oldText: 'old', newText: 'new' },
                    ...(text === 'mixed' || text === 'mixed-progress'
                      ? [
                          {
                            type: 'content',
                            content: {
                              type: 'text',
                              text:
                                text === 'mixed'
                                  ? '1 test failed'
                                  : 'Running tests…\n1 test failed',
                            },
                          },
                        ]
                      : []),
                  ],
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

for (const failure of ['once', 'unconfirmed'] as const)
  test(`confirmed rollback preserves the previous model and permits retry after ${failure}`, async () => {
    const fixture = await executableFixture();
    const protocol = fakeProtocol();
    const executor = new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      { createConnection: protocol.factory },
    );
    const input = {
      conversationKey: 'session-a',
      cwd: process.cwd(),
      configuration: { model: 'fast' },
    };
    try {
      await executor.execute(
        { ...request('first'), configuration: { model: 'default' } },
        executorContext([]),
      );
      protocol.configurationFailure = failure;
      await assert.rejects(executor.configureConversation(input, new AbortController().signal));
      assert.equal(protocol.selectedModel, 'default');
      const state = await executor.inspectConversation(input);
      assert.equal(state.currentModel, 'default');
      assert.equal(state.readiness, 'ready');
      protocol.configurationFailure = undefined;
      await executor.configureConversation(input, new AbortController().signal);
      assert.equal((await executor.inspectConversation(input)).currentModel, 'fast');
      assert.equal(protocol.disposals, 0);
    } finally {
      await executor.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

test('idle Agent configuration notifications cannot diverge from the Session configuration', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  const storage = durableState();
  const executor = new AcpExecutor(
    adapter,
    { executable: fixture.executable },
    { createConnection: protocol.factory, state: storage.state },
  );
  try {
    await executor.execute(
      { ...request('first'), configuration: { model: 'default' } },
      executorContext([]),
    );
    await executor.acknowledgeExecution('session-a', 'turn-first');
    protocol.notifyConfiguration('fast');
    protocol.notifyConfiguration('fast');
    assert.equal(
      (await executor.inspectConversation({ conversationKey: 'session-a', cwd: process.cwd() }))
        .currentModel,
      'fast',
    );
    assert.equal(storage.record().confirmedModel, 'default');
    assert.equal(
      (
        await executor.execute(
          { ...request('second'), configuration: { model: 'default' } },
          executorContext([]),
        )
      ).status,
      'completed',
    );
    assert.deepEqual(protocol.promptModels, ['default', 'default']);
  } finally {
    await executor.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an Agent configuration update during a prompt cannot replace the saved selection', async () => {
  const fixture = await executableFixture();
  const protocol = fakeProtocol();
  protocol.supportsRestore = true;
  const storage = durableState();
  const make = () =>
    new AcpExecutor(
      adapter,
      { executable: fixture.executable },
      { createConnection: protocol.factory, state: storage.state },
    );
  const first = make();
  try {
    protocol.notifyDuringPromptModel = 'fast';
    assert.equal(
      (
        await first.execute(
          { ...request('first'), configuration: { model: 'default' } },
          executorContext([]),
        )
      ).status,
      'completed',
    );
    assert.equal(storage.record().confirmedModel, 'default');
    await first.acknowledgeExecution('session-a', 'turn-first');
    assert.equal(storage.record().confirmedModel, 'default');
    await first.dispose();

    protocol.notifyDuringPromptModel = undefined;
    const restored = make();
    try {
      assert.equal(
        (
          await restored.execute(
            { ...request('second'), configuration: { model: 'default' } },
            executorContext([]),
          )
        ).status,
        'completed',
      );
      assert.deepEqual(protocol.promptModels, ['default', 'default']);
      assert.equal(storage.record().confirmedModel, 'default');
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
