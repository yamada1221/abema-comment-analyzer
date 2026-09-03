(() => {
  const SOURCE = 'abema-comment-analyzer';
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  const MAX_COMMENTS = 25000;
  let queue = [];
  let flushing = false;
  let contextValid = true;

  function isContextValid() {
    return contextValid && Boolean(globalThis.chrome?.runtime?.id);
  }

  function invalidateContext(error) {
    const message = String(error?.message || error || '');
    if (message.includes('Extension context invalidated')) {
      contextValid = false;
      queue = [];
      return true;
    }
    return false;
  }

  function postToPage(type, payload) {
    if (!contextValid) return;
    window.postMessage({ source: SOURCE, direction: 'TO_PAGE', type, payload }, '*');
  }

  async function syncMuted() {
    if (!isContextValid()) {
      contextValid = false;
      return;
    }
    try {
      const { mutedUsers = [] } = await chrome.storage.local.get('mutedUsers');
      if (isContextValid()) postToPage('SET_MUTED_USERS', mutedUsers);
    } catch (error) {
      if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] syncMuted failed:', error);
    }
  }

  async function flush() {
    if (!isContextValid()) {
      contextValid = false;
      queue = [];
      return;
    }
    if (flushing || queue.length === 0) return;
    flushing = true;
    const batch = queue.splice(0, queue.length);
    try {
      const data = await chrome.storage.local.get(['comments', 'captureEnabled']);
      if (data.captureEnabled === false) return;
      const now = Date.now();
      const existing = Array.isArray(data.comments) ? data.comments : [];
      const byId = new Map();
      for (const c of existing.concat(batch)) {
        const key = String(c.id || `${c.userId}:${c.createdAtMs || c.observedAt}:${c.message}`);
        byId.set(key, c);
      }
      const merged = [...byId.values()]
        .filter((c) => now - Number(c.observedAt || c.createdAtMs || now) <= RETENTION_MS)
        .sort((a, b) => Number(a.createdAtMs || a.observedAt) - Number(b.createdAtMs || b.observedAt))
        .slice(-MAX_COMMENTS);
      await chrome.storage.local.set({ comments: merged, lastCommentAt: now });
    } catch (error) {
      if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] flush failed:', error);
    } finally {
      flushing = false;
    }
  }

  window.addEventListener('message', async (event) => {
    if (!contextValid || event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== SOURCE) return;
    if (d.type === 'COMMENT' && d.payload) {
      queue.push({ ...d.payload, pageUrl: location.href, pageTitle: document.title });
      if (queue.length >= 20) flush();
    } else if (d.type === 'HISTORY_PROGRESS' && d.payload && isContextValid()) {
      try {
        await chrome.storage.local.set({ historyLoadProgress: d.payload });
      } catch (error) {
        if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] history progress failed:', error);
      }
    }
  });

  if (isContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!isContextValid()) {
        contextValid = false;
        return;
      }
      if (area !== 'local') return;
      if (changes.mutedUsers) postToPage('SET_MUTED_USERS', changes.mutedUsers.newValue || []);
      if (changes.historyLoadRequest?.newValue) {
        postToPage('LOAD_HISTORY', { requestId: changes.historyLoadRequest.newValue });
      }
      if (changes.historyLoadCancel?.newValue) {
        postToPage('CANCEL_HISTORY', { requestId: changes.historyLoadCancel.newValue });
      }
    });
  }

  const timer = setInterval(() => {
    if (!isContextValid()) {
      contextValid = false;
      queue = [];
      clearInterval(timer);
      return;
    }
    flush();
  }, 1500);

  syncMuted();
})();
