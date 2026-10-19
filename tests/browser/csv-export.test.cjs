const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

test('real dashboard CSV download neutralizes untrusted comment formula content', async () => {
  const root = path.resolve(process.env.ABEMA_PACKAGE_SMOKE_DIR || path.join(__dirname, '../..'));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root],
    acceptDownloads: true
  });
  try {
    const worker = context.serviceWorkers()[0] ||
      await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    await worker.evaluate(() => chrome.storage.local.set({
      captureEnabled: false,
      comments: [{
        id: 'csv-export-1',
        userId: '=1+1',
        message: '=HYPERLINK("https://example.test","click")',
        pageTitle: '  @SUM(1,2)',
        createdAtMs: Date.now()
      }, {
        id: 'csv-export-2',
        userId: 'ordinary',
        message: '日本語の普通のコメント',
        pageTitle: '通常の番組',
        createdAtMs: Date.now()
      }],
      userTags: { '=1+1': ['=タグ'] }
    }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('chrome-extension://' + id + '/dashboard.html');
    await page.waitForFunction(() => document.getElementById('total').textContent === '2');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#exportCsv').click()
    ]);
    assert.equal(download.suggestedFilename(), 'abema-comments.csv');
    const contents = await fs.readFile(await download.path(), 'utf8');
    assert.ok(contents.startsWith('\uFEFFtime,userId,message,pageTitle,userTags\r\n'));
    assert.ok(contents.includes('"\'=1+1"'));
    assert.ok(contents.includes('"\'=HYPERLINK(""https://example.test"",""click"")"'));
    assert.ok(contents.includes('"\'  @SUM(1,2)"'));
    assert.ok(contents.includes('日本語の普通のコメント'));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
