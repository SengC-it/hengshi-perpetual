const test = require('node:test');
const assert = require('node:assert/strict');
const { validationSummary, validationPass, innerSplitRows } = require('../v8_layered');

test('V8 inner split only uses fully known labels in each segment', () => {
  const split = 1000, foldStart = 2000;
  const rows = [
    { signalTime: 100, exitTime: 900 },
    { signalTime: 200, exitTime: 1000 },
    { signalTime: 1100, exitTime: 1900 },
    { signalTime: 1200, exitTime: 2000 }
  ];
  const result = innerSplitRows(rows, split, foldStart);
  assert.deepEqual(result.modelRows, [rows[0]]);
  assert.deepEqual(result.validationRows, [rows[2]]);
});

test('V8 layer validation rejects insufficient and best-trade-dependent evidence', () => {
  assert.equal(validationPass(Array.from({ length: 29 }, () => ({ target: 1 }))).pass, false);
  const fragile = [{ target: 20 }, ...Array.from({ length: 39 }, () => ({ target: -0.2 }))];
  const result = validationPass(fragile);
  assert.equal(result.summary.netTarget > 0, true);
  assert.equal(result.summary.withoutBest3 > 0, false);
  assert.equal(result.pass, false);
});

test('V8 layer validation accepts broad positive evidence', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ target: index % 3 === 0 ? -0.5 : 0.7 }));
  const summary = validationSummary(rows);
  assert.ok(summary.profitFactor > 1.1);
  assert.equal(validationPass(rows).pass, true);
});
