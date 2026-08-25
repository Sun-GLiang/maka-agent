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

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  normalizeNetworkProxyUpdate,
  type NetworkProxyCredentialUpdate,
  type RuntimePolicy,
  type UpdateNetworkProxyInput,
} from '@maka/core/runtime-policy';
import { syncDirectory } from '../stable-storage.js';
import { record } from './codec.js';
import { codecError, commitOutcomeUnknown, decodePersistedDomain, ioFailed } from './errors.js';
import { readBoundedJsonDocument, writeJsonDocument } from './document-io.js';

const FILE = 'runtime-policy-network-proxy.json';
const SCHEMA_VERSION = 1 as const;
const MAX_BYTES = 128 * 1024;

export interface NetworkProxyUpdateIntent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly networkProxy: RuntimePolicy['networkProxy'];
  readonly credential: NetworkProxyCredentialUpdate;
}

export function prepareNetworkProxyUpdateIntent(
  input: UpdateNetworkProxyInput,
): NetworkProxyUpdateIntent {
  return {
    schemaVersion: SCHEMA_VERSION,
    networkProxy: structuredClone(input.networkProxy),
    credential: structuredClone(input.credential),
  };
}

export async function readNetworkProxyUpdateIntent(
  root: string,
): Promise<NetworkProxyUpdateIntent | undefined> {
  const value = await readBoundedJsonDocument(root, FILE, MAX_BYTES);
  if (value === undefined) return undefined;
  const raw = record(value, FILE, 'invalid_document', [
    'schemaVersion',
    'networkProxy',
    'credential',
  ]);
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
  }
  const normalized = decodePersistedDomain(() =>
    normalizeNetworkProxyUpdate({
      expectedPolicyRevision: 0,
      expectedCredential: null,
      networkProxy: raw.networkProxy,
      credential: raw.credential,
    }),
  );
  return prepareNetworkProxyUpdateIntent(normalized);
}

export function writeNetworkProxyUpdateIntent(
  root: string,
  intent: NetworkProxyUpdateIntent,
): Promise<void> {
  return writeJsonDocument(root, FILE, intent, MAX_BYTES);
}

export async function clearNetworkProxyUpdateIntent(root: string): Promise<void> {
  try {
    await unlink(join(root, FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw ioFailed(`${FILE} could not be removed`, error);
  }
  try {
    await syncDirectory(root);
  } catch (error) {
    throw commitOutcomeUnknown(`${FILE} removal outcome is unknown`, error);
  }
}
