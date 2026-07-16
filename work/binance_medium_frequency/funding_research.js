const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

const DATA_DIR = path.join(__dirname, 'data');

function quantile(values, probability) {
  if (!values.length) return null;
  const rows = values.slice().sort((a, b) => a - b);
  const position = (rows.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return lower === upper ? rows[lower] : rows[lower] + (rows[upper] - rows[lower]) * (position - lower);
}

function loadFunding(symbol) {
  return fs.readFileSync(path.join(DATA_DIR, `${symbol}_funding.csv`), 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map(line => {
    const [fundingTime, fundingRate, markPrice] = line.split(',');
    return { symbol, fundingTime: Number(fundingTime), fundingRate: Number(fundingRate), markPrice: markPrice === '' ? null : Number(markPrice) };
  });
}

function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }

function summarizeGroup(rows, roundTripCostPerLeg) {
  const future = rows.map(x => x.futureSpread).filter(Number.isFinite);
  const pairCost = 2 * roundTripCostPerLeg;
  return {
    signals: rows.length,
    completedFutureWindows: future.length,
    medianTrailingSpread: quantile(rows.map(x => x.trailingSpread), 0.5),
    medianFutureSevenDayFundingSpread: quantile(future, 0.5),
    meanFutureSevenDayFundingSpread: future.length ? mean(future) : null,
    fundingOnlyCostCoverageShare: future.length ? future.filter(x => x > pairCost).length / future.length : 0,
    pairCost
  };
}

function analyzeFunding({ start = CONFIG.train[0], end = CONFIG.train[1], rollingEvents = 3, futureEvents = 21 } = {}) {
  const from = Date.parse(`${start}T00:00:00Z`), to = Date.parse(`${end}T23:59:59.999Z`);
  const bySymbol = Object.fromEntries(CONFIG.symbols.map(symbol => [symbol, loadFunding(symbol).filter(x => x.fundingTime >= from && x.fundingTime <= to)]));
  const rateMaps = Object.fromEntries(Object.entries(bySymbol).map(([symbol, rows]) => [symbol, new Map(rows.map(x => [x.fundingTime, x.fundingRate]))]));
  const events = new Map();
  for (const rows of Object.values(bySymbol)) for (const row of rows) {
    if (!events.has(row.fundingTime)) events.set(row.fundingTime, []);
    events.get(row.fundingTime).push(row);
  }
  const times = [...events.keys()].sort((a, b) => a - b), queues = new Map(), observations = [];
  for (let timeIndex = 0; timeIndex < times.length; timeIndex++) {
    const time = times[timeIndex];
    for (const row of events.get(time)) {
      const queue = queues.get(row.symbol) || [];
      queue.push(row.fundingRate);
      if (queue.length > rollingEvents) queue.shift();
      queues.set(row.symbol, queue);
    }
    const available = events.get(time).map(row => ({ symbol: row.symbol, queue: queues.get(row.symbol) }))
      .filter(x => x.queue.length === rollingEvents)
      .map(x => ({ symbol: x.symbol, trailingRate: mean(x.queue) }));
    if (available.length < 8) continue;
    available.sort((a, b) => a.trailingRate - b.trailingRate || a.symbol.localeCompare(b.symbol));
    const low = available[0], high = available.at(-1), trailingSpread = high.trailingRate - low.trailingRate;
    let futureSpread = 0, futureCount = 0;
    for (let j = timeIndex + 1; j < Math.min(times.length, timeIndex + 1 + futureEvents); j++) {
      const highRate = rateMaps[high.symbol].get(times[j]), lowRate = rateMaps[low.symbol].get(times[j]);
      if (Number.isFinite(highRate) && Number.isFinite(lowRate)) { futureSpread += highRate - lowRate; futureCount++; }
    }
    observations.push({ time, low: low.symbol, high: high.symbol, trailingSpread, futureSpread: futureCount >= Math.ceil(futureEvents * 0.85) ? futureSpread : null, futureCount });
  }
  const spreads = observations.map(x => x.trailingSpread);
  const thresholds = [0.0002, 0.0003, 0.0005, 0.001];
  return {
    generatedAt: new Date().toISOString(),
    dates: [start, end],
    rollingEvents,
    futureEvents,
    observations: observations.length,
    trailingSpreadQuantiles: { p50: quantile(spreads, 0.5), p75: quantile(spreads, 0.75), p90: quantile(spreads, 0.9), p95: quantile(spreads, 0.95), p99: quantile(spreads, 0.99) },
    thresholds: Object.fromEntries(thresholds.map(threshold => [String(threshold), {
      base: summarizeGroup(observations.filter(x => x.trailingSpread >= threshold), CONFIG.baseCost),
      stress: summarizeGroup(observations.filter(x => x.trailingSpread >= threshold), CONFIG.stressCost),
      extreme: summarizeGroup(observations.filter(x => x.trailingSpread >= threshold), 0.0032)
    }]))
  };
}

if (require.main === module) console.log(JSON.stringify(analyzeFunding(), null, 2));

module.exports = { quantile, loadFunding, summarizeGroup, analyzeFunding };
