// Run with jsdom installed: node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

function storage(initial = {}) {
  const state = clone(initial), listeners = [], locks = new Map();
  return {
    state,
    listeners,
    local: {
      async get(keys) {
        const list = typeof keys === 'string' ? [keys] : keys || Object.keys(state);
        return clone(Object.fromEntries(list.filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]])));
      },
      async set(update) {
        const changes = {};
        for (const [key, value] of Object.entries(update)) {
          if (JSON.stringify(state[key]) !== JSON.stringify(value)) {
            changes[key] = { oldValue: state[key], newValue: clone(value) };
            state[key] = clone(value);
          }
        }
        for (const listener of listeners) listener(changes, 'local');
      }
    },
    lock(name, callback) {
      const next = (locks.get(name) || Promise.resolve()).then(callback);
      locks.set(name, next.catch(() => {}));
      return next;
    }
  };
}

async function dashboard(store) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8'), {
    url: 'https://extension.test/dashboard.html', runScripts: 'outside-only'
  });
  const w = dom.window;
  w.chrome = {
    storage: { local: store.local, onChanged: { addListener: listener => store.listeners.push(listener) } },
    runtime: { getManifest: () => ({ version: '0.10.0' }), sendMessage: message => w.ABEMAModerationStore.apply(message) }
  };
  Object.defineProperty(w.navigator, 'locks', { value: { request: store.lock } });
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillRect() {}, fillText() {} });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.confirm = () => true;
  for (const file of ['user-tags.js', 'learning-model.js', 'moderation-store.js', 'dashboard.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  await settle();
  assert.equal(w.document.getElementById('versionInfo').textContent, 'v0.10.0 / 保存形式 3');
  assert.doesNotMatch(w.document.getElementById('transferStatus').textContent, /失敗/);
  const el = id => w.document.getElementById(id);
  const input = value => { el('userTagsInput').value = value; el('userTagsInput').dispatchEvent(new w.Event('input')); };
  return { w, el, input, close: () => w.close() };
}

function fixture() {
  const now = Date.now();
  return storage({
    storageSchemaVersion: 1, installedExtensionVersion: '0.7.0',
    comments: [
      { id: 'a', userId: 'user-a', message: 'test A', createdAtMs: now - 2000 },
      { id: 'b', userId: 'user-b', message: 'test B', createdAtMs: now - 1000 }
    ],
    mutedUsers: ['muted-existing'], moderationSettings: { ngWords: ['existing'] },
    captureEnabled: true, autoProgramSettings: { enabled: false, keyword: '番組' }
  });
}

test('upgrade, edit, filter, refresh, export and expiry preserve user data', async () => {
  const store = fixture(), page = await dashboard(store);
  const { w, el, input } = page;
  try {
    assert.equal(store.state.storageSchemaVersion, 3);
    w.selectUser('user-a');
    input(' 要観察、定型文,要観察');
    await w.saveUserTags();
    await settle();
    assert.deepEqual(store.state.userTags['user-a'], ['要観察', '定型文']);
    assert.deepEqual(store.state.mutedUsers, ['muted-existing']);
    assert.equal(store.state.captureEnabled, true);
    assert.deepEqual(store.state.moderationSettings.ngWords, ['existing']);
    assert.equal(w.document.querySelectorAll('[data-user="user-a"] .user-tag').length, 2);
    el('tagFilter').value = 'tag:要観察'; el('tagFilter').onchange();
    assert.equal(w.document.querySelectorAll('#usersBody tr').length, 1);
    input('編集中');
    await store.local.set({ comments: [...store.state.comments, { id: 'c', userId: 'user-b', message: 'new', createdAtMs: Date.now() }] });
    await settle();
    assert.equal(el('userTagsInput').value, '編集中');
    await el('resetUserTags').onclick();
    const downloads = [];
    w.download = (name, text, type) => downloads.push({ name, text, type });
    el('exportJson').onclick();
    assert.deepEqual(JSON.parse(downloads.at(-1).text).find(c => c.userId === 'user-a').userTags, ['要観察', '定型文']);
    el('exportCsv').onclick();
    assert.match(downloads.at(-1).text, /^time,userId,message,pageTitle,userTags/);
    await w.exportTransfer();
    const payload = JSON.parse(downloads.at(-1).text);
    assert.equal(payload.schemaVersion, 3);
    assert.deepEqual(payload.data.userTags, store.state.userTags);
    await store.local.set({ comments: [] });
    await settle();
    assert.equal(w.document.querySelectorAll('#usersBody tr').length, 1);
    assert.equal(el('total').textContent, '0');
    assert.equal(el('unique').textContent, '0');
    assert.deepEqual(store.state.userTags['user-a'], ['要観察', '定型文']);
    assert.match(el('detailComments').textContent, /分析時間内のコメントはありません/);
    el('clearUserTags').onclick();
    assert.ok(store.state.userTags['user-a']);
    await w.saveUserTags(); await settle();
    assert.equal(Object.hasOwn(store.state.userTags, 'user-a'), false);
    assert.equal(w.document.querySelectorAll('#usersBody tr').length, 0);
    await w.importTransferFile({ text: async () => JSON.stringify(payload) }); await settle();
    assert.deepEqual(store.state.userTags['user-a'], ['要観察', '定型文']);
  } finally { page.close(); }
});

test('old transfers keep tags and invalid new transfers do not partially overwrite storage', async () => {
  const store = fixture(); store.state.userTags = { 'user-a': ['keep'] };
  const page = await dashboard(store);
  try {
    await page.w.importTransferFile({ text: async () => JSON.stringify({ format: 'abema-comment-analyzer-transfer', schemaVersion: 1, data: { mutedUsers: ['imported'] } }) });
    assert.deepEqual(store.state.userTags, { 'user-a': ['keep'] });
    assert.deepEqual(store.state.mutedUsers, ['imported']);
    const before = clone(store.state);
    await page.w.importTransferFile({ text: async () => JSON.stringify({ format: 'abema-comment-analyzer-transfer', schemaVersion: 2, data: { mutedUsers: [], userTags: { broken: [42] } } }) });
    assert.match(page.el('transferStatus').textContent, /失敗/);
    assert.deepEqual(store.state, before);
  } finally { page.close(); }
});

test('two dashboards retain edits to different users and detect same-user conflicts', async () => {
  const store = fixture(), a = await dashboard(store), b = await dashboard(store);
  try {
    a.w.selectUser('user-a'); a.input('A');
    b.w.selectUser('user-b'); b.input('B');
    await Promise.all([a.w.saveUserTags(), b.w.saveUserTags()]); await settle();
    assert.deepEqual(store.state.userTags, { 'user-a': ['A'], 'user-b': ['B'] });
    b.w.selectUser('user-a');
    a.input('first'); b.input('second');
    await a.w.saveUserTags(); await settle();
    assert.equal(b.el('userTagsInput').value, 'second');
    await b.w.saveUserTags();
    assert.match(b.el('tagStatus').textContent, /別の画面/);
    assert.deepEqual(store.state.userTags['user-a'], ['first']);
    await b.el('resetUserTags').onclick();
    assert.equal(b.el('userTagsInput').value, 'first');
  } finally { a.close(); b.close(); }
});

test('arbitrary IDs, HTML-looking tags, presets and validation are safe in the UI', async () => {
  const store = fixture(), page = await dashboard(store);
  const { w, el, input } = page;
  try {
    el('tagUserId').value = '__proto__';
    el('openTagUser').dispatchEvent(new w.Event('submit', { cancelable: true }));
    input('<img src=x onerror=alert(1)>');
    await w.saveUserTags(); await settle();
    el('tagFilter').value = 'tagged'; el('tagFilter').onchange();
    assert.equal(w.document.querySelectorAll('#usersBody img').length, 0);
    assert.match(el('usersBody').textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(Object.getPrototypeOf(store.state.userTags), Object.prototype);
    input('x'.repeat(33)); await w.saveUserTags();
    assert.match(el('tagStatus').textContent, /32文字/);
    assert.deepEqual(store.state.userTags.__proto__, ['<img src=x onerror=alert(1)>']);
    input('');
    w.document.querySelector('[data-tag-preset="要観察"]').click();
    w.document.querySelector('[data-tag-preset="要観察"]').click();
    assert.equal(el('userTagsInput').value, '要観察');
    await w.saveUserTags(); await settle();
    el('search').value = '要観察'; el('search').oninput();
    assert.equal(w.document.querySelectorAll('#usersBody tr').length, 1);
  } finally { page.close(); }
});

test('learning memory survives transfer and old backups; imports remove ineligible samples', async () => {
  const store=fixture();
  store.state.learningMemory={version:1,samples:[{userId:'muted-existing',message:'test',createdAtMs:Date.now()}]};
  const page=await dashboard(store);
  try {
    let payload;
    page.w.download=(_name,text)=>{payload=JSON.parse(text);};
    await page.w.exportTransfer();
    assert.equal(payload.data.learningMemory.samples.length,1);
    await store.local.set({learningMemory:{version:1,samples:[]}});
    await page.w.importTransferFile({text:async()=>JSON.stringify(payload)});
    assert.equal(store.state.learningMemory.samples.length,1);
    await page.w.importTransferFile({text:async()=>JSON.stringify({format:'abema-comment-analyzer-transfer',schemaVersion:2,data:{userTags:{}}})});
    assert.equal(store.state.learningMemory.samples.length,1);
    payload.data.mutedUsers=[];
    await page.w.importTransferFile({text:async()=>JSON.stringify(payload)});
    assert.equal(store.state.learningMemory.samples.length,0);
  } finally {page.close();}
});

test('cancel filtered automatic mutes, preserve unrelated users, reject stale re-mutes and transfer the correction', async()=>{
  const store=fixture(), time=Date.parse('2026-09-25T15:29:00Z');
  store.state.mutedUsers=['target','other'];
  store.state.learningAutoMutedUsers=['target'];
  store.state.moderationSettings={enabled:true,learningEnabled:true,learningAutoMute:true,whitelistUsers:[]};
  store.state.autoMuteLog=[
    {userId:'target',reason:'高頻度投稿 8件/120秒',mutedAt:time,message:'sample'},
    {userId:'target',reason:'高頻度投稿 8件/120秒',mutedAt:time-60000,message:'sample'},
    {userId:'other',reason:'NGワード',mutedAt:time,message:'sample'}];
  store.state.learningMemory={version:1,samples:[{userId:'target',message:'sample',createdAtMs:Date.now()}]};
  const page=await dashboard(store);
  try {
    page.el('muteLogReason').value='高頻度投稿';page.el('muteLogReason').onchange();
    page.el('muteLogDate').value='2026-09-26';page.el('muteLogDate').onchange();
    assert.equal(page.w.document.querySelectorAll('[data-revoke-mute]').length,2);
    page.el('selectMuteLog').onclick();
    assert.equal(page.el('revokeSelectedMutes').disabled,false);
    page.w.confirm=()=>false;await page.el('revokeSelectedMutes').onclick();
    assert.equal(store.state.mutedUsers.length,2);
    page.w.confirm=()=>true;await page.el('revokeSelectedMutes').onclick();await settle();
    assert.deepEqual(store.state.mutedUsers,['other']);
    assert.deepEqual(store.state.learningAutoMutedUsers,[]);
    assert.deepEqual(store.state.moderationSettings.whitelistUsers,['target']);
    assert.equal(store.state.learningMemory.samples.length,0);
    assert.equal(store.state.autoMuteLog.filter(x=>x.revokedAt).length,2);
    assert.match(page.el('revokeMuteStatus').textContent,/1人/);
    const stale=await page.w.ABEMAModerationStore.apply({type:'APPLY_AUTO_MUTE',entries:[{userId:'target',reason:'高頻度投稿'}, {userId:'target',learned:true,reason:'学習型ミュート'}]});
    assert.equal(stale.count,0);
    const repeat=await page.w.ABEMAModerationStore.apply({type:'REVOKE_AUTO_MUTE',userIds:['target']});
    assert.equal(repeat.count,0);
    let payload;page.w.download=(_name,text)=>payload=JSON.parse(text);await page.w.exportTransfer();
    assert.equal(payload.data.autoMuteLog.filter(x=>x.revokedAt).length,2);
    assert.deepEqual(payload.data.moderationSettings.whitelistUsers,['target']);
  } finally {page.close();}
});

test('concurrent automatic mute and cancellation never undo the exclusion',async()=>{
  const store=fixture();store.state.moderationSettings={enabled:true};
  store.state.mutedUsers=['target'];store.state.autoMuteLog=[{userId:'target',reason:'高頻度投稿',mutedAt:Date.now()}];
  const page=await dashboard(store);
  try {
    await Promise.all([
      page.w.ABEMAModerationStore.apply({type:'REVOKE_AUTO_MUTE',userIds:['target']}),
      page.w.ABEMAModerationStore.apply({type:'APPLY_AUTO_MUTE',entries:[{userId:'target',reason:'高頻度投稿'},{userId:'new-user',reason:'NGワード'}]})
    ]);
    assert.deepEqual(store.state.mutedUsers,['new-user']);
    assert.deepEqual(store.state.moderationSettings.whitelistUsers,['target']);
  }finally{page.close();}
});

test('browse earlier days and a fixed JST time without incoming comments moving the range', async()=>{
  const store=fixture();
  const oldest=Date.parse('2026-09-20T15:30:00Z'), latest=Date.parse('2026-09-28T15:30:00Z');
  store.state.comments=[{id:'old',userId:'user-a',message:'earlier day',createdAtMs:oldest},{id:'latest',userId:'user-a',message:'latest day',createdAtMs:latest}];
  const page=await dashboard(store);
  try {
    assert.equal(page.el('total').textContent,'1');
    await page.el('showAllHistory').onclick();
    assert.equal(page.el('total').textContent,'2');
    assert.equal(page.el('windowUnit').value,'1440');
    page.el('historyAnchor').value='2026-09-21T01:00';
    page.el('windowValue').value='1';page.el('windowUnit').value='60';
    await page.el('applyWindow').onclick();
    assert.equal(page.el('total').textContent,'1');
    page.w.selectUser('user-a');
    assert.match(page.el('detailComments').textContent,/2026\/9\/21/);
    assert.match(page.el('detailComments').textContent,/earlier day/);
    await store.local.set({comments:[...store.state.comments,{id:'incoming',userId:'new',message:'later',createdAtMs:latest+60000}]});await settle();
    assert.equal(page.el('total').textContent,'1');
    assert.match(page.el('detailComments').textContent,/earlier day/);
    let exported;page.w.download=(_name,text)=>exported=JSON.parse(text);
    page.el('exportJson').onclick();assert.equal(exported[0].id,'old');
  } finally {page.close();}
});
