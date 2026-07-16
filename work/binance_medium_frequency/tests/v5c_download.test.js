const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePremiumLine, parseMetricsLine, aggregateMetrics4h } = require('../download_v5c_data');

test('premium parser keeps signed OHLC values and normalized time', () => {
  const row = parsePremiumLine('1704067200000,-0.001,0.002,-0.003,0.0005,0,1704081599999,0,1,0,0,0');
  assert.deepEqual(row, { openTime: 1704067200000, open: -0.001, high: 0.002, low: -0.003, close: 0.0005 });
});

test('metrics parser reads OI and crowd ratios without using future rows', () => {
  const row = parseMetricsLine('2024-01-01 04:00:00,BTCUSDT,100,5000000,1.2,1.1,1.3,0.8');
  assert.equal(row.time, Date.parse('2024-01-01T04:00:00Z'));
  assert.equal(row.openInterestValue, 5000000);
  assert.equal(row.takerRatio, 0.8);
});

test('metrics aggregation takes the final observation inside each completed four-hour bucket', () => {
  const rows = [
    parseMetricsLine('2024-01-01 00:00:00,BTCUSDT,100,5000000,1.2,1.1,1.3,0.8'),
    parseMetricsLine('2024-01-01 03:55:00,BTCUSDT,110,5500000,1.3,1.2,1.4,0.9'),
    parseMetricsLine('2024-01-01 04:00:00,BTCUSDT,120,6000000,1.4,1.3,1.5,1.1')
  ];
  const bars = aggregateMetrics4h(rows);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].openInterestValue, 5500000);
  assert.equal(bars[1].openInterestValue, 6000000);
});
