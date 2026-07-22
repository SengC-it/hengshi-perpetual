import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMarkPrices } from '../lib/binance.js';
import { buildSignalPnlRows } from '../lib/pnl.js';

test('dashboard PnL preserves realized net PnL after costs', () => {
  const [row] = buildSignalPnlRows([{
    position_id: 'position-1',
    signal_id: 1,
    symbol: 'TESTUSDT',
    side: -1,
    layer: 'liquid_low_vol',
    entry_time: '2026-07-21T00:00:00.000Z',
    exit_time: '2026-07-21T04:00:00.000Z',
    entry_price: 100,
    exit_price: 110,
    qty: 2,
    notional: 200,
    gross_pnl: -20,
    fees: 1,
    funding_pnl: 0.5,
    net_pnl: -20.5,
    reason: 'stop',
    bars_held: 1
  }], [], new Map());
  assert.equal(row.state, 'closed');
  assert.equal(row.netPnl, -20.5);
  assert.equal(row.pnlPercent, -0.1025);
  assert.equal(row.closePrice, 110);
});

test('dashboard PnL estimates an open position at the mark price including exit costs', () => {
  const [row] = buildSignalPnlRows([], [{
    id: 'position-2',
    signal_id: 2,
    symbol: 'TESTUSDT',
    side: 1,
    layer: 'liquid_low_vol',
    entry_time: '2026-07-21T00:00:00.000Z',
    entry_price: 100,
    qty: 2,
    entry_fee: 0.24,
    funding_pnl: 0.1
  }], new Map([['TESTUSDT', 110]]), '2026-07-21T04:00:00.000Z');
  assert.equal(row.state, 'open');
  assert.equal(row.grossPnl, 20);
  assert.equal(row.fees, 0.504);
  assert.equal(row.netPnl, 19.596);
  assert.equal(row.pnlPercent, 0.09798);
});

test('mark price lookup requests Binance once and keeps only requested valid marks', async () => {
  let requestedUrl;
  const marks = await fetchMarkPrices(['BTCUSDT'], {
    attempts: 1,
    fetchImpl: async url => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => [
          { symbol: 'BTCUSDT', markPrice: '100000' },
          { symbol: 'ETHUSDT', markPrice: '4000' },
          { symbol: 'BADUSDT', markPrice: '0' }
        ]
      };
    }
  });
  assert.match(requestedUrl, /\/fapi\/v1\/premiumIndex$/);
  assert.deepEqual([...marks], [['BTCUSDT', 100000]]);
});
