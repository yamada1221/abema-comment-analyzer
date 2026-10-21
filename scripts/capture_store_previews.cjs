// Local review material only. Uses a disposable profile and fictional data;
// never opens ABEMA, reads a user's profile, or uploads images.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { waitForStorage } = require('../tests/browser/helpers.cjs');

const REPO = path.resolve(__dirname, '..');
const ROOT = path.resolve(REPO, process.env.ABEMA_PACKAGE_SMOKE_DIR || 'dist/review-unpacked');
const OUTPUT = path.join(REPO, 'test-results/store-previews');
const LABEL = '表示例：架空データ ・ 実放送の確認画像ではありません';

async function capture(page, name, section) {
  if (section) await page.locator(section).evaluate(element =>
    element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  else await page.evaluate(() => window.scrollTo(0, 0));
  const filename = path.join(OUTPUT, `${name}.png`);
  const png = await page.screenshot({ path: filename, animations: 'disabled' });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 800);
  return `${name}.png`;
}

async function label(page) {
  await page.evaluate(text => {
    const banner = document.createElement('div');
    banner.textContent = text;
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;' +
      'padding:10px 20px;background:#183149;color:#fff;border-top:1px solid #5d809e;' +
      'font:14px system-ui,sans-serif;text-align:center;pointer-events:none';
    document.body.append(banner);
    document.body.style.paddingBottom = '48px';
  }, LABEL);
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  await fs.mkdir(OUTPUT, { recursive: true });
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
  });
  const errors = [], files = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    await context.route('https://**/*', route => route.abort());
    const worker = context.serviceWorkers()[0] ||
      await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    await waitForStorage(worker, 'captureEnabled', state => state.captureEnabled === false);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    // Exercise the same file import that a reviewer can use without live ABEMA.
    page.once('dialog', async dialog => {
      assert.equal(dialog.type(), 'confirm');
      assert.ok(dialog.message().includes('上書き'));
      await dialog.accept();
    });
    await page.locator('#transferFile').setInputFiles(
      path.join(REPO, 'store-assets/reviewer-demo-v0.13.2.json'));
    await page.waitForFunction(() => document.getElementById('transferStatus').textContent.includes('引継ぎ完了'));
    await waitForStorage(worker, 'captureEnabled', state => state.captureEnabled === false);
    await waitForStorage(worker, 'autoProgramSettings', state => state.autoProgramSettings?.enabled === false);
    await page.waitForFunction(() => document.getElementById('total').textContent === '18');
    await label(page);
    files.push(await capture(page, '01-overview'));

    await page.locator('#commentQuery').fill('宇宙');
    await page.waitForFunction(() => document.getElementById('commentStatus').textContent.includes('6件一致'));
    files.push(await capture(page, '02-comment-search', '#commentExplorer'));

    await page.locator('#clearCommentSearch').click();
    await page.locator('tr[data-user="demo_user_03"] td').first().click();
    await page.locator('#userTagsInput').fill('科学, メモ');
    await page.locator('#saveUserTags').click();
    await page.locator('#detailMute').click();
    await waitForStorage(worker, 'mutedUsers', state => state.mutedUsers?.includes('demo_user_03'));
    files.push(await capture(page, '03-tags-and-mute', '#userAnalysis'));
    await page.locator('#detailMute').click();
    await waitForStorage(worker, 'mutedUsers', state => !state.mutedUsers?.includes('demo_user_03'));

    await page.locator('#loadReplay').click();
    for (let i = 0; i < 3; i++) await page.locator('#replayNext').click();
    await page.waitForFunction(() => document.getElementById('replayStatus').textContent.includes('4 / 18件'));
    files.push(await capture(page, '04-comment-replay', '#commentReplay'));

    const guide = await context.newPage();
    await guide.goto(`chrome-extension://${id}/guide.html`);
    await label(guide);
    files.push(await capture(guide, '05-first-use-guide'));
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(OUTPUT, 'review-metadata.json'), JSON.stringify({
      unpublished: true, fictionalData: true, liveBroadcastVerifiedByTheseImages: false,
      extensionVersion: manifest.version, chromiumVersion: context.browser().version(),
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
      sourceHasUncommittedChanges: !!execFileSync('git', ['status', '--porcelain'],
        { cwd: REPO, encoding: 'utf8' }).trim(),
      generatedAt: new Date().toISOString(), width: 1280, height: 800, files
    }, null, 2) + '\n');
    console.log(`Created ${files.length} unpublished, fictional-data previews in ${OUTPUT}`);
    console.log('No live ABEMA access; no upload or publication.');
  } finally {
    await context.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
