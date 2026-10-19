const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { waitForStorage } = require('./helpers.cjs');

test('a real Chrome backup import needs consent before restoring recording', {timeout:60000}, async () => {
  const root = path.resolve(process.env.ABEMA_PACKAGE_SMOKE_DIR || path.join(__dirname, '../..'));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root]
  });
  try {
    const worker = context.serviceWorkers()[0] ||
      await context.waitForEvent('serviceworker', { timeout:15000 });
    const id = new URL(worker.url()).host;
    await waitForStorage(worker, 'captureEnabled', s => s.captureEnabled === false);
    await worker.evaluate(() => chrome.storage.local.set({
      captureEnabled: false,
      comments: [{ id:'original',userId:'old',message:'keep',createdAtMs:Date.now() }]
    }));
    const page = await context.newPage();
    await page.goto('chrome-extension://' + id + '/dashboard.html');
    await page.waitForFunction(() => document.getElementById('total').textContent === '1');

    const data = {
      format: 'abema-comment-analyzer-transfer',
      schemaVersion: 6,
      extensionVersion: '0.13.1',
      data: { captureEnabled:true, comments: [
        { id:'imported',userId:'new',message:'data',createdAtMs:Date.now() }
      ] }
    };
    const upload = { name:'backup.json', mimeType:'application/json',
      buffer:Buffer.from(JSON.stringify(data),'utf8') };
    let prompt = '';
    page.once('dialog', dialog => {
      prompt = dialog.message();
      dialog.dismiss();
    });
    await page.locator('#transferFile').setInputFiles(upload);
    await page.waitForFunction(() =>
      document.getElementById('transferStatus').textContent.includes('キャンセルしました'));
    assert.match(prompt, /コメント記録がON/);
    let state=await worker.evaluate(() => chrome.storage.local.get(['captureEnabled','comments']));
    assert.equal(state.captureEnabled,false);
    assert.equal(state.comments[0].id,'original');

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#transferFile').setInputFiles(upload);
    await waitForStorage(worker,['captureEnabled','comments'],s =>
      s.captureEnabled === true && s.comments?.[0]?.id === 'imported');
    state=await worker.evaluate(() => chrome.storage.local.get(['captureEnabled','comments']));
    assert.equal(state.comments[0].id,'imported');
  } finally {
    await context.close();
  }
});
