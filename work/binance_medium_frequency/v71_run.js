const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { weeklyBlockBootstrap } = require('./v2');
const { loadPrepared } = require('./v41_run');
const {
  buildLabeledRows,
  buildWalkForwardPlans,
  runScenario
} = require('./v7_run');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'v5c_data');
const AUDIT_FILE = path.join(DATA_DIR, 'v6_event_metrics_audit.json');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v71_results.json');
const END = Date.parse('2026-06-30T20:00:00Z');
const SETTINGS = {
  lookbackDays: 730,
  minimumTrainingRows: 2000,
  ridgeLambda: 1,
  targetCandidatesPerDay: 2,
  scoreFloor: 0,
  allowedSides: [-1]
};

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function sideRobust(trades, side) {
  const pnl = trades.filter(trade => trade.side === side).map(trade => trade.netPnl).sort((a, b) => b - a);
  return pnl.length >= 30 && sum(pnl.slice(5)) > 0;
}

function diagnostics(stress, extreme, plans) {
  const activePlans = plans.filter(plan => plan.model);
  const activeStart = activePlans[0]?.startTime ?? END;
  const activeQuarters = stress.quarters.filter(quarter => quarter.startTime >= activeStart);
  const operationalDays = (END - activeStart) / 86400000 + 1;
  const operationalSignalsPerDay = stress.summary.finalSignals / operationalDays;
  const positiveQuarterShare = activeQuarters.length
    ? activeQuarters.filter(quarter => quarter.totalReturn > 0).length / activeQuarters.length
    : 0;
  const profitWithoutBest10 = sum(stress.trades.map(trade => trade.netPnl).sort((a, b) => b - a).slice(10));
  const bootstrap = weeklyBlockBootstrap(stress.trades, activeStart, 50000);
  const declaredShortRobust = sideRobust(stress.trades, -1);
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

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`;
  const pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续 V7.1：成熟样本空头事件模型

## 结论

历史验收：**${result.acceptance.gate.pass ? '通过，但仅允许冻结后前瞻模拟' : '未通过，禁止实盘'}**。

- 启动日期：${new Date(result.acceptance.activeStart).toISOString().slice(0, 10)}；此前因训练样本不足保持现金
- 压力：${pct(result.stress.totalReturn)}，PF ${pf(result.stress.profitFactor)}，最大回撤 ${pct(result.stress.maxDrawdown)}
- 极端：${pct(result.extreme.totalReturn)}，PF ${pf(result.extreme.profitFactor)}，最大回撤 ${pct(result.extreme.maxDrawdown)}
- ${result.stress.trades} 笔，运行期 ${result.acceptance.operationalSignalsPerDay.toFixed(3)} 个信号/日
- 运行期盈利季度 ${pct(result.acceptance.positiveQuarterShare)}，最近四季度复合收益 ${pct(result.acceptance.lastFourQuarterReturn)}
- 删除最佳 10 笔后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT；Bootstrap 盈利概率 ${pct(result.acceptance.bootstrap.probabilityPositive)}

## 固定规则

只交易空头溢价突破事件。每季度仅使用此前 730 天且已经平仓的数据；至少积累 2,000 个空头压力成本标签才启动。岭回归正则系数固定为 1，预测收益必须不低于零。分数门槛只根据训练期事件密度自动设定，使模型入围目标为每日 2 个候选；组合仍限制每日最多 2 个最终信号、最多 6 个仓位、单笔风险 0.25%。

## 实盘边界

该历史和研究方向已经暴露。历史验收通过也只代表值得做冻结参数的前瞻模拟，不代表可以直接下真钱订单。至少需要 180 天和 50 笔未参与研发的模拟成交，并继续通过成本、回撤、集中度与执行偏差门槛。
`;
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  console.error(`V7.1 loaded ${prepared.length} histories and ${auditedEvents.length} audited events`);
  const labeled = buildLabeledRows(prepared, auditedEvents);
  const plans = buildWalkForwardPlans(prepared, labeled.rows, SETTINGS);
  const baseRun = runScenario(prepared, plans, 'base');
  const stressRun = runScenario(prepared, plans, 'stress');
  const extremeRun = runScenario(prepared, plans, 'extreme');
  const acceptance = diagnostics(stressRun, extremeRun, plans);
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'all-perpetuals-mature-short-causal-ridge-v7.1',
    evidenceStatus: 'rolling_walk_forward_research_only_history_previously_exposed',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      auditedEvents: auditedEvents.length,
      metricsAvailableBeforeEntry: labeled.available,
      labeledEligibleEvents: labeled.rows.length,
      eligibleShortLabels: labeled.rows.filter(row => row.event.side === -1).length
    },
    settings: SETTINGS,
    base: baseRun.summary,
    stress: stressRun.summary,
    extreme: extremeRun.summary,
    quarterlyStress: stressRun.quarters,
    acceptance,
    plans: plans.map(plan => ({
      startTime: plan.startTime,
      endTime: plan.endTime,
      trainingStart: plan.trainingStart,
      trainingEnd: plan.trainingEnd,
      trainingRows: plan.trainingRows,
      oosRows: plan.oosRows,
      scoreQuantile: plan.scoreQuantile,
      scoreCutoff: plan.scoreCutoff,
      trainingSpanDays: plan.trainingSpanDays,
      modelCandidates: plan.events.length,
      reason: plan.reason,
      model: plan.model && {
        lambda: plan.model.lambda,
        intercept: plan.model.intercept,
        coefficients: plan.model.coefficients,
        means: plan.model.means,
        scales: plan.model.scales
      }
    })),
    liveStatus: acceptance.gate.pass ? 'PAPER_ONLY_FREEZE_REQUIRED' : 'LIVE_DISABLED',
    forwardGate: {
      minimumCalendarDays: 180,
      minimumExecutedTrades: 50,
      sameStressProfitFactor: 1.15,
      maximumDrawdown: -0.20,
      noParameterChanges: true
    },
    caveats: [
      'This is a declared short-only strategy because long event labels were sparse and negative after stress costs.',
      'The historical interval and research direction were previously exposed.',
      'Four-hour OHLC, order-book depth, partial fills, liquidation, ADL, outages and tail gaps are not fully modeled.'
    ]
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v71_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v71_signals.csv'), serializeCsv(stressRun.finalSignals.map(event => ({ ...event, ...event.metrics })), [
    'signalTime','entryTime','market','symbol','baseAsset','layer','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr',
    'metricsSourceTime','oiChange24h','openInterestValue','topTraderAccountRatio','topTraderPositionRatio','accountRatio','takerRatio'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v71_trades.csv'), serializeCsv(stressRun.trades, [
    'signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','side','score','entryPrice','exitPrice','qty','notional',
    'grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v71_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','positions','grossExposure']));
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

module.exports = { SETTINGS, diagnostics, runAll };
