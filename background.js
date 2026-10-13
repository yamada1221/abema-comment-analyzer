importScripts('learning-model.js', 'moderation-store.js', 'auto-program-schedules.js');
const SOURCE = 'abema-comment-analyzer';
const ALARM_NAME = 'auto-program-watch';
const DEFAULT_AUTO_PROGRAM = ABEMAAutoPrograms.DEFAULTS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serialize session mutations within this worker. Durable session state stays in storage.
let autoProgramQueue = Promise.resolve();
let autoProgramRevision = 0;
async function appendCapturedComments(batch) {
  if (!Array.isArray(batch) || batch.some(c => !c || typeof c !== 'object' ||
      typeof c.message !== 'string' || !c.userId)) throw new Error('Invalid comment batch');
  // Content scripts on different tabs must not perform independent read/modify/write cycles.
  // This extension-origin lock is also used by backup restore and history deletion.
  return navigator.locks.request('abema-comment-history', async () => {
    const data = await chrome.storage.local.get(['comments', 'captureEnabled']);
    if (data.captureEnabled === false) return { ok: true, skipped: true };
    const now = Date.now(), byId = new Map();
    for (const c of (Array.isArray(data.comments) ? data.comments : []).concat(batch)) {
      const key = String(c.id || `${c.userId}:${c.createdAtMs || c.observedAt}:${c.message}`);
      byId.set(key, c);
    }
    const comments = [...byId.values()]
      .filter(c => now - Number(c.observedAt || c.createdAtMs || now) <= 30 * 24 * 60 * 60 * 1000)
      .sort((a, b) => Number(a.createdAtMs || a.observedAt) - Number(b.createdAtMs || b.observedAt))
      .slice(-100000);
    await chrome.storage.local.set({ comments, lastCommentAt: now });
    return { ok: true };
  });
}

function queueAutoProgram(operation) {
  const result = autoProgramQueue.then(operation);
  autoProgramQueue = result.catch(() => {});
  return result;
}

function tickAutoProgram(options = {}) {
  const revision = autoProgramRevision;
  return queueAutoProgram(() => {
    if (revision !== autoProgramRevision) return;
    return runAutoProgramTick(options, revision);
  });
}

function applyAutoProgramSettings() {
  const revision = ++autoProgramRevision;
  return queueAutoProgram(async () => {
    if (revision !== autoProgramRevision) return;
    await chrome.storage.local.remove(['autoProgramLastCompletedWindowKey', 'autoProgramCompletedWindowKeys']);
    if (revision === autoProgramRevision) return runAutoProgramTick({}, revision);
  });
}

function stopAutoProgram() {
  // Invalidate pending detections immediately, before waiting for the session writer.
  autoProgramRevision += 1;
  return queueAutoProgram(async () => {
    const settings = await getSettings();
    const data = await chrome.storage.local.get('autoProgramSession');
    if (data.autoProgramSession) {
      const session = data.autoProgramSession;
      session.windowKeys = [...new Set([...sessionWindowKeys(session),
        ...ABEMAAutoPrograms.windows(new Date(), settings).map(program => program.windowKey)])];
      await finishSession(settings, session, '手動で自動記録を停止しました。', true);
    } else {
      await completeWindows(ABEMAAutoPrograms.windows(new Date(), settings).map(program => program.windowKey));
      await setStatus('stopped', { message: '実行中の自動記録はありません。' });
    }
  });
}

function sessionWindowKeys(session) {
  return session?.windowKeys || (session?.windowKey ? [session.windowKey] : []);
}

async function completeWindows(keys) {
  if (!keys.length) return;
  const data = await chrome.storage.local.get('autoProgramCompletedWindowKeys');
  const completed = [...new Set([...(data.autoProgramCompletedWindowKeys || []), ...keys])].slice(-60);
  await chrome.storage.local.set({ autoProgramCompletedWindowKeys: completed });
}

async function getSettings() {
  const data = await chrome.storage.local.get('autoProgramSettings');
  return { ...DEFAULT_AUTO_PROGRAM, ...(data.autoProgramSettings || {}) };
}

async function setStatus(status, extra = {}) {
  await chrome.storage.local.set({
    autoProgramStatus: {
      status,
      updatedAt: Date.now(),
      ...extra
    }
  });
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

function urlMatchesTarget(tabUrl, targetUrl) {
  try {
    const a = new URL(tabUrl || '');
    const b = new URL(targetUrl || '');
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch (_) {
    return false;
  }
}

async function findExistingTargetTab(settings) {
  const tabs = await chrome.tabs.query({ url: 'https://abema.tv/*' });
  return tabs.find((tab) => urlMatchesTarget(tab.pendingUrl || tab.url, settings.url)) || null;
}

async function waitForContent(tabId, keyword, maxAttempts = 12, isCurrent = () => true) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isCurrent()) return null;
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        source: SOURCE,
        type: 'AUTO_PROGRAM_STATE_REQUEST',
        keyword
      });
      if (result?.ok) return result;
    } catch (error) {
      lastError = error;
    }
    if (isCurrent()) await sleep(800);
  }
  throw lastError || new Error('ABEMAタブへ接続できませんでした');
}

async function ensureSession(settings, windowKey) {
  const data = await chrome.storage.local.get(['autoProgramSession', 'captureEnabled']);
  let session = data.autoProgramSession || null;

  if (session?.windowKey === windowKey) {
    const needsMetadata = !session.targetUrl || !session.keyword;
    session = { ...session, targetUrl: settings.url, keyword: settings.keyword };
    let tab = await getTab(session.tabId);
    if (tab && urlMatchesTarget(tab.pendingUrl || tab.url, settings.url)) {
      if (needsMetadata) await chrome.storage.local.set({ autoProgramSession: session });
      return { session, tab };
    }

    tab = await findExistingTargetTab(settings);
    let ownedTab = false;
    if (!tab) {
      tab = await chrome.tabs.create({ url: settings.url, active: !!settings.openActive });
      ownedTab = true;
    }
    session = {
      ...session,
      tabId: tab.id,
      ownedTab,
      missingPolls: 0,
      reopenedAt: Date.now()
    };
    await chrome.storage.local.set({
      autoProgramSession: session,
      captureEnabled: session.active ? true : false
    });
    await setStatus('waiting-page', {
      message: '監視対象のABEMAタブに接続し直しました。',
      tabId: tab.id,
      windowKey
    });
    return { session, tab };
  }

  let tab = await findExistingTargetTab(settings);
  let ownedTab = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: settings.url, active: !!settings.openActive });
    ownedTab = true;
  }

  const hadCaptureValue = Object.prototype.hasOwnProperty.call(data, 'captureEnabled');
  session = {
    windowKey,
    targetUrl: settings.url,
    keyword: settings.keyword,
    tabId: tab.id,
    ownedTab,
    active: false,
    missingPolls: 0,
    createdAt: Date.now(),
    previousCaptureHadValue: hadCaptureValue,
    previousCaptureEnabled: data.captureEnabled
  };
  await chrome.storage.local.set({
    autoProgramSession: session,
    captureEnabled: false
  });
  await setStatus('waiting-page', {
    message: 'ABEMAを起動しました。番組名を確認します。',
    tabId: tab.id,
    windowKey
  });
  return { session, tab };
}

async function restoreCapture(session) {
  if (!session) return;
  if (session.previousCaptureHadValue) {
    await chrome.storage.local.set({ captureEnabled: session.previousCaptureEnabled });
  } else {
    await chrome.storage.local.remove('captureEnabled');
  }
}

async function finishSession(settings, session, reason, completed = true) {
  if (!session) return;
  await restoreCapture(session);

  if (session.ownedTab && (session.closeOwnedTab ?? settings.closeOwnedTab)) {
    const tab = await getTab(session.tabId);
    const targetUrl = session.targetUrl || session.lastDetection?.url || settings.url;
    if (tab && urlMatchesTarget(tab.pendingUrl || tab.url, targetUrl)) {
      try {
        await chrome.tabs.remove(session.tabId);
      } catch (_) {}
    }
  }

  const update = {
    autoProgramSession: null,
    autoProgramStatus: {
      status: 'stopped',
      message: reason,
      updatedAt: Date.now(),
      windowKey: session.windowKey
    }
  };
  if (completed) {
    await completeWindows(sessionWindowKeys(session));
    update.autoProgramLastCompletedWindowKey = session.windowKey;
  }
  await chrome.storage.local.set(update);
}

async function openSessionCommentPanel(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      source: SOURCE,
      type: 'OPEN_COMMENT_PANEL_REQUEST',
      requestId: Date.now()
    });
  } catch (_) {}
}

async function runAutoProgramTick({ force = false } = {}, revision) {
  const config = await getSettings();
  const data = await chrome.storage.local.get(['autoProgramSession', 'autoProgramLastCompletedWindowKey', 'autoProgramCompletedWindowKeys']);
  let session = data.autoProgramSession || null;
  if (revision !== autoProgramRevision) return;

  if (!config.enabled && !force) {
    if (session) await finishSession(config, session, '自動起動を停止しました。', false);
    else await setStatus('disabled', { message: '自動起動はOFFです。' });
    return;
  }

  const windows = ABEMAAutoPrograms.windows(new Date(), config, force);
  if (!windows.length) {
    if (session) await finishSession(config, session, '監視時間帯を終了しました。', true);
    else await setStatus('idle', { message: '次の監視時間帯を待っています。' });
    return;
  }

  const completed = new Set([...(data.autoProgramCompletedWindowKeys || []), data.autoProgramLastCompletedWindowKey]);
  const pending = windows.filter(program => force || !completed.has(program.windowKey));
  if (!pending.length) {
    if (session) await finishSession(config, session, 'この時間帯の自動記録を終了しました。', true);
    await setStatus('completed', {
      message: 'この時間帯の自動記録は終了済みです。',
      windowKey: windows[0].windowKey
    });
    return;
  }

  // Overlapping windows for one channel share its tab and original capture preference.
  const target = pending.find(program => program.timed) ||
    pending.find(program => urlMatchesTarget(program.url, session?.targetUrl)) || pending[0];
  const group = pending.filter(program => urlMatchesTarget(program.url, target.url));
  const keys = group.map(program => program.windowKey);
  const primary = group.find(program => !program.timed);
  const settings = { ...target, keyword: primary?.keyword || target.label,
    label: group.map(program => program.label).join(' / '), timed: group.some(program => program.timed) };
  const settingsKey = JSON.stringify(config);
  const sessionUrl = session?.targetUrl || session?.lastDetection?.url;
  const sessionKeyword = session?.keyword || session?.lastDetection?.keyword;
  const changed = session?.settingsKey ? session.settingsKey !== settingsKey :
    sessionKeyword && sessionKeyword !== settings.keyword;
  if (session && (!sessionWindowKeys(session).some(key => keys.includes(key))
      || (sessionUrl && !urlMatchesTarget(sessionUrl, settings.url)) || changed)) {
    await finishSession(config, session, '監視枠または対象番組が変わったため記録を切り替えます。', false);
    session = null;
  }
  const schedule = { windowKey: session?.windowKey || target.windowKey };
  if (revision !== autoProgramRevision) return;

  const ensured = await ensureSession(settings, schedule.windowKey);
  session = { ...ensured.session, settingsKey, closeOwnedTab: settings.closeOwnedTab,
    windowKeys: [...new Set([...sessionWindowKeys(ensured.session), ...keys])] };
  await chrome.storage.local.set({ autoProgramSession: session });
  const tab = ensured.tab;

  let state;
  try {
    state = await waitForContent(tab.id, settings.keyword, 12, () => revision === autoProgramRevision);
  } catch (error) {
    if (revision !== autoProgramRevision) return;
    await setStatus('error', {
      message: `ABEMAページへ接続できません: ${String(error?.message || error)}`,
      tabId: tab.id,
      windowKey: schedule.windowKey
    });
    return;
  }

  if (revision !== autoProgramRevision) return;
  const currentWindows = ABEMAAutoPrograms.windows(new Date(), config, force);
  const currentGroup = currentWindows.filter(program => keys.includes(program.windowKey));
  if (!currentGroup.length) {
    await finishSession(settings, session, '監視時間帯を終了しました。', true);
    return;
  }
  settings.timed = currentGroup.some(program => program.timed);
  settings.label = currentGroup.map(program => program.label).join(' / ');
  const currentTab = await getTab(tab.id);
  if (!state || !urlMatchesTarget(state.url, settings.url) || !currentTab
      || !urlMatchesTarget(currentTab.pendingUrl || currentTab.url, settings.url)) {
    await setStatus('waiting-page', {
      message: 'ページが切り替わったため、次の番組確認を待っています。',
      tabId: tab.id,
      windowKey: schedule.windowKey
    });
    return;
  }
  if (revision !== autoProgramRevision) return;

  if (settings.timed || state.matched) {
    const wasActive = !!session.active;
    session = {
      ...session,
      active: true,
      missingPolls: 0,
      lastMatchedAt: Date.now(),
      lastDetection: state
    };
    await chrome.storage.local.set({
      autoProgramSession: session,
      captureEnabled: true
    });

    await openSessionCommentPanel(tab.id);

    await setStatus('recording', {
      message: wasActive
        ? `${settings.label} を記録中です。`
        : settings.timed ? `${settings.label} の指定時刻になりました。コメント記録を開始しました。`
          : `${settings.label} を検出しました。コメント記録を開始しました。`,
      tabId: tab.id,
      windowKey: schedule.windowKey,
      detection: settings.timed ? { ...state, timed: true } : state,
      startedAt: session.startedAt || Date.now()
    });
    if (!session.startedAt) {
      session.startedAt = Date.now();
      await chrome.storage.local.set({ autoProgramSession: session });
    }
    return;
  }

  if (session.active) {
    const missingPolls = Number(session.missingPolls || 0) + 1;
    session = { ...session, missingPolls, lastDetection: state };
    await chrome.storage.local.set({
      autoProgramSession: session,
      captureEnabled: true
    });
    // Reconnected or reloaded pages may have a closed panel even while capture stays active.
    // The page bridge leaves an already-open panel open and serializes duplicate requests.
    await openSessionCommentPanel(tab.id);
    await setStatus('recording-unconfirmed', {
      message: `番組名を一時的に確認できませんが、監視時間帯内なので ${settings.keyword} の記録を継続します。`,
      tabId: tab.id,
      windowKey: schedule.windowKey,
      detection: state,
      missingPolls,
      startedAt: session.startedAt || session.lastMatchedAt || Date.now()
    });
    return;
  }

  await chrome.storage.local.set({ captureEnabled: false });
  await setStatus('waiting-program', {
    message: `${settings.keyword} の開始を待っています。`,
    tabId: tab.id,
    windowKey: schedule.windowKey,
    detection: state
  });
}

async function inspectExistingAbema(keyword) {
  const tabs = await chrome.tabs.query({ url: 'https://abema.tv/*' });
  const tab = tabs.find((item) => item.active) || tabs[0];
  if (!tab?.id) {
    await setStatus('inspect-error', { message: 'ABEMAタブが見つかりません。' });
    return null;
  }
  try {
    const state = await waitForContent(tab.id, keyword, 2);
    await setStatus('inspect', {
      message: state.matched ? `「${keyword}」を検出しました。` : `「${keyword}」は現在の画面では検出されませんでした。`,
      tabId: tab.id,
      detection: state
    });
    return state;
  } catch (error) {
    await setStatus('inspect-error', {
      message: 'ABEMAタブを再読み込みしてから再試行してください。'
    });
    return null;
  }
}

async function setupAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    await setupAlarm();
    if (details?.reason === 'update' && details.previousVersion === '0.7.0') {
      await chrome.storage.local.remove('autoProgramLastCompletedWindowKey');
    }
    await tickAutoProgram();
  })().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  tickAutoProgram().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) tickAutoProgram().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoProgramSettings) {
    applyAutoProgramSettings().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== SOURCE) return;
  if (message.type === 'APPEND_CAPTURED_COMMENTS') {
    appendCapturedComments(message.comments).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (['REVOKE_AUTO_MUTE', 'APPLY_AUTO_MUTE', 'SELECT_LEARNING_COMMENT', 'REMOVE_LEARNING_COMMENT'].includes(message.type)) {
    ABEMAModerationStore.apply(message).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }


  if (message.type === 'AUTO_PROGRAM_CHECK_NOW') {
    inspectExistingAbema(String(message.keyword || DEFAULT_AUTO_PROGRAM.keyword))
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'AUTO_PROGRAM_TICK_NOW') {
    tickAutoProgram({ force: !!message.force })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'AUTO_PROGRAM_SETTINGS_SAVED') {
    applyAutoProgramSettings()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'AUTO_PROGRAM_STOP_NOW') {
    stopAutoProgram()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

setupAlarm();

// A single writer serializes learning-memory updates across tabs and dashboards.
let learningMemoryQueue = Promise.resolve();
function refreshLearningMemory() {
  learningMemoryQueue = learningMemoryQueue.catch(() => {}).then(() => navigator.locks.request('abema-learning-memory', async () => {
    const d = await chrome.storage.local.get(['learningMemory', 'comments', 'mutedUsers', 'learningAutoMutedUsers', 'moderationSettings']);
    const cfg = d.moderationSettings || {};
    const memory = ABEMACommentLearning.updateMemory(d.learningMemory,
      cfg.learningEnabled ? d.comments : [], d.mutedUsers,
      [...(d.learningAutoMutedUsers || []), ...(cfg.whitelistUsers || [])]);
    if (JSON.stringify(memory) !== JSON.stringify(d.learningMemory)) await chrome.storage.local.set({ learningMemory: memory });
  }));
  learningMemoryQueue.catch(error => console.warn('[ABEMA] Learning memory save failed:', error));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['comments', 'mutedUsers', 'learningAutoMutedUsers', 'moderationSettings', 'lastTransferImportAt'].some(key => changes[key])) refreshLearningMemory();
});
refreshLearningMemory();
