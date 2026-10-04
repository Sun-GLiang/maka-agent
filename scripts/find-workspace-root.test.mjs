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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import findWorkspaceRoot from './npm-compat/find-workspace-root/index.cjs';

function fixture(t, workspaces) {
  const root = mkdtempSync(join(tmpdir(), 'maka-workspace-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces }));
  return root;
}

for (const workspaces of [['packages/*'], { packages: ['packages/*'] }]) {
  test(`finds the root and a member with ${JSON.stringify(workspaces)}`, (t) => {
    const root = fixture(t, workspaces);
    const member = join(root, 'packages', 'one');
    mkdirSync(member, { recursive: true });
    writeFileSync(join(member, 'package.json'), '{}');
    assert.equal(findWorkspaceRoot(root), root);
    assert.equal(findWorkspaceRoot(member), root);
    assert.equal(findWorkspaceRoot(join(root, 'unrelated')), null);
  });
}

test('supports brace patterns, exclusions, and later re-inclusion', (t) => {
  const root = fixture(t, ['{packages,apps}/*', '!packages/hidden-*', 'packages/hidden-allowed']);
  for (const member of ['packages/core', 'apps/desktop', 'packages/hidden-allowed']) {
    assert.equal(findWorkspaceRoot(join(root, member)), root);
  }
  assert.equal(findWorkspaceRoot(join(root, 'packages/hidden-secret')), null);
  assert.equal(findWorkspaceRoot(join(root, 'other/member')), null);
});

test('supports exclusion-only patterns and negated extglobs', (t) => {
  const root = fixture(t, ['!excluded/**']);
  assert.equal(findWorkspaceRoot(join(root, 'included/member')), root);
  assert.equal(findWorkspaceRoot(join(root, 'excluded/member')), null);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['!(excluded)'] }));
  assert.equal(findWorkspaceRoot(join(root, 'included')), root);
  assert.equal(findWorkspaceRoot(join(root, 'excluded')), null);
});

test('stops at the nearest workspace boundary even when it excludes the member', (t) => {
  const root = fixture(t, ['**']);
  const nested = join(root, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'package.json'), JSON.stringify({ workspaces: ['members/*'] }));
  assert.equal(findWorkspaceRoot(join(nested, 'members/one')), nested);
  assert.equal(findWorkspaceRoot(join(nested, 'other')), null);
});

test('empty workspace lists include only their root', (t) => {
  const root = fixture(t, []);
  assert.equal(findWorkspaceRoot(root), root);
  assert.equal(findWorkspaceRoot(join(root, 'member')), null);
});

test('deeply nested braces do not exhaust the call stack', (t) => {
  const root = fixture(t, [`${'{'.repeat(5000)}member${'}'.repeat(5000)}`]);
  assert.doesNotThrow(() => findWorkspaceRoot(join(root, 'member')));
});

test('returns null without a workspace and reports invalid manifests', (t) => {
  const root = fixture(t, undefined);
  assert.equal(findWorkspaceRoot(root), null);
  writeFileSync(join(root, 'package.json'), '{broken');
  assert.throws(() => findWorkspaceRoot(root), SyntaxError);
});

test('patch-package resolves the adapter and it recognizes this npm workspace', () => {
  const require = createRequire(import.meta.url);
  const fromPatchPackage = createRequire(require.resolve('patch-package/package.json'));
  const installedFindRoot = fromPatchPackage('find-yarn-workspace-root');
  assert.equal(installedFindRoot, findWorkspaceRoot);
  const root = resolve(import.meta.dirname, '..');
  assert.equal(installedFindRoot(join(root, 'apps/desktop')), root);
  assert.equal(installedFindRoot(), root);
});
