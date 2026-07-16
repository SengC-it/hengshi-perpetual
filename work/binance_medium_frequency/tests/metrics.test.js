const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, acceptance } = require('../metrics');

test('profit factor and drawdown are calculated from saved series', () => {
  const trades = [10, -5, 20, -10].map((netPnl, i) => ({ symbol: `S${i}`, side: i % 2 ? -1 : 1, netPnl }));
  const equity = [100, 110, 105, 125, 115].map((value, i) => ({ time: i * 86400000, equity: value }));
  const s = summarize({ trades, equity, startTime: 0, endTime: 4 * 86400000 });
  assert.equal(s.profitFactor, 2);
  assert.ok(Math.abs(s.maxDrawdown - (115 / 125 - 1)) < 1e-12);
});

test('acceptance reports multiple failed rules', () => {
  const a = acceptance({ entriesPerDay: 0.2, trades: 50, profitFactor: 1, stressProfitFactor: 0.9, totalReturn: -0.1, maxDrawdown: -0.4, positiveSymbols: 2, maxContributionShare: 0.8, longRobust: false, shortRobust: false });
  assert.equal(a.pass, false);
  assert.ok(a.failures.length >= 8);
});
