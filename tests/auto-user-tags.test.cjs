const test = require('node:test'), assert = require('node:assert/strict');
require('../user-tags.js');
require('../comment-tools.js');
require('../auto-user-tags.js');
const auto = globalThis.ABEMAAutoUserTags, tools = globalThis.ABEMACommentTools;
const comment = (userId, message, id = userId) => ({ userId, message, id, createdAtMs: Date.now() });
const settings = { enabled: true, rules: [{ tag: '災害情報', keywords: ['地震', '津波'] }] };

test('automatic assignment merges persistent user tags without replacing manual tags or exceeding the cap', () => {
  const existing = { a: ['識別用', '災害情報'], full: Array.from({ length: 12 }, (_, i) => `手動${i}`) };
  const original = JSON.stringify(existing);
  const result = auto.assign([comment('a', '地震'), comment('b', '津波？'), comment('full', '津波'),
    comment('question', '本当ですか？')], existing, {}, settings);
  assert.deepEqual(result.a, ['識別用', '災害情報']);
  assert.deepEqual(result.b, ['災害情報']);
  assert.deepEqual(result.full, existing.full);
  assert.equal(Object.hasOwn(result, 'question'), false);
  assert.equal(JSON.stringify(existing), original);
  assert.deepEqual(auto.assign([], result, {}, { enabled: false }), result);
  assert.deepEqual(auto.assign([comment('new', '地震')], result, {}, { ...settings, enabled: false }), result);
});

test('manual removals persist across new matching posts; explicit additions allow the tag again', () => {
  const exclusions = auto.editedExclusions({}, 'a', ['識別用', '災害情報'], ['識別用']);
  assert.deepEqual(exclusions, { a: ['災害情報'] });
  assert.deepEqual(auto.assign([comment('a', '地震')], { a: ['識別用'] }, exclusions, settings), { a: ['識別用'] });
  const cleared = auto.editedExclusions(exclusions, 'a', ['識別用'], ['識別用', '災害情報']);
  assert.deepEqual(cleared, {});
  assert.deepEqual(auto.assign([comment('a', '津波')], {}, cleared, settings), { a: ['災害情報'] });
});

test('automatic tags and exclusions safely handle arbitrary IDs and reject invalid backup values', () => {
  const result = auto.assign([comment('__proto__', '地震'), comment('constructor', '津波')], {}, {}, settings);
  assert.deepEqual(result.__proto__, ['災害情報']);
  assert.deepEqual(result.constructor, ['災害情報']);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  const removed = auto.editedExclusions({}, '__proto__', ['災害情報'], []);
  assert.deepEqual(auto.assign([comment('__proto__', '地震')], {}, removed, settings), {});
  for (const bad of [null, [], { a: 'x' }, { a: [null] }, { a: ['a,b'] }, { '': ['x'] }]) {
    assert.throws(() => auto.normalizeExclusions(bad));
  }
});

test('v0.13.0 keyword rules migrate to user-tag rules without changing enabled state', () => {
  const old = { enabled: false, rules: [{ label: '災害情報', keywords: ['地震', '津波'] }] };
  assert.deepEqual(tools.migrateLabelSettings(old), { ...settings, enabled: false });
  assert.equal(old.rules[0].label, '災害情報');
  assert.throws(() => tools.migrateLabelSettings({ rules: [null] }));
});
