const test = require('node:test');
const assert = require('node:assert/strict');
const { V21_GRID, excursionSummary } = require('../v21');

test('V2.1 grid contains only four strict-long candidates', () => {
  assert.equal(V21_GRID.length, 4);
  assert.ok(V21_GRID.every(x => x.sideMode === 'strict_long'));
});

test('excursion summary separates low follow-through losers', () => {
  const result = excursionSummary([
    { netPnl: 100, mfeAtr: 2, maeAtr: 0.4, reason: 'time' },
    { netPnl: -50, mfeAtr: 0.2, maeAtr: 1.5, reason: 'stop' },
    { netPnl: -20, mfeAtr: 0.4, maeAtr: 1.2, reason: 'stop' }
  ]);
  assert.equal(result.trades, 3);
  assert.equal(result.losers.lowFollowThroughShare, 1);
  assert.equal(result.stopShare, 2 / 3);
});
