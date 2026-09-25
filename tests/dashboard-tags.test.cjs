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
    runtime: { getManifest: () => ({ version: '0.9.1' }) }
  };
  Object.defineProperty(w.navigator, 'locks', { value: { request: store.lock } });
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillRect() {}, fillText() {} });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.confirm = () => true;
  for (const file of ['user-tags.js', 'learning-model.js', 'dashboard.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  await settle();
  assert.equal(w.document.getElementById('versionInfo').textContent, 'v0.9.1 / 保存形式 3');
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
