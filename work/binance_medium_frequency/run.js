const fs = require('fs');
const path = require('path');
const { CONFIG, PARAMETER_GRID } = require('./config');
const { loadBars } = require('./data');
const { downloadAll } = require('./download');
const { simulate } = require('./portfolio');
const { summarize, acceptance } = require('./metrics');
const { chooseParameter, freezeParameter, assertFinalAllowed, createFinalLock } = require('./selection');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const DEVELOPMENT_FILE = path.join(ROOT, 'development-results.json');
const FROZEN_FILE = path.join(ROOT, 'frozen-params.json');
const FINAL_LOCK = path.join(ROOT, 'final-run.lock');

function dateString(date) { return date.toISOString().slice(0, 10); }

function validationWindows(start, end) {
  const windows = [];
  let cursor = new Date(`${start}T00:00:00Z`), final = new Date(`${end}T00:00:00Z`);
  while (cursor <= final) {
    const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 3); next.setUTCDate(next.getUTCDate() - 1);
    const stop = next > final ? final : next;
    windows.push([dateString(cursor), dateString(stop)]);
    cursor = new Date(stop); cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

function escapeCsv(value) {
  if (value == null) return '';
  const x = String(value);
  return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
}

function serializeCsv(rows, columns) {
  return [columns.join(','), ...rows.map(row => columns.map(c => escapeCsv(row[c])).join(','))].join('\n');
}

function parseFunding(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map(line => {
    const [fundingTime, fundingRate, markPrice] = line.split(',');
    return { fundingTime: +fundingTime, fundingRate: +fundingRate, markPrice: markPrice === '' ? null : +markPrice };
  });
}

function loadDataset(cutoff, dataDir = DATA_DIR) {
  const to = Date.parse(`${cutoff}T23:59:59.999Z`), barsBySymbol = {}, fundingBySymbol = {}, warnings = [];
  for (const symbol of CONFIG.symbols) {
    const file = path.join(dataDir, `${symbol}_4h.csv`);
    if (!fs.existsSync(file)) throw new Error(`missing data file ${file}`);
    const loaded = loadBars(file, symbol);
    barsBySymbol[symbol] = loaded.bars.filter(b => b.openTime <= to);
    warnings.push(...loaded.warnings.map(w => ({ symbol, ...w })));
    fundingBySymbol[symbol] = parseFunding(path.join(dataDir, `${symbol}_funding.csv`)).filter(f => f.fundingTime <= to);
  }
  return { barsBySymbol, fundingBySymbol, warnings };
}

function metricRun(data, params, dates, leverageScale = 2, cost = CONFIG.baseCost) {
  const run = simulate({ ...data, params, start: dates[0], end: dates[1], leverageScale, cost });
  const summary = summarize({ trades: run.trades, equity: run.equity, startTime: Date.parse(`${dates[0]}T00:00:00Z`), endTime: Date.parse(`${dates[1]}T00:00:00Z`) });
  return { run, summary };
}

function finitePf(value) { return Number.isFinite(value) ? value : 0; }
function median(values) { const x = values.slice().sort((a, b) => a - b); return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2; }

function develop(dataDir = DATA_DIR) {
  const data = loadDataset(CONFIG.validation[1], dataDir);
  const windows = validationWindows(...CONFIG.validation);
  const candidates = PARAMETER_GRID.map((params, index) => {
    const train = metricRun(data, params, CONFIG.train).summary;
    const validation = metricRun(data, params, CONFIG.validation).summary;
    const windowMetrics = windows.map(dates => metricRun(data, params, dates).summary);
    return {
      id: `p${String(index + 1).padStart(2, '0')}`,
      params,
      train,
      validation,
      validationWindows: windows.map((dates, i) => ({ dates, ...windowMetrics[i] })),
      medianValidationPf: median(windowMetrics.map(x => finitePf(x.profitFactor))),
      validationReturn: validation.totalReturn,
      validationDd: validation.maxDrawdown,
      frequencyPass: validation.entriesPerDay >= 0.5 && validation.entriesPerDay <= 2
    };
  });
  const selected = chooseParameter(candidates);
  const result = { generatedAt: new Date().toISOString(), cutoff: CONFIG.validation[1], candidateCount: candidates.length, selectedId: selected.id, candidates, warnings: data.warnings };
  fs.writeFileSync(DEVELOPMENT_FILE, JSON.stringify(result, null, 2));
  return result;
}

function freeze() {
  if (!fs.existsSync(DEVELOPMENT_FILE)) throw new Error('development results missing');
  const development = JSON.parse(fs.readFileSync(DEVELOPMENT_FILE, 'utf8'));
  const selected = development.candidates.find(x => x.id === development.selectedId);
  const manifestFile = path.join(DATA_DIR, 'data-manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  freezeParameter(selected, FROZEN_FILE, { specification: '../../docs/superpowers/specs/2026-07-12-binance-4h-medium-frequency-system-design.md', dataManifest: manifest });
  return JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
}

function preflight() {
  if (!fs.existsSync(FROZEN_FILE)) throw new Error('frozen parameter missing');
  const frozen = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
  const data = loadDataset(CONFIG.validation[1]);
  const base = metricRun(data, frozen.selected.params, CONFIG.validation, 2, CONFIG.baseCost).summary;
  const stress = metricRun(data, frozen.selected.params, CONFIG.validation, 2, CONFIG.stressCost).summary;
  return { base, stress, cutoff: CONFIG.validation[1] };
}

function finalRun() {
  assertFinalAllowed(FINAL_LOCK, FROZEN_FILE);
  createFinalLock(FINAL_LOCK, FROZEN_FILE);
  const frozen = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
  const data = loadDataset(CONFIG.final[1]);
  const variants = {};
  for (const leverageScale of [1, 2]) for (const [costName, cost] of [['base', CONFIG.baseCost], ['stress', CONFIG.stressCost]]) {
    const key = `${leverageScale}x_${costName}`;
    const evaluated = metricRun(data, frozen.selected.params, CONFIG.final, leverageScale, cost);
    variants[key] = { summary: evaluated.summary, trades: evaluated.run.trades, equity: evaluated.run.equity, orders: evaluated.run.orders };
  }
  const headline = { ...variants['2x_base'].summary, stressProfitFactor: variants['2x_stress'].summary.profitFactor };
  const gate = acceptance(headline);
  const output = { generatedAt: new Date().toISOString(), design: '4h regime-gated cross-sectional trend pullback', dates: { train: CONFIG.train, validation: CONFIG.validation, final: CONFIG.final }, selected: frozen.selected, costs: { base: CONFIG.baseCost, stress: CONFIG.stressCost }, variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.summary])), acceptance: gate, fundingWarnings: data.warnings };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_results.json'), JSON.stringify(output, null, 2));
  const trades = variants['2x_base'].trades;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_trades.csv'), serializeCsv(trades, ['symbol','side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_equity.csv'), serializeCsv(variants['2x_base'].equity, ['time','equity','cash','grossExposure','positions']));
  return output;
}

async function main() {
  const command = process.argv[2];
  if (command === 'download') console.log(JSON.stringify(await downloadAll(), null, 2));
  else if (command === 'develop') console.log(JSON.stringify(develop(), null, 2));
  else if (command === 'freeze') console.log(JSON.stringify(freeze(), null, 2));
  else if (command === 'preflight') console.log(JSON.stringify(preflight(), null, 2));
  else if (command === 'final') console.log(JSON.stringify(finalRun(), null, 2));
  else throw new Error('usage: node run.js download|develop|freeze|preflight|final');
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { validationWindows, serializeCsv, loadDataset, metricRun, develop, freeze, preflight, finalRun };
