const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { prepareSymbol, FOUR_HOURS } = require('./v41_engine');
const { loadPrepared } = require('./v41_run');
const { CONFIGS, scanBreakoutEvents, simulateBreakoutPeriod } = require('./v5d_breakout');
const { loadPremium, rollingPremiumFeatures } = require('./v5c_features');
const { parseMetricsLine, aggregateMetrics4h } = require('./download_v5c_data');
const { fetchBuffer, unzipSingle } = require('./download');
const { metricsAtEvent } = require('./v5c_metrics');
const { featureVector, predictRidge } = require('./v7_ml');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'v5c_data');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const CANDIDATE_FILE = path.join(ROOT, 'forward_candidate_v74.json');
const FORWARD_START = Date.parse('2026-07-01T00:00:00Z');
const DATA_END = Date.parse('2026-07-15T20:00:00Z');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v74_forward_2026-07-15.json');
const LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol'];
const SELECTIONS = Object.fromEntries(LAYERS.map(layer => [layer, { configId: 'ml' }]));

async function mapLimit(items, limit, fn) {
  const output = Array(items.length); let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, worker));
  return output;
}

function parseRestBar(values, market) {
  const close = Number(values[4]);
  return {
    openTime: Number(values[0]),
    o: Number(values[1]),
    h: Number(values[2]),
    l: Number(values[3]),
    c: close,
    v: Number(values[5]),
    closeTime: Number(values[6]),
    qv: market === 'cm' ? Number(values[7]) * close : Number(values[7]),
    trades: Number(values[8]),
    takerBuyQv: market === 'cm' ? Number(values[10]) * close : Number(values[10])
  };
}

function mergeByTime(existing, additions, key) {
  const rows = new Map(existing.map(row => [row[key], row]));
  for (const row of additions) rows.set(row[key], row);
  return [...rows.values()].sort((left, right) => left[key] - right[key]);
}

async function downloadForwardMarket(prepared, downloadStart, dataEnd) {
  const days = [];
  for (let time = downloadStart; time <= dataEnd; time += 86400000) days.push(new Date(time).toISOString().slice(0, 10));
  const downloads = await mapLimit(days, 4, async day => {
    const base = `https://data.binance.vision/data/futures/${prepared.market}/daily`;
    const [bars, premiums] = await Promise.all([
      fetchBuffer(`${base}/klines/${prepared.symbol}/4h/${prepared.symbol}-4h-${day}.zip`),
      fetchBuffer(`${base}/premiumIndexKlines/${prepared.symbol}/4h/${prepared.symbol}-4h-${day}.zip`)
    ]);
    return { bars, premiums };
  });
  const barsJson = downloads.flatMap(item => zipLines(item.bars).map(line => line.split(',')));
  const premiumJson = downloads.flatMap(item => zipLines(item.premiums).map(line => line.split(',')));
  if (!barsJson.length || !premiumJson.length) return { prepared, bars: 0, premiums: 0, unavailable: true };
  const newBars = barsJson.map(values => parseRestBar(values, prepared.market))
    .filter(row => [row.openTime,row.o,row.h,row.l,row.c,row.closeTime,row.qv,row.takerBuyQv].every(Number.isFinite) && row.openTime <= dataEnd);
  const premiumRows = premiumJson.map(values => ({ openTime: Number(values[0]), close: Number(values[4]) }))
    .filter(row => Number.isFinite(row.openTime) && Number.isFinite(row.close) && row.openTime <= dataEnd);
  const bars = mergeByTime(prepared.bars, newBars, 'openTime');
  const extended = prepareSymbol({
    symbol: prepared.symbol,
    baseAsset: prepared.baseAsset,
    market: prepared.market,
    bars,
    funding: prepared.funding
  });
  const premiumByTime = new Map(prepared.bars.map((bar, index) => [bar.openTime, prepared.premium?.close[index] ?? null]));
  for (const row of premiumRows) premiumByTime.set(row.openTime, row.close);
  extended.premium = rollingPremiumFeatures(extended.bars.map(bar => premiumByTime.get(bar.openTime) ?? null));
  return { prepared: extended, bars: newBars.length, premiums: premiumRows.length, unavailable: false };
}

function previousDay(day) {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function zipLines(buffer) {
  if (!buffer) return [];
  const lines = unzipSingle(buffer).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.length && !/^\d/.test(lines[0]) ? lines.slice(1) : lines;
}

async function metricsForEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${event.market}:${event.symbol}`;
    if (!groups.has(key)) groups.set(key, { market: event.market, symbol: event.symbol, days: new Set() });
    groups.get(key).days.add(previousDay(event.day));
    groups.get(key).days.add(event.day);
  }
  const results = await mapLimit([...groups.values()], 8, async group => {
    const rows = new Map(), errors = [];
    for (const day of [...group.days].sort()) {
      const url = `https://data.binance.vision/data/futures/${group.market}/daily/metrics/${group.symbol}/${group.symbol}-metrics-${day}.zip`;
      try {
        const buffer = await fetchBuffer(url);
        for (const row of aggregateMetrics4h(zipLines(buffer).map(parseMetricsLine))) rows.set(row.openTime, row);
      } catch (error) {
        errors.push({ day, message: error.message });
      }
    }
    return { key: `${group.market}:${group.symbol}`, rows, errors };
  });
  return {
    byKey: new Map(results.map(result => [result.key, result.rows])),
    requestedSymbols: results.length,
    rows: results.reduce((total, result) => total + result.rows.size, 0),
    errors: results.flatMap(result => result.errors.map(error => ({ key: result.key, ...error })))
  };
}

function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scoreCutoffForCandidate(candidate, layer) {
  return candidate.scoreCutoffByLayer?.[layer] ?? candidate.scoreCutoff;
}

function portfolioForCandidate(candidate) {
  return {
    maxPerBar: candidate.portfolio?.maxSignalsPerBar ?? 2,
    maxPerDay: candidate.portfolio?.maxSignalsPerDay ?? 2,
    maxPositions: candidate.portfolio?.maxPositions ?? 6
  };
}

async function runAll(options = {}) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const candidateFile = options.candidateFile ?? CANDIDATE_FILE;
  const resultFile = options.resultFile ?? RESULT_FILE;
  const outputPrefix = options.outputPrefix ?? 'binance_all_perpetuals_v74_forward';
  const forwardStart = options.forwardStart ?? FORWARD_START;
  const downloadStart = options.downloadStart ?? forwardStart;
  const dataEnd = options.dataEnd ?? DATA_END;
  const scanEnd = dataEnd - 18 * FOUR_HOURS;
  const updateCandidate = options.updateCandidate ?? true;
  const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  if (candidate.authorization !== 'PAPER_ONLY' || candidate.liveOrdersEnabled !== false) throw new Error('forward candidate safety lock is invalid');
  if (updateCandidate && forwardStart < candidate.validFrom) throw new Error('independent forward start precedes candidate validity');
  if (updateCandidate && dataEnd > candidate.validThrough) throw new Error('forward data exceeds candidate validity');
  if (updateCandidate && forwardStart <= (candidate.developmentDataObservedThrough ?? candidate.trainingEnd)) {
    throw new Error('independent forward overlaps development data');
  }
  const frozenModelHash = hashObject(candidate.model);
  const { manifest, prepared } = loadPrepared();
  for (const row of prepared) {
    const premiumFile = path.join(DATA_DIR, row.market, `${row.symbol}_premium_4h.csv`);
    if (fs.existsSync(premiumFile)) row.premium = loadPremium(premiumFile, row.bars);
  }
  const statusByKey = new Map(manifest.symbols.map(row => [`${row.market}:${row.symbol}`, row.status]));
  const eligibleMarkets = new Set(candidate.eligibleMarkets ?? ['um', 'cm']);
  const eligibleLayers = new Set(candidate.eligibleLayers ?? LAYERS);
  const eligible = prepared.filter(row => statusByKey.get(`${row.market}:${row.symbol}`) === 'TRADING'
    && eligibleMarkets.has(row.market)
    && eligibleLayers.has(candidate.layerAssignments[row.symbol])
    && row.premium);
  let completed = 0;
  const downloaded = await mapLimit(eligible, 8, async row => {
    let result;
    try {
      result = await downloadForwardMarket(row, downloadStart, dataEnd);
    } catch (error) {
      result = { prepared: row, bars: 0, premiums: 0, unavailable: true, error: error.message };
    }
    completed++;
    if (completed % 50 === 0 || completed === eligible.length) console.error(`V7.4 forward market ${completed}/${eligible.length}`);
    return result;
  });
  const extended = downloaded.map(result => result.prepared);
  const broad = CONFIGS.find(config => config.configId === 'broad');
  const potentialEvents = scanEnd >= forwardStart ? scanBreakoutEvents(extended, [broad], forwardStart, scanEnd) : [];
  const metricAudit = await metricsForEvents(potentialEvents);
  const auditedEvents = potentialEvents.map(event => {
    const metrics = metricsAtEvent(event, metricAudit.byKey.get(`${event.market}:${event.symbol}`) || new Map());
    const layer = candidate.layerAssignments[event.symbol];
    const score = metrics ? predictRidge(candidate.model, featureVector({ ...event, metrics }, layer)) : null;
    const scoreCutoff = scoreCutoffForCandidate(candidate, layer);
    return {
      ...event,
      metrics,
      metricsAvailable: metrics != null,
      layer,
      modelScore: score,
      scoreCutoff,
      selectedByModel: event.side === -1 && Number.isFinite(score) && Number.isFinite(scoreCutoff) && score >= scoreCutoff
    };
  });
  const modelEvents = auditedEvents.filter(event => event.selectedByModel).map(event => ({ ...event, configId: 'ml', score: event.modelScore }));
  const fundingAudit = {
    requestedSymbols: 0,
    rows: 0,
    unavailableSymbols: [...new Set(modelEvents.map(event => `${event.market}:${event.symbol}`))],
    status: 'daily_archive_unavailable_until_monthly_release'
  };
  const portfolio = portfolioForCandidate(candidate);
  const baseRun = simulateBreakoutPeriod({
    preparedSymbols: extended,
    events: modelEvents,
    layers: new Map(Object.entries(candidate.layerAssignments)),
    selections: SELECTIONS,
    startTime: forwardStart,
    endTime: dataEnd,
    scenario: 'base',
    ...portfolio
  });
  const stressRun = simulateBreakoutPeriod({
    preparedSymbols: extended,
    events: modelEvents,
    layers: new Map(Object.entries(candidate.layerAssignments)),
    selections: SELECTIONS,
    startTime: forwardStart,
    endTime: dataEnd,
    scenario: 'stress',
    ...portfolio
  });
  const extremeRun = simulateBreakoutPeriod({
    preparedSymbols: extended,
    events: modelEvents,
    layers: new Map(Object.entries(candidate.layerAssignments)),
    selections: SELECTIONS,
    startTime: forwardStart,
    endTime: dataEnd,
    scenario: 'extreme',
    ...portfolio
  });
  const calendarDays = Math.max(0, (dataEnd - forwardStart) / 86400000 + 1);
  const forwardGate = {
    calendarDays: calendarDays >= candidate.forwardGate.minimumCalendarDays,
    executedTrades: stressRun.summary.trades >= candidate.forwardGate.minimumExecutedTrades,
    stressProfitFactor: stressRun.summary.profitFactor >= candidate.forwardGate.minimumStressProfitFactor,
    maximumDrawdown: stressRun.summary.maxDrawdown >= candidate.forwardGate.maximumDrawdown,
    fundingDataComplete: fundingAudit.unavailableSymbols.length === 0,
    independentHoldout: forwardStart > (candidate.developmentDataObservedThrough ?? candidate.trainingEnd),
    frozenModelUnchanged: frozenModelHash === hashObject(candidate.model)
  };
  const result = {
    generatedAt: new Date().toISOString(),
    version: candidate.version,
    authorization: candidate.authorization,
    liveOrdersEnabled: false,
    evidenceStatus: options.evidenceStatus ?? 'FROZEN_FORWARD',
    dates: [new Date(forwardStart).toISOString().slice(0, 10), new Date(dataEnd).toISOString().slice(0, 10)],
    dataAudit: {
      eligibleSymbols: eligible.length,
      marketSymbolsAvailable: downloaded.filter(result => !result.unavailable).length,
      marketSymbolsUnavailable: downloaded.filter(result => result.unavailable).length,
      bars: downloaded.reduce((total, result) => total + result.bars, 0),
      premiumBars: downloaded.reduce((total, result) => total + result.premiums, 0),
      potentialEvents: potentialEvents.length,
      metricsAvailable: auditedEvents.filter(event => event.metricsAvailable).length,
      modelEvents: modelEvents.length,
      metrics: { requestedSymbols: metricAudit.requestedSymbols, rows: metricAudit.rows, errors: metricAudit.errors },
      funding: fundingAudit
    },
    base: baseRun.summary,
    stress: stressRun.summary,
    extreme: extremeRun.summary,
    forwardGate: {
      pass: Object.values(forwardGate).every(Boolean),
      checks: forwardGate,
      failures: Object.entries(forwardGate).filter(([, pass]) => !pass).map(([name]) => name)
    },
    status: options.status ?? 'PAPER_ONLY_FORWARD_IN_PROGRESS',
    caveats: [
      options.evidenceStatus === 'EXPOSED_REPLAY_NOT_INDEPENDENT_FORWARD'
        ? 'This interval was observed during development and cannot count toward the independent forward gate.'
        : 'This interval is frozen holdout data, but it is far shorter than the 180-day and 50-trade gate.',
      'REST and public archive availability are audited above; unavailable symbols are not treated as zero-return trades.',
      'Modeled costs are used because complete order-book replay is unavailable.'
    ]
  };
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${outputPrefix}_signals.csv`), serializeCsv(stressRun.finalSignals.map(event => ({ ...event, ...event.metrics })), [
    'signalTime','entryTime','market','symbol','baseAsset','layer','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr',
    'metricsSourceTime','oiChange24h','openInterestValue','topTraderAccountRatio','topTraderPositionRatio','accountRatio','takerRatio'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${outputPrefix}_trades.csv`), serializeCsv(stressRun.trades, [
    'signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','side','score','entryPrice','exitPrice','qty','notional',
    'grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'
  ]));
  if (updateCandidate) {
    candidate.forwardValidationState = {
      observedThrough: dataEnd,
      calendarDays,
      executedTrades: stressRun.summary.trades,
      stressProfitFactor: stressRun.summary.profitFactor,
      stressReturn: stressRun.summary.totalReturn,
      stressMaxDrawdown: stressRun.summary.maxDrawdown,
      status: result.forwardGate.pass ? 'FORWARD_GATE_PASSED' : 'IN_PROGRESS',
      resultFile: path.relative(ROOT, resultFile).replaceAll('\\', '/'),
      frozenModelSha256: frozenModelHash
    };
    if (frozenModelHash !== hashObject(candidate.model)) throw new Error('frozen model changed during forward update');
    fs.writeFileSync(candidateFile, JSON.stringify(candidate, null, 2));
  }
  return {
    resultFile,
    candidateFile,
    resultSha256: crypto.createHash('sha256').update(fs.readFileSync(resultFile)).digest('hex'),
    dataAudit: result.dataAudit,
    base: result.base,
    stress: result.stress,
    extreme: result.extreme,
    forwardGate: result.forwardGate
  };
}

if (require.main === module) {
  runAll().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseRestBar, mergeByTime, scoreCutoffForCandidate, portfolioForCandidate, runAll };
