import test from 'node:test';
import assert from 'node:assert/strict';
import { FOUR_HOURS } from '../lib/binance.js';
import { advancePosition, advancePositionFiveMinute, sizePosition } from '../lib/paper.js';

function position(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    signal_id: 1,
    strategy_version: 'test',
    symbol: 'TESTUSDT',
    base_asset: 'TEST',
    layer: 'liquid_low_vol',
    family: 'reversal',
    side: 1,
    signal_time: '2026-07-17T00:00:00.000Z',
    entry_time: '2026-07-17T04:00:00.000Z',
    entry_price: 100,
    qty: 10,
    stop_price: 98,
    best_price: 100,
    trail_atr: null,
    max_hold_bars: 6,
    mean_exit_ema20: true,
    exit_next_open: false,
    entry_fee: 1.2,
    funding_pnl: 0,
    last_processed_bar: '2026-07-17T00:00:00.000Z',
    ...overrides
  };
}

test('paper engine applies an intrabar stop on the entry bar', () => {
  const bars = [{
    openTime: Date.parse('2026-07-17T04:00:00Z'),
    open: 100,
    high: 101,
    low: 97,
    close: 99
  }];
  const result = advancePosition(position(), {
    bars,
    atr: [1],
    ema20: [100]
  }, 0);
  assert.equal(result.trade.reason, 'stop');
  assert.equal(result.trade.exit_price, 98);
});

test('paper engine schedules a reversal mean exit for the next bar open', () => {
  const bars = [
    {
      openTime: Date.parse('2026-07-17T04:00:00Z'),
      open: 100,
      high: 102,
      low: 99,
      close: 101
    },
    {
      openTime: Date.parse('2026-07-17T08:00:00Z'),
      open: 102,
      high: 103,
      low: 101,
      close: 102
    }
  ];
  const result = advancePosition(position(), {
    bars,
    atr: [1, 1],
    ema20: [100, 100]
  }, 1);
  assert.equal(result.trade.reason, 'mean');
  assert.equal(result.trade.exit_price, 102);
});

test('position sizing honors risk, symbol and gross caps', () => {
  const qty = sizePosition({
    entryPrice: 100,
    stopPrice: 98
  }, {
    equity: 100000,
    grossExposure: 0
  });
  assert.equal(qty, 125);
});

test('V12.7 short remains open at the V12.4 72-hour time exit', () => {
  const entryTime = Date.parse('2026-07-17T04:00:00Z');
  const bars = Array.from({ length: 19 }, (_, index) => ({
    openTime: entryTime + index * 4 * 60 * 60 * 1000,
    open: 100,
    high: 101,
    low: 99,
    close: 100
  }));
  const prepared = {
    bars,
    atr: Array(19).fill(1),
    ema20: Array(19).fill(100)
  };
  const short = position({
    side: -1,
    stop_price: 102,
    best_price: 100,
    trail_atr: 3,
    mean_exit_ema20: false
  });
  const baseline = advancePosition({ ...short, max_hold_bars: 18 }, prepared, 18);
  const candidate = advancePosition({ ...short, max_hold_bars: 24 }, prepared, 18);
  assert.equal(baseline.trade.reason, 'time');
  assert.equal(candidate.trade, null);
});

test('five-minute execution ignores the pre-entry path and updates a trailing stop only at the 4h close', () => {
  const start = Date.parse('2026-07-23T00:00:00Z');
  const entry = start + 5 * 60 * 1000;
  const paperPosition = {
    ...position(),
    side: -1,
    entry_time: new Date(entry).toISOString(),
    entry_price: 100,
    stop_price: 102,
    best_price: 100,
    trail_atr: 3,
    max_hold_bars: 18,
    mean_exit_ema20: false,
    last_processed_bar: new Date(entry - 5 * 60 * 1000).toISOString()
  };
  const bars = [];
  for (let time = entry; time < start + FOUR_HOURS; time += 5 * 60 * 1000) {
    bars.push({
      openTime: time,
      closeTime: time + 5 * 60 * 1000 - 1,
      open: 100,
      high: 100,
      low: time === entry ? 94 : 100,
      close: 100
    });
  }
  bars.push({ openTime: start + FOUR_HOURS, closeTime: start + FOUR_HOURS + 5 * 60 * 1000 - 1, open: 96, high: 98, low: 95, close: 96 });
  const prepared = {
    bars: [{ openTime: start, close: 100 }],
    atr: [1],
    ema20: [100],
    indexByTime: new Map([[start, 0]])
  };
  const result = advancePositionFiveMinute(paperPosition, prepared, bars, start + FOUR_HOURS + 5 * 60 * 1000 + 1);
  assert.equal(result.trade.reason, 'stop');
  assert.equal(result.trade.exit_price, 97);
});
