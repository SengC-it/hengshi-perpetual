const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');
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
  buildLayeredReversalPlans,
  combineRegimePlans
} = require('./v124_reversal_capacity_research');
const {
  BASE_REGIME,
  regimeClassifier,
  leaveOneQuarterOut
} = require('./v125_reversal_robustness');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const V124_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v124_reversal_capacity_research.json');
const V125_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v125_reversal_robustness.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v126_predeclared_candidate_comparison.json');

function candidateCounts(plans) {
  const events = plans.flatMap(plan => plan.events);
  return {
    total: events.length,
    longs: events.filter(event => event.side === 1).length,
    shorts: events.filter(event => event.side === -1).length
  };
}

function leaveOneOutAudit(run) {
  const rows = leaveOneQuarterOut(run);
  const allCombinedPositive = rows.every(row => row.combined.netPnl > 0 && row.combined.profitFactor > 1);
  const allLongPositive = rows.every(row => row.long.netPnl > 0
    && row.long.profitFactor > 1
    && row.long.profitWithoutBest5 > 0);
  return {
    rows,
    allCombinedPositive,
    allLongPositive,
    minimumCombinedNetPnl: Math.min(...rows.map(row => row.combined.netPnl)),
    minimumLongNetPnl: Math.min(...rows.map(row => row.long.netPnl)),
    minimumLongWithoutBest5: Math.min(...rows.map(row => row.long.profitWithoutBest5)),
    pass: allCombinedPositive && allLongPositive
  };
}

function runAll() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const priorV124 = JSON.parse(fs.readFileSync(V124_FILE, 'utf8'));
  const priorV125 = JSON.parse(fs.readFileSync(V125_FILE, 'utf8'));
  const predeclared = priorV124.variants.filter(row => row.versusV11?.screenSuperior)
    .map(row => ({
      sourceId: row.id,
      quantileByLayer: row.design.quantileByLayer
    }));
  if (!predeclared.length) throw new Error('V12.4 has no predeclared screen-superior candidates');

  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const inRegime = regimeClassifier(prepared, BASE_REGIME);

  const shortPlanSets = new Map();
  for (const scoreQuantile of [0.850, 0.875]) {
    console.error(`V12.6 building V11 short plans q=${scoreQuantile.toFixed(3)}`);
    shortPlanSets.set(scoreQuantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      trainingScoreQuantile: scoreQuantile,
      tradingSides: [-1]
    }));
  }
  const shortPlans = v11ShortPlans(shortPlanSets);
  const rawReversalEvents = scanReversalLongEvents(prepared);
  const baselineStress = runScenario(prepared, shortPlans, 'stress', SIMULATION_PORTFOLIO);
  const baselineExtreme = runScenario(prepared, shortPlans, 'extreme', SIMULATION_PORTFOLIO);
  const baseline = {
    stress: compactRun(baselineStress, shortPlans),
    extreme: compactRun(baselineExtreme, shortPlans)
  };
  assertV11Baseline(baseline);

  const rows = [];
  for (const definition of predeclared) {
    console.error(`V12.6 testing ${definition.sourceId}`);
    const longPlans = buildLayeredReversalPlans(
      shortPlans,
      rawReversalEvents,
      definition.quantileByLayer,
      inRegime
    );
    const plans = combineRegimePlans(shortPlans, longPlans, inRegime);
    const stressRun = runScenario(prepared, plans, 'stress', SIMULATION_PORTFOLIO);
    const extremeRun = runScenario(prepared, plans, 'extreme', SIMULATION_PORTFOLIO);
    const stress = compactRun(stressRun, plans);
    const extreme = compactRun(extremeRun, plans);
    const leaveOneOut = leaveOneOutAudit(stressRun);
    const declaredLongRobust = longSleeveRobust(stress, extreme);
    let acceptance = null;
    if (leaveOneOut.pass && declaredLongRobust) {
      const standard = diagnostics(stressRun, extremeRun, plans);
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
    const validationPass = priorV125.parameterNeighborhood.audit.pass
      && leaveOneOut.pass
      && acceptance?.gate.pass === true;
    rows.push({
      ...definition,
      candidateCounts: candidateCounts(plans),
      stress,
      extreme,
      declaredLongRobust,
      leaveOneQuarterOut: leaveOneOut,
      acceptance,
      validationPass
    });
  }

  const valid = rows.filter(row => row.validationPass)
    .sort((a, b) => b.stress.totalReturn - a.stress.totalReturn
      || b.extreme.totalReturn - a.extreme.totalReturn
      || b.stress.operationalSignalsPerDay - a.stress.operationalSignalsPerDay);
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v12.6-predeclared-candidate-uniform-leave-one-quarter-out-comparison',
    evidenceStatus: 'historical_research_on_previously_exposed_data',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      rawReversalLongEvents: rawReversalEvents.length
    },
    selectionProtocol: {
      source: 'only V12.4 variants that passed the predeclared screen-superior rule',
      candidateCount: predeclared.length,
      unchangedLeaveOneOutRule: 'after excluding every active quarter in turn, combined and long sleeves must remain profitable with PF above 1, and long PnL after removing its best five trades must remain positive',
      sharedParameterNeighborhoodPassed: priorV125.parameterNeighborhood.audit.pass
    },
    benchmark: baseline,
    candidates: rows,
    bestValidatedCandidate: valid[0]?.sourceId ?? null,
    validationPass: valid.length > 0,
    researchStatus: valid.length
      ? 'PREDECLARED_V12_CANDIDATE_PASSED_UNIFORM_ROBUSTNESS'
      : 'NO_PREDECLARED_V12_CANDIDATE_PASSED_UNIFORM_ROBUSTNESS',
    nextAction: valid.length
      ? 'freeze the selected candidate, generate its forward-only configuration, verify signal parity, and restart the independent paper clock'
      : 'do not freeze V12; keep live trading disabled and retain V11 only as the prior paper candidate',
    caveats: [
      'All candidates and comparison rules are based on already exposed history.',
      'Passing this comparison still authorizes paper trading only.',
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
      bestValidatedCandidate: result.bestValidatedCandidate,
      candidates: result.candidates.map(row => ({
        id: row.sourceId,
        stressReturn: row.stress.totalReturn,
        extremeReturn: row.extreme.totalReturn,
        frequency: row.stress.operationalSignalsPerDay,
        longTrades: row.stress.longTrades,
        longProfitFactor: row.stress.longAudit.profitFactor,
        longWithoutBest5: row.stress.longAudit.profitWithoutBest5,
        leaveOneOutPass: row.leaveOneQuarterOut.pass,
        minimumLongWithoutBest5: row.leaveOneQuarterOut.minimumLongWithoutBest5,
        historicalGate: row.acceptance?.gate,
        validationPass: row.validationPass
      }))
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  leaveOneOutAudit,
  runAll
};
