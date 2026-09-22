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
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpExecutor, type AcpAgentAdapter } from '../index.js';
import type {
  PluginExecutorContext,
  PluginExecutorOutputEvent,
} from '@maka/runtime/plugin-executor-service';

// This fixture exercises the actual SDK, stdio transport, OS processes and callbacks.
const program = String.raw`
const {createInterface}=require('node:readline');
const {spawn}=require('node:child_process');
const pending=new Map(); let seq=0, turn=0, cwd, promptId;
const send=(value)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const respond=(id,result)=>send({id,result});
const update=(update)=>send({method:'session/update',params:{sessionId:'fixture',update}});
const text=(text)=>update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
const call=(method,params)=>new Promise(resolve=>{const id='client-'+(++seq);pending.set(id,resolve);send({id,method,params});});
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
 if(m.method==='initialize')return respond(m.id,{protocolVersion:1});
 if(m.method==='session/new'){cwd=m.params.cwd;return respond(m.id,{sessionId:'fixture',configOptions:[]});}
 if(m.method==='session/cancel'){if(promptId!==undefined){respond(promptId,{stopReason:'cancelled'});promptId=undefined;}return;}
 if(m.method!=='session/prompt')return;
 const value=m.params.prompt[0].text;
 if(value==='crash'){process.exit(3);return;}
 if(value==='ignore-cancel'){text('waiting');return;}
 if(value==='wait'){promptId=m.id;text('waiting');return;}
 if(value==='helper'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});text(String(child.pid));respond(m.id,{stopReason:'end_turn'});return;}
 if(value==='files'){
  const write=await call('fs/write_text_file',{sessionId:'fixture',path:cwd+'/created.txt',content:'fixture'});
  const read=await call('fs/read_text_file',{sessionId:'fixture',path:cwd+'/created.txt'});
  const escape=await call('fs/read_text_file',{sessionId:'fixture',path:cwd+'/escape.txt'});
  text(JSON.stringify({write:!!write.result,read:read.result?.content,escape:!!escape.error}));
 }else{
  const result=await call('session/request_permission',{sessionId:'fixture',toolCall:{toolCallId:'interaction_fixture',title:'Alpha or beta?'},options:[{optionId:'alpha-id',name:'Alpha',kind:'allow_once'},{optionId:'beta-id',name:'Beta',kind:'allow_once'}]});
  text(JSON.stringify({pid:process.pid,turn:++turn,choice:result.result.outcome.optionId}));
 }
 respond(m.id,{stopReason:'end_turn'});
});
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-process-'));
  const script = join(root, 'agent.cjs');
  await writeFile(script, program);
  const adapter: AcpAgentAdapter = {
    id: 'stdio-fixture',
    displayName: 'Fixture',
    configure: () => ({ launch: { executable: process.execPath, args: [script] } }),
    permissionKind: () => 'question',
  };
  const marked = new Set<string>();
  const executor = new AcpExecutor(
    adapter,
    {},
    {
      state: {
        has: async (key) => marked.has(key),
        mark: async (key) => {
          marked.add(key);
        },
      },
    },
  );
  const request = (text: string) => ({
    sessionId: 'task',
    conversationKey: 'task',
    turnId: text,
    text,
    cwd: root,
  });
  const context = (
    signal = new AbortController().signal,
    emit: (event: PluginExecutorOutputEvent) => void = () => {},
  ): PluginExecutorContext => ({
    signal,
    emit,
    requestPermission: async (request) => {
      assert.equal(request.kind, 'question');
      return { outcome: 'selected', optionId: 'beta-id' };
    },
  });
  return {
    root,
    executor,
    request,
    context,
    dispose: async () => {
      await executor.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('real stdio retains a conversation and returns original question option ids', async () => {
  const f = await fixture();
  try {
    const first = await f.executor.execute(f.request('one'), f.context());
    const second = await f.executor.execute(f.request('two'), f.context());
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    if (first.status !== 'completed' || second.status !== 'completed')
      throw new Error('Expected completion');
    const a = JSON.parse(first.text),
      b = JSON.parse(second.text);
    assert.equal(a.pid, b.pid);
    assert.equal(b.turn, 2);
    assert.equal(b.choice, 'beta-id');
  } finally {
    await f.dispose();
  }
});

test('real filesystem callbacks reject a symlink escape and permit workspace files', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'maka-acp-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(join(outside, 'secret.txt'), join(f.root, 'escape.txt'));
    const result = await f.executor.execute(f.request('files'), f.context());
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('Expected completion');
    assert.deepEqual(JSON.parse(result.text), { write: true, read: 'fixture', escape: true });
    assert.equal(await readFile(join(f.root, 'created.txt'), 'utf8'), 'fixture');
  } finally {
    await f.dispose();
    await rm(outside, { recursive: true, force: true });
  }
});

test('real cancellation settles before follow-up; crash makes the task history-only', async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const result = await f.executor.execute(
      f.request('wait'),
      f.context(abort.signal, () => abort.abort()),
    );
    assert.equal(result.status, 'cancelled');
    assert.equal((await f.executor.execute(f.request('after'), f.context())).status, 'completed');
    assert.equal((await f.executor.execute(f.request('crash'), f.context())).status, 'failed');
    assert.equal(
      (await f.executor.inspectConversation({ conversationKey: 'task', cwd: f.root })).readiness,
      'history_only',
    );
    assert.equal(
      (await f.executor.execute(f.request('never-replay'), f.context())).status,
      'failed',
    );
  } finally {
    await f.dispose();
  }
});

test('disposing a real retained process also terminates its helper', {
  skip: process.platform === 'win32',
}, async () => {
  const f = await fixture();
  try {
    const result = await f.executor.execute(f.request('helper'), f.context());
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('Expected completion');
    const pid = Number(result.text);
    assert.ok(pid > 0);
    await f.executor.dispose();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await f.dispose();
  }
});

test('an unresponsive cancel is bounded, records timeout and loses the process', async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const result = await f.executor.execute(
      f.request('ignore-cancel'),
      f.context(abort.signal, () => abort.abort()),
    );
    assert.deepEqual(result, { status: 'cancelled', reason: 'timeout' });
    assert.equal(
      (await f.executor.inspectConversation({ conversationKey: 'task', cwd: f.root })).readiness,
      'history_only',
    );
  } finally {
    await f.dispose();
  }
});

test('retiring one conversation cleans its helper after the parent has crashed', {
  skip: process.platform === 'win32',
}, async () => {
  const f = await fixture();
  try {
    const result = await f.executor.execute(f.request('helper'), f.context());
    if (result.status !== 'completed') throw new Error('Expected helper');
    const pid = Number(result.text);
    await f.executor.execute(f.request('crash'), f.context());
    await f.executor.disposeConversation('task');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await f.dispose();
  }
});
