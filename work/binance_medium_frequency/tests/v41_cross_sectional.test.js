const test = require('node:test');
const assert = require('node:assert/strict');
const { selectPair, choosePairCandidate, pairLegNotional } = require('../v41_cross_sectional');

test('pair selection keeps only the most liquid contract per base asset', () => {
  const rows = [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', momentum: 0.2, quoteVolume: 100 },
    { symbol: 'BTCUSD_PERP', baseAsset: 'BTC', momentum: 0.3, quoteVolume: 10 },
    { symbol: 'ETHUSDT', baseAsset: 'ETH', momentum: -0.1, quoteVolume: 90 },
    { symbol: 'SOLUSDT', baseAsset: 'SOL', momentum: 0.1, quoteVolume: 80 }
  ];
  const pair = selectPair(rows, 'momentum');
  assert.equal(pair.long.symbol, 'BTCUSDT');
  assert.equal(pair.short.symbol, 'ETHUSDT');
});

test('reversal pair flips the momentum ranking', () => {
  const rows = [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', momentum: 0.2, quoteVolume: 100 },
    { symbol: 'ETHUSDT', baseAsset: 'ETH', momentum: -0.1, quoteVolume: 90 }
  ];
  const pair = selectPair(rows, 'reversal');
  assert.equal(pair.long.symbol, 'ETHUSDT');
  assert.equal(pair.short.symbol, 'BTCUSDT');
});

test('walk-forward pair selection keeps cash when concentration gate fails', () => {
  const selected = choosePairCandidate([{ id: 'x', trades: 100, profitFactor: 1.5, totalReturn: 0.2, positiveQuarterShare: 0.75, profitWithoutBest5: -1 }]);
  assert.equal(selected.id, 'cash');
});

test('pair notional is sized from the riskier leg stop distance', () => {
  const notional = pairLegNotional({ equity: 100000, longEntry: 100, longAtr: 2, shortEntry: 50, shortAtr: 0.5 });
  assert.ok(Math.abs(notional - 4166.666666666667) < 1e-8);
});
