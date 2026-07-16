const test = require('node:test');
const assert = require('node:assert/strict');
const { strictLongGate, strictShortGate } = require('../signals');

function preparedFixture({ below = 8, falling = true } = {}) {
  const prepared = {};
  const indexBySymbol = {};
  const symbols = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','LTCUSDT','BCHUSDT'];
  symbols.forEach((symbol, index) => {
    const under = index < below;
    prepared[symbol] = {
      bars: [{ c: 100 }, { c: under ? 90 : 110 }],
      ema50: [falling ? 105 : 95, 100],
      ema200: [105, 105],
      r24: [-0.02, -0.02],
      rLong: [-0.05, -0.05]
    };
    indexBySymbol[symbol] = 1;
  });
  return { prepared, indexBySymbol };
}

test('strict short gate requires at least 65% bearish breadth', () => {
  const fixture = preparedFixture({ below: 7, falling: true });
  assert.equal(strictShortGate({ ...fixture, regime: 'bear' }), false);
});

test('strict short gate accepts broad bear market with falling BTC EMA50', () => {
  const fixture = preparedFixture({ below: 8, falling: true });
  assert.equal(strictShortGate({ ...fixture, regime: 'bear' }), true);
});

test('strict short gate rejects a rising BTC EMA50', () => {
  const fixture = preparedFixture({ below: 9, falling: false });
  assert.equal(strictShortGate({ ...fixture, regime: 'bear' }), false);
});

function bullishFixture({ above = 8, rising = true } = {}) {
  const prepared = {};
  const indexBySymbol = {};
  const symbols = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','LTCUSDT','BCHUSDT'];
  symbols.forEach((symbol, index) => {
    const over = index < above;
    prepared[symbol] = {
      bars: [{ c: 100 }, { c: over ? 120 : 90 }],
      ema50: [rising ? 105 : 115, 110],
      ema200: [100, 100],
      r24: [0.02, 0.02],
      rLong: [0.05, 0.05]
    };
    indexBySymbol[symbol] = 1;
  });
  return { prepared, indexBySymbol };
}

test('strict long gate requires at least 65% bullish breadth', () => {
  assert.equal(strictLongGate({ ...bullishFixture({ above: 7 }), regime: 'bull' }), false);
});

test('strict long gate accepts broad bull market with rising BTC EMA50', () => {
  assert.equal(strictLongGate({ ...bullishFixture({ above: 8 }), regime: 'bull' }), true);
});

test('strict long gate rejects a falling BTC EMA50', () => {
  assert.equal(strictLongGate({ ...bullishFixture({ above: 9, rising: false }), regime: 'bull' }), false);
});
