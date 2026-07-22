import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_SHADOW, STRATEGY } from '../config/strategy.js';
import { FOUR_HOURS } from '../lib/binance.js';
import {
  MAX_SCAN_DELAY_MS,
  expectedCompletedBarTime,
  runShadowScan,
  scanDelayMs,
  withExecutableEntries
} from '../lib/scanner.js';

test('V12.7 exit shadow is frozen while V12.8 restarts independent validation', () => {
  assert.equal(EXIT_SHADOW.enabled, false);
  assert.equal(EXIT_SHADOW.baselineVersion, 'hengshi-v12.4-shadow-2026q3');
  assert.equal(EXIT_SHADOW.liveOrdersEnabled, false);
  assert.deepEqual(EXIT_SHADOW.long, STRATEGY.long.exit);
  assert.deepEqual(EXIT_SHADOW.short, {
    ...STRATEGY.short.exit,
    maxHoldBars: 24
  });
});

test('executable entries use the mark price captured at scan time and reject missing marks', () => {
  const entryTime = Date.parse('2026-07-23T04:05:01Z');
  const candidates = [
    { symbol: 'AAAUSDT', entryPrice: 1 },
    { symbol: 'BBBUSDT', entryPrice: 1 }
  ];
  const rows = withExecutableEntries(candidates, new Map([['AAAUSDT', 1.2345]]), entryTime);
  assert.deepEqual(rows, [{ symbol: 'AAAUSDT', entryPrice: 1.2345, entryTime }]);
});

test('expected completed bar is the previous four-hour interval', () => {
  const now = Date.parse('2026-07-18T04:05:00Z');
  assert.equal(expectedCompletedBarTime(now), Date.parse('2026-07-18T00:00:00Z'));
  assert.equal(scanDelayMs(now, expectedCompletedBarTime(now)), 5 * 60 * 1000);
});

test('scan started more than ten minutes after close is rejected before market access', async () => {
  const calls = [];
  let marketRequests = 0;
  const now = STRATEGY.validFrom + FOUR_HOURS + MAX_SCAN_DELAY_MS + 1;
  const barTime = expectedCompletedBarTime(now);

  await assert.rejects(runShadowScan({
    now,
    fetchImpl: async () => {
      marketRequests += 1;
      return new Response('{}', { status: 200 });
    },
    dependencies: {
      claimScan: async () => ({ claimed: true, run: { id: 'stale-run' } }),
      failScan: async (runId, error) => calls.push(['fail', runId, error.message]),
      sendFailureEmail: async (error, context) => {
        calls.push(['email', error.message, context.barTime]);
        return { sent: true };
      }
    }
  }), /stale scan rejected/);

  assert.equal(marketRequests, 0);
  assert.deepEqual(calls.map(call => call[0]), ['fail', 'email']);
  assert.equal(calls[0][1], 'stale-run');
  assert.equal(calls[1][2], barTime);
});

test('initial Binance failure is recorded and emailed after the scan is claimed', async () => {
  const calls = [];
  const now = STRATEGY.validFrom + FOUR_HOURS + 5 * 60 * 1000;
  const barTime = expectedCompletedBarTime(now);

  await assert.rejects(runShadowScan({
    now,
    fetchImpl: async () => new Response('restricted location', { status: 451 }),
    dependencies: {
      claimScan: async (strategyVersion, claimedBarTime) => {
        calls.push(['claim', strategyVersion, claimedBarTime]);
        return { claimed: true, run: { id: 'test-run' } };
      },
      failScan: async (runId, error) => calls.push(['fail', runId, error.message]),
      sendFailureEmail: async (error, context) => {
        calls.push(['email', error.message, context.barTime]);
        return { sent: true };
      }
    }
  }), /Binance 451/);

  assert.deepEqual(calls.map(call => call[0]), ['claim', 'fail', 'email']);
  assert.equal(calls[0][2], barTime);
  assert.equal(calls[1][1], 'test-run');
  assert.equal(calls[2][2], barTime);
});
