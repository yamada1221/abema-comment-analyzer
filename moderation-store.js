(() => {
  const keys = ['mutedUsers', 'learningAutoMutedUsers', 'moderationSettings', 'autoMuteLog', 'learningMemory', 'learningSelectedSamples'];
  async function apply(command) {
    return navigator.locks.request('abema-learning-memory', async () => {
      const selectedOperation = command.type === 'SELECT_LEARNING_COMMENT' || command.type === 'REMOVE_LEARNING_COMMENT';
      const d = await chrome.storage.local.get(selectedOperation ? [...keys, 'comments'] : keys);
      if (selectedOperation) {
        const previous = ABEMACommentLearning.normalizeSelectedSamples(d.learningSelectedSamples);
        let next;
        if (command.type === 'SELECT_LEARNING_COMMENT') {
          const comment = (d.comments || []).find(c => ABEMACommentLearning.selectedCommentKey(c) === command.commentKey);
          if (!comment) throw new Error('コメントが保存履歴にありません。画面を更新してから指定してください。');
          next = ABEMACommentLearning.addSelectedSample(previous, comment);
        } else {
          next = { version: 1, samples: previous.samples.filter(c => c.key !== command.commentKey) };
        }
        const count = Math.abs(next.samples.length - previous.samples.length);
        if (count) await chrome.storage.local.set({ learningSelectedSamples: next, learningRebuildRequest: Date.now() });
        return { ok: true, count };
      }
      const muted = new Set((d.mutedUsers || []).map(String));
      const learned = new Set((d.learningAutoMutedUsers || []).map(String));
      const settings = { ...(d.moderationSettings || {}) };
      const excluded = new Set((settings.whitelistUsers || []).map(String));
      let log = Array.isArray(d.autoMuteLog) ? d.autoMuteLog : [];
      const now = Date.now();
      let count = 0;
      if (command.type === 'REVOKE_AUTO_MUTE') {
        const requested = new Set((command.userIds || []).map(String));
        const targets = new Set(log.filter(x => !x.revokedAt && requested.has(String(x.userId))).map(x => String(x.userId)));
        if (!targets.size) return { ok: true, count: 0 };
        for (const uid of targets) { muted.delete(uid); learned.delete(uid); excluded.add(uid); }
        log = log.map(x => targets.has(String(x.userId)) && !x.revokedAt ? { ...x, revokedAt: now } : x);
        settings.whitelistUsers = [...excluded];
        const learningMemory = ABEMACommentLearning.updateMemory(d.learningMemory, [], [...muted], [...learned, ...excluded]);
        await chrome.storage.local.set({ mutedUsers: [...muted], learningAutoMutedUsers: [...learned], moderationSettings: settings, autoMuteLog: log, learningMemory, learningRebuildRequest: now });
        return { ok: true, count: targets.size };
      }
      if (command.type !== 'APPLY_AUTO_MUTE') throw new Error('Unknown moderation operation');
      for (const entry of (command.entries || []).slice(0,100)) {
        const uid = String(entry.userId || '');
        // Re-read exclusions within the same lock as cancellation; stale candidates cannot re-mute.
        if (!uid || excluded.has(uid) || muted.has(uid)) continue;
        if (entry.learned ? !(settings.learningEnabled && settings.learningAutoMute) : !settings.enabled) continue;
        if (entry.learned) {
          const selected = ABEMACommentLearning.normalizeSelectedSamples(d.learningSelectedSamples);
          // A removed example or switched training mode must not let stale results re-mute.
          if (Boolean(selected.samples.length) !== (entry.source === 'selected-comments')) continue;
          if (selected.samples.length) {
            const active = new Map(selected.samples.map(c=>[c.key,c.message]));
            if (!Array.isArray(entry.evidence) || entry.evidence.length < ABEMACommentLearning.SELECTED_MIN_MATCHES ||
                entry.evidence.some(e=>active.get(e.sourceCommentKey)!==e.sourceMessage)) continue;
          }
        }
        muted.add(uid);
        if (entry.learned) learned.add(uid);
        log.push({ ...entry, userId: uid, mutedAt: now });
        count++;
      }
      if (count) await chrome.storage.local.set({ mutedUsers: [...muted], learningAutoMutedUsers: [...learned], autoMuteLog: log.slice(-500) });
      return { ok: true, count };
    });
  }
  globalThis.ABEMAModerationStore = { apply };
})();
