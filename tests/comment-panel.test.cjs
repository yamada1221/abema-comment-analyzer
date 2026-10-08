const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { abemaFixture } = require('./browser/abema-fixture.cjs');

const source = fs.readFileSync(path.join(__dirname, '../page-bridge.js'), 'utf8');
const SOURCE = 'abema-comment-analyzer';

function bridge() {
  const dom = new JSDOM(abemaFixture({ keyword: '自動記録テスト番組' }), {
    url: 'https://abema.tv/now-on-air/abema-news', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, ms, ...args) => timeout(callback, ms / 10, ...args);
      // jsdom has no layout or innerText; Chrome tests also check real visibility.
      window.Element.prototype.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 280, width: 400, height: 180 });
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
      window.document.elementFromPoint = () => window.document.body;
    }
  });
  const { window } = dom;
  window.eval(source);
  const statuses = [];
  window.addEventListener('message', event => {
    if (event.data?.type === 'COMMENT_PANEL_STATUS') statuses.push(event.data.payload);
  });
  return {
    window, statuses,
    request(id) {
      window.dispatchEvent(new window.MessageEvent('message', { source: window, data: {
        source: SOURCE, direction: 'TO_PAGE', type: 'OPEN_COMMENT_PANEL', payload: { requestId: id }
      } }));
    },
    async settled() {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const last = statuses.at(-1);
        if (last && ['success', 'error'].includes(last.status)) return last;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`No final panel status: ${JSON.stringify(statuses)}`);
    },
    close() { window.close(); }
  };
}

test('overlapping requests dismiss the later dialog and click the comment button only once', async () => {
  const app = bridge();
  try {
    for (let id = 1; id <= 4; id++) app.request(id);
    const status = await app.settled();
    assert.equal(status.status, 'success');
    assert.equal(app.window.fixture.laterClicks, 1);
    assert.equal(app.window.fixture.otherClicks, 0);
    assert.equal(app.window.fixture.primaryClicks, 0);
    assert.equal(app.window.fixture.commentClicks, 1);
    assert.equal(app.window.document.getElementById('panel').hidden, false);
    app.statuses.length = 0;
    app.request(5);
    const next = await app.settled();
    assert.equal(next.status, 'success');
    assert.equal(next.alreadyOpen, true);
    assert.equal(app.window.fixture.commentClicks, 1);
  } finally { app.close(); }
});

test('two overlapping requests without a dialog do not toggle the panel shut', async () => {
  const app = bridge();
  try {
    app.window.document.getElementById('notice').hidden = true;
    app.request(1);
    app.request(2);
    assert.equal((await app.settled()).status, 'success');
    assert.equal(app.window.fixture.commentClicks, 1);
    assert.equal(app.window.document.getElementById('panel').hidden, false);
  } finally { app.close(); }
});

test('a failed open releases the operation so a later request can retry', async () => {
  const app = bridge();
  try {
    const button = app.window.document.getElementById('comments');
    button.disabled = true;
    app.request(1);
    assert.equal((await app.settled()).status, 'error');
    assert.equal(app.window.fixture.commentClicks, 0);
    app.statuses.length = 0;
    button.disabled = false;
    app.request(2);
    assert.equal((await app.settled()).status, 'success');
    assert.equal(app.window.fixture.commentClicks, 1);
  } finally { app.close(); }
});
