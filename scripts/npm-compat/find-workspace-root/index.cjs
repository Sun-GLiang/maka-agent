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

const { readFileSync } = require('node:fs');
const { dirname, join, relative, resolve, sep } = require('node:path');
const picomatch = require('picomatch');

// patch-package expects a synchronous function returning a root path or null.
// Retain ordered exclusions/re-inclusions and both workspace manifest shapes.
function matchesWorkspace(path, patterns) {
  const matchers = patterns.map((pattern) => {
    const match = picomatch(pattern, {}, true);
    return { match, negative: Boolean(match.state.negated || match.state.negatedExtglob) };
  });
  let included = matchers.length > 0 && matchers.every(({ negative }) => negative);
  for (const { match, negative } of matchers) {
    if (negative ? !match(path) : match(path)) included = !negative;
  }
  return included;
}

module.exports = function findWorkspaceRoot(start = process.cwd()) {
  const initial = resolve(start);
  let directory = initial;
  while (true) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const workspaces = manifest?.workspaces;
    const patterns = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
    if (Array.isArray(patterns)) {
      const path = relative(directory, initial).split(sep).join('/');
      return path === '' || matchesWorkspace(path, patterns) ? directory : null;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
};
