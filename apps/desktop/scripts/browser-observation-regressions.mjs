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

export async function runBrowserObservationRegressions({ page, invoke, current, legacy }) {
  const observe = options => invoke(current.buildBrowserInspectTool(), options).then(JSON.parse);
  let regressionChecks = 0;
  function check(condition, message) { assert.ok(condition, message); regressionChecks++; }
  await invoke(current.buildBrowserNavigateTool(), { url: 'https://fixture.test/pr' });
  const snapshot = JSON.parse(await invoke(current.buildBrowserSnapshotTool(), { selector: '#new_pull_request' }));
  check(snapshot.candidates.every(candidate => candidate.visible), 'only visible candidates appear');
  check(!JSON.stringify(snapshot).includes('css-hidden') && !JSON.stringify(snapshot).includes('closed-menu'), 'hidden menus are excluded');
  check(snapshot.candidates.some(candidate => candidate.attributes.id === 'contents-control'), 'display:contents descendants are retained');
  check(!snapshot.candidates.some(candidate => candidate.attributes.id === 'transparent-control'), 'transparent ancestor is excluded');
  check(!JSON.stringify(snapshot).includes('PRIVATE_') && !JSON.stringify(snapshot).includes('private-csrf-identifier'), 'input values and hidden identifiers are absent');
  const observed = JSON.parse(await invoke(current.buildBrowserInspectTool(), { selector: 'button[type="submit"]', scope: '#new_pull_request' }));
  check(observed.matchCount === 5 && observed.visibleMatchCount === 1 && observed.candidates.length === 1, 'all matches counted, visible targets identified');
  const blocked = await invoke(current.buildBrowserClickTool(), { ref: 'form#new_pull_request button[type="submit"]' });
  check(blocked.includes('No action taken') && blocked.includes('"matchCount":5'), 'ambiguous click returns actionable diagnostics');
  check(await page.evaluate('window.submissions') === 0, 'ambiguous click never submits');
  await assert.rejects(invoke(current.buildBrowserExtractTool(), { selector: 'button[type="submit"]' }), /5 elements/); regressionChecks++;
  const same = JSON.parse(await invoke(current.buildBrowserInspectTool(), { selector: 'button[type="submit"]', scope: '#new_pull_request' }));
  check(same.candidates[0].ref === observed.candidates[0].ref, 'inspection preserves existing refs within a document');
  const limited = await observe({ maxElements: 1 });
  check(limited.candidates.length === 1 && limited.truncated, 'candidate limits report truncation');
  const invalid = await observe({ selector: '#x";window.injected=true;//' });
  check(Boolean(invalid.error) && !(await page.evaluate('window.injected')), 'selector is a JSON literal, never executable code');
  const hidden = await observe({ selector: 'input[type="hidden"]', visibleOnly: false });
  check(hidden.matchCount === 1 && hidden.candidates.length === 0, 'invisible inspection never exposes hidden controls');
  const staleRef = observed.candidates[0].ref;
  await invoke(current.buildBrowserNavigateTool(), { url: 'https://fixture.test/pr' });
  const stale = await invoke(current.buildBrowserClickTool(), { ref: staleRef });
  check(stale.includes('No action taken') && stale.includes('stale'), 'refs cannot silently survive navigation');
  check(await page.evaluate('window.submissions') === 0, 'stale refs never submit');
  const controls = await observe({ selector: '#disabled-control' });
  check(controls.candidates[0].enabled === false, 'disabled state is reported');
  const disabled = await invoke(current.buildBrowserClickTool(), { ref: controls.candidates[0].ref });
  check(disabled.includes('No action taken'), 'disabled target is not acted upon');
  await page.evaluate(() => {
    const parent = document.createElement('div'); parent.style.visibility = 'hidden';
    parent.innerHTML = '<button id="visibility-override" style="visibility:visible">Override</button>';
    document.body.append(parent);
  });
  const override = await observe({ selector: '#visibility-override' });
  check(override.candidates[0]?.visible, 'a child can override inherited visibility:hidden');
  const freshPrimary = await observe({ selector: '.btn-primary' });
  await page.evaluate(() => { const target = document.querySelector('.btn-primary'); target.replaceWith(target.cloneNode(true)); });
  const replaced = await invoke(current.buildBrowserClickTool(), { ref: freshPrimary.candidates[0].ref });
  check(replaced.includes('No action taken') && replaced.includes('stale'), 'copied refs cannot silently target a replacement node');
  check(await page.evaluate('window.submissions') === 0, 'replacement refs never submit');
  if (legacy) {
    const old = await invoke(legacy.buildBrowserSnapshotTool(), {});
    check(old.includes('css-hidden repository') && old.includes('closed-menu repository'), 'baseline genuinely reproduces hidden-menu noise');
  }
  const capped = await observe({ selector: 'a', visibleOnly: false, maxElements: 100 });
  check(JSON.stringify(capped).length <= 16000 && capped.truncated, 'structured result obeys output budget');
  await page.evaluate(() => {
    const parent = document.createElement('div'); parent.hidden = true;
    parent.innerHTML = '<button class="scan-limit">Hidden</button>'.repeat(5001);
    document.body.append(parent);
  });
  const scan = await observe({ selector: '.scan-limit' });
  check(scan.matchCount === 5001 && scan.scannedCount === 5000 && scan.scanTruncated && scan.visibleMatchCount === null, 'bounded scans do not present partial visible counts as exact');
  const ambiguousScope = await observe({ scope: 'details' });
  check(Boolean(ambiguousScope.error) && ambiguousScope.candidates.length === 0, 'ambiguous scopes never choose the first region');
  return regressionChecks;
}
