const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { costForLayer } = require('./v41_portfolio');
const { simulateBreakoutPeriod } = require('./v5d_breakout');
const {
  buildLayerMaps,
  buildLabeledRows,
  buildWalkForwardPlans,
  runScenario,
  utcQuarterStart
} = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { clip } = require('./v7_ml');
const { SETTINGS } = require('./v92_run');
const {
  SIMULATION_PORTFOLIO,
  v11ShortPlans,
  compactRun,
  longSleeveRobust,
  assertV11Baseline
} = require('./v12_long_short_research');
const { scanReversalLongEvents } = require('./v123_reversal_long_research');
const {
  BASE_EXIT,
  BASE_REGIME,
  regimeClassifier
} = require('./v125_reversal_robustness');
const { leaveOneOutAudit } = require('./v126_predeclared_candidate_comparison');
const { strictlyBetter } = require('./v13_capacity_diversification');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const V124_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v124_reversal_capacity_research.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v14_causal_reversal_selector.json');
const FEATURE_NAMES = [
  'reversalScore',
  'shockRatio',
  'logVolumeRatio',
  'trendGap',
  'distanceToEma20',
  'emaGap',
  'btcReturn30',
  'btcEmaGap',
  'layerLiquid',
  'layerHighVol'
];
const SCORE_QUANTILES = [0.300, 0.500, 0.700, 0.800, 0.900];
const ELIGIBLE_LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol'];

function benchmarkV124() {
  const result = JSON.parse(fs.readFileSync(V124_FILE, 'utf8'));
  const row = result.variants.find(item => item.id === 'replace_rapid_reversal_eligible3_q300');
  if (!row) throw new Error('V12.4 benchmark is missing');
  return row;
}

function stopPrice(bar, stop) {
  if (bar.o <= stop) return bar.o;
  if (bar.l <= stop) return stop;
  return null;
}

function simulateLongEventReturn(item, event, layer, scenario = 'stress') {
  const entryIndex = item.indexByTime.get(event.entryTime);
  if (entryIndex == null || entryIndex < 1) return null;
  const initialAtr = item.atr[entryIndex - 1];
  const entryBar = item.bars[entryIndex];
  if (!(initialAtr > 0) || !(entryBar.o > 0)) return null;
  const entryPrice = entryBar.o;
  const stop = entryPrice - BASE_EXIT.stopAtr * initialAtr;
  let exitPrice = stopPrice(entryBar, stop);
  let exitTime = entryBar.openTime;
  let reason = exitPrice == null ? null : 'stop';
  let fundingReturn = 0;
  let exitNextOpen = false;

  for (let index = entryIndex + 1; reason == null && index < item.bars.length; index++) {
    const bar = item.bars[index];
    const rate = item.fundingMap.get(bar.openTime);
    if (Number.isFinite(rate)) fundingReturn -= bar.o * rate / entryPrice;
    if (exitNextOpen) {
      exitPrice = bar.o;
      exitTime = bar.openTime;
      reason = 'mean';
      break;
    }
    if (index - entryIndex >= BASE_EXIT.maxHoldBars) {
      exitPrice = bar.o;
      exitTime = bar.openTime;
      reason = 'time';
      break;
    }
    const fill = stopPrice(bar, stop);
    if (fill != null) {
      exitPrice = fill;
      exitTime = bar.openTime;
      reason = 'stop';
      break;
    }
    if (BASE_EXIT.meanExitEma20 && bar.c >= item.ema20[index]) exitNextOpen = true;
  }
  if (reason == null || !(exitPrice > 0)) return null;
  const cost = costForLayer(layer, scenario);
  const grossReturn = exitPrice / entryPrice - 1;
  const feeReturn = cost / 2 * (1 + exitPrice / entryPrice);
  const netReturn = grossReturn + fundingReturn - feeReturn;
  const riskReturn = BASE_EXIT.stopAtr * initialAtr / entryPrice;
  return {
    entryPrice,
    exitPrice,
    exitTime,
    reason,
    grossReturn,
    fundingReturn,
    feeReturn,
    netReturn,
    riskReturn,
    target: clip(netReturn / riskReturn, -3, 5)
  };
}

function featureVector(item, event, layer, btc) {
  const index = item.indexByTime.get(event.signalTime);
  const btcIndex = btc.indexByTime.get(event.signalTime);
  if (index == null || btcIndex == null || index < 50 || btcIndex < 180) return null;
  const bar = item.bars[index];
  const atr = item.atr[index];
  const volumeMedian = item.volumeMedian20[index];
  if (!(atr > 0) || !(volumeMedian > 0)) return null;
  const change = bar.c / item.bars[index - 6].c - 1;
  const threshold = 2.5 * atr / bar.c;
  return {
    reversalScore: clip(event.score, 0, 10),
    shockRatio: clip(-change / threshold, 0, 10),
    logVolumeRatio: clip(Math.log(bar.qv / volumeMedian), 0, 5),
    trendGap: clip(Math.abs(item.ema20[index] / item.ema50[index] - 1), 0, 0.25),
    distanceToEma20: clip(bar.c / item.ema20[index] - 1, -0.25, 0.25),
    emaGap: clip(item.ema20[index] / item.ema50[index] - 1, -0.25, 0.25),
    btcReturn30: clip(btc.bars[btcIndex].c / btc.bars[btcIndex - 180].c - 1, -0.75, 2),
    btcEmaGap: clip(btc.ema20[btcIndex] / btc.ema50[btcIndex] - 1, -0.25, 0.25),
    layerLiquid: String(layer).startsWith('liquid_') ? 1 : 0,
    layerHighVol: String(layer).endsWith('high_vol') ? 1 : 0
  };
}

function buildReversalLabels(prepared, rawEvents, inRegime) {
  const byKey = new Map(prepared.map(item => [`${item.market}:${item.symbol}`, item]));
  const btc = byKey.get('um:BTCUSDT');
  const layerMaps = buildLayerMaps(prepared, rawEvents);
  const rows = [];
  for (const event of rawEvents) {
    if (!inRegime(event.signalTime)) continue;
    const item = byKey.get(`${event.market}:${event.symbol}`);
    const layer = layerMaps.get(utcQuarterStart(event.signalTime))?.get(event.symbol);
    if (!item || !layer || layer === 'insufficient_history') continue;
    const features = featureVector(item, event, layer, btc);
    const outcome = simulateLongEventReturn(item, event, layer, 'stress');
    if (!features || !outcome) continue;
    rows.push({
      signalTime: event.signalTime,
      exitTime: outcome.exitTime,
      layer,
      features,
      target: outcome.target,
      outcome,
      event: { ...event, exit: BASE_EXIT }
    });
  }
  return rows;
}

function validateLabelParity(prepared, row) {
  const item = prepared.find(value => value.market === row.event.market && value.symbol === row.event.symbol);
  const selections = {
    liquid_low_vol: { configId: 'ml' },
    liquid_high_vol: { configId: 'ml' },
    tail_low_vol: { configId: 'ml' },
    tail_high_vol: { configId: 'ml' }
  };
  const run = simulateBreakoutPeriod({
    preparedSymbols: [item],
    events: [row.event],
    layers: new Map([[row.event.symbol, row.layer]]),
    selections,
    startTime: row.event.signalTime,
    endTime: row.outcome.exitTime,
    scenario: 'stress',
    initialEquity: 100000,
    maxPerBar: 1,
    maxPerDay: 1,
    maxPositions: 1
  });
  const trade = run.trades[0];
  if (!trade) throw new Error('V14 label parity produced no trade');
  const simulatedReturn = trade.netPnl / trade.notional;
  if (Math.abs(simulatedReturn - row.outcome.netReturn) > 1e-12
    || trade.exitTime !== row.outcome.exitTime
    || trade.reason !== row.outcome.reason) {
    throw new Error('V14 causal label does not match the portfolio simulator');
  }
  return {
    event: `${row.event.market}:${row.event.symbol}:${row.event.signalTime}`,
    netReturn: row.outcome.netReturn,
    exitTime: row.outcome.exitTime,
    reason: row.outcome.reason
  };
}

function combinePlans(shortPlans, longPlans, inRegime) {
  return shortPlans.map((shortPlan, index) => {
    const events = new Map();
    for (const event of shortPlan.events) {
      if (!inRegime(event.signalTime)) {
        events.set(`${event.market}:${event.symbol}:${event.signalTime}:${event.side}`, event);
      }
    }
    if (shortPlan.model && longPlans[index]?.model) {
      for (const event of longPlans[index].events) {
        events.set(`${event.market}:${event.symbol}:${event.signalTime}:${event.side}`, { ...event, exit: BASE_EXIT });
      }
    }
    return {
      ...shortPlan,
      events: [...events.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score),
      longModel: longPlans[index]?.model || null,
      longTrainingRows: longPlans[index]?.trainingRows || 0,
      longScoreCutoff: longPlans[index]?.scoreCutoff ?? null
    };
  });
}

function runAll(options = {}) {
  const outputFile = options.outputFile || OUTPUT_FILE;
  const eligibleTrainingOnly = options.eligibleTrainingOnly ?? false;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const benchmark = benchmarkV124();
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const premiumLabeled = buildLabeledRows(prepared, auditedEvents);
  const inRegime = regimeClassifier(prepared, BASE_REGIME);

  const shortPlanSets = new Map();
  for (const scoreQuantile of [0.850, 0.875]) {
    console.error(`V14 building V11 short plans q=${scoreQuantile.toFixed(3)}`);
    shortPlanSets.set(scoreQuantile, buildWalkForwardPlans(prepared, premiumLabeled.rows, {
      ...SETTINGS,
      trainingScoreQuantile: scoreQuantile,
      tradingSides: [-1]
    }));
  }
  const shortPlans = v11ShortPlans(shortPlanSets);
  const rawEvents = scanReversalLongEvents(prepared);
  const labeledRows = buildReversalLabels(prepared, rawEvents, inRegime);
  if (labeledRows.length < 300) throw new Error(`V14 has only ${labeledRows.length} causal reversal labels`);
  const modelRows = eligibleTrainingOnly
    ? labeledRows.filter(row => ELIGIBLE_LAYERS.includes(row.layer))
    : labeledRows;
  const parity = validateLabelParity(prepared, labeledRows.find(row => row.outcome.reason !== 'period_end') || labeledRows[0]);

  const v11Stress = runScenario(prepared, shortPlans, 'stress', SIMULATION_PORTFOLIO);
  const v11Extreme = runScenario(prepared, shortPlans, 'extreme', SIMULATION_PORTFOLIO);
  assertV11Baseline({
    stress: compactRun(v11Stress, shortPlans),
    extreme: compactRun(v11Extreme, shortPlans)
  });

  const rows = [];
  for (const scoreQuantile of SCORE_QUANTILES) {
    console.error(`V14 building causal long plans q=${scoreQuantile.toFixed(3)}`);
    const longPlans = buildWalkForwardPlans(prepared, modelRows, {
      lookbackDays: 730,
      minimumTrainingRows: 300,
      ridgeLambda: 5,
      featureNames: FEATURE_NAMES,
      trainingScoreQuantile: scoreQuantile,
      scoreFloor: 0,
      trainingSides: [1],
      tradingSides: [1],
      trainingMarkets: ['um'],
      tradingMarkets: ['um'],
      tradingLayers: ELIGIBLE_LAYERS
    });
    const plans = combinePlans(shortPlans, longPlans, inRegime);
    const stressRun = runScenario(prepared, plans, 'stress', SIMULATION_PORTFOLIO);
    const extremeRun = runScenario(prepared, plans, 'extreme', SIMULATION_PORTFOLIO);
    const stress = compactRun(stressRun, plans);
    const extreme = compactRun(extremeRun, plans);
    const leaveOneOut = leaveOneOutAudit(stressRun);
    const headlineSuperior = strictlyBetter({ stress, extreme }, benchmark);
    let acceptance = null;
    if (headlineSuperior && leaveOneOut.pass) {
      const standard = diagnostics(stressRun, extremeRun, plans);
      const declaredLongRobust = longSleeveRobust(stress, extreme);
      acceptance = {
        ...standard,
        declaredLongRobust,
        gate: {
          pass: standard.gate.pass && declaredLongRobust,
          failures: [
            ...standard.gate.failures,
            ...(declaredLongRobust ? [] : ['declaredLongRobust'])
          ]
        }
      };
    }
    rows.push({
      id: `causal_long_q${Math.round(1000 * scoreQuantile)}`,
      scoreQuantile,
      modeledFolds: longPlans.filter(plan => plan.model).length,
      modelCandidates: plans.reduce((sum, plan) => sum + plan.events.filter(event => event.side === 1).length, 0),
      stress,
      extreme,
      versusV124: {
        stressReturnDelta: stress.totalReturn - benchmark.stress.totalReturn,
        extremeReturnDelta: extreme.totalReturn - benchmark.extreme.totalReturn,
        frequencyDelta: stress.operationalSignalsPerDay - benchmark.stress.operationalSignalsPerDay,
        headlineSuperior
      },
      leaveOneQuarterOut: leaveOneOut,
      acceptance,
      validationPass: headlineSuperior && leaveOneOut.pass && acceptance?.gate.pass === true
    });
  }

  const valid = rows.filter(row => row.validationPass)
    .sort((a, b) => b.stress.totalReturn - a.stress.totalReturn);
  const targetSummary = {
    rows: labeledRows.length,
    positiveShare: labeledRows.filter(row => row.target > 0).length / labeledRows.length,
    meanTarget: labeledRows.reduce((sum, row) => sum + row.target, 0) / labeledRows.length,
    byLayer: Object.fromEntries(ELIGIBLE_LAYERS.map(layer => {
      const selected = labeledRows.filter(row => row.layer === layer);
      return [layer, {
        rows: selected.length,
        positiveShare: selected.length ? selected.filter(row => row.target > 0).length / selected.length : 0,
        meanTarget: selected.length ? selected.reduce((sum, row) => sum + row.target, 0) / selected.length : 0
      }];
    }))
  };
  const result = {
    outputFile,
    generatedAt: new Date().toISOString(),
    version: options.version || 'v14-causal-walk-forward-reversal-quality-selector',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      rawReversalEvents: rawEvents.length,
      causalRapidBullLabels: labeledRows.length,
      modelTrainingLabels: modelRows.length,
      eligibleTrainingOnly
    },
    labelParity: parity,
    targetSummary,
    model: {
      features: FEATURE_NAMES,
      lookbackDays: 730,
      minimumTrainingRows: 300,
      ridgeLambda: 5,
      scoreQuantiles: SCORE_QUANTILES,
      scoreFloor: 0,
      labelKnownRule: 'event exit time must be before the fold start'
    },
    benchmark: {
      stress: benchmark.stress,
      extreme: benchmark.extreme
    },
    variants: rows,
    bestValidatedCandidate: valid[0]?.id ?? null,
    validationPass: valid.length > 0,
    researchStatus: valid.length
      ? 'V14_CAUSAL_REVERSAL_SELECTOR_STRICTLY_SUPERIOR_TO_V12_4'
      : 'NO_V14_CAUSAL_REVERSAL_SELECTOR_STRICTLY_SUPERIOR_TO_V12_4',
    nextAction: valid.length
      ? 'run model-coefficient stability, feature ablation, frozen forward configuration, and signal parity validation'
      : 'the reversal edge is not sufficiently predictable from causal event features; do not increase live risk',
    caveats: [
      'The feature set and quantile grid are evaluated on already exposed history.',
      'Causal walk-forward construction prevents future labels from entering each fold but does not create independent evidence.',
      'No historical result guarantees future profitability or authorizes live trading.'
    ]
  };
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try {
    const result = runAll();
    console.log(JSON.stringify({
      outputFile: OUTPUT_FILE,
      researchStatus: result.researchStatus,
      validationPass: result.validationPass,
      bestValidatedCandidate: result.bestValidatedCandidate,
      labelParity: result.labelParity,
      targetSummary: result.targetSummary,
      variants: result.variants.map(row => ({
        id: row.id,
        modeledFolds: row.modeledFolds,
        modelCandidates: row.modelCandidates,
        stressReturn: row.stress.totalReturn,
        extremeReturn: row.extreme.totalReturn,
        frequency: row.stress.operationalSignalsPerDay,
        trades: row.stress.trades,
        longTrades: row.stress.longTrades,
        longProfitFactor: row.stress.longAudit.profitFactor,
        longWithoutBest5: row.stress.longAudit.profitWithoutBest5,
        headlineSuperior: row.versusV124.headlineSuperior,
        leaveOneOutPass: row.leaveOneQuarterOut.pass,
        minimumLongWithoutBest5: row.leaveOneQuarterOut.minimumLongWithoutBest5,
        validationPass: row.validationPass
      }))
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  FEATURE_NAMES,
  SCORE_QUANTILES,
  stopPrice,
  simulateLongEventReturn,
  featureVector,
  buildReversalLabels,
  validateLabelParity,
  combinePlans,
  runAll
};
