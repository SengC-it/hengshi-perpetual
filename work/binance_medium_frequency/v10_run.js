const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { loadPrepared } = require('./v41_run');
const { CONFIGS } = require('./v5d_breakout');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { FEATURE_SET, SETTINGS } = require('./v92_run');
const { mergePlans } = require('./v10_layer_research');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v10_results.json');
const CANDIDATE_FILE = path.join(ROOT, 'forward_candidate_v10.json');
const FORWARD_START = Date.parse('2026-07-17T00:00:00Z');
const FORWARD_END = Date.parse('2026-09-30T20:00:00Z');
const DEVELOPMENT_OBSERVED_THROUGH = Date.parse('2026-07-15T20:00:00Z');
const QUANTILE_BY_LAYER = {
  liquid_low_vol: 0.850,
  liquid_high_vol: 0.850,
  tail_high_vol: 0.875
};
const PORTFOLIO = {
  riskPerTrade: 0.0025,
  maxSignalsPerBar: 3,
  maxSignalsPerDay: 3,
  maxPositions: 8,
  maxGross: 1.5
};

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compactModel(model) {
  return model && {
    featureNames: model.featureNames,
    lambda: model.lambda,
    intercept: model.intercept,
    coefficients: model.coefficients,
    means: model.means,
    scales: model.scales
  };
}

function scoreCutoffs(plan85, plan875) {
  return {
    liquid_low_vol: plan85.scoreCutoff,
    liquid_high_vol: plan85.scoreCutoff,
    tail_high_vol: plan875.scoreCutoff
  };
}

function compactPlans(plans, plans85, plans875) {
  return plans.map((plan, index) => ({
    startTime: plan.startTime,
    endTime: plan.endTime,
    trainingStart: plan.trainingStart,
    trainingEnd: plan.trainingEnd,
    trainingRows: plan.trainingRows,
    oosRows: plan.oosRows,
    modelCandidates: plan.events.length,
    scoreQuantileByLayer: QUANTILE_BY_LAYER,
    scoreCutoffByLayer: scoreCutoffs(plans85[index], plans875[index]),
    reason: plan.reason,
    model: compactModel(plan.model)
  }));
}

function runAll(options = {}) {
  const label = options.label ?? 'V10';
  const strategyVersion = options.strategyVersion ?? 'all-perpetuals-unit-safe-layer-threshold-capacity-v10';
  const candidateVersion = options.candidateVersion ?? 'v10-forward-2026q3';
  const resultFile = options.resultFile ?? RESULT_FILE;
  const candidateFile = options.candidateFile ?? CANDIDATE_FILE;
  const outputPrefix = options.outputPrefix ?? 'binance_all_perpetuals_v10';
  const portfolio = options.portfolio ?? PORTFOLIO;
  const benchmarkName = options.benchmarkName ?? 'V92';
  const benchmark = options.benchmark ?? {
    stressReturn: 0.11153414057729161,
    extremeReturn: 0.07539163937478022,
    operationalSignalsPerDay: 0.5632429137458091,
    trades: 308
  };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  console.error(`${label} loaded ${prepared.length} histories and ${auditedEvents.length} audited events`);
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const settings85 = { ...SETTINGS, featureNames: FEATURE_SET, trainingScoreQuantile: 0.850 };
  const settings875 = { ...SETTINGS, featureNames: FEATURE_SET, trainingScoreQuantile: 0.875 };
  const plans85 = buildWalkForwardPlans(prepared, labeled.rows, settings85);
  const plans875 = buildWalkForwardPlans(prepared, labeled.rows, settings875);
  const plans = mergePlans(new Map([[0.850, plans85], [0.875, plans875]]), QUANTILE_BY_LAYER);
  const simulationPortfolio = {
    maxPerBar: portfolio.maxSignalsPerBar,
    maxPerDay: portfolio.maxSignalsPerDay,
    maxPositions: portfolio.maxPositions
  };
  const baseRun = runScenario(prepared, plans, 'base', simulationPortfolio);
  const stressRun = runScenario(prepared, plans, 'stress', simulationPortfolio);
  const extremeRun = runScenario(prepared, plans, 'extreme', simulationPortfolio);
  const acceptance = diagnostics(stressRun, extremeRun, plans);

  const forwardFolds = [{ startTime: FORWARD_START, endTime: FORWARD_END }];
  const forward85 = buildWalkForwardPlans(prepared, labeled.rows, { ...settings85, folds: forwardFolds })[0];
  const forward875 = buildWalkForwardPlans(prepared, labeled.rows, { ...settings875, folds: forwardFolds })[0];
  if (!forward85.model || !forward875.model) throw new Error(`${label} forward model is unavailable`);
  if (hashObject(compactModel(forward85.model)) !== hashObject(compactModel(forward875.model))) {
    throw new Error(`${label} layer plans produced inconsistent forward models`);
  }

  const comparison = {
    stressReturnDelta: stressRun.summary.totalReturn - benchmark.stressReturn,
    extremeReturnDelta: extremeRun.summary.totalReturn - benchmark.extremeReturn,
    operationalSignalsPerDayDelta: acceptance.operationalSignalsPerDay - benchmark.operationalSignalsPerDay,
    tradesDelta: stressRun.summary.trades - benchmark.trades
  };
  const result = {
    generatedAt: new Date().toISOString(),
    version: strategyVersion,
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      scannedMarkets: ['um', 'cm'],
      eligibleMarkets: ['um'],
      auditedEvents: auditedEvents.length,
      metricsAvailableBeforeEntry: labeled.available,
      labeledEligibleEvents: labeled.rows.length
    },
    design: {
      ...SETTINGS,
      featureNames: FEATURE_SET,
      trainingScoreQuantile: undefined,
      scoreQuantileByLayer: QUANTILE_BY_LAYER,
      event: CONFIGS.find(config => config.configId === 'broad'),
      direction: 'short_only',
      excludedFeatures: ['logOpenInterest'],
      disabledLayers: ['tail_low_vol'],
      exit: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 },
      portfolio
    },
    base: baseRun.summary,
    stress: stressRun.summary,
    extreme: extremeRun.summary,
    quarterlyStress: stressRun.quarters,
    acceptance,
    plans: compactPlans(plans, plans85, plans875),
    [`versus${benchmarkName}`]: comparison,
    liveStatus: acceptance.gate.pass ? 'PAPER_ONLY_FROZEN_FORWARD' : 'LIVE_DISABLED',
    forwardGate: {
      minimumCalendarDays: 180,
      minimumExecutedTrades: 50,
      minimumStressProfitFactor: 1.15,
      maximumDrawdown: -0.20,
      noRuleChanges: true,
      scheduledQuarterlyRefitsAllowed: true,
      ruleChangeResetsClock: true
    },
    caveats: options.caveats ?? [
      `${label} was selected on previously exposed history and is not independent evidence.`,
      `${label} replaces the prior preferred paper candidate; this rule change starts a new forward clock.`,
      'COIN-M remains scanned but is not eligible for execution.',
      'Four-hour OHLC, order-book depth, partial fills, liquidation, ADL, outages and tail gaps are not fully modeled.',
      'Passing historical gates does not prove future profitability.'
    ]
  };
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${outputPrefix}_signals.csv`), serializeCsv(stressRun.finalSignals.map(event => ({ ...event, ...event.metrics })), [
    'signalTime','entryTime','market','symbol','baseAsset','layer','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr',
    'metricsSourceTime','oiChange24h','openInterestValue','topTraderAccountRatio','topTraderPositionRatio','accountRatio','takerRatio'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${outputPrefix}_trades.csv`), serializeCsv(stressRun.trades, [
    'signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','side','score','entryPrice','exitPrice','qty','notional',
    'grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${outputPrefix}_equity.csv`), serializeCsv(stressRun.equity, ['time','equity','cash','positions','grossExposure']));

  const resultSha256 = hashFile(resultFile);
  if (acceptance.gate.pass) {
    const candidate = {
      frozenAt: new Date().toISOString(),
      version: candidateVersion,
      authorization: 'PAPER_ONLY',
      liveOrdersEnabled: false,
      validFrom: FORWARD_START,
      validThrough: FORWARD_END,
      developmentDataObservedThrough: DEVELOPMENT_OBSERVED_THROUGH,
      sourceResult: path.relative(ROOT, resultFile).replaceAll('\\', '/'),
      sourceResultSha256: resultSha256,
      historicalGatePassed: true,
      scannedMarkets: ['um', 'cm'],
      eligibleMarkets: ['um'],
      eligibleLayers: Object.keys(QUANTILE_BY_LAYER),
      event: CONFIGS.find(config => config.configId === 'broad'),
      direction: 'short_only',
      layerAssignments: Object.fromEntries(forward85.layers),
      model: compactModel(forward85.model),
      scoreQuantileByLayer: QUANTILE_BY_LAYER,
      scoreCutoffByLayer: scoreCutoffs(forward85, forward875),
      trainingRows: forward85.trainingRows,
      trainingStart: forward85.trainingStart,
      trainingEnd: forward85.trainingEnd,
      exit: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 },
      portfolio,
      forwardGate: result.forwardGate,
      forwardValidationState: {
        observedThrough: DEVELOPMENT_OBSERVED_THROUGH,
        calendarDays: 0,
        executedTrades: 0,
        status: 'NOT_STARTED'
      }
    };
    fs.writeFileSync(candidateFile, JSON.stringify(candidate, null, 2));
  }

  return {
    resultFile,
    candidateFile: acceptance.gate.pass ? candidateFile : null,
    resultSha256,
    base: result.base,
    stress: result.stress,
    extreme: result.extreme,
    acceptance,
    comparison,
    forward: {
      validFrom: FORWARD_START,
      validThrough: FORWARD_END,
      trainingRows: forward85.trainingRows,
      scoreCutoffByLayer: scoreCutoffs(forward85, forward875)
    }
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runAll(), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { QUANTILE_BY_LAYER, PORTFOLIO, scoreCutoffs, runAll };
