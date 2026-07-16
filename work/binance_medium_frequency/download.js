const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { CONFIG } = require('./config');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url) {
  let last;
  for (const delay of [0, 1000, 2000, 4000, 8000]) {
    if (delay) await sleep(delay);
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      if (r.status !== 429 && r.status < 500) throw last;
    } catch (error) { last = error; }
  }
  throw last;
}

async function downloadKlines(symbol, startTime, endTime) {
  const rows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const q = new URLSearchParams({ symbol, interval: CONFIG.interval, startTime: String(cursor), endTime: String(endTime), limit: '1500' });
    const page = await fetchJson(`https://fapi.binance.com/fapi/v1/klines?${q}`);
    if (!page.length) break;
    rows.push(...page);
    const next = page.at(-1)[0] + CONFIG.intervalMs;
    if (next <= cursor) throw new Error(`non-advancing Kline cursor for ${symbol}`);
    cursor = next;
    if (page.length < 1500) break;
  }
  return rows;
}

async function downloadFunding(symbol, startTime, endTime) {
  const rows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const q = new URLSearchParams({ symbol, startTime: String(cursor), endTime: String(endTime), limit: '1000' });
    const page = await fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?${q}`);
    if (!page.length) break;
    rows.push(...page);
    const next = page.at(-1).fundingTime + 1;
    if (next <= cursor) throw new Error(`non-advancing funding cursor for ${symbol}`);
    cursor = next;
    if (page.length < 1000) break;
  }
  return rows;
}

function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

async function downloadApiAll(dataDir = path.join(__dirname, 'data')) {
  fs.mkdirSync(dataDir, { recursive: true });
  const start = Date.parse(`${CONFIG.train[0]}T00:00:00Z`), end = Date.parse(`${CONFIG.final[1]}T23:59:59Z`);
  const manifest = { generatedAt: new Date().toISOString(), source: 'Binance USD-M REST', files: [], warnings: [] };
  for (const symbol of CONFIG.symbols) {
    const k = await downloadKlines(symbol, start, end);
    const kFile = path.join(dataDir, `${symbol}_4h.csv`);
    const kText = ['openTime,open,high,low,close,volume,closeTime', ...k.map(x => [x[0],x[1],x[2],x[3],x[4],x[5],x[6]].join(','))].join('\n');
    fs.writeFileSync(`${kFile}.tmp`, kText); fs.renameSync(`${kFile}.tmp`, kFile);
    manifest.files.push({ file: path.basename(kFile), rows: k.length, sha256: hashFile(kFile) });
    try {
      const f = await downloadFunding(symbol, start, end);
      const fFile = path.join(dataDir, `${symbol}_funding.csv`);
      const fText = ['fundingTime,fundingRate,markPrice', ...f.map(x => [x.fundingTime,x.fundingRate,x.markPrice || ''].join(','))].join('\n');
      fs.writeFileSync(`${fFile}.tmp`, fText); fs.renameSync(`${fFile}.tmp`, fFile);
      manifest.files.push({ file: path.basename(fFile), rows: f.length, sha256: hashFile(fFile) });
    } catch (error) { manifest.warnings.push({ symbol, type: 'funding', message: error.message }); }
  }
  fs.writeFileSync(path.join(dataDir, 'data-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function fetchBuffer(url) {
  let last;
  for (const delay of [0, 500, 1000, 2000]) {
    if (delay) await sleep(delay);
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (error) { last = error; }
  }
  throw last;
}

function unzipSingle(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('invalid ZIP local header');
  const flags = buffer.readUInt16LE(6), method = buffer.readUInt16LE(8);
  if (flags & 0x08) throw new Error('ZIP data descriptors are unsupported');
  const compressedSize = buffer.readUInt32LE(18), fileNameLength = buffer.readUInt16LE(26), extraLength = buffer.readUInt16LE(28);
  const start = 30 + fileNameLength + extraLength, payload = buffer.subarray(start, start + compressedSize);
  if (method === 0) return payload;
  if (method === 8) return zlib.inflateRawSync(payload);
  throw new Error(`unsupported ZIP method ${method}`);
}

function monthKeys(start, end) {
  const result = [], cursor = new Date(`${start}-01T00:00:00Z`), last = new Date(`${end}-01T00:00:00Z`);
  while (cursor <= last) { result.push(cursor.toISOString().slice(0, 7)); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
  return result;
}

async function mapLimit(items, limit, fn) {
  const out = Array(items.length); let cursor = 0;
  async function worker() { while (true) { const i = cursor++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function normalizeTime(value) { const n = +value; return n > 1e14 ? Math.floor(n / 1000) : n; }

function csvLines(buffer) {
  const lines = unzipSingle(buffer).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.length && !/^\d/.test(lines[0]) ? lines.slice(1) : lines;
}

async function downloadArchiveAll(dataDir = path.join(__dirname, 'data')) {
  fs.mkdirSync(dataDir, { recursive: true });
  const base = 'https://data.binance.vision/data/futures/um';
  const months = monthKeys('2021-02', '2026-06');
  const julyDays = Array.from({ length: 11 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
  const manifest = { generatedAt: new Date().toISOString(), source: base, files: [], warnings: [{ type: 'funding', message: '2026-07-01 through 2026-07-11 funding archive unavailable; rates omitted for this interval' }] };
  for (const symbol of CONFIG.symbols) {
    const klineUrls = [
      ...months.map(m => `${base}/monthly/klines/${symbol}/4h/${symbol}-4h-${m}.zip`),
      ...julyDays.map(d => `${base}/daily/klines/${symbol}/4h/${symbol}-4h-${d}.zip`)
    ];
    const fundingUrls = months.map(m => `${base}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${m}.zip`);
    const klineBuffers = await mapLimit(klineUrls, 12, fetchBuffer);
    const fundingBuffers = await mapLimit(fundingUrls, 12, fetchBuffer);
    const klineMap = new Map();
    for (const buffer of klineBuffers.filter(Boolean)) for (const line of csvLines(buffer)) {
      const x = line.split(','), openTime = normalizeTime(x[0]), closeTime = normalizeTime(x[6]);
      if (openTime <= Date.parse('2026-07-11T23:59:59Z')) klineMap.set(openTime, [openTime,x[1],x[2],x[3],x[4],x[5],closeTime].join(','));
    }
    const fundingMap = new Map();
    for (const buffer of fundingBuffers.filter(Boolean)) for (const line of csvLines(buffer)) {
      const x = line.split(','), fundingTime = normalizeTime(x[0]);
      fundingMap.set(fundingTime, [fundingTime,x[2],''].join(','));
    }
    const kFile = path.join(dataDir, `${symbol}_4h.csv`), fFile = path.join(dataDir, `${symbol}_funding.csv`);
    const kText = ['openTime,open,high,low,close,volume,closeTime', ...[...klineMap.entries()].sort((a,b) => a[0]-b[0]).map(x => x[1])].join('\n');
    const fText = ['fundingTime,fundingRate,markPrice', ...[...fundingMap.entries()].sort((a,b) => a[0]-b[0]).map(x => x[1])].join('\n');
    fs.writeFileSync(`${kFile}.tmp`, kText); fs.renameSync(`${kFile}.tmp`, kFile);
    fs.writeFileSync(`${fFile}.tmp`, fText); fs.renameSync(`${fFile}.tmp`, fFile);
    manifest.files.push({ file: path.basename(kFile), rows: klineMap.size, sha256: hashFile(kFile) }, { file: path.basename(fFile), rows: fundingMap.size, sha256: hashFile(fFile) });
    console.error(`downloaded ${symbol}: ${klineMap.size} bars, ${fundingMap.size} funding rows`);
  }
  fs.writeFileSync(path.join(dataDir, 'data-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = { fetchJson, downloadKlines, downloadFunding, downloadApiAll, fetchBuffer, unzipSingle, downloadAll: downloadArchiveAll };
