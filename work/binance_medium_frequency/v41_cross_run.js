const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { weeklyBlockBootstrap } = require('./v2');
const { median, classifyUniverse, signalAcceptance } = require('./v41_core');
const { trailingStats, FOUR_HOURS } = require('./v41_engine');
const { loadPrepared, quarterWindows } = require('./v41_run');
const { choosePairCandidate, summarizePairRun, simulatePairPeriod } = require('./v41_cross_sectional');

const ROOT = __dirname, OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_results.json');
const START = Date.parse('2022-01-01T00:00:00Z'), END = Date.parse('2026-06-30T20:00:00Z');
const LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol'];

function candidateGrid() {
  return LAYERS.flatMap(layer => ['momentum', 'reversal'].flatMap(direction => [42, 126].map(lookbackBars => ({ id: `${layer}:${direction}:${lookbackBars}`, layer, direction, lookbackBars, holdBars: 18 }))));
}

function evaluateTraining(prepared, layers, candidate, startTime, endTime) {
  const full = simulatePairPeriod({ preparedSymbols: prepared, layers, candidate, startTime, endTime, scenario: 'stress' });
  const quarters = [];
  for (let cursor = new Date(startTime); cursor.getTime() <= endTime; ) {
    const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 3);
    const stop = Math.min(endTime, next.getTime() - FOUR_HOURS);
    const run = simulatePairPeriod({ preparedSymbols: prepared, layers, candidate, startTime: cursor.getTime(), endTime: stop, scenario: 'stress' });
    quarters.push(run.summary);
    cursor = next;
  }
  const pnlWithoutBest5 = full.trades.map(trade => trade.netPnl).sort((a, b) => b - a).slice(5).reduce((a, b) => a + b, 0);
  return {
    ...candidate,
    trades: full.summary.trades,
    pairs: full.summary.pairs,
    profitFactor: full.summary.profitFactor,
    totalReturn: full.summary.totalReturn,
    maxDrawdown: full.summary.maxDrawdown,
    positiveQuarterShare: quarters.filter(summary => summary.totalReturn > 0).length / quarters.length,
    medianQuarterPf: median(quarters.map(summary => summary.profitFactor || 0)),
    profitWithoutBest5: pnlWithoutBest5
  };
}

function buildPlan(prepared) {
  const plans = [];
  for (const fold of quarterWindows()) {
    const layers = classifyUniverse(prepared.map(item => trailingStats(item, fold.startTime)));
    const trainingStart = fold.startTime - 365 * 86400000, trainingEnd = fold.startTime - FOUR_HOURS;
    const candidates = candidateGrid().map(candidate => evaluateTraining(prepared, layers, candidate, trainingStart, trainingEnd));
    const selected = { ...choosePairCandidate(candidates) };
    plans.push({ ...fold, trainingStart, trainingEnd, layers, layerCounts: Object.fromEntries([...new Set(layers.values())].map(layer => [layer, [...layers.values()].filter(value => value === layer).length])), selected, candidates });
    console.error(`pair plan ${new Date(fold.startTime).toISOString().slice(0, 10)} ${selected.id}`);
  }
  return plans;
}

function runScenario(prepared, plans, scenario) {
  const output = { initialEquity: 100000, finalEquity: 100000, trades: [], equity: [], finalSignals: [], executedSignals: 0, quarters: [] };
  let capital = 100000;
  for (const plan of plans) {
    const run = simulatePairPeriod({ preparedSymbols: prepared, layers: plan.layers, candidate: plan.selected, startTime: plan.startTime, endTime: plan.endTime, scenario, initialEquity: capital });
    const startEquity = capital; capital = run.finalEquity;
    output.trades.push(...run.trades); output.equity.push(...run.equity); output.finalSignals.push(...run.finalSignals); output.executedSignals += run.executedSignals;
    output.quarters.push({ startTime: plan.startTime, endTime: plan.endTime, strategy: plan.selected.id, startEquity, endEquity: capital, totalReturn: capital / startEquity - 1, trades: run.trades.length, signals: run.finalSignals.length });
  }
  output.finalEquity = capital; output.summary = summarizePairRun(output);
  output.summary.signalsPerDay = output.finalSignals.length / ((END - START) / 86400000 + 1);
  return output;
}

function sideRobust(trades, side) {
  const rows = trades.filter(trade => trade.side === side).map(trade => trade.netPnl).sort((a, b) => b - a);
  return rows.length >= 30 && rows.slice(5).reduce((a, b) => a + b, 0) > 0;
}

function diagnostics(stress, extreme, plans) {
  const positiveQuarterShare = stress.quarters.filter(row => row.totalReturn > 0).length / stress.quarters.length;
  const profitWithoutBest10 = stress.trades.map(trade => trade.netPnl).sort((a, b) => b - a).slice(10).reduce((a, b) => a + b, 0);
  const bootstrap = weeklyBlockBootstrap(stress.trades, START, 50000), longRobust = sideRobust(stress.trades, 1), shortRobust = sideRobust(stress.trades, -1);
  const selectedLayers = new Set(plans.filter(plan => plan.selected.id !== 'cash').map(plan => plan.selected.layer));
  const gate = signalAcceptance({ finalSignals: stress.summary.finalSignals, executedSignals: stress.summary.executedSignals, signalsPerDay: stress.summary.signalsPerDay, stress: stress.summary, extreme: extreme.summary, positiveQuarterShare, profitWithoutBest10, bootstrapProbabilityPositive: bootstrap.probabilityPositive, longRobust, shortRobust, profitableLayers: selectedLayers.size, maxSymbolContribution: stress.summary.maxSymbolContribution });
  return { positiveQuarterShare, profitWithoutBest10, bootstrap, longRobust, shortRobust, selectedLayerBreadth: selectedLayers.size, gate };
}

function compactPlan(plan) {
  return { startTime: plan.startTime, endTime: plan.endTime, trainingStart: plan.trainingStart, trainingEnd: plan.trainingEnd, layerCounts: plan.layerCounts, selected: plan.selected, candidates: plan.candidates };
}

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`, pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续横截面多空 V4.1\n\n## 结论\n\n走步验收：**${result.acceptance.gate.pass ? '通过' : '未通过'}**。\n\n- 基准：${pct(result.base.totalReturn)}，PF ${pf(result.base.profitFactor)}，最大回撤 ${pct(result.base.maxDrawdown)}\n- 压力：${pct(result.stress.totalReturn)}，PF ${pf(result.stress.profitFactor)}，最大回撤 ${pct(result.stress.maxDrawdown)}\n- 极端：${pct(result.extreme.totalReturn)}，PF ${pf(result.extreme.profitFactor)}，最大回撤 ${pct(result.extreme.maxDrawdown)}\n- 最终信号 ${result.stress.finalSignals}，成交 ${result.stress.executedSignals}，${result.stress.signalsPerDay.toFixed(3)} 个/日\n- 去最佳 10 笔后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT；盈利季度 ${pct(result.acceptance.positiveQuarterShare)}\n\n每季度只使用过去一年训练，在四个动态层、动量/反转方向、7/21 天回看中选择；每两天建立一组等名义永续多空，按较危险一腿的 3 ATR 止损距离将每对风险限制为权益的 0.25%，任一腿止损则双腿同时平仓，最长持有 3 天。全程不使用现货。由于历史区间已暴露，本结果仍属于研究级证据，不是盈利保证。\n`;
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared(); console.error(`pair loaded ${prepared.length}`);
  const plans = buildPlan(prepared), baseRun = runScenario(prepared, plans, 'base'), stressRun = runScenario(prepared, plans, 'stress'), extremeRun = runScenario(prepared, plans, 'extreme');
  const acceptance = diagnostics(stressRun, extremeRun, plans);
  const result = {
    generatedAt: new Date().toISOString(), version: 'all-perpetuals-cross-sectional-v4.1', evidenceStatus: 'rolling_walk_forward_research_only_history_previously_exposed', dates: ['2022-01-01','2026-06-30'],
    universe: { requested: manifest.requestedSymbols, withBars: manifest.symbols.filter(row => row.bars > 0).length, usdsMargined: manifest.symbols.filter(row => row.market === 'um').length, coinMargined: manifest.symbols.filter(row => row.market === 'cm').length, downloadErrors: manifest.symbols.filter(row => row.errors?.length).length },
    design: 'quarterly training-year selection of one liquidity-volatility layer, cross-sectional momentum/reversal, 7/21-day lookback, equal-notional long-short pair every two days, 0.25% equity pair risk sized from the riskier 3-ATR leg, close both legs when either stops, maximum three-day hold',
    base: baseRun.summary, stress: stressRun.summary, extreme: extremeRun.summary, quarterlyStress: stressRun.quarters, acceptance, plans: plans.map(compactPlan),
    caveats: ['Historical interval and hypotheses were previously exposed.', 'Full order-book depth, liquidation, ADL, exchange outages, and extreme gaps are not completely modeled.', 'Quarter boundaries close all open pairs.']
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_signals.csv'), serializeCsv(stressRun.finalSignals, ['symbol','baseAsset','market','layer','direction','lookbackBars','side','momentum','signalTime','entryTime']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_trades.csv'), serializeCsv(stressRun.trades, ['symbol','baseAsset','market','layer','direction','lookbackBars','side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','momentum','grossPnl','fees','fundingPnl','netPnl','reason']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_pair_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','pairs','grossExposure']));
  return { resultFile: RESULT_FILE, sha256: crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex'), base: result.base, stress: result.stress, extreme: result.extreme, acceptance };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runAll(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { candidateGrid, evaluateTraining, buildPlan, runScenario, diagnostics, runAll };
