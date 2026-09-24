const test = require('node:test');
const assert = require('node:assert/strict');
require('../user-tags.js');
const tags = globalThis.ABEMAUserTags;

test('multiple Japanese separators, empty values and duplicates round-trip', () => {
  assert.deepEqual(tags.parse(' 要観察,定型文、要観察\nグループ A， '), ['要観察', '定型文', 'グループ A']);
  assert.deepEqual(tags.parse(''), []);
  assert.deepEqual(tags.parse('か\u3099,が'), ['が']);
});

test('invalid imports and over-limit input are rejected rather than silently lost', () => {
  for (const bad of [null, [], 'tags']) assert.throws(() => tags.normalizeMap(bad));
  for (const bad of [{ user: 'label' }, { user: [1] }, { user: ['a,b'] }, { '': ['tag'] }]) {
    assert.throws(() => tags.normalizeMap(bad));
  }
  assert.throws(() => tags.parse('a'.repeat(33)));
  assert.throws(() => tags.parse(Array.from({ length: 13 }, (_, i) => String(i))));
  assert.equal(tags.parse('a'.repeat(32))[0].length, 32);
});

test('old data defaults to empty tags and empty tag lists are removed', () => {
  assert.deepEqual(tags.normalizeMap(), {});
  assert.deepEqual(tags.normalizeMap({ user: [], other: ['要観察', '要観察'] }), { other: ['要観察'] });
});

test('arbitrary IDs cannot change the object prototype', () => {
  const map = tags.normalizeMap(JSON.parse('{"__proto__":["tag"],"constructor":["other"]}'));
  assert.deepEqual(tags.get(map, '__proto__'), ['tag']);
  assert.deepEqual(tags.get(map, 'constructor'), ['other']);
  assert.deepEqual(tags.get(map, 'toString'), []);
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  assert.deepEqual(tags.normalizeMap(JSON.parse(JSON.stringify(map))), map);
});
