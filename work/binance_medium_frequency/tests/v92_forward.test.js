const test = require('node:test');
const assert = require('node:assert/strict');
const { dataEndFromArgs } = require('../v92_forward');
const { dataEndFromArgs: v10DataEndFromArgs } = require('../v10_forward');
const { dataEndFromArgs: v11DataEndFromArgs } = require('../v11_forward');
const { portfolioForCandidate, scoreCutoffForCandidate } = require('../v74_forward');

test('V9.2 forward end-date parser closes the requested UTC day at 20:00', () => {
  assert.equal(dataEndFromArgs(['--end=2026-07-20']), Date.parse('2026-07-20T20:00:00Z'));
});

test('V9.2 forward end-date parser rejects invalid dates', () => {
  assert.throws(() => dataEndFromArgs(['--end=not-a-date']), /invalid --end date/);
});

test('V10 forward end-date parser closes the requested UTC day at 20:00', () => {
  assert.equal(v10DataEndFromArgs(['--end=2026-07-20']), Date.parse('2026-07-20T20:00:00Z'));
});

test('V11 forward end-date parser closes the requested UTC day at 20:00', () => {
  assert.equal(v11DataEndFromArgs(['--end=2026-07-20']), Date.parse('2026-07-20T20:00:00Z'));
});

test('forward runner supports layer-specific score cutoffs with a global fallback', () => {
  const candidate = {
    scoreCutoff: 0.1,
    scoreCutoffByLayer: { tail_high_vol: 0.2 }
  };
  assert.equal(scoreCutoffForCandidate(candidate, 'tail_high_vol'), 0.2);
  assert.equal(scoreCutoffForCandidate(candidate, 'liquid_low_vol'), 0.1);
});

test('forward runner reads frozen portfolio capacity with V9.2 defaults', () => {
  assert.deepEqual(portfolioForCandidate({}), { maxPerBar: 2, maxPerDay: 2, maxPositions: 6 });
  assert.deepEqual(portfolioForCandidate({
    portfolio: { maxSignalsPerBar: 3, maxSignalsPerDay: 3, maxPositions: 8 }
  }), { maxPerBar: 3, maxPerDay: 3, maxPositions: 8 });
});
