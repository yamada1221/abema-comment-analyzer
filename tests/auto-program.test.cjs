const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const TARGET = 'https://abema.tv/now-on-air/abema-news';
const SOURCE = 'abema-comment-analyzer';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ capture = true, initialTabs = [], settings = {}, readState } = {}) {
  const data = {
    autoProgramSettings: {
      enabled: true, keyword: '報道ステーション', url: TARGET,
      days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '02:00',
      closeOwnedTab: true, openActive: false, ...settings
    },
    ...(capture === null ? {} : { captureEnabled: capture })
  };
  let now = new Date(2026, 9, 6, 0, 30).getTime();
  let nextId = 100;
  const tabs = new Map(initialTabs.map(tab => [tab.id, structuredClone(tab)]));
  const created = [], removed = [], updated = [], panelRequests = [];
  const changed = [], messages = [], alarms = [];
  const event = listeners => ({ addListener: callback => listeners.push(callback) });
  const local = {
    async get(keys) {
      const selected = typeof keys === 'string' ? [keys] : keys || Object.keys(data);
      return structuredClone(Object.fromEntries(selected.filter(key => key in data).map(key => [key, data[key]])));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(structuredClone(values))) {
        if (JSON.stringify(data[key]) !== JSON.stringify(value)) changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      }
      if (Object.keys(changes).length) changed.forEach(callback => callback(changes, 'local'));
    },
    async remove(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
    }
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    console, URL, Date: Clock, setTimeout, clearTimeout,
    importScripts() {},
    ABEMACommentLearning: { updateMemory: memory => memory },
    navigator: { locks: { request: async (_name, operation) => operation() } },
    chrome: {
      storage: { local, onChanged: event(changed) },
      alarms: { clear: async () => {}, create: async () => {}, onAlarm: event(alarms) },
      runtime: { onInstalled: event([]), onStartup: event([]), onMessage: event(messages) },
      tabs: {
        async query() { return structuredClone([...tabs.values()].filter(tab => (tab.pendingUrl || tab.url || '').startsWith('https://abema.tv/'))); },
        async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return structuredClone(tabs.get(id)); },
        async create(options) {
          const tab = { id: nextId++, url: options.url, active: options.active };
          tabs.set(tab.id, tab); created.push(tab.id); return structuredClone(tab);
        },
        async update(id, options) { updated.push(id); Object.assign(tabs.get(id), options); return structuredClone(tabs.get(id)); },
        async remove(id) { removed.push(id); tabs.delete(id); },
        async sendMessage(id, message) {
          if (message.type === 'OPEN_COMMENT_PANEL_REQUEST') { panelRequests.push(id); return { ok: true }; }
          const state = { ok: true, matched: true, keyword: message.keyword, url: tabs.get(id)?.url };
          return readState ? readState(state, id) : state;
        }
      }
    }
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  const send = message => new Promise((resolve, reject) => {
    const listener = messages[0];
    try {
      if (!listener({ source: SOURCE, ...message }, {}, resolve)) reject(new Error('No asynchronous response'));
    } catch (error) { reject(error); }
  });
  return {
    data, tabs, created, removed, updated, panelRequests, local,
    tick: options => context.tickAutoProgram(options),
    stop: () => send({ type: 'AUTO_PROGRAM_STOP_NOW' }),
    saveSettings: () => send({ type: 'AUTO_PROGRAM_SETTINGS_SAVED' }),
    setTime: value => { now = value.getTime(); },
    async settle() { await nextTurn(); await context.tickAutoProgram(); }
  };
}

test('simultaneous polls open one tab and preserve the original capture setting', async () => {
  const h = harness();
  await Promise.all([h.tick(), h.tick(), h.tick()]);
  assert.equal(h.created.length, 1);
  assert.equal(h.data.autoProgramSession.ownedTab, true);
  assert.equal(h.data.autoProgramSession.previousCaptureEnabled, true);
  await h.stop();
  assert.equal(h.data.captureEnabled, true);
  assert.equal(h.tabs.size, 0);
});

test('a pending page response cannot resurrect a manually stopped session', async () => {
  const waiting = deferred(), response = deferred();
  const h = harness({ capture: false, readState: async state => { waiting.resolve(); await response.promise; return state; } });
  const tick = h.tick();
  await waiting.promise;
  const stop = h.stop();
  await nextTurn();
  response.resolve();
  await Promise.all([tick, stop]);
  await h.tick();
  assert.equal(h.data.autoProgramSession, null);
  assert.equal(h.data.captureEnabled, false);
  assert.equal(h.created.length, 1);
  assert.equal(h.tabs.size, 0);
  assert.equal(h.panelRequests.length, 0);
});

test('disabling automation during detection leaves it stopped after the response arrives', async () => {
  const waiting = deferred(), response = deferred();
  const h = harness({ capture: null, readState: async state => { waiting.resolve(); await response.promise; return state; } });
  const tick = h.tick();
  await waiting.promise;
  await h.local.set({ autoProgramSettings: { ...h.data.autoProgramSettings, enabled: false } });
  await nextTurn();
  response.resolve();
  await tick;
  await h.settle();
  assert.equal(h.data.autoProgramSession, null);
  assert.equal('captureEnabled' in h.data, false);
  assert.equal(h.tabs.size, 0);
  assert.equal(h.panelRequests.length, 0);
});

test('manual stop before the first poll blocks that monitoring window', async () => {
  const h = harness();
  await h.stop();
  await h.tick();
  assert.equal(h.created.length, 0);
  assert.equal(h.data.captureEnabled, true);
});

test('a manually opened target tab remains open when recording stops', async () => {
  const h = harness({ initialTabs: [{ id: 12, url: TARGET }], capture: false });
  await h.tick();
  assert.equal(h.data.autoProgramSession.ownedTab, false);
  await h.stop();
  assert.equal(h.tabs.has(12), true);
  assert.equal(h.removed.length, 0);
  assert.equal(h.data.captureEnabled, false);
});

test('stop restores a missing capture preference rather than saving a new default', async () => {
  const h = harness({ capture: null });
  await h.tick();
  await h.stop();
  assert.equal('captureEnabled' in h.data, false);
});

test('missing program title keeps recording until the configured end time', async () => {
  let matched = true;
  const h = harness({ capture: false, readState: state => ({ ...state, matched }) });
  await h.tick();
  matched = false;
  await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.data.autoProgramSession.active, true);
  assert.equal(h.data.captureEnabled, true);
  assert.equal(h.tabs.size, 1);
  h.setTime(new Date(2026, 9, 6, 2, 0));
  await h.tick();
  assert.equal(h.data.autoProgramSession, null);
  assert.equal(h.data.captureEnabled, false);
  assert.equal(h.tabs.size, 0);
});

test('a reused automatic tab is not closed after the user navigates elsewhere', async () => {
  const h = harness();
  await h.tick();
  const id = h.data.autoProgramSession.tabId;
  h.tabs.get(id).pendingUrl = 'https://example.org/reading';
  await h.stop();
  assert.equal(h.tabs.has(id), true);
  assert.equal(h.removed.length, 0);
});

test('new monitoring windows retain capture restoration and automatic-tab ownership', async () => {
  const h = harness({ capture: false });
  await h.tick();
  const oldTab = h.data.autoProgramSession.tabId;
  h.setTime(new Date(2026, 9, 7, 0, 30)); // Browser slept through the preceding end time.
  await h.tick();
  assert.equal(h.data.autoProgramSession.previousCaptureEnabled, false);
  assert.equal(h.data.autoProgramSession.ownedTab, true);
  assert.equal(h.tabs.has(oldTab), false);
  await h.stop();
  assert.equal(h.data.captureEnabled, false);
  assert.equal(h.tabs.size, 0);
});

test('a response arriving after the monitoring end cannot start recording', async () => {
  const waiting = deferred(), response = deferred();
  const h = harness({ capture: false, readState: async state => { waiting.resolve(); await response.promise; return state; } });
  const tick = h.tick();
  await waiting.promise;
  h.setTime(new Date(2026, 9, 6, 2, 0));
  response.resolve();
  await tick;
  assert.equal(h.data.autoProgramSession, null);
  assert.equal(h.data.captureEnabled, false);
  assert.equal(h.panelRequests.length, 0);
});

test('saving new settings after a pending stop can start a fresh session', async () => {
  const waiting = deferred(), response = deferred();
  let first = true;
  const h = harness({ capture: false, readState: async state => {
    if (first) { first = false; waiting.resolve(); await response.promise; }
    return state;
  } });
  const tick = h.tick();
  await waiting.promise;
  const stop = h.stop();
  await h.local.set({ autoProgramSettings: { ...h.data.autoProgramSettings, keyword: '新しい番組' } });
  response.resolve();
  await Promise.all([tick, stop]);
  await h.settle();
  assert.equal(h.data.autoProgramSession.keyword, '新しい番組');
  assert.equal(h.data.autoProgramSession.active, true);
  assert.equal(h.data.autoProgramSession.previousCaptureEnabled, false);
  assert.equal(h.tabs.size, 1);
});

test('changing the target URL does not carry over an active program detection', async () => {
  let matched = true;
  const h = harness({ capture: false, readState: state => ({ ...state, matched }) });
  await h.tick();
  const oldTab = h.data.autoProgramSession.tabId;
  matched = false;
  await h.local.set({ autoProgramSettings: { ...h.data.autoProgramSettings, url: 'https://abema.tv/now-on-air/anime-live' } });
  await h.settle();
  assert.equal(h.tabs.has(oldTab), false);
  assert.equal(h.data.autoProgramSession.active, false);
  assert.equal(h.data.captureEnabled, false);
  assert.equal(h.data.autoProgramSession.previousCaptureEnabled, false);
});

test('navigating away preserves that tab and reconnects without redirecting it', async () => {
  const h = harness();
  await h.tick();
  const oldTab = h.data.autoProgramSession.tabId;
  h.tabs.get(oldTab).url = 'https://example.org/reading';
  await h.tick();
  assert.equal(h.tabs.get(oldTab).url, 'https://example.org/reading');
  assert.equal(h.updated.length, 0);
  assert.notEqual(h.data.autoProgramSession.tabId, oldTab);
  await h.stop();
  assert.equal(h.tabs.has(oldTab), true);
  assert.equal(h.tabs.size, 1);
});

test('overnight monitoring stays in one window across midnight', async () => {
  const h = harness({ capture: false, settings: { days: [2], startTime: '23:00', endTime: '01:00' } });
  h.setTime(new Date(2026, 9, 6, 23, 30));
  await h.tick();
  const tabId = h.data.autoProgramSession.tabId;
  h.setTime(new Date(2026, 9, 7, 0, 30));
  await h.tick();
  assert.equal(h.data.autoProgramSession.windowKey, '2026-10-06');
  assert.equal(h.data.autoProgramSession.tabId, tabId);
  assert.equal(h.created.length, 1);
  h.setTime(new Date(2026, 9, 7, 1, 0));
  await h.tick();
  assert.equal(h.data.autoProgramSession, null);
  assert.equal(h.data.captureEnabled, false);
});

test('a failed queued operation does not block subsequent monitoring', async () => {
  const h = harness();
  const get = h.local.get;
  let fail = true;
  h.local.get = async keys => {
    if (fail) { fail = false; throw new Error('temporary storage failure'); }
    return get(keys);
  };
  await assert.rejects(h.tick(), /temporary storage failure/);
  await h.tick();
  assert.equal(h.data.autoProgramSession.active, true);
  await h.stop();
  assert.equal(h.data.captureEnabled, true);
});

test('explicitly saving identical settings restarts a manually stopped window', async () => {
  const h = harness({ capture: false });
  await h.tick();
  await h.stop();
  await h.tick();
  assert.equal(h.data.autoProgramSession, null);
  assert.equal((await h.saveSettings()).ok, true);
  assert.equal(h.data.autoProgramSession.active, true);
  assert.equal(h.created.length, 2);
  assert.equal(h.tabs.size, 1);
});
