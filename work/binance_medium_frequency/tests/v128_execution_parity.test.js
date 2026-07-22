const test = require('node:test');
const assert = require('node:assert/strict');
const { EXECUTION_DELAY_MS, FIVE_MINUTES, simulateExecutableTrade } = require('../v128_execution_parity');

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function prepared() {
  return {
    indexByTime: new Map([[0, 0], [FOUR_HOURS, 1]]),
    atr: [1, 1],
    fundingMap: new Map()
  };
}

function trade() {
  return { symbol: 'TESTUSDT', layer: 'liquid_high_vol', side: -1, signalTime: 0, entryTime: FOUR_HOURS, exitTime: FOUR_HOURS + 3 * 24 * 60 * 60 * 1000, notional: 1000, reason: 'time' };
}

test('V12.8 enters at the first 5m bar after the scan delay and ignores the pre-fill bar', () => {
  const entry = FOUR_HOURS + EXECUTION_DELAY_MS;
  const result = simulateExecutableTrade({
    trade: trade(),
    prepared: prepared(),
    fiveMinuteBars: [
      { openTime: FOUR_HOURS, o: 100, h: 130, l: 99, c: 100 },
      { openTime: entry, o: 101, h: 101, l: 100, c: 100 },
      { openTime: entry + FIVE_MINUTES, o: 100, h: 104, l: 99, c: 100 }
    ]
  });
  assert.equal(result.entryTime, entry);
  assert.equal(result.entryPrice, 101);
  assert.equal(result.exitPrice, 103);
  assert.equal(result.reason, 'stop');
});

test('V12.8 applies a 4h trailing stop only after that 4h interval closes', () => {
  const start = FOUR_HOURS, bars = [];
  for (let time = start; time <= start + FOUR_HOURS; time += FIVE_MINUTES) {
    bars.push({ openTime: time, o: time === start + FOUR_HOURS ? 96 : 100, h: time === start + FOUR_HOURS ? 98 : 100, l: time === start ? 94 : 100, c: 100 });
  }
  const result = simulateExecutableTrade({ trade: trade(), prepared: prepared(), fiveMinuteBars: bars, executionDelayMs: 0 });
  assert.equal(result.exitTime, start + FOUR_HOURS);
  assert.equal(result.exitPrice, 97);
  assert.equal(result.reason, 'stop');
});
