const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup(fetchImpl, Xhr) {
  const output = [];
  const listeners = {};
  const timers = [];
  class Socket {
    static OPEN = 1;
    addEventListener(type, fn) { this[type] = fn; }
  }
  const window = { WebSocket: Socket, addEventListener: (type, fn) => { listeners[type] = fn; },
    postMessage: event => output.push(event) };
  window.fetch = fetchImpl || (() => Promise.resolve({ ok: true }));
  window.Worker = class Worker {};
  if (Xhr) window.XMLHttpRequest = Xhr;
  const location = { origin: 'https://abema.tv', pathname: '/now-on-air/abema-news' };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../network-bridge.js'), 'utf8'),
    { window, location, Blob, ArrayBuffer, TextDecoder, URL, setTimeout: fn => { timers.push(fn); return 1; } });
  return { window, location, output, flushDiagnostics: () => { for (const fn of timers.splice(0)) fn(); }, ready: () => listeners.message({ source: window,
    data: { source: 'abema-comment-analyzer', type: 'BRIDGE_READY' } }) };
}
test('preserves socket identity and buffers nested comments until bridge ready', async () => {
  const s = setup();
  const socket = new s.window.WebSocket('wss://example.invalid');
  assert.equal(s.window.WebSocket.OPEN, 1);
  assert.ok(socket instanceof s.window.WebSocket);
  await socket.message({ data: JSON.stringify({ data: { id: '1', userId: 'u', message: 'hello', createdAtMs: Date.now() } }) });
  assert.equal(s.output.length, 0);
  s.ready();
  assert.equal(s.output[0].payload.message, 'hello');
  assert.equal(s.output[0].payload.captureTransport, 'websocket');
});
test('observes other hosts and workers without retaining query tokens or path IDs', async () => {
  const s = setup(); s.ready();
  await s.window.fetch('https://api.example.org/v1/comments/private-id?token=secret');
  new s.window.Worker('https://abema.tv/scripts/worker.js?token=secret');
  s.flushDiagnostics();
  const status = s.output.find(v => v.type === 'NETWORK_STATUS').payload;
  assert.equal(status.allFetch, 1);
  assert.equal(status.fetchRequests, 1);
  assert.equal(status.fetchResponses, 1);
  assert.equal(status.workers, 1);
  assert.ok(status.destinations.some(v => v.includes('api.example.org [comment]')));
  assert.ok(!JSON.stringify(status).includes('secret'));
  assert.ok(!JSON.stringify(status).includes('private-id'));
});
test('ignores unknown frames and sockets from a previous channel', async () => {
  const s = setup(); s.ready();
  const socket = new s.window.WebSocket('wss://example.invalid');
  await socket.message({ data: 'ping' });
  await socket.message({ data: '{"message":"not a comment"}' });
  s.location.pathname = '/now-on-air/other';
  await socket.message({ data: '{"id":"1","userId":"u","message":"old channel"}' });
  assert.equal(s.output.length, 0);
});
test('captures API comments from cloned responses without consuming the site response', async () => {
  const response = new Response(JSON.stringify({ comments: [{ id: 'api1', userId: 'u', message: 'api hello', createdAtMs: Date.now() }] }), { headers: { 'content-type': 'application/json' } });
  const s = setup(() => Promise.resolve(response)); s.ready();
  const original = await s.window.fetch('https://api-p-c3.abema-tv.com/v1/slots/current/comments');
  assert.equal((await original.json()).comments[0].message, 'api hello');
  for (let i = 0; i < 30 && !s.output.some(v => v.type === 'NETWORK_COMMENT'); i++) await new Promise(r => setTimeout(r, 5));
  const comment = s.output.find(v => v.type === 'NETWORK_COMMENT');
  assert.equal(comment.payload.captureTransport, 'fetch');
  s.flushDiagnostics();
  assert.equal(s.output.find(v => v.type === 'NETWORK_STATUS').payload.httpComments, 1);
});
test('does not capture non-comment API routes or responses after channel navigation', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const s = setup(() => pending); s.ready();
  const call = s.window.fetch('https://api-p-c3-abema-tv.com/v1/slots/current/comments');
  s.location.pathname = '/now-on-air/other';
  resolve(new Response('{"id":"1","userId":"u","message":"old"}', { headers: { 'content-type': 'application/json' } }));
  await call;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(s.output.filter(v => v.type === 'NETWORK_COMMENT').length, 0);
  const candidate = setup(() => Promise.resolve(new Response('{"id":"1","userId":"u","message":"unknown"}', { headers: { 'content-type': 'application/json' } }))); candidate.ready();
  await candidate.window.fetch('https://api-p-c3-abema-tv.com/v1/profile');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(candidate.output.filter(v => v.type === 'NETWORK_COMMENT').length, 0);
});
test('XHR captures comments from abema domain and reports unrelated host exclusion', () => {
  class Xhr {
    constructor() { this.listeners = []; this.status = 200; this.responseType = 'json'; this.response = { comments: [{ id: 'xhr1', userId: 'u', message: 'xhr hello' }] }; }
    open() {}
    addEventListener(type, fn) { if (type === 'load') this.listeners.push(fn); }
    send() { for (const fn of this.listeners.splice(0)) fn(); }
  }
  const s = setup(undefined, Xhr); s.ready();
  const xhr = new s.window.XMLHttpRequest();
  xhr.open('GET', 'https://api.p-c3.abema-tv.com/v1/comments'); xhr.send();
  assert.equal(s.output.find(v => v.type === 'NETWORK_COMMENT').payload.captureTransport, 'xhr');
  const unrelated = new s.window.XMLHttpRequest();
  unrelated.open('GET', 'https://example.org/comments'); unrelated.send();
  s.flushDiagnostics();
  const stats = s.output.find(v => v.type === 'NETWORK_STATUS').payload;
  assert.equal(stats.apiSelected, 1);
  assert.equal(stats.apiResponses, 1);
  assert.ok(stats.selectionReasons.some(v => v.includes('example.org: related-but-host-excluded')));
});
