const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { SETTINGS } = require('./v92_run');
const {
  SIMULATION_PORTFOLIO,
  rapidBullClassifier,
  v11ShortPlans
} = require('./v12_long_short_research');
const { scanReversalLongEvents } = require('./v123_reversal_long_research');
const {
  buildLayeredReversalPlans,
  combineRegimePlans
} = require('./v124_reversal_capacity_research');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const FROZEN_RESULT = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v124_reversal_capacity_research.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v127_exit_research.json');
const DEVELOPMENT = {
  start: Date.parse('2025-01-01T00:00:00Z'),
  end: Date.parse('2025-12-31T20:00:00Z')
};
const HOLDOUT = {
  start: Date.parse('2026-01-01T00:00:00Z'),
  end: Date.parse('2026-06-30T20:00:00Z')
};
const BASE_SHORT = { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 };
const BASE_LONG = { stopAtr: 1.5, trailAtr: null, maxHoldBars: 6, meanExitEma20: true };

function profileId(prefix, profile) {
  return [
    prefix,
    profile.kind,
    `s${profile.stopAtr}`,
    profile.takeProfitAtr == null ? null : `tp${profile.takeProfitAtr}`,
    profile.trailAtr == null ? null : `tr${profile.trailAtr}`,
    `h${profile.maxHoldBars}`,
    profile.meanExitEma20 ? 'mean' : null
  ].filter(Boolean).join('_');
}

function uniqueProfiles(rows) {
  const result = new Map();
  for (const row of rows) {
    const key = JSON.stringify(row.exit);
    if (!result.has(key)) result.set(key, row);
  }
  return [...result.values()];
}

function shortProfiles() {
  const rows = [{ id: 'short_baseline', kind: 'trailing', exit: BASE_SHORT }];
  for (const stopAtr of [1.5, 2, 2.5]) {
    for (const trailAtr of [2, 3, 4]) {
      for (const maxHoldBars of [12, 18, 24]) {
        const exit = { stopAtr, trailAtr, maxHoldBars };
        rows.push({ id: profileId('short', { kind: 'trailing', ...exit }), kind: 'trailing', exit });
      }
    }
    for (const takeProfitAtr of [2, 3, 4, 6]) {
      for (const maxHoldBars of [12, 18]) {
        const exit = { stopAtr, takeProfitAtr, trailAtr: null, maxHoldBars };
        rows.push({ id: profileId('short', { kind: 'fixed', ...exit }), kind: 'fixed', exit });
      }
    }
  }
  return uniqueProfiles(rows);
}

function longProfiles() {
  const rows = [{ id: 'long_baseline', kind: 'mean', exit: BASE_LONG }];
  for (const stopAtr of [1, 1.5, 2]) {
    for (const maxHoldBars of [4, 6, 8]) {
      const exit = { stopAtr, trailAtr: null, maxHoldBars, meanExitEma20: true };
      rows.push({ id: profileId('long', { kind: 'mean', ...exit }), kind: 'mean', exit });
    }
    for (const takeProfitAtr of [1, 1.5, 2, 3]) {
      for (const maxHoldBars of [4, 6, 8]) {
        const exit = { stopAtr, takeProfitAtr, trailAtr: null, maxHoldBars };
        rows.push({ id: profileId('long', { kind: 'fixed', ...exit }), kind: 'fixed', exit });
      }
    }
  }
  return uniqueProfiles(rows);
}

function withExits(plans, shortExit, longExit) {
  return plans.map(plan => ({
    ...plan,
    events: plan.events.map(event => ({
      ...event,
      exit: event.side === 1 ? longExit : shortExit
    }))
  }));
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function profitFactor(trades) {
  const profit = sum(trades.filter(row => row.netPnl > 0), row => row.netPnl);
  const loss = -sum(trades.filter(row => row.netPnl < 0), row => row.netPnl);
  return loss > 0 ? profit / loss : profit > 0 ? null : 0;
}

function maxDrawdown(points) {
  if (!points.length) return 0;
  let peak = points[0].equity;
  let drawdown = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    drawdown = Math.min(drawdown, point.equity / peak - 1);
  }
  return drawdown;
}

function sideMetrics(trades, side) {
  const rows = trades.filter(row => row.side === side);
  return {
    trades: rows.length,
    winRate: rows.length ? rows.filter(row => row.netPnl > 0).length / rows.length : 0,
    profitFactor: profitFactor(rows),
    netPnl: sum(rows, row => row.netPnl)
  };
}

function periodMetrics(run, period) {
  const quarters = run.quarters.filter(row => row.startTime >= period.start && row.endTime <= period.end);
  const trades = run.trades.filter(row => row.entryTime >= period.start && row.exitTime <= period.end);
  const points = run.equity.filter(row => row.time >= period.start && row.time <= period.end);
  const reasons = {};
  for (const trade of trades) reasons[trade.reason] = (reasons[trade.reason] || 0) + 1;
  return {
    totalReturn: quarters.reduce((capital, row) => capital * (1 + row.totalReturn), 1) - 1,
    maxDrawdown: maxDrawdown(points),
    trades: trades.length,
    winRate: trades.length ? trades.filter(row => row.netPnl > 0).length / trades.length : 0,
    profitFactor: profitFactor(trades),
    netPnl: sum(trades, row => row.netPnl),
    fees: sum(trades, row => row.fees),
    positiveQuarterShare: quarters.length ? quarters.filter(row => row.totalReturn > 0).length / quarters.length : 0,
    quarterlyReturns: quarters.map(row => ({ startTime: row.startTime, totalReturn: row.totalReturn })),
    reasons,
    long: sideMetrics(trades, 1),
    short: sideMetrics(trades, -1)
  };
}

function fullMetrics(run) {
  return {
    totalReturn: run.summary.totalReturn,
    maxDrawdown: run.summary.maxDrawdown,
    trades: run.summary.trades,
    winRate: run.summary.winRate,
    profitFactor: run.summary.profitFactor,
    netPnl: run.summary.netPnl,
    fees: run.summary.fees,
    finalSignals: run.summary.finalSignals,
    executedSignals: run.summary.executedSignals
  };
}

function evaluate(basePlans, shortProfile, longProfile) {
  const plans = withExits(basePlans, shortProfile.exit, longProfile.exit);
  const stress = runScenario(basePlans.prepared, plans, 'stress', SIMULATION_PORTFOLIO);
  const extreme = runScenario(basePlans.prepared, plans, 'extreme', SIMULATION_PORTFOLIO);
  return {
    id: `${shortProfile.id}__${longProfile.id}`,
    shortProfile,
    longProfile,
    full: { stress: fullMetrics(stress), extreme: fullMetrics(extreme) },
    development: {
      stress: periodMetrics(stress, DEVELOPMENT),
      extreme: periodMetrics(extreme, DEVELOPMENT)
    },
    holdout: {
      stress: periodMetrics(stress, HOLDOUT),
      extreme: periodMetrics(extreme, HOLDOUT)
    }
  };
}

function robustDevelopmentScore(row) {
  return Math.min(row.development.stress.totalReturn, row.development.extreme.totalReturn);
}

function developmentPass(row) {
  const stress = row.development.stress;
  const extreme = row.development.extreme;
  return stress.totalReturn > 0
    && extreme.totalReturn > 0
    && stress.profitFactor >= 1.15
    && extreme.profitFactor >= 1
    && stress.maxDrawdown >= -0.15
    && extreme.maxDrawdown >= -0.18
    && stress.positiveQuarterShare >= 0.75
    && extreme.positiveQuarterShare >= 0.5
    && stress.trades >= 200;
}

function rankDevelopment(rows) {
  return rows.slice().sort((a, b) => Number(developmentPass(b)) - Number(developmentPass(a))
    || robustDevelopmentScore(b) - robustDevelopmentScore(a)
    || b.development.stress.profitFactor - a.development.stress.profitFactor
    || b.development.stress.maxDrawdown - a.development.stress.maxDrawdown
    || a.id.localeCompare(b.id));
}

function balancedDevelopmentImprovement(row, baseline) {
  return ['stress', 'extreme'].every(scenario => {
    const candidate = row.development[scenario];
    const frozen = baseline.development[scenario];
    return candidate.totalReturn > frozen.totalReturn
      && candidate.profitFactor >= frozen.profitFactor
      && candidate.maxDrawdown >= frozen.maxDrawdown - 0.01
      && candidate.positiveQuarterShare >= frozen.positiveQuarterShare
      && candidate.trades >= 0.95 * frozen.trades;
  });
}

function dedupeProfiles(rows, selector) {
  const profiles = new Map();
  for (const row of rows) {
    const profile = selector(row);
    if (!profiles.has(profile.id)) profiles.set(profile.id, profile);
  }
  return [...profiles.values()];
}

function finalists(rows, selector) {
  const ranked = rankDevelopment(rows);
  const overall = dedupeProfiles(ranked.slice(0, 4), selector);
  const fixed = dedupeProfiles(ranked.filter(row => selector(row).kind === 'fixed').slice(0, 2), selector);
  return dedupeProfiles([...overall, ...fixed].map(profile => ({ profile })), row => row.profile);
}

function assertBaseline(row) {
  const frozen = JSON.parse(fs.readFileSync(FROZEN_RESULT, 'utf8'));
  const expected = frozen.variants.find(item => item.id === frozen.bestStrictlySuperior);
  const checks = {
    stressReturn: Math.abs(row.full.stress.totalReturn - expected.stress.totalReturn) < 1e-12,
    extremeReturn: Math.abs(row.full.extreme.totalReturn - expected.extreme.totalReturn) < 1e-12,
    stressTrades: row.full.stress.trades === expected.stress.trades,
    extremeTrades: row.full.extreme.trades === expected.extreme.trades
  };
  const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  if (failures.length) throw new Error(`V12.7 failed to reproduce frozen V12.4 baseline: ${failures.join(', ')}`);
  return checks;
}

function holdoutComparison(candidate, baseline) {
  const result = {};
  for (const scenario of ['stress', 'extreme']) {
    const row = candidate.holdout[scenario];
    const base = baseline.holdout[scenario];
    result[scenario] = {
      returnDelta: row.totalReturn - base.totalReturn,
      profitFactorDelta: row.profitFactor - base.profitFactor,
      maxDrawdownDelta: row.maxDrawdown - base.maxDrawdown,
      beatsReturn: row.totalReturn > base.totalReturn,
      acceptableProfitFactor: row.profitFactor >= (scenario === 'stress' ? 1.15 : 1),
      acceptableDrawdown: row.maxDrawdown >= base.maxDrawdown - 0.02,
      bothSleevesPositive: row.long.netPnl > 0 && row.short.netPnl > 0
    };
  }
  result.pass = Object.values(result).filter(value => typeof value === 'object')
    .every(value => value.beatsReturn && value.acceptableProfitFactor && value.acceptableDrawdown && value.bothSleevesPositive);
  return result;
}

function compact(row) {
  return {
    id: row.id,
    shortProfile: row.shortProfile,
    longProfile: row.longProfile,
    developmentPass: developmentPass(row),
    developmentScore: robustDevelopmentScore(row),
    full: row.full,
    development: row.development,
    holdout: row.holdout
  };
}

function buildBasePlans(prepared) {
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const isRapidBull = rapidBullClassifier(prepared);
  const planSets = new Map();
  for (const scoreQuantile of [0.850, 0.875]) {
    console.error(`V12.7 building V11 short plans q=${scoreQuantile.toFixed(3)}`);
    planSets.set(scoreQuantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      trainingScoreQuantile: scoreQuantile,
      tradingSides: [-1]
    }));
  }
  const shortPlans = v11ShortPlans(planSets);
  const rawReversalEvents = scanReversalLongEvents(prepared);
  const quantileByLayer = {
    liquid_low_vol: 0.3,
    liquid_high_vol: 0.3,
    tail_high_vol: 0.3
  };
  const longPlans = buildLayeredReversalPlans(shortPlans, rawReversalEvents, quantileByLayer, isRapidBull);
  const plans = combineRegimePlans(shortPlans, longPlans, isRapidBull);
  plans.prepared = prepared;
  return { plans, auditedEvents: auditedEvents.length, labeledRows: labeled.rows.length, rawReversalEvents: rawReversalEvents.length };
}

function runAll() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const built = buildBasePlans(prepared);
  const basePlans = built.plans;
  const shortGrid = shortProfiles();
  const longGrid = longProfiles();
  const baseShort = shortGrid.find(row => row.id === 'short_baseline');
  const baseLong = longGrid.find(row => row.id === 'long_baseline');

  console.error('V12.7 evaluating frozen baseline');
  const baseline = evaluate(basePlans, baseShort, baseLong);
  const baselineParity = assertBaseline(baseline);

  const shortRows = [];
  for (const profile of shortGrid) {
    console.error(`V12.7 short exit ${profile.id}`);
    shortRows.push(evaluate(basePlans, profile, baseLong));
  }
  const longRows = [];
  for (const profile of longGrid) {
    console.error(`V12.7 long exit ${profile.id}`);
    longRows.push(evaluate(basePlans, baseShort, profile));
  }

  const shortFinalists = finalists(shortRows, row => row.shortProfile);
  const longFinalists = finalists(longRows, row => row.longProfile);
  if (!shortFinalists.some(row => row.id === baseShort.id)) shortFinalists.push(baseShort);
  if (!longFinalists.some(row => row.id === baseLong.id)) longFinalists.push(baseLong);

  const jointRows = [];
  for (const shortProfile of shortFinalists) {
    for (const longProfile of longFinalists) {
      console.error(`V12.7 joint exit ${shortProfile.id} + ${longProfile.id}`);
      jointRows.push(evaluate(basePlans, shortProfile, longProfile));
    }
  }
  const selected = rankDevelopment(jointRows)[0];
  const selectedHoldout = holdoutComparison(selected, baseline);
  const fixedCandidates = rankDevelopment(jointRows.filter(row => row.shortProfile.kind === 'fixed' || row.longProfile.kind === 'fixed'));
  const bestWithFixedTakeProfit = fixedCandidates[0] || null;
  const fixedHoldout = bestWithFixedTakeProfit ? holdoutComparison(bestWithFixedTakeProfit, baseline) : null;
  const balancedShortCandidate = rankDevelopment(shortRows.filter(row => balancedDevelopmentImprovement(row, baseline)))[0] || null;
  const balancedShortHoldout = balancedShortCandidate ? holdoutComparison(balancedShortCandidate, baseline) : null;

  const result = {
    generatedAt: new Date().toISOString(),
    version: 'v12.7-exit-and-take-profit-research',
    evidenceStatus: 'pseudo_out_of_sample_on_previously_exposed_history',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      auditedEvents: built.auditedEvents,
      labeledRows: built.labeledRows,
      rawReversalEvents: built.rawReversalEvents,
      historicalEnd: '2026-06-30T20:00:00Z'
    },
    methodology: {
      development: DEVELOPMENT,
      untouchedDuringSelectionHoldout: HOLDOUT,
      selectionObjective: 'maximize the lower of stress and extreme development return after minimum PF, drawdown, quarter breadth and trade-count gates',
      stressRoundTripCost: { liquid: 0.0024, tail: 0.0040 },
      extremeRoundTripCost: { liquid: 0.0040, tail: 0.0080 },
      sameBarConflict: 'stop_first',
      takeProfitDefinition: 'entry plus side times takeProfitAtr times signal ATR',
      shortProfiles: shortGrid.length,
      longProfiles: longGrid.length,
      jointProfiles: jointRows.length
    },
    baselineParity,
    baseline: compact(baseline),
    selectedByDevelopmentOnly: compact(selected),
    selectedHoldoutComparison: selectedHoldout,
    bestDevelopmentCandidateUsingAnyFixedTakeProfit: bestWithFixedTakeProfit ? compact(bestWithFixedTakeProfit) : null,
    fixedTakeProfitHoldoutComparison: fixedHoldout,
    balancedShortCandidate: balancedShortCandidate ? compact(balancedShortCandidate) : null,
    balancedShortHoldoutComparison: balancedShortHoldout,
    topShortProfilesByDevelopment: rankDevelopment(shortRows).slice(0, 10).map(compact),
    topLongProfilesByDevelopment: rankDevelopment(longRows).slice(0, 10).map(compact),
    topJointProfilesByDevelopment: rankDevelopment(jointRows).slice(0, 12).map(compact),
    conclusion: {
      selectedPassesHoldout: selectedHoldout.pass,
      fixedTakeProfitPassesHoldout: Boolean(fixedHoldout?.pass),
      balancedShortCandidatePassesHoldout: Boolean(balancedShortHoldout?.pass),
      productionAction: balancedShortHoldout?.pass
        ? 'retain_v12_4_in_production_and_forward_ab_test_the_balanced_dynamic_short_exit_candidate'
        : 'retain_v12_4_dynamic_exits_and_do_not_add_a_fixed_take_profit',
      caveat: 'The 2026 holdout was not used by this script for selection, but the project had previously observed this history, so it is not genuinely pristine evidence.'
    }
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try {
    const result = runAll();
    console.log(JSON.stringify({
      outputFile: OUTPUT_FILE,
      universe: result.universe,
      methodology: result.methodology,
      baseline: result.baseline,
      selected: result.selectedByDevelopmentOnly,
      selectedHoldoutComparison: result.selectedHoldoutComparison,
      bestFixed: result.bestDevelopmentCandidateUsingAnyFixedTakeProfit,
      fixedTakeProfitHoldoutComparison: result.fixedTakeProfitHoldoutComparison,
      balancedShortCandidate: result.balancedShortCandidate,
      balancedShortHoldoutComparison: result.balancedShortHoldoutComparison,
      conclusion: result.conclusion
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  DEVELOPMENT,
  HOLDOUT,
  BASE_SHORT,
  BASE_LONG,
  shortProfiles,
  longProfiles,
  periodMetrics,
  developmentPass,
  holdoutComparison,
  runAll
};
