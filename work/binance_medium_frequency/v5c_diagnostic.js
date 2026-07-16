const fs = require('fs');
const path = require('path');
const { serializeCsv } = require('./run');
const { trailingStats } = require('./v41_engine');
const { classifyUniverse } = require('./v41_core');
const { loadPrepared } = require('./v41_run');
const { loadPremium } = require('./v5c_features');
const { simulateEvent, summarizeTrades } = require('./v5c_strategy');

const ROOT = __dirname, DATA = path.join(ROOT, 'v5c_data'), OUTPUT = path.resolve(ROOT, '..', '..', 'outputs');
function groupSummary(trades, field) { return Object.fromEntries([...new Set(trades.map(row => row[field]))].sort().map(value => [value, summarizeTrades(trades.filter(row => row[field] === value))])); }

function run(eventFile = 'confirmed_events.json', resultTag = 'v5c') {
  const events = JSON.parse(fs.readFileSync(path.join(DATA, eventFile), 'utf8'));
  const { prepared } = loadPrepared(), byKey = new Map(prepared.map(row => [`${row.market}:${row.symbol}`, row]));
  for (const row of prepared) {
    const file = path.join(DATA, row.market, `${row.symbol}_premium_4h.csv`);
    if (fs.existsSync(file)) row.premium = loadPremium(file, row.bars);
  }
  const layerCache = new Map();
  function layersAt(time) {
    const date = new Date(time), quarter = `${date.getUTCFullYear()}-${Math.floor(date.getUTCMonth() / 3)}`;
    if (!layerCache.has(quarter)) {
      const start = Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3, 1);
      layerCache.set(quarter, classifyUniverse(prepared.map(row => trailingStats(row, start))));
    }
    return layerCache.get(quarter);
  }
  const scenarios = {};
  for (const scenario of ['base','stress','extreme']) {
    const trades = events.map(event => {
      const preparedRow = byKey.get(`${event.market}:${event.symbol}`), layer = layersAt(event.signalTime).get(event.symbol);
      return preparedRow && layer && layer !== 'insufficient_history' ? simulateEvent(preparedRow, event, layer, scenario) : null;
    }).filter(Boolean);
    scenarios[scenario] = { ...summarizeTrades(trades), byType: groupSummary(trades, 'type'), bySide: groupSummary(trades, 'side'), byLayer: groupSummary(trades, 'layer') };
    if (scenario === 'stress') fs.writeFileSync(path.join(OUTPUT, `binance_all_perpetuals_${resultTag}_diagnostic_trades.csv`), serializeCsv(trades, ['signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','type','side','score','entryPrice','exitPrice','qty','notional','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld']));
  }
  const result = { version: `${resultTag}-oi-premium-event-diagnostic`, evidenceStatus: 'in_sample_diagnostic_not_validation', eventFile, events: events.length, scenarios };
  fs.writeFileSync(path.join(OUTPUT, `binance_all_perpetuals_${resultTag}_diagnostic_results.json`), JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try { console.log(JSON.stringify(process.argv.includes('--potential') ? run('potential_events.json', 'v5c_raw') : run(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { run };
