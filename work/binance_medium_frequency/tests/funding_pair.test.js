const test = require('node:test');
const assert = require('node:assert/strict');
const { fundingPayment, pairPricePnl, buildFundingSignals, simulateFundingPairs } = require('../funding_pair');

test('funding payment credits short at positive rate and long at negative rate', () => {
  assert.equal(fundingPayment(-1, 2, 100, 0.001), 0.2);
  assert.equal(fundingPayment(1, 2, 100, -0.001), 0.2);
});

test('equal-notional pair price PnL offsets equal percentage moves', () => {
  const pnl = pairPricePnl({ longQty: 1, longEntry: 100, longExit: 110, shortQty: 2, shortEntry: 50, shortExit: 55 });
  assert.equal(pnl, 0);
});

test('funding signal uses three realized events and enters only after threshold', () => {
  const rows = rate => [0, 1, 2].map((fundingTime, index) => ({ fundingTime, fundingRate: rate[index], markPrice: 100 }));
  const signals = buildFundingSignals({
    fundingBySymbol: {
      LOW: rows([-0.0002, -0.0003, -0.0004]),
      HIGH: rows([0.0002, 0.0003, 0.0004])
    },
    threshold: 0.0005,
    rollingEvents: 3,
    minSymbols: 2
  });
  assert.equal(signals.length, 1);
  assert.deepEqual({ time: signals[0].signalTime, long: signals[0].longSymbol, short: signals[0].shortSymbol }, { time: 2, long: 'LOW', short: 'HIGH' });
});

test('flat-price pair earns the realized funding spread after entry', () => {
  const step = 4 * 60 * 60 * 1000;
  const bars = symbol => Array.from({ length: 8 }, (_, index) => ({ symbol, openTime: index * step, o: 100, h: 100, l: 100, c: 100, v: 1000 }));
  const funding = (rates) => rates.map((fundingRate, index) => ({ fundingTime: index * 2 * step, fundingRate, markPrice: 100 }));
  const result = simulateFundingPairs({
    barsBySymbol: { BTCUSDT: bars('BTCUSDT'), ETHUSDT: bars('ETHUSDT') },
    fundingBySymbol: {
      BTCUSDT: funding([-0.0002, -0.0003, -0.0004, -0.0004]),
      ETHUSDT: funding([0.0002, 0.0003, 0.0004, 0.0004])
    },
    params: { threshold: 0.0005, rollingEvents: 3, minSymbols: 2, maxHoldHours: 100, stopEquityFraction: 0.5, maxGross: 1 },
    start: '1970-01-01',
    end: '1970-01-02',
    cost: 0
  });
  assert.equal(result.trades.length, 1);
  assert.ok(Math.abs(result.trades[0].fundingPnl - 40) < 1e-8);
  assert.ok(Math.abs(result.trades[0].netPnl - 40) < 1e-8);
});
