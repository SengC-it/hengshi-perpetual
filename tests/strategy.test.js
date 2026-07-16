import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY, assertPaperOnly } from '../config/strategy.js';
import { isRapidBull, rawBreakoutShortAt, reversalLongAt } from '../lib/strategy.js';

function bar(close = 100, quoteVolume = 100, takerBuyQuoteVolume = 50) {
  return {
    openTime: 0,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    quoteVolume,
    takerBuyQuoteVolume
  };
}

test('deployment is permanently paper-only', () => {
  assert.doesNotThrow(assertPaperOnly);
  assert.equal(STRATEGY.liveOrdersEnabled, false);
  assert.equal(STRATEGY.implementation.causalSelection, true);
});

test('rapid bull regime requires trend and 30-day momentum', () => {
  const bars = Array.from({ length: 181 }, (_, index) => bar(100 + index * 0.1));
  const prepared = {
    bars,
    ema20: Array(181).fill(120),
    ema50: Array(181).fill(110)
  };
  assert.equal(isRapidBull(prepared, 180), true);
  prepared.ema20[180] = 100;
  assert.equal(isRapidBull(prepared, 180), false);
});

test('V12.4 reversal long uses shock, volume, trend gap and frozen cutoff', () => {
  const bars = Array.from({ length: 60 }, () => bar());
  bars[59] = bar(95, 200, 100);
  const prepared = {
    bars,
    atr: Array(60).fill(1),
    ema20: Array(60).fill(100),
    ema50: Array(60).fill(100),
    volumeMedian20: Array(60).fill(100)
  };
  const signal = reversalLongAt(prepared, 59, 'liquid_low_vol');
  assert.equal(signal.side, 1);
  assert.ok(signal.score > STRATEGY.long.scoreCutoff);
});

test('V11 raw short breakout remains disabled in rapid-bull mode by the caller', () => {
  const bars = Array.from({ length: 31 }, () => bar());
  bars[30] = bar(97, 140, 45);
  const prepared = {
    bars,
    premiums: Array(31).fill(-0.001),
    premiumZ: Array(31).fill(-1),
    atr: Array(31).fill(1),
    volumeMedian20: Array(31).fill(100)
  };
  const signal = rawBreakoutShortAt(prepared, 30, 'liquid_high_vol');
  assert.equal(signal.side, -1);
  assert.equal(signal.family, 'breakout');
});
