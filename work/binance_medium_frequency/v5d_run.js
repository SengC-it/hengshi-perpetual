const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { weeklyBlockBootstrap } = require('./v2');
const { median, classifyUniverse, signalAcceptance } = require('./v41_core');
const { trailingStats, FOUR_HOURS } = require('./v41_engine');
const { loadPrepared, quarterWindows } = require('./v41_run');
const { loadPremium } = require('./v5c_features');
const { CONFIGS, scanBreakoutEvents, chooseBreakoutCandidate, summarizeBreakoutRun, simulateBreakoutPeriod } = require('./v5d_breakout');

const ROOT = __dirname, DATA = path.join(ROOT, 'v5c_data'), OUTPUT = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT, 'binance_all_perpetuals_v5d_results.json');
const START = Date.parse('2022-01-01T00:00:00Z'), END = Date.parse('2026-06-30T20:00:00Z'), SCAN_START = Date.parse('2021-01-01T00:00:00Z');
const LAYERS = ['liquid_low_vol','liquid_high_vol','tail_low_vol','tail_high_vol'];

function candidateGrid() {
  return LAYERS.flatMap(layer => CONFIGS.map(config => ({ id: `${layer}:${config.configId}`, layer, ...config })));
}

function evaluateTraining(prepared, events, layers, candidate, startTime, endTime) {
  const selections = Object.fromEntries(LAYERS.map(layer => [layer, layer === candidate.layer ? candidate : { id: 'cash', configId: 'cash' }]));
  const full = simulateBreakoutPeriod({ preparedSymbols: prepared, events, layers, selections, startTime, endTime, scenario: 'stress' });
  const quarters = [];
  for (let cursor = new Date(startTime); cursor.getTime() <= endTime;) {
    const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 3);
    const run = simulateBreakoutPeriod({ preparedSymbols: prepared, events, layers, selections, startTime: cursor.getTime(), endTime: Math.min(endTime, next.getTime() - FOUR_HOURS), scenario: 'stress' });
    quarters.push(run.summary); cursor = next;
  }
  const withoutBest = full.trades.map(row => row.netPnl).sort((a,b) => b-a).slice(5).reduce((a,b) => a+b, 0);
  return {
    ...candidate, trades: full.summary.trades, profitFactor: full.summary.profitFactor, totalReturn: full.summary.totalReturn, maxDrawdown: full.summary.maxDrawdown,
    positiveQuarterShare: quarters.filter(row => row.totalReturn > 0).length / quarters.length,
    medianQuarterPf: median(quarters.map(row => row.profitFactor || 0)), profitWithoutBest5: withoutBest
  };
}

function buildPlan(prepared, events) {
  const plans = [];
  for (const fold of quarterWindows()) {
    const layers = classifyUniverse(prepared.map(row => trailingStats(row, fold.startTime))), trainingStart = fold.startTime - 365 * 86400000, trainingEnd = fold.startTime - FOUR_HOURS;
    const evaluated = candidateGrid().map(candidate => evaluateTraining(prepared, events, layers, candidate, trainingStart, trainingEnd));
    const selections = Object.fromEntries(LAYERS.map(layer => [layer, { ...chooseBreakoutCandidate(evaluated.filter(row => row.layer === layer)) }]));
    const layerCounts = Object.fromEntries([...new Set(layers.values())].map(layer => [layer, [...layers.values()].filter(value => value === layer).length]));
    plans.push({ ...fold, trainingStart, trainingEnd, layers, layerCounts, selections, candidates: evaluated });
    console.error(`v5d plan ${new Date(fold.startTime).toISOString().slice(0,10)} ${LAYERS.map(layer => `${layer}=${selections[layer].configId}`).join(' ')}`);
  }
  return plans;
}

function runScenario(prepared, events, plans, scenario) {
  const output = { initialEquity: 100000, finalEquity: 100000, trades: [], equity: [], finalSignals: [], executedSignals: 0, quarters: [] };
  let capital = output.initialEquity;
  for (const plan of plans) {
    const run = simulateBreakoutPeriod({ preparedSymbols: prepared, events, layers: plan.layers, selections: plan.selections, startTime: plan.startTime, endTime: plan.endTime, scenario, initialEquity: capital });
    const startEquity = capital; capital = run.finalEquity;
    output.trades.push(...run.trades); output.equity.push(...run.equity); output.finalSignals.push(...run.finalSignals); output.executedSignals += run.executedSignals;
    output.quarters.push({ startTime: plan.startTime, endTime: plan.endTime, startEquity, endEquity: capital, totalReturn: capital / startEquity - 1, trades: run.summary.trades, signals: run.summary.finalSignals, selections: Object.fromEntries(LAYERS.map(layer => [layer, plan.selections[layer].configId])) });
  }
  output.finalEquity = capital; output.summary = summarizeBreakoutRun(output); output.summary.signalsPerDay = output.finalSignals.length / ((END - START) / 86400000 + 1); return output;
}

function sideRobust(trades, side) {
  const pnl = trades.filter(row => row.side === side).map(row => row.netPnl).sort((a,b) => b-a);
  return pnl.length >= 30 && pnl.slice(5).reduce((a,b) => a+b, 0) > 0;
}

function diagnostics(stress, extreme) {
  const positiveQuarterShare = stress.quarters.filter(row => row.totalReturn > 0).length / stress.quarters.length;
  const profitWithoutBest10 = stress.trades.map(row => row.netPnl).sort((a,b) => b-a).slice(10).reduce((a,b) => a+b, 0);
  const bootstrap = weeklyBlockBootstrap(stress.trades, START, 50000), longRobust = sideRobust(stress.trades, 1), shortRobust = sideRobust(stress.trades, -1);
  const gate = signalAcceptance({ finalSignals: stress.summary.finalSignals, executedSignals: stress.summary.executedSignals, signalsPerDay: stress.summary.signalsPerDay, stress: stress.summary, extreme: extreme.summary, positiveQuarterShare, profitWithoutBest10, bootstrapProbabilityPositive: bootstrap.probabilityPositive, longRobust, shortRobust, profitableLayers: stress.summary.profitableLayers, maxSymbolContribution: stress.summary.maxSymbolContribution });
  gate.checks.drawdown20 = stress.summary.maxDrawdown >= -0.20; gate.checks.positiveQuartersTwoThirds = positiveQuarterShare >= 2/3; gate.checks.bootstrap75 = bootstrap.probabilityPositive >= 0.75;
  gate.pass = Object.values(gate.checks).every(Boolean); gate.failures = Object.entries(gate.checks).filter(([,ok]) => !ok).map(([name]) => name);
  return { positiveQuarterShare, profitWithoutBest10, bootstrap, longRobust, shortRobust, gate };
}

function compactPlan(plan) { return { startTime: plan.startTime, endTime: plan.endTime, trainingStart: plan.trainingStart, trainingEnd: plan.trainingEnd, layerCounts: plan.layerCounts, selections: plan.selections, candidates: plan.candidates }; }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function markdown(result) {
  const pct = value => `${(100*value).toFixed(2)}%`, pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续 V5-D：分层溢价突破\n\n## 结论\n\n滚动样本外验收：**${result.acceptance.gate.pass ? '通过历史门槛，仅可进入前瞻模拟' : '未通过，不具备实盘价值'}**。\n\n- 基准：${pct(result.base.totalReturn)}，PF ${pf(result.base.profitFactor)}，最大回撤 ${pct(result.base.maxDrawdown)}\n- 压力：${pct(result.stress.totalReturn)}，PF ${pf(result.stress.profitFactor)}，最大回撤 ${pct(result.stress.maxDrawdown)}\n- 极端：${pct(result.extreme.totalReturn)}，PF ${pf(result.extreme.profitFactor)}，最大回撤 ${pct(result.extreme.maxDrawdown)}\n- 压力情景 ${result.stress.trades} 笔；平均 ${result.stress.signalsPerDay.toFixed(3)} 信号/日；盈利季度 ${pct(result.acceptance.positiveQuarterShare)}\n- 删除最佳 10 笔后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT；周块 Bootstrap 盈利概率 ${pct(result.acceptance.bootstrap.probabilityPositive)}\n\n每个季度仅用此前一年，在四个动态流动性/波动层中分别选择严格、中等、宽松突破或现金。信号于下一根 4 小时开盘成交，单笔风险 0.25%，单币名义上限 35%，组合毛敞口 1.5 倍，每日最多 2 个信号。成本含双边手续费与滑点，且另测压力与极端情景。历史区间与先前研究已经暴露；即使通过，也必须先完成冻结规则的前瞻模拟，不能视为盈利保证。\n`;
}

function runAll() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { manifest, prepared } = loadPrepared(); let premiumAttached = 0;
  for (const row of prepared) { const file = path.join(DATA, row.market, `${row.symbol}_premium_4h.csv`); if (fs.existsSync(file)) { row.premium = loadPremium(file, row.bars); premiumAttached++; } }
  console.error(`v5d loaded ${prepared.length}; premium ${premiumAttached}`);
  const events = scanBreakoutEvents(prepared.filter(row => row.premium), CONFIGS, SCAN_START, END);
  console.error(`v5d events ${events.length} ${CONFIGS.map(config => `${config.configId}=${events.filter(row => row.configId === config.configId).length}`).join(' ')}`);
  const plans = buildPlan(prepared, events), baseRun = runScenario(prepared, events, plans, 'base'), stressRun = runScenario(prepared, events, plans, 'stress'), extremeRun = runScenario(prepared, events, plans, 'extreme'), acceptance = diagnostics(stressRun, extremeRun);
  const result = {
    generatedAt: new Date().toISOString(), version: 'all-perpetuals-stratified-premium-breakout-v5d', evidenceStatus: 'rolling_walk_forward_research_only_history_previously_exposed', dates: ['2022-01-01','2026-06-30'],
    universe: { requested: manifest.requestedSymbols, prepared: prepared.length, premiumAttached }, eventCounts: Object.fromEntries(CONFIGS.map(config => [config.configId, events.filter(row => row.configId === config.configId).length])),
    design: { configs: CONFIGS, exit: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 }, selection: 'trailing 365 days separately by point-in-time layer; next quarter OOS' },
    base: baseRun.summary, stress: stressRun.summary, extreme: extremeRun.summary, quarterlyStress: stressRun.quarters, acceptance, plans: plans.map(compactPlan),
    caveats: ['Historical interval and hypotheses were previously exposed.', 'Four-hour OHLC cannot reproduce intrabar path; stop is checked before trailing-stop updates.', 'Order-book depth, partial fills, liquidation, ADL, outages and all delisted history are not completely modeled.', 'Quarter boundaries close open positions.']
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(OUTPUT, 'binance_all_perpetuals_v5d_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT, 'binance_all_perpetuals_v5d_signals.csv'), serializeCsv(stressRun.finalSignals, ['signalTime','entryTime','market','symbol','baseAsset','layer','configId','type','side','score','premium','premiumZ','takerShare','volumeRatio','breakoutAtr']));
  fs.writeFileSync(path.join(OUTPUT, 'binance_all_perpetuals_v5d_trades.csv'), serializeCsv(stressRun.trades, ['signalTime','entryTime','exitTime','market','symbol','baseAsset','layer','configId','type','side','score','entryPrice','exitPrice','qty','notional','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld']));
  fs.writeFileSync(path.join(OUTPUT, 'binance_all_perpetuals_v5d_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','positions','grossExposure']));
  return { resultFile: RESULT_FILE, sha256: sha(RESULT_FILE), eventCounts: result.eventCounts, base: result.base, stress: result.stress, extreme: result.extreme, acceptance };
}

if (require.main === module) { try { console.log(JSON.stringify(runAll(), null, 2)); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; } }
module.exports = { candidateGrid, evaluateTraining, buildPlan, runScenario, diagnostics, runAll };
