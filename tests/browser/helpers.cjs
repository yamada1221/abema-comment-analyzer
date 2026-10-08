const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

async function waitForStorage(page, keys, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let state;
  do {
    state = await page.evaluate(keys => chrome.storage.local.get(keys), keys);
    if (predicate(state)) return state;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`Storage condition did not become true: ${JSON.stringify(state)}`);
}

module.exports = { waitForStorage };
