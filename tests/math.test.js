import test from 'node:test';
import assert from 'node:assert/strict';
import { atr, ema, median, rollingZ } from '../lib/math.js';

test('indicator helpers preserve the research definitions', () => {
  assert.equal(median([3, 1, 2, 4]), 2.5);
  assert.deepEqual(ema([1, 2, 3], 3), [null, null, 2]);
  const bars = Array.from({ length: 16 }, (_, index) => ({
    high: index + 2,
    low: index,
    close: index + 1
  }));
  assert.equal(atr(bars, 14)[14], 2);
  assert.equal(rollingZ(Array(30).fill(1).concat([2]))[30], Infinity);
});
