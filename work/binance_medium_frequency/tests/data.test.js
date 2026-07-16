const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKlineCsv, validateBars, isEligible, sliceBars } = require('../data');

test('parser rejects duplicate timestamps', () => {
  const csv = 'openTime,open,high,low,close,volume,closeTime\n1000,1,2,0.5,1.5,10,2000\n1000,1,2,0.5,1.5,10,2000';
  assert.throws(() => validateBars(parseKlineCsv(csv, 'BTCUSDT')), /timestamp/);
});

test('eligibility starts after two hundred completed bars', () => {
  assert.equal(isEligible(199, 0, 200), false);
  assert.equal(isEligible(200, 0, 200), true);
});

test('date slicing uses UTC day boundaries', () => {
  const bars = [{ openTime: Date.parse('2025-01-01T00:00:00Z') }, { openTime: Date.parse('2025-01-02T00:00:00Z') }];
  assert.equal(sliceBars(bars, '2025-01-02', '2025-01-02').length, 1);
});
