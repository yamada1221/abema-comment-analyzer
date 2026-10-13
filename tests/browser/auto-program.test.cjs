const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForStorage } = require('./helpers.cjs');
const { abemaFixture } = require('./abema-fixture.cjs');

const TARGET = 'https://abema.tv/now-on-air/abema-news';
const SOURCE = 'abema-comment-analyzer';
const KEYWORD = '自動記録テスト番組';

async function extension(fixtureOptions = {}) {
  const root = path.resolve(__dirname, '../..');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  context.setDefaultTimeout(15000);
  // Browser-created tabs can start their first navigation before Playwright attaches.
  // Keep networking offline, then load the intercepted fixture after the tab attaches.
  await context.setOffline(true);
  await context.route('https://abema.tv/**', route => route.fulfill({
    contentType: 'text/html', body: abemaFixture({ keyword: KEYWORD, ...fixtureOptions })
  }));
  await context.route('https://example.org/**', route => route.fulfill({
    contentType: 'text/html', body: '<html><title>閲覧中のページ</title><body>閲覧中</body></html>'
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ captureEnabled: false }));
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
  return { context, worker, dashboard };
}

async function recording({ dashboard }) {
  const responses = await dashboard.evaluate(async source => Promise.all(Array.from({ length: 3 }, () =>
    chrome.runtime.sendMessage({ source, type: 'AUTO_PROGRAM_TICK_NOW' }))), SOURCE);
  assert.ok(responses.every(response => response.ok));
  return waitForStorage(dashboard, ['autoProgramSession', 'captureEnabled'],
    state => state.autoProgramSession?.active === true && state.captureEnabled === true);
}

async function start({ context, worker, dashboard }) {
  const existing = context.pages().find(page => page.url() === TARGET);
  const opened = existing ? null : context.waitForEvent('page');
  await worker.evaluate(({ url, keyword }) => chrome.storage.local.set({
    autoProgramSettings: {
      enabled: true, newsEnabled: false, cnnEnabled: false, url, keyword, days: [0, 1, 2, 3, 4, 5, 6],
      startTime: '00:00', endTime: '00:00', closeOwnedTab: true, openActive: false
    }
  }), { url: TARGET, keyword: KEYWORD });
  if (opened) await (await opened).goto(TARGET);
  return recording({ dashboard });
}

async function stop({ dashboard }) {
  await dashboard.locator('#stopAutoProgram').click();
  await waitForStorage(dashboard, ['autoProgramSession', 'captureEnabled'],
    data => data.autoProgramSession === null && data.captureEnabled === false);
  const result = await dashboard.evaluate(source => chrome.runtime.sendMessage({ source, type: 'AUTO_PROGRAM_TICK_NOW' }), SOURCE);
  assert.equal(result.ok, true);
}

test('NEWS and CNNj time slots open the comment panel without a matching title', { timeout: 60000 }, async () => {
  const app = await extension();
  try {
    await app.worker.evaluate(() => {
      const NativeDate = Date;
      globalThis.testNow = NativeDate.parse('2026-10-12T15:01:00Z');
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [globalThis.testNow])); }
        static now() { return globalThis.testNow; }
      };
    });
    let opened = app.context.waitForEvent('page');
    // Old settings do not contain the new preset keys. Their defaults must work on upgrade.
    await app.worker.evaluate(() => chrome.storage.local.set({
      autoProgramSettings: { enabled: true, primaryEnabled: false }
    }));
    let tab = await opened;
    await tab.goto(TARGET);
    let state = await recording(app);
    assert.equal(state.autoProgramSession.windowKey, 'news:2026-10-13');
    await tab.getByRole('textbox', { name: 'コメントを入力' }).waitFor({ state: 'visible' });
    const status = await app.worker.evaluate(() => chrome.storage.local.get('autoProgramStatus'));
    assert.equal(status.autoProgramStatus.detection.matched, false);
    assert.equal(status.autoProgramStatus.detection.timed, true);
    await app.worker.evaluate(() => { globalThis.testNow = Date.parse('2026-10-12T16:20:00Z'); });
    await app.dashboard.evaluate(source => chrome.runtime.sendMessage({ source, type: 'AUTO_PROGRAM_TICK_NOW' }), SOURCE);
    await waitForStorage(app.dashboard, ['autoProgramSession', 'captureEnabled'],
      data => data.autoProgramSession === null && data.captureEnabled === false);
    await app.worker.evaluate(() => { globalThis.testNow = Date.parse('2026-10-13T07:00:00Z'); });
    opened = app.context.waitForEvent('page');
    const tick = app.dashboard.evaluate(source => chrome.runtime.sendMessage({ source, type: 'AUTO_PROGRAM_TICK_NOW' }), SOURCE);
    tab = await opened; await tab.goto(TARGET); await tick;
    state = await recording(app);
    assert.equal(state.autoProgramSession.windowKey, 'cnn:2026-10-13');
    await tab.getByRole('textbox', { name: 'コメントを入力' }).waitFor({ state: 'visible' });
    await app.worker.evaluate(() => { globalThis.testNow = Date.parse('2026-10-13T07:20:00Z'); });
    await app.dashboard.evaluate(source => chrome.runtime.sendMessage({ source, type: 'AUTO_PROGRAM_TICK_NOW' }), SOURCE);
    await waitForStorage(app.dashboard, ['autoProgramSession', 'captureEnabled'],
      data => data.autoProgramSession === null && data.captureEnabled === false);
    assert.equal((await app.worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }))).length, 0);
  } finally { await app.context.close(); }
});

test('concurrent Chrome extension checks open one automatic tab and stop does not reopen it', { timeout: 60000 }, async () => {
  const app = await extension();
  try {
    const state = await start(app);
    assert.equal(state.autoProgramSession.ownedTab, true);
    assert.equal(state.captureEnabled, true);
    const tabs = await app.worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }));
    assert.equal(tabs.length, 1);
    await stop(app);
    const remaining = await app.worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }));
    assert.equal(remaining.length, 0);
    // Identical settings do not necessarily emit storage.onChanged; the explicit save must resume.
    const opened = app.context.waitForEvent('page');
    await app.dashboard.locator('#saveAutoProgram').click();
    await (await opened).goto(TARGET);
    await recording(app);
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

test('a replacement tab reopens comments while the previously detected title is missing', { timeout: 60000 }, async () => {
  const app = await extension();
  try {
    await start(app);
    const original = app.context.pages().find(page => page.url() === TARGET);
    await original.getByRole('textbox', { name: 'コメントを入力' }).waitFor({ state: 'visible' });
    await app.context.route('https://abema.tv/**', route => route.fulfill({
      contentType: 'text/html', body: abemaFixture({ keyword: '読み込み中' })
    }));
    await original.close();
    const opened = app.context.waitForEvent('page');
    const tick = app.dashboard.evaluate(source => chrome.runtime.sendMessage({ source, type: 'AUTO_PROGRAM_TICK_NOW' }), SOURCE);
    const replacement = await opened;
    await replacement.goto(TARGET);
    await tick;
    await replacement.getByRole('textbox', { name: 'コメントを入力' }).waitFor({ state: 'visible' });
    const data = await app.worker.evaluate(() => chrome.storage.local.get(['autoProgramSession', 'autoProgramStatus', 'captureEnabled']));
    assert.equal(data.autoProgramSession.active, true);
    assert.equal(data.autoProgramStatus.detection.matched, false);
    assert.equal(data.captureEnabled, true);
    assert.equal((await replacement.evaluate(() => window.fixture)).laterClicks, 1);
    await recording(app);
    assert.equal((await replacement.evaluate(() => window.fixture)).commentClicks, 1);
    await stop(app);
    assert.equal((await app.worker.evaluate(() => chrome.tabs.query({ url: 'https://abema.tv/*' }))).length, 0);
  } finally { await app.context.close(); }
});

test('concurrent capture messages preserve every batch and popup deletion clears the merged history', { timeout: 60000 }, async () => {
  const app = await extension();
  try {
    await app.worker.evaluate(() => chrome.storage.local.set({ captureEnabled: true }));
    const second = await app.context.newPage();
    await second.goto(app.dashboard.url());
    const sendBatches = (page, prefix) => page.evaluate(async prefix => {
      return Promise.all(Array.from({ length: 20 }, (_, i) => chrome.runtime.sendMessage({
        source: 'abema-comment-analyzer', type: 'APPEND_CAPTURED_COMMENTS',
        comments: [{ id: `${prefix}-${i}`, userId: prefix, message: `comment ${i}`, createdAtMs: Date.now() }]
      })));
    }, prefix);
    const replies = await Promise.all([sendBatches(app.dashboard, 'a'), sendBatches(second, 'b')]);
    assert.ok(replies.flat().every(reply => reply.ok));
    const state = await app.dashboard.evaluate(() => chrome.storage.local.get('comments'));
    assert.deepEqual(state.comments.map(c => c.id).sort(),
      ['a', 'b'].flatMap(prefix => Array.from({ length: 20 }, (_, i) => `${prefix}-${i}`)).sort());
    const popup = await app.context.newPage();
    await popup.goto(app.dashboard.url().replace('dashboard.html', 'popup.html'));
    await popup.locator('#clear').click();
    await waitForStorage(app.dashboard, ['comments', 'lastCommentAt'],
      data => data.comments.length === 0 && data.lastCommentAt === null);
  } finally { await app.context.close(); }
});

for (const options of [
  { laterLabel: 'あとで', modalKind: 'semantic' },
  { laterLabel: '後で', modalKind: 'fixed' }
]) {
  test(`automatic startup dismisses ${options.laterLabel} in a ${options.modalKind} modal and records comments`, { timeout: 60000 }, async () => {
    const app = await extension(options);
    try {
      await start(app);
      const tab = app.context.pages().find(page => page.url() === TARGET);
      const opened = await waitForStorage(app.dashboard, 'commentPanelOpenStatus',
        state => state.commentPanelOpenStatus?.status === 'success');
      assert.equal(opened.commentPanelOpenStatus.dismissedLaterDialog, true);
      await tab.locator('#notice').waitFor({ state: 'hidden' });
      await tab.getByRole('textbox', { name: 'コメントを入力' }).waitFor({ state: 'visible' });
      const clicks = await tab.evaluate(() => window.fixture);
      assert.equal(clicks.laterClicks, 1);
      assert.equal(clicks.otherClicks, 0);
      assert.equal(clicks.primaryClicks, 0);
      assert.equal(clicks.commentClicks, 1);
      assert.ok(clicks.controlsRevealed > 0);
      const saved = await waitForStorage(app.dashboard, 'comments',
        state => state.comments?.some(comment => comment.id === 'fixture-comment'));
      assert.equal(saved.comments.find(comment => comment.id === 'fixture-comment').message, '自動記録で取得したコメント');
      // A later check must recognize the open panel instead of toggling it shut.
      await app.worker.evaluate(() => chrome.storage.local.remove('commentPanelOpenStatus'));
      await recording(app);
      await waitForStorage(app.dashboard, 'commentPanelOpenStatus',
        state => state.commentPanelOpenStatus?.status === 'success' && state.commentPanelOpenStatus.alreadyOpen);
      assert.equal(await tab.evaluate(() => fixture.commentClicks), 1);
      assert.equal(await tab.getByRole('textbox', { name: 'コメントを入力' }).isVisible(), true);
      await stop(app);
    } finally { await app.context.close(); }
  });
}
