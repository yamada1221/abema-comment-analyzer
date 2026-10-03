(() => {
  const DEFAULTS = {
    learningMinComments: 5,
    learningMinMutedUsers: 3,
    learningMaxCommentsPerUser: 40,
    learningCandidateThreshold: 0.25,
    learningSelectedMatchThreshold: 0.70,
    learningAutoMuteThreshold: 0.40,
    learningNormalPenalty: 0.75
  };

  function normalizeMessage(message) {
    return String(message || '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/https?:\/\/\S+/g, 'url')
      .replace(/\d{3,}/g, '0')
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .replace(/(.)\1{4,}/g, '$1$1$1$1')
      .slice(0, 160);
  }

  function extractFeatures(message) {
    const text = normalizeMessage(message);
    const set = new Set();
    if (!text) return set;
    if (text.length <= 12) set.add('w:' + text);
    for (const size of [2, 3]) {
      if (text.length < size) continue;
      for (let i = 0; i <= text.length - size; i++) {
        set.add(size + ':' + text.slice(i, i + size));
      }
    }
    return set;
  }

  const MAX_SELECTED_SAMPLES = 200;
  const SELECTED_MATCH_THRESHOLD = 0.70;
  const SELECTED_MIN_MATCHES = 2;

  function selectedCommentKey(comment) {
    const userId = String(comment.userId || ''), id = String(comment.commentId || comment.id || '');
    // A re-observed historical post keeps its identity even when fallback timestamps change.
    return id ? JSON.stringify(['id', userId, id]) : JSON.stringify(['text', userId,
      Number(comment.createdAtMs || comment.observedAt || 0), normalizeMessage(comment.message)]);
  }

  // Explicit examples are independent of mute status and history retention.
  function normalizeSelectedSamples(value) {
    if (value === undefined) return { version: 1, samples: [] };
    if (!value || value.version !== 1 || !Array.isArray(value.samples) || value.samples.length > MAX_SELECTED_SAMPLES) {
      throw new Error('指定した学習コメントの保存形式が正しくありません。');
    }
    const samples = new Map();
    for (const c of value.samples) {
      if (!c || typeof c.userId !== 'string' || !c.userId.trim() || c.userId.length > 128 ||
          typeof c.message !== 'string' || !normalizeMessage(c.message) || c.message.length > 4096 ||
          typeof c.commentId !== 'string' || c.commentId.length > 512 ||
          !Number.isFinite(c.createdAtMs) || c.createdAtMs <= 0 ||
          !Number.isFinite(c.selectedAt) || c.selectedAt <= 0) {
        throw new Error('指定した学習コメントに不正なデータがあります。');
      }
      const sample = { userId: c.userId, commentId: c.commentId, message: c.message,
        createdAtMs: c.createdAtMs, selectedAt: c.selectedAt };
      sample.key = selectedCommentKey(sample);
      samples.set(sample.key, sample);
    }
    return { version: 1, samples: [...samples.values()] };
  }

  function addSelectedSample(value, comment, now = Date.now()) {
    const current = normalizeSelectedSamples(value);
    const sample = normalizeSelectedSamples({ version: 1, samples: [{
      userId: String(comment?.userId || ''), commentId: String(comment?.id || ''),
      message: String(comment?.message || ''), createdAtMs: Number(comment?.createdAtMs || comment?.observedAt || 0),
      selectedAt: now
    }] }).samples[0];
    if (current.samples.some(c => c.key === sample.key)) return current;
    if (current.samples.length >= MAX_SELECTED_SAMPLES) throw new Error(`学習コメントは${MAX_SELECTED_SAMPLES}件までです。不要な指定を解除してください。`);
    return { version: 1, samples: [...current.samples, sample] };
  }

  // Bounded, normalized samples; no raw page titles or full comment archive.
  function updateMemory(memory, comments, mutedUsers, excludedUsers = [], now = Date.now()) {
    const allowed = new Set((mutedUsers || []).map(String));
    for (const id of excludedUsers) allowed.delete(String(id));
    const grouped = new Map();
    const samples = Array.isArray(memory?.samples) ? memory.samples : [];
    for (const c of [...samples, ...(Array.isArray(comments) ? comments : [])]) {
      const userId = String(c?.userId || '');
      const time = Number(c?.createdAtMs || c?.observedAt || 0);
      const message = normalizeMessage(c?.message);
      if (!allowed.has(userId) || userId.length > 128 || !message ||
          !Number.isFinite(time) || time <= 0 || time > now || now - time > 180 * 86400000) continue;
      if (!grouped.has(userId)) grouped.set(userId, new Map());
      // Re-reading the same comment must not refresh its age or increase its weight.
      grouped.get(userId).set(JSON.stringify([time, message]), { userId, message, createdAtMs: time });
    }
    const users = [...grouped.values()].map(items => [...items.values()]
      .sort((a,b) => a.createdAtMs - b.createdAtMs || a.message.localeCompare(b.message)).slice(-40))
      .sort((a,b) => b[b.length-1].createdAtMs - a[a.length-1].createdAtMs).slice(0, 200);
    return { version: 1, samples: users.flat() };
  }

  function buildProfiles(comments, maxCommentsPerUser) {
    const grouped = new Map();
    for (const comment of comments || []) {
      const userId = String(comment?.userId || '');
      if (!userId) continue;
      if (!grouped.has(userId)) grouped.set(userId, []);
      grouped.get(userId).push(comment);
    }

    const profiles = new Map();
    for (const [userId, list] of grouped) {
      list.sort((a, b) => Number(a.createdAtMs || a.observedAt || 0) - Number(b.createdAtMs || b.observedAt || 0));
      const recent = list.slice(-maxCommentsPerUser);
      const counts = new Map();
      for (const comment of recent) {
        const features = extractFeatures(comment.message);
        for (const feature of features) counts.set(feature, (counts.get(feature) || 0) + 1);
      }
      profiles.set(userId, {
        userId,
        commentCount: recent.length,
        updatedAt: Number(recent[recent.length - 1]?.createdAtMs || recent[recent.length - 1]?.observedAt || 0),
        counts,
        recent,
        sample: recent.slice(-3).map((c) => String(c.message || ''))
      });
    }
    return profiles;
  }

  function buildIdf(profiles) {
    const df = new Map();
    for (const profile of profiles.values()) {
      for (const feature of profile.counts.keys()) df.set(feature, (df.get(feature) || 0) + 1);
    }
    const n = Math.max(1, profiles.size);
    const idf = new Map();
    for (const [feature, count] of df) idf.set(feature, Math.log((n + 1) / (count + 1)) + 1);
    return idf;
  }

  function normalizedVector(profile, idf) {
    const vector = new Map();
    let normSq = 0;
    for (const [feature, count] of profile.counts) {
      const value = (1 + Math.log(count)) * (idf.get(feature) || 1);
      vector.set(feature, value);
      normSq += value * value;
    }
    const norm = Math.sqrt(normSq) || 1;
    for (const [feature, value] of vector) vector.set(feature, value / norm);
    return vector;
  }

  function centroid(ids, profiles, idf, now = null) {
    const result = new Map();
    let used = 0;
    for (const userId of ids) {
      const profile = profiles.get(userId);
      if (!profile) continue;
      const vector = normalizedVector(profile, idf);
      for (const [feature, value] of vector) result.set(feature, (result.get(feature) || 0) + value * (now === null ? 1 : Math.pow(0.5, Math.max(0, now - profile.updatedAt) / (30 * 86400000))));
      used++;
    }
    if (!used) return { vector: result, used: 0 };
    for (const [feature, value] of result) result.set(feature, value / used);
    return { vector: result, used };
  }

  function normalizeVector(vector) {
    let normSq = 0;
    for (const value of vector.values()) normSq += value * value;
    const norm = Math.sqrt(normSq) || 1;
    const out = new Map();
    for (const [feature, value] of vector) {
      if (value > 0) out.set(feature, value / norm);
    }
    return out;
  }

  function prettyFeature(feature) {
    const pos = feature.indexOf(':');
    return pos >= 0 ? feature.slice(pos + 1) : feature;
  }

  function scoreProfile(profile, model) {
    const vector = normalizedVector(profile, model.idf);
    let dot = 0;
    const matches = [];
    for (const [feature, value] of vector) {
      const modelValue = model.vector.get(feature) || 0;
      if (!modelValue) continue;
      const contribution = value * modelValue;
      dot += contribution;
      matches.push([feature, contribution]);
    }
    matches.sort((a, b) => b[1] - a[1]);
    const patterns = [];
    for (const [feature] of matches) {
      const text = prettyFeature(feature);
      if (!text || patterns.includes(text)) continue;
      patterns.push(text);
      if (patterns.length >= 6) break;
    }
    return {
      score: Math.max(0, Math.min(1, dot)),
      patterns
    };
  }

  function analyzeSelected(profiles, selected, muted, whitelist, settings) {
    const minComments = Math.max(2, Number(settings.learningMinComments) || 5);
    const normalIds = [...profiles.keys()].filter(id => !muted.has(id) && !whitelist.has(id) && profiles.get(id).commentCount >= minComments);
    const idf = buildIdf(profiles);
    const ordinary = centroid(normalIds, profiles, idf).vector;
    const penalty = Math.max(0, Math.min(1.5, Number(settings.learningNormalPenalty) || 0.75));
    const matchThreshold = Math.max(0.10, Math.min(1,
      Number(settings.learningSelectedMatchThreshold) || SELECTED_MATCH_THRESHOLD));
    const selectedKeys = new Set(selected.samples.map(c => c.key));
    const templates = selected.samples.map(sample => {
      const counts = new Map([...extractFeatures(sample.message)].map(f => [f, 1]));
      const positive = normalizedVector({ counts }, idf);
      const discriminant = new Map();
      for (const [f, v] of positive) {
        const distinctive = v - penalty * (ordinary.get(f) || 0);
        if (distinctive > 0) discriminant.set(f, distinctive);
      }
      return { sample, idf, vector: normalizeVector(discriminant) };
    });
    // Compare each post with each selected example, without averaging unrelated examples.
    // The inverted index shares work across examples and keeps large selections bounded.
    const index = new Map();
    templates.forEach((template, i) => {
      for (const [feature, value] of template.vector) {
        if (!index.has(feature)) index.set(feature, []);
        index.get(feature).push([i, value]);
      }
    });
    const candidates = [];
    const threshold = Math.max(0, Math.min(1, Number(settings.learningCandidateThreshold) || 0.25));
    for (const userId of normalIds) {
      const profile = profiles.get(userId);
      const seen = new Set(), evidence = [];
      for (const comment of profile.recent) {
        const key = selectedCommentKey(comment);
        if (seen.has(key) || selectedKeys.has(key)) continue;
        seen.add(key);
        const counts = new Map([...extractFeatures(comment.message)].map(f => [f, 1]));
        const vector = normalizedVector({ counts }, idf), scores = new Map();
        for (const [feature, value] of vector) {
          for (const [i, modelValue] of index.get(feature) || []) scores.set(i, (scores.get(i) || 0) + value * modelValue);
        }
        let best = -1, score = 0;
        for (const [i, dot] of scores) if (dot > score) { best = i; score = Math.min(1, dot); }
        if (best < 0 || score < matchThreshold) continue;
        const template = templates[best];
        evidence.push({ message: String(comment.message || ''), createdAtMs: Number(comment.createdAtMs || comment.observedAt),
          sourceUserId: template.sample.userId, sourceMessage: template.sample.message, sourceCommentKey: template.sample.key, score,
          patterns: scoreProfile({ counts }, template).patterns });
      }
      if (evidence.length < SELECTED_MIN_MATCHES) continue;
      const score = evidence.reduce((sum, item) => sum + item.score, 0) / evidence.length;
      if (score < threshold) continue;
      evidence.sort((a,b) => b.score - a.score);
      candidates.push({ userId, score, commentCount: profile.commentCount, matchedCommentCount: evidence.length,
        source: 'selected-comments', patterns: [...new Set(evidence.flatMap(e => e.patterns))].slice(0,6),
        sample: evidence.slice(0,3).map(e => e.message), evidence: evidence.slice(0,3) });
    }
    candidates.sort((a,b) => b.score - a.score || b.matchedCommentCount - a.matchedCommentCount);
    return { ready: true, reason: '', mode: 'selected-comments', trainingUsers: new Set(selected.samples.map(c => c.userId)).size,
      selectedSamples: selected.samples.length, normalUsers: normalIds.length, analyzedUsers: profiles.size,
      featureCount: index.size, candidates: candidates.slice(0,100) };
  }

  function analyze(comments, mutedUsers, whitelistUsers, options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const currentProfiles = buildProfiles(comments, Math.max(5, Number(settings.learningMaxCommentsPerUser) || 40));
    const muted = new Set((mutedUsers || []).map(String));
    const trainingExcluded = new Set((settings.learningTrainingExcludedUsers || []).map(String));
    const whitelist = new Set((whitelistUsers || []).map(String));
    const selected = normalizeSelectedSamples(settings.learningSelectedSamples);
    if (selected.samples.length) return analyzeSelected(currentProfiles, selected, muted, whitelist, settings);
    const now = Number(options.now) || Date.now();
    const memory = updateMemory(options.learningMemory, comments, [...muted], [...trainingExcluded, ...whitelist], now);
    const profiles = new Map(currentProfiles);
    for (const id of muted) profiles.delete(id);
    for (const [id, profile] of buildProfiles(memory.samples, 40)) profiles.set(id, profile);
    const minComments = Math.max(2, Number(settings.learningMinComments) || 5);
    const minMutedUsers = Math.max(1, Number(settings.learningMinMutedUsers) || 3);

    const trainingIds = [...muted].filter((id) => !trainingExcluded.has(id) && !whitelist.has(id) && (profiles.get(id)?.commentCount || 0) >= minComments);
    if (trainingIds.length < minMutedUsers) {
      return {
        ready: false,
        reason: `学習に使えるミュート済みユーザーが ${trainingIds.length} 人です。最低 ${minMutedUsers} 人必要です。`,
        trainingUsers: trainingIds.length,
        analyzedUsers: profiles.size,
        candidates: []
      };
    }

    const normalIds = [...profiles.keys()].filter((id) =>
      !muted.has(id) &&
      !whitelist.has(id) &&
      (profiles.get(id)?.commentCount || 0) >= minComments
    );

    const idf = buildIdf(profiles);
    const mutedCentroid = centroid(trainingIds, profiles, idf, now);
    const normalCentroid = centroid(normalIds, profiles, idf);
    const penalty = Math.max(0, Math.min(1.5, Number(settings.learningNormalPenalty) || 0.75));
    const discriminant = new Map();

    for (const [feature, value] of mutedCentroid.vector) {
      const normalValue = normalCentroid.vector.get(feature) || 0;
      const distinctive = value - penalty * normalValue;
      if (distinctive > 0) discriminant.set(feature, distinctive);
    }

    const model = { idf, vector: normalizeVector(discriminant) };
    if (!model.vector.size) {
      return {
        ready: false,
        reason: 'ミュート済みユーザーに固有のコメント傾向をまだ抽出できません。',
        trainingUsers: trainingIds.length,
        analyzedUsers: profiles.size,
        candidates: []
      };
    }

    const threshold = Math.max(0, Math.min(1, Number(settings.learningCandidateThreshold) || 0.25));
    const candidates = [];
    for (const userId of normalIds) {
      const profile = profiles.get(userId);
      const result = scoreProfile(profile, model);
      if (result.score < threshold) continue;
      candidates.push({
        userId,
        score: result.score,
        commentCount: profile.commentCount,
        patterns: result.patterns,
        sample: profile.sample
      });
    }
    candidates.sort((a, b) => b.score - a.score || b.commentCount - a.commentCount);

    return {
      ready: true,
      reason: '',
      trainingUsers: trainingIds.length,
      normalUsers: normalIds.length,
      analyzedUsers: profiles.size,
      featureCount: model.vector.size,
      candidates: candidates.slice(0, 100)
    };
  }

  globalThis.ABEMACommentLearning = { analyze, normalizeMessage, updateMemory,
    selectedCommentKey, normalizeSelectedSamples, addSelectedSample,
    MAX_SELECTED_SAMPLES, SELECTED_MATCH_THRESHOLD, SELECTED_MIN_MATCHES };
})();
