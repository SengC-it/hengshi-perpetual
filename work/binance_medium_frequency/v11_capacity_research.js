const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { FEATURE_SET, SETTINGS } = require('./v92_run');
const { mergePlans } = require('./v10_layer_research');
const { QUANTILE_BY_LAYER } = require('./v10_run');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v11_capacity_research.json');
const V10 = {
  stressReturn: 0.16996588122723733,
  extremeReturn: 0.1311997740920181,
  operationalSignalsPerDay: 0.6144468149954282
};

const VARIANTS = [
  { id: 'v10_b3_d3_p8', maxPerBar: 3, maxPerDay: 3, maxPositions: 8 },
  { id: 'b3_d3_p10', maxPerBar: 3, maxPerDay: 3, maxPositions: 10 },
  { id: 'b3_d3_p12', maxPerBar: 3, maxPerDay: 3, maxPositions: 12 },
  { id: 'b3_d4_p10', maxPerBar: 3, maxPerDay: 4, maxPositions: 10 },
  { id: 'b4_d3_p10', maxPerBar: 4, maxPerDay: 3, maxPositions: 10 },
  { id: 'b4_d4_p8', maxPerBar: 4, maxPerDay: 4, maxPositions: 8 },
  { id: 'b4_d4_p9', maxPerBar: 4, maxPerDay: 4, maxPositions: 9 },
  { id: 'b4_d4_p10', maxPerBar: 4, maxPerDay: 4, maxPositions: 10 },
  { id: 'b4_d4_p11', maxPerBar: 4, maxPerDay: 4, maxPositions: 11 },
  { id: 'b4_d4_p12', maxPerBar: 4, maxPerDay: 4, maxPositions: 12 }
];

function tradeKey(trade) {
  return `${trade.market}:${trade.symbol}:${trade.signalTime}:${trade.side}`;
}

function sum(rows) {
  return rows.reduce((total, row) => total + row.netPnl, 0);
}

function compareTrades(candidate, baseline) {
  const baselineKeys = new Set(baseline.trades.map(tradeKey));
  const candidateKeys = new Set(candidate.trades.map(tradeKey));
  const added = candidate.trades.filter(trade => !baselineKeys.has(tradeKey(trade)));
  const removed = baseline.trades.filter(trade => !candidateKeys.has(tradeKey(trade)));
  return {
    retainedTrades: candidate.trades.filter(trade => baselineKeys.has(tradeKey(trade))).length,
    addedTrades: added.length,
    addedTradeNetPnl: sum(added),
    addedTradeWinRate: added.length ? added.filter(trade => trade.netPnl > 0).length / added.length : 0,
    removedTrades: removed.length,
    removedTradeNetPnl: sum(removed)
  };
}

function countDistribution(values) {
  return values.reduce((result, value) => {
    result[value] = (result[value] || 0) + 1;
    return result;
  }, {});
}

function capacityAudit(run) {
  const daily = new Map(), bars = new Map();
  for (const event of run.finalSignals) {
    const day = new Date(event.signalTime).toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + 1);
    bars.set(event.signalTime, (bars.get(event.signalTime) || 0) + 1);
  }
  return {
    activeSignalDays: daily.size,
    dailyDistribution: countDistribution([...daily.values()]),
    barDistribution: countDistribution([...bars.values()]),
    maxObservedPositions: Math.max(0, ...run.equity.map(row => row.positions)),
    maxObservedGrossExposure: Math.max(0, ...run.equity.map(row => row.grossExposure))
  };
}

function compact(run, acceptance) {
  return {
    trades: run.summary.trades,
    finalSignals: run.summary.finalSignals,
    executedSignals: run.summary.executedSignals,
    winRate: run.summary.winRate,
    profitFactor: run.summary.profitFactor,
    totalReturn: run.summary.totalReturn,
    maxDrawdown: run.summary.maxDrawdown,
    netPnl: run.summary.netPnl,
    fees: run.summary.fees,
    byLayer: run.summary.byLayer,
    operationalSignalsPerDay: acceptance.operationalSignalsPerDay,
    positiveQuarterShare: acceptance.positiveQuarterShare,
    lastFourQuarterReturn: acceptance.lastFourQuarterReturn,
    profitWithoutBest10: acceptance.profitWithoutBest10,
    bootstrapProbabilityPositive: acceptance.bootstrap.probabilityPositive,
    bootstrapInterval95: acceptance.bootstrap.interval95,
    activeQuarterReturns: run.quarters.filter(quarter => quarter.trades > 0).map(quarter => ({
      startTime: quarter.startTime,
      trades: quarter.trades,
      totalReturn: quarter.totalReturn
    })),
    gate: acceptance.gate,
    capacity: capacityAudit(run)
  };
}

function runAll(variants = VARIANTS, outputFile = OUTPUT_FILE) {
  const { prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const plans85 = buildWalkForwardPlans(prepared, labeled.rows, {
    ...SETTINGS,
    featureNames: FEATURE_SET,
    trainingScoreQuantile: 0.850
  });
  const plans875 = buildWalkForwardPlans(prepared, labeled.rows, {
    ...SETTINGS,
    featureNames: FEATURE_SET,
    trainingScoreQuantile: 0.875
  });
  const plans = mergePlans(new Map([[0.850, plans85], [0.875, plans875]]), QUANTILE_BY_LAYER);
  const fullRuns = new Map(), results = [];

  for (const variant of variants) {
    console.error(`V11 capacity research ${variant.id}`);
    const stress = runScenario(prepared, plans, 'stress', variant);
    const extreme = runScenario(prepared, plans, 'extreme', variant);
    const acceptance = diagnostics(stress, extreme, plans);
    fullRuns.set(variant.id, stress);
    const row = {
      ...variant,
      stress: compact(stress, acceptance),
      extreme: {
        trades: extreme.summary.trades,
        finalSignals: extreme.summary.finalSignals,
        executedSignals: extreme.summary.executedSignals,
        winRate: extreme.summary.winRate,
        profitFactor: extreme.summary.profitFactor,
        totalReturn: extreme.summary.totalReturn,
        maxDrawdown: extreme.summary.maxDrawdown,
        netPnl: extreme.summary.netPnl,
        fees: extreme.summary.fees,
        byLayer: extreme.summary.byLayer
      }
    };
    row.versusV10 = {
      stressReturnDelta: row.stress.totalReturn - V10.stressReturn,
      extremeReturnDelta: row.extreme.totalReturn - V10.extremeReturn,
      frequencyDelta: row.stress.operationalSignalsPerDay - V10.operationalSignalsPerDay,
      strictlySuperior: row.id !== 'v10_b3_d3_p8'
        && row.stress.gate.pass
        && row.stress.totalReturn > V10.stressReturn
        && row.extreme.totalReturn > V10.extremeReturn
        && row.stress.operationalSignalsPerDay > V10.operationalSignalsPerDay
    };
    results.push(row);
  }

  const baseline = fullRuns.get('v10_b3_d3_p8');
  for (const row of results) row.tradeChanges = compareTrades(fullRuns.get(row.id), baseline);
  const superior = results.filter(row => row.versusV10.strictlySuperior)
    .sort((a, b) => b.stress.totalReturn - a.stress.totalReturn
      || b.extreme.totalReturn - a.extreme.totalReturn
      || b.stress.operationalSignalsPerDay - a.stress.operationalSignalsPerDay);
  const result = {
    generatedAt: new Date().toISOString(),
    purpose: 'bounded same-risk capacity frontier above frozen V10 thresholds',
    fixedRisk: { riskPerTrade: 0.0025, maxGross: 1.5 },
    variants: results,
    bestStrictlySuperior: superior[0]?.id ?? null,
    researchStatus: superior.length ? 'SUPERIOR_HISTORICAL_CANDIDATE_FOUND' : 'NO_STRICTLY_SUPERIOR_CANDIDATE',
    caveat: 'All capacity choices use previously exposed history and require a new independent forward clock if adopted.'
  };
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
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
