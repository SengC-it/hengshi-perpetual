const test = require('node:test');
const assert = require('node:assert/strict');
const { FOUR_HOURS } = require('../v41_engine');
const { parseMetricsCsv, metricsAtEvent, attachMetrics } = require('../v5c_metrics');

const header = 'openTime,sourceTime,openInterest,openInterestValue,topTraderAccountRatio,topTraderPositionRatio,accountRatio,takerRatio';

test('metrics parser preserves exact four-hour observations', () => {
  const rows = parseMetricsCsv(`${header}\n0,14399000,10,100,1.2,1.3,1.4,1.5`);
  assert.equal(rows.get(0).openInterestValue, 100);
  assert.equal(rows.get(0).takerRatio, 1.5);
});

test('event metrics use exact prior-24h OI and only information before entry', () => {
  const signalTime = 6 * FOUR_HOURS, entryTime = 7 * FOUR_HOURS;
  const rows = parseMetricsCsv(`${header}\n0,14399000,10,100,1,1,1,1\n${signalTime},${entryTime - 1},12,125,1.2,1.3,1.4,1.5`);
  const metrics = metricsAtEvent({ signalTime, entryTime }, rows);
  assert.ok(Math.abs(metrics.oiChange24h - 0.25) < 1e-12);
  assert.equal(metrics.metricsSourceTime, entryTime - 1);
});

test('event metrics reject missing prior rows and observations published at entry', () => {
  const signalTime = 6 * FOUR_HOURS, entryTime = 7 * FOUR_HOURS;
  const missingPrior = parseMetricsCsv(`${header}\n${signalTime},${entryTime - 1},12,125,1.2,1.3,1.4,1.5`);
  assert.equal(metricsAtEvent({ signalTime, entryTime }, missingPrior), null);
  const future = parseMetricsCsv(`${header}\n0,14399000,10,100,1,1,1,1\n${signalTime},${entryTime},12,125,1.2,1.3,1.4,1.5`);
  assert.equal(metricsAtEvent({ signalTime, entryTime }, future), null);
});

test('metric confirmation is audited for every potential event', () => {
  const signalTime = 6 * FOUR_HOURS, entryTime = 7 * FOUR_HOURS;
  const rows = parseMetricsCsv(`${header}\n0,14399000,10,100,1,1,1,1\n${signalTime},${entryTime - 1},12,125,1.2,1.3,1.4,1.5`);
  const events = [{ market: 'um', symbol: 'XUSDT', signalTime, entryTime, type: 'oi_breakout', side: 1 }];
  const output = attachMetrics(events, new Map([['um:XUSDT', rows]]));
  assert.equal(output.length, 1);
  assert.equal(output[0].metricsAvailable, true);
  assert.equal(output[0].confirmed, true);
});
