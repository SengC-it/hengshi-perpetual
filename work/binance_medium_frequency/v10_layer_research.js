const fs = require('fs');
const path = require('path');
const { loadPrepared } = require('./v41_run');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');
const { FEATURE_SET, SETTINGS } = require('./v92_run');

const ROOT = __dirname;
const AUDIT_FILE = path.join(ROOT, 'v5c_data', 'v6_event_metrics_audit.json');
const OUTPUT_FILE = path.resolve(ROOT, '..', '..', 'outputs', 'binance_all_perpetuals_v10_layer_research.json');
const LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_high_vol'];
const V92 = {
  stressReturn: 0.11153414057729161,
  extremeReturn: 0.07539163937478022,
  operationalSignalsPerDay: 0.5632429137458091
};

const VARIANTS = [
  {
    id: 'q850_day3_bar2_pos6',
    quantileByLayer: Object.fromEntries(LAYERS.map(layer => [layer, 0.850])),
    portfolio: { maxPerBar: 2, maxPerDay: 3, maxPositions: 6 }
  },
  {
    id: 'q850_day3_bar3_pos6',
    quantileByLayer: Object.fromEntries(LAYERS.map(layer => [layer, 0.850])),
    portfolio: { maxPerBar: 3, maxPerDay: 3, maxPositions: 6 }
  },
  {
    id: 'q850_day3_bar3_pos8',
    quantileByLayer: Object.fromEntries(LAYERS.map(layer => [layer, 0.850])),
    portfolio: { maxPerBar: 3, maxPerDay: 3, maxPositions: 8 }
  },
  {
    id: 'layer_q875_low_tail_q850_high',
    quantileByLayer: {
      liquid_low_vol: 0.875,
      liquid_high_vol: 0.850,
      tail_high_vol: 0.875
    },
    portfolio: { maxPerBar: 3, maxPerDay: 3, maxPositions: 6 }
  },
  {
    id: 'layer_q850_liquid_q875_tail',
    quantileByLayer: {
      liquid_low_vol: 0.850,
      liquid_high_vol: 0.850,
      tail_high_vol: 0.875
    },
    portfolio: { maxPerBar: 3, maxPerDay: 3, maxPositions: 6 }
  },
  {
    id: 'layer_q850_liquid_q875_tail_pos8',
    quantileByLayer: {
      liquid_low_vol: 0.850,
      liquid_high_vol: 0.850,
      tail_high_vol: 0.875
    },
    portfolio: { maxPerBar: 3, maxPerDay: 3, maxPositions: 8 }
  },
  {
    id: 'layer_q825_liquid_q875_tail_pos6',
    quantileByLayer: {
      liquid_low_vol: 0.825,
      liquid_high_vol: 0.825,
      tail_high_vol: 0.875
    },
    portfolio: { maxPerBar: 3, maxPerDay: 3, maxPositions: 6 }
  },
  {
    id: 'layer_q825_liquid_q875_tail_pos8',
    quantileByLayer: {
      liquid_low_vol: 0.825,
      liquid_high_vol: 0.825,
      tail_high_vol: 0.875
    },
    portfolio: { maxPerBar: 3, maxPerDay: 3, maxPositions: 8 }
  }
];

function eventKey(event) {
  return `${event.market}:${event.symbol}:${event.signalTime}:${event.side}`;
}

function mergePlans(planSets, quantileByLayer) {
  const reference = planSets.get(0.850);
  return reference.map((plan, index) => {
    const events = new Map();
    for (const layer of LAYERS) {
      const source = planSets.get(quantileByLayer[layer])[index];
      for (const event of source.events) {
        if (source.layers.get(event.symbol) === layer) events.set(eventKey(event), event);
      }
    }
    return {
      ...plan,
      events: [...events.values()].sort((a, b) => a.signalTime - b.signalTime || b.score - a.score),
      layerScoreQuantiles: quantileByLayer
    };
  });
}

function countsBy(rows, field) {
  const result = {};
  for (const row of rows) result[row[field]] = (result[row[field]] || 0) + 1;
  return result;
}

function compact(run, acceptance) {
  return {
    trades: run.summary.trades,
    winRate: run.summary.winRate,
    profitFactor: run.summary.profitFactor,
    totalReturn: run.summary.totalReturn,
    maxDrawdown: run.summary.maxDrawdown,
    netPnl: run.summary.netPnl,
    fees: run.summary.fees,
    modelCandidates: run.summary.modelCandidates,
    operationalSignalsPerDay: acceptance.operationalSignalsPerDay,
    positiveQuarterShare: acceptance.positiveQuarterShare,
    lastFourQuarterReturn: acceptance.lastFourQuarterReturn,
    profitWithoutBest10: acceptance.profitWithoutBest10,
    bootstrapProbabilityPositive: acceptance.bootstrap.probabilityPositive,
    bootstrapInterval95: acceptance.bootstrap.interval95,
    byLayerPnl: run.summary.byLayer,
    byLayerTrades: countsBy(run.trades, 'layer'),
    byLayerSignals: countsBy(run.finalSignals, 'layer'),
    maxSymbolContribution: run.summary.maxSymbolContribution,
    gate: acceptance.gate
  };
}

function runAll() {
  const { prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const planSets = new Map();
  for (const quantile of [0.825, 0.850, 0.875]) {
    planSets.set(quantile, buildWalkForwardPlans(prepared, labeled.rows, {
      ...SETTINGS,
      featureNames: FEATURE_SET,
      trainingScoreQuantile: quantile
    }));
  }

  const results = [];
  for (const variant of VARIANTS) {
    console.error(`V10 layer research ${variant.id}`);
    const plans = mergePlans(planSets, variant.quantileByLayer);
    const stress = runScenario(prepared, plans, 'stress', variant.portfolio);
    const extreme = runScenario(prepared, plans, 'extreme', variant.portfolio);
    const acceptance = diagnostics(stress, extreme, plans);
    const row = {
      ...variant,
      stress: compact(stress, acceptance),
      extreme: {
        trades: extreme.summary.trades,
        winRate: extreme.summary.winRate,
        profitFactor: extreme.summary.profitFactor,
        totalReturn: extreme.summary.totalReturn,
        maxDrawdown: extreme.summary.maxDrawdown,
        netPnl: extreme.summary.netPnl,
        fees: extreme.summary.fees,
        byLayerPnl: extreme.summary.byLayer,
        byLayerTrades: countsBy(extreme.trades, 'layer')
      }
    };
    row.versusV92 = {
      stressReturnDelta: row.stress.totalReturn - V92.stressReturn,
      extremeReturnDelta: row.extreme.totalReturn - V92.extremeReturn,
      frequencyDelta: row.stress.operationalSignalsPerDay - V92.operationalSignalsPerDay,
      strictlySuperior: row.stress.gate.pass
        && row.stress.totalReturn > V92.stressReturn
        && row.extreme.totalReturn > V92.extremeReturn
        && row.stress.operationalSignalsPerDay > V92.operationalSignalsPerDay
    };
    results.push(row);
  }

  const superior = results.filter(row => row.versusV92.strictlySuperior)
    .sort((a, b) => b.stress.totalReturn - a.stress.totalReturn
      || b.extreme.totalReturn - a.extreme.totalReturn
      || b.stress.operationalSignalsPerDay - a.stress.operationalSignalsPerDay);
  const result = {
    generatedAt: new Date().toISOString(),
    purpose: 'capacity ablation and bounded layer-specific threshold validation after the V10 capacity screen',
    variants: results,
    bestStrictlySuperior: superior[0]?.id ?? null,
    researchStatus: superior.length ? 'SUPERIOR_HISTORICAL_CANDIDATE_FOUND' : 'NO_STRICTLY_SUPERIOR_CANDIDATE',
    caveat: 'Layer choices were made on exposed history; any selected design remains paper-only and requires a fresh independent forward clock.'
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runAll(), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { VARIANTS, mergePlans, runAll };
