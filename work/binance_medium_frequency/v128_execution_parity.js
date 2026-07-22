const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseBars, parseFunding, prepareSymbol, FOUR_HOURS } = require('./v41_engine');
const { costForLayer } = require('./v41_portfolio');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const FOUR_HOUR_MS = FOUR_HOURS;
const FIVE_MINUTES = 5 * 60 * 1000;
const EXECUTION_DELAY_MS = FIVE_MINUTES;
const MAX_HOLD_BARS = 18;
const STOP_ATR = 2;
const TRAIL_ATR = 3;
const INITIAL_EQUITY = 100000;
const ARCHIVE_ROOT = path.join(ROOT, 'v128_5m_archive');
const TRADE_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v11_trades.csv');
const DATA_ROOT = path.join(ROOT, 'all_perpetuals_data', 'um');

function parseCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const fields = header.split(',');
  return lines.filter(Boolean).map(line => Object.fromEntries(fields.map((field, index) => [field, line.split(',')[index]])));
}

function csv(rows, fields) {
  return [fields.join(','), ...rows.map(row => fields.map(field => row[field] ?? '').join(','))].join('\n') + '\n';
}

function monthId(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function archiveName(symbol, month) {
  if (!/^[A-Z0-9]+$/.test(symbol) || !/^\d{4}-\d{2}$/.test(month)) throw new Error('invalid archive name');
  return `${symbol}-5m-${month}`;
}

function archiveCsvPath(symbol, month) {
  return path.join(ARCHIVE_ROOT, symbol, `${archiveName(symbol, month)}.csv`);
}

function csvCovers(file, requiredThrough) {
  if (!fs.existsSync(file) || !Number.isFinite(requiredThrough)) return fs.existsSync(file);
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(line => /^\d/.test(line));
  const last = Number(lines.at(-1)?.split(',')[0]);
  return Number.isFinite(last) && last >= requiredThrough;
}

function downloadMonth(symbol, month, requiredThrough) {
  const file = archiveCsvPath(symbol, month);
  if (csvCovers(file, requiredThrough)) return file;
  const directory = path.dirname(file), base = archiveName(symbol, month), zip = path.join(ARCHIVE_ROOT, 'zips', `${base}.zip`);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  const url = `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/5m/${base}.zip`;
  try {
    execFileSync('curl.exe', ['-sS', '-fL', '--retry', '3', '--connect-timeout', '20', '-o', zip, url], { stdio: 'pipe' });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`archive unavailable ${symbol} ${month}: ${detail}`);
  }
  try { execFileSync('tar.exe', ['-xf', zip, '-C', directory], { stdio: 'pipe' }); }
  catch (error) { throw new Error(`archive extract failed ${symbol} ${month}: ${error.stderr?.toString().trim() || error.message}`); }
  if (!fs.existsSync(file)) throw new Error(`archive did not contain expected CSV: ${file}`);
  return file;
}

function archiveKeys(trades) {
  const keys = new Map();
  for (const rawTrade of trades) {
    const trade = numericTrade(rawTrade), end = Math.max(dataEndTimeFor(trade, trade.entryTime), dataEndTimeFor(trade, trade.entryTime + EXECUTION_DELAY_MS));
    const cursor = new Date(Date.parse(`${monthId(trade.entryTime)}-01T00:00:00Z`)), last = monthId(end);
    while (true) {
      const month = cursor.toISOString().slice(0, 7), base = archiveName(trade.symbol, month);
      keys.set(`${trade.symbol}:${month}`, { symbol: trade.symbol, month, base });
      if (month === last) break;
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return [...keys.values()];
}

function prefetchArchives(trades) {
  const missing = archiveKeys(trades).filter(({ symbol, month }) => !fs.existsSync(archiveCsvPath(symbol, month)) && !fs.existsSync(path.join(ARCHIVE_ROOT, 'zips', `${archiveName(symbol, month)}.zip`)));
  if (!missing.length) return { requested: 0, error: null };
  const zipDir = path.join(ARCHIVE_ROOT, 'zips'), config = path.join(ARCHIVE_ROOT, 'v128_prefetch.curl');
  fs.mkdirSync(zipDir, { recursive: true });
  const lines = missing.flatMap(({ symbol, month, base }) => [
    `url = \"https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/5m/${base}.zip\"`,
    `output = \"${path.join(zipDir, `${base}.zip`).split(path.sep).join('/')}\"`
  ]);
  fs.writeFileSync(config, lines.join('\n') + '\n');
  try {
    execFileSync('curl.exe', ['-sS', '-fL', '--retry', '3', '--connect-timeout', '20', '--parallel', '--parallel-max', '8', '--config', config], { stdio: 'pipe' });
    return { requested: missing.length, error: null };
  } catch (error) {
    return { requested: missing.length, error: error.stderr?.toString().trim() || error.message };
  }
}

function parseFiveMinuteFile(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.filter(line => /^\d/.test(line)).map(line => {
    const value = line.split(',');
    return { openTime: +value[0], o: +value[1], h: +value[2], l: +value[3], c: +value[4] };
  }).filter(bar => [bar.openTime, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite));
}

function createFiveMinuteStore(options = {}) {
  const download = options.download ?? downloadMonth;
  const cache = new Map();
  function month(symbol, id, requiredThrough) {
    const key = `${symbol}:${id}`;
    if (!cache.has(key)) cache.set(key, parseFiveMinuteFile(download(symbol, id, requiredThrough)));
    return cache.get(key);
  }
  return {
    bars(symbol, startTime, endTime) {
      const output = [], cursor = new Date(Date.parse(`${monthId(startTime)}-01T00:00:00Z`));
      const last = monthId(endTime);
      while (true) {
        const id = cursor.toISOString().slice(0, 7);
        const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 1);
        const requiredThrough = Math.min(endTime, next.getTime() - FIVE_MINUTES);
        output.push(...month(symbol, id, requiredThrough));
        if (id === last) break;
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
      return output.filter(bar => bar.openTime >= startTime && bar.openTime <= endTime).sort((a, b) => a.openTime - b.openTime);
    },
    downloadedArchives() { return cache.size; }
  };
}

function stopFill(position, bar) {
  if (position.side === 1) {
    if (bar.o <= position.stop) return bar.o;
    if (bar.l <= position.stop) return position.stop;
  } else {
    if (bar.o >= position.stop) return bar.o;
    if (bar.h >= position.stop) return position.stop;
  }
  return null;
}

function numericTrade(row) {
  return {
    ...row,
    side: Number(row.side),
    signalTime: Number(row.signalTime),
    entryTime: Number(row.entryTime),
    exitTime: Number(row.exitTime),
    notional: Number(row.notional),
    netPnl: Number(row.netPnl),
    fees: Number(row.fees),
    fundingPnl: Number(row.fundingPnl)
  };
}

function endTimeFor(trade, entryTime) {
  return trade.reason === 'period_end'
    ? trade.exitTime
    : entryTime + MAX_HOLD_BARS * FOUR_HOUR_MS;
}

function dataEndTimeFor(trade, entryTime) {
  return trade.reason === 'period_end' ? trade.exitTime - FIVE_MINUTES : endTimeFor(trade, entryTime);
}

function simulateExecutableTrade({ trade: rawTrade, prepared, fiveMinuteBars, executionDelayMs = EXECUTION_DELAY_MS }) {
  const trade = numericTrade(rawTrade);
  const entryTime = trade.entryTime + executionDelayMs;
  const endTime = endTimeFor(trade, entryTime);
  const signalIndex = prepared.indexByTime.get(trade.signalTime);
  const initialAtr = signalIndex == null ? null : prepared.atr[signalIndex];
  if (!(initialAtr > 0)) throw new Error(`missing ATR for ${trade.symbol} at ${trade.signalTime}`);
  const bars = fiveMinuteBars.filter(bar => bar.openTime >= entryTime && bar.openTime <= endTime);
  const entryBar = bars.find(bar => bar.openTime === entryTime);
  if (!entryBar) throw new Error(`missing executable 5m entry bar for ${trade.symbol} at ${entryTime}`);
  const entryPrice = entryBar.o, qty = trade.notional / entryPrice;
  const position = { side: trade.side, stop: entryPrice - trade.side * STOP_ATR * initialAtr, best: entryPrice };
  const cost = costForLayer(trade.layer, 'stress');
  const entryFee = qty * entryPrice * cost / 2;
  let fundingPnl = 0, intervalStart = null, intervalHigh = -Infinity, intervalLow = Infinity;

  const close = (price, exitTime, reason) => {
    const grossPnl = trade.side * qty * (price - entryPrice), exitFee = qty * price * cost / 2;
    return {
      ...trade,
      entryTime,
      entryPrice,
      exitTime,
      exitPrice: price,
      qty,
      notional: qty * entryPrice,
      grossPnl,
      fees: entryFee + exitFee,
      fundingPnl,
      netPnl: grossPnl - entryFee - exitFee + fundingPnl,
      reason,
      barsHeld: (exitTime - entryTime) / FOUR_HOUR_MS
    };
  };

  for (const bar of bars) {
    if (trade.reason !== 'period_end' && bar.openTime >= endTime) return close(bar.o, bar.openTime, 'time');
    if (bar.openTime > entryTime) {
      const rate = prepared.fundingMap.get(bar.openTime);
      if (Number.isFinite(rate)) fundingPnl += -trade.side * qty * bar.o * rate;
    }
    const fill = stopFill(position, bar);
    if (fill != null) return close(fill, bar.openTime, 'stop');

    const currentInterval = Math.floor(bar.openTime / FOUR_HOUR_MS) * FOUR_HOUR_MS;
    if (currentInterval !== intervalStart) {
      intervalStart = currentInterval;
      intervalHigh = -Infinity;
      intervalLow = Infinity;
    }
    intervalHigh = Math.max(intervalHigh, bar.h);
    intervalLow = Math.min(intervalLow, bar.l);
    if (bar.openTime + FIVE_MINUTES === currentInterval + FOUR_HOUR_MS) {
      const intervalIndex = prepared.indexByTime.get(currentInterval), currentAtr = prepared.atr[intervalIndex];
      if (currentAtr > 0) {
        if (trade.side === 1) {
          position.best = Math.max(position.best, intervalHigh);
          position.stop = Math.max(position.stop, position.best - TRAIL_ATR * currentAtr);
        } else {
          position.best = Math.min(position.best, intervalLow);
          position.stop = Math.min(position.stop, position.best + TRAIL_ATR * currentAtr);
        }
      }
    }
    if (trade.reason === 'period_end' && bar.openTime + FIVE_MINUTES === endTime) return close(bar.c, endTime, 'period_end');
  }
  throw new Error(`insufficient 5m path for ${trade.symbol} through ${endTime}`);
}

function summary(trades) {
  const wins = trades.filter(trade => trade.netPnl > 0), losses = trades.filter(trade => trade.netPnl < 0);
  const sum = rows => rows.reduce((total, row) => total + row.netPnl, 0);
  const netPnl = sum(trades);
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    netPnl,
    replayReturnOnInitialEquity: netPnl / INITIAL_EQUITY,
    fees: trades.reduce((total, trade) => total + trade.fees, 0),
    fundingPnl: trades.reduce((total, trade) => total + trade.fundingPnl, 0)
  };
}

function loadPrepared(symbol) {
  const barsFile = path.join(DATA_ROOT, `${symbol}_4h.csv`), fundingFile = path.join(DATA_ROOT, `${symbol}_funding.csv`);
  if (!fs.existsSync(barsFile) || !fs.existsSync(fundingFile)) throw new Error(`missing frozen 4h history for ${symbol}`);
  return prepareSymbol({ symbol, baseAsset: symbol.replace(/(USDT|USDC)$/, ''), market: 'um', bars: parseBars(barsFile), funding: parseFunding(fundingFile) });
}

function sampleRows(rows, limit) {
  if (limit >= rows.length) return rows;
  const ordered = rows.slice().sort((a, b) => Number(a.entryTime) - Number(b.entryTime) || a.symbol.localeCompare(b.symbol));
  return Array.from({ length: limit }, (_, index) => ordered[Math.floor((index + 0.5) * ordered.length / limit)]);
}

function run(options = {}) {
  const input = parseCsv(options.tradeFile ?? TRADE_FILE).map(numericTrade);
  const chosen = options.full ? input : sampleRows(input, options.limit ?? 30);
  const prefetched = options.prefetch === false ? { requested: 0, error: null } : prefetchArchives(chosen);
  const store = createFiveMinuteStore(options);
  const prepared = new Map(), ideal = [], executable = [], failures = [];
  for (const trade of chosen) {
    try {
      if (!prepared.has(trade.symbol)) prepared.set(trade.symbol, loadPrepared(trade.symbol));
      const symbolPrepared = prepared.get(trade.symbol);
      const start = trade.entryTime, end = Math.max(dataEndTimeFor(trade, trade.entryTime), dataEndTimeFor(trade, trade.entryTime + EXECUTION_DELAY_MS));
      const bars = store.bars(trade.symbol, start, end);
      const idealTrade = simulateExecutableTrade({ trade, prepared: symbolPrepared, fiveMinuteBars: bars, executionDelayMs: 0 });
      const executableTrade = simulateExecutableTrade({ trade, prepared: symbolPrepared, fiveMinuteBars: bars, executionDelayMs: EXECUTION_DELAY_MS });
      ideal.push(idealTrade);
      executable.push({ ...executableTrade, originalNetPnl: trade.netPnl, idealFiveMinuteNetPnl: idealTrade.netPnl, executionDelayNetPnlDelta: executableTrade.netPnl - idealTrade.netPnl });
    } catch (error) {
      failures.push({ symbol: trade.symbol, signalTime: trade.signalTime, error: error.message });
    }
  }
  const baseline = summary(chosen), idealSummary = summary(ideal), executableSummary = summary(executable);
  const complete = failures.length === 0 && executable.length === chosen.length;
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v12.8-executable-entry-parity',
    evidenceStatus: options.full ? 'historical_replay_fixed_v11_signal_ledger' : 'stratified_sample_only',
    frozenSource: path.relative(ROOT, options.tradeFile ?? TRADE_FILE).replaceAll('\\', '/'),
    design: {
      signal: 'V11 frozen 4h close signal ledger; no parameter or candidate selection changes',
      entry: 'first 5m open after a 5m scan delay from the 4h signal close',
      exits: '5m stop path; trailing stop updates only after each completed 4h interval',
      costs: 'V11 stress round-trip cost retained by liquidity layer',
      allocation: 'original V11 executed notional is held fixed trade by trade; this isolates execution timing and path effects'
    },
    coverage: { requestedTrades: chosen.length, idealFiveMinuteTrades: ideal.length, executableFiveMinuteTrades: executable.length, complete, prefetchedArchives: prefetched.requested, prefetchError: prefetched.error, downloadedArchives: store.downloadedArchives(), failures },
    baselineFourHour: baseline,
    idealEntryFiveMinute: idealSummary,
    executableEntryFiveMinute: executableSummary,
    changeVsBaselineFourHour: { netPnl: executableSummary.netPnl - baseline.netPnl, profitFactor: executableSummary.profitFactor - baseline.profitFactor },
    changeVsIdealFiveMinute: { netPnl: executableSummary.netPnl - idealSummary.netPnl, profitFactor: executableSummary.profitFactor - idealSummary.profitFactor },
    historicalExecutionGate: {
      pass: complete && executableSummary.netPnl > 0 && executableSummary.profitFactor >= 1.15,
      requirements: ['100% frozen ledger 5m coverage', 'positive replay PnL', 'profit factor >= 1.15'],
      notSufficientForLive: true
    },
    caveats: [
      'This is an execution-parity replay of the frozen V11 selected ledger, not a new fitted strategy or an independent out-of-sample test.',
      'Original V11 allocation is held fixed, so changes to position-capacity selection caused by altered exit times are not re-optimized here.',
      'Passing this replay does not establish tradable profitability; any rule change requires a new forward-validation clock.'
    ]
  };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const suffix = options.full ? 'full' : `sample_${chosen.length}`;
  fs.writeFileSync(path.join(OUTPUT_DIR, `binance_all_perpetuals_v128_execution_${suffix}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, `binance_all_perpetuals_v128_execution_${suffix}_trades.csv`), csv(executable, [
    'symbol', 'layer', 'side', 'signalTime', 'entryTime', 'exitTime', 'entryPrice', 'exitPrice', 'notional', 'grossPnl', 'fees', 'fundingPnl', 'netPnl', 'originalNetPnl', 'idealFiveMinuteNetPnl', 'executionDelayNetPnlDelta', 'reason', 'barsHeld'
  ]));
  return result;
}

function cli() {
  const args = new Set(process.argv.slice(2));
  const limitArg = [...args].find(value => value.startsWith('--limit='));
  const result = run({ full: args.has('--full'), limit: limitArg ? Number(limitArg.slice(8)) : undefined });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) cli();

module.exports = { EXECUTION_DELAY_MS, FIVE_MINUTES, simulateExecutableTrade, summary, run };
