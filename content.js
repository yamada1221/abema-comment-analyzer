(() => {
  const SOURCE = 'abema-comment-analyzer';
  const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_COMMENTS = 100000;
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
    whitelistUsers: [],
    learningEnabled: false,
    learningMinComments: 5,
    learningMinMutedUsers: 3,
    learningMaxCommentsPerUser: 40,
    learningCandidateThreshold: 0.25,
    learningAutoMute: false,
    learningAutoMuteThreshold: 0.40,
    learningNormalPenalty: 0.75
  };

  let queue = [];
  let flushing = false;
  let contextValid = true;
  let moderation = { ...DEFAULT_MODERATION };
  let mutedUsersCache = new Set();
  let whitelistCache = new Set();
  const userActivity = new Map();
  let learningTimer = null;
  let learningRunning = false;
  let lastLearningRun = 0;

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

    // Never infer posting frequency from batch arrival/observation time.
    const t = Number(comment.createdAtMs);
    if (comment.timestampReliable === false || !Number.isFinite(t) ||
        t < 946684800000 || t > Date.now() + 60000) return null;
    const maxWindowMs = Math.max(
      Number(moderation.rateWindowSec || 30),
      Number(moderation.duplicateWindowSec || 60)
    ) * 1000;
    const previous = userActivity.get(uid) || [];
    const latest = Math.max(t, ...previous.map(item => item.t));
    const list = previous.filter(item => latest - item.t <= maxWindowMs);
    const key = String(comment.id || JSON.stringify([uid, t, message]));
    if (list.some(item => item.key === key) || latest - t > maxWindowMs) return null;
    const normalized = normalizeMessage(message);
    list.push({ t, normalized, message, key });
    list.sort((a, b) => a.t - b.t);
    userActivity.set(uid, list.slice(-100));

    // Count an actual window of W seconds, never the +/-W interval (2W).
    // Sliding windows also handle historical comments arriving out of order.
    function matchingWindow(windowMs, predicate) {
      const matching = list.filter(predicate);
      let left = 0, best = [];
      for (let right = 0; right < matching.length; right++) {
        while (matching[right].t - matching[left].t > windowMs) left++;
        const window = matching.slice(left, right + 1);
        if (window.some(item => item.key === key) && window.length > best.length) best = window;
      }
      return best;
    }
    function evidence(reason, window) {
      return { reason, evidence: {
        count: window.length,
        firstPostedAt: window[0].t,
        lastPostedAt: window[window.length - 1].t,
        spanSeconds: (window[window.length - 1].t - window[0].t) / 1000
      } };
    }
    if (moderation.duplicateEnabled && normalized) {
      const windowMs = Math.max(1, Number(moderation.duplicateWindowSec || 60)) * 1000;
      const window = matchingWindow(windowMs, item => item.normalized === normalized);
      if (window.length >= Math.max(2, Number(moderation.duplicateCount || 3))) {
        return evidence(`同文・類似連投 ${window.length}回/${Math.round(windowMs / 1000)}秒`, window);
      }
    }
    if (moderation.rateEnabled) {
      const windowMs = Math.max(1, Number(moderation.rateWindowSec || 30)) * 1000;
      const window = matchingWindow(windowMs, () => true);
      if (window.length >= Math.max(2, Number(moderation.rateCount || 8))) {
        return evidence(`高頻度投稿 ${window.length}件/${Math.round(windowMs / 1000)}秒`, window);
      }
    }

    return null;
  }

  async function autoMute(comment, reason) {
    const uid = String(comment.userId || '');
    if (!uid || mutedUsersCache.has(uid) || whitelistCache.has(uid)) return;
    mutedUsersCache.add(uid);
    try {
      const result = await chrome.runtime.sendMessage({ source: SOURCE, type: 'APPLY_AUTO_MUTE', entries: [{
        userId: uid,
        reason: typeof reason === 'string' ? reason : reason.reason,
        ...(typeof reason === 'object' ? { evidence: reason.evidence } : {}),
        message: String(comment.message || ''),
        commentAt: commentTimestamp(comment),
        pageTitle: document.title
      }] });
      if (!result?.ok) throw new Error(result?.error || '自動ミュートの保存に失敗しました');
      if (!result.count) await loadRuntimeSettings();
    } catch (error) {
      mutedUsersCache.delete(uid);
      if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] auto mute failed:', error);
    }
  }

  function scheduleLearningAnalysis(delay = 8000) {
    if (!moderation.learningEnabled || !globalThis.ABEMACommentLearning || !isContextValid()) return;
    if (learningTimer) return;
    learningTimer = setTimeout(() => {
      learningTimer = null;
      runLearningAnalysis();
    }, Math.max(0, delay));
  }

  async function runLearningAnalysis() {
    if (learningRunning || !moderation.learningEnabled || !globalThis.ABEMACommentLearning || !isContextValid()) return;
    learningRunning = true;
    lastLearningRun = Date.now();
    try {
      const data = await chrome.storage.local.get(['comments', 'mutedUsers', 'autoMuteLog', 'learningAutoMutedUsers', 'learningMemory', 'learningSelectedSamples']);
      const allMuted = (data.mutedUsers || []).map(String);
      const learnedAuto = new Set((data.learningAutoMutedUsers || []).map(String));
      const result = ABEMACommentLearning.analyze(
        Array.isArray(data.comments) ? data.comments : [],
        allMuted,
        moderation.whitelistUsers || [],
        { ...moderation, learningMemory: data.learningMemory, learningSelectedSamples: data.learningSelectedSamples,
          learningTrainingExcludedUsers: [...learnedAuto] }
      );

      const update = {
        learningStatus: {
          ready: !!result.ready,
          reason: result.reason || '',
          trainingUsers: result.trainingUsers || 0,
          normalUsers: result.normalUsers || 0,
          analyzedUsers: result.analyzedUsers || 0,
          candidateCount: result.candidates?.length || 0,
          mode: result.mode || 'muted-users',
          selectedSamples: result.selectedSamples || 0,
          updatedAt: Date.now()
        }
      };

      if (result.ready && moderation.learningAutoMute) {
        const threshold = Math.max(
          Number(moderation.learningCandidateThreshold || 0.25),
          Number(moderation.learningAutoMuteThreshold || 0.40)
        );
        const entries = (result.candidates || []).filter(candidate => candidate.score >= threshold).map(candidate => ({
          userId: candidate.userId, learned: true,
          reason: `学習型ミュート 類似度 ${(candidate.score * 100).toFixed(1)}%`,
          message: (candidate.sample || []).join(' / '), commentAt: Date.now(),
          pageTitle: document.title, patterns: candidate.patterns || [],
          ...(candidate.evidence ? { evidence: candidate.evidence, source: candidate.source } : {})
        }));
        if (entries.length) {
          const saved = await chrome.runtime.sendMessage({ source: SOURCE, type: 'APPLY_AUTO_MUTE', entries });
          if (!saved?.ok) throw new Error(saved?.error || '学習型ミュートの保存に失敗しました');
        }
      }

      await chrome.storage.local.set(update);
    } catch (error) {
      if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] learned mute analysis failed:', error);
    } finally {
      learningRunning = false;
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
      scheduleLearningAnalysis(1500);
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
      if (moderation.learningEnabled && Date.now() - lastLearningRun > 12000) scheduleLearningAnalysis(3000);
    } catch (error) {
      if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] flush failed:', error);
    } finally {
      flushing = false;
    }
  }

  function visibleForProgramDetection(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    let node = element;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      if (node.getAttribute('aria-hidden') === 'true') return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function nearVideo(element) {
    const video = document.querySelector('video');
    if (!(video instanceof Element) || !(element instanceof Element)) return false;
    const vr = video.getBoundingClientRect();
    const er = element.getBoundingClientRect();
    if (vr.width < 20 || vr.height < 20) return false;
    const margin = 260;
    return er.right >= vr.left - margin &&
      er.left <= vr.right + margin &&
      er.bottom >= vr.top - margin &&
      er.top <= vr.bottom + margin;
  }

  function detectProgramKeyword(keyword) {
    const rawKeyword = String(keyword || '').trim();
    const normalizedKeyword = rawKeyword.toLowerCase().normalize('NFKC');
    const samples = [];
    let bestScore = 0;

    const add = (source, text, score, element = null) => {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      if (!value || !normalizedKeyword) return;
      if (!value.toLowerCase().normalize('NFKC').includes(normalizedKeyword)) return;
      let finalScore = score;
      if (element && nearVideo(element)) finalScore += 2;
      bestScore = Math.max(bestScore, finalScore);
      if (!samples.some((item) => item.text === value && item.source === source)) {
        samples.push({ source, text: value.slice(0, 180), score: finalScore });
      }
    };

    add('document.title', document.title, 8);
    add('meta:og:title', document.querySelector('meta[property="og:title"]')?.content, 7);
    add('meta:twitter:title', document.querySelector('meta[name="twitter:title"]')?.content, 7);

    for (const element of document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')) {
      if (!visibleForProgramDetection(element)) continue;
      add('heading', element.textContent, 4, element);
    }

    for (const element of document.querySelectorAll('[aria-current="true"]')) {
      if (!visibleForProgramDetection(element)) continue;
      const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length <= 220) add('aria-current', text, 6, element);
    }

    const selectors = [
      '[class*="program" i]',
      '[class*="title" i]',
      '[data-testid*="program" i]',
      '[data-testid*="title" i]',
      '[aria-label*="番組"]'
    ];
    const seenElements = new Set();
    for (const selector of selectors) {
      let count = 0;
      for (const element of document.querySelectorAll(selector)) {
        if (seenElements.has(element) || !visibleForProgramDetection(element)) continue;
        seenElements.add(element);
        const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 220) continue;
        add('program-title-candidate', text, 4, element);
        if (++count >= 80) break;
      }
    }

    samples.sort((a, b) => b.score - a.score);
    const bodyContains = normalizedKeyword
      ? String(document.body?.innerText || '').toLowerCase().normalize('NFKC').includes(normalizedKeyword)
      : false;

    return {
      ok: true,
      matched: bestScore >= 6,
      score: bestScore,
      keyword: rawKeyword,
      pageTitle: document.title,
      url: location.href,
      bodyContains,
      samples: samples.slice(0, 8),
      checkedAt: Date.now()
    };
  }

  window.addEventListener('message', async (event) => {
    if (!contextValid || event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== SOURCE) return;
    if (d.type === 'NETWORK_STATUS' && d.payload && isContextValid()) {
      try {
        await chrome.storage.local.set({ networkCaptureStatus: d.payload });
      } catch (error) { invalidateContext(error); }
    } else if (d.type === 'COMMENT' && d.payload) {
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
    } else if (d.type === 'COMMENT_PANEL_STATUS' && d.payload && isContextValid()) {
      try {
        await chrome.storage.local.set({ commentPanelOpenStatus: d.payload });
      } catch (error) {
        if (!invalidateContext(error)) console.warn('[ABEMA Comment Analyzer] comment panel status failed:', error);
      }
    }
  });

  if (isContextValid()) {
    window.postMessage({ source: SOURCE, type: 'NETWORK_STATUS_REQUEST' }, '*');
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.source !== SOURCE) return;
      if (message.type === 'AUTO_PROGRAM_STATE_REQUEST') {
        sendResponse(detectProgramKeyword(message.keyword));
      } else if (message.type === 'OPEN_COMMENT_PANEL_REQUEST') {
        postToPage('OPEN_COMMENT_PANEL', { requestId: message.requestId });
        sendResponse({ ok: true, title: document.title });
      } else if (message.type === 'LOAD_HISTORY_REQUEST') {
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
        scheduleLearningAnalysis(1000);
      }
      if (changes.moderationSettings) {
        moderation = { ...DEFAULT_MODERATION, ...(changes.moderationSettings.newValue || {}) };
        whitelistCache = new Set((moderation.whitelistUsers || []).map(String));
        userActivity.clear();
        scheduleLearningAnalysis(500);
      }
      if (changes.learningMemory || changes.learningSelectedSamples) scheduleLearningAnalysis(500);
      if (changes.learningRebuildRequest) scheduleLearningAnalysis(0);
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
