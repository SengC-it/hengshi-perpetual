const test = require('node:test');
const assert = require('node:assert/strict');
const { rollingPremiumFeatures, potentialEventsAt, confirmWithMetrics } = require('../v5c_features');

test('premium z-score uses only prior completed premium bars', () => {
  const values = [...Array(40).fill(0.001), 0.01];
  const first = rollingPremiumFeatures(values, 30);
  const changedFuture = rollingPremiumFeatures([...values.slice(0, 40), 0.50], 30);
  assert.equal(first.z[39], changedFuture.z[39]);
  assert.ok(first.z[40] > 5);
});

test('crowding reversal requires premium funding residual and taker alignment', () => {
  const bars = Array.from({ length: 61 }, (_, index) => ({ c: 100 + index, h: 101 + index, l: 99 + index, qv: 1000, takerBuyQv: 700 }));
  const prepared = {
    bars,
    factor: { beta: Array(61).fill(1), volatility: Array(61).fill(0.01), residualReturn: () => 0.12 },
    fundingAverage: { 21: Array(61).fill(0.0001) },
    premium: { close: Array(61).fill(0.001), z: Array(61).fill(0) },
    volumeMedian20: Array(61).fill(900)
  };
  prepared.premium.z[59] = 2.5;
  const events = potentialEventsAt(prepared, 59);
  assert.equal(events.find(row => row.type === 'crowding_unwind').side, -1);
});

test('breakout compares current close with prior highs and requires volume confirmation', () => {
  const bars = Array.from({ length: 50 }, (_, index) => ({ c: 100, h: 101, l: 99, qv: 1000, takerBuyQv: 700 }));
  bars[48] = { c: 103, h: 104, l: 100, qv: 2000, takerBuyQv: 1500 };
  const prepared = {
    bars,
    factor: { beta: Array(50).fill(1), volatility: Array(50).fill(0.01), residualReturn: () => 0.01 },
    fundingAverage: { 21: Array(50).fill(0.00001) },
    premium: { close: Array(50).fill(0.001), z: Array(50).fill(0.6) },
    volumeMedian20: Array(50).fill(1000)
  };
  const events = potentialEventsAt(prepared, 48);
  assert.equal(events.find(row => row.type === 'oi_breakout').side, 1);
});

test('OI metrics confirm direction without relaxing event conditions', () => {
  const event = { type: 'oi_breakout', side: 1 };
  assert.equal(confirmWithMetrics(event, { oiChange24h: 0.03, takerRatio: 1.2, topTraderPositionRatio: 1 }), true);
  assert.equal(confirmWithMetrics(event, { oiChange24h: 0.01, takerRatio: 1.2, topTraderPositionRatio: 1 }), false);
  assert.equal(confirmWithMetrics({ type: 'crowding_unwind', side: -1 }, { oiChange24h: 0.06, takerRatio: 1.2, topTraderPositionRatio: 1.2, accountRatio: 1.2 }), true);
});
