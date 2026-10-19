(() => {
  'use strict';
  const alarmName = 'capture-watchdog', source = 'abema-comment-analyzer';
  let queue = Promise.resolve();
  async function setup() {
    if (!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
  }
  async function ping(tabId) {
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, { source, type: 'CAPTURE_HEARTBEAT' }).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  function reconcile() {
    queue = queue.catch(() => {}).then(async () => {
      const { captureEnabled } = await chrome.storage.local.get('captureEnabled');
      const { captureProtectedTabs = {} } = await chrome.storage.session.get('captureProtectedTabs');
      const protectedTabs = { ...captureProtectedTabs };
      const tabs = await chrome.tabs.query({});
      const targets = tabs.filter(tab => /^https:\/\/abema\.tv\//.test(tab.pendingUrl || tab.url || ''));
      for (const [id, previous] of Object.entries(protectedTabs)) {
        const tab = tabs.find(tab => tab.id === Number(id));
        if (captureEnabled === true && targets.includes(tab)) continue;
        if (tab) {
          try { await chrome.tabs.update(tab.id, { autoDiscardable: previous }); }
          catch (_) { continue; }
        }
        delete protectedTabs[id];
      }
      if (captureEnabled === true) {
        for (const tab of targets) {
          if (tab.autoDiscardable === false) continue;
          // Save the original value before changing it; survive service-worker suspension.
          if (!Object.hasOwn(protectedTabs, tab.id)) protectedTabs[tab.id] = tab.autoDiscardable !== false;
          await chrome.storage.session.set({ captureProtectedTabs: protectedTabs });
          try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); }
          catch (_) { delete protectedTabs[tab.id]; }
        }
      }
      await chrome.storage.session.set({ captureProtectedTabs: protectedTabs });
      const reports = captureEnabled !== true ? [] : await Promise.all(targets.map(tab => ping(tab.id)));
      await chrome.storage.local.set({ backgroundCaptureStatus: {
        updatedAt: Date.now(), enabled: captureEnabled === true, tabs: targets.length,
        protectedTabs: captureEnabled !== true ? 0 : targets.filter(tab => tab.autoDiscardable === false || Object.hasOwn(protectedTabs,tab.id)).length,
        connected: reports.filter(report => report?.ok).length,
        pending: reports.reduce((sum,report) => sum+(Number(report?.pending)||0),0),
        discarded: targets.filter(tab => tab.discarded).length
      } });
    });
    queue.catch(error => console.warn('[ABEMA] Capture watchdog failed:', error));
    return queue;
  }
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) reconcile(); });
  chrome.storage.onChanged.addListener((changes,area) => { if (area === 'local' && changes.captureEnabled) reconcile(); });
  chrome.tabs.onUpdated.addListener((_id,change) => { if (change.url || change.status === 'complete') reconcile(); });
  chrome.tabs.onRemoved.addListener(() => reconcile());
  chrome.runtime.onStartup.addListener(() => { setup().then(reconcile).catch(()=>{}); });
  chrome.runtime.onInstalled.addListener(() => { setup().then(reconcile).catch(()=>{}); });
  setup().then(reconcile).catch(error => console.warn('[ABEMA] Capture watchdog setup failed:', error));
})();
