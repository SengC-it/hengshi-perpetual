const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { FEATURE_SET, SETTINGS } = require('./v92_run');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v10_capacity_research.json');

const VARIANTS = [
  { id: 'q825_cap2', quantile: 0.825, maxPerBar: 2, maxPerDay: 2, maxPositions: 6 },
  { id: 'q825_cap3', quantile: 0.825, maxPerBar: 3, maxPerDay: 3, maxPositions: 8 },
  { id: 'q850_cap2', quantile: 0.850, maxPerBar: 2, maxPerDay: 2, maxPositions: 6 },
  { id: 'q850_cap3', quantile: 0.850, maxPerBar: 3, maxPerDay: 3, maxPositions: 8 },
  { id: 'q875_cap3', quantile: 0.875, maxPerBar: 3, maxPerDay: 3, maxPositions: 8 },
  { id: 'q900_cap3', quantile: 0.900, maxPerBar: 3, maxPerDay: 3, maxPositions: 8 }
];

function compactSummary(run, acceptance) {
  return {
    trades: run.summary.trades,
    winRate: run.summary.winRate,
    profitFactor: run.summary.profitFactor,
    totalReturn: run.summary.totalReturn,
    maxDrawdown: run.summary.maxDrawdown,
    netPnl: run.summary.netPnl,
    fees: run.summary.fees,
    profitableSymbols: run.summary.profitableSymbols,
    maxSymbolContribution: run.summary.maxSymbolContribution,
    profitableLayers: run.summary.profitableLayers,
    byLayer: run.summary.byLayer,
    modelCandidates: run.summary.modelCandidates,
    operationalSignalsPerDay: acceptance.operationalSignalsPerDay,
    positiveQuarterShare: acceptance.positiveQuarterShare,
    lastFourQuarterReturn: acceptance.lastFourQuarterReturn,
    profitWithoutBest10: acceptance.profitWithoutBest10,
    bootstrapProbabilityPositive: acceptance.bootstrap.probabilityPositive,
    bootstrapInterval95: acceptance.bootstrap.interval95,
    gate: acceptance.gate
  };
}

function tradeKey(trade) {
  return `${trade.market}:${trade.symbol}:${trade.signalTime}:${trade.side}`;
}

function compareTrades(candidate, baseline) {
  const baselineKeys = new Set(baseline.trades.map(tradeKey));
  const candidateKeys = new Set(candidate.trades.map(tradeKey));
  const added = candidate.trades.filter(trade => !baselineKeys.has(tradeKey(trade)));
  const removed = baseline.trades.filter(trade => !candidateKeys.has(tradeKey(trade)));
  const sum = rows => rows.reduce((total, row) => total + row.netPnl, 0);
  return {
    retainedTrades: candidate.trades.filter(trade => baselineKeys.has(tradeKey(trade))).length,
    addedTrades: added.length,
    addedTradeNetPnl: sum(added),
    addedTradeWinRate: added.length ? added.filter(trade => trade.netPnl > 0).length / added.length : 0,
    removedTrades: removed.length,
    removedTradeNetPnl: sum(removed)
  };
}

function runAll() {
  const { prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const rows = [];
  const fullRuns = new Map();

  for (const variant of VARIANTS) {
    console.error(`V10 capacity research ${variant.id}`);
    const plans = buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      featureNames: FEATURE_SET,
      trainingScoreQuantile: variant.quantile
    });
    const portfolio = {
      maxPerBar: variant.maxPerBar,
      maxPerDay: variant.maxPerDay,
      maxPositions: variant.maxPositions
    };
    const stress = runScenario(prepared, plans, 'stress', portfolio);
    const extreme = runScenario(prepared, plans, 'extreme', portfolio);
    const acceptance = diagnostics(stress, extreme, plans);
    fullRuns.set(variant.id, stress);
    rows.push({
      ...variant,
      stress: compactSummary(stress, acceptance),
      extreme: {
        trades: extreme.summary.trades,
        winRate: extreme.summary.winRate,
        profitFactor: extreme.summary.profitFactor,
        totalReturn: extreme.summary.totalReturn,
        maxDrawdown: extreme.summary.maxDrawdown,
        netPnl: extreme.summary.netPnl,
        fees: extreme.summary.fees,
        byLayer: extreme.summary.byLayer
      }
    });
  }

  const baseline = rows.find(row => row.id === 'q825_cap2');
  for (const row of rows) {
    row.versusV92 = {
      stressReturnDelta: row.stress.totalReturn - baseline.stress.totalReturn,
      extremeReturnDelta: row.extreme.totalReturn - baseline.extreme.totalReturn,
      frequencyDelta: row.stress.operationalSignalsPerDay - baseline.stress.operationalSignalsPerDay,
      tradeDelta: row.stress.trades - baseline.stress.trades,
      strictlySuperior: row.id !== baseline.id
        && row.stress.gate.pass
        && row.stress.totalReturn > baseline.stress.totalReturn
        && row.extreme.totalReturn > baseline.extreme.totalReturn
        && row.stress.operationalSignalsPerDay > baseline.stress.operationalSignalsPerDay
    };
    row.tradeChanges = compareTrades(fullRuns.get(row.id), fullRuns.get(baseline.id));
  }

  const superior = rows.filter(row => row.versusV92.strictlySuperior)
    .sort((a, b) => b.stress.totalReturn - a.stress.totalReturn
      || b.stress.operationalSignalsPerDay - a.stress.operationalSignalsPerDay);
  const result = {
    generatedAt: new Date().toISOString(),
    purpose: 'bounded structural test of whether higher score thresholds plus greater portfolio capacity can improve both frequency and profitability versus V9.2',
    featureSet: FEATURE_SET,
    commonSettings: SETTINGS,
    variants: rows,
    bestStrictlySuperior: superior[0]?.id ?? null,
    researchStatus: superior.length ? 'SUPERIOR_HISTORICAL_CANDIDATE_FOUND' : 'NO_STRICTLY_SUPERIOR_CANDIDATE',
    caveat: 'All variants use previously exposed historical data and remain research-only until a newly frozen candidate passes independent forward validation.'
  };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runAll(), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { VARIANTS, runAll };
