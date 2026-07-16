const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { weeklyBlockBootstrap } = require('./v2');
const { classifyUniverse, signalAcceptance } = require('./v41_core');
const { trailingStats, FOUR_HOURS } = require('./v41_engine');
const { loadPrepared, quarterWindows } = require('./v41_run');
const { simulateEvent } = require('./v5c_strategy');
const { summarizeBreakoutRun, simulateBreakoutPeriod } = require('./v5d_breakout');
const {
  FEATURE_NAMES,
  clip,
  featureVector,
  fitRidge,
  predictRidge,
  quantile,
  quantileForTargetRate,
  trainingRowsForFold
} = require('./v7_ml');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'v5c_data');
const AUDIT_FILE = path.join(DATA_DIR, 'v6_event_metrics_audit.json');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v7_results.json');
const START = Date.parse('2022-01-01T00:00:00Z');
const END = Date.parse('2026-06-30T20:00:00Z');
const LOOKBACK_DAYS = 730;
const MINIMUM_TRAINING_ROWS = 300;
const RIDGE_LAMBDA = 1;
const TRAINING_SCORE_QUANTILE = 0.85;
const LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol'];
const ML_SELECTIONS = Object.fromEntries(LAYERS.map(layer => [layer, { configId: 'ml' }]));

function utcQuarterStart(time) {
  const value = new Date(time), month = Math.floor(value.getUTCMonth() / 3) * 3;
  return Date.UTC(value.getUTCFullYear(), month, 1);
}

function buildLayerMaps(prepared, events) {
  const starts = [...new Set(events.map(event => utcQuarterStart(event.signalTime)))].sort((a, b) => a - b);
  return new Map(starts.map(start => [start, classifyUniverse(prepared.map(row => trailingStats(row, start)))]));
}

function buildLabeledRows(prepared, auditedEvents) {
  const byKey = new Map(prepared.map(row => [`${row.market}:${row.symbol}`, row]));
  const available = auditedEvents.filter(event => event.metricsAvailable && event.metrics?.metricsSourceTime < event.entryTime);
  const layerMaps = buildLayerMaps(prepared, available), rows = [];
  for (const event of available) {
    const item = byKey.get(`${event.market}:${event.symbol}`);
    const layer = layerMaps.get(utcQuarterStart(event.signalTime))?.get(event.symbol);
    if (!item || !layer || layer === 'insufficient_history') continue;
    const trade = simulateEvent(item, { ...event, type: 'oi_breakout' }, layer, 'stress');
    if (!trade) continue;
    rows.push({
      signalTime: event.signalTime,
      exitTime: trade.exitTime,
      layer,
      features: featureVector(event, layer),
      target: clip(trade.netPnl / 250, -3, 5),
      event
    });
  }
  return { rows, available: available.length };
}

function buildWalkForwardPlans(prepared, labeledRows, options = {}) {
  const lookbackDays = options.lookbackDays ?? LOOKBACK_DAYS;
  const minimumTrainingRows = options.minimumTrainingRows ?? MINIMUM_TRAINING_ROWS;
  const ridgeLambda = options.ridgeLambda ?? RIDGE_LAMBDA;
  const featureNames = options.featureNames ?? FEATURE_NAMES;
  const fixedQuantile = options.trainingScoreQuantile ?? TRAINING_SCORE_QUANTILE;
  const targetCandidatesPerDay = options.targetCandidatesPerDay ?? null;
  const scoreFloor = options.scoreFloor ?? 0;
  const trainingSides = new Set(options.trainingSides ?? options.allowedSides ?? [-1, 1]);
  const tradingSides = new Set(options.tradingSides ?? options.allowedSides ?? [-1, 1]);
  const trainingMarkets = new Set(options.trainingMarkets ?? ['um', 'cm']);
  const tradingMarkets = new Set(options.tradingMarkets ?? ['um', 'cm']);
  const tradingLayers = options.tradingLayers ? new Set(options.tradingLayers) : null;
  const folds = options.folds ?? quarterWindows(START, END);
  const plans = [];
  for (const fold of folds) {
    const layers = classifyUniverse(prepared.map(row => trailingStats(row, fold.startTime)));
    const trainingRows = trainingRowsForFold(labeledRows, fold.startTime, lookbackDays)
      .filter(row => trainingSides.has(row.event.side) && trainingMarkets.has(row.event.market));
    const oosRows = labeledRows.filter(row => row.signalTime >= fold.startTime
      && row.signalTime <= fold.endTime
      && tradingSides.has(row.event.side)
      && tradingMarkets.has(row.event.market)
      && (!tradingLayers || tradingLayers.has(row.layer)));
    if (trainingRows.length < minimumTrainingRows) {
      plans.push({
        ...fold,
        layers,
        trainingStart: fold.startTime - lookbackDays * 86400000,
        trainingEnd: fold.startTime - FOUR_HOURS,
        trainingRows: trainingRows.length,
        oosRows: oosRows.length,
        scoreCutoff: null,
        model: null,
        events: [],
        reason: 'insufficient_training_rows'
      });
      continue;
    }
    const model = fitRidge(trainingRows, featureNames, ridgeLambda);
    const trainingScores = trainingRows.map(row => predictRidge(model, row.features));
    const firstTrainingSignal = Math.min(...trainingRows.map(row => row.signalTime));
    const trainingSpanDays = Math.max(1, (fold.startTime - Math.max(fold.startTime - lookbackDays * 86400000, firstTrainingSignal)) / 86400000);
    const scoreQuantile = targetCandidatesPerDay == null
      ? fixedQuantile
      : quantileForTargetRate(trainingRows.length, trainingSpanDays, targetCandidatesPerDay);
    const scoreCutoff = Math.max(scoreFloor, quantile(trainingScores, scoreQuantile));
    const events = oosRows.map(row => ({
      ...row.event,
      configId: 'ml',
      score: predictRidge(model, row.features)
    })).filter(event => event.score >= scoreCutoff);
    plans.push({
      ...fold,
      layers,
      trainingStart: fold.startTime - lookbackDays * 86400000,
      trainingEnd: fold.startTime - FOUR_HOURS,
      trainingRows: trainingRows.length,
      oosRows: oosRows.length,
      scoreCutoff,
      scoreQuantile,
      trainingSpanDays,
      trainingScoreMean: trainingScores.reduce((sum, value) => sum + value, 0) / trainingScores.length,
      trainingScoreP85: quantile(trainingScores, TRAINING_SCORE_QUANTILE),
      model,
      events,
      reason: events.length ? 'model_scored' : 'no_positive_oos_scores'
    });
    console.error(`V7 ${new Date(fold.startTime).toISOString().slice(0, 10)} train=${trainingRows.length} oos=${oosRows.length} selected=${events.length} cutoff=${scoreCutoff.toFixed(4)}`);
  }
  return plans;
}

function runScenario(prepared, plans, scenario, portfolio = {}) {
  const maxPerBar = portfolio.maxPerBar ?? 2;
  const maxPerDay = portfolio.maxPerDay ?? 2;
  const maxPositions = portfolio.maxPositions ?? 6;
  const output = { initialEquity: 100000, finalEquity: 100000, trades: [], equity: [], finalSignals: [], executedSignals: 0, quarters: [], modelCandidates: 0 };
  let capital = output.initialEquity;
  for (const plan of plans) {
    const before = capital;
    const run = simulateBreakoutPeriod({
      preparedSymbols: prepared,
      events: plan.events,
      layers: plan.layers,
      selections: ML_SELECTIONS,
      startTime: plan.startTime,
      endTime: plan.endTime,
      scenario,
      initialEquity: capital,
      maxPerBar,
      maxPerDay,
      maxPositions
    });
    capital = run.finalEquity;
    output.trades.push(...run.trades);
    output.equity.push(...run.equity);
    output.finalSignals.push(...run.finalSignals);
    output.executedSignals += run.executedSignals;
    output.modelCandidates += plan.events.length;
    output.quarters.push({
      startTime: plan.startTime,
      endTime: plan.endTime,
      totalReturn: capital / before - 1,
      trades: run.summary.trades,
      signals: run.summary.finalSignals,
      trainingRows: plan.trainingRows,
      oosRows: plan.oosRows,
      modelCandidates: plan.events.length
    });
  }
  output.finalEquity = capital;
  output.summary = summarizeBreakoutRun(output);
  output.summary.signalsPerDay = output.finalSignals.length / ((END - START) / 86400000 + 1);
  output.summary.modelCandidates = output.modelCandidates;
  return output;
}

function sideRobust(trades, side) {
  const pnl = trades.filter(trade => trade.side === side).map(trade => trade.netPnl).sort((a, b) => b - a);
  return pnl.length >= 30 && pnl.slice(5).reduce((sum, value) => sum + value, 0) > 0;
}

function diagnostics(stress, extreme, plans) {
  const positiveQuarterShare = stress.quarters.filter(row => row.totalReturn > 0).length / stress.quarters.length;
  const profitWithoutBest10 = stress.trades.map(trade => trade.netPnl).sort((a, b) => b - a).slice(10).reduce((sum, value) => sum + value, 0);
  const bootstrap = weeklyBlockBootstrap(stress.trades, START, 50000);
  const longRobust = sideRobust(stress.trades, 1), shortRobust = sideRobust(stress.trades, -1);
  const modeledFoldShare = plans.filter(plan => plan.model).length / plans.length;
  const gate = signalAcceptance({
    finalSignals: stress.summary.finalSignals,
    executedSignals: stress.summary.executedSignals,
    signalsPerDay: stress.summary.signalsPerDay,
    stress: stress.summary,
    extreme: extreme.summary,
    positiveQuarterShare,
    profitWithoutBest10,
    bootstrapProbabilityPositive: bootstrap.probabilityPositive,
    longRobust,
    shortRobust,
    profitableLayers: stress.summary.profitableLayers,
    maxSymbolContribution: stress.summary.maxSymbolContribution
  });
  gate.checks.drawdown20 = stress.summary.maxDrawdown >= -0.20;
  gate.checks.positiveQuartersTwoThirds = positiveQuarterShare >= 2 / 3;
  gate.checks.bootstrap75 = bootstrap.probabilityPositive >= 0.75;
  gate.checks.modelFoldCoverage = modeledFoldShare >= 0.8;
  gate.pass = Object.values(gate.checks).every(Boolean);
  gate.failures = Object.entries(gate.checks).filter(([, pass]) => !pass).map(([name]) => name);
  return { positiveQuarterShare, profitWithoutBest10, bootstrap, longRobust, shortRobust, modeledFoldShare, gate };
}

function compactPlan(plan) {
  return {
    startTime: plan.startTime,
    endTime: plan.endTime,
    trainingStart: plan.trainingStart,
    trainingEnd: plan.trainingEnd,
    trainingRows: plan.trainingRows,
    oosRows: plan.oosRows,
    modelCandidates: plan.events.length,
    scoreCutoff: plan.scoreCutoff,
    scoreQuantile: plan.scoreQuantile,
    trainingSpanDays: plan.trainingSpanDays,
    trainingScoreMean: plan.trainingScoreMean,
    trainingScoreP85: plan.trainingScoreP85,
    reason: plan.reason,
    model: plan.model && {
      lambda: plan.model.lambda,
      intercept: plan.model.intercept,
      coefficients: plan.model.coefficients,
      means: plan.model.means,
      scales: plan.model.scales
    }
  };
}

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`;
  const pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续 V7：因果滚动模型排序

## 结论

历史验收：**${result.acceptance.gate.pass ? '通过，但仅允许冻结后模拟盘' : '未通过，禁止实盘'}**。

- 基准：${pct(result.base.totalReturn)}，PF ${pf(result.base.profitFactor)}，最大回撤 ${pct(result.base.maxDrawdown)}
- 压力：${pct(result.stress.totalReturn)}，PF ${pf(result.stress.profitFactor)}，最大回撤 ${pct(result.stress.maxDrawdown)}
- 极端：${pct(result.extreme.totalReturn)}，PF ${pf(result.extreme.profitFactor)}，最大回撤 ${pct(result.extreme.maxDrawdown)}
- 压力场景 ${result.stress.trades} 笔，${result.stress.signalsPerDay.toFixed(3)} 个最终信号/日，模型入围 ${result.stress.modelCandidates} 个
- 盈利季度 ${pct(result.acceptance.positiveQuarterShare)}；删除最佳 10 笔后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT
- 周度区块 Bootstrap 盈利概率 ${pct(result.acceptance.bootstrap.probabilityPositive)}

## 固定方法

每季度只使用此前 730 天、且已经平仓的压力成本交易训练岭回归；固定正则系数 1，不搜索模型参数。特征只使用开仓前可见的溢价、K 线 taker、24 小时 OI、大户持仓/账户比、全体账户比、成交量、突破幅度、市场与动态层。使用训练预测分数的 85% 分位且预测收益大于等于零作为下一季度门槛；每天最多 2 个信号、最多 6 个仓位、单笔风险 0.25%。

## 边界

历史区间和研究方向已经反复暴露，所以即使通过也不能直接证明未来盈利，只能进入冻结参数的前瞻模拟盘。四小时 OHLC 无法还原完整盘中路径，订单簿深度、部分成交、强平、ADL、交易所故障和极端跳空未被完整模拟。
`;
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  const auditedEvents = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  console.error(`V7 loaded ${prepared.length} histories and ${auditedEvents.length} audited events`);
  const labeled = buildLabeledRows(prepared, auditedEvents);
  console.error(`V7 labeled ${labeled.rows.length}/${labeled.available} causally available events`);
  const plans = buildWalkForwardPlans(prepared, labeled.rows);
  const baseRun = runScenario(prepared, plans, 'base');
  const stressRun = runScenario(prepared, plans, 'stress');
  const extremeRun = runScenario(prepared, plans, 'extreme');
  const acceptance = diagnostics(stressRun, extremeRun, plans);
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'all-perpetuals-causal-walk-forward-ridge-v7',
    evidenceStatus: 'rolling_walk_forward_research_only_history_previously_exposed',
    dates: ['2022-01-01', '2026-06-30'],
    universe: {
      requested: manifest.requestedSymbols,
      prepared: prepared.length,
      auditedEvents: auditedEvents.length,
      metricsAvailableBeforeEntry: labeled.available,
      labeledEligibleEvents: labeled.rows.length
    },
    design: {
      model: 'ridge regression on clipped stress-cost risk-unit outcome',
      featureNames: FEATURE_NAMES,
      trainingLookbackDays: LOOKBACK_DAYS,
      minimumTrainingRows: MINIMUM_TRAINING_ROWS,
      ridgeLambda: RIDGE_LAMBDA,
      trainingScoreQuantile: TRAINING_SCORE_QUANTILE,
      scoreFloor: 0,
      exit: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 },
      portfolio: { riskPerTrade: 0.0025, maxSignalsPerBar: 2, maxSignalsPerDay: 2, maxPositions: 6, maxGross: 1.5 }
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
      'All model labels must exit before the next fold begins; OOS labels are not used for selection.',
      'Four-hour OHLC cannot reproduce intrabar paths; stops are checked before trailing-stop updates.',
      'Order-book depth, partial fills, liquidation, ADL, outages and complete delisted history are not fully modeled.'
    ]
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v7_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v7_signals.csv'), serializeCsv(stressRun.finalSignals.map(event => ({ ...event, ...event.metrics })), [
    'signalTime','entryTime','market','symbol','baseAsset','layer','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr',
    'metricsSourceTime','oiChange24h','openInterestValue','topTraderAccountRatio','topTraderPositionRatio','accountRatio','takerRatio'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v7_trades.csv'), serializeCsv(stressRun.trades, [
    'signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','side','score','entryPrice','exitPrice','qty','notional',
    'grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'
  ]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v7_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','positions','grossExposure']));
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

module.exports = {
  utcQuarterStart,
  buildLayerMaps,
  buildLabeledRows,
  buildWalkForwardPlans,
  runScenario,
  diagnostics,
  runAll
};
