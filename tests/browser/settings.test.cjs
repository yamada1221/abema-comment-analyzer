const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

test('Chrome extension settings persist and clamp without changing tags or exclusions', async () => {
  const root = path.resolve(__dirname, '../..');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers()[0]
      || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    await worker.evaluate(() => chrome.storage.local.set({
      userTags: { identity: ['識別用'] }, mutedUsers: ['kept'],
      moderationSettings: { rateCount: 12, rateWindowSec: 120, whitelistUsers: ['allowed'] }
    }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    await page.waitForFunction(() => document.getElementById('rateCount').value === '12');
    assert.equal(await page.locator('#learningSelectedMatchThreshold').inputValue(), '70');

    for (const [input, expected] of [['55', 0.55], ['5', 0.1], ['150', 1]]) {
      await page.locator('#learningSelectedMatchThreshold').fill(input);
      await page.locator('#saveModeration').click();
      await page.waitForFunction(async value =>
        (await chrome.storage.local.get('moderationSettings')).moderationSettings.learningSelectedMatchThreshold === value, expected);
      await page.reload();
      await page.waitForFunction(value =>
        document.getElementById('learningSelectedMatchThreshold').value === value, String(expected * 100));
    }
    const state = await worker.evaluate(() => chrome.storage.local.get(['moderationSettings', 'userTags', 'mutedUsers']));
    assert.equal(state.moderationSettings.rateCount, 12);
    assert.equal(state.moderationSettings.rateWindowSec, 120);
    assert.deepEqual(state.moderationSettings.whitelistUsers, ['allowed']);
    assert.deepEqual(state.userTags, { identity: ['識別用'] });
    assert.deepEqual(state.mutedUsers, ['kept']);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
