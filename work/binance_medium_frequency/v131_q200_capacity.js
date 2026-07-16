const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { SETTINGS } = require('./v92_run');
const {
  v11ShortPlans,
  compactRun,
  longSleeveRobust,
  assertV11Baseline
} = require('./v12_long_short_research');
const { scanReversalLongEvents } = require('./v123_reversal_long_research');
const {
  buildLayeredReversalPlans,
  combineRegimePlans
} = require('./v124_reversal_capacity_research');
const { BASE_REGIME, regimeClassifier } = require('./v125_reversal_robustness');
const { leaveOneOutAudit } = require('./v126_predeclared_candidate_comparison');
const { strictlyBetter } = require('./v13_capacity_diversification');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const V124_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v124_reversal_capacity_research.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v131_q200_capacity.json');
const QUANTILE_BY_LAYER = {
  liquid_low_vol: 0.200,
  liquid_high_vol: 0.200,
  tail_high_vol: 0.200
};
const CAPACITIES = [
  { id: 'bar5_day5_pos9', maxPerBar: 5, maxPerDay: 5, maxPositions: 9 },
  { id: 'bar5_day7_pos12', maxPerBar: 5, maxPerDay: 7, maxPositions: 12 },
  { id: 'bar8_day8_pos12', maxPerBar: 8, maxPerDay: 8, maxPositions: 12 },
  { id: 'bar10_day10_pos15', maxPerBar: 10, maxPerDay: 10, maxPositions: 15 }
];

function benchmarkV124() {
  const result = JSON.parse(fs.readFileSync(V124_FILE, 'utf8'));
  const row = result.variants.find(item => item.id === 'replace_rapid_reversal_eligible3_q300');
  if (!row) throw new Error('V12.4 benchmark is missing');
  return row;
}

function runAll() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const benchmark = benchmarkV124();
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const inRegime = regimeClassifier(prepared, BASE_REGIME);

  const shortPlanSets = new Map();
  for (const scoreQuantile of [0.850, 0.875]) {
    console.error(`V13.1 building V11 short plans q=${scoreQuantile.toFixed(3)}`);
    shortPlanSets.set(scoreQuantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      trainingScoreQuantile: scoreQuantile,
      tradingSides: [-1]
    }));
  }
  const shortPlans = v11ShortPlans(shortPlanSets);
  const rawReversalEvents = scanReversalLongEvents(prepared);
  const longPlans = buildLayeredReversalPlans(
    shortPlans,
    rawReversalEvents,
    QUANTILE_BY_LAYER,
    inRegime
  );
  const plans = combineRegimePlans(shortPlans, longPlans, inRegime);

  const v11Stress = runScenario(prepared, shortPlans, 'stress', CAPACITIES[0]);
  const v11Extreme = runScenario(prepared, shortPlans, 'extreme', CAPACITIES[0]);
  assertV11Baseline({
    stress: compactRun(v11Stress, shortPlans),
    extreme: compactRun(v11Extreme, shortPlans)
  });

  const rows = [];
  for (const capacity of CAPACITIES) {
    console.error(`V13.1 testing ${capacity.id}`);
    const stressRun = runScenario(prepared, plans, 'stress', capacity);
    const extremeRun = runScenario(prepared, plans, 'extreme', capacity);
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
      ...capacity,
      riskPerTrade: 0.0025,
      maxGross: 1.5,
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
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v13.1-predeclared-q200-reversal-capacity-validation',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      rawReversalLongEvents: rawReversalEvents.length
    },
    design: {
      source: 'V12.5 predeclared score_q200 neighborhood',
      quantileByLayer: QUANTILE_BY_LAYER,
      regime: BASE_REGIME,
      riskPerTrade: 0.0025,
      maxGross: 1.5
    },
    benchmark: {
      stress: benchmark.stress,
      extreme: benchmark.extreme
    },
    variants: rows,
    bestValidatedCandidate: valid[0]?.id ?? null,
    validationPass: valid.length > 0,
    researchStatus: valid.length
      ? 'V13_1_Q200_CAPACITY_CANDIDATE_VALIDATED'
      : 'NO_V13_1_Q200_CAPACITY_CANDIDATE_VALIDATED',
    nextAction: valid.length
      ? 'run forward implementation parity and frozen-rule validation'
      : 'use a causally trained reversal selector; neither threshold broadening nor capacity expansion solved the concentration problem',
    caveats: [
      'q0.20 was declared before this capacity comparison in V12.5.',
      'Gross exposure and per-trade risk remain unchanged.',
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
      researchStatus: result.researchStatus,
      validationPass: result.validationPass,
      bestValidatedCandidate: result.bestValidatedCandidate,
      variants: result.variants.map(row => ({
        id: row.id,
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

module.exports = { QUANTILE_BY_LAYER, CAPACITIES, runAll };
