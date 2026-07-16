const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadPrepared } = require('./v41_run');
const { attachFactorFeatures } = require('./v5_residual');
const { attachFundingFeatures } = require('./v5_funding');
const { loadPremium, scanPotentialEvents } = require('./v5c_features');

const ROOT = __dirname;
const V5C_DIR = path.join(ROOT, 'v5c_data');
const EVENTS_FILE = path.join(V5C_DIR, 'potential_events.json');
const REQUESTS_FILE = path.join(V5C_DIR, 'metrics_requests.json');
const START = Date.parse('2021-01-01T00:00:00Z'), END = Date.parse('2026-06-30T20:00:00Z');

function previousDay(day) {
  const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10);
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function scan() {
  const { prepared } = loadPrepared();
  attachFactorFeatures(prepared, 270); attachFundingFeatures(prepared, [21]);
  let premiumAttached = 0;
  for (const row of prepared) {
    const file = path.join(V5C_DIR, row.market, `${row.symbol}_premium_4h.csv`);
    if (!fs.existsSync(file)) continue;
    row.premium = loadPremium(file, row.bars); premiumAttached++;
  }
  const events = scanPotentialEvents(prepared.filter(row => row.premium), START, END), requests = new Map();
  for (const event of events) for (const day of [previousDay(event.day), event.day]) requests.set(`${event.market}:${event.symbol}:${day}`, { market: event.market, symbol: event.symbol, day });
  const requestRows = [...requests.values()].sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol) || a.day.localeCompare(b.day));
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requestRows));
  const byType = Object.fromEntries([...new Set(events.map(row => row.type))].map(type => [type, events.filter(row => row.type === type).length]));
  const byMarket = Object.fromEntries([...new Set(events.map(row => row.market))].map(market => [market, events.filter(row => row.market === market).length]));
  return { prepared: prepared.length, premiumAttached, events: events.length, byType, byMarket, metricRequests: requestRows.length, eventSha256: sha256(EVENTS_FILE), requestSha256: sha256(REQUESTS_FILE) };
}

if (require.main === module) {
  try { console.log(JSON.stringify(scan(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { previousDay, scan };
