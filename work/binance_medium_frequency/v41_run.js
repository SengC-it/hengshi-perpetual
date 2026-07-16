const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serializeCsv } = require('./run');
const { weeklyBlockBootstrap } = require('./v2');
const { median, classifyUniverse, chooseLayerStrategy, signalAcceptance } = require('./v41_core');
const { parseBars, parseFunding, prepareSymbol, trailingStats, auditFamily, summarizeAudit, FOUR_HOURS } = require('./v41_engine');
const { costForLayer, simulatePortfolioQuarter } = require('./v41_portfolio');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'all_perpetuals_data');
const MANIFEST_FILE = path.join(DATA_DIR, 'manifest.json');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_results.json');
const FAMILIES = ['breakout', 'momentum', 'reversal'];
const LAYERS = ['liquid_low_vol', 'liquid_high_vol', 'tail_low_vol', 'tail_high_vol'];
const START = Date.parse('2022-01-01T00:00:00Z');
const END = Date.parse('2026-06-30T20:00:00Z');

function quarterWindows(start = START, end = END) {
  const rows = [], cursor = new Date(start);
  while (cursor.getTime() <= end) {
    const next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 3);
    rows.push({ startTime: cursor.getTime(), endTime: Math.min(end, next.getTime() - FOUR_HOURS) });
    cursor.setTime(next.getTime());
  }
  return rows;
}

function loadPrepared() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')), prepared = [];
  for (const record of manifest.symbols.filter(row => row.bars > 50)) {
    const marketDir = path.join(DATA_DIR, record.market);
    const bars = parseBars(path.join(marketDir, `${record.symbol}_4h.csv`));
    const funding = parseFunding(path.join(marketDir, `${record.symbol}_funding.csv`));
    prepared.push(prepareSymbol({ symbol: record.symbol, baseAsset: record.baseAsset, market: record.market, bars, funding }));
  }
  return { manifest, prepared };
}

function precomputeTrades(preparedSymbols) {
  const cache = new Map(); let complete = 0;
  for (const prepared of preparedSymbols) {
    for (const family of FAMILIES) cache.set(`${prepared.symbol}:${family}`, auditFamily(prepared, family, Date.parse('2020-01-01T00:00:00Z'), END, 0));
    complete++;
    if (complete % 100 === 0 || complete === preparedSymbols.length) console.error(`precomputed signals ${complete}/${preparedSymbols.length}`);
  }
  return cache;
}

function withModeledCost(trade, layer, scenario = 'stress') {
  const cost = costForLayer(layer, scenario), exitRatio = trade.exitPrice / trade.entryPrice;
  const feeReturn = cost / 2 * (1 + exitRatio);
  return { ...trade, feeReturn, netReturn: trade.grossReturn + trade.fundingReturn - feeReturn };
}

function performanceFor({ symbols, family, layer, cache, startTime, endTime }) {
  const trades = [];
  for (const symbol of symbols) for (const trade of cache.get(`${symbol}:${family}`) || []) {
    if (trade.entryTime >= startTime && trade.exitTime <= endTime) trades.push(withModeledCost(trade, layer, 'stress'));
  }
  const summary = summarizeAudit(trades), quarterPfs = [];
  for (let time = startTime; time <= endTime; ) {
    const cursor = new Date(time), next = new Date(cursor); next.setUTCMonth(next.getUTCMonth() + 3);
    const windowTrades = trades.filter(trade => trade.entryTime >= time && trade.exitTime < Math.min(next.getTime(), endTime + FOUR_HOURS));
    quarterPfs.push(summarizeAudit(windowTrades).profitFactor || 0);
    time = next.getTime();
  }
  return { family, ...summary, medianQuarterPf: median(quarterPfs), quarterPfs };
}

function buildWalkForwardPlan(preparedSymbols, cache) {
  const plans = [], assignments = [];
  for (const fold of quarterWindows()) {
    const stats = preparedSymbols.map(prepared => trailingStats(prepared, fold.startTime));
    const layers = classifyUniverse(stats);
    const selections = {}, trainingStart = fold.startTime - 365 * 86400000, trainingEnd = fold.startTime - FOUR_HOURS;
    for (const layer of LAYERS) {
      const symbols = preparedSymbols.filter(prepared => layers.get(prepared.symbol) === layer).map(prepared => prepared.symbol);
      const candidates = FAMILIES.map(family => performanceFor({ symbols, family, layer, cache, startTime: trainingStart, endTime: trainingEnd }));
      selections[layer] = { ...chooseLayerStrategy(candidates), candidates };
    }
    const layerCounts = Object.fromEntries([...new Set(layers.values())].map(layer => [layer, [...layers.values()].filter(value => value === layer).length]));
    for (const [symbol, layer] of layers) assignments.push({ foldStart: fold.startTime, foldEnd: fold.endTime, symbol, layer });
    plans.push({ ...fold, trainingStart, trainingEnd, layers, layerCounts, selections });
    console.error(`planned ${new Date(fold.startTime).toISOString().slice(0, 10)} ${JSON.stringify(Object.fromEntries(LAYERS.map(layer => [layer, selections[layer].family])))}`);
  }
  return { plans, assignments };
}

function summarizePortfolio(run, startTime = START, endTime = END) {
  const wins = run.trades.filter(trade => trade.netPnl > 0), losses = run.trades.filter(trade => trade.netPnl < 0);
  const sum = rows => rows.reduce((total, trade) => total + trade.netPnl, 0);
  let peak = run.equity[0]?.equity || 100000, maxDrawdown = 0;
  for (const point of run.equity) { peak = Math.max(peak, point.equity); maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1); }
  const bySymbol = {}, byLayer = {};
  for (const trade of run.trades) {
    bySymbol[trade.symbol] = (bySymbol[trade.symbol] || 0) + trade.netPnl;
    byLayer[trade.layer] = (byLayer[trade.layer] || 0) + trade.netPnl;
  }
  const positiveSymbolPnl = Object.values(bySymbol).filter(value => value > 0), totalPositive = positiveSymbolPnl.reduce((a, b) => a + b, 0);
  const first = run.initialEquity, last = run.finalEquity, days = (endTime - startTime) / 86400000 + 1;
  return {
    trades: run.trades.length,
    finalSignals: run.finalSignals.length,
    executedSignals: run.executedSignals,
    rawCandidates: run.candidateAudit.length,
    signalsPerDay: run.finalSignals.length / days,
    winRate: run.trades.length ? wins.length / run.trades.length : 0,
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    totalReturn: last / first - 1,
    maxDrawdown,
    netPnl: sum(run.trades),
    totalFees: run.trades.reduce((a, trade) => a + trade.fees, 0),
    totalFunding: run.trades.reduce((a, trade) => a + trade.fundingPnl, 0),
    longTrades: run.trades.filter(trade => trade.side === 1).length,
    shortTrades: run.trades.filter(trade => trade.side === -1).length,
    profitableSymbols: positiveSymbolPnl.length,
    maxSymbolContribution: totalPositive ? Math.max(...positiveSymbolPnl) / totalPositive : 1,
    profitableLayers: Object.values(byLayer).filter(value => value > 0).length,
    byLayer,
    bySymbol
  };
}

function runScenario(preparedSymbols, plans, scenario) {
  const output = { initialEquity: 100000, trades: [], equity: [], finalSignals: [], candidateAudit: [], executedSignals: 0, quarters: [] };
  let capital = output.initialEquity;
  for (const plan of plans) {
    const result = simulatePortfolioQuarter({ preparedSymbols, layers: plan.layers, selections: plan.selections, startTime: plan.startTime, endTime: plan.endTime, scenario, initialEquity: capital });
    const startEquity = capital; capital = result.finalEquity;
    output.trades.push(...result.trades); output.equity.push(...result.equity); output.finalSignals.push(...result.finalSignals); output.candidateAudit.push(...result.candidateAudit); output.executedSignals += result.executedSignals;
    output.quarters.push({ startTime: plan.startTime, endTime: plan.endTime, startEquity, endEquity: capital, totalReturn: capital / startEquity - 1, trades: result.trades.length, finalSignals: result.finalSignals.length });
  }
  output.finalEquity = capital;
  output.summary = summarizePortfolio(output);
  return output;
}

function sideRobust(trades, side) {
  const rows = trades.filter(trade => trade.side === side).map(trade => trade.netPnl).sort((a, b) => b - a);
  return rows.length >= 30 && rows.slice(5).reduce((a, b) => a + b, 0) > 0;
}

function diagnostics(stress, extreme) {
  const positiveQuarterShare = stress.quarters.filter(row => row.totalReturn > 0).length / stress.quarters.length;
  const profitWithoutBest10 = stress.trades.map(trade => trade.netPnl).sort((a, b) => b - a).slice(10).reduce((a, b) => a + b, 0);
  const bootstrap = weeklyBlockBootstrap(stress.trades, START, 50000);
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
  return { positiveQuarterShare, profitWithoutBest10, bootstrap, longRobust, shortRobust, gate };
}

function compactPlan(plan) {
  return {
    startTime: plan.startTime,
    endTime: plan.endTime,
    trainingStart: plan.trainingStart,
    trainingEnd: plan.trainingEnd,
    layerCounts: plan.layerCounts,
    selections: Object.fromEntries(Object.entries(plan.selections).map(([layer, selected]) => [layer, { family: selected.family, reason: selected.reason, trades: selected.trades, profitFactor: selected.profitFactor, totalReturn: selected.totalReturn, medianQuarterPf: selected.medianQuarterPf, candidates: selected.candidates }]))
  };
}

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`, pf = value => value == null ? 'N/A' : value.toFixed(3);
  return `# 币安全永续分层系统 V4.1\n\n## 结论\n\n滚动走步验收：**${result.acceptance.gate.pass ? '通过' : '未通过'}**。由于策略假设和历史区间已暴露，该结果只属于研究级证据。\n\n## 全市场范围\n\n- USDⓈ-M 永续记录：${result.universe.usdsMarginedPerpetuals}\n- COIN-M 永续记录：${result.universe.coinMarginedPerpetuals}\n- 有历史 K 线：${result.universe.withBars}\n- 最终期满足 180 天历史要求：${result.universe.finalEligible}\n\n## 走步结果\n\n- 基准：${pct(result.base.totalReturn)}，PF ${pf(result.base.profitFactor)}，回撤 ${pct(result.base.maxDrawdown)}\n- 压力：${pct(result.stress.totalReturn)}，PF ${pf(result.stress.profitFactor)}，回撤 ${pct(result.stress.maxDrawdown)}\n- 极端：${pct(result.extreme.totalReturn)}，PF ${pf(result.extreme.profitFactor)}，回撤 ${pct(result.extreme.maxDrawdown)}\n- 最终信号 ${result.stress.finalSignals}，已执行 ${result.stress.executedSignals}，覆盖率 ${pct(result.stress.executedSignals / Math.max(1, result.stress.finalSignals))}\n- 平均 ${result.stress.signalsPerDay.toFixed(3)} 个信号/日；原始候选 ${result.stress.rawCandidates}\n- 去除最佳 10 笔后 ${result.acceptance.profitWithoutBest10.toFixed(0)} USDT；盈利季度 ${pct(result.acceptance.positiveQuarterShare)}\n\n## 成本假设\n\n高流动性层双边成本为 0.16% / 0.24% / 0.40%；尾部层为 0.24% / 0.40% / 0.80%。资金费按持仓方向逐次计入。\n\n## 边界\n\n未模拟完整订单簿、强平、ADL、交易所故障和极端跳空；季度边界强制平仓。当前结果不能构成盈利保证。\n`;
}

function runAll() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { manifest, prepared } = loadPrepared();
  console.error(`loaded ${prepared.length} perpetual histories`);
  const cache = precomputeTrades(prepared), { plans, assignments } = buildWalkForwardPlan(prepared, cache);
  const baseRun = runScenario(prepared, plans, 'base'), stressRun = runScenario(prepared, plans, 'stress'), extremeRun = runScenario(prepared, plans, 'extreme');
  const acceptance = diagnostics(stressRun, extremeRun);
  const finalLayers = plans.at(-1).layers, universe = {
    requested: manifest.requestedSymbols,
    usdsMarginedPerpetuals: manifest.symbols.filter(row => row.market === 'um').length,
    coinMarginedPerpetuals: manifest.symbols.filter(row => row.market === 'cm').length,
    withBars: manifest.symbols.filter(row => row.bars > 0).length,
    withAtLeastYear: manifest.symbols.filter(row => row.bars >= 6 * 365).length,
    finalEligible: [...finalLayers.values()].filter(layer => layer !== 'insufficient_history').length,
    downloadErrors: manifest.symbols.filter(row => row.errors?.length).length
  };
  const result = {
    generatedAt: new Date().toISOString(),
    version: 'all-perpetuals-layered-v4.1',
    evidenceStatus: 'rolling_walk_forward_research_only_history_previously_exposed',
    dates: ['2022-01-01', '2026-06-30'],
    universe,
    design: 'quarterly point-in-time liquidity-volatility layers; trailing-year choice among breakout, momentum, reversal, or cash; max two final signals per day',
    base: baseRun.summary,
    stress: stressRun.summary,
    extreme: extremeRun.summary,
    quarterlyStress: stressRun.quarters,
    acceptance,
    plans: plans.map(compactPlan),
    caveats: ['Historical interval and hypotheses were previously exposed.', 'Full order-book depth, liquidation, ADL, exchange outages, and tail gaps are not completely modeled.', 'Quarter boundaries force positions closed before the next strategy selection.']
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_summary.md'), markdown(result));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_signals.csv'), serializeCsv(stressRun.finalSignals, ['symbol','baseAsset','market','layer','family','side','score','signalTime','entryTime']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_candidate_audit.csv'), serializeCsv(stressRun.candidateAudit, ['symbol','baseAsset','market','layer','family','side','score','signalTime','entryTime','selected','reason']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_trades.csv'), serializeCsv(stressRun.trades, ['symbol','baseAsset','market','layer','family','side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','score','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_equity.csv'), serializeCsv(stressRun.equity, ['time','equity','cash','positions','grossExposure']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_all_perpetuals_v41_assignments.csv'), serializeCsv(assignments, ['foldStart','foldEnd','symbol','layer']));
  return { resultFile: RESULT_FILE, sha256: crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex'), universe, base: result.base, stress: result.stress, extreme: result.extreme, acceptance };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runAll(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { quarterWindows, loadPrepared, withModeledCost, performanceFor, summarizePortfolio, sideRobust, diagnostics, runAll };
