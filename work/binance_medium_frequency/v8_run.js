const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { weeklyBlockBootstrap } = require('./v2');
const { classifyUniverse } = require('./v41_core');
const { trailingStats, FOUR_HOURS } = require('./v41_engine');
const { loadPrepared, quarterWindows } = require('./v41_run');
const { buildLabeledRows, runScenario } = require('./v7_run');
const { FEATURE_NAMES, fitRidge, predictRidge, quantile, trainingRowsForFold } = require('./v7_ml');
const { validationPass, innerSplitRows } = require('./v8_layered');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'v5c_data');
const AUDIT_FILE = path.join(DATA_DIR, 'v6_event_metrics_audit.json');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v8_results.json');
const START = Date.parse('2022-01-01T00:00:00Z');
const END = Date.parse('2026-06-30T20:00:00Z');
const DAY = 86400000;
const LOOKBACK_DAYS = 730;
const INNER_VALIDATION_DAYS = 180;
const MINIMUM_FULL_ROWS = 500;
const MINIMUM_MODEL_ROWS = 300;
const RIDGE_LAMBDA = 1;
const SCORE_QUANTILE = 0.85;
const LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol'];

function buildLayeredPlans(prepared, labeledRows) {
  const shortRows = labeledRows.filter(row => row.event.side === -1), plans = [];
  for (const fold of quarterWindows(START, END)) {
    const layers = classifyUniverse(prepared.map(row => trailingStats(row, fold.startTime)));
    const trainingRows = trainingRowsForFold(shortRows, fold.startTime, LOOKBACK_DAYS);
    const oosRows = shortRows.filter(row => row.signalTime >= fold.startTime && row.signalTime <= fold.endTime);
    const splitTime = fold.startTime - INNER_VALIDATION_DAYS * DAY, layerPlans = {}, events = [];
    for (const layer of LAYERS) {
      const fullRows = trainingRows.filter(row => row.layer === layer);
      const { modelRows, validationRows } = innerSplitRows(fullRows, splitTime, fold.startTime);
      const layerPlan = {
        layer,
        fullRows: fullRows.length,
        modelRows: modelRows.length,
        validationRows: validationRows.length,
        splitTime,
        active: false,
        reason: null
      };
      if (fullRows.length < MINIMUM_FULL_ROWS || modelRows.length < MINIMUM_MODEL_ROWS) {
        layerPlan.reason = 'insufficient_nested_training_rows';
        layerPlans[layer] = layerPlan;
        continue;
      }
      const developmentModel = fitRidge(modelRows, FEATURE_NAMES, RIDGE_LAMBDA);
      const developmentCutoff = Math.max(0, quantile(modelRows.map(row => predictRidge(developmentModel, row.features)), SCORE_QUANTILE));
      const validationSelected = validationRows.filter(row => predictRidge(developmentModel, row.features) >= developmentCutoff);
      const validation = validationPass(validationSelected);
      Object.assign(layerPlan, {
        developmentCutoff,
        validationSelected: validationSelected.length,
        validation
      });
      if (!validation.pass) {
        layerPlan.reason = 'inner_validation_failed';
        layerPlans[layer] = layerPlan;
        continue;
      }
      const finalModel = fitRidge(fullRows, FEATURE_NAMES, RIDGE_LAMBDA);
      const finalCutoff = Math.max(0, quantile(fullRows.map(row => predictRidge(finalModel, row.features)), SCORE_QUANTILE));
      const layerEvents = oosRows.filter(row => row.layer === layer).map(row => ({
        ...row.event,
        configId: 'ml',
        score: predictRidge(finalModel, row.features)
      })).filter(event => event.score >= finalCutoff);
      events.push(...layerEvents);
      Object.assign(layerPlan, {
        active: true,
        reason: 'inner_validation_passed',
        finalCutoff,
        oosRows: oosRows.filter(row => row.layer === layer).length,
        oosCandidates: layerEvents.length,
        model: finalModel
      });
      layerPlans[layer] = layerPlan;
    }
    const activeLayers = LAYERS.filter(layer => layerPlans[layer].active);
    plans.push({
      ...fold,
      layers,
      trainingStart: fold.startTime - LOOKBACK_DAYS * DAY,
      trainingEnd: fold.startTime - FOUR_HOURS,
      splitTime,
      trainingRows: trainingRows.length,
      oosRows: oosRows.length,
      activeLayers,
      model: activeLayers.length > 0,
      layerPlans,
      events
    });
    console.error(`V8 ${new Date(fold.startTime).toISOString().slice(0, 10)} active=${activeLayers.join('|') || 'cash'} candidates=${events.length}`);
  }
  return plans;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function sideRobust(trades) {
  const pnl = trades.map(trade => trade.netPnl).sort((a, b) => b - a);
  return pnl.length >= 30 && sum(pnl.slice(5)) > 0;
}

function diagnostics(stress, extreme, plans) {
  const activePlans = plans.filter(plan => plan.model), activeStart = activePlans[0]?.startTime ?? END;
  const activeQuarters = stress.quarters.filter(quarter => quarter.startTime >= activeStart);
  const operationalDays = (END - activeStart) / DAY + 1;
  const operationalSignalsPerDay = stress.summary.finalSignals / operationalDays;
  const positiveQuarterShare = activeQuarters.length ? activeQuarters.filter(quarter => quarter.totalReturn > 0).length / activeQuarters.length : 0;
  const profitWithoutBest10 = sum(stress.trades.map(trade => trade.netPnl).sort((a, b) => b - a).slice(10));
  const bootstrap = weeklyBlockBootstrap(stress.trades, activeStart, 50000);
  const declaredShortRobust = sideRobust(stress.trades);
  const lastFourQuarterReturn = activeQuarters.slice(-4).reduce((capital, quarter) => capital * (1 + quarter.totalReturn), 1) - 1;
  const checks = {
    completeSignalCoverage: stress.summary.finalSignals === stress.summary.executedSignals,
    operationalFrequency: operationalSignalsPerDay >= 0.5 && operationalSignalsPerDay <= 2,
    tradeCount: stress.summary.trades >= 300,
    stressProfitFactor: stress.summary.profitFactor >= 1.15,
    extremeProfitFactor: extreme.summary.profitFactor >= 1,
    stressPositiveReturn: stress.summary.totalReturn > 0,
    extremePositiveReturn: extreme.summary.totalReturn > 0,
    drawdown20: stress.summary.maxDrawdown >= -0.20,
    activeQuarterCount: activeQuarters.length >= 6,
    positiveQuartersTwoThirds: positiveQuarterShare >= 2 / 3,
    lastFourQuartersPositive: lastFourQuarterReturn > 0,
    withoutBestTen: profitWithoutBest10 > 0,
    bootstrap75: bootstrap.probabilityPositive >= 0.75,
    declaredShortRobust,
    layerBreadth: stress.summary.profitableLayers >= 2,
    symbolConcentration: stress.summary.maxSymbolContribution <= 0.20
  };
  return {
    activeStart,
    activeQuarterCount: activeQuarters.length,
    operationalDays,
    operationalSignalsPerDay,
    positiveQuarterShare,
    lastFourQuarterReturn,
    profitWithoutBest10,
    bootstrap,
    declaredShortRobust,
    gate: {
      pass: Object.values(checks).every(Boolean),
      checks,
      failures: Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name)
    }
  };
}

function compactPlan(plan) {
  return {
    startTime: plan.startTime,
    endTime: plan.endTime,
    trainingStart: plan.trainingStart,
    trainingEnd: plan.trainingEnd,
    splitTime: plan.splitTime,
    trainingRows: plan.trainingRows,
    oosRows: plan.oosRows,
    activeLayers: plan.activeLayers,
    modelCandidates: plan.events.length,
    layers: Object.fromEntries(Object.entries(plan.layerPlans).map(([layer, item]) => [layer, {
      fullRows: item.fullRows,
      modelRows: item.modelRows,
      validationRows: item.validationRows,
      developmentCutoff: item.developmentCutoff,
      validationSelected: item.validationSelected,
      validation: item.validation,
      active: item.active,
      reason: item.reason,
      finalCutoff: item.finalCutoff,
      oosRows: item.oosRows,
      oosCandidates: item.oosCandidates,
      model: item.model && {
        lambda: item.model.lambda,
        intercept: item.model.intercept,
        coefficients: item.model.coefficients,
        means: item.model.means,
        scales: item.model.scales
      }
    }]))
  };
}

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`;
  const pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续 V8：嵌套验证分层空头模型

## 结论

历史验收：**${result.acceptance.gate.pass ? '通过，但仅允许冻结后前瞻模拟' : '未通过，禁止实盘'}**。

- 启动日期：${new Date(result.acceptance.activeStart).toISOString().slice(0, 10)}
- 压力：${pct(result.stress.totalReturn)}，PF ${pf(result.stress.profitFactor)}，回撤 ${pct(result.stress.maxDrawdown)}
- 极端：${pct(result.extreme.totalReturn)}，PF ${pf(result.extreme.profitFactor)}，回撤 ${pct(result.extreme.maxDrawdown)}
- ${result.stress.trades} 笔，运行期 ${result.acceptance.operationalSignalsPerDay.toFixed(3)} 个信号/日
- 盈利季度 ${pct(result.acceptance.positiveQuarterShare)}；删除最佳 10 笔后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT
- Bootstrap 盈利概率 ${pct(result.acceptance.bootstrap.probabilityPositive)}

每个流动性/波动层独立训练。季度开始前的 730 天中，最近 180 天只用于内层验证；老样本拟合模型，验证样本必须至少 30 笔、PF 不低于 1.10、净收益为正且删除最佳 3 笔后仍盈利，该层下一季度才允许交易。模型、85% 分位门槛、成本和组合约束均固定。
`;
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  console.error(`V8 loaded ${prepared.length} histories and ${auditedEvents.length} events`);
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const plans = buildLayeredPlans(prepared, labeled.rows);
  const baseRun = runScenario(prepared, plans, 'base');
  const stressRun = runScenario(prepared, plans, 'stress');
  const extremeRun = runScenario(prepared, plans, 'extreme');
  const acceptance = diagnostics(stressRun, extremeRun, plans);
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'all-perpetuals-nested-layered-short-ridge-v8',
    evidenceStatus: 'nested_rolling_walk_forward_research_only_history_previously_exposed',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      auditedEvents: auditedEvents.length,
      metricsAvailableBeforeEntry: labeled.available,
      labeledEligibleEvents: labeled.rows.length,
      eligibleShortLabels: labeled.rows.filter(row => row.event.side === -1).length
    },
    design: {
      direction: 'short_only',
      layers: LAYERS,
      lookbackDays: LOOKBACK_DAYS,
      innerValidationDays: INNER_VALIDATION_DAYS,
      minimumFullRows: MINIMUM_FULL_ROWS,
      minimumModelRows: MINIMUM_MODEL_ROWS,
      ridgeLambda: RIDGE_LAMBDA,
      scoreQuantile: SCORE_QUANTILE,
      innerValidation: { minimumSelected: 30, minimumProfitFactor: 1.10, positiveNet: true, profitWithoutBest3: true }
    },
    base: baseRun.summary,
    stress: stressRun.summary,
    extreme: extremeRun.summary,
    quarterlyStress: stressRun.quarters,
    acceptance,
    plans: plans.map(compactPlan),
    liveStatus: acceptance.gate.pass ? 'PAPER_ONLY_FREEZE_REQUIRED' : 'LIVE_DISABLED',
    caveats: [
      'The historical interval and research direction were previously exposed.',
      'Nested validation reduces but cannot eliminate research overfitting.',
      'Four-hour OHLC, order-book depth, partial fills, liquidation, ADL, outages and tail gaps are not fully modeled.'
    ]
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v8_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v8_signals.csv'), serializeCsv(stressRun.finalSignals.map(event => ({ ...event, ...event.metrics })), [
    'signalTime','entryTime','market','symbol','baseAsset','layer','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr',
    'metricsSourceTime','oiChange24h','openInterestValue','topTraderAccountRatio','topTraderPositionRatio','accountRatio','takerRatio'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v8_trades.csv'), serializeCsv(stressRun.trades, [
    'signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','side','score','entryPrice','exitPrice','qty','notional',
    'grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v8_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','positions','grossExposure']));
  return {
    resultFile: RESULT_FILE,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex'),
    base: result.base,
    stress: result.stress,
    extreme: result.extreme,
    acceptance
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

module.exports = { buildLayeredPlans, diagnostics, runAll };
