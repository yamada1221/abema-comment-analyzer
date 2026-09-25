(function (root) {
  'use strict';

  const MAX_TAGS = 12;
  const MAX_TAG_LENGTH = 32;

  function userId(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
      throw new Error('ユーザーIDを1〜200文字で入力してください。');
    }
    return value.trim();
  }

  function parse(value) {
    const input = typeof value === 'string' ? value.split(/[,、，\n\r]+/) : value;
    if (!Array.isArray(input) || input.some(tag => typeof tag !== 'string')) {
      throw new Error('タグは文字列の配列で指定してください。');
    }
    const tags = [...new Set(input.map(tag => tag.trim().normalize('NFC')).filter(Boolean))];
    if (tags.some(tag => [...tag].length > MAX_TAG_LENGTH)) {
      throw new Error(`タグは1つ${MAX_TAG_LENGTH}文字までです。`);
    }
    if (tags.some(tag => /[,、，\n\r]/.test(tag))) {
      throw new Error('タグ名にカンマ・読点・改行は使えません。');
    }
    if (tags.length > MAX_TAGS) throw new Error(`タグは1ユーザーにつき${MAX_TAGS}個までです。`);
    return tags;
  }

  function normalizeMap(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('ユーザータグの保存形式が正しくありません。');
    }
    const entries = [];
    for (const [id, values] of Object.entries(value)) {
      const uid = userId(id);
      if (uid !== id || !Array.isArray(values)) throw new Error('ユーザータグの保存形式が正しくありません。');
      const tags = parse(values);
      if (tags.length) entries.push([uid, tags]);
    }
    return Object.fromEntries(entries);
  }

  function get(map, uid) {
    return Object.prototype.hasOwnProperty.call(map, uid) ? map[uid] : [];
  }

  root.ABEMAUserTags = { parse, normalizeMap, get, userId, MAX_TAGS, MAX_TAG_LENGTH };
})(globalThis);
