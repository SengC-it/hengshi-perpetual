const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { quantile } = require('./v7_ml');
const { SETTINGS } = require('./v92_run');
const {
  SIMULATION_PORTFOLIO,
  v11ShortPlans,
  compactRun,
  sideAudit,
  longSleeveRobust,
  assertV11Baseline
} = require('./v12_long_short_research');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v125_reversal_robustness.json');
const LOOKBACK_DAYS = 730;
const ELIGIBLE_LAYERS = new Set(['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol']);
const BASE_SIGNAL = {
  shockLookbackBars: 6,
  shockAtr: 2.5,
  volumeMultiple: 1.5,
  maximumTrendGap: 0.08
};
const BASE_REGIME = {
  returnLookbackBars: 180,
  minimumReturn: 0.10
};
const BASE_EXIT = {
  stopAtr: 1.5,
  trailAtr: null,
  maxHoldBars: 6,
  meanExitEma20: true
};
const BASE_SCORE_QUANTILE = 0.300;

const STRUCTURAL_SIGNALS = {
  base: BASE_SIGNAL,
  shock_atr_200: { ...BASE_SIGNAL, shockAtr: 2.0 },
  shock_atr_300: { ...BASE_SIGNAL, shockAtr: 3.0 },
  volume_125: { ...BASE_SIGNAL, volumeMultiple: 1.25 },
  volume_175: { ...BASE_SIGNAL, volumeMultiple: 1.75 },
  trend_gap_050: { ...BASE_SIGNAL, maximumTrendGap: 0.05 },
  trend_gap_120: { ...BASE_SIGNAL, maximumTrendGap: 0.12 },
  shock_lookback_4: { ...BASE_SIGNAL, shockLookbackBars: 4 },
  shock_lookback_8: { ...BASE_SIGNAL, shockLookbackBars: 8 }
};

const VARIANTS = [
  { id: 'base', signal: 'base' },
  { id: 'score_q200', signal: 'base', scoreQuantile: 0.200 },
  { id: 'score_q400', signal: 'base', scoreQuantile: 0.400 },
  { id: 'shock_atr_200', signal: 'shock_atr_200' },
  { id: 'shock_atr_300', signal: 'shock_atr_300' },
  { id: 'volume_125', signal: 'volume_125' },
  { id: 'volume_175', signal: 'volume_175' },
  { id: 'trend_gap_050', signal: 'trend_gap_050' },
  { id: 'trend_gap_120', signal: 'trend_gap_120' },
  { id: 'shock_lookback_4', signal: 'shock_lookback_4' },
  { id: 'shock_lookback_8', signal: 'shock_lookback_8' },
  { id: 'regime_return_050', signal: 'base', regime: { ...BASE_REGIME, minimumReturn: 0.05 } },
  { id: 'regime_return_150', signal: 'base', regime: { ...BASE_REGIME, minimumReturn: 0.15 } },
  { id: 'regime_lookback_20d', signal: 'base', regime: { ...BASE_REGIME, returnLookbackBars: 120 } },
  { id: 'regime_lookback_45d', signal: 'base', regime: { ...BASE_REGIME, returnLookbackBars: 270 } },
  { id: 'exit_stop_125', signal: 'base', exit: { ...BASE_EXIT, stopAtr: 1.25 } },
  { id: 'exit_stop_175', signal: 'base', exit: { ...BASE_EXIT, stopAtr: 1.75 } },
  { id: 'exit_hold_4', signal: 'base', exit: { ...BASE_EXIT, maxHoldBars: 4 } },
  { id: 'exit_hold_8', signal: 'base', exit: { ...BASE_EXIT, maxHoldBars: 8 } },
  { id: 'exit_without_mean', signal: 'base', exit: { ...BASE_EXIT, meanExitEma20: false } }
];

function eventKey(event) {
  return `${event.market}:${event.symbol}:${event.signalTime}:${event.side}`;
}

function safeLog(value) {
  return value > 0 && Number.isFinite(value) ? Math.log(value) : 0;
}

function reversalSignalAt(item, index, config) {
  if (index < Math.max(50, config.shockLookbackBars)) return null;
  const bar = item.bars[index];
  const atr = item.atr[index];
  const volumeMedian = item.volumeMedian20[index];
  if (!(atr > 0) || !(volumeMedian > 0) || bar.qv <= config.volumeMultiple * volumeMedian) return null;
  const trendGap = Math.abs(item.ema20[index] / item.ema50[index] - 1);
  if (!Number.isFinite(trendGap) || trendGap > config.maximumTrendGap) return null;
  const change = bar.c / item.bars[index - config.shockLookbackBars].c - 1;
  const threshold = config.shockAtr * atr / bar.c;
  if (!(change < -threshold)) return null;
  return -change / threshold + safeLog(bar.qv / volumeMedian);
}

function scanStructuralEvents(prepared) {
  const maps = new Map(Object.keys(STRUCTURAL_SIGNALS).map(id => [id, new Map()]));
  let complete = 0;
  for (const item of prepared.filter(row => row.market === 'um')) {
    for (let index = 50; index < item.bars.length - 1; index++) {
      const bar = item.bars[index];
      const day = new Date(bar.openTime).toISOString().slice(0, 10);
      for (const [id, config] of Object.entries(STRUCTURAL_SIGNALS)) {
        const score = reversalSignalAt(item, index, config);
        if (score == null) continue;
        const key = `${item.market}:${item.symbol}:${day}`;
        const event = {
          market: item.market,
          symbol: item.symbol,
          baseAsset: item.baseAsset,
          side: 1,
          score,
          signalTime: bar.openTime,
          entryTime: item.bars[index + 1].openTime,
          configId: 'ml',
          type: 'reversal_long'
        };
        const target = maps.get(id);
        if (!target.has(key) || event.score > target.get(key).score) target.set(key, event);
      }
    }
    complete++;
    if (complete % 100 === 0) console.error(`V12.5 scanned structural histories ${complete}`);
  }
  return new Map([...maps].map(([id, events]) => [
    id,
    [...events.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score)
  ]));
}

function regimeClassifier(prepared, config) {
  const btc = prepared.find(row => row.market === 'um' && row.symbol === 'BTCUSDT');
  if (!btc) throw new Error('BTCUSDT USD-M history is required');
  return time => {
    const index = btc.indexByTime.get(time);
    if (index == null || index < config.returnLookbackBars) return false;
    return Number.isFinite(btc.ema20[index])
      && Number.isFinite(btc.ema50[index])
      && btc.ema20[index] > btc.ema50[index]
      && btc.bars[index].c / btc.bars[index - config.returnLookbackBars].c - 1 > config.minimumReturn;
  };
}

function buildLongPlans(shortPlans, rawEvents, scoreQuantile, exit, inRegime) {
  return shortPlans.map(plan => {
    const trainingStart = plan.startTime - LOOKBACK_DAYS * 86400000;
    const training = rawEvents.filter(event => event.signalTime >= trainingStart && event.entryTime < plan.startTime);
    const cutoff = training.length >= 1000 ? quantile(training.map(event => event.score), scoreQuantile) : null;
    const events = !plan.model || cutoff == null ? [] : rawEvents.filter(event => {
      const layer = plan.layers.get(event.symbol);
      return event.signalTime >= plan.startTime
        && event.signalTime <= plan.endTime
        && event.entryTime <= plan.endTime
        && event.score >= cutoff
        && ELIGIBLE_LAYERS.has(layer)
        && inRegime(event.signalTime);
    }).map(event => ({ ...event, exit }));
    return {
      ...plan,
      events,
      reversalTrainingRows: training.length,
      reversalScoreQuantile: scoreQuantile,
      reversalScoreCutoff: cutoff,
      reversalExit: exit
    };
  });
}

function combinePlans(shortPlans, longPlans, inRegime) {
  return shortPlans.map((shortPlan, index) => {
    const events = new Map();
    for (const event of shortPlan.events) {
      if (!inRegime(event.signalTime)) events.set(eventKey(event), event);
    }
    for (const event of longPlans[index].events) events.set(eventKey(event), event);
    return {
      ...shortPlan,
      events: [...events.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score)
    };
  });
}

function auditTrades(trades, removeBest = 10) {
  const pnl = trades.map(trade => trade.netPnl).sort((a, b) => b - a);
  const wins = pnl.filter(value => value > 0);
  const losses = pnl.filter(value => value < 0);
  return {
    trades: trades.length,
    netPnl: pnl.reduce((sum, value) => sum + value, 0),
    profitFactor: losses.length
      ? wins.reduce((sum, value) => sum + value, 0) / -losses.reduce((sum, value) => sum + value, 0)
      : null,
    profitWithoutBest: pnl.slice(removeBest).reduce((sum, value) => sum + value, 0)
  };
}

function leaveOneQuarterOut(run) {
  return run.quarters.filter(quarter => quarter.trades > 0).map(quarter => {
    const remaining = run.trades.filter(trade => trade.signalTime < quarter.startTime || trade.signalTime > quarter.endTime);
    return {
      excludedQuarter: new Date(quarter.startTime).toISOString().slice(0, 10),
      combined: auditTrades(remaining),
      long: sideAudit(remaining, 1),
      short: sideAudit(remaining, -1)
    };
  });
}

function candidateCounts(plans) {
  const events = plans.flatMap(plan => plan.events);
  return {
    total: events.length,
    longs: events.filter(event => event.side === 1).length,
    shorts: events.filter(event => event.side === -1).length
  };
}

function runVariant(prepared, plans, variant) {
  console.error(`V12.5 testing ${variant.id}`);
  const stressRun = runScenario(prepared, plans, 'stress', SIMULATION_PORTFOLIO);
  const extremeRun = runScenario(prepared, plans, 'extreme', SIMULATION_PORTFOLIO);
  return {
    ...variant,
    candidateCounts: candidateCounts(plans),
    stress: compactRun(stressRun, plans),
    extreme: compactRun(extremeRun, plans),
    _stressRun: stressRun,
    _extremeRun: extremeRun
  };
}

function runAll() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);

  const shortPlanSets = new Map();
  for (const scoreQuantile of [0.850, 0.875]) {
    console.error(`V12.5 building V11 short plans q=${scoreQuantile.toFixed(3)}`);
    shortPlanSets.set(scoreQuantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      trainingScoreQuantile: scoreQuantile,
      tradingSides: [-1]
    }));
  }
  const shortPlans = v11ShortPlans(shortPlanSets);
  const structuralEvents = scanStructuralEvents(prepared);

  const baseline = runVariant(prepared, shortPlans, { id: 'v11_baseline', type: 'benchmark' });
  assertV11Baseline(baseline);
  const rows = [];
  const plansById = new Map();
  for (const definition of VARIANTS) {
    const regime = definition.regime || BASE_REGIME;
    const scoreQuantile = definition.scoreQuantile ?? BASE_SCORE_QUANTILE;
    const exit = definition.exit || BASE_EXIT;
    const inRegime = regimeClassifier(prepared, regime);
    const rawEvents = structuralEvents.get(definition.signal);
    const longPlans = buildLongPlans(shortPlans, rawEvents, scoreQuantile, exit, inRegime);
    const plans = combinePlans(shortPlans, longPlans, inRegime);
    const row = runVariant(prepared, plans, {
      id: definition.id,
      type: 'parameter_neighborhood',
      signal: STRUCTURAL_SIGNALS[definition.signal],
      regime,
      scoreQuantile,
      exit
    });
    rows.push(row);
    plansById.set(row.id, plans);
  }

  const base = rows.find(row => row.id === 'base');
  const acceptance = diagnostics(base._stressRun, base._extremeRun, plansById.get('base'));
  const declaredLongRobust = longSleeveRobust(base.stress, base.extreme);
  base.acceptance = {
    ...acceptance,
    declaredLongRobust,
    v125Gate: {
      pass: acceptance.gate.pass && declaredLongRobust,
      failures: [
        ...acceptance.gate.failures,
        ...(declaredLongRobust ? [] : ['declaredLongRobust'])
      ]
    }
  };

  const neighborhood = rows.filter(row => row.id !== 'base');
  for (const row of rows) {
    row.versusV11 = {
      stressReturnDelta: row.stress.totalReturn - baseline.stress.totalReturn,
      extremeReturnDelta: row.extreme.totalReturn - baseline.extreme.totalReturn,
      frequencyDelta: row.stress.operationalSignalsPerDay - baseline.stress.operationalSignalsPerDay,
      longSleeveRobust: longSleeveRobust(row.stress, row.extreme),
      exceedsV11Returns: row.stress.totalReturn > baseline.stress.totalReturn
        && row.extreme.totalReturn > baseline.extreme.totalReturn
    };
  }
  const neighborhoodAudit = {
    variants: neighborhood.length,
    allStressPositive: neighborhood.every(row => row.stress.totalReturn > 0),
    allExtremePositive: neighborhood.every(row => row.extreme.totalReturn > 0),
    exceedsV11Returns: neighborhood.filter(row => row.versusV11.exceedsV11Returns).length,
    exceedsV11ReturnShare: neighborhood.filter(row => row.versusV11.exceedsV11Returns).length / neighborhood.length,
    longSleeveRobust: neighborhood.filter(row => row.versusV11.longSleeveRobust).length,
    longSleeveRobustShare: neighborhood.filter(row => row.versusV11.longSleeveRobust).length / neighborhood.length,
    minimumStressReturn: Math.min(...neighborhood.map(row => row.stress.totalReturn)),
    minimumExtremeReturn: Math.min(...neighborhood.map(row => row.extreme.totalReturn)),
    minimumLongProfitFactor: Math.min(...neighborhood.map(row => row.stress.longAudit.profitFactor || 0))
  };
  neighborhoodAudit.pass = neighborhoodAudit.allStressPositive
    && neighborhoodAudit.allExtremePositive
    && neighborhoodAudit.exceedsV11ReturnShare >= 0.70
    && neighborhoodAudit.longSleeveRobustShare >= 0.70;

  const leaveOneOut = leaveOneQuarterOut(base._stressRun);
  const leaveOneOutAudit = {
    rows: leaveOneOut,
    allCombinedPositive: leaveOneOut.every(row => row.combined.netPnl > 0 && row.combined.profitFactor > 1),
    allLongPositive: leaveOneOut.every(row => row.long.netPnl > 0 && row.long.profitFactor > 1 && row.long.profitWithoutBest5 > 0),
    minimumCombinedNetPnl: Math.min(...leaveOneOut.map(row => row.combined.netPnl)),
    minimumLongNetPnl: Math.min(...leaveOneOut.map(row => row.long.netPnl)),
    minimumLongWithoutBest5: Math.min(...leaveOneOut.map(row => row.long.profitWithoutBest5))
  };
  leaveOneOutAudit.pass = leaveOneOutAudit.allCombinedPositive && leaveOneOutAudit.allLongPositive;

  const validationPass = base.acceptance.v125Gate.pass
    && neighborhoodAudit.pass
    && leaveOneOutAudit.pass;
  for (const row of rows) {
    delete row._stressRun;
    delete row._extremeRun;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v12.5-reversal-candidate-anti-overfit-validation',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      structuralEventCounts: Object.fromEntries([...structuralEvents].map(([id, events]) => [id, events.length]))
    },
    frozenRuleUnderTest: {
      normalRegime: 'V11 short model',
      rapidBullRegime: 'replace short events with long reversal events',
      signal: BASE_SIGNAL,
      regime: BASE_REGIME,
      scoreQuantile: BASE_SCORE_QUANTILE,
      layers: [...ELIGIBLE_LAYERS],
      exit: BASE_EXIT,
      portfolio: SIMULATION_PORTFOLIO
    },
    benchmark: {
      stress: baseline.stress,
      extreme: baseline.extreme
    },
    candidate: base,
    parameterNeighborhood: {
      audit: neighborhoodAudit,
      variants: rows.filter(row => row.id !== 'base')
    },
    leaveOneQuarterOut: leaveOneOutAudit,
    validationPass,
    researchStatus: validationPass
      ? 'V12_5_HISTORICAL_ROBUSTNESS_VALIDATION_PASSED'
      : 'V12_5_HISTORICAL_ROBUSTNESS_VALIDATION_FAILED',
    nextAction: validationPass
      ? 'freeze V12 paper candidate, add forward-only signal generation and implementation parity tests, and restart the independent clock'
      : 'do not freeze V12; retain V11 or the rapid-bull pause overlay',
    caveats: [
      'Parameter-neighborhood and leave-one-quarter-out checks reduce but do not remove selection bias.',
      'All history through 2026-07-15 was already visible during development.',
      'A pass authorizes only a frozen paper candidate, never immediate live trading.',
      'No historical result guarantees future profitability.'
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
      researchStatus: result.researchStatus,
      validationPass: result.validationPass,
      candidate: {
        stressReturn: result.candidate.stress.totalReturn,
        extremeReturn: result.candidate.extreme.totalReturn,
        frequency: result.candidate.stress.operationalSignalsPerDay,
        trades: result.candidate.stress.trades,
        longTrades: result.candidate.stress.longTrades,
        longProfitFactor: result.candidate.stress.longAudit.profitFactor,
        longWithoutBest5: result.candidate.stress.longAudit.profitWithoutBest5,
        gate: result.candidate.acceptance.v125Gate
      },
      parameterNeighborhood: result.parameterNeighborhood.audit,
      leaveOneQuarterOut: {
        pass: result.leaveOneQuarterOut.pass,
        allCombinedPositive: result.leaveOneQuarterOut.allCombinedPositive,
        allLongPositive: result.leaveOneQuarterOut.allLongPositive,
        minimumCombinedNetPnl: result.leaveOneQuarterOut.minimumCombinedNetPnl,
        minimumLongNetPnl: result.leaveOneQuarterOut.minimumLongNetPnl,
        minimumLongWithoutBest5: result.leaveOneQuarterOut.minimumLongWithoutBest5
      },
      weakestNeighborhoods: result.parameterNeighborhood.variants.slice().sort((a, b) => a.stress.totalReturn - b.stress.totalReturn).slice(0, 5).map(row => ({
        id: row.id,
        stressReturn: row.stress.totalReturn,
        extremeReturn: row.extreme.totalReturn,
        frequency: row.stress.operationalSignalsPerDay,
        longTrades: row.stress.longTrades,
        longProfitFactor: row.stress.longAudit.profitFactor,
        longWithoutBest5: row.stress.longAudit.profitWithoutBest5,
        exceedsV11Returns: row.versusV11.exceedsV11Returns,
        longSleeveRobust: row.versusV11.longSleeveRobust
      }))
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  BASE_SIGNAL,
  BASE_REGIME,
  BASE_EXIT,
  BASE_SCORE_QUANTILE,
  STRUCTURAL_SIGNALS,
  VARIANTS,
  reversalSignalAt,
  scanStructuralEvents,
  regimeClassifier,
  buildLongPlans,
  combinePlans,
  leaveOneQuarterOut,
  runAll
};
