const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

test('packaged extension can manage ABEMA tabs without reading unrelated URLs or titles',
  { timeout: 40000 }, async t => {
    if (!process.env.ABEMA_PACKAGE_SMOKE_DIR) {
      t.skip('Set ABEMA_PACKAGE_SMOKE_DIR to an extracted local review ZIP');
      return;
    }
    const root = path.resolve(process.env.ABEMA_PACKAGE_SMOKE_DIR);
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    try {
      const worker = context.serviceWorkers()[0] ||
        await context.waitForEvent('serviceworker', { timeout: 15000 });
      const permissions = await worker.evaluate(() => chrome.permissions.getAll());
      assert.ok(!permissions.permissions.includes('tabs'));
      assert.deepEqual(permissions.origins, ['https://abema.tv/*']);
      await context.route('https://abema.tv/**', route => route.fulfill({
        contentType: 'text/html', body: '<title>ABEMA tab fixture</title><p>Offline fixture</p>'
      }));
      await context.route('https://example.test/**', route => route.fulfill({
        contentType: 'text/html', body: '<title>Unrelated private title</title><p>Offline fixture</p>'
      }));
      const abema = await context.newPage();
      await abema.goto('https://abema.tv/now-on-air/abema-news');
      const other = await context.newPage();
      await other.goto('https://example.test/private-page');
      const tabs = await worker.evaluate(() => chrome.tabs.query({}));
      assert.ok(tabs.every(tab => !tab.url?.startsWith('https://example.test/')));
      assert.ok(tabs.every(tab => tab.title !== 'Unrelated private title'));
      const targets = await worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }));
      assert.equal(targets.length, 1);
      assert.equal(targets[0].url, 'https://abema.tv/now-on-air/abema-news');
      assert.equal(targets[0].title, 'ABEMA tab fixture');
      const target = targets[0];
      const kept = await worker.evaluate(id => chrome.tabs.update(id, { autoDiscardable: false }), target.id);
      assert.equal(kept.autoDiscardable, false);
      await worker.evaluate(({ id, value }) => chrome.tabs.update(id, { autoDiscardable: value }),
        { id: target.id, value: target.autoDiscardable });
    } finally {
      await context.close();
    }
  });
