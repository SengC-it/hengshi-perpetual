const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRegime, combinedScore, rankEligible } = require('../signals');

function bars(n) {
  return Array.from({ length: n }, (_, i) => ({
    symbol: 'BTCUSDT', openTime: i * 14400000, o: 100 + i, h: 102 + i,
    l: 99 + i, c: 101 + i, v: 1000 + i
  }));
}

test('regime at an earlier index ignores later bars', () => {
  const x = bars(260);
  const before = computeRegime(x, { fast: 50, slow: 200 })[220];
  x[250].c *= 10;
  assert.equal(computeRegime(x, { fast: 50, slow: 200 })[220], before);
});

test('rank ties use symbol order and score is finite', () => {
  const ranked = rankEligible([{ symbol: 'ETHUSDT', score: 1 }, { symbol: 'BTCUSDT', score: 1 }]);
  assert.deepEqual(ranked.map(x => x.symbol), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(combinedScore(0.1, 0.2, 0.2, 0.4), 0.5);
});
