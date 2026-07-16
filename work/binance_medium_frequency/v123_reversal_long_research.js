const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { familySignalAt } = require('./v41_engine');
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

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v123_reversal_long_research.json');
const LOOKBACK_DAYS = 730;
const SCORE_QUANTILES = [0.800, 0.900, 0.950, 0.975];
const LAYER_GROUPS = {
  all4: new Set(['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol']),
  eligible3: new Set(['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol']),
  liquid2: new Set(['liquid_low_vol', 'liquid_high_vol'])
};
const EXIT_PROFILES = {
  native_mean6: { stopAtr: 1.5, trailAtr: null, maxHoldBars: 6, meanExitEma20: true },
  time6: { stopAtr: 1.5, trailAtr: null, maxHoldBars: 6 },
  trail12: { stopAtr: 1.8, trailAtr: 2.5, maxHoldBars: 12 }
};

function eventKey(event) {
  return `${event.market}:${event.symbol}:${event.signalTime}:${event.side}`;
}

function scanReversalLongEvents(prepared) {
  const best = new Map();
  let complete = 0;
  for (const item of prepared.filter(row => row.market === 'um')) {
    for (let index = 50; index < item.bars.length - 1; index++) {
      const signal = familySignalAt(item, index, 'reversal');
      if (!signal || signal.side !== 1) continue;
      const bar = item.bars[index];
      const day = new Date(bar.openTime).toISOString().slice(0, 10);
      const key = `${item.market}:${item.symbol}:${day}`;
      const event = {
        market: item.market,
        symbol: item.symbol,
        baseAsset: item.baseAsset,
        side: 1,
        score: signal.score,
        rawReversalScore: signal.score,
        signalTime: bar.openTime,
        entryTime: item.bars[index + 1].openTime,
        configId: 'ml',
        type: 'reversal_long'
      };
      if (!best.has(key) || event.score > best.get(key).score) best.set(key, event);
    }
    complete++;
    if (complete % 100 === 0) console.error(`V12.3 scanned reversal histories ${complete}`);
  }
  return [...best.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score);
}

function buildReversalPlans(shortPlans, rawEvents, scoreQuantile, layerGroup, exitProfile, isRapidBull) {
  const allowedLayers = LAYER_GROUPS[layerGroup];
  const exit = EXIT_PROFILES[exitProfile];
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
        && allowedLayers.has(layer)
        && isRapidBull(event.signalTime);
    }).map(event => ({ ...event, exit }));
    return {
      ...plan,
      events,
      reversalTrainingRows: training.length,
      reversalScoreQuantile: scoreQuantile,
      reversalScoreCutoff: cutoff,
      reversalLayerGroup: layerGroup,
      reversalExitProfile: exitProfile
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
    v123Gate: {
      pass: acceptance.gate.pass && declaredLongRobust,
      failures: [
        ...acceptance.gate.failures,
        ...(declaredLongRobust ? [] : ['declaredLongRobust'])
      ]
    }
  };
}

function runVariant(prepared, plans, id, design) {
  console.error(`V12.3 testing ${id}`);
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
    console.error(`V12.3 building V11 short plans q=${scoreQuantile.toFixed(3)}`);
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

  for (const scoreQuantile of SCORE_QUANTILES) {
    for (const layerGroup of Object.keys(LAYER_GROUPS)) {
      for (const exitProfile of Object.keys(EXIT_PROFILES)) {
        const reversalPlans = buildReversalPlans(shortPlans, rawReversalEvents, scoreQuantile, layerGroup, exitProfile, isRapidBull);
        const combined = combineRegimePlans(shortPlans, reversalPlans, isRapidBull);
        const id = `replace_rapid_with_reversal_q${Math.round(1000 * scoreQuantile)}_${layerGroup}_${exitProfile}`;
        const row = runVariant(prepared, combined, id, {
          shortMode: 'pause_rapid_bull',
          longMode: 'reversal',
          longRegime: 'rapid_bull',
          scoreQuantile,
          layerGroup,
          exitProfile
        });
        rows.push(row);
        plansById.set(id, combined);
      }
    }
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
  const finalists = [baseline, ...superior.slice(0, 3)];
  for (const row of finalists) {
    console.error(`V12.3 full diagnostics ${row.id}`);
    row.acceptance = fullAcceptance(row, plansById.get(row.id));
  }
  const acceptedSuperior = superior.filter(row => row.acceptance?.v123Gate.pass);
  for (const row of rows) {
    delete row._stressRun;
    delete row._extremeRun;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v12.3-rapid-bull-volume-shock-reversal-long-regime-switch-research',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      scannedMarkets: ['um', 'cm'],
      reversalEligibleMarkets: ['um'],
      rawReversalLongEvents: rawReversalEvents.length
    },
    reversalDesign: {
      direction: 'long_only',
      symbolCondition: '6-bar decline below -2.5 ATR, quote volume above 1.5 times its prior median, and symbol EMA20/EMA50 gap below 8%',
      marketRegime: 'BTC EMA20 above EMA50 and BTC trailing 30-day return above 10%',
      dailyDeduplication: 'best score per symbol per UTC day',
      scoreLookbackDays: LOOKBACK_DAYS,
      scoreQuantiles: SCORE_QUANTILES,
      minimumTrainingEvents: 1000,
      testedLayerGroups: Object.fromEntries(Object.entries(LAYER_GROUPS).map(([name, layers]) => [name, [...layers]])),
      testedExits: EXIT_PROFILES,
      portfolio: SIMULATION_PORTFOLIO
    },
    variants: rows,
    bestStrictlySuperior: acceptedSuperior[0]?.id ?? null,
    researchStatus: acceptedSuperior.length
      ? 'HISTORICALLY_SUPERIOR_REVERSAL_LONG_REGIME_SWITCH_FOUND'
      : 'NO_REVERSAL_LONG_REGIME_SWITCH_STRICTLY_SUPERIOR_TO_V11',
    nextAction: acceptedSuperior.length
      ? 'formalize the winning rules and run anti-overfit, parameter-neighborhood, forward-safety and implementation parity validation'
      : 'stop adding long sleeves to V11; use the rapid-bull pause overlay as the only supported bull-risk improvement and keep live trading disabled pending forward evidence',
    caveats: [
      'This is a final bounded long-family screen after shared-model, separate-model and momentum-long failures.',
      'The threshold, layer and exit grid was evaluated on previously exposed history and carries multiple-testing risk.',
      'COIN-M remains excluded from execution pending an inverse-contract-safe sizing engine.',
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
      rawReversalLongEvents: result.universe.rawReversalLongEvents,
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
        screenSuperior: row.versusV11.screenSuperior
      }))
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  SCORE_QUANTILES,
  LAYER_GROUPS,
  EXIT_PROFILES,
  scanReversalLongEvents,
  buildReversalPlans,
  combineRegimePlans,
  screenSuperior,
  runAll
};
