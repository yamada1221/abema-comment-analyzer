(() => {
  const SOURCE = 'abema-comment-analyzer';
  const seen = new Set();
  const elementUsers = new Map();
  const hiddenByExtension = new Map();
  let mutedUsers = new Set();
  let observer = null;
  let scanTimer = null;

  const isComment = (value) => value && typeof value === 'object' &&
    typeof value.message === 'string' && value.message.length > 0 &&
    (typeof value.userId === 'string' || typeof value.userId === 'number');

  function commentKey(comment) {
    return String(comment.id || `${comment.userId}:${comment.createdAtMs || ''}:${comment.message}`);
  }

  function emitComment(comment) {
    const key = commentKey(comment);
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 30000) {
      const recent = Array.from(seen).slice(-15000);
      seen.clear();
      recent.forEach((item) => seen.add(item));
    }

    window.postMessage({
      source: SOURCE,
      type: 'COMMENT',
      payload: {
        id: comment.id ? String(comment.id) : key,
        userId: String(comment.userId),
        message: comment.message,
        createdAtMs: Number(comment.createdAtMs || Date.now()),
        observedAt: Date.now(),
        isOwner: Boolean(comment.isOwner)
      }
    }, '*');
  }

  function getText(element) {
    if (!(element instanceof HTMLElement)) return '';
    return (element.innerText || '').trim();
  }

  function bindVisibleElement(comment, root) {
    const message = comment.message.trim();
    if (!message) return;

    const candidates = [];
    if (root instanceof HTMLElement) candidates.push(root);
    root?.querySelectorAll?.('li, [role="listitem"]').forEach((el) => candidates.push(el));

    for (const element of candidates.slice(0, 120)) {
      const text = getText(element);
      if (!text || text.length > message.length + 160 || !text.includes(message)) continue;
      elementUsers.set(element, String(comment.userId));
      applyMuteToElement(element);
      return;
    }
  }

  function extractCommentsFromObject(value, depth = 0, visited = new WeakSet()) {
    if (!value || typeof value !== 'object' || depth > 3 || visited.has(value)) return [];
    visited.add(value);

    if (Array.isArray(value)) {
      const direct = value.filter(isComment);
      if (direct.length) return direct;
      return [];
    }

    if (isComment(value)) return [value];

    const keys = ['comments', 'commentList', 'items', 'data', 'props', 'pendingProps', 'memoizedProps'];
    for (const key of keys) {
      try {
        if (!(key in value)) continue;
        const found = extractCommentsFromObject(value[key], depth + 1, visited);
        if (found.length) return found;
      } catch (_) {}
    }
    return [];
  }

  function commentsFromReactNode(element) {
    if (!(element instanceof Element)) return [];
    let node = element;
    for (let level = 0; node && level < 7; level++, node = node.parentElement) {
      for (const key of Object.getOwnPropertyNames(node)) {
        if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactProps$')) continue;
        try {
          const reactValue = node[key];
          const direct = extractCommentsFromObject(reactValue);
          if (direct.length) return direct;

          let fiber = reactValue;
          for (let hop = 0; fiber && hop < 8; hop++, fiber = fiber.return) {
            const fromMemo = extractCommentsFromObject(fiber.memoizedProps);
            if (fromMemo.length) return fromMemo;
            const fromPending = extractCommentsFromObject(fiber.pendingProps);
            if (fromPending.length) return fromPending;
          }
        } catch (_) {}
      }
    }
    return [];
  }

  function inspect(root) {
    if (!(root instanceof Element)) return;
    const comments = commentsFromReactNode(root);
    if (!comments.length) return;
    for (const comment of comments) {
      emitComment(comment);
      bindVisibleElement(comment, root.parentElement || root);
    }
  }

  function applyMuteToElement(element) {
    const userId = elementUsers.get(element);
    if (!userId) return;

    if (mutedUsers.has(userId)) {
      if (!hiddenByExtension.has(element)) {
        hiddenByExtension.set(element, element.style.display || '');
        element.style.setProperty('display', 'none', 'important');
      }
    } else if (hiddenByExtension.has(element)) {
      const original = hiddenByExtension.get(element);
      if (original) element.style.display = original;
      else element.style.removeProperty('display');
      hiddenByExtension.delete(element);
    }
  }

  function applyMute() {
    for (const [element] of elementUsers) {
      if (!element.isConnected) {
        elementUsers.delete(element);
        hiddenByExtension.delete(element);
        continue;
      }
      applyMuteToElement(element);
    }
  }

  function scanVisibleComments() {
    const candidates = document.querySelectorAll('li, [role="listitem"], [class*="comment" i]');
    const start = Math.max(0, candidates.length - 80);
    for (let i = start; i < candidates.length; i++) inspect(candidates[i]);
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanVisibleComments();
    }, 250);
  }

  function start() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      let relevant = false;
      for (const record of records) {
        if (!record.addedNodes.length) continue;
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.('li, [role="listitem"], [class*="comment" i]') ||
              node.querySelector?.('li, [role="listitem"], [class*="comment" i]')) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }
      if (relevant) scheduleScan();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(scanVisibleComments, 1500);
    setInterval(scanVisibleComments, 5000);
    window.postMessage({ source: SOURCE, type: 'BRIDGE_READY' }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.direction !== 'TO_PAGE') return;
    if (data.type === 'SET_MUTED_USERS') {
      mutedUsers = new Set((data.payload || []).map(String));
      applyMute();
    } else if (data.type === 'RESCAN') {
      scanVisibleComments();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
