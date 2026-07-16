const test = require('node:test');
const assert = require('node:assert/strict');
const { positionSize, stopFillPrice, canAddPosition, updateExcursions } = require('../portfolio');

test('risk and notional caps both apply', () => {
  assert.equal(positionSize({ equity: 10000, entry: 100, stop: 98, riskFraction: 0.0075, notionalCap: 0.5 }), 37.5);
  assert.equal(positionSize({ equity: 10000, entry: 100, stop: 90, riskFraction: 0.0075, notionalCap: 0.5 }), 7.5);
});

test('gap stop uses adverse open and intrabar stop uses stop price', () => {
  assert.equal(stopFillPrice({ side: 1, stop: 98 }, { o: 95, h: 100, l: 94 }), 95);
  assert.equal(stopFillPrice({ side: 1, stop: 98 }, { o: 100, h: 101, l: 97 }), 98);
  assert.equal(stopFillPrice({ side: -1, stop: 102 }, { o: 105, h: 106, l: 100 }), 105);
});

test('BTC and ETH cannot be added together on the same side', () => {
  const positions = [{ symbol: 'BTCUSDT', side: 1, notional: 1000 }];
  assert.equal(canAddPosition(positions, { symbol: 'ETHUSDT', side: 1, notional: 1000 }, 10000, { maxPositions: 4, maxSameSide: 3, maxGross: 2 }), false);
});

test('excursions are normalized by entry ATR for long and short positions', () => {
  const long = { side: 1, entryPrice: 100, initialAtr: 10, mfeAtr: 0, maeAtr: 0 };
  updateExcursions(long, { h: 115, l: 94 });
  assert.equal(long.mfeAtr, 1.5);
  assert.equal(long.maeAtr, 0.6);

  const short = { side: -1, entryPrice: 100, initialAtr: 10, mfeAtr: 0, maeAtr: 0 };
  updateExcursions(short, { h: 108, l: 82 });
  assert.equal(short.mfeAtr, 1.8);
  assert.equal(short.maeAtr, 0.8);
});
