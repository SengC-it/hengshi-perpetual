import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../lib/binance.js';

test('Binance deterministic 4xx responses are not retried', async () => {
  let calls = 0;
  await assert.rejects(fetchJson('/fapi/v1/exchangeInfo', {
    attempts: 3,
    fetchImpl: async () => {
      calls += 1;
      return new Response('restricted location', { status: 451 });
    }
  }), /Binance 451/);
  assert.equal(calls, 1);
});
