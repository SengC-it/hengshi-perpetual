const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_PATH = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_results.json');
const SIGNALS_PATH = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_signals.csv');
const TRADES_PATH = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_trades.csv');
const EQUITY_PATH = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_equity.csv');
const VALIDATION_PATH = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_validation.json');
const START = Date.parse('2022-01-01T00:00:00Z');
const END = Date.parse('2026-06-30T20:00:00Z');

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value])));
}

function close(a, b, tolerance = 1e-8) {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validate() {
  const result = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
  const signals = parseCsv(SIGNALS_PATH);
  const trades = parseCsv(TRADES_PATH);
  const equity = parseCsv(EQUITY_PATH);
  const pnl = trades.map(row => Number(row.netPnl));
  const gains = pnl.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -pnl.filter(value => value < 0).reduce((sum, value) => sum + value, 0);
  const netPnl = pnl.reduce((sum, value) => sum + value, 0);
  const fees = trades.reduce((sum, row) => sum + Number(row.fees), 0);
  const funding = trades.reduce((sum, row) => sum + Number(row.fundingPnl), 0);
  let peak = 100000;
  let maxDrawdown = 0;
  for (const row of equity) {
    const value = Number(row.equity);
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
  }
  const tradeKeys = new Map();
  for (const row of trades) {
    const key = `${row.symbol}|${row.entryTime}|${row.side}`;
    tradeKeys.set(key, (tradeKeys.get(key) || 0) + 1);
  }
  let matchedSignals = 0;
  for (const row of signals) {
    const key = `${row.symbol}|${row.entryTime}|${row.side}`;
    const remaining = tradeKeys.get(key) || 0;
    if (remaining > 0) {
      matchedSignals += 1;
      tradeKeys.set(key, remaining - 1);
    }
  }
  const unmatchedTrades = [...tradeKeys.values()].reduce((sum, value) => sum + value, 0);
  const recomputed = {
    trades: trades.length,
    signals: signals.length,
    matchedSignals,
    unmatchedSignals: signals.length - matchedSignals,
    unmatchedTrades,
    netPnl,
    totalReturn: netPnl / 100000,
    profitFactor: gains / losses,
    maxDrawdown,
    fees,
    funding,
    signalsPerDay: signals.length / ((END - START) / 86400000 + 1)
  };
  const checks = {
    resultEvidenceLabelPresent: result.evidenceStatus === 'rolling_walk_forward_research_only_history_previously_exposed',
    tradeCountMatches: recomputed.trades === result.stress.trades,
    signalCountMatches: recomputed.signals === result.stress.finalSignals,
    completeSignalCoverage: recomputed.unmatchedSignals === 0 && recomputed.unmatchedTrades === 0,
    netPnlMatches: close(recomputed.netPnl, result.stress.netPnl),
    returnMatches: close(recomputed.totalReturn, result.stress.totalReturn),
    profitFactorMatches: close(recomputed.profitFactor, result.stress.profitFactor),
    maxDrawdownMatches: close(recomputed.maxDrawdown, result.stress.maxDrawdown),
    feesMatch: close(recomputed.fees, result.stress.fees),
    fundingMatches: close(recomputed.funding, result.stress.funding),
    frequencyMatches: close(recomputed.signalsPerDay, result.stress.signalsPerDay),
    gateIsRejected: result.acceptance.gate.pass === false
  };
  const validation = {
    generatedAt: new Date().toISOString(),
    independentFromBacktestSummary: true,
    pass: Object.values(checks).every(Boolean),
    checks,
    recomputedStress: recomputed,
    reportedStress: result.stress,
    hashes: {
      results: sha256(RESULT_PATH),
      signals: sha256(SIGNALS_PATH),
      trades: sha256(TRADES_PATH),
      equity: sha256(EQUITY_PATH)
    }
  };
  fs.writeFileSync(VALIDATION_PATH, JSON.stringify(validation, null, 2));
  return { validationPath: VALIDATION_PATH, pass: validation.pass, checks, recomputed, hash: sha256(VALIDATION_PATH) };
}

if (require.main === module) {
  try { console.log(JSON.stringify(validate(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { parseCsv, validate };
