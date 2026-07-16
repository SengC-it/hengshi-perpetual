const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rollingFactorFeatures,
  selectResidualPair,
  betaNeutralNotionals,
  adversePairPnl,
  chooseResidualCandidate
} = require('../v5_residual');

function prepared(symbol, baseAsset, closes) {
  const bars = closes.map((c, index) => ({ openTime: index * 4 * 60 * 60 * 1000, o: c, h: c * 1.01, l: c * 0.99, c, qv: 1000 }));
  return { symbol, baseAsset, bars, indexByTime: new Map(bars.map((bar, index) => [bar.openTime, index])) };
}

test('rolling factor features are causal and remove a one-for-one BTC move', () => {
  const btc = prepared('BTCUSDT', 'BTC', [100, 101, 102, 103, 104, 105, 106, 107]);
  const asset = prepared('XUSDT', 'X', [50, 50.5, 51, 51.5, 52, 52.5, 53, 53.5]);
  const first = rollingFactorFeatures(asset, btc, 3);
  const changedFuture = prepared('XUSDT', 'X', [50, 50.5, 51, 51.5, 52, 52.5, 53, 500]);
  const second = rollingFactorFeatures(changedFuture, btc, 3);
  assert.ok(Math.abs(first.beta[6] - 1) < 0.1);
  assert.ok(Math.abs(first.beta[6] - second.beta[6]) < 1e-12);
  assert.ok(Math.abs(first.residualReturn(6, 3)) < 0.01);
});

test('residual reversal pair uses opposite residual extremes with matched risk', () => {
  const rows = [
    { symbol: 'AUSDT', baseAsset: 'A', residual: -0.20, beta: 1.0, volatility: 0.02, quoteVolume: 100 },
    { symbol: 'BUSDT', baseAsset: 'B', residual: 0.18, beta: 1.1, volatility: 0.021, quoteVolume: 90 },
    { symbol: 'CUSDT', baseAsset: 'C', residual: 0.30, beta: 3.0, volatility: 0.08, quoteVolume: 80 }
  ];
  const pair = selectResidualPair(rows);
  assert.equal(pair.long.symbol, 'AUSDT');
  assert.equal(pair.short.symbol, 'BUSDT');
});

test('beta-neutral notionals cancel factor exposure and respect gross cap', () => {
  const sized = betaNeutralNotionals({ equity: 100000, longBeta: 0.8, shortBeta: 1.2, grossFraction: 0.2 });
  assert.ok(Math.abs(sized.longNotional * 0.8 - sized.shortNotional * 1.2) < 1e-8);
  assert.ok(Math.abs(sized.longNotional + sized.shortNotional - 20000) < 1e-8);
});

test('adverse pair pnl combines long low and short high', () => {
  const pnl = adversePairPnl({
    legs: [
      { side: 1, qty: 10, entryPrice: 100 },
      { side: -1, qty: 5, entryPrice: 200 }
    ]
  }, new Map([
    ['long', { l: 95, h: 102 }],
    ['short', { l: 198, h: 210 }]
  ]), leg => leg.side === 1 ? 'long' : 'short');
  assert.equal(pnl, -100);
});

test('training selection stays in cash when robustness gate fails', () => {
  const selected = chooseResidualCandidate([{ id: 'x', pairs: 80, pairProfitFactor: 1.4, totalReturn: 0.1, positiveQuarterShare: 0.75, profitWithoutBest5Pairs: -1 }]);
  assert.equal(selected.id, 'cash');
});
