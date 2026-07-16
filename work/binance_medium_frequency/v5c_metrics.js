const fs = require('fs');
const { FOUR_HOURS } = require('./v41_engine');
const { confirmWithMetrics } = require('./v5c_features');

function parseMetricsCsv(text) {
  const rows = new Map();
  for (const line of text.trim().split(/\r?\n/).slice(1).filter(Boolean)) {
    const value = line.split(',').map(Number);
    const row = {
      openTime: value[0], sourceTime: value[1], openInterest: value[2], openInterestValue: value[3],
      topTraderAccountRatio: value[4], topTraderPositionRatio: value[5], accountRatio: value[6], takerRatio: value[7]
    };
    if (Object.values(row).every(Number.isFinite)) rows.set(row.openTime, row);
  }
  return rows;
}

function loadMetrics(file) {
  return parseMetricsCsv(fs.readFileSync(file, 'utf8'));
}

function metricsAtEvent(event, rows) {
  const current = rows.get(event.signalTime), prior = rows.get(event.signalTime - 6 * FOUR_HOURS);
  if (!current || !prior || !(prior.openInterestValue > 0)) return null;
  if (current.sourceTime < event.signalTime || current.sourceTime >= event.entryTime) return null;
  if (prior.sourceTime < prior.openTime || prior.sourceTime >= event.signalTime - 5 * FOUR_HOURS) return null;
  return {
    metricsTime: current.openTime,
    metricsSourceTime: current.sourceTime,
    oiChange24h: current.openInterestValue / prior.openInterestValue - 1,
    openInterestValue: current.openInterestValue,
    topTraderAccountRatio: current.topTraderAccountRatio,
    topTraderPositionRatio: current.topTraderPositionRatio,
    accountRatio: current.accountRatio,
    takerRatio: current.takerRatio
  };
}

function attachMetrics(events, rowsByKey) {
  return events.map(event => {
    const metrics = metricsAtEvent(event, rowsByKey.get(`${event.market}:${event.symbol}`) || new Map());
    return { ...event, metrics, metricsAvailable: metrics != null, confirmed: confirmWithMetrics(event, metrics) };
  });
}

module.exports = { parseMetricsCsv, loadMetrics, metricsAtEvent, attachMetrics };
