const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const {
  buildLabeledRows,
  buildWalkForwardPlans,
  runScenario
} = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { SETTINGS } = require('./v92_run');
const {
  SIMULATION_PORTFOLIO,
  rapidBullClassifier,
  v11ShortPlans,
  compactRun,
  longSleeveRobust,
  assertV11Baseline
} = require('./v12_long_short_research');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v121_separate_long_research.json');
const LONG_QUANTILES = [0.400, 0.500, 0.600, 0.700, 0.800, 0.900];
const LONG_FEATURES = [
  'directionalPremiumZ',
  'directionalPremiumBps',
  'barTakerImbalance',
  'metricsTakerLog',
  'topTraderPositionLog',
  'oiChange24h',
  'logVolumeRatio',
  'breakoutAtr',
  'marketCm',
  'layerLiquid',
  'layerHighVol'
];
const LAYER_GROUPS = {
  all4: new Set(['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol']),
  eligible3: new Set(['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol']),
  liquid2: new Set(['liquid_low_vol', 'liquid_high_vol'])
};

function eventKey(event) {
  return `${event.market}:${event.symbol}:${event.signalTime}:${event.side}`;
}

function buildModules() {
  const modules = [];
  for (const quantile of LONG_QUANTILES) {
    modules.push({ id: `long_q${String(Math.round(1000 * quantile)).padStart(3, '0')}_ema_all4`, quantile, regime: 'ema_bull', layerGroup: 'all4' });
    modules.push({ id: `long_q${String(Math.round(1000 * quantile)).padStart(3, '0')}_rapid_all4`, quantile, regime: 'rapid_bull', layerGroup: 'all4' });
  }
  for (const regime of ['ema_bull', 'rapid_bull']) {
    for (const layerGroup of ['eligible3', 'liquid2']) {
      modules.push({ id: `long_q600_${regime}_${layerGroup}`, quantile: 0.600, regime, layerGroup });
    }
  }
  return modules;
}

function regimeClassifiers(prepared) {
  const btc = prepared.find(row => row.market === 'um' && row.symbol === 'BTCUSDT');
  if (!btc) throw new Error('BTCUSDT USD-M history is required');
  const rapidBull = rapidBullClassifier(prepared);
  return {
    rapid_bull: rapidBull,
    ema_bull: time => {
      const index = btc.indexByTime.get(time);
      return index != null
        && Number.isFinite(btc.ema20[index])
        && Number.isFinite(btc.ema50[index])
        && btc.ema20[index] > btc.ema50[index];
    }
  };
}

function combinePlans(shortPlans, longPlanSets, module, shortMode, regimes) {
  return shortPlans.map((shortPlan, index) => {
    const events = new Map();
    for (const event of shortPlan.events) {
      if (shortMode === 'all' || !regimes.rapid_bull(event.signalTime)) {
        events.set(eventKey(event), event);
      }
    }
    if (shortPlan.model) {
      const source = longPlanSets.get(module.quantile)[index];
      const allowedLayers = LAYER_GROUPS[module.layerGroup];
      for (const event of source.events) {
        const layer = source.layers.get(event.symbol);
        if (event.side === 1 && allowedLayers.has(layer) && regimes[module.regime](event.signalTime)) {
          events.set(eventKey(event), event);
        }
      }
    }
    return {
      ...shortPlan,
      events: [...events.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score),
      longModule: module.id,
      shortMode
    };
  });
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

function candidateCounts(plans) {
  const events = plans.flatMap(plan => plan.events);
  return {
    total: events.length,
    longs: events.filter(event => event.side === 1).length,
    shorts: events.filter(event => event.side === -1).length
  };
}

function fullAcceptance(row, plans) {
  const acceptance = diagnostics(row._stressRun, row._extremeRun, plans);
  const declaredLongRobust = longSleeveRobust(row.stress, row.extreme);
  return {
    ...acceptance,
    declaredLongRobust,
    v121Gate: {
      pass: acceptance.gate.pass && declaredLongRobust,
      failures: [
        ...acceptance.gate.failures,
        ...(declaredLongRobust ? [] : ['declaredLongRobust'])
      ]
    }
  };
}

function runAll() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const regimes = regimeClassifiers(prepared);

  const shortPlanSets = new Map();
  for (const quantile of [0.850, 0.875]) {
    console.error(`V12.1 building V11 short plans q=${quantile.toFixed(3)}`);
    shortPlanSets.set(quantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      trainingScoreQuantile: quantile,
      tradingSides: [-1]
    }));
  }
  const shortPlans = v11ShortPlans(shortPlanSets);

  const longPlanSets = new Map();
  for (const quantile of LONG_QUANTILES) {
    console.error(`V12.1 building separate long plans q=${quantile.toFixed(3)}`);
    longPlanSets.set(quantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      minimumTrainingRows: 100,
      ridgeLambda: 5,
      featureNames: LONG_FEATURES,
      trainingScoreQuantile: quantile,
      scoreFloor: 0,
      trainingSides: [1],
      tradingSides: [1],
      tradingLayers: [...LAYER_GROUPS.all4]
    }));
  }

  const baselineStress = runScenario(prepared, shortPlans, 'stress', SIMULATION_PORTFOLIO);
  const baselineExtreme = runScenario(prepared, shortPlans, 'extreme', SIMULATION_PORTFOLIO);
  const rows = [{
    id: 'v11_baseline',
    shortMode: 'all',
    longModule: null,
    candidateCounts: candidateCounts(shortPlans),
    stress: compactRun(baselineStress, shortPlans),
    extreme: compactRun(baselineExtreme, shortPlans),
    _stressRun: baselineStress,
    _extremeRun: baselineExtreme
  }];
  const plansById = new Map([['v11_baseline', shortPlans]]);

  for (const module of buildModules()) {
    for (const shortMode of ['pause_rapid_bull', 'all']) {
      const id = `${shortMode}__${module.id}`;
      console.error(`V12.1 testing ${id}`);
      const plans = combinePlans(shortPlans, longPlanSets, module, shortMode, regimes);
      const stressRun = runScenario(prepared, plans, 'stress', SIMULATION_PORTFOLIO);
      const extremeRun = runScenario(prepared, plans, 'extreme', SIMULATION_PORTFOLIO);
      plansById.set(id, plans);
      rows.push({
        id,
        shortMode,
        longModule: module,
        candidateCounts: candidateCounts(plans),
        stress: compactRun(stressRun, plans),
        extreme: compactRun(extremeRun, plans),
        _stressRun: stressRun,
        _extremeRun: extremeRun
      });
    }
  }

  const baseline = rows[0];
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
  const finalists = [baseline, ...superior.slice(0, 3)];
  for (const row of finalists) {
    console.error(`V12.1 full diagnostics ${row.id}`);
    row.acceptance = fullAcceptance(row, plansById.get(row.id));
  }
  const acceptedSuperior = superior.filter(row => row.acceptance?.v121Gate.pass);
  for (const row of rows) {
    delete row._stressRun;
    delete row._extremeRun;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v12.1-separately-trained-causal-long-regime-combination-research',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      auditedEvents: auditedEvents.length,
      labeledEligibleEvents: labeled.rows.length,
      longLabels: labeled.rows.filter(row => row.event.side === 1).length
    },
    longModel: {
      features: LONG_FEATURES,
      lookbackDays: SETTINGS.lookbackDays,
      minimumTrainingRows: 100,
      ridgeLambda: 5,
      quantiles: LONG_QUANTILES,
      trainingSides: [1],
      tradingSides: [1],
      trainingMarkets: SETTINGS.trainingMarkets,
      tradingMarkets: SETTINGS.tradingMarkets,
      testedRegimes: ['BTC EMA20 above EMA50', 'BTC EMA20 above EMA50 and trailing 30-day return above 10%'],
      testedLayerGroups: Object.fromEntries(Object.entries(LAYER_GROUPS).map(([name, layers]) => [name, [...layers]]))
    },
    variants: rows,
    bestStrictlySuperior: acceptedSuperior[0]?.id ?? null,
    researchStatus: acceptedSuperior.length
      ? 'HISTORICALLY_SUPERIOR_SEPARATE_LONG_CANDIDATE_FOUND'
      : 'NO_SEPARATE_LONG_CANDIDATE_STRICTLY_SUPERIOR_TO_V11',
    nextAction: acceptedSuperior.length
      ? 'formalize the winning V12.1 rule and run anti-overfit, forward-safety and implementation parity tests'
      : 'retain the rapid-bull short pause as a risk overlay candidate and test a structurally different momentum long event family',
    caveats: [
      'The long sample is much smaller than the short sample, so the long model uses stronger regularization and remains more uncertain.',
      'The candidate grid was evaluated on previously exposed history and carries multiple-testing risk.',
      'A historical winner would remain paper-only and would restart the independent forward clock.',
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
      topByStressReturn: result.variants.slice().sort((a, b) => b.stress.totalReturn - a.stress.totalReturn).slice(0, 8).map(row => ({
        id: row.id,
        stressReturn: row.stress.totalReturn,
        extremeReturn: row.extreme.totalReturn,
        frequency: row.stress.operationalSignalsPerDay,
        trades: row.stress.trades,
        longTrades: row.stress.longTrades,
        longPnl: row.stress.longAudit.netPnl,
        longProfitFactor: row.stress.longAudit.profitFactor,
        longWithoutBest5: row.stress.longAudit.profitWithoutBest5,
        screenSuperior: row.versusV11.screenSuperior
      }))
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  LONG_QUANTILES,
  LONG_FEATURES,
  LAYER_GROUPS,
  buildModules,
  regimeClassifiers,
  combinePlans,
  screenSuperior,
  runAll
};
