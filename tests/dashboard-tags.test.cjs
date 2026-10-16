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
    runtime: { getManifest: () => ({ version: '0.11.0' }), sendMessage: message => w.ABEMAModerationStore.apply(message) }
  };
  Object.defineProperty(w.navigator, 'locks', { value: { request: store.lock } });
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillRect() {}, fillText() {} });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.confirm = () => true;
  for (const file of ['user-tags.js', 'learning-model.js', 'moderation-store.js', 'auto-program-schedules.js', 'comment-tools.js', 'auto-user-tags.js', 'dashboard-explorer.js', 'dashboard.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  await settle();
  assert.equal(w.document.getElementById('versionInfo').textContent, 'v0.11.0 / 保存形式 6');
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

test('select and revoke one comment, retain it after history expiry, and transfer it', async () => {
  const store=fixture(),page=await dashboard(store);
  const {w,el}=page;
  const initialMuted=clone(store.state.mutedUsers),initialSettings=clone(store.state.moderationSettings);
  try {
    w.selectUser('user-a');
    const button=w.document.querySelector('[data-learncomment]');
    button.focus();await button.onclick();await settle();
    assert.equal(store.state.learningSelectedSamples.samples.length,1);
    assert.equal(store.state.learningSelectedSamples.samples[0].message,'test A');
    assert.deepEqual(store.state.mutedUsers,initialMuted);
    assert.deepEqual(store.state.moderationSettings,initialSettings);
    assert.equal(w.document.activeElement.dataset.learncomment,'0');
    assert.equal(w.document.querySelector('[data-learncomment]').textContent,'学習指定を解除');
    let exported;w.download=(_name,text)=>exported=JSON.parse(text);
    await w.exportTransfer();
    assert.equal(exported.schemaVersion,6);assert.equal(exported.data.learningSelectedSamples.samples.length,1);
    await store.local.set({comments:[]});await settle();
    assert.equal(store.state.learningSelectedSamples.samples.length,1);
    assert.match(el('learningSelectedList').textContent,/test A/);
    await w.document.querySelector('[data-selected-remove]').onclick();await settle();
    assert.equal(store.state.learningSelectedSamples.samples.length,0);
    await w.importTransferFile({text:async()=>JSON.stringify(exported)});await settle();
    assert.equal(store.state.learningSelectedSamples.samples.length,1);
    const before=JSON.stringify(store.state);
    exported.data.learningSelectedSamples={version:1,samples:[null]};
    await w.importTransferFile({text:async()=>JSON.stringify(exported)});
    assert.match(el('transferStatus').textContent,/失敗/);
    assert.equal(JSON.stringify(store.state),before);
  } finally {page.close();}
});

test('old backups retain selected examples; concurrent tabs serialize additions and removals', async () => {
  const store=fixture(),a=await dashboard(store),b=await dashboard(store);
  try {
    a.w.selectUser('user-a');b.w.selectUser('user-b');
    await Promise.all([a.w.document.querySelector('[data-learncomment]').onclick(),b.w.document.querySelector('[data-learncomment]').onclick()]);
    await settle();
    assert.equal(store.state.learningSelectedSamples.samples.length,2);
    const sample=store.state.learningSelectedSamples.samples[0];
    await Promise.all([a.w.ABEMAModerationStore.apply({type:'SELECT_LEARNING_COMMENT',commentKey:sample.key}),b.w.ABEMAModerationStore.apply({type:'SELECT_LEARNING_COMMENT',commentKey:sample.key})]);
    assert.equal(store.state.learningSelectedSamples.samples.length,2);
    await a.w.importTransferFile({text:async()=>JSON.stringify({format:'abema-comment-analyzer-transfer',schemaVersion:3,data:{mutedUsers:[]}})});await settle();
    assert.equal(store.state.learningSelectedSamples.samples.length,2);
    await a.w.ABEMAModerationStore.apply({type:'REMOVE_LEARNING_COMMENT',commentKey:sample.key});await settle();
    assert.equal(store.state.learningSelectedSamples.samples.length,1);
    assert.match(b.el('learningSelectedCount').textContent,/1 \/ 200/);
  } finally {a.close();b.close();}
});

test('selected-example recommendation displays source and matching posts without changing settings', async () => {
  const now=Date.now()-1000;
  const c=(id,userId,message)=>({id,userId,message,createdAtMs:now});
  const selectedPost=c('source','source','独自の定型煽りを繰り返す投稿');
  const store=storage({comments:[selectedPost,c('a','target',selectedPost.message),c('b','target',selectedPost.message),c('c','target','普通の実況')],mutedUsers:[],moderationSettings:{learningEnabled:true,learningMinComments:3,learningAutoMute:false}});
  const page=await dashboard(store);
  try {
    page.w.selectUser('source');
    await page.w.document.querySelector('[data-learncomment]').onclick();await settle();
    assert.match(page.el('learningStatus').textContent,/指定したコメント 1件/);
    assert.equal(page.w.document.querySelector('[data-learnmute]').dataset.learnmute,'target');
    assert.match(page.el('learningCandidates').textContent,/一致した投稿 2件/);
    assert.match(page.el('learningCandidates').textContent,/学習元 source/);
    assert.equal(store.state.mutedUsers.length,0);
    assert.equal(store.state.moderationSettings.learningAutoMute,false);
    await page.w.document.querySelector('[data-selected-remove]').onclick();await settle();
    assert.equal(page.w.document.querySelectorAll('[data-learnmute]').length,0);
    assert.match(page.el('learningStatus').textContent,/最低 3 人必要/);
  } finally {page.close();}
});

test('HTML-looking selected comments are escaped in detail and saved-example list', async () => {
  const store=fixture();store.state.comments[0].message='<img src=x onerror=alert(1)>';
  const page=await dashboard(store);
  try {
    page.w.selectUser('user-a');await page.w.document.querySelector('[data-learncomment]').onclick();await settle();
    assert.equal(page.w.document.querySelectorAll('#detailComments img,#learningSelectedList img').length,0);
    assert.match(page.el('learningSelectedList').textContent,/<img src=x onerror=alert\(1\)>/);
  } finally {page.close();}
});

test('upgrade, edit, filter, refresh, export and expiry preserve user data', async () => {
  const store = fixture(), page = await dashboard(store);
  const { w, el, input } = page;
  try {
    assert.equal(store.state.storageSchemaVersion, 6);
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
    assert.equal(payload.schemaVersion, 6);
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

test('malformed transfers never overwrite any existing data', async t => {
  const invalid = [
    ['comments object', { comments: {} }],
    ['null comment', { comments: [null] }],
    ['comment message', { comments: [{ userId: 'u', message: {} }] }],
    ['mute list', { mutedUsers: 'u' }],
    ['mute entry', { mutedUsers: [null] }],
    ['automatic mute list', { learningAutoMutedUsers: {} }],
    ['settings object', { moderationSettings: [] }],
    ['NG words', { moderationSettings: { ngWords: 'word' } }],
    ['whitelist', { moderationSettings: { whitelistUsers: {} } }],
    ['enabled flag', { moderationSettings: { enabled: 'false' } }],
    ['numeric threshold', { moderationSettings: { rateCount: {} } }],
    ['log entry', { autoMuteLog: [null] }],
    ['capture flag', { captureEnabled: 'false' }],
    ['analysis window', { analysisWindowMinutes: {} }],
    ['last capture time', { lastCommentAt: {} }],
    ['program settings', { autoProgramSettings: [] }],
    ['program days', { autoProgramSettings: { days: '1,2' } }],
    ['program URL', { autoProgramSettings: { url: 'https://example.org' } }],
    ['NEWS enabled flag', { autoProgramSettings: { newsEnabled: 'false' } }],
    ['CNNj start time', { autoProgramSettings: { cnnStartTime: '25:00' } }],
    ['memory shape', { learningMemory: { version: 1, samples: {} } }],
    ['memory entry', { learningMemory: { version: 1, samples: [null] } }]
  ];
  for (const [name, data] of invalid) await t.test(name, async () => {
    const store = fixture(), page = await dashboard(store);
    // Exercise the import entry point itself, without unrelated change listeners.
    store.listeners.length = 0;
    const before = clone(store.state);
    try {
      await page.w.importTransferFile({ text: async () => JSON.stringify({
        format: 'abema-comment-analyzer-transfer', schemaVersion: 4,
        data: { userTags: { imported: ['must not persist'] }, ...data }
      }) });
      assert.match(page.el('transferStatus').textContent, /失敗/);
      assert.deepEqual(store.state, before);
    } finally { page.close(); }
  });
});

test('old auto-start settings retain the custom program while new daily presets can be disabled and transferred', async () => {
  const oldSettings = { enabled: false, keyword: '保存済みの番組',
    url: 'https://abema.tv/now-on-air/abema-news', days: [1, 3], startTime: '22:00', endTime: '23:00' };
  const store = storage({ autoProgramSettings: oldSettings });
  const page = await dashboard(store);
  try {
    assert.equal(page.el('autoProgramEnabled').checked, false);
    assert.equal(page.el('autoProgramKeyword').value, oldSettings.keyword);
    assert.equal(page.el('autoProgramStart').value, '22:00');
    assert.equal(page.el('autoProgramNewsEnabled').checked, true);
    assert.equal(page.el('autoProgramNewsStart').value, '00:01');
    assert.equal(page.el('autoProgramNewsEnd').value, '01:20');
    assert.equal(page.el('autoProgramCnnEnabled').checked, true);
    assert.equal(page.el('autoProgramCnnStart').value, '16:00');
    assert.equal(page.el('autoProgramCnnEnd').value, '16:20');
    page.w.chrome.runtime.sendMessage = async () => ({ ok: true });
    page.el('autoProgramNewsEnabled').checked = false;
    page.el('autoProgramCnnStart').value = '16:02';
    await page.el('saveAutoProgram').onclick();
    await settle();
    assert.equal(store.state.autoProgramSettings.newsEnabled, false);
    assert.equal(store.state.autoProgramSettings.cnnStartTime, '16:02');
    assert.deepEqual(store.state.autoProgramSettings.days, [1, 3]);
    assert.equal(store.state.autoProgramSettings.keyword, oldSettings.keyword);
    let exported;
    page.w.download = (_name, text) => { exported = JSON.parse(text); };
    await page.w.exportTransfer();
    assert.deepEqual(exported.data.autoProgramSettings, store.state.autoProgramSettings);
    const saved = clone(store.state.autoProgramSettings);
    await store.local.set({ autoProgramSettings: { ...saved, newsEnabled: true } });
    await page.w.importTransferFile({ text: async () => JSON.stringify(exported) });
    assert.deepEqual(store.state.autoProgramSettings, saved);
  } finally { page.close(); }
});

test('complete backups round-trip settings while malformed envelopes leave storage unchanged', async () => {
  const store = fixture(), page = await dashboard(store);
  try {
    await page.el('saveModeration').onclick();
    await page.el('saveAutoProgram').onclick();
    await store.local.set({ lastCommentAt: null, learningMemory: null,
      learningAutoMutedUsers: [], analysisWindowMinutes: 1440 });
    let payload;
    page.w.download = (_name, text) => { payload = JSON.parse(text); };
    await page.w.exportTransfer();
    await page.w.importTransferFile({ text: async () => JSON.stringify(payload) });
    assert.match(page.el('transferStatus').textContent, /引継ぎ完了/);
    for (const key of ['comments', 'mutedUsers', 'moderationSettings', 'autoProgramSettings',
      'captureEnabled', 'lastCommentAt', 'analysisWindowMinutes']) {
      assert.deepEqual(store.state[key], payload.data[key], key);
    }
    const before = clone(store.state);
    for (const patch of [{ data: [] }, { data: null }, { schemaVersion: 'broken' },
      { schemaVersion: -1 }, { schemaVersion: 4.5 }, { schemaVersion: 7 }]) {
      await page.w.importTransferFile({ text: async () => JSON.stringify({ ...payload, ...patch }) });
      assert.match(page.el('transferStatus').textContent, /失敗/);
      assert.deepEqual(store.state, before);
    }
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
    el('userSearch').value = '要観察'; el('userSearch').oninput();
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

test('comment search isolates matching posts, escapes markup, and paginates without losing results', async () => {
  const store=fixture(),page=await dashboard(store);
  try {
    const now=Date.now();
    await store.local.set({comments:[...Array.from({length:205},(_,i)=>({id:String(i),userId:'same',message:i%2?'ordinary':`XX ${i}`,createdAtMs:now-i})),
      {id:'markup',userId:'same',message:'XX <img src=x onerror=alert(1)>',createdAtMs:now}]});await settle();
    assert.equal(page.el('commentResults').querySelectorAll('article').length,100);
    page.el('commentQuery').value='xx';page.el('commentQuery').oninput();await new Promise(resolve=>setTimeout(resolve,200));
    assert.match(page.el('commentStatus').textContent,/104件一致/);
    assert.doesNotMatch(page.el('commentResults').textContent,/ordinary/);
    assert.equal(page.el('commentResults').querySelector('img'),null);
    assert.ok(page.el('commentResults').querySelector('mark'));
    page.el('commentNext').onclick();assert.equal(page.el('commentResults').querySelectorAll('article').length,4);
    let exported;page.w.download=(_name,text)=>exported=JSON.parse(text);
    page.el('exportCommentResults').onclick();assert.equal(exported.length,104);
    assert.ok(exported.every(c=>c.message.toLowerCase().includes('xx')));
  } finally {page.close();}
});
test('automatic user tags integrate with existing tags, search, exports and transfer',async()=>{
  const store=fixture();store.state.userTags={'user-a':['identity']};
  const page=await dashboard(store);
  try {
    page.el('autoTagRules').value='指定語: test A';page.el('autoTagRules').oninput();
    await page.el('saveAutoTags').onclick();await settle();
    assert.deepEqual(store.state.userTags,{'user-a':['identity','指定語']});
    page.el('tagFilter').value='tag:指定語';page.el('tagFilter').onchange();
    assert.equal(page.el('usersBody').querySelectorAll('tr').length,1);
    page.w.selectUser('user-a');assert.equal(page.el('userTagsInput').value,'identity, 指定語');
    assert.doesNotMatch(page.w.document.body.textContent,/疑問表現|自動ラベル/);
    page.el('commentTagFilter').value='指定語';page.el('commentTagFilter').onchange();
    assert.equal(page.el('commentResults').querySelectorAll('article').length,1);
    assert.match(page.el('commentResults').textContent,/test A/);
    let exported;page.w.download=(_name,text)=>exported=JSON.parse(text);await page.w.exportTransfer();
    assert.equal(exported.data.autoTagSettings.rules[0].tag,'指定語');
    await page.w.importTransferFile({text:async()=>JSON.stringify({format:'abema-comment-analyzer-transfer',schemaVersion:4,data:{mutedUsers:[]}})});
    assert.equal(store.state.autoTagSettings.rules[0].tag,'指定語');
    const before=JSON.stringify(store.state);exported.data.autoTagSettings.rules=[{tag:'x',keywords:[null]}];
    await page.w.importTransferFile({text:async()=>JSON.stringify(exported)});
    assert.match(page.el('transferStatus').textContent,/失敗/);assert.equal(JSON.stringify(store.state),before);
  }finally{page.close();}
});
test('legacy rules migrate and removing an automatic tag survives capture, reload and transfer',async()=>{
  const store=fixture();
  store.state.userTags={'user-a':['identity']};
  store.state.autoLabelSettings={enabled:true,rules:[{label:'指定語',keywords:['test A']}]};
  const page=await dashboard(store);
  try {
    assert.deepEqual(store.state.userTags['user-a'],['identity','指定語']);
    assert.deepEqual(store.state.autoTagSettings.rules,[{tag:'指定語',keywords:['test A']}]);
    page.w.selectUser('user-a');page.input('identity');await page.w.saveUserTags();await settle();
    assert.deepEqual(store.state.autoTagExclusions,{'user-a':['指定語']});
    await store.local.set({comments:[...store.state.comments,{id:'new',userId:'user-a',message:'test A?',createdAtMs:Date.now()}]});
    await settle();await page.w.ABEMAAutoUserTags.refresh();
    assert.deepEqual(store.state.userTags['user-a'],['identity']);
    let payload;page.w.download=(_name,text)=>payload=JSON.parse(text);await page.w.exportTransfer();
    assert.deepEqual(payload.data.autoTagExclusions,{'user-a':['指定語']});
    await page.w.importTransferFile({text:async()=>JSON.stringify(payload)});
    assert.deepEqual(store.state.userTags['user-a'],['identity']);
    const reopened=await dashboard(store);
    try {assert.deepEqual(store.state.userTags['user-a'],['identity']);}finally{reopened.close();}
    const before=JSON.stringify(store.state);payload.data.autoTagExclusions={'user-a':[42]};
    await page.w.importTransferFile({text:async()=>JSON.stringify(payload)});
    assert.match(page.el('transferStatus').textContent,/失敗/);assert.equal(JSON.stringify(store.state),before);
    page.input('identity, 指定語');await page.w.saveUserTags();await settle();
    assert.deepEqual(store.state.autoTagExclusions,{});
  }finally{page.close();}
});

test('tag filters combine with comment-level search and include tags in search export',async()=>{
  const store=fixture();store.state.autoTagSettings={rules:[{tag:'指定語',keywords:['test A']}]};
  store.state.comments.push({id:'other',userId:'user-a',message:'unrelated',createdAtMs:Date.now()});
  const page=await dashboard(store);
  try {
    page.el('commentTagFilter').value='指定語';page.el('commentTagFilter').onchange();
    assert.equal(page.el('commentResults').querySelectorAll('article').length,2);
    page.el('commentQuery').value='test A';page.el('commentTarget').onchange();
    assert.equal(page.el('commentResults').querySelectorAll('article').length,1);
    assert.doesNotMatch(page.el('commentResults').textContent,/unrelated/);
    let exported;page.w.download=(_name,text)=>exported=JSON.parse(text);page.el('exportCommentResults').onclick();
    assert.equal(exported.length,1);assert.deepEqual(exported[0].userTags,['指定語']);
    assert.equal('autoLabels' in exported[0],false);
    page.el('autoTagsEnabled').checked=false;await page.el('saveAutoTags').onclick();
    await store.local.set({comments:[{id:'late',userId:'new',message:'test A',createdAtMs:Date.now()}]});await settle();
    assert.deepEqual(store.state.userTags,{'user-a':['指定語']});
  }finally{page.close();}
});

test('replay freezes current results while capture continues, and filter edits clear it',async()=>{
  const store=fixture(),page=await dashboard(store);
  try {
    page.el('loadReplay').onclick();assert.match(page.el('replayStatus').textContent,/1 \/ 2件/);
    await store.local.set({comments:[...store.state.comments,{id:'new',userId:'user-a',message:'new arrival',createdAtMs:Date.now()}]});await settle();
    page.el('replayNext').onclick();assert.match(page.el('replayStatus').textContent,/2 \/ 2件/);
    assert.doesNotMatch(page.el('replayComments').textContent,/new arrival/);
    page.el('replayRestart').onclick();assert.match(page.el('replayStatus').textContent,/1 \/ 2件/);
    page.el('commentTarget').value='user';page.el('commentTarget').onchange();
    assert.equal(page.el('replayPlay').disabled,true);assert.equal(page.el('replayComments').textContent,'');
  }finally{page.close();}
});
test('emoji settings default off and round-trip with exclusions and existing settings',async()=>{
  const store=fixture(),page=await dashboard(store);
  try {
    assert.equal(page.el('emojiEnabled').checked,false);
    page.el('emojiEnabled').checked=true;page.el('emojiCount').value='4';page.el('emojiWindowSec').value='180';
    await page.el('saveModeration').onclick();
    assert.equal(store.state.moderationSettings.emojiEnabled,true);
    assert.equal(store.state.moderationSettings.emojiCount,4);
    assert.equal(store.state.moderationSettings.emojiWindowSec,180);
    assert.deepEqual(store.state.moderationSettings.ngWords,['existing']);
    let exported;page.w.download=(_name,text)=>exported=JSON.parse(text);await page.w.exportTransfer();
    await page.w.importTransferFile({text:async()=>JSON.stringify(exported)});
    assert.equal(store.state.moderationSettings.emojiCount,4);
  }finally{page.close();}
});

test('changing emoji thresholds invalidates queued mute decisions before storage is changed',async()=>{
  const store=fixture(),page=await dashboard(store);
  try {
    await store.local.set({moderationSettings:{enabled:true,emojiEnabled:true,emojiCount:5,emojiWindowSec:120}});
    const command={type:'APPLY_AUTO_MUTE',entries:[{userId:'target',rule:'emoji',reason:'絵文字のみ 3件/120秒',
      evidence:{count:3,windowSec:120}}]};
    const before=JSON.stringify(store.state.mutedUsers);
    assert.equal((await page.w.ABEMAModerationStore.apply(command)).count,0);
    assert.equal(JSON.stringify(store.state.mutedUsers),before);
    await store.local.set({moderationSettings:{enabled:true,emojiEnabled:true,emojiCount:3,emojiWindowSec:60}});
    assert.equal((await page.w.ABEMAModerationStore.apply(command)).count,0);
  }finally{page.close();}
});
