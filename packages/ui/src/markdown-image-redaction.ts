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

import { fromMarkdown } from 'mdast-util-from-markdown';
import { markdownImages } from '@maka/core/image-markdown';
import { redactSecrets } from './redact.js';

interface PositionedNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: readonly PositionedNode[];
  url?: string;
  alt?: string | null;
}

/** Hide destinations behind opaque image-only aliases before redacting prose.
 * Source positions keep identical examples in code, links and HTML untouched.
 * Marked remains the authority for the destinations sent to the Host; mdast
 * supplies only source ranges, which Marked does not expose.
 */
export function redactMarkdownImages(text: string, settledText?: string) {
  let prefix = 'maka-image-display:';
  while (text.includes(prefix) || settledText?.includes(prefix)) prefix += 'x';
  const sources = new Map<string, string>();
  const aliases = new Map<string, string>();
  const prepare = (original: string): string => {
    const redacted = redactSecrets(original);
    if (redacted === original) return redacted;
    const images = markdownImages(original).filter(image =>
      redactSecrets(image.source) !== image.source || redactSecrets(image.raw) !== image.raw);
    if (!images.length) return redacted;
    const destinations = new Map(images.map(image => [image.raw, image.source]));
    const canonical = new Set(images.map(image => image.source));
    const replacements: { start: number; end: number; value: string }[] = [];
    const visit = (node: PositionedNode) => {
      if (node.type === 'image' || node.type === 'imageReference') {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const raw = original.slice(start, end);
        const source = destinations.get(raw) ?? (node.url && canonical.has(node.url) ? node.url : undefined);
        if (!source || (redactSecrets(source) === source && redactSecrets(raw) === raw)) return;
        let alias = aliases.get(source);
        if (!alias) {
          alias = `${prefix}${aliases.size}`;
          aliases.set(source, alias);
          sources.set(alias, source);
        }
        const alt = redactSecrets(node.alt ?? '').replace(/[\\[\]`*_<>|]/g, '\\$&');
        replacements.push({ start, end, value: `![${alt}](${alias})` });
        return;
      }
      node.children?.forEach(visit);
    };
    visit(fromMarkdown(original));
    let protectedText = original;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      protectedText = protectedText.slice(0, replacement.start) + replacement.value + protectedText.slice(replacement.end);
    }
    return redactSecrets(protectedText);
  };
  return {
    text: prepare(text),
    settledText: settledText === undefined ? undefined : prepare(settledText),
    sources,
  };
}
