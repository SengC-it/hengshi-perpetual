const test = require('node:test');
const assert = require('node:assert/strict');
const { marketRegimeAllows } = require('../v5e_regime');

test('market regime uses benchmark values at the completed signal bar', () => {
  const benchmark = { indexByTime: new Map([[100, 50]]), ema20: Array(51).fill(2), ema50: Array(51).fill(1) };
  assert.equal(marketRegimeAllows({ signalTime: 100, side: 1 }, benchmark), true);
  assert.equal(marketRegimeAllows({ signalTime: 100, side: -1 }, benchmark), false);
  assert.equal(marketRegimeAllows({ signalTime: 101, side: 1 }, benchmark), false);
});
