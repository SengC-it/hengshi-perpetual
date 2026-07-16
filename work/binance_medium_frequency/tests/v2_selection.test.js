const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseV2Candidate, profitAfterRemovingBest, v2Acceptance } = require('../v2');

test('V2 selection prefers quarterly robustness over a higher aggregate return', () => {
  const boom = { id: 'boom', medianQuarterlyStressPf: 0.9, positiveQuarterShare: 0.5, stress: { profitFactor: 1.4, totalReturn: 0.5, maxDrawdown: -0.3 } };
  const steady = { id: 'steady', medianQuarterlyStressPf: 1.2, positiveQuarterShare: 0.75, stress: { profitFactor: 1.2, totalReturn: 0.1, maxDrawdown: -0.15 } };
  assert.equal(chooseV2Candidate([boom, steady]).id, 'steady');
});

test('profit after removing best trades exposes concentration', () => {
  assert.equal(profitAfterRemovingBest([{ netPnl: 100 }, { netPnl: 20 }, { netPnl: -10 }], 1), 10);
});

test('V2 acceptance requires positive stress performance and profit factor', () => {
  const result = v2Acceptance({
    base: { profitFactor: 1.31 },
    stress: { trades: 200, profitFactor: 1.14, totalReturn: 0.1, maxDrawdown: -0.1, maxContributionShare: 0.2 },
    positiveQuarterShare: 0.75,
    profitWithoutBest5: 1
  });
  assert.equal(result.pass, false);
  assert.ok(result.failures.includes('stressProfitFactor'));
});
