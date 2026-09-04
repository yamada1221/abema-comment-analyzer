(() => {
  const SOURCE = 'abema-comment-analyzer';
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  const MAX_COMMENTS = 25000;
  const DEFAULT_MODERATION = {
    enabled: false,
    rateEnabled: true,
    rateCount: 8,
    rateWindowSec: 30,
    duplicateEnabled: true,
    duplicateCount: 3,
    duplicateWindowSec: 60,
    ngEnabled: true,
    ngWords: [],
    whitelistUsers: []
  };

  let queue = [];
  let flushing = false;
  let contextValid = true;
  let moderation = { ...DEFAULT_MODERATION };
  let mutedUsersCache = new Set();
  let whitelistCache = new Set();
  const userActivity = new Map();

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

  function normalizeMessage(message) {
    return String(message || '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .replace(/(.)\1{3,}/g, '$1$1$1');
  }

  function commentTimestamp(comment) {
    return Number(comment.createdAtMs || comment.observedAt || Date.now());
  }

  function moderationReason(comment) {
    if (!moderation.enabled) return null;
    const uid = String(comment.userId || '');
    if (!uid || whitelistCache.has(uid) || mutedUsersCache.has(uid)) return null;

    const message = String(comment.message || '');
    const lower = message.toLowerCase().normalize('NFKC');
    if (moderation.ngEnabled) {
      const words = Array.isArray(moderation.ngWords) ? moderation.ngWords : [];
      const hit = words.map((w) => String(w).trim()).filter(Boolean)
        .find((w) => lower.includes(w.toLowerCase().normalize('NFKC')));
      if (hit) return `NGワード「${hit}」`;
    }

    const t = commentTimestamp(comment);
    const maxWindowMs = Math.max(
      Number(moderation.rateWindowSec || 30),
      Number(moderation.duplicateWindowSec || 60)
    ) * 1000;
    const list = (userActivity.get(uid) || []).filter((item) => Math.abs(t - item.t) <= maxWindowMs);
    const normalized = normalizeMessage(message);
    list.push({ t, normalized, message });
    list.sort((a, b) => a.t - b.t);
    userActivity.set(uid, list.slice(-100));

    if (moderation.duplicateEnabled && normalized) {
      const windowMs = Math.max(1, Number(moderation.duplicateWindowSec || 60)) * 1000;
      const count = list.filter((item) => Math.abs(t - item.t) <= windowMs && item.normalized === normalized).length;
      if (count >= Math.max(2, Number(moderation.duplicateCount || 3))) {
        return `同文・類似連投 ${count}回/${Math.round(windowMs / 1000)}秒`;
      }
    }

    if (moderation.rateEnabled) {
      const windowMs = Math.max(1, Number(moderation.rateWindowSec || 30)) * 1000;
      const count = list.filter((item) => Math.abs(t - item.t) <= windowMs).length;
      if (count >= Math.max(2, Number(moderation.rateCount || 8))) {
        return `高頻度投稿 ${count}件/${Math.round(windowMs / 1000)}秒`;
      }
    }

    return null;
  }

  async function autoMute(comment, reason) {
    const uid = String(comment.userId || '');
    if (!uid || mutedUsersCache.has(uid) || whitelistCache.has(uid)) return;
    mutedUsersCache.add(uid);
    try {
      const data = await chrome.storage.local.get(['mutedUsers', 'autoMuteLog']);
      const muted = new Set((data.mutedUsers || []).map(String));
      muted.add(uid);
      const log = Array.isArray(data.autoMuteLog) ? data.autoMuteLog : [];
      log.push({
        userId: uid,
        reason,
        message: String(comment.message || ''),
        commentAt: commentTimestamp(comment),
        mutedAt: Date.now(),
        pageTitle: document.title
      });
      await chrome.storage.local.set({ mutedUsers: [...muted], autoMuteLog: log.slice(-500) });
    } catch (error) {
      if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] auto mute failed:', error);
    }
  }

  async function loadRuntimeSettings() {
    if (!isContextValid()) return;
    try {
      const data = await chrome.storage.local.get(['mutedUsers', 'moderationSettings']);
      mutedUsersCache = new Set((data.mutedUsers || []).map(String));
      moderation = { ...DEFAULT_MODERATION, ...(data.moderationSettings || {}) };
      whitelistCache = new Set((moderation.whitelistUsers || []).map(String));
      postToPage('SET_MUTED_USERS', [...mutedUsersCache]);
    } catch (error) {
      if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] settings load failed:', error);
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
      const comment = { ...d.payload, pageUrl: location.href, pageTitle: document.title };
      queue.push(comment);
      const reason = moderationReason(comment);
      if (reason) autoMute(comment, reason);
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
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.source !== SOURCE) return;
      if (message.type === 'LOAD_HISTORY_REQUEST') {
        postToPage('LOAD_HISTORY', { requestId: message.requestId });
        sendResponse({ ok: true, title: document.title });
      } else if (message.type === 'CANCEL_HISTORY_REQUEST') {
        postToPage('CANCEL_HISTORY', { requestId: message.requestId });
        sendResponse({ ok: true });
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (!isContextValid()) {
        contextValid = false;
        return;
      }
      if (area !== 'local') return;
      if (changes.mutedUsers) {
        mutedUsersCache = new Set((changes.mutedUsers.newValue || []).map(String));
        postToPage('SET_MUTED_USERS', [...mutedUsersCache]);
      }
      if (changes.moderationSettings) {
        moderation = { ...DEFAULT_MODERATION, ...(changes.moderationSettings.newValue || {}) };
        whitelistCache = new Set((moderation.whitelistUsers || []).map(String));
        userActivity.clear();
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

  loadRuntimeSettings();
})();
