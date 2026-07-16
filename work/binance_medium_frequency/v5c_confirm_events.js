const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { loadMetrics, attachMetrics } = require('./v5c_metrics');

const ROOT = __dirname, DATA_DIR = path.join(ROOT, 'v5c_data');
const EVENTS_FILE = path.join(DATA_DIR, 'potential_events.json');
const MANIFEST_FILE = path.join(DATA_DIR, 'metrics_manifest.json');
const AUDIT_FILE = path.join(DATA_DIR, 'event_metrics_audit.json');
const CONFIRMED_FILE = path.join(DATA_DIR, 'confirmed_events.json');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function counts(rows, field) { return Object.fromEntries([...new Set(rows.map(row => row[field]))].sort().map(value => [value, rows.filter(row => row[field] === value).length])); }

function run() {
  const events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')), rowsByKey = new Map();
  for (const item of manifest.symbols) {
    const file = path.join(DATA_DIR, item.market, `${item.symbol}_metrics_4h.csv`);
    if (fs.existsSync(file)) rowsByKey.set(`${item.market}:${item.symbol}`, loadMetrics(file));
  }
  const audited = attachMetrics(events, rowsByKey), confirmed = audited.filter(row => row.confirmed);
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(audited));
  fs.writeFileSync(CONFIRMED_FILE, JSON.stringify(confirmed));
  fs.writeFileSync(path.join(DATA_DIR, 'confirmed_events.csv'), serializeCsv(confirmed.map(row => ({ ...row, ...row.metrics })), [
    'signalTime','entryTime','market','symbol','baseAsset','day','type','side','score','premium','premiumZ','funding','residualZ','takerShare',
    'metricsTime','metricsSourceTime','oiChange24h','openInterestValue','topTraderAccountRatio','topTraderPositionRatio','accountRatio','takerRatio'
  ]));
  return {
    potential: audited.length,
    metricsAvailable: audited.filter(row => row.metricsAvailable).length,
    confirmed: confirmed.length,
    rejectedByMetrics: audited.filter(row => row.metricsAvailable && !row.confirmed).length,
    missingMetrics: audited.filter(row => !row.metricsAvailable).length,
    confirmedByType: counts(confirmed, 'type'), confirmedByMarket: counts(confirmed, 'market'), confirmedBySide: counts(confirmed, 'side'),
    potentialSha256: hash(EVENTS_FILE), auditSha256: hash(AUDIT_FILE), confirmedSha256: hash(CONFIRMED_FILE)
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(run(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { run };
