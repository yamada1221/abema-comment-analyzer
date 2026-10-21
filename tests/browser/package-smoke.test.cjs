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
    for (const size of [16, 32, 48, 128]) {
      const filename = `icons/icon-${size}.png`;
      assert.equal(manifest.icons?.[size], filename);
      const binary = await fs.readFile(path.join(root, filename));
      assert.equal(binary.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(binary.readUInt32BE(16), size);
      assert.equal(binary.readUInt32BE(20), size);
      assert.equal(binary.readUInt8(25), 6, 'icon must be RGBA');
    }
    assert.equal(manifest.action.default_icon['16'], 'icons/icon-16.png');
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

      // Deletion is explicitly two-step and never removes tags, mutes or settings.
      await worker.evaluate(() => chrome.storage.local.set({
        comments: [{ id: 'retained-before-confirm', userId: 'sample', message: '履歴',
          createdAtMs: Date.now() }],
        lastCommentAt: Date.now(), userTags: { sample: ['残す'] },
        mutedUsers: ['muted'], autoProgramSettings: { enabled: false }
      }));
      await popup.waitForFunction(() => document.querySelector('#count').textContent === '1');
      await popup.locator('#clear').click();
      assert.equal(await popup.locator('#clearConfirm').isVisible(), true);
      assert.match(await popup.locator('#clearConfirm').innerText(), /取り消せません/);
      let before = await worker.evaluate(() => chrome.storage.local.get('comments'));
      assert.equal(before.comments.length, 1, 'opening confirmation must not delete history');
      await popup.locator('#cancelClear').click();
      assert.equal(await popup.locator('#clearConfirm').isVisible(), false);
      before = await worker.evaluate(() => chrome.storage.local.get('comments'));
      assert.equal(before.comments.length, 1, 'cancel must retain saved history');
      await popup.locator('#clear').click();
      await popup.locator('#confirmClear').click();
      const cleared = await waitForStorage(worker,
        ['comments', 'lastCommentAt', 'userTags', 'mutedUsers', 'autoProgramSettings'],
        state => Array.isArray(state.comments) && state.comments.length === 0
          && state.lastCommentAt === null);
      assert.deepEqual(cleared.userTags, { sample: ['残す'] });
      assert.deepEqual(cleared.mutedUsers, ['muted']);
      assert.deepEqual(cleared.autoProgramSettings, { enabled: false });
      await popup.waitForFunction(() => document.querySelector('#clearStatus').textContent.includes('削除しました'));

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
