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
const {
  BASE_REGIME,
  regimeClassifier
} = require('./v125_reversal_robustness');
const { leaveOneOutAudit } = require('./v126_predeclared_candidate_comparison');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const V124_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v124_reversal_capacity_research.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v13_capacity_diversification.json');
const QUANTILE_BY_LAYER = {
  liquid_low_vol: 0.300,
  liquid_high_vol: 0.300,
  tail_high_vol: 0.300
};
const CAPACITY_GRID = [
  { id: 'bar5_day5_pos9', maxPerBar: 5, maxPerDay: 5, maxPositions: 9 },
  { id: 'bar6_day6_pos10', maxPerBar: 6, maxPerDay: 6, maxPositions: 10 },
  { id: 'bar6_day6_pos12', maxPerBar: 6, maxPerDay: 6, maxPositions: 12 },
  { id: 'bar5_day7_pos12', maxPerBar: 5, maxPerDay: 7, maxPositions: 12 },
  { id: 'bar7_day7_pos9', maxPerBar: 7, maxPerDay: 7, maxPositions: 9 },
  { id: 'bar7_day7_pos12', maxPerBar: 7, maxPerDay: 7, maxPositions: 12 },
  { id: 'bar8_day8_pos12', maxPerBar: 8, maxPerDay: 8, maxPositions: 12 },
  { id: 'bar10_day10_pos15', maxPerBar: 10, maxPerDay: 10, maxPositions: 15 }
];

function candidateCounts(plans) {
  const events = plans.flatMap(plan => plan.events);
  return {
    total: events.length,
    longs: events.filter(event => event.side === 1).length,
    shorts: events.filter(event => event.side === -1).length
  };
}

function exactV124Benchmark() {
  const prior = JSON.parse(fs.readFileSync(V124_FILE, 'utf8'));
  const row = prior.variants.find(item => item.id === 'replace_rapid_reversal_eligible3_q300');
  if (!row) throw new Error('V12.4 eligible3 q300 benchmark is missing');
  return row;
}

function strictlyBetter(row, benchmark) {
  return row.stress.totalReturn > benchmark.stress.totalReturn
    && row.extreme.totalReturn > benchmark.extreme.totalReturn
    && row.stress.operationalSignalsPerDay > benchmark.stress.operationalSignalsPerDay
    && row.stress.maxDrawdown >= benchmark.stress.maxDrawdown - 0.02
    && row.stress.positiveQuarterShare >= benchmark.stress.positiveQuarterShare
    && row.stress.profitFactor >= 1.15
    && row.extreme.profitFactor >= 1
    && longSleeveRobust(row.stress, row.extreme);
}

function runAll() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const benchmark = exactV124Benchmark();
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const inRegime = regimeClassifier(prepared, BASE_REGIME);

  const shortPlanSets = new Map();
  for (const scoreQuantile of [0.850, 0.875]) {
    console.error(`V13 building V11 short plans q=${scoreQuantile.toFixed(3)}`);
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

  const baselineStress = runScenario(prepared, shortPlans, 'stress', CAPACITY_GRID[0]);
  const baselineExtreme = runScenario(prepared, shortPlans, 'extreme', CAPACITY_GRID[0]);
  assertV11Baseline({
    stress: compactRun(baselineStress, shortPlans),
    extreme: compactRun(baselineExtreme, shortPlans)
  });

  const rows = [];
  for (const capacity of CAPACITY_GRID) {
    console.error(`V13 testing ${capacity.id}`);
    const stressRun = runScenario(prepared, plans, 'stress', capacity);
    const extremeRun = runScenario(prepared, plans, 'extreme', capacity);
    const stress = compactRun(stressRun, plans);
    const extreme = compactRun(extremeRun, plans);
    const leaveOneOut = leaveOneOutAudit(stressRun);
    const exactBaseline = capacity.id !== CAPACITY_GRID[0].id || (
      Math.abs(stress.totalReturn - benchmark.stress.totalReturn) < 1e-12
      && Math.abs(extreme.totalReturn - benchmark.extreme.totalReturn) < 1e-12
      && stress.trades === benchmark.stress.trades
    );
    if (!exactBaseline) throw new Error('V13 failed to reproduce the V12.4 benchmark');
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
      candidateCounts: candidateCounts(plans),
      stress,
      extreme,
      versusV124: {
        stressReturnDelta: stress.totalReturn - benchmark.stress.totalReturn,
        extremeReturnDelta: extreme.totalReturn - benchmark.extreme.totalReturn,
        frequencyDelta: stress.operationalSignalsPerDay - benchmark.stress.operationalSignalsPerDay,
        maxDrawdownDelta: stress.maxDrawdown - benchmark.stress.maxDrawdown,
        headlineSuperior
      },
      leaveOneQuarterOut: leaveOneOut,
      acceptance,
      validationPass: headlineSuperior && leaveOneOut.pass && acceptance?.gate.pass === true
    });
  }

  const valid = rows.filter(row => row.validationPass)
    .sort((a, b) => b.stress.totalReturn - a.stress.totalReturn
      || b.extreme.totalReturn - a.extreme.totalReturn
      || b.stress.operationalSignalsPerDay - a.stress.operationalSignalsPerDay);
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v13-v12.4-capacity-diversification-with-fixed-gross-exposure',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      rawReversalLongEvents: rawReversalEvents.length
    },
    fixedSignalRule: {
      source: 'V12.4 eligible3 q300',
      quantileByLayer: QUANTILE_BY_LAYER,
      regime: BASE_REGIME,
      riskPerTrade: 0.0025,
      maxGross: 1.5
    },
    benchmark: {
      stress: benchmark.stress,
      extreme: benchmark.extreme
    },
    capacityGrid: rows,
    bestValidatedCandidate: valid[0]?.id ?? null,
    validationPass: valid.length > 0,
    researchStatus: valid.length
      ? 'V13_CAPACITY_CANDIDATE_STRICTLY_SUPERIOR_TO_V12_4'
      : 'NO_V13_CAPACITY_CANDIDATE_STRICTLY_SUPERIOR_TO_V12_4',
    nextAction: valid.length
      ? 'run capacity-neighborhood, execution saturation, and forward implementation parity validation'
      : 'capacity alone cannot solve V12.4 concentration; move to a causally trained reversal selector rather than increasing trade count',
    caveats: [
      'The gross-exposure cap and per-trade risk are unchanged; only scheduling capacity changes.',
      'All comparisons use already exposed history.',
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
      variants: result.capacityGrid.map(row => ({
        id: row.id,
        stressReturn: row.stress.totalReturn,
        extremeReturn: row.extreme.totalReturn,
        maxDrawdown: row.stress.maxDrawdown,
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
  QUANTILE_BY_LAYER,
  CAPACITY_GRID,
  strictlyBetter,
  runAll
};
