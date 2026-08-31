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
import test from 'node:test';
import {
  createDefaultSettings,
  type RuntimeHostAppSettings,
} from '@maka/core/settings';
import type {
  ConnectionCatalogSnapshot,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import type { ConfigBundle } from '@maka/storage/config-transfer';
import {
  adaptRuntimeHostConfigImport,
  gatherRuntimeHostConfig,
} from '../runtime-host-config-ipc-main.js';

const CATALOG: ConnectionCatalogSnapshot = {
  revision: 1,
  defaultTarget: {
    connectionId: '00000000-0000-4000-8000-000000000001',
    modelId: 'deepseek-v4-pro',
  },
  connections: [
    {
      connectionId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      slug: 'deepseek-main',
      name: 'DeepSeek',
      providerType: 'deepseek',
      enabled: true,
      enabledModelIds: ['deepseek-v4-pro'],
      models: [{ id: 'deepseek-v4-pro' }],
    },
  ],
};

test('Runtime Host config export omits settings secrets unless credentials are selected', async () => {
  let credentialExports = 0;
  const bundle = await gatherRuntimeHostConfig(
    ['settings'],
    {
      client: {
        exportConfigurationCredentials: async () => {
          credentialExports += 1;
          return { credential: null };
        },
      },
      appVersion: '0.1.0',
      getSettings: async () => settingsWithSecrets(),
    } as never,
  );

  const settings = bundle.data.settings as Record<string, any>;
  assert.deepEqual(bundle.includedData, ['settings']);
  assert.equal(credentialExports, 0);
  assert.equal('password' in settings.network.proxy, false);
  assert.equal('passwordConfigured' in settings.network.proxy, false);
  assert.equal('token' in settings.botChat.channels.telegram, false);
  assert.equal('appSecret' in settings.botChat.channels.telegram, false);
  assert.equal('apiKey' in settings.webSearch.providers.tavily, false);
  assert.equal(settings.network.proxy.host, '127.0.0.1');
});

test('Runtime Host config export reads selected credentials from Host authority', async () => {
  const bundle = await gatherRuntimeHostConfig(
    ['connections', 'settings', 'credentials'],
    {
      client: {
        loadConnectionCatalog: async () => CATALOG,
        exportConfigurationCredentials: async ({ locator }: { locator: CredentialLocator }) => {
          const secret = secretFor(locator);
          return {
            credential:
              secret === null
                ? null
                : {
                    locator,
                    secretBase64: Buffer.from(secret).toString('base64'),
                  },
          };
        },
      },
      appVersion: '0.1.0',
      getSettings: async () => settingsWithSecrets(),
    } as never,
  );

  const settings = bundle.data.settings as Record<string, any>;
  assert.deepEqual(bundle.data.credentials, [
    {
      slug: 'deepseek-main',
      kind: 'api_key',
      value: 'sk-host',
      connection: {
        providerType: 'deepseek',
        effectiveBaseUrl: 'https://api.deepseek.com',
      },
    },
  ]);
  assert.equal(settings.network.proxy.password, 'proxy-host');
  assert.equal(settings.webSearch.providers.tavily.apiKey, 'tavily-host');
  assert.equal(settings.botChat.channels.telegram.token, 'bot-secret');
});

test('Runtime Host credentials-only export includes only schema-v1 credential fields', async () => {
  const bundle = await gatherRuntimeHostConfig(
    ['credentials'],
    {
      client: {
        loadConnectionCatalog: async () => CATALOG,
        exportConfigurationCredentials: async ({ locator }: { locator: CredentialLocator }) => {
          const secret = secretFor(locator);
          return {
            credential:
              secret === null
                ? null
                : {
                    locator,
                    secretBase64: Buffer.from(secret).toString('base64'),
                  },
          };
        },
      },
      appVersion: '0.1.0',
      getSettings: async () => settingsWithSecrets(),
    } as never,
  );

  assert.deepEqual(bundle.includedData, ['settings', 'credentials']);
  assert.deepEqual(bundle.data.settings, {
    network: { proxy: { authEnabled: true, password: 'proxy-host' } },
    webSearch: { providers: { tavily: { apiKey: 'tavily-host' } } },
  });
  assert.deepEqual(bundle.data.credentials, [
    {
      slug: 'deepseek-main',
      kind: 'api_key',
      value: 'sk-host',
      connection: {
        providerType: 'deepseek',
        effectiveBaseUrl: 'https://api.deepseek.com',
      },
    },
  ]);
});

test('Runtime Host credentials-only proxy export adapts onto default target policy', async () => {
  const exported = await gatherRuntimeHostConfig(
    ['credentials'],
    {
      client: {
        loadConnectionCatalog: async () => ({ ...CATALOG, connections: [] }),
        exportConfigurationCredentials: async ({ locator }: { locator: CredentialLocator }) => ({
          credential:
            locator.scope === 'network_proxy'
              ? {
                  locator,
                  secretBase64: Buffer.from('proxy-host').toString('base64'),
                }
              : null,
        }),
      },
      appVersion: '0.1.0',
      getSettings: async () => createDefaultSettings(),
    } as never,
  );

  const adapted = adaptRuntimeHostConfigImport(exported);
  const importedProxy = (adapted.data.settings as Record<string, any>).network.proxy;
  const targetProxy = {
    ...createDefaultSettings().network.proxy,
    ...importedProxy,
  };

  assert.equal(targetProxy.authEnabled, true);
  assert.deepEqual(targetProxy.credential, {
    kind: 'replace',
    secret: 'proxy-host',
  });
});

test('Runtime Host credentials-only export omits each absent settings-carried secret', async () => {
  const cases = [
    {
      presentScope: 'web_search',
      expected: {
        webSearch: { providers: { tavily: { apiKey: 'tavily-host' } } },
      },
    },
    {
      presentScope: 'network_proxy',
      expected: {
        network: { proxy: { authEnabled: true, password: 'proxy-host' } },
      },
    },
    {
      presentScope: null,
      expected: undefined,
    },
  ] as const;

  for (const { presentScope, expected } of cases) {
    const bundle = await gatherRuntimeHostConfig(
      ['credentials'],
      {
        client: {
          loadConnectionCatalog: async () => ({ ...CATALOG, connections: [] }),
          exportConfigurationCredentials: async ({
            locator,
          }: {
            locator: CredentialLocator;
          }) => {
            const secret = locator.scope === presentScope ? secretFor(locator) : null;
            return {
              credential:
                secret === null
                  ? null
                  : {
                      locator,
                      secretBase64: Buffer.from(secret).toString('base64'),
                    },
            };
          },
        },
        appVersion: '0.1.0',
        getSettings: async () => settingsWithSecrets(),
      } as never,
    );

    assert.deepEqual(bundle.data.settings, expected);
    assert.deepEqual(
      bundle.includedData,
      expected === undefined ? ['credentials'] : ['settings', 'credentials'],
    );
  }
});

test('Runtime Host config export writes an empty v1 proxy password when none is configured', async () => {
  const bundle = await gatherRuntimeHostConfig(
    ['settings', 'credentials'],
    {
      client: {
        loadConnectionCatalog: async () => ({ ...CATALOG, connections: [] }),
        exportConfigurationCredentials: async () => ({ credential: null }),
      },
      appVersion: '0.1.0',
      getSettings: async () => settingsWithSecrets(),
    } as never,
  );

  const settings = bundle.data.settings as Record<string, any>;
  assert.equal(settings.network.proxy.password, '');
  assert.equal('passwordConfigured' in settings.network.proxy, false);
});

test('Runtime Host config import adapts v1 proxy passwords only with credential consent', () => {
  const replace = adaptRuntimeHostConfigImport(
    importBundle(['settings', 'credentials'], 'complete-secret'),
  );
  assert.deepEqual(
    (replace.data.settings as Record<string, any>).network.proxy,
    {
      host: '10.0.0.2',
      credential: { kind: 'replace', secret: 'complete-secret' },
    },
  );

  const remove = adaptRuntimeHostConfigImport(
    importBundle(['settings', 'credentials'], ''),
  );
  assert.deepEqual(
    (remove.data.settings as Record<string, any>).network.proxy.credential,
    { kind: 'delete' },
  );

  const keep = adaptRuntimeHostConfigImport(
    importBundle(['settings', 'credentials'], undefined),
  );
  assert.equal(
    'credential' in (keep.data.settings as Record<string, any>).network.proxy,
    false,
  );

  const ignored = adaptRuntimeHostConfigImport(
    importBundle(['settings'], 'handcrafted-secret'),
  );
  assert.deepEqual(
    (ignored.data.settings as Record<string, any>).network.proxy,
    { host: '10.0.0.2' },
  );
});

test('Runtime Host config import rejects a non-string v1 password during preflight', () => {
  assert.throws(
    () => adaptRuntimeHostConfigImport(importBundle(['settings', 'credentials'], 42)),
    /password.*string/i,
  );
});

test('Runtime Host config import rejects conflicting authentication before apply', () => {
  const bundle = importBundle(
    ['connections', 'settings', 'credentials'],
    'complete-secret',
  );
  (bundle.data.settings as Record<string, any>).network.proxy.authEnabled = false;

  assert.throws(
    () => adaptRuntimeHostConfigImport(bundle),
    /authentication.*disabled/i,
  );
});

function settingsWithSecrets(): RuntimeHostAppSettings {
  const settings = createDefaultSettings();
  settings.botChat.channels.telegram.token = 'bot-secret';
  settings.botChat.channels.telegram.appSecret = 'app-secret';
  (settings.webSearch.providers.tavily as { apiKey: string }).apiKey =
    'local-tavily-secret';
  return {
    ...settings,
    network: {
      proxy: {
        ...settings.network.proxy,
        passwordConfigured: true,
      },
    },
  };
}

function importBundle(
  includedData: ConfigBundle['includedData'],
  password: unknown,
): ConfigBundle {
  const proxy: Record<string, unknown> = {
    host: '10.0.0.2',
    passwordConfigured: true,
    credential: { kind: 'replace', secret: 'injected-operation' },
  };
  if (password !== undefined) proxy.password = password;
  return {
    schemaVersion: 1,
    exportedAt: '',
    appVersion: '',
    includedData,
    data: {
      settings: { network: { proxy } },
      ...(includedData.includes('credentials') ? { credentials: [] } : {}),
    },
  };
}

function secretFor(locator: CredentialLocator): string | null {
  if (locator.scope === 'network_proxy') return 'proxy-host';
  if (locator.scope === 'web_search') return 'tavily-host';
  if (locator.scope === 'connection' && locator.kind === 'api_key') {
    return 'sk-host';
  }
  return null;
}
