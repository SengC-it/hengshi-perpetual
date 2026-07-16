const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const {
  buildLabeledRows,
  buildWalkForwardPlans,
  runScenario
} = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { FEATURE_SET, SETTINGS } = require('./v92_run');
const { QUANTILE_BY_LAYER } = require('./v10_run');
const { PORTFOLIO } = require('./v11_run');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v12_long_short_research.json');
const V11_RESULT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v11_results.json');
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const RAPID_BULL_LOOKBACK_BARS = 180;
const RAPID_BULL_RETURN = 0.10;
const QUANTILES = [0.825, 0.850, 0.875, 0.900, 0.925, 0.950];
const ELIGIBLE_LAYERS = new Set(['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol']);
const LIQUID_LAYERS = new Set(['liquid_low_vol', 'liquid_high_vol']);
const LIQUID_HIGH_LAYER = new Set(['liquid_high_vol']);
const SIMULATION_PORTFOLIO = {
  maxPerBar: PORTFOLIO.maxSignalsPerBar,
  maxPerDay: PORTFOLIO.maxSignalsPerDay,
  maxPositions: PORTFOLIO.maxPositions
};

const VARIANTS = [
  { id: 'v11_baseline', shortMode: 'all', longQuantile: null, longLayers: null },
  { id: 'rapid_bull_pause_shorts', shortMode: 'pause_rapid_bull', longQuantile: null, longLayers: null },
  { id: 'replace_long_q825_all', shortMode: 'pause_rapid_bull', longQuantile: 0.825, longLayers: ELIGIBLE_LAYERS },
  { id: 'replace_long_q850_all', shortMode: 'pause_rapid_bull', longQuantile: 0.850, longLayers: ELIGIBLE_LAYERS },
  { id: 'replace_long_q875_all', shortMode: 'pause_rapid_bull', longQuantile: 0.875, longLayers: ELIGIBLE_LAYERS },
  { id: 'replace_long_q900_all', shortMode: 'pause_rapid_bull', longQuantile: 0.900, longLayers: ELIGIBLE_LAYERS },
  { id: 'replace_long_q925_all', shortMode: 'pause_rapid_bull', longQuantile: 0.925, longLayers: ELIGIBLE_LAYERS },
  { id: 'replace_long_q950_all', shortMode: 'pause_rapid_bull', longQuantile: 0.950, longLayers: ELIGIBLE_LAYERS },
  { id: 'replace_long_q850_liquid', shortMode: 'pause_rapid_bull', longQuantile: 0.850, longLayers: LIQUID_LAYERS },
  { id: 'replace_long_q875_liquid', shortMode: 'pause_rapid_bull', longQuantile: 0.875, longLayers: LIQUID_LAYERS },
  { id: 'replace_long_q900_liquid', shortMode: 'pause_rapid_bull', longQuantile: 0.900, longLayers: LIQUID_LAYERS },
  { id: 'replace_long_q900_liquid_high', shortMode: 'pause_rapid_bull', longQuantile: 0.900, longLayers: LIQUID_HIGH_LAYER },
  { id: 'add_long_q900_liquid', shortMode: 'all', longQuantile: 0.900, longLayers: LIQUID_LAYERS }
];

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function countsBy(rows, selector) {
  const result = {};
  for (const row of rows) {
    const key = selector(row);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function eventKey(event) {
  return `${event.market}:${event.symbol}:${event.signalTime}:${event.side}`;
}

function profitFactor(trades) {
  const wins = sum(trades.filter(trade => trade.netPnl > 0).map(trade => trade.netPnl));
  const losses = -sum(trades.filter(trade => trade.netPnl < 0).map(trade => trade.netPnl));
  return losses > 0 ? wins / losses : wins > 0 ? null : 0;
}

function sideAudit(trades, side) {
  const selected = trades.filter(trade => trade.side === side);
  const sortedPnl = selected.map(trade => trade.netPnl).sort((a, b) => b - a);
  return {
    trades: selected.length,
    winRate: selected.length ? selected.filter(trade => trade.netPnl > 0).length / selected.length : 0,
    netPnl: sum(sortedPnl),
    profitFactor: profitFactor(selected),
    profitWithoutBest5: sum(sortedPnl.slice(5)),
    byLayerPnl: Object.fromEntries(Object.entries(countsBy(selected, trade => trade.layer))
      .map(([layer]) => [layer, sum(selected.filter(trade => trade.layer === layer).map(trade => trade.netPnl))])),
    byLayerTrades: countsBy(selected, trade => trade.layer)
  };
}

function rapidBullClassifier(prepared) {
  const btc = prepared.find(row => row.market === 'um' && row.symbol === 'BTCUSDT');
  if (!btc) throw new Error('BTCUSDT USD-M history is required for the causal rapid-bull regime');
  return time => {
    const index = btc.indexByTime.get(time);
    if (index == null || index < RAPID_BULL_LOOKBACK_BARS) return false;
    const current = btc.bars[index];
    const prior = btc.bars[index - RAPID_BULL_LOOKBACK_BARS];
    return Number.isFinite(btc.ema20[index])
      && Number.isFinite(btc.ema50[index])
      && btc.ema20[index] > btc.ema50[index]
      && current.c / prior.c - 1 > RAPID_BULL_RETURN;
  };
}

function v11ShortPlans(planSets) {
  const reference = planSets.get(0.850);
  return reference.map((plan, index) => {
    const events = new Map();
    for (const [layer, quantile] of Object.entries(QUANTILE_BY_LAYER)) {
      const source = planSets.get(quantile)[index];
      for (const event of source.events) {
        if (event.side === -1 && source.layers.get(event.symbol) === layer) {
          events.set(eventKey(event), event);
        }
      }
    }
    return {
      ...plan,
      events: [...events.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score),
      layerScoreQuantiles: QUANTILE_BY_LAYER
    };
  });
}

function variantPlans(shortPlans, planSets, variant, isRapidBull) {
  return shortPlans.map((shortPlan, index) => {
    const events = new Map();
    for (const event of shortPlan.events) {
      if (variant.shortMode === 'all' || !isRapidBull(event.signalTime)) {
        events.set(eventKey(event), event);
      }
    }
    if (variant.longQuantile != null) {
      const longSource = planSets.get(variant.longQuantile)[index];
      for (const event of longSource.events) {
        const layer = longSource.layers.get(event.symbol);
        if (event.side === 1 && variant.longLayers.has(layer) && isRapidBull(event.signalTime)) {
          events.set(eventKey(event), event);
        }
      }
    }
    return {
      ...shortPlan,
      events: [...events.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score),
      variant: variant.id
    };
  });
}

function operationalStats(run, plans) {
  const activeStart = plans.find(plan => plan.model)?.startTime;
  const activeQuarters = run.quarters.filter(row => row.startTime >= activeStart);
  const activeEnd = activeQuarters.at(-1)?.endTime;
  const operationalDays = activeStart == null || activeEnd == null ? 0 : (activeEnd - activeStart) / 86400000 + 1;
  return {
    activeStart,
    activeQuarters: activeQuarters.length,
    operationalDays,
    operationalSignalsPerDay: operationalDays ? run.summary.finalSignals / operationalDays : 0,
    positiveQuarterShare: activeQuarters.length
      ? activeQuarters.filter(row => row.totalReturn > 0).length / activeQuarters.length
      : 0,
    lastFourQuarterReturn: activeQuarters.slice(-4).reduce((capital, row) => capital * (1 + row.totalReturn), 1) - 1
  };
}

function compactRun(run, plans) {
  const operational = operationalStats(run, plans);
  return {
    trades: run.summary.trades,
    longTrades: run.summary.longTrades,
    shortTrades: run.summary.shortTrades,
    winRate: run.summary.winRate,
    profitFactor: run.summary.profitFactor,
    totalReturn: run.summary.totalReturn,
    maxDrawdown: run.summary.maxDrawdown,
    netPnl: run.summary.netPnl,
    fees: run.summary.fees,
    modelCandidates: run.summary.modelCandidates,
    finalSignals: run.summary.finalSignals,
    executedSignals: run.summary.executedSignals,
    maxSymbolContribution: run.summary.maxSymbolContribution,
    profitableLayers: run.summary.profitableLayers,
    byLayer: run.summary.byLayer,
    quarters: run.quarters,
    ...operational,
    longAudit: sideAudit(run.trades, 1),
    shortAudit: sideAudit(run.trades, -1)
  };
}

function longSleeveRobust(stress, extreme) {
  return stress.longAudit.trades >= 30
    && stress.longAudit.profitFactor > 1
    && stress.longAudit.profitWithoutBest5 > 0
    && extreme.longAudit.profitFactor > 1
    && extreme.longAudit.netPnl > 0;
}

function isStrictlySuperior(row, baseline) {
  return row.id !== 'v11_baseline'
    && row.stress.totalReturn > baseline.stress.totalReturn
    && row.extreme.totalReturn > baseline.extreme.totalReturn
    && row.stress.operationalSignalsPerDay > baseline.stress.operationalSignalsPerDay
    && row.stress.positiveQuarterShare >= baseline.stress.positiveQuarterShare
    && row.stress.maxDrawdown >= baseline.stress.maxDrawdown - 0.02
    && row.stress.profitFactor >= 1.15
    && row.extreme.profitFactor >= 1
    && row.stress.finalSignals === row.stress.executedSignals
    && longSleeveRobust(row.stress, row.extreme);
}

function summarizeLabeled(rows, isRapidBull) {
  const rapid = rows.filter(row => isRapidBull(row.signalTime));
  return {
    total: rows.length,
    bySide: countsBy(rows, row => row.event.side === 1 ? 'long' : 'short'),
    bySideAndLayer: countsBy(rows, row => `${row.event.side === 1 ? 'long' : 'short'}:${row.layer}`),
    rapidBull: {
      total: rapid.length,
      bySide: countsBy(rapid, row => row.event.side === 1 ? 'long' : 'short'),
      bySideAndLayer: countsBy(rapid, row => `${row.event.side === 1 ? 'long' : 'short'}:${row.layer}`)
    }
  };
}

function assertV11Baseline(baseline) {
  const frozen = JSON.parse(fs.readFileSync(V11_RESULT_FILE, 'utf8'));
  const checks = {
    stressTrades: baseline.stress.trades === frozen.stress.trades,
    extremeTrades: baseline.extreme.trades === frozen.extreme.trades,
    stressReturn: Math.abs(baseline.stress.totalReturn - frozen.stress.totalReturn) < 1e-12,
    extremeReturn: Math.abs(baseline.extreme.totalReturn - frozen.extreme.totalReturn) < 1e-12,
    stressDrawdown: Math.abs(baseline.stress.maxDrawdown - frozen.stress.maxDrawdown) < 1e-12
  };
  const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  if (failures.length) throw new Error(`V12 failed to reproduce frozen V11 baseline: ${failures.join(', ')}`);
}

function fullAcceptance(row, plans) {
  const acceptance = diagnostics(row._stressRun, row._extremeRun, plans);
  return {
    ...acceptance,
    declaredLongRobust: longSleeveRobust(row.stress, row.extreme),
    v12Gate: {
      pass: acceptance.gate.pass && longSleeveRobust(row.stress, row.extreme),
      failures: [
        ...acceptance.gate.failures,
        ...(longSleeveRobust(row.stress, row.extreme) ? [] : ['declaredLongRobust'])
      ]
    }
  };
}

function runAll() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const isRapidBull = rapidBullClassifier(prepared);
  const planSets = new Map();
  for (const quantile of QUANTILES) {
    console.error(`V12 building two-sided plans q=${quantile.toFixed(3)}`);
    planSets.set(quantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      featureNames: FEATURE_SET,
      trainingScoreQuantile: quantile,
      tradingSides: [-1, 1]
    }));
  }

  const shortPlans = v11ShortPlans(planSets);
  const rows = [];
  const plansById = new Map();
  for (const variant of VARIANTS) {
    console.error(`V12 testing ${variant.id}`);
    const plans = variantPlans(shortPlans, planSets, variant, isRapidBull);
    const stressRun = runScenario(prepared, plans, 'stress', SIMULATION_PORTFOLIO);
    const extremeRun = runScenario(prepared, plans, 'extreme', SIMULATION_PORTFOLIO);
    plansById.set(variant.id, plans);
    rows.push({
      id: variant.id,
      shortMode: variant.shortMode,
      longQuantile: variant.longQuantile,
      longLayers: variant.longLayers ? [...variant.longLayers] : [],
      stress: compactRun(stressRun, plans),
      extreme: compactRun(extremeRun, plans),
      _stressRun: stressRun,
      _extremeRun: extremeRun
    });
  }

  const baseline = rows.find(row => row.id === 'v11_baseline');
  assertV11Baseline(baseline);
  for (const row of rows) {
    row.versusV11 = {
      stressReturnDelta: row.stress.totalReturn - baseline.stress.totalReturn,
      extremeReturnDelta: row.extreme.totalReturn - baseline.extreme.totalReturn,
      frequencyDelta: row.stress.operationalSignalsPerDay - baseline.stress.operationalSignalsPerDay,
      maxDrawdownDelta: row.stress.maxDrawdown - baseline.stress.maxDrawdown,
      longSleeveRobust: longSleeveRobust(row.stress, row.extreme),
      strictlySuperior: isStrictlySuperior(row, baseline)
    };
  }

  const superior = rows.filter(row => row.versusV11.strictlySuperior)
    .sort((a, b) => b.stress.totalReturn - a.stress.totalReturn
      || b.extreme.totalReturn - a.extreme.totalReturn
      || b.stress.operationalSignalsPerDay - a.stress.operationalSignalsPerDay);
  const finalists = [baseline, ...superior.slice(0, 3)];
  for (const row of finalists) {
    console.error(`V12 full diagnostics ${row.id}`);
    row.acceptance = fullAcceptance(row, plansById.get(row.id));
  }
  for (const row of rows) {
    delete row._stressRun;
    delete row._extremeRun;
  }

  const acceptedSuperior = superior.filter(row => row.acceptance?.v12Gate.pass);
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v12-rapid-bull-long-short-regime-replacement-research',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      auditedEvents: auditedEvents.length,
      metricsAvailableBeforeEntry: labeled.available,
      labeledEligibleEvents: labeled.rows.length
    },
    hypothesis: {
      normalRegime: 'retain V11 short events',
      rapidBullRegime: 'BTC EMA20 above EMA50 and trailing 30-day return above 10%',
      testedActions: ['pause shorts', 'replace shorts with longs', 'add longs while retaining shorts'],
      unchangedControls: {
        features: FEATURE_SET,
        trainingWindowDays: SETTINGS.lookbackDays,
        minimumTrainingRows: SETTINGS.minimumTrainingRows,
        exits: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 },
        portfolio: PORTFOLIO
      }
    },
    labelAudit: summarizeLabeled(labeled.rows, isRapidBull),
    variants: rows,
    bestStrictlySuperior: acceptedSuperior[0]?.id ?? null,
    researchStatus: acceptedSuperior.length
      ? 'HISTORICALLY_SUPERIOR_TWO_SIDED_CANDIDATE_FOUND'
      : 'NO_TWO_SIDED_CANDIDATE_STRICTLY_SUPERIOR_TO_V11',
    nextAction: acceptedSuperior.length
      ? 'formalize the winning rules, repeat anti-overfit and forward-safety tests, then start a new paper-only clock'
      : 'do not replace V11; test a separately trained causal long model rather than a mirrored shared model',
    caveats: [
      'All V12 choices were evaluated on history already exposed during V7-V11 research, so even a winner is not independent evidence.',
      'The rapid-bull threshold and candidate grid are research choices and introduce multiple-testing risk.',
      'Historical OHLC simulation does not fully model spread spikes, queue priority, partial fills, liquidation, ADL, outages or tail gaps.',
      'No result guarantees future profitability or authorizes live trading.'
    ]
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try {
    const result = runAll();
    console.log(JSON.stringify({
      outputFile: OUTPUT_FILE,
      labelAudit: result.labelAudit,
      bestStrictlySuperior: result.bestStrictlySuperior,
      researchStatus: result.researchStatus,
      variants: result.variants.map(row => ({
        id: row.id,
        stressReturn: row.stress.totalReturn,
        extremeReturn: row.extreme.totalReturn,
        frequency: row.stress.operationalSignalsPerDay,
        trades: row.stress.trades,
        longTrades: row.stress.longTrades,
        stressLongPnl: row.stress.longAudit.netPnl,
        stressLongProfitFactor: row.stress.longAudit.profitFactor,
        stressLongWithoutBest5: row.stress.longAudit.profitWithoutBest5,
        strictlySuperior: row.versusV11.strictlySuperior
      }))
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  QUANTILES,
  VARIANTS,
  SIMULATION_PORTFOLIO,
  rapidBullClassifier,
  v11ShortPlans,
  variantPlans,
  operationalStats,
  compactRun,
  sideAudit,
  longSleeveRobust,
  isStrictlySuperior,
  assertV11Baseline,
  runAll
};
