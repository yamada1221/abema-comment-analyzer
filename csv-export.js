(() => {
  'use strict';
  // ABEMA comments and user identifiers are untrusted. Spreadsheet programs
  // may execute formulas when importing cells beginning with =, +, -, or @.
  const isFormulaLike = value =>
    /^[\s\uFEFF\u200B]*[=+\-@]/u.test(value) ||
    /^[\t\r\n]/u.test(value);
  function cell(value) {
    const original = String(value ?? '');
    const safe = (isFormulaLike(original) ? "'" : '') + original;
    return '"' + safe.replace(/"/g, '""') + '"';
  }
  function document(rows) {
    const header = 'time,userId,message,pageTitle,userTags';
    // UTF-8 BOM helps spreadsheet software detect Japanese CSV text.
    const lines = rows.map(values => values.map(cell).join(','));
    return '\uFEFF' + [header, ...lines].join('\r\n');
  }
  globalThis.ABEMACsvExport = Object.freeze({ cell, document });
})();
