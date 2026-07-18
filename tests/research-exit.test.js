import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { takeProfitFill } = require('../work/binance_medium_frequency/v5d_breakout.js');

test('historical research take-profit fills are directional and gap-aware', () => {
  assert.equal(takeProfitFill({ side: 1, takeProfit: 110 }, { o: 100, h: 112, l: 99 }), 110);
  assert.equal(takeProfitFill({ side: 1, takeProfit: 110 }, { o: 111, h: 113, l: 109 }), 111);
  assert.equal(takeProfitFill({ side: -1, takeProfit: 90 }, { o: 100, h: 101, l: 88 }), 90);
  assert.equal(takeProfitFill({ side: -1, takeProfit: 90 }, { o: 89, h: 91, l: 87 }), 89);
  assert.equal(takeProfitFill({ side: 1, takeProfit: null }, { o: 100, h: 120, l: 80 }), null);
});
