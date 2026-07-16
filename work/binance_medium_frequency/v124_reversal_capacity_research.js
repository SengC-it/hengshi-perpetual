const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { quantile } = require('./v7_ml');
const { SETTINGS } = require('./v92_run');
const {
  SIMULATION_PORTFOLIO,
  rapidBullClassifier,
  v11ShortPlans,
  compactRun,
  longSleeveRobust,
  assertV11Baseline
} = require('./v12_long_short_research');
const { scanReversalLongEvents, EXIT_PROFILES } = require('./v123_reversal_long_research');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v124_reversal_capacity_research.json');
const LOOKBACK_DAYS = 730;
const QUANTILES = [0.300, 0.400, 0.500, 0.600, 0.700, 0.800];
const ACTIVE_LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol'];
const EXIT = EXIT_PROFILES.native_mean6;

function eventKey(event) {
  return `${event.market}:${event.symbol}:${event.signalTime}:${event.side}`;
}

function variants() {
  const rows = [];
  for (const scoreQuantile of QUANTILES) {
    rows.push({
      id: `liquid2_q${Math.round(1000 * scoreQuantile)}`,
      quantileByLayer: {
        liquid_low_vol: scoreQuantile,
        liquid_high_vol: scoreQuantile
      }
    });
    rows.push({
      id: `eligible3_q${Math.round(1000 * scoreQuantile)}`,
      quantileByLayer: Object.fromEntries(ACTIVE_LAYERS.map(layer => [layer, scoreQuantile]))
    });
    rows.push({
      id: `liquid_high_q${Math.round(1000 * scoreQuantile)}`,
      quantileByLayer: { liquid_high_vol: scoreQuantile }
    });
    rows.push({
      id: `liquid_low_q${Math.round(1000 * scoreQuantile)}`,
      quantileByLayer: { liquid_low_vol: scoreQuantile }
    });
  }
  for (const liquidQuantile of [0.400, 0.500, 0.600]) {
    rows.push({
      id: `liquid_q${Math.round(1000 * liquidQuantile)}_tail_high_q900`,
      quantileByLayer: {
        liquid_low_vol: liquidQuantile,
        liquid_high_vol: liquidQuantile,
        tail_high_vol: 0.900
      }
    });
  }
  return rows;
}

function buildLayeredReversalPlans(shortPlans, rawEvents, quantileByLayer, isRapidBull) {
  return shortPlans.map(plan => {
    const trainingStart = plan.startTime - LOOKBACK_DAYS * 86400000;
    const training = rawEvents.filter(event => event.signalTime >= trainingStart && event.entryTime < plan.startTime);
    const cutoffs = training.length >= 1000
      ? Object.fromEntries(Object.entries(quantileByLayer).map(([layer, scoreQuantile]) => [
        layer,
        quantile(training.map(event => event.score), scoreQuantile)
      ]))
      : {};
    const events = !plan.model ? [] : rawEvents.filter(event => {
      const layer = plan.layers.get(event.symbol);
      const cutoff = cutoffs[layer];
      return cutoff != null
        && event.signalTime >= plan.startTime
        && event.signalTime <= plan.endTime
        && event.entryTime <= plan.endTime
        && event.score >= cutoff
        && isRapidBull(event.signalTime);
    }).map(event => ({ ...event, exit: EXIT }));
    return {
      ...plan,
      events,
      reversalTrainingRows: training.length,
      reversalQuantileByLayer: quantileByLayer,
      reversalCutoffByLayer: cutoffs,
      reversalExit: EXIT
    };
  });
}

function combineRegimePlans(shortPlans, longPlans, isRapidBull) {
  return shortPlans.map((shortPlan, index) => {
    const events = new Map();
    for (const event of shortPlan.events) {
      if (!isRapidBull(event.signalTime)) events.set(eventKey(event), event);
    }
    for (const event of longPlans[index].events) events.set(eventKey(event), event);
    return {
      ...shortPlan,
      events: [...events.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score)
    };
  });
}

function pauseRapidBullPlans(shortPlans, isRapidBull) {
  return shortPlans.map(plan => ({
    ...plan,
    events: plan.events.filter(event => !isRapidBull(event.signalTime))
  }));
}

function candidateCounts(plans) {
  const events = plans.flatMap(plan => plan.events);
  return {
    total: events.length,
    longs: events.filter(event => event.side === 1).length,
    shorts: events.filter(event => event.side === -1).length
  };
}

function screenSuperior(row, baseline) {
  return row.id !== 'v11_baseline'
    && row.stress.totalReturn > baseline.stress.totalReturn
    && row.extreme.totalReturn > baseline.extreme.totalReturn
    && row.stress.operationalSignalsPerDay > baseline.stress.operationalSignalsPerDay
    && row.stress.positiveQuarterShare >= baseline.stress.positiveQuarterShare
    && row.stress.lastFourQuarterReturn > 0
    && row.stress.maxDrawdown >= baseline.stress.maxDrawdown - 0.02
    && row.stress.profitFactor >= 1.15
    && row.extreme.profitFactor >= 1
    && row.stress.trades >= 300
    && row.stress.finalSignals === row.stress.executedSignals
    && longSleeveRobust(row.stress, row.extreme);
}

function fullAcceptance(row, plans) {
  const acceptance = diagnostics(row._stressRun, row._extremeRun, plans);
  const declaredLongRobust = longSleeveRobust(row.stress, row.extreme);
  return {
    ...acceptance,
    declaredLongRobust,
    v124Gate: {
      pass: acceptance.gate.pass && declaredLongRobust,
      failures: [
        ...acceptance.gate.failures,
        ...(declaredLongRobust ? [] : ['declaredLongRobust'])
      ]
    }
  };
}

function runVariant(prepared, plans, id, design) {
  console.error(`V12.4 testing ${id}`);
  const stressRun = runScenario(prepared, plans, 'stress', SIMULATION_PORTFOLIO);
  const extremeRun = runScenario(prepared, plans, 'extreme', SIMULATION_PORTFOLIO);
  return {
    id,
    design,
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
  const isRapidBull = rapidBullClassifier(prepared);

  const shortPlanSets = new Map();
  for (const scoreQuantile of [0.850, 0.875]) {
    console.error(`V12.4 building V11 short plans q=${scoreQuantile.toFixed(3)}`);
    shortPlanSets.set(scoreQuantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      trainingScoreQuantile: scoreQuantile,
      tradingSides: [-1]
    }));
  }
  const shortPlans = v11ShortPlans(shortPlanSets);
  const rawReversalEvents = scanReversalLongEvents(prepared);

  const rows = [];
  const plansById = new Map();
  const baseline = runVariant(prepared, shortPlans, 'v11_baseline', { shortMode: 'all', longMode: 'none' });
  rows.push(baseline);
  plansById.set(baseline.id, shortPlans);
  const pausePlans = pauseRapidBullPlans(shortPlans, isRapidBull);
  const pause = runVariant(prepared, pausePlans, 'rapid_bull_pause_shorts', { shortMode: 'pause_rapid_bull', longMode: 'none' });
  rows.push(pause);
  plansById.set(pause.id, pausePlans);

  for (const design of variants()) {
    const reversalPlans = buildLayeredReversalPlans(shortPlans, rawReversalEvents, design.quantileByLayer, isRapidBull);
    const combined = combineRegimePlans(shortPlans, reversalPlans, isRapidBull);
    const id = `replace_rapid_reversal_${design.id}`;
    const row = runVariant(prepared, combined, id, {
      shortMode: 'pause_rapid_bull',
      longMode: 'reversal',
      longRegime: 'rapid_bull',
      quantileByLayer: design.quantileByLayer,
      exit: EXIT
    });
    rows.push(row);
    plansById.set(id, combined);
  }

  assertV11Baseline(baseline);
  for (const row of rows) {
    row.versusV11 = {
      stressReturnDelta: row.stress.totalReturn - baseline.stress.totalReturn,
      extremeReturnDelta: row.extreme.totalReturn - baseline.extreme.totalReturn,
      frequencyDelta: row.stress.operationalSignalsPerDay - baseline.stress.operationalSignalsPerDay,
      maxDrawdownDelta: row.stress.maxDrawdown - baseline.stress.maxDrawdown,
      longSleeveRobust: longSleeveRobust(row.stress, row.extreme),
      screenSuperior: screenSuperior(row, baseline)
    };
  }
  const superior = rows.filter(row => row.versusV11.screenSuperior)
    .sort((a, b) => b.stress.totalReturn - a.stress.totalReturn
      || b.extreme.totalReturn - a.extreme.totalReturn
      || b.stress.operationalSignalsPerDay - a.stress.operationalSignalsPerDay);
  const finalists = [baseline, ...superior.slice(0, 5)];
  for (const row of finalists) {
    console.error(`V12.4 full diagnostics ${row.id}`);
    row.acceptance = fullAcceptance(row, plansById.get(row.id));
  }
  const acceptedSuperior = superior.filter(row => row.acceptance?.v124Gate.pass);
  for (const row of rows) {
    delete row._stressRun;
    delete row._extremeRun;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v12.4-profitable-layer-reversal-capacity-research',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      rawReversalLongEvents: rawReversalEvents.length
    },
    researchDesign: {
      rationale: 'expand V12.3 only through historically positive liquid layers and a separately thresholded tail-high layer',
      quantiles: QUANTILES,
      testedLayers: ACTIVE_LAYERS,
      excludedLayer: 'tail_low_vol',
      exit: EXIT,
      marketRegime: 'BTC EMA20 above EMA50 and trailing 30-day return above 10%',
      portfolio: SIMULATION_PORTFOLIO
    },
    variants: rows,
    bestStrictlySuperior: acceptedSuperior[0]?.id ?? null,
    researchStatus: acceptedSuperior.length
      ? 'HISTORICALLY_SUPERIOR_REVERSAL_CAPACITY_CANDIDATE_FOUND'
      : 'NO_REVERSAL_CAPACITY_CANDIDATE_STRICTLY_SUPERIOR_TO_V11',
    nextAction: acceptedSuperior.length
      ? 'run parameter-neighborhood, leave-one-quarter-out, bootstrap, forward-safety and implementation parity validation'
      : 'do not force higher frequency; retain the rapid-bull pause overlay as a lower-frequency risk improvement',
    caveats: [
      'V12.4 narrows the search after V12.3 and is therefore highly exposed to selection bias.',
      'Any winner remains paper-only and requires a fresh independent forward clock.',
      'No historical result guarantees future profitability or authorizes live trading.'
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
      bestStrictlySuperior: result.bestStrictlySuperior,
      researchStatus: result.researchStatus,
      topByStressReturn: result.variants.slice().sort((a, b) => b.stress.totalReturn - a.stress.totalReturn).slice(0, 12).map(row => ({
        id: row.id,
        stressReturn: row.stress.totalReturn,
        extremeReturn: row.extreme.totalReturn,
        maxDrawdown: row.stress.maxDrawdown,
        frequency: row.stress.operationalSignalsPerDay,
        trades: row.stress.trades,
        longTrades: row.stress.longTrades,
        longPnl: row.stress.longAudit.netPnl,
        longProfitFactor: row.stress.longAudit.profitFactor,
        longWithoutBest5: row.stress.longAudit.profitWithoutBest5,
        positiveQuarterShare: row.stress.positiveQuarterShare,
        screenSuperior: row.versusV11.screenSuperior,
        gate: row.acceptance?.v124Gate
      }))
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  QUANTILES,
  variants,
  buildLayeredReversalPlans,
  combineRegimePlans,
  screenSuperior,
  runAll
};
