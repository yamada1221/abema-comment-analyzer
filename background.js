const SOURCE = 'abema-comment-analyzer';
const ALARM_NAME = 'auto-program-watch';
const DEFAULT_AUTO_PROGRAM = {
  enabled: false,
  keyword: '報道ステーション',
  url: 'https://abema.tv/now-on-air/abema-news',
  days: [2, 3, 4, 5, 6],
  startTime: '00:00',
  endTime: '02:00',
  closeOwnedTab: true,
  openActive: false,
  missingPollsToStop: 2
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function minutesOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return 0;
  return Math.max(0, Math.min(1439, Number(match[1]) * 60 + Number(match[2])));
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function previousDate(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return d;
}

function scheduleState(now, settings) {
  const days = new Set((settings.days || []).map(Number));
  const start = minutesOfDay(settings.startTime);
  const end = minutesOfDay(settings.endTime);
  const minute = now.getHours() * 60 + now.getMinutes();

  if (start === end) {
    return { inWindow: days.has(now.getDay()), windowKey: dateKey(now) };
  }
  if (start < end) {
    return {
      inWindow: days.has(now.getDay()) && minute >= start && minute < end,
      windowKey: dateKey(now)
    };
  }

  if (minute >= start && days.has(now.getDay())) {
    return { inWindow: true, windowKey: dateKey(now) };
  }
  const prev = previousDate(now);
  if (minute < end && days.has(prev.getDay())) {
    return { inWindow: true, windowKey: dateKey(prev) };
  }
  return { inWindow: false, windowKey: minute < end ? dateKey(prev) : dateKey(now) };
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
    return a.hostname === b.hostname && a.pathname === b.pathname;
  } catch (_) {
    return false;
  }
}

async function findExistingTargetTab(settings) {
  const tabs = await chrome.tabs.query({ url: 'https://abema.tv/*' });
  return tabs.find((tab) => urlMatchesTarget(tab.url, settings.url)) || null;
}

async function waitForContent(tabId, keyword, maxAttempts = 12) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
    await sleep(800);
  }
  throw lastError || new Error('ABEMAタブへ接続できませんでした');
}

async function ensureSession(settings, windowKey) {
  const data = await chrome.storage.local.get(['autoProgramSession', 'captureEnabled']);
  let session = data.autoProgramSession || null;

  if (session?.windowKey === windowKey) {
    let tab = await getTab(session.tabId);
    if (tab) return { session, tab };

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
      message: 'ABEMAタブが閉じられていたため再度開きました。',
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

  if (session.ownedTab && settings.closeOwnedTab) {
    const tab = await getTab(session.tabId);
    if (tab) {
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
  if (completed) update.autoProgramLastCompletedWindowKey = session.windowKey;
  await chrome.storage.local.set(update);
}

async function tickAutoProgram({ force = false } = {}) {
  const settings = await getSettings();
  const now = new Date();
  const schedule = scheduleState(now, settings);
  const data = await chrome.storage.local.get(['autoProgramSession', 'autoProgramLastCompletedWindowKey']);
  let session = data.autoProgramSession || null;

  if (!settings.enabled && !force) {
    if (session) await finishSession(settings, session, '自動起動を停止しました。', false);
    else await setStatus('disabled', { message: '自動起動はOFFです。' });
    return;
  }

  if (!schedule.inWindow && !force) {
    if (session) await finishSession(settings, session, '監視時間帯を終了しました。', true);
    else await setStatus('idle', { message: '次の監視時間帯を待っています。' });
    return;
  }

  if (!force && data.autoProgramLastCompletedWindowKey === schedule.windowKey && !session) {
    await setStatus('completed', {
      message: 'この時間帯の自動記録は終了済みです。',
      windowKey: schedule.windowKey
    });
    return;
  }

  const ensured = await ensureSession(settings, schedule.windowKey);
  session = ensured.session;
  let tab = ensured.tab;

  if (!urlMatchesTarget(tab.url, settings.url)) {
    await chrome.tabs.update(tab.id, { url: settings.url, active: !!settings.openActive });
    await sleep(1500);
  }

  let state;
  try {
    state = await waitForContent(tab.id, settings.keyword);
  } catch (error) {
    await setStatus('error', {
      message: `ABEMAページへ接続できません: ${String(error?.message || error)}`,
      tabId: tab.id,
      windowKey: schedule.windowKey
    });
    return;
  }

  if (state.matched) {
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

    try {
      await chrome.tabs.sendMessage(tab.id, {
        source: SOURCE,
        type: 'OPEN_COMMENT_PANEL_REQUEST',
        requestId: Date.now()
      });
    } catch (_) {}

    await setStatus('recording', {
      message: wasActive
        ? `${settings.keyword} を記録中です。`
        : `${settings.keyword} を検出しました。コメント記録を開始しました。`,
      tabId: tab.id,
      windowKey: schedule.windowKey,
      detection: state,
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
    tickAutoProgram().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== SOURCE) return;

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

  if (message.type === 'AUTO_PROGRAM_STOP_NOW') {
    (async () => {
      const settings = await getSettings();
      const data = await chrome.storage.local.get('autoProgramSession');
      if (data.autoProgramSession) {
        await finishSession(settings, data.autoProgramSession, '手動で自動記録を停止しました。', true);
      } else {
        await setStatus('stopped', { message: '実行中の自動記録はありません。' });
      }
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

setupAlarm();
