const test = require('node:test');
const assert = require('node:assert/strict');
const { rollingFundingAverages, selectFundingPair, chooseFundingCandidate } = require('../v5_funding');

test('funding averages use only events realized by the signal time', () => {
  const prepared = {
    bars: [0, 4, 8, 12, 16].map(hour => ({ openTime: hour * 3600000 })),
    funding: [
      { fundingTime: 0, fundingRate: 0.001 },
      { fundingTime: 8 * 3600000, fundingRate: 0.003 },
      { fundingTime: 16 * 3600000, fundingRate: 0.009 }
    ]
  };
  const features = rollingFundingAverages(prepared, [2]);
  assert.equal(features[2][3], 0.002);
  assert.equal(features[2][4], 0.006);
});

test('pure carry longs low funding and shorts high funding', () => {
  const rows = [
    { symbol: 'AUSDT', baseAsset: 'A', fundingAverage: -0.001, beta: 1, volatility: 0.02, quoteVolume: 100, residualZ: -1 },
    { symbol: 'BUSDT', baseAsset: 'B', fundingAverage: 0.002, beta: 1.1, volatility: 0.021, quoteVolume: 90, residualZ: 1 },
    { symbol: 'CUSDT', baseAsset: 'C', fundingAverage: 0.004, beta: 3, volatility: 0.08, quoteVolume: 80, residualZ: 2 }
  ];
  const pair = selectFundingPair(rows, { strategy: 'funding_carry', holdBars: 18, stressCost: 0.0024 });
  assert.equal(pair.long.symbol, 'AUSDT');
  assert.equal(pair.short.symbol, 'BUSDT');
});

test('crowding reversal requires price residual alignment', () => {
  const rows = [
    { symbol: 'AUSDT', baseAsset: 'A', fundingAverage: -0.001, beta: 1, volatility: 0.02, quoteVolume: 100, residualZ: 1 },
    { symbol: 'BUSDT', baseAsset: 'B', fundingAverage: 0.002, beta: 1.1, volatility: 0.021, quoteVolume: 90, residualZ: -1 }
  ];
  assert.equal(selectFundingPair(rows, { strategy: 'funding_crowding_reversal', holdBars: 18, stressCost: 0.0024 }), null);
});

test('training selection stays in cash when best pairs depend on outliers', () => {
  const selected = chooseFundingCandidate([{ id: 'x', pairs: 80, pairProfitFactor: 1.3, totalReturn: 0.1, positiveQuarterShare: 0.75, profitWithoutBest5Pairs: -2 }]);
  assert.equal(selected.id, 'cash');
});
