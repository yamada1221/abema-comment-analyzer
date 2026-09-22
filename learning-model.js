(() => {
  const DEFAULTS = {
    learningMinComments: 5,
    learningMinMutedUsers: 3,
    learningMaxCommentsPerUser: 40,
    learningCandidateThreshold: 0.58,
    learningAutoMuteThreshold: 0.78,
    learningNormalPenalty: 0.75
  };

  function normalizeMessage(message) {
    return String(message || '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/https?:\/\/\S+/g, 'URL')
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
        counts,
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

  function centroid(ids, profiles, idf) {
    const result = new Map();
    let used = 0;
    for (const userId of ids) {
      const profile = profiles.get(userId);
      if (!profile) continue;
      const vector = normalizedVector(profile, idf);
      for (const [feature, value] of vector) result.set(feature, (result.get(feature) || 0) + value);
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

  function analyze(comments, mutedUsers, whitelistUsers, options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const profiles = buildProfiles(comments, Math.max(5, Number(settings.learningMaxCommentsPerUser) || 40));
    const muted = new Set((mutedUsers || []).map(String));
    const whitelist = new Set((whitelistUsers || []).map(String));
    const minComments = Math.max(2, Number(settings.learningMinComments) || 5);
    const minMutedUsers = Math.max(1, Number(settings.learningMinMutedUsers) || 3);

    const trainingIds = [...muted].filter((id) => !whitelist.has(id) && (profiles.get(id)?.commentCount || 0) >= minComments);
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
    const mutedCentroid = centroid(trainingIds, profiles, idf);
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

    const threshold = Math.max(0, Math.min(1, Number(settings.learningCandidateThreshold) || 0.58));
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

  globalThis.ABEMACommentLearning = { analyze, normalizeMessage };
})();