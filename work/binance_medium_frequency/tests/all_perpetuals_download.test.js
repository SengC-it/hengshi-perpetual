const test = require('node:test');
const assert = require('node:assert/strict');
const { symbolMonths, parseKlineLine, parseFundingLine } = require('../download_all_perpetuals');

test('symbol month range respects onboarding and settlement', () => {
  const months = symbolMonths({ onboardDate: Date.parse('2024-02-15T00:00:00Z'), deliveryDate: Date.parse('2024-04-03T00:00:00Z') });
  assert.deepEqual(months, ['2024-02', '2024-03', '2024-04']);
});

test('USD-M kline keeps archived quote volume and taker quote volume', () => {
  const row = parseKlineLine('1000,10,12,9,11,5,1999,55,7,3,33,0', 'um', 'TESTUSDT');
  assert.equal(row.quoteVolume, 55);
  assert.equal(row.takerBuyQuoteVolume, 33);
  assert.equal(row.trades, 7);
});

test('COIN-M kline converts base volume fields to approximate quote value', () => {
  const row = parseKlineLine('1000,10,12,9,11,5,1999,2,7,3,1,0', 'cm', 'TESTUSD_PERP');
  assert.equal(row.quoteVolume, 22);
  assert.equal(row.takerBuyQuoteVolume, 11);
});

test('funding parser uses realized funding rate column', () => {
  assert.deepEqual(parseFundingLine('1000,TESTUSDT,0.0001'), { fundingTime: 1000, fundingRate: 0.0001 });
});

