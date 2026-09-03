(() => {
  const SOURCE = 'abema-comment-analyzer';
  const ONE_HOUR = 60 * 60 * 1000;
  const MAX_COMMENTS = 25000;
  let queue = [];
  let flushing = false;

  function postMuted(users) {
    window.postMessage({ source: SOURCE, direction: 'TO_PAGE', type: 'SET_MUTED_USERS', payload: users }, '*');
  }

  async function syncMuted() {
    const { mutedUsers = [] } = await chrome.storage.local.get('mutedUsers');
    postMuted(mutedUsers);
  }

  async function flush() {
    if (flushing || queue.length === 0) return;
    flushing = true;
    const batch = queue.splice(0, queue.length);
    try {
      const data = await chrome.storage.local.get(['comments', 'captureEnabled']);
      if (data.captureEnabled === false) return;
      const now = Date.now();
      const existing = Array.isArray(data.comments) ? data.comments : [];
      const merged = existing.concat(batch)
        .filter((c) => now - Number(c.observedAt || c.createdAtMs || now) <= ONE_HOUR)
        .slice(-MAX_COMMENTS);
      await chrome.storage.local.set({ comments: merged, lastCommentAt: now });
    } finally {
      flushing = false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== SOURCE) return;
    if (d.type === 'COMMENT' && d.payload) {
      queue.push({ ...d.payload, pageUrl: location.href, pageTitle: document.title });
      if (queue.length >= 20) flush();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.mutedUsers) postMuted(changes.mutedUsers.newValue || []);
  });

  setInterval(flush, 1500);
  syncMuted();
})();
