const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { loadPrepared } = require('./v41_run');
const { CONFIGS } = require('./v5d_breakout');
const { FEATURE_NAMES } = require('./v7_ml');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'v5c_data');
const AUDIT_FILE = path.join(DATA_DIR, 'v6_event_metrics_audit.json');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v92_results.json');
const CANDIDATE_FILE = path.join(ROOT, 'forward_candidate_v92.json');
const FORWARD_START = Date.parse('2026-07-16T00:00:00Z');
const FORWARD_END = Date.parse('2026-09-30T20:00:00Z');
const FEATURE_SET = FEATURE_NAMES.filter(name => name !== 'logOpenInterest');
const SETTINGS = {
  lookbackDays: 730,
  minimumTrainingRows: 2500,
  ridgeLambda: 1,
  featureNames: FEATURE_SET,
  trainingScoreQuantile: 0.825,
  scoreFloor: 0,
  trainingSides: [-1, 1],
  tradingSides: [-1],
  trainingMarkets: ['um', 'cm'],
  tradingMarkets: ['um'],
  tradingLayers: ['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol']
};

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

function compactPlans(plans) {
  return plans.map(plan => ({
    startTime: plan.startTime,
    endTime: plan.endTime,
    trainingStart: plan.trainingStart,
    trainingEnd: plan.trainingEnd,
    trainingRows: plan.trainingRows,
    oosRows: plan.oosRows,
    scoreCutoff: plan.scoreCutoff,
    scoreQuantile: plan.scoreQuantile,
    modelCandidates: plan.events.length,
    reason: plan.reason,
    model: compactModel(plan.model)
  }));
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  console.error(`V9.2 loaded ${prepared.length} histories and ${auditedEvents.length} audited events`);
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const plans = buildWalkForwardPlans(prepared, labeled.rows, SETTINGS);
  const baseRun = runScenario(prepared, plans, 'base');
  const stressRun = runScenario(prepared, plans, 'stress');
  const extremeRun = runScenario(prepared, plans, 'extreme');
  const acceptance = diagnostics(stressRun, extremeRun, plans);
  const forwardPlan = buildWalkForwardPlans(prepared, labeled.rows, {
    ...SETTINGS,
    folds: [{ startTime: FORWARD_START, endTime: FORWARD_END }]
  })[0];
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'all-perpetuals-unit-safe-layer-screened-short-v9.2',
    evidenceStatus: 'historical_research_after_v74_forward_failure',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      scannedMarkets: ['um', 'cm'],
      eligibleMarkets: ['um'],
      quarantinedMarkets: {
        cm: 'absolute open-interest-value units differ from USD-M and the prior selected training sample was not robust after removing its best trades'
      },
      auditedEvents: auditedEvents.length,
      metricsAvailableBeforeEntry: labeled.available,
      labeledEligibleEvents: labeled.rows.length,
      eligibleTrainingLabels: labeled.rows.filter(row => row.event.market === 'um').length
    },
    design: {
      ...SETTINGS,
      event: CONFIGS.find(config => config.configId === 'broad'),
      excludedFeatures: ['logOpenInterest'],
      disabledLayers: ['tail_low_vol'],
      exit: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 },
      portfolio: { riskPerTrade: 0.0025, maxSignalsPerBar: 2, maxSignalsPerDay: 2, maxPositions: 6, maxGross: 1.5 }
    },
    base: baseRun.summary,
    stress: stressRun.summary,
    extreme: extremeRun.summary,
    quarterlyStress: stressRun.quarters,
    acceptance,
    plans: compactPlans(plans),
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
    caveats: [
      'The failed V7.4 forward interval through 2026-07-15 influenced this redesign, so V9 requires a new holdout beginning 2026-07-16.',
      'COIN-M remains scanned but is quarantined until it has a unit-consistent model and enough independent evidence.',
      'Quarterly model weights may refresh on a fixed schedule using past data only; changing rules, features, thresholds, costs or gates resets the forward clock.',
      'Passing historical gates does not prove future profitability.',
      'Four-hour OHLC, order-book depth, partial fills, liquidation, ADL, outages and tail gaps are not fully modeled.'
    ]
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v92_signals.csv'), serializeCsv(stressRun.finalSignals.map(event => ({ ...event, ...event.metrics })), [
    'signalTime','entryTime','market','symbol','baseAsset','layer','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr',
    'metricsSourceTime','oiChange24h','openInterestValue','topTraderAccountRatio','topTraderPositionRatio','accountRatio','takerRatio'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v92_trades.csv'), serializeCsv(stressRun.trades, [
    'signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','side','score','entryPrice','exitPrice','qty','notional',
    'grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v92_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','positions','grossExposure']));
  const resultSha256 = hashFile(RESULT_FILE);
  if (acceptance.gate.pass && forwardPlan.model) {
    const candidate = {
      frozenAt: new Date().toISOString(),
      version: 'v9.2-forward-2026q3b',
      authorization: 'PAPER_ONLY',
      liveOrdersEnabled: false,
      validFrom: FORWARD_START,
      validThrough: FORWARD_END,
      developmentDataObservedThrough: Date.parse('2026-07-15T20:00:00Z'),
      sourceResult: path.relative(ROOT, RESULT_FILE).replaceAll('\\', '/'),
      sourceResultSha256: resultSha256,
      historicalGatePassed: true,
      scannedMarkets: ['um', 'cm'],
      eligibleMarkets: ['um'],
      eligibleLayers: SETTINGS.tradingLayers,
      event: CONFIGS.find(config => config.configId === 'broad'),
      direction: 'short_only',
      layerAssignments: Object.fromEntries(forwardPlan.layers),
      model: compactModel(forwardPlan.model),
      scoreCutoff: forwardPlan.scoreCutoff,
      scoreQuantile: forwardPlan.scoreQuantile,
      trainingRows: forwardPlan.trainingRows,
      trainingStart: forwardPlan.trainingStart,
      trainingEnd: forwardPlan.trainingEnd,
      exit: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 },
      portfolio: { riskPerTrade: 0.0025, maxSignalsPerBar: 2, maxSignalsPerDay: 2, maxPositions: 6, maxGross: 1.5 },
      forwardGate: result.forwardGate,
      forwardValidationState: {
        observedThrough: Date.parse('2026-07-15T20:00:00Z'),
        calendarDays: 0,
        executedTrades: 0,
        status: 'NOT_STARTED'
      }
    };
    fs.writeFileSync(CANDIDATE_FILE, JSON.stringify(candidate, null, 2));
  }
  return {
    resultFile: RESULT_FILE,
    candidateFile: acceptance.gate.pass && forwardPlan.model ? CANDIDATE_FILE : null,
    resultSha256,
    base: result.base,
    stress: result.stress,
    extreme: result.extreme,
    acceptance,
    forward: {
      trainingRows: forwardPlan.trainingRows,
      scoreCutoff: forwardPlan.scoreCutoff,
      validFrom: FORWARD_START,
      validThrough: FORWARD_END
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

module.exports = { FEATURE_SET, SETTINGS, runAll };
