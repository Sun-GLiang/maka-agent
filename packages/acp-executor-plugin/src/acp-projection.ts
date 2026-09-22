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

import type { ToolCall, ToolCallContent } from '@agentclientprotocol/sdk';
import type {
  PluginExecutorContext,
  PluginExecutorRequest,
  PluginExecutorToolResultContent,
} from '@maka/runtime/plugin-executor-service';

const MAX_EVENT_TEXT = 8_192;
const MAX_TOOL_RESULT_DIFF = 1024 * 1024;

export function promptText(request: Readonly<PluginExecutorRequest>): string {
  const sections = [request.text];
  if (request.instructions) sections.push(`Agent instructions:\n${request.instructions}`);
  for (const quote of request.quotes ?? []) sections.push(`Quoted context:\n${quote.text}`);
  for (const reference of request.directoryReferences ?? [])
    sections.push(`Project directory reference: ${reference.path}`);
  return sections.filter(Boolean).join('\n\n');
}

export function emitText(
  context: PluginExecutorContext,
  type: 'output_delta' | 'thinking_delta' | 'tool_progress',
  text: string,
  toolCallId?: string,
): void {
  const safeText = text.replaceAll('\r', '');
  for (let offset = 0; offset < safeText.length; offset += MAX_EVENT_TEXT) {
    const chunk = safeText.slice(offset, offset + MAX_EVENT_TEXT);
    if (type === 'output_delta' || type === 'thinking_delta') context.emit({ type, text: chunk });
    else context.emit({ type, toolCallId: toolCallId!, text: chunk });
  }
}

export function projectToolResult(
  content: readonly ToolCallContent[],
  rawOutput: unknown,
): PluginExecutorToolResultContent {
  const diffs = content.flatMap((item) =>
    item.type === 'diff'
      ? [
          {
            path: item.path,
            diff: createWholeFileDiff(item.path, item.oldText ?? '', item.newText ?? ''),
          },
        ]
      : [],
  );
  const combinedDiff = diffs.map(({ diff }) => diff).join('\n');
  if (diffs.length && diffs.length <= 64 && combinedDiff.length <= MAX_TOOL_RESULT_DIFF)
    return {
      kind: 'file_diff',
      paths: diffs.map(({ path }) => path),
      diff: combinedDiff,
    };
  if (diffs.length)
    return {
      kind: 'text',
      text: boundedText(
        `${diffs.map(({ path }) => `Updated ${path}`).join('\n')}\nDiff omitted because it exceeds the executor event limit.`,
      ),
    };
  return { kind: 'text', text: boundedText(summarizeToolResult(content, rawOutput)) };
}

function createWholeFileDiff(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.replaceAll('\r', '').split('\n');
  const newLines = newText.replaceAll('\r', '').split('\n');
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

export function summarizeToolContent(content: readonly ToolCallContent[]): string {
  return content
    .map((item) => {
      if (item.type === 'diff') return `Updated ${item.path}`;
      if (item.type === 'terminal') return item.terminalId ? `Terminal ${item.terminalId}` : '';
      return item.content.type === 'text' ? item.content.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeToolResult(content: readonly ToolCallContent[], rawOutput: unknown): string {
  const summary = summarizeToolContent(content);
  if (summary) return summary;
  if (rawOutput === undefined) return '';
  try {
    return JSON.stringify(rawOutput);
  } catch {
    return 'External tool completed';
  }
}

export function boundedText(value: string): string {
  const safe = value.replace(/[\0\r]/gu, '');
  return safe.length <= MAX_EVENT_TEXT ? safe : `${safe.slice(0, MAX_EVENT_TEXT - 1)}…`;
}

export function toolName(value: string): string {
  return value.replace(/[\0\r\n]/gu, '').slice(0, 256) || 'external_tool';
}

export function activityKind(kind: ToolCall['kind'] | undefined) {
  if (kind === 'read') return 'read' as const;
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit' as const;
  if (kind === 'search') return 'search' as const;
  if (kind === 'fetch') return 'webfetch' as const;
  if (kind === 'execute') return 'command' as const;
  if (kind === 'think') return 'explore' as const;
  return 'tool' as const;
}
