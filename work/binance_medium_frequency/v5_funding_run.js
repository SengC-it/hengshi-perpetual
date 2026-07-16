const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { median, classifyUniverse } = require('./v41_core');
const { trailingStats, FOUR_HOURS } = require('./v41_engine');
const { loadPrepared, quarterWindows } = require('./v41_run');
const { attachFactorFeatures } = require('./v5_residual');
const { diagnostics } = require('./v5_residual_run');
const { attachFundingFeatures, chooseFundingCandidate, pairRows, simulateFundingPeriod, summarizeFundingRun } = require('./v5_funding');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_results.json');
const START = Date.parse('2022-01-01T00:00:00Z');
const END = Date.parse('2026-06-30T20:00:00Z');
const LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol'];

function candidateGrid() {
  const candidates = [];
  for (const layer of LAYERS) for (const strategy of ['funding_carry', 'funding_crowding_reversal']) {
    for (const fundingEvents of [21, 42]) for (const holdBars of [18, 42]) candidates.push({
      id: `${layer}:${strategy}:${fundingEvents}:${holdBars}`,
      layer,
      strategy,
      fundingEvents,
      holdBars
    });
  }
  return candidates;
}

function evaluateTraining(prepared, layers, candidate, startTime, endTime) {
  const full = simulateFundingPeriod({ preparedSymbols: prepared, layers, candidate, startTime, endTime, scenario: 'stress' });
  const quarters = [];
  for (let cursor = new Date(startTime); cursor.getTime() <= endTime; ) {
    const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 3);
    const stop = Math.min(endTime, next.getTime() - FOUR_HOURS);
    const run = simulateFundingPeriod({ preparedSymbols: prepared, layers, candidate, startTime: cursor.getTime(), endTime: stop, scenario: 'stress' });
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
    const selected = { ...chooseFundingCandidate(candidates) };
    const layerCounts = Object.fromEntries([...new Set(layers.values())].map(layer => [layer, [...layers.values()].filter(value => value === layer).length]));
    plans.push({ ...fold, trainingStart, trainingEnd, layers, layerCounts, selected, candidates });
    console.error(`v5b plan ${new Date(fold.startTime).toISOString().slice(0, 10)} ${selected.id}`);
  }
  return plans;
}

function runScenario(prepared, plans, scenario) {
  const output = { initialEquity: 100000, finalEquity: 100000, trades: [], equity: [], finalSignals: [], executedSignals: 0, quarters: [] };
  let capital = output.initialEquity;
  for (const plan of plans) {
    const run = simulateFundingPeriod({ preparedSymbols: prepared, layers: plan.layers, candidate: plan.selected, startTime: plan.startTime, endTime: plan.endTime, scenario, initialEquity: capital });
    const startEquity = capital; capital = run.finalEquity;
    output.trades.push(...run.trades); output.equity.push(...run.equity); output.finalSignals.push(...run.finalSignals); output.executedSignals += run.executedSignals;
    output.quarters.push({ startTime: plan.startTime, endTime: plan.endTime, strategy: plan.selected.id, startEquity, endEquity: capital, totalReturn: capital / startEquity - 1, pairs: run.summary.pairs, signals: run.finalSignals.length });
  }
  output.finalEquity = capital;
  output.summary = summarizeFundingRun(output);
  output.summary.signalsPerDay = output.finalSignals.length / ((END - START) / 86400000 + 1);
  return output;
}

function compactPlan(plan) {
  return { startTime: plan.startTime, endTime: plan.endTime, trainingStart: plan.trainingStart, trainingEnd: plan.trainingEnd, layerCounts: plan.layerCounts, selected: plan.selected, candidates: plan.candidates };
}

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`, pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续V5-B：资金费Carry与拥挤反转\n\n## 结论\n\n滚动样本外验收：**${result.acceptance.gate.pass ? '通过' : '未通过'}**。\n\n- 基础：${pct(result.base.totalReturn)}，配对PF ${pf(result.base.pairProfitFactor)}，最大回撤 ${pct(result.base.maxDrawdown)}\n- 压力：${pct(result.stress.totalReturn)}，配对PF ${pf(result.stress.pairProfitFactor)}，最大回撤 ${pct(result.stress.maxDrawdown)}\n- 极端：${pct(result.extreme.totalReturn)}，配对PF ${pf(result.extreme.pairProfitFactor)}，最大回撤 ${pct(result.extreme.maxDrawdown)}\n- 压力情景 ${result.stress.pairs} 组配对、${result.stress.finalSignals} 个腿信号，成交覆盖率 ${pct(result.stress.executedSignals / Math.max(1, result.stress.finalSignals))}\n- 平均 ${result.stress.signalsPerDay.toFixed(3)} 个腿信号/日；盈利季度 ${pct(result.acceptance.positiveQuarterShare)}\n- 删除最佳10组后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT；Bootstrap盈利概率 ${pct(result.acceptance.bootstrap.probabilityPositive)}\n\n每季度只用此前一年，在四个动态层、纯资金费Carry或资金费拥挤反转、7/14天资金费均值和3/7天持有中选择。纯Carry预计持有期资金费差必须达到压力成本的1.25倍；拥挤反转同时要求价格残差同向确认并覆盖至少一半压力成本。名义金额按BTC Beta中性分配，组合亏损在4小时收盘确认后于下一根开盘退出。\n\n历史区间和研究假设已经暴露，即使通过也只能进入前瞻模拟盘。本结果不是盈利保证。\n`;
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  attachFactorFeatures(prepared, 270); attachFundingFeatures(prepared, [21, 42]);
  console.error(`v5b loaded ${prepared.length}`);
  const plans = buildPlan(prepared);
  const baseRun = runScenario(prepared, plans, 'base'), stressRun = runScenario(prepared, plans, 'stress'), extremeRun = runScenario(prepared, plans, 'extreme');
  const acceptance = diagnostics(stressRun, extremeRun);
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'all-perpetuals-funding-carry-crowding-v5b',
    evidenceStatus: 'rolling_walk_forward_research_only_history_previously_exposed',
    dates: ['2022-01-01', '2026-06-30'],
    universe: { requested: manifest.requestedSymbols, withBars: manifest.symbols.filter(row => row.bars > 0).length, prepared: prepared.length, usdsMargined: manifest.symbols.filter(row => row.market === 'um').length, coinMargined: manifest.symbols.filter(row => row.market === 'cm').length, downloadErrors: manifest.symbols.filter(row => row.errors?.length).length },
    design: 'quarterly trailing-year selection among dynamic layers, pure-perpetual funding carry or funding-crowding reversal, 7/14-day realized funding average, 3/7-day hold, beta-neutral notionals, close-confirmed pair stop exiting next open',
    base: baseRun.summary,
    stress: stressRun.summary,
    extreme: extremeRun.summary,
    quarterlyStress: stressRun.quarters,
    acceptance,
    plans: plans.map(compactPlan),
    caveats: ['Historical interval and hypotheses were previously exposed.', 'Funding persistence is estimated only from realized events available at signal time.', 'Four-hour bars model a close-confirmed stop at the next open; intrabar order-book paths and partial fills are unavailable.', 'Liquidation, ADL, exchange outages, and all historical delisted symbols are not completely modeled.', 'Quarter boundaries close open pairs.']
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_signals.csv'), serializeCsv(stressRun.finalSignals, ['symbol','baseAsset','market','layer','strategy','fundingEvents','holdBars','side','beta','fundingAverage','residualZ','expectedCarry','signalTime','entryTime']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_trades.csv'), serializeCsv(stressRun.trades, ['symbol','baseAsset','market','layer','strategy','fundingEvents','holdBars','side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','beta','fundingAverage','residualZ','expectedCarry','grossPnl','fees','fundingPnl','netPnl','reason']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_pairs.csv'), serializeCsv(pairRows(stressRun.trades), ['signalTime','entryTime','exitTime','layer','grossPnl','fees','fundingPnl','netPnl','reason']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v5b_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','pairs','grossExposure']));
  return { resultFile: RESULT_FILE, sha256: crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex'), base: result.base, stress: result.stress, extreme: result.extreme, acceptance };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runAll(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { candidateGrid, evaluateTraining, buildPlan, runScenario, runAll };
