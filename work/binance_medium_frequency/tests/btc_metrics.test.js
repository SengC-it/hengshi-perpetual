const test = require('node:test');
const assert = require('node:assert/strict');
const { dateKeys, aggregate4h } = require('../download_btc_metrics');

test('dateKeys includes both requested boundaries', () => {
  assert.deepEqual(dateKeys('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
});

test('4h aggregation deduplicates timestamps and ignores invalid fields independently', () => {
  const hour = 60 * 60 * 1000;
  const rows = [
    { time: 0, openInterest: 100, openInterestValue: 1000, topCountRatio: 1.1, topPositionRatio: 1.2, globalRatio: 1.3, takerRatio: 0.8 },
    { time: 0, openInterest: 100, openInterestValue: 1000, topCountRatio: 1.1, topPositionRatio: 1.2, globalRatio: 1.3, takerRatio: 0.8 },
    { time: 2 * hour, openInterest: 0, openInterestValue: 0, topCountRatio: null, topPositionRatio: 1.4, globalRatio: 1.5, takerRatio: 0 }
  ];
  const [bucket] = aggregate4h(rows);
  assert.equal(bucket.samples, 2);
  assert.equal(bucket.openInterest, 100);
  assert.equal(bucket.openInterestValue, 1000);
  assert.equal(bucket.topCountRatio, 1.1);
  assert.ok(Math.abs(bucket.topPositionRatio - 1.3) < 1e-12);
  assert.ok(Math.abs(bucket.globalRatio - 1.4) < 1e-12);
  assert.equal(bucket.takerRatio, 0.8);
});
