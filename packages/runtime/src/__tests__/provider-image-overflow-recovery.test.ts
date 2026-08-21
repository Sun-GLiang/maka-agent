import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ModelMessage } from '../model-protocol.js';
import {
  collectHistoricalImageToolResults,
  omitHistoricalImageToolResults,
} from '../provider-image-overflow-recovery.js';

function imageResultEvent(toolCallId: string, relativePath: string): RuntimeEvent {
  return {
    id: `event-${toolCallId}`,
    sessionId: 'session-1',
    invocationId: 'run-1',
    runId: 'run-1',
    turnId: 'turn-0',
    seq: 1,
    ts: 1,
    role: 'tool',
    author: 'tool',
    partial: false,
    content: {
      kind: 'function_response',
      id: toolCallId,
      name: 'Read',
      result: {
        kind: 'image',
        mimeType: 'image/png',
        ref: { kind: 'session_file', sessionId: 'session-1', relativePath },
      },
      isError: false,
    },
  } as unknown as RuntimeEvent;
}

function imageFile(data: string): Record<string, unknown> {
  return {
    type: 'file',
    data: { type: 'data', data },
    mediaType: 'image/png',
  };
}

function toolImageMessage(toolCallId: string, data: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName: 'Read',
        output: {
          type: 'content',
          value: [{ type: 'text', text: 'Image read successfully.' }, imageFile(data)],
        },
      },
    ],
  } as ModelMessage;
}

function prompt(messages: readonly ModelMessage[]): string {
  return JSON.stringify(messages);
}

describe('provider image overflow recovery projection', () => {
  test('omits only eligible historical tool-result images and names their artifact', () => {
    const priorEvents = [imageResultEvent('prior-image-call', 'screenshots/screenshot.png')];
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'compare these' }, imageFile('USER_IMAGE')],
      } as unknown as ModelMessage,
      toolImageMessage('prior-image-call', 'PRIOR_IMAGE'),
      toolImageMessage('new-image-call', 'NEW_IMAGE'),
    ];

    const eligible = collectHistoricalImageToolResults(priorEvents);
    const result = omitHistoricalImageToolResults(messages, eligible);
    const rendered = prompt(result.messages);

    assert.deepEqual([...result.omittedToolCallIds], ['prior-image-call']);
    assert.equal(result.omittedParts, 1);
    assert.equal(rendered.includes('USER_IMAGE'), true);
    assert.equal(rendered.includes('NEW_IMAGE'), true);
    assert.equal(rendered.includes('PRIOR_IMAGE'), false);
    assert.match(rendered, /screenshots\/screenshot\.png/);
    assert.match(rendered, /repeat the preceding Read tool call/i);
  });

  test('preserves the tool-result envelope and siblings without mutating its input', () => {
    const messages = [toolImageMessage('prior-image-call', 'PRIOR_IMAGE')];
    const original = structuredClone(messages);
    const eligible = collectHistoricalImageToolResults([
      imageResultEvent('prior-image-call', 'screenshot.png'),
    ]);

    const first = omitHistoricalImageToolResults(messages, eligible);
    const second = omitHistoricalImageToolResults(first.messages, eligible);
    const firstJson = prompt(first.messages);

    assert.deepEqual(messages, original);
    assert.match(firstJson, /"type":"tool-result"/);
    assert.match(firstJson, /Image read successfully/);
    assert.equal(second.omittedParts, 0);
    assert.deepEqual(second.messages, first.messages);
  });
});
