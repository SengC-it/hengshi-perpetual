const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRestBar, mergeByTime } = require('../v74_forward');

test('V7.4 forward parser preserves USD-M quote and taker quote volume', () => {
  const row = parseRestBar([1, '10', '12', '9', '11', '5', 2, '1000', 7, '3', '600'], 'um');
  assert.equal(row.qv, 1000);
  assert.equal(row.takerBuyQv, 600);
});

test('V7.4 forward parser converts COIN-M base volume fields to quote value', () => {
  const row = parseRestBar([1, '10', '12', '9', '11', '5', 2, '100', 7, '3', '40'], 'cm');
  assert.equal(row.qv, 1100);
  assert.equal(row.takerBuyQv, 440);
});

test('V7.4 forward merge replaces duplicate timestamps and sorts rows', () => {
  const rows = mergeByTime([{ openTime: 2, value: 'old' }], [{ openTime: 1 }, { openTime: 2, value: 'new' }], 'openTime');
  assert.deepEqual(rows.map(row => row.openTime), [1, 2]);
  assert.equal(rows[1].value, 'new');
});
