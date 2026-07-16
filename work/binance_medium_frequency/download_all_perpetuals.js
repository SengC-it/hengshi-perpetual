const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchBuffer, unzipSingle } = require('./download');

const ROOT = __dirname;
const UNIVERSE_FILE = path.join(ROOT, 'data', 'binance-perpetual-universe-2026-07-14.json');
const OUTPUT_DIR = path.join(ROOT, 'all_perpetuals_data');
const MANIFEST_FILE = path.join(OUTPUT_DIR, 'manifest.json');
const START_MONTH = '2020-01';
const END_MONTH = '2026-06';

function normalizeTime(value) { const number = Number(value); return number > 1e14 ? Math.floor(number / 1000) : number; }

function monthKeys(start, end) {
  const rows = [], cursor = new Date(`${start}-01T00:00:00Z`), last = new Date(`${end}-01T00:00:00Z`);
  while (cursor <= last) { rows.push(cursor.toISOString().slice(0, 7)); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
  return rows;
}

function symbolMonths(record) {
  const first = new Date(Math.max(Date.parse(`${START_MONTH}-01T00:00:00Z`), record.onboardDate || 0));
  const last = new Date(Math.min(Date.parse(`${END_MONTH}-28T23:59:59Z`), record.deliveryDate || Date.parse(`${END_MONTH}-28T23:59:59Z`)));
  if (first > last) return [];
  return monthKeys(first.toISOString().slice(0, 7), last.toISOString().slice(0, 7));
}

async function mapLimit(items, limit, fn) {
  const output = Array(items.length); let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function linesFromZip(buffer) {
  if (!buffer) return [];
  const lines = unzipSingle(buffer).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.length && !/^\d/.test(lines[0]) ? lines.slice(1) : lines;
}

function parseKlineLine(line, market, symbol) {
  const values = line.split(','), openTime = normalizeTime(values[0]), close = Number(values[4]);
  const quoteVolume = market === 'um' ? Number(values[7]) : Number(values[7]) * close;
  return {
    symbol,
    openTime,
    open: Number(values[1]),
    high: Number(values[2]),
    low: Number(values[3]),
    close,
    volume: Number(values[5]),
    closeTime: normalizeTime(values[6]),
    quoteVolume,
    trades: Number(values[8]),
    takerBuyQuoteVolume: market === 'um' ? Number(values[10]) : Number(values[10]) * close
  };
}

function parseFundingLine(line) {
  const values = line.split(',');
  return { fundingTime: normalizeTime(values[0]), fundingRate: Number(values[2]) };
}

function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function atomicWrite(file, text) {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

async function safeFetch(url, errors) {
  try { return await fetchBuffer(url); }
  catch (error) { errors.push({ url, message: error.message }); return null; }
}

async function downloadSymbol(record, market) {
  const months = symbolMonths(record), base = `https://data.binance.vision/data/futures/${market}/monthly`;
  const errors = [];
  const klineBuffers = await mapLimit(months, 4, month => safeFetch(`${base}/klines/${record.symbol}/4h/${record.symbol}-4h-${month}.zip`, errors));
  const fundingBuffers = await mapLimit(months, 4, month => safeFetch(`${base}/fundingRate/${record.symbol}/${record.symbol}-fundingRate-${month}.zip`, errors));
  const bars = new Map(), funding = new Map();
  for (const buffer of klineBuffers.filter(Boolean)) for (const line of linesFromZip(buffer)) {
    const row = parseKlineLine(line, market, record.symbol);
    if ([row.openTime,row.open,row.high,row.low,row.close,row.closeTime,row.quoteVolume].every(Number.isFinite)) bars.set(row.openTime, row);
  }
  for (const buffer of fundingBuffers.filter(Boolean)) for (const line of linesFromZip(buffer)) {
    const row = parseFundingLine(line);
    if (Number.isFinite(row.fundingTime) && Number.isFinite(row.fundingRate)) funding.set(row.fundingTime, row);
  }
  const marketDir = path.join(OUTPUT_DIR, market);
  fs.mkdirSync(marketDir, { recursive: true });
  const barFile = path.join(marketDir, `${record.symbol}_4h.csv`), fundingFile = path.join(marketDir, `${record.symbol}_funding.csv`);
  const sortedBars = [...bars.values()].sort((a, b) => a.openTime - b.openTime);
  const sortedFunding = [...funding.values()].sort((a, b) => a.fundingTime - b.fundingTime);
  atomicWrite(barFile, [
    'openTime,open,high,low,close,volume,closeTime,quoteVolume,trades,takerBuyQuoteVolume',
    ...sortedBars.map(row => [row.openTime,row.open,row.high,row.low,row.close,row.volume,row.closeTime,row.quoteVolume,row.trades,row.takerBuyQuoteVolume].join(','))
  ].join('\n'));
  atomicWrite(fundingFile, [
    'fundingTime,fundingRate',
    ...sortedFunding.map(row => [row.fundingTime,row.fundingRate].join(','))
  ].join('\n'));
  return {
    market,
    symbol: record.symbol,
    pair: record.pair,
    baseAsset: record.baseAsset,
    quoteAsset: record.quoteAsset,
    marginAsset: record.marginAsset,
    status: record.status,
    onboardDate: record.onboardDate,
    deliveryDate: record.deliveryDate,
    requestedMonths: months.length,
    klineMonths: klineBuffers.filter(Boolean).length,
    fundingMonths: fundingBuffers.filter(Boolean).length,
    bars: sortedBars.length,
    fundingRows: sortedFunding.length,
    firstBar: sortedBars[0]?.openTime || null,
    lastBar: sortedBars.at(-1)?.openTime || null,
    barSha256: hashFile(barFile),
    fundingSha256: hashFile(fundingFile),
    errors
  };
}

function saveManifest(manifest) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  atomicWrite(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

async function main() {
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
  const records = [
    ...universe.usdsMarginedPerpetuals.map(record => ({ market: 'um', record })),
    ...universe.coinMarginedPerpetuals.map(record => ({ market: 'cm', record }))
  ];
  const prior = fs.existsSync(MANIFEST_FILE) ? JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) : null;
  const byKey = new Map((prior?.symbols || []).map(row => [`${row.market}:${row.symbol}`, row]));
  let completed = 0;
  await mapLimit(records, 12, async ({ market, record }) => {
    const key = `${market}:${record.symbol}`;
    if (!byKey.has(key) || byKey.get(key).errors?.length) byKey.set(key, await downloadSymbol(record, market));
    completed++;
    if (completed % 10 === 0 || completed === records.length) {
      const manifest = { generatedAt: new Date().toISOString(), source: 'https://data.binance.vision/data/futures', startMonth: START_MONTH, endMonth: END_MONTH, universeFile: path.basename(UNIVERSE_FILE), requestedSymbols: records.length, completedSymbols: byKey.size, symbols: [...byKey.values()].sort((a, b) => a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol)) };
      saveManifest(manifest);
      console.error(`all-perpetuals ${completed}/${records.length}; with bars ${[...byKey.values()].filter(row => row.bars > 0).length}; errors ${[...byKey.values()].filter(row => row.errors?.length).length}`);
    }
  });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  console.log(JSON.stringify({ requestedSymbols: manifest.requestedSymbols, completedSymbols: manifest.completedSymbols, withBars: manifest.symbols.filter(row => row.bars > 0).length, withAtLeastYear: manifest.symbols.filter(row => row.bars >= 6 * 365).length, errors: manifest.symbols.filter(row => row.errors?.length).length }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { normalizeTime, monthKeys, symbolMonths, parseKlineLine, parseFundingLine, downloadSymbol };

