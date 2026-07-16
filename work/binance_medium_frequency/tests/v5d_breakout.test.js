const test = require('node:test');
const assert = require('node:assert/strict');
const { FOUR_HOURS } = require('../v41_engine');
const { EXIT, eventExit, breakoutEventAt, chooseBreakoutCandidate } = require('../v5d_breakout');

function prepared() {
  const bars = Array.from({ length: 22 }, (_, index) => ({ openTime: index * FOUR_HOURS, o: 100, h: index === 20 ? 100 : 101, l: 99, c: 100, qv: 100, takerBuyQv: 50 }));
  bars[20] = { ...bars[20], h: 103, c: 103, qv: 160, takerBuyQv: 104 };
  return { bars, volumeMedian20: Array(22).fill(100), atr: Array(22).fill(2), premium: { close: Array(22).fill(0.001), z: Array(22).fill(1) } };
}

test('breakout uses prior highs and does not require factor or funding fields', () => {
  const event = breakoutEventAt(prepared(), 20, { configId: 'strict', volumeMultiple: 1.5, takerEdge: 0.1, premiumZ: 0.5 });
  assert.equal(event.side, 1); assert.equal(event.entryTime, 21 * FOUR_HOURS);
});

test('candidate selection returns cash unless training robustness gates pass', () => {
  assert.equal(chooseBreakoutCandidate([{ id: 'x', trades: 29, profitFactor: 2, totalReturn: 1, positiveQuarterShare: 1, profitWithoutBest5: 1 }]).id, 'cash');
  assert.equal(chooseBreakoutCandidate([{ id: 'x', trades: 30, profitFactor: 1.1, totalReturn: 0.1, positiveQuarterShare: 0.5, profitWithoutBest5: 1 }]).id, 'x');
});

test('event exits preserve the frozen default and allow a declared side-specific exit', () => {
  const custom = { stopAtr: 1.5, trailAtr: null, maxHoldBars: 6, meanExitEma20: true };
  assert.equal(eventExit({}), EXIT);
  assert.equal(eventExit({ exit: custom }), custom);
});
