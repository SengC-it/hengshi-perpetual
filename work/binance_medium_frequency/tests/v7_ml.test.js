const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FEATURE_NAMES,
  featureVector,
  fitRidge,
  predictRidge,
  quantile,
  quantileForTargetRate,
  trainingRowsForFold
} = require('../v7_ml');

function event(overrides = {}) {
  return {
    side: 1,
    premium: 0.001,
    premiumZ: 2,
    takerShare: 0.6,
    volumeRatio: 1.5,
    breakoutAtr: 0.8,
    market: 'um',
    metrics: {
      oiChange24h: 0.05,
      openInterestValue: 1000000,
      topTraderAccountRatio: 1.1,
      topTraderPositionRatio: 1.2,
      accountRatio: 1.05,
      takerRatio: 1.15
    },
    ...overrides
  };
}

test('V7 directional features treat mirrored long and short evidence equally', () => {
  const long = featureVector(event(), 'liquid_high_vol');
  const short = featureVector(event({
    side: -1,
    premium: -0.001,
    premiumZ: -2,
    takerShare: 0.4,
    metrics: {
      oiChange24h: 0.05,
      openInterestValue: 1000000,
      topTraderAccountRatio: 1 / 1.1,
      topTraderPositionRatio: 1 / 1.2,
      accountRatio: 1 / 1.05,
      takerRatio: 1 / 1.15
    }
  }), 'liquid_high_vol');
  for (const name of FEATURE_NAMES.filter(name => name !== 'sideLong')) {
    assert.ok(Math.abs(long[name] - short[name]) < 1e-12, name);
  }
  assert.equal(long.sideLong, 1);
  assert.equal(short.sideLong, 0);
});

test('V7 ridge model learns a fixed linear relationship', () => {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const x = index / 10 - 3;
    return { features: { x, noise: index % 2 }, target: 1 + 2 * x };
  });
  const model = fitRidge(rows, ['x', 'noise'], 0.01);
  assert.ok(predictRidge(model, { x: 2, noise: 0 }) > predictRidge(model, { x: -2, noise: 0 }));
  assert.ok(Math.abs(predictRidge(model, { x: 1, noise: 0 }) - 3) < 0.25);
});

test('V7 training data excludes labels not fully known before the fold', () => {
  const foldStart = 1000, rows = [
    { signalTime: 100, exitTime: 900 },
    { signalTime: 200, exitTime: 1000 },
    { signalTime: 1000, exitTime: 1100 }
  ];
  assert.deepEqual(trainingRowsForFold(rows, foldStart, 1000), [rows[0]]);
});

test('V7 cutoff is calculated from training scores only', () => {
  assert.equal(quantile([1, 2, 3, 100], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.8), 4.2);
  assert.equal(quantileForTargetRate(600, 300, 0.5), 0.75);
  assert.equal(quantileForTargetRate(100, 100, 2), 0);
});
