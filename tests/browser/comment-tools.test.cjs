const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const {chromium}=require('playwright');
const {waitForStorage}=require('./helpers.cjs');
const root=path.resolve(__dirname,'../..');
async function extension() {
  const context=await chromium.launchPersistentContext('',{
    channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],
    args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(worker.url()).host;
  return {context,worker,id};
}
async function screenshot(page,name) {
  if(!process.env.ABEMA_SCREENSHOT_DIR)return;
  await fs.mkdir(process.env.ABEMA_SCREENSHOT_DIR,{recursive:true});
  await page.screenshot({path:path.join(process.env.ABEMA_SCREENSHOT_DIR,`${name}.png`)});
}
test('comment search, label settings, replay and narrow layouts work as an installed extension',async()=>{
  const {context,worker,id}=await extension();
  try {
    const now=Date.now()-30000;
    await worker.evaluate(({now})=>chrome.storage.local.set({captureEnabled:false,userTags:{a:['識別用']},comments:[
      {id:'a',userId:'a',message:'地震 XX <script>test</script>',createdAtMs:now,pageTitle:'検証番組'},
      {id:'b',userId:'a',message:'通常コメント',createdAtMs:now+10000,pageTitle:'検証番組'},
      {id:'c',userId:'b'.repeat(120),message:'地震 ｘｘ？',createdAtMs:now+20000,pageTitle:'長い番組名'.repeat(20)}
    ]}),{now});
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    await page.waitForFunction(()=>document.getElementById('total').textContent==='3');
    await page.locator('#commentQuery').fill('xx');
    await page.waitForFunction(()=>document.getElementById('commentStatus').textContent.includes('2件一致'));
    assert.equal(await page.locator('#commentResults article').count(),2);
    assert.doesNotMatch(await page.locator('#commentResults').innerText(),/通常コメント/);
    assert.equal(await page.locator('#commentResults script').count(),0);
    assert.equal(await page.locator('#commentResults mark').count(),2);
    await page.locator('.label-settings summary').click();
    await page.locator('#autoLabelRules').fill('災害情報: 地震, 津波');
    await page.locator('#saveAutoLabels').click();
    await waitForStorage(page,'autoLabelSettings',state=>state.autoLabelSettings?.rules[0]?.label==='災害情報');
    await page.locator('#autoLabelFilter').selectOption('災害情報');
    for(const [width,height] of [[1440,1000],[900,900],[390,844]]) {
      await page.setViewportSize({width,height});
      await page.locator('#commentExplorer').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`overflow at ${width}`);
      await screenshot(page,`comments-${width}`);
    }
    await page.locator('#loadReplay').click();
    await page.locator('#replayNext').click();
    await page.waitForFunction(()=>document.getElementById('replayStatus').textContent.includes('2 / 2件'));
    await page.locator('#replayRestart').click();
    await page.locator('#replaySpeed').selectOption('60');
    await page.locator('#replayPlay').click();
    await page.waitForFunction(()=>document.getElementById('replayStatus').textContent.includes('再生終了'));
    await page.locator('#commentReplay').scrollIntoViewIfNeeded();await screenshot(page,'replay-390');
    const tag=await worker.evaluate(()=>chrome.storage.local.get('userTags'));assert.deepEqual(tag.userTags,{a:['識別用']});
    await page.locator('#emojiEnabled').scrollIntoViewIfNeeded();await screenshot(page,'moderation-390');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test('background capture protects tabs, saves received comments and supports reversible emoji mutes',async()=>{
  const {context,worker,id}=await extension();
  try {
    await worker.evaluate(()=>chrome.storage.local.set({captureEnabled:true,moderationSettings:{enabled:true,
      emojiEnabled:true,emojiCount:3,emojiWindowSec:120,rateEnabled:false,duplicateEnabled:false,ngEnabled:false,whitelistUsers:['allowed']}}));
    await context.route('https://abema.tv/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><title>模擬放送</title></head><body>Mock ABEMA</body></html>'}));
    const abema=await context.newPage();await abema.goto('https://abema.tv/now-on-air/abema-news');
    const dashboard=await context.newPage();await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
    await waitForStorage(dashboard,'backgroundCaptureStatus',s=>s.backgroundCaptureStatus?.connected===1);
    assert.equal(await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'https://abema.tv/*'});return tab.autoDiscardable;}),false);
    await dashboard.bringToFront();
    await abema.evaluate(()=>{
      const now=Date.now();for(const userId of ['emoji-user','allowed','normal-user'])for(let i=0;i<3;i++) {
        window.postMessage({source:'abema-comment-analyzer',type:'COMMENT',payload:{id:`${userId}-${i}`,userId,
          message:userId==='normal-user'&&i===0?'通常文':'\u{1F600}',createdAtMs:now-2000+i*1000,timestampReliable:true}},'*');
      }
    });
    await waitForStorage(dashboard,['comments','mutedUsers'],s=>s.comments?.length===9&&s.mutedUsers?.includes('emoji-user'));
    const state=await worker.evaluate(()=>chrome.storage.local.get(['mutedUsers','autoMuteLog']));
    assert.deepEqual(state.mutedUsers,['emoji-user']);assert.match(state.autoMuteLog[0].reason,/絵文字のみ 3件/);
    const undo=await dashboard.evaluate(()=>chrome.runtime.sendMessage({source:'abema-comment-analyzer',type:'REVOKE_AUTO_MUTE',userIds:['emoji-user']}));
    assert.equal(undo.count,1);
    await worker.evaluate(()=>chrome.storage.local.set({captureEnabled:false}));
    await waitForStorage(dashboard,'backgroundCaptureStatus',s=>s.backgroundCaptureStatus?.enabled===false);
    assert.equal(await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'https://abema.tv/*'});return tab.autoDiscardable;}),true);
  }finally{await context.close();}
});
