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

// An evidence journey on PR #5969's production build, not a substitute renderer.
// The Electron boundary is renderer -> contextBridge -> main -> Runtime Host ->
// archive storage -> attachment bytes, including a complete process restart.
// Only model generation uses the existing deterministic FakeBackend echo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveOperationalStateDatabasePath } from '@maka/storage/operational-state-store';
import {
  withE2eWindow,
  COMPOSER_INPUT,
  awaitSendReady,
  ensureSidebarExpanded,
  expect,
} from '../apps/desktop/e2e/fixtures';

const repoRoot = path.resolve(process.cwd(), '../..');
const output = path.join(repoRoot, 'docs/images/pr/chat-image-delivery/e2e-20261009');
const remoteSource =
  'https://raw.githubusercontent.com/Sun-GLiang/maka-agent/fc8d30612/docs/images/pr/chat-image-delivery/e2e-20261009/delivery-fixture.png';
const png = await readFile(path.join(output, 'delivery-fixture.png'));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const expectedHash = digest(png);
const checks: Array<{ name: string; result: string; detail?: unknown }> = [];
const record = (name: string, detail?: unknown) => {
  checks.push({ name, result: 'PASS', detail });
  console.log(`PASS ${name}`);
};
await mkdir(output, { recursive: true });
await withE2eWindow(
  { seed: true, readinessSelector: COMPOSER_INPUT, locale: 'en', showWindow: true },
  async (initialPage, { userDataDir, app, restart }) => {
    let page = initialPage;
    try {
      page.setDefaultTimeout(10_000);
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())!;
        window.setSize(1280, 900);
      });
      await ensureSidebarExpanded(page);
      await page.mouse.move(1200, 70);
      const send = async (text: string) => {
        await page.locator(COMPOSER_INPUT).fill(text);
        await awaitSendReady(page);
        await page.locator(COMPOSER_INPUT).press('Enter');
        await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
      };
      const image = (alt: string) =>
        page.locator('.maka-markdown-image-preview').getByRole('img', { name: alt, exact: true });
      const loaded = async (alt: string) => {
        await expect(image(alt)).toBeVisible({ timeout: 20_000 });
        await expect
          .poll(
            () =>
              image(alt).evaluate(
                (img: HTMLImageElement) =>
                  img.complete && img.naturalWidth === 960 && img.naturalHeight === 540,
              ),
            { timeout: 20_000 },
          )
          .toBe(true);
        assert.match((await image(alt).getAttribute('src'))!, /^data:image\/png;base64,/);
      };
      await send(
        `Show this remote image in the conversation.\n\n![Remote HTTPS image](${remoteSource})`,
      );
      await loaded('Remote HTTPS image');
      assert.equal(await page.getByRole('button', { name: 'Load image', exact: true }).count(), 0);
      record('Remote HTTPS image appears automatically as archived PNG bytes');
      const sessions = await page.evaluate(() => window.maka.sessions.list());
      assert.equal(sessions.length, 1);
      const sessionId = sessions[0]!.id;
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.maka.sessions.list(), sessionId)).find(
              (s) => s.id === sessionId,
            )?.status,
          { timeout: 20_000 },
        )
        .not.toBe('running');
      // Public ArtifactProjection intentionally excludes imageDelivery metadata.
      // Inspect the isolated database read-only; never seed or mutate an archive.
      const archive = () => {
        const db = new DatabaseSync(
          resolveOperationalStateDatabasePath(path.join(userDataDir, 'workspaces/default')),
          { readOnly: true },
        );
        try {
          return db
            .prepare('SELECT record_json FROM artifact_records')
            .all()
            .map((row) => JSON.parse(String(row.record_json)));
        } finally {
          db.close();
        }
      };
      const readArchive = async (source: string) => {
        const artifacts = archive();
        const artifact = artifacts.find(
          (a) => a.imageDelivery?.source === source && a.imageDelivery.status === 'ready',
        );
        assert.ok(artifact, `ready archived artifact for ${source}`);
        assert.equal(artifact.imageDelivery!.contentSha256, expectedHash);
        const read = await page.evaluate(
          ({ sessionId, artifactId }) => window.maka.attachments.readBytes(sessionId, artifactId),
          { sessionId, artifactId: artifact.id },
        );
        assert.equal(read.ok, true);
        if (!read.ok) throw new Error('archive read failed');
        assert.equal(digest(Buffer.from(read.base64, 'base64')), expectedHash);
        return artifact.id;
      };
      const remoteArtifactId = await readArchive(remoteSource);
      record('Remote archive metadata and preload attachment bytes match source SHA-256', {
        artifactId: remoteArtifactId,
        sha256: expectedHash,
      });
      await page.screenshot({
        path: path.join(output, '01-remote-automatic.png'),
        animations: 'disabled',
      });
      await image('Remote HTTPS image').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(
        page.getByRole('dialog').getByRole('img', { name: 'Remote HTTPS image', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(output, '02-click-enlarged.png'),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      record('Click opens enlarged real Electron preview; Escape closes it');

      const permission = await page.evaluate(
        (id) => window.maka.sessions.setPermissionMode(id, 'bypass'),
        sessionId,
      );
      assert.equal(permission.ok, true);
      const localSource = path.join(userDataDir, 'image-original.png');
      await writeFile(localSource, png);
      await send(
        `Archive this local image so it remains visible after its source is deleted.\n\n![Local archived image](${localSource})`,
      );
      await loaded('Local archived image');
      const localArtifactId = await readArchive(localSource);
      record('Local image crosses main/Host file reader and is archived byte-for-byte', {
        artifactId: localArtifactId,
      });
      await image('Local archived image').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(output, '03-local-archived.png'),
        animations: 'disabled',
      });
      await unlink(localSource);
      record('Original local source file deleted');
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.maka.sessions.list())).find((s) => s.id === sessionId)
              ?.status,
          { timeout: 20_000 },
        )
        .not.toBe('running');
      const privacy = await page.evaluate(() =>
        window.maka.settings.update({ privacy: { incognitoActive: true } }),
      );
      assert.equal(privacy.settings.privacy.incognitoActive, true);
      assert.equal(
        (await page.evaluate(() => window.maka.settings.get())).privacy.incognitoActive,
        true,
      );
      record('Application privacy mode enabled before restart (outbound media blocked)');
      await page.context().tracing.stop({ path: path.join(output, '01-capture.trace.zip') });
      page = await restart();
      page.setDefaultTimeout(10_000);
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      await ensureSidebarExpanded(page);
      await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
      // Leave the sidebar row before its hover card opens over the evidence.
      await page.mouse.move(1200, 70);
      await loaded('Local archived image');
      assert.equal(await readArchive(localSource), localArtifactId);
      await image('Local archived image').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(output, '04-restart-source-deleted.png'),
        animations: 'disabled',
      });
      record('Complete Electron restart replays local saved image after source deletion');
      // Offscreen images intentionally have no img element until observed.
      // Scroll the real transcript article into view before waiting for bytes.
      await page
        .getByRole('article', { name: /^Maka's response · Show this remote image/ })
        .scrollIntoViewIfNeeded();
      await loaded('Remote HTTPS image');
      assert.equal(await readArchive(remoteSource), remoteArtifactId);
      await page.screenshot({
        path: path.join(output, '05-restart-privacy-replay.png'),
        animations: 'disabled',
      });
      record('Complete Electron restart replays remote saved image with outbound media blocked');
      const csp = await page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content');
      assert.match(csp!, /img-src 'self' data: blob:/);
      record('Production renderer CSP remains self/data/blob');
      assert.equal(
        (await page.evaluate(() => window.maka.settings.get())).privacy.incognitoActive,
        true,
      );
      await page.context().tracing.stop({ path: path.join(output, '02-replay.trace.zip') });
      await writeFile(
        path.join(output, 'results.json'),
        JSON.stringify(
          {
            testedImplementation: 'b535d57b364aace0b62f13bcaea72660563e0642',
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            runAt: new Date().toISOString(),
            modelBackend:
              'existing deterministic FakeBackend; all media and persistence production code',
            remoteSource,
            imageSha256: expectedHash,
            checks,
          },
          null,
          2,
        ) + '\n',
      );
    } catch (error) {
      await page
        .context()
        .tracing.stop({ path: path.join(output, 'failure.trace.zip') })
        .catch(() => {});
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      console.error((await page.locator('body').innerText()).slice(0, 8000));
      throw error;
    }
  },
);
console.log(`Evidence saved to ${output}`);
