const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWalkForwardPlans } = require('../v7_run');

function row({ signalTime, exitTime, market, side, layer, x, target }) {
  return {
    signalTime,
    exitTime,
    layer,
    features: { x },
    target,
    event: { signalTime, entryTime: signalTime + 1, market, side, symbol: `${market}-${signalTime}` }
  };
}

test('V7 walk-forward options isolate training markets, trading markets, layers, and features', () => {
  const rows = [
    row({ signalTime: 100, exitTime: 200, market: 'um', side: -1, layer: 'liquid_low_vol', x: -1, target: -1 }),
    row({ signalTime: 300, exitTime: 400, market: 'um', side: 1, layer: 'liquid_low_vol', x: 1, target: 1 }),
    row({ signalTime: 500, exitTime: 600, market: 'cm', side: -1, layer: 'liquid_low_vol', x: 100, target: 5 }),
    row({ signalTime: 1200, exitTime: 1300, market: 'um', side: -1, layer: 'liquid_low_vol', x: 0, target: 0 }),
    row({ signalTime: 1300, exitTime: 1400, market: 'um', side: -1, layer: 'tail_low_vol', x: 0, target: 0 }),
    row({ signalTime: 1400, exitTime: 1500, market: 'cm', side: -1, layer: 'liquid_low_vol', x: 0, target: 0 })
  ];
  const [plan] = buildWalkForwardPlans([], rows, {
    folds: [{ startTime: 1000, endTime: 2000 }],
    lookbackDays: 1000,
    minimumTrainingRows: 2,
    featureNames: ['x'],
    trainingScoreQuantile: 0,
    trainingMarkets: ['um'],
    tradingMarkets: ['um'],
    tradingLayers: ['liquid_low_vol'],
    trainingSides: [-1, 1],
    tradingSides: [-1]
  });
  assert.equal(plan.trainingRows, 2);
  assert.equal(plan.oosRows, 1);
  assert.equal(plan.events.length, 1);
  assert.deepEqual(plan.model.featureNames, ['x']);
  assert.equal(plan.events[0].market, 'um');
});
