const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { waitForStorage } = require('./helpers.cjs');

// Actual main-branch v0.13.1, before the opt-in and manual-stop changes.
// CI needs checkout fetch-depth: 0. Never fetch a moving branch during this test.
const BASELINE = '7da43d98cfc114ced491bfd53bd8c97778a50ee4';
const REPO = path.resolve(__dirname, '../..');
const EVENT_KEY = '__testInstalledEvent';
// Observe the browser event in disposable copies only. Do not call the handler
// directly or add test instrumentation to the review ZIP.
const OBSERVER = `\nchrome.runtime.onInstalled.addListener(details => {
  chrome.storage.local.set({ ${EVENT_KEY}: details });
});\n`;

async function installBaseline(root) {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', BASELINE],
    { cwd: REPO, encoding: 'utf8' }).trim().split('\n')
    .filter(name => name === 'manifest.json' || /^[^/]+\.(js|css|html)$/.test(name));
  for (const name of files) {
    await fs.writeFile(path.join(root, name),
      execFileSync('git', ['show', `${BASELINE}:${name}`], { cwd: REPO }));
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.13.1');
  await fs.appendFile(path.join(root, 'background.js'), OBSERVER);
}

for (const preference of [false, true, undefined]) {
  const label = preference === undefined ? 'legacy implicit ON' : `saved ${preference ? 'ON' : 'OFF'}`;
  test(`v0.13.1 updates to the review ZIP and preserves data with ${label}`,
    { timeout: 70000 }, async t => {
      if (!process.env.ABEMA_PACKAGE_SMOKE_DIR) {
        t.skip('Set ABEMA_PACKAGE_SMOKE_DIR to an extracted local review ZIP');
        return;
      }
      const review = path.resolve(process.env.ABEMA_PACKAGE_SMOKE_DIR);
      const current = JSON.parse(await fs.readFile(path.join(review, 'manifest.json'), 'utf8'));
      assert.notEqual(current.version, '0.13.1', 'update needs a new manifest version');
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'abema-update-'));
      const root = path.join(temporary, 'extension');
      const profile = path.join(temporary, 'profile');
      await fs.mkdir(root);
      const launch = () => chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        // CDP installs with unpacked (developer-mode) lifecycle semantics.
        // --load-extension uses command-line installation semantics instead.
        // This flag applies only to this disposable test browser/profile.
        args: ['--enable-unsafe-extension-debugging']
      });
      const getWorker = async context => context.serviceWorkers()[0] ||
        context.waitForEvent('serviceworker', { timeout: 15000 });
      let context;
      try {
        await installBaseline(root);
        context = await launch();
        const cdp = await context.browser().newBrowserCDPSession();
        const installed = await cdp.send('Extensions.loadUnpacked', { path: root });
        const before = await getWorker(context);
        const id = new URL(before.url()).host;
        assert.equal(id, installed.id);
        await waitForStorage(before, EVENT_KEY, s => s[EVENT_KEY]?.reason === 'install');
        const saved = {
          comments: [{ id: 'kept-comment', userId: 'sample', message: '更新前の保存コメント',
            createdAtMs: Date.now(), pageTitle: '更新確認用番組' }],
          userTags: { sample: ['引継ぎタグ'] }, mutedUsers: ['muted-account'],
          autoProgramSettings: { enabled: false, primaryEnabled: false,
            newsEnabled: false, cnnEnabled: false, startTime: '22:17', endTime: '23:12' },
          moderationSettings: { enabled: false, learningEnabled: false,
            whitelistUsers: ['keep-account'] },
          storageSchemaVersion: 6, installedExtensionVersion: '0.13.1'
        };
        if (preference !== undefined) saved.captureEnabled = preference;
        await before.evaluate(async ({ saved, eventKey }) => {
          await chrome.storage.local.set(saved);
          await chrome.storage.local.remove(eventKey);
          if (!Object.hasOwn(saved, 'captureEnabled')) await chrome.storage.local.remove('captureEnabled');
        }, { saved, eventKey: EVENT_KEY });
        assert.deepEqual(await before.evaluate(keys => chrome.storage.local.get(keys),
          Object.keys(saved)), saved);
        // Reload the installed extension in the same browser, path and profile.
        // A fresh --load-extension launch reports "install" even if data survives;
        // checking that event would only test restart, not the update handler.
        await fs.cp(review, root, { recursive: true, force: true });
        await fs.appendFile(path.join(root, 'background.js'), OBSERVER);
        await cdp.send('Extensions.loadUnpacked', { path: root });
        const wake = await context.newPage();
        await wake.goto(`chrome-extension://${id}/popup.html`);
        const after = await getWorker(context);
        assert.equal(new URL(after.url()).host, id);
        const event = await waitForStorage(after, EVENT_KEY,
          s => s[EVENT_KEY]?.reason === 'update');
        assert.equal(event[EVENT_KEY].previousVersion, '0.13.1');
        assert.equal(await after.evaluate(() => chrome.runtime.getManifest().version), current.version);
        const expected = { ...saved, captureEnabled: preference ?? true };
        await waitForStorage(after, 'captureEnabled', s => s.captureEnabled === expected.captureEnabled);
        assert.deepEqual(await after.evaluate(keys => chrome.storage.local.get(keys),
          Object.keys(expected)), expected);

        const errors = [];
        const popup = await context.newPage();
        popup.on('pageerror', e => errors.push(e.message));
        await popup.goto(`chrome-extension://${id}/popup.html`);
        await popup.waitForFunction(enabled =>
          document.querySelector('#toggle')?.textContent === (enabled ? '記録を停止' : '記録を開始'),
        expected.captureEnabled);
        assert.equal(await popup.locator('#count').innerText(), '1');
        const dashboard = await context.newPage();
        dashboard.on('pageerror', e => errors.push(e.message));
        await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
        await waitForStorage(after, 'installedExtensionVersion',
          s => s.installedExtensionVersion === current.version);
        await dashboard.locator('tr[data-user="sample"]').waitFor();
        assert.match(await dashboard.locator('tr[data-user="sample"]').innerText(), /引継ぎタグ/);
        // Opening the updated UI must not reset the old data or preferences.
        assert.deepEqual(await after.evaluate(keys => chrome.storage.local.get(keys),
          Object.keys(expected).filter(key => key !== 'installedExtensionVersion')),
        Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'installedExtensionVersion')));
        assert.deepEqual(errors, []);
      } finally {
        if (context) await context.close();
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });
}
