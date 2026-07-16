const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'outputs');
const files = {
  result: path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_results.json'),
  signals: path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_signals.csv'),
  trades: path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_trades.csv'),
  pairs: path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_pairs.csv'),
  equity: path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_equity.csv'),
  validation: path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_validation.json')
};
const START = Date.parse('2022-01-01T00:00:00Z'), END = Date.parse('2026-06-30T20:00:00Z');

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/), headers = lines.shift().split(',');
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value])));
}

function close(a, b, tolerance = 1e-8) {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function validate() {
  const result = JSON.parse(fs.readFileSync(files.result, 'utf8'));
  const signals = parseCsv(files.signals), trades = parseCsv(files.trades), pairs = parseCsv(files.pairs), equity = parseCsv(files.equity);
  const pairPnl = pairs.map(row => Number(row.netPnl)), gains = pairPnl.filter(value => value > 0).reduce((a, b) => a + b, 0), losses = -pairPnl.filter(value => value < 0).reduce((a, b) => a + b, 0);
  const netPnl = pairPnl.reduce((a, b) => a + b, 0), gross = pairs.reduce((a, row) => a + Number(row.grossPnl), 0), fees = pairs.reduce((a, row) => a + Number(row.fees), 0), funding = pairs.reduce((a, row) => a + Number(row.fundingPnl), 0);
  let peak = 100000, maxDrawdown = 0;
  for (const row of equity) { const value = Number(row.equity); peak = Math.max(peak, value); maxDrawdown = Math.min(maxDrawdown, value / peak - 1); }
  const tradeKeys = new Map();
  for (const row of trades) { const key = `${row.symbol}|${row.entryTime}|${row.side}`; tradeKeys.set(key, (tradeKeys.get(key) || 0) + 1); }
  let matchedSignals = 0;
  for (const row of signals) {
    const key = `${row.symbol}|${row.entryTime}|${row.side}`, remaining = tradeKeys.get(key) || 0;
    if (remaining > 0) { matchedSignals++; tradeKeys.set(key, remaining - 1); }
  }
  const sorted = pairPnl.slice().sort((a, b) => b - a);
  const recomputed = {
    signals: signals.length,
    trades: trades.length,
    pairs: pairs.length,
    matchedSignals,
    unmatchedSignals: signals.length - matchedSignals,
    unmatchedTrades: [...tradeKeys.values()].reduce((a, b) => a + b, 0),
    grossPnl: gross,
    fees,
    funding,
    netPnl,
    totalReturn: netPnl / 100000,
    pairProfitFactor: gains / losses,
    maxDrawdown,
    profitWithoutBest10Pairs: sorted.slice(10).reduce((a, b) => a + b, 0),
    signalsPerDay: signals.length / ((END - START) / 86400000 + 1)
  };
  const checks = {
    evidenceLabelPresent: result.evidenceStatus === 'rolling_walk_forward_research_only_history_previously_exposed',
    signalCountMatches: recomputed.signals === result.stress.finalSignals,
    tradeCountMatches: recomputed.trades === result.stress.trades,
    pairCountMatches: recomputed.pairs === result.stress.pairs,
    completeSignalCoverage: recomputed.unmatchedSignals === 0 && recomputed.unmatchedTrades === 0,
    netPnlMatches: close(recomputed.netPnl, result.stress.netPnl),
    returnMatches: close(recomputed.totalReturn, result.stress.totalReturn),
    pairProfitFactorMatches: close(recomputed.pairProfitFactor, result.stress.pairProfitFactor),
    drawdownMatches: close(recomputed.maxDrawdown, result.stress.maxDrawdown),
    feesMatch: close(recomputed.fees, result.stress.fees),
    fundingMatches: close(recomputed.funding, result.stress.funding),
    bestTenCheckMatches: close(recomputed.profitWithoutBest10Pairs, result.acceptance.profitWithoutBest10),
    frequencyMatches: close(recomputed.signalsPerDay, result.stress.signalsPerDay),
    strategyRejected: result.acceptance.gate.pass === false
  };
  const validation = { generatedAt: new Date().toISOString(), independentFromBacktestSummary: true, pass: Object.values(checks).every(Boolean), checks, recomputedStress: recomputed, reportedStress: result.stress, hashes: Object.fromEntries(Object.entries(files).filter(([key]) => key !== 'validation').map(([key, file]) => [key, hash(file)])) };
  fs.writeFileSync(files.validation, JSON.stringify(validation, null, 2));
  return { validationFile: files.validation, pass: validation.pass, checks, recomputed, sha256: hash(files.validation) };
}

if (require.main === module) {
  try { console.log(JSON.stringify(validate(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { parseCsv, validate };
