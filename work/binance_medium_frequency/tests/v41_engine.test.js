const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareSymbol, familySignalAt, trailingStats, summarizeAudit } = require('../v41_engine');

function bars(count, mutate = () => ({})) {
  const step = 4 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, index) => ({
    openTime: index * step,
    o: 100,
    h: 101,
    l: 99,
    c: 100,
    qv: 1000,
    ...mutate(index)
  }));
}

test('breakout signal uses prior highs and current volume confirmation', () => {
  const input = bars(60, index => index === 59 ? { c: 103, h: 104, qv: 2000 } : {});
  const prepared = prepareSymbol({ symbol: 'TEST', baseAsset: 'TEST', market: 'um', bars: input, funding: [] });
  const signal = familySignalAt(prepared, 59, 'breakout');
  assert.equal(signal.side, 1);
  assert.ok(signal.score > 0);
  input[59].qv = 500;
  const lowVolume = prepareSymbol({ symbol: 'TEST', baseAsset: 'TEST', market: 'um', bars: input, funding: [] });
  assert.equal(familySignalAt(lowVolume, 59, 'breakout'), null);
});

test('trailing classification statistics ignore bars at and after as-of time', () => {
  const input = bars(1100, index => index === 1099 ? { c: 1000, qv: 1e12 } : {});
  const prepared = prepareSymbol({ symbol: 'TEST', baseAsset: 'TEST', market: 'um', bars: input, funding: [] });
  const asOf = input[1099].openTime;
  const stats = trailingStats(prepared, asOf);
  assert.ok(stats.quoteVolume < 1e6);
  assert.equal(stats.historyBars, 1099);
});

test('audit summary calculates profit factor from every supplied trade', () => {
  const summary = summarizeAudit([{ netReturn: 0.02 }, { netReturn: -0.01 }, { netReturn: 0.01 }]);
  assert.equal(summary.trades, 3);
  assert.ok(Math.abs(summary.profitFactor - 3) < 1e-12);
  assert.ok(Math.abs(summary.totalReturn - 0.02) < 1e-12);
});

