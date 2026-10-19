const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const sandbox = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../csv-export.js'), 'utf8'), sandbox);
const csv = sandbox.ABEMACsvExport;

test('CSV escaping protects dangerous spreadsheet formula prefixes in untrusted ABEMA comments', () => {
  for (const payload of [
    '=HYPERLINK("https://example.test","open")',
    '+SUM(1,2)',
    '-1+2',
    '@SUM(1,2)',
    '  =cmd',
    '\t=1+1',
    '\r=1+1',
    '\n=1+1',
    '\uFEFF=1',
    '\u200B=1',
    ' \t-1+2'
  ]) {
    const result = csv.cell(payload);
    assert.ok(result.startsWith('"\''),
      'Untrusted CSV formula was not neutralized: ' + JSON.stringify(payload));
    assert.ok(result.endsWith('"'));
    assert.ok(result.includes(payload.replaceAll('"', '""')));
  }
});

test('CSV preserves ordinary Japanese text, quotes, commas and stable numeric IDs', () => {
  assert.equal(csv.cell('普通のコメント'), '"普通のコメント"');
  assert.equal(csv.cell('00123'), '"00123"');
  assert.equal(csv.cell('name, "quoted"'), '"name, ""quoted"""');
  assert.equal(csv.cell(null), '""');
  assert.equal(csv.cell(undefined), '""');
});

test('CSV document emits UTF-8 BOM and CRLF for spreadsheet compatibility', () => {
  const text = csv.document([
    ['2026-10-19T00:00:00.000Z', '=EVIL()', '日本語, "こんにちは"', '番組', '["タグ"]']
  ]);
  assert.ok(text.startsWith('\uFEFFtime,userId,message,pageTitle,userTags\r\n'));
  assert.ok(text.includes('"\'=EVIL()"'));
  assert.ok(text.includes('"日本語, ""こんにちは"""'));
  assert.ok(text.endsWith('"[""タグ""]"'));
});
