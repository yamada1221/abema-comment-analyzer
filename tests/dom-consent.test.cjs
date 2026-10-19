const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { abemaFixture } = require('./browser/abema-fixture.cjs');

const source = readFileSync(path.join(__dirname, '../page-bridge.js'), 'utf8');
const SOURCE = 'abema-comment-analyzer';
const wait = (ms=80) => new Promise(resolve => setTimeout(resolve, ms));

function launch() {
  const dom = new JSDOM(abemaFixture({ keyword: 'DOM consent fixture' }), {
    url: 'https://abema.tv/now-on-air/abema-news',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      const realTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => realTimeout(fn, Math.max(1, ms / 10), ...args);
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        get() { return this.textContent; }
      });
    }
  });
  const { window } = dom;
  const sent = [];
  let candidateReads = 0;
  const origQuery = window.document.querySelectorAll.bind(window.document);
  window.document.querySelectorAll = selector => {
    if (selector === 'li, [role="listitem"], [class*="comment" i]') candidateReads++;
    return origQuery(selector);
  };
  window.addEventListener('message', event => {
    if (event.data?.source === SOURCE) sent.push(event.data);
  });
  window.eval(source);

  return {
    window, sent,
    get candidateReads() { return candidateReads; },
    send(type, payload) {
      window.dispatchEvent(new window.MessageEvent('message', {
        source: window,
        data: { source: SOURCE, direction: 'TO_PAGE', type, payload }
      }));
    },
    add(id, userId) {
      const row = window.document.createElement('li');
      row.id = id; row.textContent = 'comment ' + id;
      row['__reactProps$fixture'] = { comments: [
        { id, userId, message: row.textContent, createdAtMs: Date.now() }
      ] };
      window.document.getElementById('rows').appendChild(row);
      return row;
    },
    close() { window.close(); }
  };
}

test('new install does not inspect DOM comments until recording is enabled', async () => {
  const app = launch();
  try {
    await wait(30);
    app.add('before-opt-in', 'a');
    await wait();
    assert.equal(app.candidateReads, 0);
    assert.equal(app.sent.filter(x=>x.type==='COMMENT').length, 0);

    app.send('SET_CAPTURE_ENABLED', { enabled: true });
    await wait();
    assert.deepEqual(app.sent.filter(x=>x.type==='COMMENT').map(x=>x.payload.id), ['before-opt-in']);
    assert.ok(app.candidateReads > 0);

    app.send('SET_CAPTURE_ENABLED', { enabled: false });
    await wait(40);
    const reads = app.candidateReads;
    app.add('after-opt-out', 'b');
    await wait();
    assert.equal(app.candidateReads, reads);
    assert.deepEqual(app.sent.filter(x=>x.type==='COMMENT').map(x=>x.payload.id), ['before-opt-in']);
  } finally { app.close(); }
});

test('configured mutes can hide locally without recording or forwarding comments', async () => {
  const app = launch();
  try {
    await wait(30);
    app.send('SET_MUTED_USERS', ['muted-user']);
    const hidden = app.add('muted', 'muted-user');
    const visible = app.add('normal', 'ordinary');
    await wait();
    assert.equal(hidden.style.display, 'none');
    assert.notEqual(visible.style.display, 'none');
    assert.equal(app.sent.filter(x=>x.type==='COMMENT').length, 0);

    app.send('SET_MUTED_USERS', []);
    assert.notEqual(hidden.style.display, 'none');
    const previous = app.candidateReads;
    app.add('unrelated', 'ordinary');
    await wait();
    assert.equal(app.candidateReads, previous);
  } finally { app.close(); }
});

test('loading old comments requires recording opt-in', async () => {
  const app = launch();
  try {
    await wait(30);
    app.send('LOAD_HISTORY', { requestId: 99 });
    await wait(20);
    assert.ok(app.sent.some(x=>x.type==='HISTORY_PROGRESS' && x.payload?.status==='error' &&
      x.payload?.requestId===99));
    assert.equal(app.candidateReads, 0);
  } finally { app.close(); }
});
