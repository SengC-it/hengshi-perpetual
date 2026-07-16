const test = require('node:test');
const assert = require('node:assert/strict');
const {
  signalAt,
  positionSize,
  stopFillPrice,
  chooseCandidate,
  acceptance
} = require('../btc_oi_strategy');

test('signal uses a completed-bar breakout with OI and taker confirmation', () => {
  const bars = [
    { h: 100, l: 90, c: 95 },
    { h: 101, l: 91, c: 96 },
    { h: 102, l: 92, c: 103 }
  ];
  const metrics = [
    { openInterest: 100, takerRatio: 1 },
    { openInterest: 101, takerRatio: 1 },
    { openInterest: 106, takerRatio: 1.1 }
  ];
  assert.equal(signalAt({ bars, metrics, fundingRates: [0, 0, 0], index: 2, params: { breakoutBars: 2, oiLookbackBars: 2, oiThreshold: 0.05, fundingLimit: 0.0005 } }), 1);
  assert.equal(signalAt({ bars, metrics, fundingRates: [0, 0, 0], index: 1, params: { breakoutBars: 2, oiLookbackBars: 2, oiThreshold: 0.05, fundingLimit: 0.0005 } }), 0);
});

test('crowded funding blocks the matching trade direction', () => {
  const bars = [{ h: 100, l: 90, c: 95 }, { h: 101, l: 91, c: 96 }, { h: 102, l: 92, c: 103 }];
  const metrics = [{ openInterest: 100, takerRatio: 1 }, { openInterest: 101, takerRatio: 1 }, { openInterest: 106, takerRatio: 1.1 }];
  assert.equal(signalAt({ bars, metrics, fundingRates: [0, 0, 0.0006], index: 2, params: { breakoutBars: 2, oiLookbackBars: 2, oiThreshold: 0.05, fundingLimit: 0.0005 } }), 0);
});

test('risk sizing is capped at one times equity notional', () => {
  assert.equal(positionSize({ equity: 100000, entry: 100, stop: 99, riskFraction: 0.005, maxNotional: 1 }), 500);
  assert.equal(positionSize({ equity: 100000, entry: 100, stop: 99.9, riskFraction: 0.005, maxNotional: 1 }), 1000);
});

test('gap through stop fills at the bar open', () => {
  assert.equal(stopFillPrice({ side: 1, stop: 95 }, { o: 90, h: 92, l: 88 }), 90);
  assert.equal(stopFillPrice({ side: -1, stop: 105 }, { o: 110, h: 112, l: 108 }), 110);
});

test('training selection prioritizes quarter robustness before headline return', () => {
  const highReturn = { id: 'a', medianQuarterlyStressPf: 0.9, positiveQuarterShare: 0.5, stress: { profitFactor: 2, totalReturn: 0.5, maxDrawdown: -0.3 } };
  const robust = { id: 'b', medianQuarterlyStressPf: 1.2, positiveQuarterShare: 0.7, stress: { profitFactor: 1.2, totalReturn: 0.1, maxDrawdown: -0.1 } };
  assert.equal(chooseCandidate([highReturn, robust]).id, 'b');
});

test('acceptance rejects a non-profitable stress result', () => {
  const result = acceptance({
    base: { profitFactor: 1.4 },
    stress: { trades: 60, profitFactor: 1.2, totalReturn: -0.01, maxDrawdown: -0.1 },
    extreme: { profitFactor: 1.01 },
    positiveQuarterShare: 0.75,
    profitWithoutBest5: 1,
    bootstrapProbabilityPositive: 0.8,
    sideRobustness: { long: true, short: true }
  });
  assert.equal(result.pass, false);
  assert.ok(result.failures.includes('stressPositiveReturn'));
});

