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

import {
  classifySessionTurnIdentity,
  SessionTurnIdentityClassificationError,
  type SessionTurnIdentity,
} from './session-turn-membership.js';

export const SESSION_TURN_IDENTITY_SCANNER_VERSION = 1;
export const SESSION_TURN_IDENTITY_SCANNER_MAX_STATE_BYTES = 64 * 1024;
export const SESSION_TURN_IDENTITY_SCANNER_MAX_CAPTURE_BYTES = 32 * 1024;
export const SESSION_TURN_IDENTITY_SCANNER_MAX_DEPTH = 4_096;

type ObjectExpectation = 'key_or_end' | 'key' | 'colon' | 'value' | 'comma_or_end';
type ArrayExpectation = 'value_or_end' | 'value' | 'comma_or_end';
type ContainerState =
  | { readonly kind: 'object'; expectation: ObjectExpectation; pendingKey: string | null }
  | { readonly kind: 'array'; expectation: ArrayExpectation };

type LexicalState =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'string';
      readonly role: 'key' | 'value';
      capture: boolean;
      value: string;
    }
  | {
      readonly kind: 'escape';
      readonly role: 'key' | 'value';
      capture: boolean;
      value: string;
    }
  | {
      readonly kind: 'unicode';
      readonly role: 'key' | 'value';
      capture: boolean;
      value: string;
      digits: string;
    }
  | { readonly kind: 'number'; value: string }
  | { readonly kind: 'literal'; readonly expected: 'true' | 'false' | 'null'; offset: number };

interface Utf8State {
  needed: number;
  codePoint: number;
  minimum: number;
}

export interface SessionTurnIdentityScannerStateV1 {
  readonly version: 1;
  rootStarted: boolean;
  rootComplete: boolean;
  stack: ContainerState[];
  lexical: LexicalState;
  utf8: Utf8State;
  seenIdentityKeys: string[];
  identity: {
    id?: string;
    type?: string;
    turnId?: string;
    turnIdPresent: boolean;
    kind?: string;
    kindPresent: boolean;
  };
  capturedBytes: number;
}

export type SessionTurnRecoveredIdentity = SessionTurnIdentity;

export class SessionTurnIdentityScannerError extends Error {
  readonly code = 'session_turn_identity_incompatible';

  constructor(
    readonly detail: string,
    readonly reason: 'corrupt_source' | 'incompatible_identity' = 'corrupt_source',
  ) {
    super(`Session Turn identity envelope is incompatible: ${detail}`);
    this.name = 'SessionTurnIdentityScannerError';
  }
}

const IDENTITY_KEYS = new Set(['id', 'type', 'turnId', 'kind']);

export function createSessionTurnIdentityScannerState(): SessionTurnIdentityScannerStateV1 {
  return {
    version: SESSION_TURN_IDENTITY_SCANNER_VERSION,
    rootStarted: false,
    rootComplete: false,
    stack: [],
    lexical: { kind: 'default' },
    utf8: { needed: 0, codePoint: 0, minimum: 0 },
    seenIdentityKeys: [],
    identity: { turnIdPresent: false, kindPresent: false },
    capturedBytes: 0,
  };
}

export function restoreSessionTurnIdentityScannerState(
  encoded: string,
): SessionTurnIdentityScannerStateV1 {
  if (Buffer.byteLength(encoded, 'utf8') > SESSION_TURN_IDENTITY_SCANNER_MAX_STATE_BYTES) {
    throw new SessionTurnIdentityScannerError(
      'scanner state exceeds 64 KiB',
      'incompatible_identity',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new SessionTurnIdentityScannerError(`invalid persisted scanner state: ${String(error)}`);
  }
  if (!isScannerState(value)) {
    throw new SessionTurnIdentityScannerError('unsupported persisted scanner state');
  }
  return value;
}

export function serializeSessionTurnIdentityScannerState(
  state: SessionTurnIdentityScannerStateV1,
): string {
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded, 'utf8') > SESSION_TURN_IDENTITY_SCANNER_MAX_STATE_BYTES) {
    throw new SessionTurnIdentityScannerError(
      'scanner state exceeds 64 KiB',
      'incompatible_identity',
    );
  }
  return encoded;
}

export function advanceSessionTurnIdentityScanner(
  state: SessionTurnIdentityScannerStateV1,
  fragment: Uint8Array,
): void {
  for (const byte of fragment) {
    const codePoint = decodeUtf8Byte(state.utf8, byte);
    if (codePoint === null) continue;
    consumeCodePoint(state, codePoint);
  }
  serializeSessionTurnIdentityScannerState(state);
}

export function completeSessionTurnIdentityScanner(
  state: SessionTurnIdentityScannerStateV1,
  sqlIdentity: { readonly messageId: string; readonly messageType: string },
): SessionTurnRecoveredIdentity {
  if (state.utf8.needed !== 0) throw new SessionTurnIdentityScannerError('truncated UTF-8');
  if (state.lexical.kind === 'number') {
    finishNumber(state);
  } else if (state.lexical.kind !== 'default') {
    throw new SessionTurnIdentityScannerError('truncated JSON token');
  }
  if (!state.rootComplete || state.stack.length !== 0) {
    throw new SessionTurnIdentityScannerError('truncated JSON structure');
  }
  const { id, type, turnId, turnIdPresent, kind, kindPresent } = state.identity;
  if (typeof id !== 'string' || id.length === 0 || typeof type !== 'string' || type.length === 0) {
    throw new SessionTurnIdentityScannerError('missing id or type', 'incompatible_identity');
  }
  if (id !== sqlIdentity.messageId || type !== sqlIdentity.messageType) {
    throw new SessionTurnIdentityScannerError(
      'SQL/body id or type mismatch',
      'incompatible_identity',
    );
  }
  try {
    return classifySessionTurnIdentity({
      id,
      type,
      turnIdPresent,
      turnId,
      kindPresent,
      kind,
    });
  } catch (error) {
    if (error instanceof SessionTurnIdentityClassificationError) {
      throw new SessionTurnIdentityScannerError(error.detail, 'incompatible_identity');
    }
    throw error;
  }
}

function consumeCodePoint(state: SessionTurnIdentityScannerStateV1, codePoint: number): void {
  const character = String.fromCodePoint(codePoint);
  switch (state.lexical.kind) {
    case 'string':
      if (codePoint === 0x22) {
        const token = state.lexical;
        state.lexical = { kind: 'default' };
        acceptString(state, token.role, token.value);
      } else if (codePoint === 0x5c) {
        state.lexical = { ...state.lexical, kind: 'escape' };
      } else {
        if (codePoint < 0x20) throw new SessionTurnIdentityScannerError('control byte in string');
        appendCaptured(state, character);
      }
      return;
    case 'escape': {
      const escaped = escapeCharacter(codePoint);
      if (escaped === null) {
        if (codePoint !== 0x75) throw new SessionTurnIdentityScannerError('invalid JSON escape');
        state.lexical = { ...state.lexical, kind: 'unicode', digits: '' };
      } else {
        const previous = state.lexical;
        state.lexical = {
          kind: 'string',
          role: previous.role,
          capture: previous.capture,
          value: previous.value,
        };
        appendCaptured(state, escaped);
      }
      return;
    }
    case 'unicode': {
      if (!/[0-9a-f]/iu.test(character)) {
        throw new SessionTurnIdentityScannerError('invalid Unicode escape');
      }
      state.lexical.digits += character;
      if (state.lexical.digits.length === 4) {
        const previous = state.lexical;
        state.lexical = {
          kind: 'string',
          role: previous.role,
          capture: previous.capture,
          value: previous.value,
        };
        appendCaptured(state, String.fromCharCode(Number.parseInt(previous.digits, 16)));
      }
      return;
    }
    case 'number':
      if (/[0-9eE+.-]/u.test(character)) {
        if (state.lexical.value.length >= 128) {
          throw new SessionTurnIdentityScannerError(
            'number token is too long',
            'incompatible_identity',
          );
        }
        state.lexical.value += character;
        return;
      }
      finishNumber(state);
      consumeCodePoint(state, codePoint);
      return;
    case 'literal':
      if (character !== state.lexical.expected[state.lexical.offset]) {
        throw new SessionTurnIdentityScannerError('invalid JSON literal');
      }
      state.lexical.offset += 1;
      if (state.lexical.offset === state.lexical.expected.length) {
        state.lexical = { kind: 'default' };
        acceptPrimitive(state, 'non-string');
      }
      return;
    case 'default':
      break;
  }

  if (codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return;
  if (state.rootComplete) throw new SessionTurnIdentityScannerError('trailing JSON data');
  if (!state.rootStarted) {
    if (character !== '{') {
      throw new SessionTurnIdentityScannerError('root must be an object', 'incompatible_identity');
    }
    state.rootStarted = true;
    pushContainer(state, { kind: 'object', expectation: 'key_or_end', pendingKey: null });
    return;
  }
  const current = state.stack.at(-1);
  if (!current) throw new SessionTurnIdentityScannerError('invalid JSON structure');
  if (character === '}' || character === ']') {
    closeContainer(state, character);
    return;
  }
  if (character === ',') {
    if (current.expectation !== 'comma_or_end') {
      throw new SessionTurnIdentityScannerError('unexpected comma');
    }
    current.expectation = current.kind === 'object' ? 'key' : 'value';
    if (current.kind === 'object') current.pendingKey = null;
    return;
  }
  if (character === ':') {
    if (current.kind !== 'object' || current.expectation !== 'colon') {
      throw new SessionTurnIdentityScannerError('unexpected colon');
    }
    current.expectation = 'value';
    return;
  }
  if (character === '"') {
    const role =
      current.kind === 'object' &&
      (current.expectation === 'key_or_end' || current.expectation === 'key')
        ? 'key'
        : 'value';
    if (role === 'value') requireValueExpectation(current);
    const capture =
      (role === 'key' && state.stack.length === 1) ||
      (role === 'value' &&
        state.stack.length === 1 &&
        current.kind === 'object' &&
        current.pendingKey !== null &&
        IDENTITY_KEYS.has(current.pendingKey));
    state.lexical = { kind: 'string', role, capture, value: '' };
    return;
  }
  if (character === '{' || character === '[') {
    requireValueExpectation(current);
    acceptPrimitive(state, 'container');
    pushContainer(
      state,
      character === '{'
        ? { kind: 'object', expectation: 'key_or_end', pendingKey: null }
        : { kind: 'array', expectation: 'value_or_end' },
    );
    return;
  }
  requireValueExpectation(current);
  if (character === '-' || /[0-9]/u.test(character)) {
    state.lexical = { kind: 'number', value: character };
    return;
  }
  if (character === 't' || character === 'f' || character === 'n') {
    state.lexical = {
      kind: 'literal',
      expected: character === 't' ? 'true' : character === 'f' ? 'false' : 'null',
      offset: 1,
    };
    return;
  }
  throw new SessionTurnIdentityScannerError('invalid JSON token');
}

function acceptString(
  state: SessionTurnIdentityScannerStateV1,
  role: 'key' | 'value',
  value: string,
): void {
  const current = state.stack.at(-1);
  if (!current) throw new SessionTurnIdentityScannerError('string outside root');
  if (role === 'key') {
    if (
      current.kind !== 'object' ||
      (current.expectation !== 'key_or_end' && current.expectation !== 'key')
    ) {
      throw new SessionTurnIdentityScannerError('unexpected object key');
    }
    current.pendingKey = state.stack.length === 1 ? value : null;
    current.expectation = 'colon';
    return;
  }
  if (current.kind === 'object' && state.stack.length === 1 && current.pendingKey) {
    recordIdentityValue(state, current.pendingKey, value);
  }
  acceptPrimitive(state, 'string');
}

function recordIdentityValue(
  state: SessionTurnIdentityScannerStateV1,
  key: string,
  value: string,
): void {
  if (!IDENTITY_KEYS.has(key)) return;
  if (state.seenIdentityKeys.includes(key)) {
    throw new SessionTurnIdentityScannerError(
      `duplicate top-level ${key}`,
      'incompatible_identity',
    );
  }
  state.seenIdentityKeys.push(key);
  state.capturedBytes += Buffer.byteLength(value, 'utf8');
  if (state.capturedBytes > SESSION_TURN_IDENTITY_SCANNER_MAX_CAPTURE_BYTES) {
    throw new SessionTurnIdentityScannerError(
      'captured identity exceeds 32 KiB',
      'incompatible_identity',
    );
  }
  if (key === 'turnId') state.identity.turnIdPresent = true;
  if (key === 'kind') state.identity.kindPresent = true;
  state.identity[key as 'id' | 'type' | 'turnId' | 'kind'] = value;
}

function acceptPrimitive(
  state: SessionTurnIdentityScannerStateV1,
  token: 'string' | 'non-string' | 'container',
): void {
  const current = state.stack.at(-1);
  if (!current) throw new SessionTurnIdentityScannerError('value outside root');
  requireValueExpectation(current);
  if (
    token !== 'string' &&
    current.kind === 'object' &&
    state.stack.length === 1 &&
    current.pendingKey !== null &&
    IDENTITY_KEYS.has(current.pendingKey)
  ) {
    throw new SessionTurnIdentityScannerError(
      `${current.pendingKey} must be a string`,
      'incompatible_identity',
    );
  }
  current.expectation = 'comma_or_end';
}

function requireValueExpectation(current: ContainerState): void {
  const valid =
    (current.kind === 'object' && current.expectation === 'value') ||
    (current.kind === 'array' &&
      (current.expectation === 'value_or_end' || current.expectation === 'value'));
  if (!valid) throw new SessionTurnIdentityScannerError('unexpected JSON value');
}

function pushContainer(state: SessionTurnIdentityScannerStateV1, container: ContainerState): void {
  if (state.stack.length >= SESSION_TURN_IDENTITY_SCANNER_MAX_DEPTH) {
    throw new SessionTurnIdentityScannerError('JSON nesting exceeds 4096', 'incompatible_identity');
  }
  state.stack.push(container);
}

function closeContainer(state: SessionTurnIdentityScannerStateV1, character: string): void {
  const current = state.stack.at(-1);
  if (!current || (character === '}' ? current.kind !== 'object' : current.kind !== 'array')) {
    throw new SessionTurnIdentityScannerError('mismatched JSON container');
  }
  const mayClose =
    current.kind === 'object'
      ? current.expectation === 'key_or_end' || current.expectation === 'comma_or_end'
      : current.expectation === 'value_or_end' || current.expectation === 'comma_or_end';
  if (!mayClose) throw new SessionTurnIdentityScannerError('incomplete JSON container');
  state.stack.pop();
  if (state.stack.length === 0) state.rootComplete = true;
}

function finishNumber(state: SessionTurnIdentityScannerStateV1): void {
  if (state.lexical.kind !== 'number') return;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(state.lexical.value)) {
    throw new SessionTurnIdentityScannerError('invalid JSON number');
  }
  state.lexical = { kind: 'default' };
  acceptPrimitive(state, 'non-string');
}

function appendCaptured(state: SessionTurnIdentityScannerStateV1, value: string): void {
  const lexical = state.lexical;
  if (lexical.kind !== 'string' && lexical.kind !== 'escape' && lexical.kind !== 'unicode') {
    throw new SessionTurnIdentityScannerError('invalid string scanner state');
  }
  if (!lexical.capture) return;
  if (lexical.role === 'key' && state.stack.length === 1) {
    const candidate = lexical.value + value;
    if (![...IDENTITY_KEYS].some((key) => key.startsWith(candidate))) {
      lexical.capture = false;
      lexical.value = '';
      return;
    }
  }
  lexical.value += value;
  if (Buffer.byteLength(lexical.value, 'utf8') > SESSION_TURN_IDENTITY_SCANNER_MAX_CAPTURE_BYTES) {
    throw new SessionTurnIdentityScannerError(
      'scanner capture exceeds 32 KiB',
      'incompatible_identity',
    );
  }
}

function escapeCharacter(codePoint: number): string | null {
  switch (codePoint) {
    case 0x22:
      return '"';
    case 0x5c:
      return '\\';
    case 0x2f:
      return '/';
    case 0x62:
      return '\b';
    case 0x66:
      return '\f';
    case 0x6e:
      return '\n';
    case 0x72:
      return '\r';
    case 0x74:
      return '\t';
    default:
      return null;
  }
}

function decodeUtf8Byte(state: Utf8State, byte: number): number | null {
  if (state.needed === 0) {
    if (byte <= 0x7f) return byte;
    if (byte >= 0xc2 && byte <= 0xdf) {
      state.needed = 1;
      state.codePoint = byte & 0x1f;
      state.minimum = 0x80;
      return null;
    }
    if (byte >= 0xe0 && byte <= 0xef) {
      state.needed = 2;
      state.codePoint = byte & 0x0f;
      state.minimum = 0x800;
      return null;
    }
    if (byte >= 0xf0 && byte <= 0xf4) {
      state.needed = 3;
      state.codePoint = byte & 0x07;
      state.minimum = 0x10000;
      return null;
    }
    throw new SessionTurnIdentityScannerError('invalid UTF-8 lead byte');
  }
  if (byte < 0x80 || byte > 0xbf) {
    throw new SessionTurnIdentityScannerError('invalid UTF-8 continuation byte');
  }
  state.codePoint = (state.codePoint << 6) | (byte & 0x3f);
  state.needed -= 1;
  if (state.needed > 0) return null;
  const codePoint = state.codePoint;
  const minimum = state.minimum;
  state.codePoint = 0;
  state.minimum = 0;
  if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    throw new SessionTurnIdentityScannerError('invalid UTF-8 scalar');
  }
  return codePoint;
}

function isScannerState(value: unknown): value is SessionTurnIdentityScannerStateV1 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionTurnIdentityScannerStateV1>;
  if (
    !(
      candidate.version === SESSION_TURN_IDENTITY_SCANNER_VERSION &&
      typeof candidate.rootStarted === 'boolean' &&
      typeof candidate.rootComplete === 'boolean' &&
      Array.isArray(candidate.stack) &&
      candidate.stack.length <= SESSION_TURN_IDENTITY_SCANNER_MAX_DEPTH &&
      candidate.stack.every(isContainerState) &&
      isLexicalState(candidate.lexical) &&
      isUtf8State(candidate.utf8) &&
      Array.isArray(candidate.seenIdentityKeys) &&
      candidate.seenIdentityKeys.every(
        (key): key is string => typeof key === 'string' && IDENTITY_KEYS.has(key),
      ) &&
      new Set(candidate.seenIdentityKeys).size === candidate.seenIdentityKeys.length &&
      typeof candidate.identity === 'object' &&
      candidate.identity !== null &&
      isOptionalString(candidate.identity.id) &&
      isOptionalString(candidate.identity.type) &&
      isOptionalString(candidate.identity.turnId) &&
      typeof candidate.identity.turnIdPresent === 'boolean' &&
      isOptionalString(candidate.identity.kind) &&
      typeof candidate.identity.kindPresent === 'boolean' &&
      Number.isSafeInteger(candidate.capturedBytes) &&
      (candidate.capturedBytes ?? -1) >= 0 &&
      (candidate.capturedBytes ?? 0) <= SESSION_TURN_IDENTITY_SCANNER_MAX_CAPTURE_BYTES
    )
  ) {
    return false;
  }
  const state = candidate as SessionTurnIdentityScannerStateV1;
  if (
    (!state.rootStarted && (state.rootComplete || state.stack.length !== 0)) ||
    (state.rootComplete && state.stack.length !== 0) ||
    (!state.rootComplete && state.rootStarted && state.stack.length === 0) ||
    state.identity.turnIdPresent !== (state.identity.turnId !== undefined) ||
    state.identity.kindPresent !== (state.identity.kind !== undefined)
  ) {
    return false;
  }
  const capturedBytes = ['id', 'type', 'turnId', 'kind'].reduce((total, key) => {
    const captured = state.identity[key as keyof typeof state.identity];
    return total + (typeof captured === 'string' ? Buffer.byteLength(captured, 'utf8') : 0);
  }, 0);
  return capturedBytes === state.capturedBytes;
}

function isContainerState(value: unknown): value is ContainerState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ContainerState>;
  if (candidate.kind === 'array') {
    return (
      candidate.expectation === 'value_or_end' ||
      candidate.expectation === 'value' ||
      candidate.expectation === 'comma_or_end'
    );
  }
  return (
    candidate.kind === 'object' &&
    (candidate.expectation === 'key_or_end' ||
      candidate.expectation === 'key' ||
      candidate.expectation === 'colon' ||
      candidate.expectation === 'value' ||
      candidate.expectation === 'comma_or_end') &&
    (candidate.pendingKey === null || typeof candidate.pendingKey === 'string')
  );
}

function isLexicalState(value: unknown): value is LexicalState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LexicalState> & Record<string, unknown>;
  if (candidate.kind === 'default') return true;
  if (candidate.kind === 'number') {
    return typeof candidate.value === 'string' && candidate.value.length <= 128;
  }
  if (candidate.kind === 'literal') {
    return (
      (candidate.expected === 'true' ||
        candidate.expected === 'false' ||
        candidate.expected === 'null') &&
      Number.isSafeInteger(candidate.offset) &&
      (candidate.offset as number) >= 1 &&
      (candidate.offset as number) < candidate.expected.length
    );
  }
  if (candidate.kind !== 'string' && candidate.kind !== 'escape' && candidate.kind !== 'unicode') {
    return false;
  }
  if (
    (candidate.role !== 'key' && candidate.role !== 'value') ||
    typeof candidate.capture !== 'boolean' ||
    typeof candidate.value !== 'string' ||
    Buffer.byteLength(candidate.value, 'utf8') > SESSION_TURN_IDENTITY_SCANNER_MAX_CAPTURE_BYTES
  ) {
    return false;
  }
  return (
    candidate.kind !== 'unicode' ||
    (typeof candidate.digits === 'string' &&
      candidate.digits.length <= 3 &&
      /^[0-9a-f]*$/iu.test(candidate.digits))
  );
}

function isUtf8State(value: unknown): value is Utf8State {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Utf8State>;
  if (
    !Number.isSafeInteger(candidate.needed) ||
    (candidate.needed ?? -1) < 0 ||
    (candidate.needed ?? 4) > 3 ||
    !Number.isSafeInteger(candidate.codePoint) ||
    (candidate.codePoint ?? -1) < 0 ||
    !Number.isSafeInteger(candidate.minimum) ||
    (candidate.minimum ?? -1) < 0
  ) {
    return false;
  }
  return candidate.needed === 0
    ? candidate.codePoint === 0 && candidate.minimum === 0
    : candidate.minimum === 0x80 || candidate.minimum === 0x800 || candidate.minimum === 0x10000;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
