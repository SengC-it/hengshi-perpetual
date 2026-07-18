import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY } from '../config/strategy.js';
import { FOUR_HOURS } from '../lib/binance.js';
import { expectedCompletedBarTime, runShadowScan } from '../lib/scanner.js';

test('expected completed bar is the previous four-hour interval', () => {
  const now = Date.parse('2026-07-18T04:05:00Z');
  assert.equal(expectedCompletedBarTime(now), Date.parse('2026-07-18T00:00:00Z'));
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
