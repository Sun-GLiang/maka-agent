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

/** Bounded, structured observations without depending on OpenCLI's DOM pruning. */
export const BROWSER_OBSERVATION_MAX_CHARS = 16_000;
export const BROWSER_OBSERVATION_SCAN_LIMIT = 5_000;
export const BROWSER_ACTION_TARGET_CHANGED = 'Maka browser action target changed';

export interface BrowserObservationOptions {
  selector?: string;
  scope?: string;
  visibleOnly?: boolean;
  maxElements?: number;
  start?: number;
  context?: boolean;
}

export interface BrowserCandidate {
  /** Document-local CSS reference accepted by browser_click / browser_type. */
  ref: string;
  tag: string;
  name: string;
  attributes: Record<string, string>;
  visible: boolean;
  enabled: boolean;
  readOnly?: boolean;
  checked?: boolean;
  selected?: boolean;
}

export interface BrowserObservation {
  selector: string;
  scope: string;
  scopeMatchCount: number;
  matchCount: number;
  visibleMatchCount: number | null;
  start?: number;
  nextStart?: number | null;
  scannedCount: number;
  scanTruncated: boolean;
  truncated: boolean;
  candidates: BrowserCandidate[];
  context: string[];
  error?: string;
}

// Both observations and action validation use the same rendered/disabled rules.
// Ancestors are visited iteratively so a deeply nested document cannot overflow
// the JavaScript stack. References are assigned only during observations.
const elementChecksJs = `
  const visibility = new WeakMap();
  function allowedByAncestors(el) {
    const pending = [];
    let allowed = true;
    for (let node = el; node; node = node.parentElement) {
      if (visibility.has(node)) { allowed = visibility.get(node); break; }
      pending.push(node);
      const style = window.getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || style.display === 'none' || Number(style.opacity) === 0) {
        allowed = false; break;
      }
    }
    for (const node of pending) visibility.set(node, allowed);
    return allowed;
  }
  function visible(el) {
    if (!el.isConnected || el.matches('input[type="hidden"]') || !allowedByAncestors(el)) return false;
    const ownVisibility = window.getComputedStyle(el).visibility;
    if (ownVisibility === 'hidden' || ownVisibility === 'collapse') return false;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS' && !parent.open) {
        const summary = Array.from(parent.children).find(child => child.tagName === 'SUMMARY');
        if (!summary || !summary.contains(el)) return false;
      }
    }
    return Array.from(el.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  }
  function enabled(el) {
    return !el.matches(':disabled') && !el.closest('[aria-disabled="true"]');
  }
  function readOnly(el) {
    return el.readOnly === true || !!el.closest('[aria-readonly="true"]');
  }
`;

/** Validate in the same evaluation as each OpenCLI action step, without retagging a replacement. */
export function browserActionValidationJs(
  ref: string,
  typing = false,
  native: { focus?: boolean; point?: { x: number; y: number }; targetCenter?: boolean } = {},
): string {
  return `(() => {
  const ref = ${JSON.stringify(ref)};
  const native = ${JSON.stringify(native)};
  ${elementChecksJs}
  const nodes = document.querySelectorAll(ref);
  const el = nodes[0];
  const state = window.__makaBrowserObservationRefs;
  const id = el && state?.refs.get(el);
  if (nodes.length !== 1 || !id || ref !== '[data-maka-browser-ref="' + id + '"]' ||
      !visible(el) || !enabled(el) || (${typing} && readOnly(el))) {
    throw new Error(${JSON.stringify(BROWSER_ACTION_TARGET_CHANGED)});
  }
  if (native.focus) {
    let host = el;
    if (el.isContentEditable) {
      for (let node = el; node; node = node.parentElement) {
        if (node.hasAttribute('contenteditable')) { host = node; break; }
      }
    }
    const active = document.activeElement;
    if (active !== host && !(host.isContentEditable && active?.isContentEditable && host.contains(active))) {
      throw new Error(${JSON.stringify(BROWSER_ACTION_TARGET_CHANGED)});
    }
  }
  if (native.point) {
    let { x, y } = native.point;
    const rect = el.getBoundingClientRect();
    // OpenCLI may aim at a clickable ancestor's centre for an icon/text ref.
    // Keep native events on the bound child; they still bubble to that ancestor.
    if (native.targetCenter && !(x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
      x = Math.round(rect.left + rect.width / 2);
      y = Math.round(rect.top + rect.height / 2);
    }
    const hit = document.elementFromPoint(x, y);
    const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    if (!inside || !hit || !(el === hit || el.contains(hit) || hit.contains(el))) {
      throw new Error(${JSON.stringify(BROWSER_ACTION_TARGET_CHANGED)});
    }
    return { x, y };
  }
})()`;
}

/**
 * Inputs are JSON literals, never executable selector fragments. References use
 * a per-document nonce and a WeakMap: another inspection preserves them, while
 * reload/navigation cannot silently reuse them for unrelated elements.
 * Only reference attributes are written; no page controls or values are changed.
 */
export function browserObservationJs(options: BrowserObservationOptions = {}): string {
  return `(() => {
  const options = ${JSON.stringify(options)};
  const interactive = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="tab"],[role="textbox"],[role="combobox"],[contenteditable="true"]';
  const selector = options.selector || interactive;
  const scope = options.scope || 'body';
  const maxElements = Math.max(1, Math.min(100, options.maxElements || 20));
  const start = Math.max(0, Math.floor(options.start || 0));
  const result = { selector, scope, scopeMatchCount: 0, matchCount: 0, visibleMatchCount: 0, start, nextStart: null, scannedCount: 0, scanTruncated: false, truncated: false, candidates: [], context: [] };
  let roots;
  try { roots = document.querySelectorAll(scope); }
  catch { result.error = 'Invalid scope selector.'; return result; }
  result.scopeMatchCount = roots.length;
  if (roots.length !== 1) {
    result.error = 'Scope must match exactly one element; use a narrower scope.';
    return result;
  }
  const root = roots[0];
  let nodes, rootMatches;
  try {
    nodes = root.querySelectorAll(selector);
    rootMatches = root.matches(selector);
  } catch { result.error = 'Invalid element selector.'; return result; }
  result.matchCount = nodes.length + (rootMatches ? 1 : 0);
  const end = Math.min(result.matchCount, start + ${BROWSER_OBSERVATION_SCAN_LIMIT});
  result.scannedCount = Math.max(0, end - start);
  result.scanTruncated = start > 0 || end < result.matchCount;
  result.nextStart = end < result.matchCount ? end : null;
  ${elementChecksJs}
  const clean = (text) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  function name(el) {
    const explicit = el.getAttribute('aria-label');
    if (explicit) return clean(explicit);
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      // Explicit naming references may point to hidden text (e.g. an sr-only label).
      const text = labelled.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
      if (text.trim()) return clean(text);
    }
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).filter(visible).map(label => label.innerText).join(' ');
      if (text.trim()) return clean(text);
    }
    // Submit/button/reset values are displayed action labels, not editable input values.
    if (el.matches('input[type="submit"],input[type="button"],input[type="reset"]')) return clean(el.value);
    return clean(el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') ||
      (el.isContentEditable || el.matches('input,textarea,select') ? '' : el.innerText));
  }
  const stateKey = '__makaBrowserObservationRefs';
  if (!window[stateKey]) {
    window[stateKey] = { nonce: Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), next: 0, refs: new WeakMap() };
  }
  const state = window[stateKey];
  let visibleCount = 0;
  const candidateIndexes = [];
  for (let index = start; index < end; index++) {
    const el = rootMatches && index === 0 ? root : nodes[index - (rootMatches ? 1 : 0)];
    const isVisible = visible(el);
    if (isVisible) visibleCount++;
    if (el.matches('input[type="hidden"]') || (options.visibleOnly !== false && !isVisible)) continue;
    if (result.candidates.length >= maxElements) {
      result.nextStart = Math.min(result.nextStart ?? index, index);
      continue;
    }
    let id = state.refs.get(el);
    if (!id) { id = 'maka-' + state.nonce + '-' + (++state.next); state.refs.set(el, id); }
    if (el.getAttribute('data-maka-browser-ref') !== id) el.setAttribute('data-maka-browser-ref', id);
    const attributes = {};
    for (const key of ['id', 'name', 'role', 'type', 'aria-label', 'aria-checked', 'aria-expanded', 'aria-selected']) {
      const value = el.getAttribute(key);
      if (value) attributes[key] = clean(value);
    }
    const candidate = { ref: '[data-maka-browser-ref="' + id + '"]', tag: el.tagName.toLowerCase(), name: name(el), attributes, visible: isVisible, enabled: enabled(el) };
    if (el.matches('input,textarea,[contenteditable],[role="textbox"]')) candidate.readOnly = readOnly(el);
    if (el.matches('input[type="checkbox"],input[type="radio"]')) candidate.checked = el.checked;
    if (el.tagName === 'OPTION') candidate.selected = el.selected;
    result.candidates.push(candidate);
    candidateIndexes.push(index);
  }
  result.visibleMatchCount = result.scanTruncated ? null : visibleCount;
  if (options.context) {
    const headings = root.querySelectorAll('h1,h2,h3,[role="heading"]');
    for (let index = 0; index < Math.min(headings.length, ${BROWSER_OBSERVATION_SCAN_LIMIT}); index++) {
      const el = headings[index];
      if (visible(el)) result.context.push(clean(el.innerText));
      if (result.context.length >= 12) break;
    }
  }
  result.truncated = result.scanTruncated || result.nextStart !== null;
  while (JSON.stringify(result).length > ${BROWSER_OBSERVATION_MAX_CHARS} && result.candidates.length) {
    result.candidates.pop();
    result.nextStart = Math.min(result.nextStart ?? Infinity, candidateIndexes.pop());
    result.truncated = true;
  }
  return result;
})()`;
}
