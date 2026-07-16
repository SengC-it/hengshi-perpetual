const test = require('node:test');
const assert = require('node:assert/strict');
const { FOUR_HOURS } = require('../v41_engine');
const { stopFill, simulateEvent } = require('../v5c_strategy');

test('long and short stop gaps fill conservatively at the bar open', () => {
  assert.equal(stopFill({ side: 1, stop: 95 }, { o: 90, l: 89 }), 90);
  assert.equal(stopFill({ side: -1, stop: 105 }, { o: 110, h: 111 }), 110);
});

test('event enters at the next bar open and charges round-trip costs', () => {
  const bars = Array.from({ length: 4 }, (_, index) => ({ openTime: index * FOUR_HOURS, o: 100, h: 101, l: 99, c: 100 }));
  const prepared = { bars, indexByTime: new Map(bars.map((bar, index) => [bar.openTime, index])), atr: [2,2,2,2], fundingMap: new Map(), premium: { z: [0,0,0,0] } };
  const trade = simulateEvent(prepared, { signalTime: 0, entryTime: FOUR_HOURS, type: 'oi_breakout', side: 1 }, 'liquid_low_vol', 'stress');
  assert.equal(trade.entryPrice, 100);
  assert.ok(trade.fees > 0);
  assert.ok(trade.netPnl < 0);
});
