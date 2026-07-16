const test = require('node:test');
const assert = require('node:assert/strict');
const { ema, atr, median, windowReturn, realizedVol } = require('../indicators');
const { PARAMETER_GRID } = require('../config');

test('approved grid has exactly sixteen unique combinations', () => {
  assert.equal(PARAMETER_GRID.length, 16);
  assert.equal(new Set(PARAMETER_GRID.map(JSON.stringify)).size, 16);
});

test('indicators are deterministic and preserve warmup nulls', () => {
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.equal(median([9, 1, 5, 3]), 4);
  assert.ok(Math.abs(windowReturn([100, 110, 121], 2)[2] - 0.21) < 1e-12);
  const bars = [
    { h: 11, l: 9, c: 10 }, { h: 13, l: 10, c: 12 },
    { h: 14, l: 11, c: 13 }, { h: 15, l: 12, c: 14 }
  ];
  assert.equal(atr(bars, 3)[1], null);
  assert.ok(atr(bars, 3)[3] > 0);
  assert.equal(realizedVol([100, 101], 3)[1], null);
});
