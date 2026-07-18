import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalEmail, exitPresentation, formatBeijingTime } from '../lib/mailer.js';

test('user-facing timestamps are formatted in Beijing time', () => {
  assert.equal(
    formatBeijingTime('2026-07-18T00:00:00.000Z'),
    '2026-07-18 08:00:00'
  );
});

test('short signal email shows the researched 3 ATR reference point and trailing exit', () => {
  const signal = {
    symbol: 'TESTUSDT',
    side: -1,
    layer: 'liquid_high_vol',
    score: 2,
    entry_price: 100,
    stop_price: 104,
    metadata: {
      exit: {
        trailAtr: 3,
        maxHoldBars: 18,
        referenceProfitPrice: 94
      }
    }
  };
  assert.deepEqual(exitPresentation(signal), {
    point: '94.000000',
    rule: '3ATR移动止盈；该点位是参考盈利位，不挂固定止盈单',
    holdText: '72小时'
  });
  const html = buildSignalEmail({
    newSignals: [signal],
    barTime: '2026-07-18T00:00:00.000Z'
  });
  assert.match(html, /参考止盈点位/);
  assert.match(html, /94\.000000/);
  assert.match(html, /3ATR移动止盈/);
  assert.match(html, /72小时/);
});

test('long signal email uses EMA20 as a dynamic reference exit', () => {
  const presentation = exitPresentation({
    side: 1,
    metadata: {
      exit: {
        referenceEma20: 108.5,
        maxHoldBars: 6
      }
    }
  });
  assert.equal(presentation.point, '108.50000');
  assert.match(presentation.rule, /动态EMA20/);
  assert.equal(presentation.holdText, '24小时');
});
