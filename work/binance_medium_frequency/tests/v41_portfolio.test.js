const test = require('node:test');
const assert = require('node:assert/strict');
const { positionSize, selectCandidates, costForLayer } = require('../v41_portfolio');

test('portfolio sizing applies risk, symbol notional, and remaining gross caps', () => {
  assert.equal(positionSize({ equity: 100000, entry: 100, stop: 99, riskFraction: 0.0025, symbolCap: 0.35, remainingGross: 100000 }), 250);
  assert.equal(positionSize({ equity: 100000, entry: 100, stop: 99.9, riskFraction: 0.0025, symbolCap: 0.35, remainingGross: 20000 }), 200);
});

test('candidate selection ranks deterministically and avoids duplicate base exposure', () => {
  const candidates = [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', score: 2 },
    { symbol: 'BTCUSD_PERP', baseAsset: 'BTC', score: 3 },
    { symbol: 'ETHUSDT', baseAsset: 'ETH', score: 1 }
  ];
  const selected = selectCandidates(candidates, { occupiedBases: new Set(), slots: 2, remainingToday: 2, maxPerBar: 2 });
  assert.deepEqual(selected.map(row => row.symbol), ['BTCUSD_PERP', 'ETHUSDT']);
});

test('tail contracts receive larger modeled transaction costs', () => {
  assert.ok(costForLayer('tail_high_vol', 'stress') > costForLayer('liquid_high_vol', 'stress'));
  assert.ok(costForLayer('tail_low_vol', 'extreme') > costForLayer('tail_low_vol', 'base'));
});

