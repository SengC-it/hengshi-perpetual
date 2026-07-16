const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { unzipSingle } = require('./download');

const DATA_DIR = path.join(__dirname, 'data');
const INTERVAL_MS = 4 * 60 * 60 * 1000;

function dateKeys(start, end) {
  const rows = [], cursor = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) { rows.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return rows;
}

async function fetchBuffer(url) {
  let last;
  for (const delay of [0, 250, 750, 1500]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(url);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) { last = error; }
  }
  throw last;
}

async function mapLimit(items, limit, fn) {
  const output = Array(items.length); let cursor = 0, completed = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
      completed++;
      if (completed % 100 === 0 || completed === items.length) console.error(`metrics downloads ${completed}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function parseMetricCsv(buffer) {
  const lines = unzipSingle(buffer).toString('utf8').trim().split(/\r?\n/);
  const header = lines.shift().split(','), index = Object.fromEntries(header.map((name, i) => [name, i]));
  const numeric = value => {
    const parsed = Number(value);
    return value !== '' && Number.isFinite(parsed) ? parsed : null;
  };
  return lines.filter(Boolean).map(line => {
    const values = line.split(','), time = Date.parse(`${values[index.create_time].replace(' ', 'T')}Z`);
    return {
      time,
      openInterest: numeric(values[index.sum_open_interest]),
      openInterestValue: numeric(values[index.sum_open_interest_value]),
      topCountRatio: numeric(values[index.count_toptrader_long_short_ratio]),
      topPositionRatio: numeric(values[index.sum_toptrader_long_short_ratio]),
      globalRatio: numeric(values[index.count_long_short_ratio]),
      takerRatio: numeric(values[index.sum_taker_long_short_vol_ratio])
    };
  }).filter(row => Number.isFinite(row.time));
}

function aggregate4h(rows) {
  const uniqueRows = [...new Map(rows.map(row => [row.time, row])).values()];
  const buckets = new Map();
  for (const row of uniqueRows) {
    const openTime = Math.floor(row.time / INTERVAL_MS) * INTERVAL_MS;
    const bucket = buckets.get(openTime) || {
      openTime, lastTime: -1, count: 0,
      takerSum: 0, takerCount: 0,
      topCountSum: 0, topCountCount: 0,
      topPositionSum: 0, topPositionCount: 0,
      globalSum: 0, globalCount: 0
    };
    if (row.time >= bucket.lastTime && row.openInterest > 0 && row.openInterestValue > 0) {
      bucket.lastTime = row.time;
      bucket.openInterest = row.openInterest;
      bucket.openInterestValue = row.openInterestValue;
    }
    bucket.count++;
    for (const [name, sumKey, countKey] of [
      ['takerRatio', 'takerSum', 'takerCount'],
      ['topCountRatio', 'topCountSum', 'topCountCount'],
      ['topPositionRatio', 'topPositionSum', 'topPositionCount'],
      ['globalRatio', 'globalSum', 'globalCount']
    ]) if (Number.isFinite(row[name]) && row[name] > 0) { bucket[sumKey] += row[name]; bucket[countKey]++; }
    buckets.set(openTime, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime).map(bucket => ({
    openTime: bucket.openTime,
    sampleTime: bucket.lastTime,
    samples: bucket.count,
    openInterest: bucket.openInterest,
    openInterestValue: bucket.openInterestValue,
    topCountRatio: bucket.topCountCount ? bucket.topCountSum / bucket.topCountCount : null,
    topPositionRatio: bucket.topPositionCount ? bucket.topPositionSum / bucket.topPositionCount : null,
    globalRatio: bucket.globalCount ? bucket.globalSum / bucket.globalCount : null,
    takerRatio: bucket.takerCount ? bucket.takerSum / bucket.takerCount : null
  })).filter(bucket => bucket.openInterest > 0 && bucket.openInterestValue > 0);
}

async function downloadSymbolMetrics(symbol, start = '2021-02-06', end = '2026-07-11', dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });
  const output = path.join(dataDir, `${symbol}_metrics_4h.csv`);
  const manifestFile = path.join(dataDir, `${symbol.toLowerCase()}-metrics-manifest.json`);
  const days = dateKeys(start, end), base = `https://data.binance.vision/data/futures/um/daily/metrics/${symbol}`;
  const buffers = await mapLimit(days, 32, day => fetchBuffer(`${base}/${symbol}-metrics-${day}.zip`));
  const from = Date.parse(`${start}T00:00:00Z`), through = Date.parse(`${end}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  const rows = buffers.filter(Boolean).flatMap(parseMetricCsv).filter(row => row.time >= from && row.time < through);
  const aggregated = aggregate4h(rows);
  const text = [
    'openTime,sampleTime,samples,openInterest,openInterestValue,topCountRatio,topPositionRatio,globalRatio,takerRatio',
    ...aggregated.map(row => [row.openTime,row.sampleTime,row.samples,row.openInterest,row.openInterestValue,row.topCountRatio,row.topPositionRatio,row.globalRatio,row.takerRatio].join(','))
  ].join('\n');
  fs.writeFileSync(`${output}.tmp`, text);
  fs.renameSync(`${output}.tmp`, output);
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: base,
    dates: [start, end],
    requestedDays: days.length,
    downloadedDays: buffers.filter(Boolean).length,
    missingDays: days.filter((_, index) => !buffers[index]),
    sourceRows: rows.length,
    aggregatedRows: aggregated.length,
    symbol,
    file: path.basename(output),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return manifest;
}

async function downloadBtcMetrics(start = '2021-02-06', end = '2026-07-11') {
  return downloadSymbolMetrics('BTCUSDT', start, end);
}

if (require.main === module) downloadBtcMetrics().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { dateKeys, parseMetricCsv, aggregate4h, downloadSymbolMetrics, downloadBtcMetrics };
