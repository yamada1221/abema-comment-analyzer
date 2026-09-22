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

  function emitCommentPanelStatus(payload) {
    window.postMessage({
      source: SOURCE,
      type: 'COMMENT_PANEL_STATUS',
      payload: { updatedAt: Date.now(), ...payload }
    }, '*');
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

  function isElementVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    let node = element;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function buttonHasCommentIcon(button) {
    if (!(button instanceof HTMLButtonElement)) return false;
    const descendants = [button, ...button.querySelectorAll('*')];
    for (const element of descendants.slice(0, 80)) {
      const values = [
        element.getAttribute?.('href'),
        element.getAttribute?.('src'),
        element.getAttribute?.('data-src'),
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title')
      ];
      try {
        values.push(element.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href'));
      } catch (_) {}
      if (values.some((value) => /(?:^|[\/_-])comment(?:[._/-]|$)/i.test(String(value || '')))) return true;
    }
    return /comment\.svg/i.test(button.innerHTML || '');
  }

  function describeCommentButton(button) {
    if (!(button instanceof HTMLButtonElement)) return null;
    return {
      ariaLabel: String(button.getAttribute('aria-label') || '').slice(0, 80),
      title: String(button.getAttribute('title') || '').slice(0, 80),
      text: getText(button).replace(/\s+/g, ' ').slice(0, 80),
      hasCommentIcon: buttonHasCommentIcon(button),
      disabled: Boolean(button.disabled)
    };
  }

  function findCommentOpenButton() {
    const candidates = [];
    for (const button of document.querySelectorAll('button')) {
      if (!(button instanceof HTMLButtonElement) || !isElementVisible(button)) continue;
      const label = String(button.getAttribute('aria-label') || '');
      const title = String(button.getAttribute('title') || '');
      const text = getText(button).replace(/\s+/g, ' ');
      const controls = String(button.getAttribute('aria-controls') || '');
      const hasIcon = buttonHasCommentIcon(button);
      let score = 0;
      if (hasIcon) score += 120;
      if (/コメント/.test(label)) score += 80;
      if (/コメント/.test(title)) score += 70;
      if (/コメント/.test(text)) score += 55;
      if (/comment/i.test(controls)) score += 35;
      if (button.getAttribute('aria-expanded') === 'false' || button.getAttribute('aria-expanded') === 'true') score += 10;
      const rect = button.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.5) score += 8;
      if (button.disabled) score -= 100;
      if (score >= 50) candidates.push({ button, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  function visibleCommentTextarea() {
    for (const textarea of document.querySelectorAll('textarea')) {
      if (!isElementVisible(textarea)) continue;
      const placeholder = String(textarea.getAttribute('placeholder') || '');
      const label = String(textarea.getAttribute('aria-label') || '');
      if (/コメント/.test(placeholder) || /コメント/.test(label)) return textarea;
    }
    return null;
  }

  function isCommentPanelOpen(button = null) {
    if (button instanceof HTMLButtonElement) {
      if (button.getAttribute('aria-expanded') === 'true') return true;
      if (button.getAttribute('aria-pressed') === 'true') return true;
    }
    if (visibleCommentTextarea()) return true;
    const scroller = findCommentScrollContainer();
    if (scroller && isElementVisible(scroller)) {
      const visibleRows = [...scroller.querySelectorAll('li, [role="listitem"], [class*="comment" i]')]
        .slice(-30)
        .filter(isElementVisible);
      if (visibleRows.length >= 2) return true;
    }
    return false;
  }

  function findModalRootForButton(button) {
    if (!(button instanceof HTMLButtonElement)) return null;
    const semantic = button.closest('dialog, [role="dialog"], [aria-modal="true"]');
    if (semantic instanceof Element && isElementVisible(semantic)) return semantic;

    let node = button.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      if (!(node instanceof HTMLElement) || !isElementVisible(node)) continue;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const z = Number.parseInt(style.zIndex, 10);
      const isOverlay = style.position === 'fixed' &&
        rect.width >= Math.min(260, window.innerWidth * 0.45) &&
        rect.height >= 80 &&
        rect.width <= window.innerWidth + 8 &&
        rect.height <= window.innerHeight + 8 &&
        (Number.isFinite(z) ? z > 0 : true);
      const hasChoices = node.querySelectorAll('button').length >= 2;
      const nearCenter = rect.left < window.innerWidth * 0.75 &&
        rect.right > window.innerWidth * 0.25 &&
        rect.top < window.innerHeight * 0.75 &&
        rect.bottom > window.innerHeight * 0.25;
      if (isOverlay && hasChoices && nearCenter) return node;
    }
    return null;
  }

  function findVisibleLaterDialogButton() {
    const candidates = [];
    for (const button of document.querySelectorAll('button')) {
      if (!(button instanceof HTMLButtonElement) || button.disabled || !isElementVisible(button)) continue;
      const labels = [
        getText(button),
        button.getAttribute('aria-label') || '',
        button.getAttribute('title') || ''
      ].map((value) => String(value).replace(/\s+/g, '').trim());
      const exactLater = labels.some((value) => value === '後で' || value === 'あとで');
      if (!exactLater) continue;
      const modal = findModalRootForButton(button);
      if (!modal) continue;
      let score = 0;
      if (button.closest('dialog, [role="dialog"], [aria-modal="true"]')) score += 100;
      const style = getComputedStyle(modal);
      if (style.position === 'fixed') score += 25;
      if (modal.querySelectorAll('button').length >= 2) score += 15;
      candidates.push({ button, modal, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  async function dismissBlockingLaterDialog() {
    const candidate = findVisibleLaterDialogButton();
    if (!candidate) return false;
    const { button, modal } = candidate;
    try {
      button.click();
    } catch (_) {
      return false;
    }
    for (let i = 0; i < 8; i++) {
      await wait(150);
      if (!button.isConnected || !isElementVisible(button) || !modal.isConnected || !isElementVisible(modal)) return true;
    }
    return !isElementVisible(button);
  }

  function revealPlayerControls() {
    const x = Math.max(1, Math.round(window.innerWidth * 0.72));
    const y = Math.max(1, Math.round(window.innerHeight * 0.72));
    const target = document.elementFromPoint(x, y) || document.querySelector('video') || document.body;
    for (const type of ['mouseover', 'mousemove', 'pointermove']) {
      try {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          view: window
        }));
      } catch (_) {}
    }
  }

  async function openCommentPanel(requestId) {
    emitCommentPanelStatus({
      status: 'starting',
      requestId,
      message: 'コメント欄を確認しています…'
    });

    let dismissedLaterDialog = await dismissBlockingLaterDialog();
    if (dismissedLaterDialog) await wait(250);

    if (isCommentPanelOpen()) {
      scanVisibleComments();
      emitCommentPanelStatus({
        status: 'success',
        requestId,
        alreadyOpen: true,
        dismissedLaterDialog,
        message: dismissedLaterDialog ? '「後で」の案内を閉じました。コメント欄はすでに開いています。' : 'コメント欄はすでに開いています。'
      });
      return;
    }

    let candidate = null;
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (attempt > 1 && await dismissBlockingLaterDialog()) {
        dismissedLaterDialog = true;
        await wait(250);
      }
      revealPlayerControls();
      await wait(attempt === 1 ? 350 : 600);
      candidate = findCommentOpenButton();
      if (candidate) break;
    }

    if (!candidate) {
      emitCommentPanelStatus({
        status: 'error',
        requestId,
        message: 'コメント欄を開くボタンを見つけられませんでした。ABEMAの視聴画面を開いた状態で再試行してください。'
      });
      return;
    }

    const { button } = candidate;
    const descriptor = describeCommentButton(button);
    if (button.disabled) {
      emitCommentPanelStatus({
        status: 'error',
        requestId,
        button: descriptor,
        message: 'コメントボタンは見つかりましたが、現在は無効になっています。'
      });
      return;
    }

    if (isCommentPanelOpen(button)) {
      scanVisibleComments();
      emitCommentPanelStatus({
        status: 'success',
        requestId,
        alreadyOpen: true,
        button: descriptor,
        message: 'コメント欄はすでに開いています。'
      });
      return;
    }

    emitCommentPanelStatus({
      status: 'clicking',
      requestId,
      button: descriptor,
      message: 'コメントボタンを検出しました。開いています…'
    });

    try {
      button.click();
    } catch (error) {
      emitCommentPanelStatus({
        status: 'error',
        requestId,
        button: descriptor,
        message: `コメントボタンのクリックに失敗しました: ${String(error?.message || error)}`
      });
      return;
    }

    for (let check = 1; check <= 12; check++) {
      await wait(350);
      scanVisibleComments();
      if (isCommentPanelOpen(button)) {
        emitCommentPanelStatus({
          status: 'success',
          requestId,
          alreadyOpen: false,
          button: descriptor,
          dismissedLaterDialog,
          message: dismissedLaterDialog ? '「後で」の案内を閉じて、コメント欄を自動で開けました。' : 'コメント欄を自動で開けました。'
        });
        return;
      }
    }

    emitCommentPanelStatus({
      status: 'error',
      requestId,
      button: descriptor,
      message: 'コメントボタンは押せましたが、コメント欄が開いたことを確認できませんでした。'
    });
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
    } else if (data.type === 'OPEN_COMMENT_PANEL') {
      openCommentPanel(data.payload?.requestId || Date.now());
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
