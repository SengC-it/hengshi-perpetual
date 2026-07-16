const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseFundingCandidate, summarizeFundingPairs, fundingAcceptance } = require('../funding_strategy');

test('funding candidate selection prefers training-quarter robustness', () => {
  const highReturn = { id: 'high', medianQuarterlyStressPf: 0.9, positiveQuarterShare: 0.5, stress: { profitFactor: 2, totalReturn: 0.5, maxDrawdown: -0.3 } };
  const robust = { id: 'robust', medianQuarterlyStressPf: 1.3, positiveQuarterShare: 0.7, stress: { profitFactor: 1.3, totalReturn: 0.1, maxDrawdown: -0.1 } };
  assert.equal(chooseFundingCandidate([highReturn, robust]).id, 'robust');
});

test('funding summary separates price, funding, and fees', () => {
  const summary = summarizeFundingPairs({
    trades: [{ longSymbol: 'A', shortSymbol: 'B', netPnl: 30, pricePnl: -10, fundingPnl: 50, fees: 10 }],
    equity: [{ equity: 100 }, { equity: 130 }],
    startTime: 0,
    endTime: 86400000
  });
  assert.equal(summary.totalPricePnl, -10);
  assert.equal(summary.totalFundingPnl, 50);
  assert.equal(summary.totalFees, 10);
  assert.ok(Math.abs(summary.totalReturn - 0.3) < 1e-12);
});

test('funding acceptance rejects a strategy that fails stress profit factor', () => {
  const result = fundingAcceptance({
    base: { profitFactor: 1.4 },
    stress: { trades: 100, profitFactor: 1.1, totalReturn: 0.1, maxDrawdown: -0.1, maxContributionShare: 0.2, totalFundingPnl: 1 },
    extreme: { profitFactor: 1.01 },
    positiveQuarterShare: 0.8,
    profitWithoutBest5: 1,
    bootstrapProbabilityPositive: 0.8
  });
  assert.equal(result.pass, false);
  assert.ok(result.failures.includes('stressProfitFactor'));
});
