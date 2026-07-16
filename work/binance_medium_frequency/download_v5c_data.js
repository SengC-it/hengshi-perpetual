const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchBuffer, unzipSingle } = require('./download');
const { normalizeTime, symbolMonths } = require('./download_all_perpetuals');

const ROOT = __dirname;
const UNIVERSE_FILE = path.join(ROOT, 'data', 'binance-perpetual-universe-2026-07-14.json');
const OUTPUT_DIR = path.join(ROOT, 'v5c_data');
const PREMIUM_MANIFEST = path.join(OUTPUT_DIR, 'premium_manifest.json');
const METRICS_REQUESTS = path.join(OUTPUT_DIR, 'metrics_requests.json');
const METRICS_MANIFEST = path.join(OUTPUT_DIR, 'metrics_manifest.json');
const V6_METRICS_REQUESTS = path.join(OUTPUT_DIR, 'v6_metrics_requests.json');
const V6_METRICS_MANIFEST = path.join(OUTPUT_DIR, 'v6_metrics_manifest.json');

async function mapLimit(items, limit, fn) {
  const output = Array(items.length); let cursor = 0;
  async function worker() {
    while (true) { const index = cursor++; if (index >= items.length) return; output[index] = await fn(items[index], index); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function linesFromZip(buffer) {
  if (!buffer) return [];
  const lines = unzipSingle(buffer).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.length && !/^\d/.test(lines[0]) ? lines.slice(1) : lines;
}

function parsePremiumLine(line) {
  const value = line.split(',');
  return { openTime: normalizeTime(value[0]), open: Number(value[1]), high: Number(value[2]), low: Number(value[3]), close: Number(value[4]) };
}

function parseMetricsLine(line) {
  const value = line.split(','), iso = value[0].includes('T') ? value[0] : value[0].replace(' ', 'T') + 'Z';
  return {
    time: Date.parse(iso),
    symbol: value[1],
    openInterest: Number(value[2]),
    openInterestValue: Number(value[3]),
    topTraderAccountRatio: Number(value[4]),
    topTraderPositionRatio: Number(value[5]),
    accountRatio: Number(value[6]),
    takerRatio: Number(value[7])
  };
}

function aggregateMetrics4h(rows) {
  const buckets = new Map(), interval = 4 * 60 * 60 * 1000;
  for (const row of rows) {
    if (!Number.isFinite(row.time)) continue;
    const bucket = Math.floor(row.time / interval) * interval;
    if (!buckets.has(bucket) || row.time > buckets.get(bucket).sourceTime) buckets.set(bucket, { openTime: bucket, sourceTime: row.time, openInterest: row.openInterest, openInterestValue: row.openInterestValue, topTraderAccountRatio: row.topTraderAccountRatio, topTraderPositionRatio: row.topTraderPositionRatio, accountRatio: row.accountRatio, takerRatio: row.takerRatio });
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function atomicWrite(file, text) { fs.writeFileSync(`${file}.tmp`, text); fs.renameSync(`${file}.tmp`, file); }

async function safeFetch(url, errors) {
  try { return await fetchBuffer(url); }
  catch (error) { errors.push({ url, message: error.message }); return null; }
}

async function downloadPremiumRecord(record, market) {
  const months = symbolMonths(record), errors = [];
  const base = `https://data.binance.vision/data/futures/${market}/monthly/premiumIndexKlines/${record.symbol}/4h`;
  const buffers = await mapLimit(months, 4, month => safeFetch(`${base}/${record.symbol}-4h-${month}.zip`, errors));
  const rows = new Map();
  for (const buffer of buffers.filter(Boolean)) for (const line of linesFromZip(buffer)) {
    const row = parsePremiumLine(line);
    if ([row.openTime,row.open,row.high,row.low,row.close].every(Number.isFinite)) rows.set(row.openTime, row);
  }
  const dir = path.join(OUTPUT_DIR, market); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.symbol}_premium_4h.csv`), sorted = [...rows.values()].sort((a, b) => a.openTime - b.openTime);
  atomicWrite(file, ['openTime,open,high,low,close', ...sorted.map(row => [row.openTime,row.open,row.high,row.low,row.close].join(','))].join('\n'));
  return { market, symbol: record.symbol, baseAsset: record.baseAsset, requestedMonths: months.length, availableMonths: buffers.filter(Boolean).length, rows: sorted.length, first: sorted[0]?.openTime || null, last: sorted.at(-1)?.openTime || null, sha256: hashFile(file), errors };
}

async function downloadPremiumAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
  const records = [...universe.usdsMarginedPerpetuals.map(record => ({ market: 'um', record })), ...universe.coinMarginedPerpetuals.map(record => ({ market: 'cm', record }))];
  const prior = fs.existsSync(PREMIUM_MANIFEST) ? JSON.parse(fs.readFileSync(PREMIUM_MANIFEST, 'utf8')) : null;
  const byKey = new Map((prior?.symbols || []).map(row => [`${row.market}:${row.symbol}`, row]));
  let completed = 0;
  await mapLimit(records, 12, async ({ market, record }) => {
    const key = `${market}:${record.symbol}`;
    if (!byKey.has(key) || byKey.get(key).errors?.length) byKey.set(key, await downloadPremiumRecord(record, market));
    completed++;
    if (completed % 10 === 0 || completed === records.length) {
      const manifest = { generatedAt: new Date().toISOString(), source: 'https://data.binance.vision/data/futures', requestedSymbols: records.length, completedSymbols: byKey.size, symbols: [...byKey.values()].sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol)) };
      atomicWrite(PREMIUM_MANIFEST, JSON.stringify(manifest, null, 2));
      console.error(`v5c premium ${completed}/${records.length}; with rows ${[...byKey.values()].filter(row => row.rows > 0).length}`);
    }
  });
  const manifest = JSON.parse(fs.readFileSync(PREMIUM_MANIFEST, 'utf8'));
  return { manifest: PREMIUM_MANIFEST, requested: manifest.requestedSymbols, completed: manifest.completedSymbols, withRows: manifest.symbols.filter(row => row.rows > 0).length, rows: manifest.symbols.reduce((sum, row) => sum + row.rows, 0), errors: manifest.symbols.filter(row => row.errors?.length).length };
}

async function downloadMetricsGroup(market, symbol, days) {
  const errors = [], base = `https://data.binance.vision/data/futures/${market}/daily/metrics/${symbol}`;
  const buffers = await mapLimit(days, 4, day => safeFetch(`${base}/${symbol}-metrics-${day}.zip`, errors));
  const rows = new Map();
  for (const buffer of buffers.filter(Boolean)) {
    const aggregated = aggregateMetrics4h(linesFromZip(buffer).map(parseMetricsLine));
    for (const row of aggregated) rows.set(row.openTime, row);
  }
  const dir = path.join(OUTPUT_DIR, market); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${symbol}_metrics_4h.csv`), sorted = [...rows.values()].sort((a, b) => a.openTime - b.openTime);
  atomicWrite(file, [
    'openTime,sourceTime,openInterest,openInterestValue,topTraderAccountRatio,topTraderPositionRatio,accountRatio,takerRatio',
    ...sorted.map(row => [row.openTime,row.sourceTime,row.openInterest,row.openInterestValue,row.topTraderAccountRatio,row.topTraderPositionRatio,row.accountRatio,row.takerRatio].join(','))
  ].join('\n'));
  return { market, symbol, requestedDays: days.length, availableDays: buffers.filter(Boolean).length, rows: sorted.length, first: sorted[0]?.openTime || null, last: sorted.at(-1)?.openTime || null, sha256: hashFile(file), errors };
}

async function downloadMetricsForEvents(requestFile = METRICS_REQUESTS, manifestFile = METRICS_MANIFEST) {
  if (!fs.existsSync(requestFile)) throw new Error(`metrics request file unavailable: ${requestFile}`);
  const requests = JSON.parse(fs.readFileSync(requestFile, 'utf8')), groups = new Map();
  for (const row of requests) {
    const key = `${row.market}:${row.symbol}`;
    if (!groups.has(key)) groups.set(key, { market: row.market, symbol: row.symbol, days: [] });
    groups.get(key).days.push(row.day);
  }
  const items = [...groups.values()], results = []; let completed = 0;
  await mapLimit(items, 12, async item => {
    results.push(await downloadMetricsGroup(item.market, item.symbol, [...new Set(item.days)].sort()));
    completed++;
    if (completed % 10 === 0 || completed === items.length) console.error(`v5c metrics symbols ${completed}/${items.length}`);
  });
  const manifest = { generatedAt: new Date().toISOString(), source: 'https://data.binance.vision/data/futures/*/daily/metrics', requestedFiles: requests.length, requestedSymbols: items.length, symbols: results.sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol)) };
  atomicWrite(manifestFile, JSON.stringify(manifest, null, 2));
  return { manifest: manifestFile, requestedFiles: requests.length, requestedSymbols: items.length, availableFiles: results.reduce((sum, row) => sum + row.availableDays, 0), withRows: results.filter(row => row.rows > 0).length, rows: results.reduce((sum, row) => sum + row.rows, 0), errors: results.filter(row => row.errors?.length).length };
}

if (require.main === module) {
  const action = process.argv.includes('--v6-metrics') ? () => downloadMetricsForEvents(V6_METRICS_REQUESTS, V6_METRICS_MANIFEST) : process.argv.includes('--metrics') ? downloadMetricsForEvents : downloadPremiumAll;
  action().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { parsePremiumLine, parseMetricsLine, aggregateMetrics4h, downloadPremiumRecord, downloadPremiumAll, downloadMetricsGroup, downloadMetricsForEvents };
