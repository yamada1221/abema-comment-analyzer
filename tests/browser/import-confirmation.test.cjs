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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('chrome-extension://' + id + '/dashboard.html');
    await page.waitForFunction(() => document.getElementById('total').textContent === '1');

    const data = {
      format: 'abema-comment-analyzer-transfer',
      schemaVersion: 6,
      extensionVersion: '0.13.1',
      data: { captureEnabled:true, comments: [
        { id:'imported',commentId:'chat-id',userId:'new',message:'学習元として指定するコメント',createdAtMs:Date.now() }
      ] }
    };
    const protectedKeys = ['comments', 'captureEnabled', 'userTags', 'mutedUsers',
      'moderationSettings', 'autoProgramSettings', 'lastTransferImportAt'];
    const before = await worker.evaluate(keys => chrome.storage.local.get(keys), protectedKeys);
    let unexpectedPrompts = 0;
    const dismissUnexpected = dialog => { unexpectedPrompts++; return dialog.dismiss(); };
    page.on('dialog', dismissUnexpected);
    for (const metadata of [{pageUrl:123}, {pageTitle:{}}, {id:[]}, {timestampReliable:'false'}]) {
      const invalid = { ...data, data: { ...data.data, mutedUsers: [], userTags: {},
        comments: [{ ...data.data.comments[0], ...metadata }] } };
      await page.evaluate(() => { document.getElementById('transferStatus').textContent = ''; });
      await page.locator('#transferFile').setInputFiles({ name:'invalid.json', mimeType:'application/json',
        buffer:Buffer.from(JSON.stringify(invalid),'utf8') });
      await page.waitForFunction(() =>
        document.getElementById('transferStatus').textContent.includes('引継ぎに失敗'));
      assert.deepEqual(await worker.evaluate(keys => chrome.storage.local.get(keys), protectedKeys), before);
    }
    page.off('dialog', dismissUnexpected);
    assert.equal(unexpectedPrompts, 0);
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
    await page.locator('tr[data-user="new"]').click();
    await page.locator('[data-learncomment]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-learncomment]')?.textContent === '学習指定を解除');
    const selected = await waitForStorage(worker, 'learningSelectedSamples', s =>
      s.learningSelectedSamples?.samples.length === 1);
    assert.equal(selected.learningSelectedSamples.samples[0].commentId, 'chat-id');
    await page.locator('[data-learncomment]').click();
    await waitForStorage(worker, 'learningSelectedSamples', s =>
      s.learningSelectedSamples?.samples.length === 0);
    await page.waitForFunction(() =>
      document.querySelector('[data-learncomment]')?.textContent === 'このコメントを学習');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
