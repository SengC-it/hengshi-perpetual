const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { loadPrepared } = require('./v41_run');
const { CONFIGS } = require('./v5d_breakout');
const { buildLabeledRows, buildWalkForwardPlans, runScenario } = require('./v7_run');
const { diagnostics } = require('./v71_run');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'v5c_data');
const AUDIT_FILE = path.join(DATA_DIR, 'v6_event_metrics_audit.json');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v74_results.json');
const CANDIDATE_FILE = path.join(ROOT, 'forward_candidate_v74.json');
const FORWARD_START = Date.parse('2026-07-01T00:00:00Z');
const FORWARD_END = Date.parse('2026-09-30T20:00:00Z');
const SETTINGS = {
  lookbackDays: 730,
  minimumTrainingRows: 2500,
  ridgeLambda: 1,
  trainingScoreQuantile: 0.85,
  scoreFloor: 0,
  trainingSides: [-1, 1],
  tradingSides: [-1]
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

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`;
  const pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续 V7.4：成熟统一模型、仅执行空头

## 结论

历史门槛：**${result.acceptance.gate.pass ? '全部通过' : '未通过'}**。当前状态仍是 **PAPER_ONLY**，不允许真钱自动下单。

- 运行期：2025-01-01 至 2026-06-30
- 基准：${pct(result.base.totalReturn)}，PF ${pf(result.base.profitFactor)}
- 压力：${pct(result.stress.totalReturn)}，PF ${pf(result.stress.profitFactor)}，最大回撤 ${pct(result.stress.maxDrawdown)}
- 极端：${pct(result.extreme.totalReturn)}，PF ${pf(result.extreme.profitFactor)}，最大回撤 ${pct(result.extreme.maxDrawdown)}
- ${result.stress.trades} 笔，${result.acceptance.operationalSignalsPerDay.toFixed(3)} 个信号/日
- 盈利季度 ${pct(result.acceptance.positiveQuarterShare)}；最近四季度 ${pct(result.acceptance.lastFourQuarterReturn)}
- 删除最佳 10 笔后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT
- Bootstrap 盈利概率 ${pct(result.acceptance.bootstrap.probabilityPositive)}

## 冻结规则

统一模型同时学习多空样本，但执行端只允许空头；这样多头负收益样本仍作为模型的对照信息。每季度只用此前 730 天且已平仓的数据，至少 2,500 个标签才启动。岭回归正则系数 1，训练分数 85% 分位且预测压力收益不低于零。所有永续合约先扫描，再由动态流动性/波动层决定成本和仓位；每日最多 2 笔、最多 6 个仓位、单笔风险 0.25%。

## 前瞻门槛

模型已冻结到 2026 年第三季度候选，只能模拟成交。至少累计 180 天且 50 笔未参与研发的成交，压力口径 PF 仍不低于 1.15、最大回撤不低于 -20%，并且期间不改参数，才有资格重新评估小资金实盘；这不是盈利保证。
`;
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  console.error(`V7.4 loaded ${prepared.length} histories and ${auditedEvents.length} events`);
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
    version: 'all-perpetuals-mature-unified-model-short-execution-v7.4',
    evidenceStatus: 'historical_gate_passed_but_history_previously_exposed',
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      auditedEvents: auditedEvents.length,
      metricsAvailableBeforeEntry: labeled.available,
      labeledEligibleEvents: labeled.rows.length
    },
    design: {
      ...SETTINGS,
      event: CONFIGS.find(config => config.configId === 'broad'),
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
      noParameterChanges: true
    },
    caveats: [
      'The historical interval and research direction were previously exposed.',
      'Passing historical gates does not prove future profitability.',
      'Four-hour OHLC, order-book depth, partial fills, liquidation, ADL, outages and tail gaps are not fully modeled.'
    ]
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  const resultSha256 = crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex');
  const candidate = {
    frozenAt: new Date().toISOString(),
    version: 'v7.4-forward-2026q3',
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    validFrom: FORWARD_START,
    validThrough: FORWARD_END,
    sourceResult: path.relative(ROOT, RESULT_FILE).replaceAll('\\', '/'),
    sourceResultSha256: resultSha256,
    historicalGatePassed: acceptance.gate.pass,
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
      observedThrough: Date.parse('2026-06-30T20:00:00Z'),
      calendarDays: 0,
      executedTrades: 0,
      status: 'NOT_STARTED'
    }
  };
  fs.writeFileSync(CANDIDATE_FILE, JSON.stringify(candidate, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v74_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v74_signals.csv'), serializeCsv(stressRun.finalSignals.map(event => ({ ...event, ...event.metrics })), [
    'signalTime','entryTime','market','symbol','baseAsset','layer','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr',
    'metricsSourceTime','oiChange24h','openInterestValue','topTraderAccountRatio','topTraderPositionRatio','accountRatio','takerRatio'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v74_trades.csv'), serializeCsv(stressRun.trades, [
    'signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','side','score','entryPrice','exitPrice','qty','notional',
    'grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v74_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','positions','grossExposure']));
  return {
    resultFile: RESULT_FILE,
    candidateFile: CANDIDATE_FILE,
    sha256: resultSha256,
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

module.exports = { SETTINGS, runAll };
