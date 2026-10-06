const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const TARGET = 'https://abema.tv/now-on-air/abema-news';
const SOURCE = 'abema-comment-analyzer';
const KEYWORD = '自動記録テスト番組';

async function extension() {
  const root = path.resolve(__dirname, '../..');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  context.setDefaultTimeout(15000);
  // Exercise real content scripts and tab APIs without contacting ABEMA or another website.
  await context.route('https://abema.tv/**', route => route.fulfill({
    contentType: 'text/html', body: `<html><head><title>${KEYWORD}</title></head><body><h1>${KEYWORD}</h1></body></html>`
  }));
  await context.route('https://example.org/**', route => route.fulfill({
    contentType: 'text/html', body: '<html><title>閲覧中のページ</title><body>閲覧中</body></html>'
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.autoProgramTestTrace = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const relevant = Object.fromEntries(Object.entries(changes).filter(([key]) => key.startsWith('autoProgram') || key === 'captureEnabled'));
      if (Object.keys(relevant).length) autoProgramTestTrace.push({ at: Date.now(), changes: relevant });
    });
  });
  await worker.evaluate(() => chrome.storage.local.set({ captureEnabled: false }));
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
  return { context, worker, dashboard };
}

async function start({ worker, dashboard }) {
  await worker.evaluate(({ url, keyword }) => chrome.storage.local.set({
    autoProgramSettings: {
      enabled: true, url, keyword, days: [0, 1, 2, 3, 4, 5, 6],
      startTime: '00:00', endTime: '00:00', closeOwnedTab: true, openActive: false
    }
  }), { url: TARGET, keyword: KEYWORD });
  const responses = await dashboard.evaluate(async source => Promise.all(Array.from({ length: 3 }, () =>
    chrome.runtime.sendMessage({ source, type: 'AUTO_PROGRAM_TICK_NOW' }))), SOURCE);
  assert.ok(responses.every(response => response.ok));
  await dashboard.waitForFunction(async () => (await chrome.storage.local.get('autoProgramSession')).autoProgramSession?.active);
  return worker.evaluate(() => chrome.storage.local.get(['autoProgramSession', 'captureEnabled']));
}

async function stop({ dashboard }) {
  await dashboard.locator('#stopAutoProgram').click();
  await dashboard.waitForFunction(async () => {
    const data = await chrome.storage.local.get(['autoProgramSession', 'captureEnabled']);
    return data.autoProgramSession === null && data.captureEnabled === false;
  });
  const result = await dashboard.evaluate(source => chrome.runtime.sendMessage({ source, type: 'AUTO_PROGRAM_TICK_NOW' }), SOURCE);
  assert.equal(result.ok, true);
}

test('concurrent Chrome extension checks open one automatic tab and stop does not reopen it', { timeout: 60000 }, async () => {
  const app = await extension();
  try {
    const state = await start(app);
    assert.equal(state.autoProgramSession.ownedTab, true);
    const trace = await app.worker.evaluate(() => globalThis.autoProgramTestTrace);
    assert.equal(state.captureEnabled, true, JSON.stringify({ state, trace }));
    const tabs = await app.worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }));
    assert.equal(tabs.length, 1);
    await stop(app);
    const remaining = await app.worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }));
    assert.equal(remaining.length, 0);
    // Identical settings do not necessarily emit storage.onChanged; the explicit save must resume.
    await app.dashboard.locator('#saveAutoProgram').click();
    await app.dashboard.waitForFunction(async () => (await chrome.storage.local.get('autoProgramSession')).autoProgramSession?.active);
    const resumed = await app.worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }));
    assert.equal(resumed.length, 1);
    await stop(app);
  } finally { await app.context.close(); }
});

test('automatic recording borrows an existing ABEMA tab and leaves it open', { timeout: 60000 }, async () => {
  const app = await extension();
  try {
    const manual = await app.context.newPage();
    await manual.goto(TARGET);
    const state = await start(app);
    assert.equal(state.autoProgramSession.ownedTab, false);
    await stop(app);
    assert.equal(manual.isClosed(), false);
    assert.equal(manual.url(), TARGET);
    const remaining = await app.worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }));
    assert.equal(remaining.length, 1);
  } finally { await app.context.close(); }
});

test('stopping leaves an automatic tab open after it is used for another page', { timeout: 60000 }, async () => {
  const app = await extension();
  try {
    await start(app);
    const tab = app.context.pages().find(page => page.url() === TARGET);
    assert.ok(tab);
    await tab.goto('https://example.org/reading');
    await stop(app);
    assert.equal(tab.isClosed(), false);
    assert.equal(tab.url(), 'https://example.org/reading');
  } finally { await app.context.close(); }
});
