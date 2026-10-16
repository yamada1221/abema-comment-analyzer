(function (root) {
  'use strict';
  const DEFAULT_TAG_SETTINGS = { enabled: true, rules: [] };
  const TAG_NAMES = ['絵文字のみ', 'URLあり', '同文反復', '高頻度投稿'];
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ja');
  const time = c => Number(c.createdAtMs || c.observedAt || 0);
  const key = c => String(c.id || JSON.stringify([c.userId, time(c), c.message]));
  const reliable = (c, now = Date.now()) => c.timestampReliable !== false &&
    Number.isFinite(c.createdAtMs) && c.createdAtMs >= 946684800000 && c.createdAtMs <= now + 60000;
  const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.round(Number(value) || fallback)));

  // Emoji property alone also matches bare digits, # and *. Require a whole sequence.
  const pictograph = '(?:\\p{Extended_Pictographic}[\\uFE0E\\uFE0F]?\\p{Emoji_Modifier}?)';
  const emojiSequence = new RegExp('^(?:' + pictograph + '(?:\\u200D' + pictograph + ')*' +
    '|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F})+$', 'u');
  function isEmojiOnly(message) {
    const text = String(message || '').replace(/\s/gu, '');
    return !!text && emojiSequence.test(text);
  }

  function normalizeTagSettings(value = DEFAULT_TAG_SETTINGS) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
        (value.rules !== undefined && !Array.isArray(value.rules))) throw new Error('自動タグ設定の形式が正しくありません。');
    const rules = value.rules || [];
    if (rules.length > 20) throw new Error('タグルールは20件までです。');
    const result = rules.map(rule => {
      if (!rule || typeof rule.tag !== 'string' || !Array.isArray(rule.keywords) ||
          rule.keywords.some(word => typeof word !== 'string')) throw new Error('タグ名とキーワードを確認してください。');
      const tag = rule.tag.trim().normalize('NFC'), keywords = [...new Set(rule.keywords.map(word => word.trim()).filter(Boolean))];
      if (!tag || [...tag].length > 32 || /[,、，\r\n:：]/.test(tag) || TAG_NAMES.includes(tag) ||
          !keywords.length || keywords.length > 20 || keywords.some(word => word.length > 80)) {
        throw new Error('タグ名は32文字以内（標準タグと別名）、キーワードは各80文字以内・20個までです。');
      }
      return { tag, keywords };
    });
    if (new Set(result.map(rule => rule.tag)).size !== result.length) throw new Error('タグ名が重複しています。');
    return { enabled: value.enabled !== false, rules: result };
  }
  function migrateLabelSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (value.rules !== undefined && !Array.isArray(value.rules))) throw new Error('旧自動設定の形式が正しくありません。');
    return normalizeTagSettings({ ...value, rules: (value.rules || []).map(rule => {
      if (!rule || typeof rule !== 'object') throw new Error('旧自動設定の形式が正しくありません。');
      return { tag: rule.label, keywords: rule.keywords };
    }) });
  }
  function parseRules(text) {
    return normalizeTagSettings({ rules: String(text).split(/\r?\n/).filter(line => line.trim()).map(line => {
      const colon = line.search(/[:：]/);
      if (colon < 1) throw new Error('「タグ名: キーワード, キーワード」の形式で入力してください。');
      return { tag: line.slice(0, colon).trim(), keywords: line.slice(colon + 1).split(/[,、，]/) };
    }) }).rules;
  }

  function annotate(input, tagSettings = DEFAULT_TAG_SETTINGS, moderation = {}) {
    const settings = normalizeTagSettings(tagSettings);
    const rows = input.map(comment => ({ comment, tags: [] }));
    if (!settings.enabled) return rows;
    const byUser = new Map();
    for (const row of rows) {
      const message = String(row.comment.message || ''), normalized = normalize(message);
      const add = (name, reason) => row.tags.push({ name, reason });
      if (isEmojiOnly(message)) add('絵文字のみ', '本文が絵文字と空白だけです');
      if (/https?:\/\/\S+/iu.test(message)) add('URLあり', '本文にHTTP(S)のURLを含みます');
      for (const rule of settings.rules) {
        const hit = rule.keywords.find(word => normalized.includes(normalize(word)));
        if (hit) add(rule.tag, `キーワード「${hit}」に一致`);
      }
      const uid = String(row.comment.userId);
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(row);
    }
    const rateCount = bounded(moderation.rateCount, 8, 2, 10000);
    const rateMs = bounded(moderation.rateWindowSec, 30, 1, 86400) * 1000;
    for (const userRows of byUser.values()) {
      const phrases = new Map(), unique = new Map();
      for (const row of userRows) {
        const phrase = normalize(row.comment.message).replace(/\s+/gu, ' ').trim();
        if (phrase) {
          if (!phrases.has(phrase)) phrases.set(phrase, []);
          phrases.get(phrase).push(row);
        }
        if (reliable(row.comment)) unique.set(key(row.comment), row);
      }
      for (const repeated of phrases.values()) {
        const count = new Set(repeated.map(row => key(row.comment))).size;
        if (count >= 3) for (const row of repeated) row.tags.push({ name: '同文反復', reason: `保存履歴内で同じ本文を${count}件投稿（空白・大文字小文字・全半角を正規化）` });
      }
      const timed = [...unique.values()].sort((a,b) => time(a.comment)-time(b.comment));
      // Mark all members of qualifying windows in linear time, including the first posts.
      const marks = new Int32Array(timed.length + 1);
      let left = 0;
      for (let right = 0; right < timed.length; right++) {
        while (time(timed[right].comment)-time(timed[left].comment) > rateMs) left++;
        if (right-left+1 >= rateCount) { marks[left]++; marks[right+1]--; }
      }
      let active = 0;
      for (let i = 0; i < timed.length; i++) {
        active += marks[i];
        if (active) timed[i].tags.push({ name: '高頻度投稿', reason: `${rateMs/1000}秒内に${rateCount}件以上（投稿時刻で判定）` });
      }
    }
    return rows;
  }

  function filterRows(rows, { query = '', target = 'message', tag = '', channel = '', hideMuted = false, mutedUsers = [], order = 'newest' } = {}) {
    const q = normalize(query).trim(), muted = new Set(mutedUsers.map(String));
    return rows.filter(row => {
      const c = row.comment;
      const fields = target === 'user' ? [c.userId] : target === 'all' ? [c.message, c.userId, c.pageTitle] : [c.message];
      return (!q || fields.some(field => normalize(field).includes(q))) &&
        (!tag || row.tags.some(item => item.name === tag)) &&
        (!channel || c.pageUrl === channel) && (!hideMuted || !muted.has(String(c.userId)));
    }).sort((a,b) => (order === 'oldest' ? 1 : -1)*(time(a.comment)-time(b.comment)) || key(a.comment).localeCompare(key(b.comment)));
  }

  function emojiEvidence(input, settings = {}) {
    const count = bounded(settings.emojiCount, 3, 1, 100), windowMs = bounded(settings.emojiWindowSec, 120, 1, 86400)*1000;
    const sorted = [...new Map(input.filter(c => reliable(c)).map(c => [key(c), c])).values()].sort((a,b) => time(a)-time(b));
    if (!sorted.length) return null;
    const latest = time(sorted.at(-1));
    const window = sorted.filter(c => latest-time(c) <= windowMs);
    // An ordinary comment in the window prevents the "emoji only" user judgment.
    if (window.length < count || window.some(c => !isEmojiOnly(c.message))) return null;
    return { count: window.length, firstPostedAt: time(window[0]), lastPostedAt: latest,
      spanSeconds: (latest-time(window[0]))/1000, windowSec: windowMs/1000 };
  }

  class Replay {
    constructor() { this.reset([]); }
    reset(rows) {
      this.rows = [...rows].sort((a,b) => time(a.comment)-time(b.comment) || key(a.comment).localeCompare(key(b.comment)));
      this.start = this.rows.length ? time(this.rows[0].comment) : 0;
      this.end = this.rows.length ? time(this.rows.at(-1).comment) : 0;
      this.position = this.start; this.playing = false; this.speed = 1;
    }
    seek(position) { this.position = Math.min(this.end, Math.max(this.start, position)); }
    advance(elapsedMs) { if (this.playing) { this.seek(this.position + Math.max(0, elapsedMs)*this.speed); if (this.position >= this.end) this.playing = false; } }
    next() { const row = this.rows.find(row => time(row.comment) > this.position); this.seek(row ? time(row.comment) : this.end); }
    visible(limit = 100) {
      let lo = 0, hi = this.rows.length;
      while (lo < hi) { const mid = (lo+hi) >>> 1; if (time(this.rows[mid].comment) <= this.position) lo=mid+1; else hi=mid; }
      return { count: lo, rows: this.rows.slice(Math.max(0,lo-limit),lo) };
    }
  }
  root.ABEMACommentTools = { DEFAULT_TAG_SETTINGS, TAG_NAMES, normalize, time, key, reliable, isEmojiOnly,
    normalizeTagSettings, migrateLabelSettings, parseRules, annotate, filterRows, emojiEvidence, Replay };
})(globalThis);
