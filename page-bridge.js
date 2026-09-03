(() => {
  const SOURCE = 'abema-comment-analyzer';
  const seen = new Set();
  const elementUsers = new Map();
  const hiddenByExtension = new Map();
  let mutedUsers = new Set();
  let observer = null;
  let scanTimer = null;
  let historyLoading = false;
  let historyCancelled = false;
  let oldestSeenAt = Infinity;

  const isComment = (value) => value && typeof value === 'object' &&
    typeof value.message === 'string' && value.message.length > 0 &&
    (typeof value.userId === 'string' || typeof value.userId === 'number');

  function commentKey(comment) {
    return String(comment.id || `${comment.userId}:${comment.createdAtMs || ''}:${comment.message}`);
  }

  function emitProgress(payload) {
    window.postMessage({ source: SOURCE, type: 'HISTORY_PROGRESS', payload: { updatedAt: Date.now(), ...payload } }, '*');
  }

  function emitComment(comment) {
    const key = commentKey(comment);
    if (seen.has(key)) return false;
    seen.add(key);
    const createdAtMs = Number(comment.createdAtMs || Date.now());
    if (Number.isFinite(createdAtMs)) oldestSeenAt = Math.min(oldestSeenAt, createdAtMs);
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
        createdAtMs,
        observedAt: Date.now(),
        isOwner: Boolean(comment.isOwner)
      }
    }, '*');
    return true;
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
    if (!value || typeof value !== 'object' || depth > 4 || visited.has(value)) return [];
    visited.add(value);
    if (Array.isArray(value)) {
      const direct = value.filter(isComment);
      if (direct.length) return direct;
      for (const item of value.slice(0, 20)) {
        const found = extractCommentsFromObject(item, depth + 1, visited);
        if (found.length) return found;
      }
      return [];
    }
    if (isComment(value)) return [value];
    const keys = ['comments', 'commentList', 'items', 'data', 'props', 'pendingProps', 'memoizedProps', 'page', 'edges', 'nodes'];
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
    for (let level = 0; node && level < 9; level++, node = node.parentElement) {
      for (const key of Object.getOwnPropertyNames(node)) {
        if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactProps$')) continue;
        try {
          const reactValue = node[key];
          const direct = extractCommentsFromObject(reactValue);
          if (direct.length) return direct;
          let fiber = reactValue;
          for (let hop = 0; fiber && hop < 10; hop++, fiber = fiber.return) {
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
    if (!(root instanceof Element)) return 0;
    const comments = commentsFromReactNode(root);
    if (!comments.length) return 0;
    let added = 0;
    for (const comment of comments) {
      if (emitComment(comment)) added++;
      bindVisibleElement(comment, root.parentElement || root);
    }
    return added;
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
    const start = Math.max(0, candidates.length - 120);
    let added = 0;
    for (let i = start; i < candidates.length; i++) added += inspect(candidates[i]);
    return added;
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanVisibleComments();
    }, 250);
  }

  function findCommentScrollContainer() {
    const commentNodes = [...document.querySelectorAll('li, [role="listitem"], [class*="comment" i]')].slice(-120);
    const scores = new Map();
    for (const node of commentNodes) {
      let parent = node.parentElement;
      for (let level = 0; parent && level < 8; level++, parent = parent.parentElement) {
        if (!(parent instanceof HTMLElement)) continue;
        const scrollable = parent.scrollHeight - parent.clientHeight > 80;
        if (!scrollable) continue;
        let score = scores.get(parent) || 0;
        score += 1;
        const style = getComputedStyle(parent);
        if (/auto|scroll/.test(style.overflowY)) score += 4;
        if (parent.querySelectorAll('li, [role="listitem"]').length >= 3) score += 3;
        scores.set(parent, score);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function loadHistory(requestId) {
    if (historyLoading) {
      emitProgress({ status: 'running', requestId, message: 'すでに過去コメントを読み込み中です' });
      return;
    }
    const scroller = findCommentScrollContainer();
    if (!scroller) {
      emitProgress({ status: 'error', requestId, message: 'コメント欄のスクロール領域を見つけられません。コメント欄を表示してから再実行してください。' });
      return;
    }

    historyLoading = true;
    historyCancelled = false;
    const startedAt = Date.now();
    const initialSeen = seen.size;
    let lastOldest = oldestSeenAt;
    let stagnant = 0;
    let cycles = 0;
    const MAX_CYCLES = 240;
    const MAX_MS = 5 * 60 * 1000;

    emitProgress({ status: 'running', requestId, startedAt, cycles: 0, captured: 0, message: '過去コメントを読み込み中…' });

    try {
      while (!historyCancelled && cycles < MAX_CYCLES && Date.now() - startedAt < MAX_MS) {
        cycles++;
        scanVisibleComments();
        const beforeHeight = scroller.scrollHeight;
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(900);
        scanVisibleComments();
        await wait(250);

        const captured = Math.max(0, seen.size - initialSeen);
        const olderFound = oldestSeenAt < lastOldest;
        const heightChanged = scroller.scrollHeight !== beforeHeight;
        if (olderFound || heightChanged) {
          stagnant = 0;
          lastOldest = oldestSeenAt;
        } else if (scroller.scrollTop <= 1) {
          stagnant++;
        } else {
          stagnant = 0;
        }

        emitProgress({
          status: 'running', requestId, startedAt, cycles, captured,
          oldestAt: Number.isFinite(oldestSeenAt) ? oldestSeenAt : null,
          message: `過去コメントを読み込み中… ${captured}件追加`
        });

        if (stagnant >= 12) break;
      }

      scanVisibleComments();
      const captured = Math.max(0, seen.size - initialSeen);
      emitProgress({
        status: historyCancelled ? 'cancelled' : 'done', requestId, startedAt, cycles, captured,
        oldestAt: Number.isFinite(oldestSeenAt) ? oldestSeenAt : null,
        message: historyCancelled ? `中止しました（${captured}件追加）` : `完了しました（${captured}件追加）`
      });
    } catch (error) {
      emitProgress({ status: 'error', requestId, startedAt, cycles, captured: Math.max(0, seen.size - initialSeen), message: String(error?.message || error) });
    } finally {
      historyLoading = false;
      historyCancelled = false;
    }
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
    } else if (data.type === 'LOAD_HISTORY') {
      loadHistory(data.payload?.requestId || Date.now());
    } else if (data.type === 'CANCEL_HISTORY') {
      historyCancelled = true;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
