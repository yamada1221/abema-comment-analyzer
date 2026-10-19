const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForStorage } = require('./helpers.cjs');

// This test loads the extracted, allowlisted review ZIP rather than repository
// sources. CI builds and extracts it locally; nothing gets uploaded/published.
test('review ZIP installs as a real extension with opt-in and linked guidance',
  { timeout: 60000 }, async t => {
    if (!process.env.ABEMA_PACKAGE_SMOKE_DIR) {
      t.skip('Set ABEMA_PACKAGE_SMOKE_DIR to an extracted local review ZIP');
      return;
    }
    const root = path.resolve(process.env.ABEMA_PACKAGE_SMOKE_DIR);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.host_permissions.length, 1);
    assert.equal(manifest.host_permissions[0], 'https://abema.tv/*');
    // A packaged extension must not accidentally include development sources.
    const members = await fs.readdir(root);
    for (const forbidden of ['tests', 'docs', 'node_modules', 'package.json',
      '.git', '.github', '.env', 'scripts']) {
      assert.ok(!members.includes(forbidden), `unwanted packaged asset: ${forbidden}`);
    }

    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    try {
      const worker = context.serviceWorkers()[0] ||
        await context.waitForEvent('serviceworker', { timeout: 15000 });
      const id = new URL(worker.url()).host;
      const fresh = await waitForStorage(worker, 'captureEnabled',
        state => state.captureEnabled === false);
      assert.equal(fresh.captureEnabled, false);

      const popup = await context.newPage();
      const errors = [];
      popup.on('pageerror', error => errors.push(error.message));
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.waitForFunction(() => {
        const toggle = document.querySelector('#toggle');
        return toggle && !toggle.disabled && toggle.textContent === '記録を開始';
      });
      assert.match(await popup.locator('#captureDisclosure').innerText(), /コメント本文・投稿者ID/);
      assert.match(await popup.locator('#network').innerText(), /記録OFF中/);

      const help = popup.locator('a[href="guide.html"]');
      assert.equal(await help.count(), 1);
      const guide = await context.newPage();
      await guide.goto(`chrome-extension://${id}/guide.html`);
      assert.match(await guide.locator('main').innerText(), /はじめに|使い始める/);
      const privacy = await context.newPage();
      await privacy.goto(`chrome-extension://${id}/privacy.html`);
      assert.match(await privacy.locator('main').innerText(), /データの取り扱い/);
      assert.match(await privacy.locator('main').innerText(), /記録停止中の動作/);

      await popup.locator('#toggle').click();
      await waitForStorage(worker, 'captureEnabled', s => s.captureEnabled === true);
      await popup.waitForFunction(() => document.querySelector('#toggle').textContent === '記録を停止');
      await popup.locator('#toggle').click();
      await waitForStorage(worker, 'captureEnabled', s => s.captureEnabled === false);

      const dashboard = await context.newPage();
      dashboard.on('pageerror', error => errors.push(error.message));
      await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
      await dashboard.locator('#commentExplorer').waitFor();
      assert.deepEqual(errors, []);
      await popup.close();
      await guide.close();
      await privacy.close();
      await dashboard.close();
    } finally {
      await context.close();
    }
  });
