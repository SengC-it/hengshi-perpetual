const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { weeklyBlockBootstrap } = require('./v2');
const { median, classifyUniverse, signalAcceptance } = require('./v41_core');
const { trailingStats, FOUR_HOURS } = require('./v41_engine');
const { loadPrepared, quarterWindows } = require('./v41_run');
const { attachFactorFeatures, chooseResidualCandidate, pairRows, simulateResidualPeriod, summarizeResidualRun } = require('./v5_residual');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5a_results.json');
const START = Date.parse('2022-01-01T00:00:00Z');
const END = Date.parse('2026-06-30T20:00:00Z');
const LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol'];

function candidateGrid() {
  return LAYERS.flatMap(layer => [42, 126].flatMap(lookbackBars => [18, 30, 42].map(holdBars => ({
    id: `${layer}:residual_reversal:${lookbackBars}:${holdBars}`,
    layer,
    strategy: 'btc_residual_reversal',
    lookbackBars,
    holdBars
  }))));
}

function evaluateTraining(prepared, layers, candidate, startTime, endTime) {
  const full = simulateResidualPeriod({ preparedSymbols: prepared, layers, candidate, startTime, endTime, scenario: 'stress' });
  const quarters = [];
  for (let cursor = new Date(startTime); cursor.getTime() <= endTime; ) {
    const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 3);
    const stop = Math.min(endTime, next.getTime() - FOUR_HOURS);
    const run = simulateResidualPeriod({ preparedSymbols: prepared, layers, candidate, startTime: cursor.getTime(), endTime: stop, scenario: 'stress' });
    quarters.push(run.summary);
    cursor = next;
  }
  const pairs = pairRows(full.trades), withoutBest = pairs.map(row => row.netPnl).sort((a, b) => b - a).slice(5).reduce((a, b) => a + b, 0);
  return {
    ...candidate,
    trades: full.summary.trades,
    pairs: full.summary.pairs,
    pairProfitFactor: full.summary.pairProfitFactor,
    totalReturn: full.summary.totalReturn,
    maxDrawdown: full.summary.maxDrawdown,
    positiveQuarterShare: quarters.filter(summary => summary.totalReturn > 0).length / quarters.length,
    medianQuarterPairPf: median(quarters.map(summary => summary.pairProfitFactor || 0)),
    profitWithoutBest5Pairs: withoutBest
  };
}

function buildPlan(prepared) {
  const plans = [];
  for (const fold of quarterWindows()) {
    const layers = classifyUniverse(prepared.map(row => trailingStats(row, fold.startTime)));
    const trainingStart = fold.startTime - 365 * 86400000, trainingEnd = fold.startTime - FOUR_HOURS;
    const candidates = candidateGrid().map(candidate => evaluateTraining(prepared, layers, candidate, trainingStart, trainingEnd));
    const selected = { ...chooseResidualCandidate(candidates) };
    const layerCounts = Object.fromEntries([...new Set(layers.values())].map(layer => [layer, [...layers.values()].filter(value => value === layer).length]));
    plans.push({ ...fold, trainingStart, trainingEnd, layers, layerCounts, selected, candidates });
    console.error(`v5a plan ${new Date(fold.startTime).toISOString().slice(0, 10)} ${selected.id}`);
  }
  return plans;
}

function runScenario(prepared, plans, scenario) {
  const output = { initialEquity: 100000, finalEquity: 100000, trades: [], equity: [], finalSignals: [], executedSignals: 0, quarters: [] };
  let capital = output.initialEquity;
  for (const plan of plans) {
    const run = simulateResidualPeriod({ preparedSymbols: prepared, layers: plan.layers, candidate: plan.selected, startTime: plan.startTime, endTime: plan.endTime, scenario, initialEquity: capital });
    const startEquity = capital; capital = run.finalEquity;
    output.trades.push(...run.trades); output.equity.push(...run.equity); output.finalSignals.push(...run.finalSignals); output.executedSignals += run.executedSignals;
    output.quarters.push({ startTime: plan.startTime, endTime: plan.endTime, strategy: plan.selected.id, startEquity, endEquity: capital, totalReturn: capital / startEquity - 1, pairs: run.summary.pairs, signals: run.finalSignals.length });
  }
  output.finalEquity = capital;
  output.summary = summarizeResidualRun(output);
  output.summary.signalsPerDay = output.finalSignals.length / ((END - START) / 86400000 + 1);
  return output;
}

function sideRobust(trades, side) {
  const rows = trades.filter(row => row.side === side).map(row => row.netPnl).sort((a, b) => b - a);
  return rows.length >= 30 && rows.slice(5).reduce((a, b) => a + b, 0) > 0;
}

function diagnostics(stress, extreme) {
  const pairs = pairRows(stress.trades);
  const positiveQuarterShare = stress.quarters.filter(row => row.totalReturn > 0).length / stress.quarters.length;
  const profitWithoutBest10 = pairs.map(row => row.netPnl).sort((a, b) => b - a).slice(10).reduce((a, b) => a + b, 0);
  const bootstrap = weeklyBlockBootstrap(pairs, START, 50000);
  const longRobust = sideRobust(stress.trades, 1), shortRobust = sideRobust(stress.trades, -1);
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
  gate.pass = Object.values(gate.checks).every(Boolean);
  gate.failures = Object.entries(gate.checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { positiveQuarterShare, profitWithoutBest10, bootstrap, longRobust, shortRobust, gate };
}

function compactPlan(plan) {
  return { startTime: plan.startTime, endTime: plan.endTime, trainingStart: plan.trainingStart, trainingEnd: plan.trainingEnd, layerCounts: plan.layerCounts, selected: plan.selected, candidates: plan.candidates };
}

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`, pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续V5-A：BTC残差反转\n\n## 结论\n\n滚动样本外验收：**${result.acceptance.gate.pass ? '通过' : '未通过'}**。\n\n- 基础：${pct(result.base.totalReturn)}，配对PF ${pf(result.base.pairProfitFactor)}，最大回撤 ${pct(result.base.maxDrawdown)}\n- 压力：${pct(result.stress.totalReturn)}，配对PF ${pf(result.stress.pairProfitFactor)}，最大回撤 ${pct(result.stress.maxDrawdown)}\n- 极端：${pct(result.extreme.totalReturn)}，配对PF ${pf(result.extreme.pairProfitFactor)}，最大回撤 ${pct(result.extreme.maxDrawdown)}\n- 压力情景 ${result.stress.pairs} 组配对、${result.stress.finalSignals} 个腿信号，成交覆盖率 ${pct(result.stress.executedSignals / Math.max(1, result.stress.finalSignals))}\n- 平均 ${result.stress.signalsPerDay.toFixed(3)} 个腿信号/日；盈利季度 ${pct(result.acceptance.positiveQuarterShare)}\n- 删除最佳10组后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT；Bootstrap盈利概率 ${pct(result.acceptance.bootstrap.probabilityPositive)}\n\n每季度只用此前一年，在四个动态层、7/21天残差回看和3/5/7天持有中选择。残差使用过去45天BTC Beta；配对要求Beta与波动率相近，按Beta中性分配名义金额。每组毛敞口20%权益、风险预算0.25%权益，止损依据两腿组合的最不利4小时价格。\n\n历史区间和研究假设已经暴露，即使通过也只能进入前瞻模拟盘。本结果不是盈利保证。\n`;
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  attachFactorFeatures(prepared, 270);
  console.error(`v5a loaded ${prepared.length}`);
  const plans = buildPlan(prepared);
  const baseRun = runScenario(prepared, plans, 'base'), stressRun = runScenario(prepared, plans, 'stress'), extremeRun = runScenario(prepared, plans, 'extreme');
  const acceptance = diagnostics(stressRun, extremeRun);
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'all-perpetuals-btc-residual-reversal-v5a',
    evidenceStatus: 'rolling_walk_forward_research_only_history_previously_exposed',
    dates: ['2022-01-01', '2026-06-30'],
    universe: { requested: manifest.requestedSymbols, withBars: manifest.symbols.filter(row => row.bars > 0).length, prepared: prepared.length, usdsMargined: manifest.symbols.filter(row => row.market === 'um').length, coinMargined: manifest.symbols.filter(row => row.market === 'cm').length, downloadErrors: manifest.symbols.filter(row => row.errors?.length).length },
    design: 'quarterly trailing-year selection among point-in-time liquidity-volatility layers, 7/21-day BTC residual reversal, 3/5/7-day hold, beta-neutral notionals, pair-level adverse-bar stop',
    base: baseRun.summary,
    stress: stressRun.summary,
    extreme: extremeRun.summary,
    quarterlyStress: stressRun.quarters,
    acceptance,
    plans: plans.map(compactPlan),
    caveats: ['Historical interval and hypotheses were previously exposed.', 'Four-hour OHLC cannot reproduce synchronous intrabar paths; pair-stop fills use the adverse long low and short high, which is conservative but path-agnostic.', 'Full order-book depth, partial fills, liquidation, ADL, exchange outages, and all historical delisted symbols are not completely modeled.', 'Quarter boundaries close open pairs.']
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5a_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5a_signals.csv'), serializeCsv(stressRun.finalSignals, ['symbol','baseAsset','market','layer','strategy','lookbackBars','holdBars','side','beta','residual','residualZ','signalTime','entryTime']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5a_trades.csv'), serializeCsv(stressRun.trades, ['symbol','baseAsset','market','layer','strategy','lookbackBars','holdBars','side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','beta','residual','residualZ','grossPnl','fees','fundingPnl','netPnl','reason']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5a_pairs.csv'), serializeCsv(pairRows(stressRun.trades), ['signalTime','entryTime','exitTime','layer','grossPnl','fees','fundingPnl','netPnl','reason']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5a_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','pairs','grossExposure']));
  return { resultFile: RESULT_FILE, sha256: crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex'), base: result.base, stress: result.stress, extreme: result.extreme, acceptance };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runAll(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { candidateGrid, evaluateTraining, buildPlan, runScenario, diagnostics, runAll };
