const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForStorage } = require('./helpers.cjs');

// Chromium using the same extension path and persistent profile approximates
// closing and reopening the browser. This is not an update from a signed
// Chrome Web Store extension or a live ABEMA broadcast.
test('saved comments and opt-out survive restart of a packaged extension',
  { timeout: 70000 }, async t => {
    if (!process.env.ABEMA_PACKAGE_SMOKE_DIR) {
      t.skip('Requires CI extracted review ZIP');
      return;
    }
    const root = path.resolve(process.env.ABEMA_PACKAGE_SMOKE_DIR);
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'abema-persist-'));
    const launch = () => chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const getWorker = async context => context.serviceWorkers()[0] ||
      context.waitForEvent('serviceworker', { timeout: 15000 });

    const saved = {
      captureEnabled: false,
      comments: [{ id: 'persistent-comment', userId: 'sample', message: '続きから確認',
        createdAtMs: Date.now(), pageTitle: '確認用番組' }],
      userTags: { sample: ['保存したタグ'] },
      mutedUsers: ['muted-account'],
      autoProgramSettings: { enabled: false, newsEnabled: false, cnnEnabled: false,
        primaryEnabled: false }
    };
    let first, second;
    try {
      first = await launch();
      const worker = await getWorker(first);
      const id = new URL(worker.url()).host;
      await waitForStorage(worker, 'captureEnabled', s => s.captureEnabled === false);
      await worker.evaluate(state => chrome.storage.local.set(state), saved);
      assert.deepEqual(await worker.evaluate(keys => chrome.storage.local.get(keys),
        Object.keys(saved)), saved);
      await first.close();
      first = null;

      second = await launch();
      const next = await getWorker(second);
      assert.equal(new URL(next.url()).host, id, 'extension identity changed across restart');
      await waitForStorage(next, 'comments', state => state.comments?.length === 1);
      const restored = await next.evaluate(keys => chrome.storage.local.get(keys),
        Object.keys(saved));
      assert.deepEqual(restored, saved);
      const page = await second.newPage();
      await page.goto(`chrome-extension://${id}/popup.html`);
      await page.waitForFunction(() => document.querySelector('#toggle').textContent === '記録を開始');
      assert.equal(await page.locator('#count').innerText(), '1');
    } finally {
      if (first) await first.close();
      if (second) await second.close();
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
