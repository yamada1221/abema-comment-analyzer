(function (root) {
  'use strict';
  const tags = ABEMAUserTags, tools = ABEMACommentTools;
  let queue = Promise.resolve(), started = false;

  // Removed tags stay excluded until the user explicitly adds them again.
  // Unlike visible tags, exclusions can accumulate across changes to the rules.
  function normalizeExclusions(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自動タグ除外の保存形式が正しくありません。');
    return Object.fromEntries(Object.entries(value).map(([uid, names]) => {
      if (tags.userId(uid) !== uid || !Array.isArray(names)) throw new Error('自動タグ除外の保存形式が正しくありません。');
      return [uid, [...new Set(names.flatMap(name => tags.parse([name])))]];
    }).filter(([, names]) => names.length));
  }

  function editedExclusions(value, uid, before, after) {
    const map = new Map(Object.entries(normalizeExclusions(value)));
    const excluded = new Set(map.get(uid) || []);
    for (const name of before) if (!after.includes(name)) excluded.add(name);
    for (const name of after) excluded.delete(name);
    if (excluded.size) map.set(uid, [...excluded]); else map.delete(uid);
    return Object.fromEntries(map);
  }

  function assign(comments, existing, exclusions, settings, moderation) {
    const map = new Map(Object.entries(tags.normalizeMap(existing)));
    const excluded = normalizeExclusions(exclusions);
    for (const row of tools.annotate(comments, settings, moderation)) {
      const uid = String(row.comment.userId || '');
      if (!uid || uid !== uid.trim() || uid.length > 200) continue;
      const names = map.get(uid) || [];
      for (const item of row.tags) {
        if (names.length < tags.MAX_TAGS && !names.includes(item.name) && !tags.get(excluded, uid).includes(item.name)) names.push(item.name);
      }
      if (names.length) map.set(uid, names);
    }
    return Object.fromEntries(map);
  }

  function refresh() {
    queue = queue.catch(() => {}).then(() => navigator.locks.request('abema-comment-analyzer-user-tags', async () => {
      const data = await chrome.storage.local.get(['comments', 'userTags', 'autoTagExclusions', 'autoTagSettings',
        'autoLabelSettings', 'moderationSettings', 'storageSchemaVersion']);
      if (Number(data.storageSchemaVersion) > 6) return;
      const settings = data.autoTagSettings === undefined && data.autoLabelSettings !== undefined
        ? tools.migrateLabelSettings(data.autoLabelSettings) : tools.normalizeTagSettings(data.autoTagSettings);
      const next = assign(Array.isArray(data.comments) ? data.comments : [], data.userTags,
        data.autoTagExclusions, settings, data.moderationSettings);
      const update = {};
      if (data.autoTagSettings === undefined) update.autoTagSettings = settings;
      if (JSON.stringify(next) !== JSON.stringify(data.userTags || {})) update.userTags = next;
      if (Object.keys(update).length) await chrome.storage.local.set(update);
    }));
    return queue;
  }

  function start() {
    if (!started) {
      started = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && ['comments', 'autoTagSettings', 'moderationSettings', 'lastTransferImportAt'].some(key => changes[key])) {
          refresh().catch(error => console.warn('[ABEMA] Auto tags save failed:', error));
        }
      });
    }
    return refresh();
  }
  root.ABEMAAutoUserTags = { assign, normalizeExclusions, editedExclusions, refresh, start };
})(globalThis);
