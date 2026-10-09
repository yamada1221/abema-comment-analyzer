// Observe the site's own connection without creating sockets or logging credentials.
(() => {
  const SOURCE = 'abema-comment-analyzer';
  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) return;
  let ready = false;
  const pending = [];
  const stats = { startedAt: Date.now(), connections: 0, opened: 0, frames: 0,
    jsonFrames: 0, parsedComments: 0, errors: 0, closed: 0, lastFrameAt: null, sampleKeys: [],
    sent: 0, subscriptionHints: 0, fetchRequests: 0, fetchResponses: 0, xhrRequests: 0, xhrResponses: 0,
    diagnosticVersion: 6, allFetch: 0, allXhr: 0, workers: 0, sharedWorkers: 0, eventSources: 0, destinations: [],
    selectionReasons: [],
    apiSelected: 0, apiResponses: 0, apiRouteDiscarded: 0, apiNoBody: 0,
    httpJson: 0, httpComments: 0, httpCandidates: 0, httpParseErrors: 0, httpSkipped: 0, lastHttpAt: null };
  const destinations = new Map();
  const selections = new Map();
  function observeDestination(input, transport) {
    try {
      const u = new URL(typeof input === 'string' ? input : input.url || String(input), location.origin);
      if (!/^https?:$|^wss?:$/.test(u.protocol)) return;
      // Retain host and fixed route categories only. Never retain query strings, path IDs or bodies.
      const category = /comment/i.test(u.pathname) ? 'comment' : /realtime/i.test(u.pathname) ? 'realtime' : /chat/i.test(u.pathname) ? 'chat' : 'other';
      const key = `${transport} ${u.hostname} [${category}]`;
      if (!destinations.has(key) && destinations.size >= 24) return;
      destinations.set(key, (destinations.get(key) || 0) + 1);
      stats.destinations = [...destinations].map(([destination, count]) => `${destination}: ${count}`);
    } catch (_) {}
  }
  let statusTimer = null;
  function report() {
    if (!ready || statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      window.postMessage({ source: SOURCE, type: 'NETWORK_STATUS', payload: {
        ...stats, pageUrl: location.origin + location.pathname, updatedAt: Date.now()
      } }, '*');
    }, 1000);
  }
  function publish(payload) {
    if (ready) window.postMessage({ source: SOURCE, type: 'NETWORK_COMMENT', payload }, '*');
    else {
      pending.push(payload);
      if (pending.length > 1000) pending.shift();
    }
  }
  function visit(value, route, depth = 0, transport = 'websocket', capture = true, budget = { left: 12000 }) {
    if (--budget.left < 0) return;
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (typeof value.message === 'string' && value.message.length > 0 &&
        (typeof value.userId === 'string' || typeof value.userId === 'number') && value.id) {
      if (!capture) { stats.httpCandidates++; return; }
      stats.parsedComments++;
      if (transport !== 'websocket') stats.httpComments++;
      publish({ id: value.id, userId: value.userId, message: value.message,
        createdAtMs: value.createdAtMs, contentId: value.contentId, chatId: value.chatId,
        isOwner: value.isOwner, captureTransport: transport, captureRoute: route });
      return;
    }
    for (const child of Object.values(value).slice(0, 1000)) visit(child, route, depth + 1, transport, capture, budget);
  }
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      stats.connections++;
      observeDestination(args[0], 'WS');
      const nativeSend = socket.send;
      if (typeof nativeSend === 'function') socket.send = function(...values) {
        const result = Reflect.apply(nativeSend, this, values);
        stats.sent++;
        // Count subscription-like operations without retaining their payloads.
        try {
          const v = typeof values[0] === 'string' ? JSON.parse(values[0]) : null;
          if (v && [v.type, v.action, v.event, v.method].some(x => typeof x === 'string' && /subscribe|join/i.test(x))) stats.subscriptionHints++;
        } catch (_) {}
        report();
        return result;
      };
      report();
      socket.addEventListener('open', () => { stats.opened++; report(); });
      socket.addEventListener('error', () => { stats.errors++; report(); });
      socket.addEventListener('close', () => { stats.closed++; report(); });
      const socketRoute = location.pathname;
      socket.addEventListener('message', async (event) => {
        const route = location.pathname;
        if (route !== socketRoute) return;
        stats.frames++;
        stats.lastFrameAt = Date.now();
        try {
          let data = event.data;
          if (typeof Blob !== 'undefined' && data instanceof Blob) data = await data.text();
          if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
          if (typeof data !== 'string' || data.length > 2000000) return;
          const parsed = JSON.parse(data);
          stats.jsonFrames++;
          // Only common schema field names; never retain message bodies or URLs.
          const names = new Set();
          function fields(v, depth = 0) {
            if (!v || typeof v !== 'object' || depth > 4) return;
            for (const [key, child] of Object.entries(v).slice(0, 30)) {
              if (['data','payload','body','message','text','comment','comments','userId','id','contentId','chatId','createdAtMs','type','event'].includes(key)) names.add(key);
              fields(child, depth + 1);
            }
          }
          fields(parsed);
          stats.sampleKeys = [...names];
          if (route === location.pathname) visit(parsed, route);
        } catch (_) { /* Unknown frames leave the site's connection untouched. */ }
        finally { report(); }
      });
      return socket;
    }
  });
  function relevant(input) {
    try {
      const u = new URL(typeof input === 'string' ? input : input.url || String(input), location.origin);
      return /comments?|realtime|chat/i.test(u.pathname);
    } catch (_) { return false; }
  }
  function apiInput(input) {
    try {
      const u = new URL(typeof input === 'string' ? input : input.url || String(input), location.origin);
      const abema = u.hostname === 'abema.tv' || u.hostname.endsWith('.abema.tv') ||
        u.hostname === 'abema-tv.com' || u.hostname.endsWith('.abema-tv.com') || u.hostname.endsWith('-abema-tv.com');
      const route = /comments?|realtime|chat/i.test(u.pathname);
      const api = /^(?:realtime-)?api[.-]/i.test(u.hostname);
      return u.protocol === 'https:' && abema && (route || api);
    } catch (_) { return false; }
  }
  function selection(input, transport) {
    const chosen = apiInput(input);
    try {
      const u = new URL(typeof input === 'string' ? input : input.url || String(input), location.origin);
      // Only domain names and fixed reasons; no paths, queries or headers.
      const reason = chosen ? 'selected' : relevant(input) ? 'related-but-host-excluded' : 'not-api-or-comment-route';
      const key = `${transport} ${u.hostname}: ${reason}`;
      if (selections.has(key) || selections.size < 48) selections.set(key, (selections.get(key) || 0) + 1);
      stats.selectionReasons = [...selections].sort((a, b) => Number(/selected|related-but/.test(b[0])) - Number(/selected|related-but/.test(a[0])))
        .slice(0, 24).map(([key, count]) => `${key} (${count})`);
    } catch (_) {
      const key = `${transport}: invalid-url-input`;
      selections.set(key, (selections.get(key) || 0) + 1);
      stats.selectionReasons = [...selections].slice(0, 24).map(([key, count]) => `${key} (${count})`);
    }
    return chosen;
  }
  function inspectHttp(value, input, route, transport) {
    if (route !== location.pathname) { stats.apiRouteDiscarded++; report(); return; }
    stats.httpJson++;
    stats.lastHttpAt = Date.now();
    // Unknown API routes provide candidate counts only, to avoid capturing unrelated data.
    visit(value, route, 0, transport, relevant(input));
    report();
  }
  async function inspectFetch(response, input, route) {
    try {
      if (!response.ok || !/json/i.test(response.headers.get('content-type') || '')) { stats.httpSkipped++; return; }
      if (Number(response.headers.get('content-length')) > 2000000) { stats.httpSkipped++; return; }
      const copy = response.clone();
      if (!copy.body) { stats.apiNoBody++; return; }
      const reader = copy.body.getReader();
      const decoder = new TextDecoder();
      let size = 0, text = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2000000) { stats.httpSkipped++; reader.cancel().catch(() => {}); return; }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        inspectHttp(JSON.parse(text), input, route, 'fetch');
      } finally { reader.releaseLock(); }
    } catch (_) { stats.httpParseErrors++; }
    finally { report(); }
  }
  if (typeof window.fetch === 'function') {
    const original = window.fetch;
    window.fetch = function(...args) {
      stats.allFetch++;
      observeDestination(args[0], 'fetch');
      report();
      const watched = relevant(args[0]);
      const route = location.pathname;
      if (watched) { stats.fetchRequests++; report(); }
      const result = Reflect.apply(original, this, args);
      if (watched) result.then(() => { stats.fetchResponses++; report(); }, () => { report(); });
      if (selection(args[0], 'fetch')) {
        stats.apiSelected++; report();
        result.then(response => { stats.apiResponses++; return inspectFetch(response, args[0], route); }, () => {}).catch(() => {});
      }
      return result;
    };
  }
  if (window.XMLHttpRequest) {
    const proto = window.XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const watched = new WeakMap();
    const apiRequests = new WeakMap();
    proto.open = function(...args) {
      const result = Reflect.apply(originalOpen, this, args);
      stats.allXhr++;
      observeDestination(args[1], 'XHR');
      report();
      watched.set(this, relevant(args[1]));
      apiRequests.set(this, selection(args[1], 'XHR') ? args[1] : null);
      return result;
    };
    proto.send = function(...args) {
      const input = apiRequests.get(this);
      const route = location.pathname;
      if (input) { stats.apiSelected++; report(); }
      if (input) this.addEventListener('load', () => {
        stats.apiResponses++;
        try {
          if (this.status < 200 || this.status >= 300) { stats.httpSkipped++; return; }
          let value;
          if (this.responseType === 'json') value = this.response;
          else if (!this.responseType || this.responseType === 'text') {
            if (!/json/i.test(this.getResponseHeader('content-type') || '') || this.responseText.length > 2000000) { stats.httpSkipped++; return; }
            value = JSON.parse(this.responseText);
          } else { stats.httpSkipped++; return; }
          inspectHttp(value, input, route, 'xhr');
        } catch (_) { stats.httpParseErrors++; }
        finally { report(); }
      }, { once: true });
      if (watched.get(this)) {
        stats.xhrRequests++; report();
        this.addEventListener('load', () => { stats.xhrResponses++; report(); }, { once: true });
      }
      return Reflect.apply(originalSend, this, args);
    };
  }
  for (const [name, counter] of [['Worker', 'workers'], ['SharedWorker', 'sharedWorkers'], ['EventSource', 'eventSources']]) {
    if (typeof window[name] !== 'function') continue;
    const Original = window[name];
    window[name] = new Proxy(Original, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
        stats[counter]++;
        observeDestination(args[0], name);
        report();
        return instance;
      }
    });
  }
  if (typeof PerformanceObserver === 'function') {
    try {
      const resourceObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (['fetch', 'xmlhttprequest', 'other'].includes(entry.initiatorType)) observeDestination(entry.name, `resource/${entry.initiatorType}`);
        }
        report();
      });
      resourceObserver.observe({ type: 'resource', buffered: true });
    } catch (_) {}
  }
  // Refresh diagnostics even when the connection is idle; browsers may throttle this in background tabs.
  if (typeof setInterval === 'function') setInterval(report, 10000);
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === SOURCE && event.data.type === 'NETWORK_STATUS_REQUEST') {
      ready = true;
      report();
      return;
    }
    if (event.source !== window || event.data?.source !== SOURCE || event.data.type !== 'BRIDGE_READY') return;
    ready = true;
    report();
    for (const payload of pending.splice(0)) {
      if (payload.captureRoute === location.pathname) publish(payload);
    }
  });
})();
