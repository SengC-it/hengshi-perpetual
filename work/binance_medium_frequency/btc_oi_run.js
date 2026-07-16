const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG } = require('./config');
const { loadBars } = require('./data');
const { validationWindows, serializeCsv } = require('./run');
const { median } = require('./v2_run');
const { profitAfterRemovingBest, weeklyBlockBootstrap } = require('./v2');
const { parseMetrics, chooseCandidate, acceptance, summarize, simulate } = require('./btc_oi_strategy');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const DEVELOPMENT_FILE = path.join(ROOT, 'btc-oi-development-results.json');
const FROZEN_FILE = path.join(ROOT, 'btc-oi-frozen-params.json');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_futures_btc_oi_v4_results.json');
const EXTREME_COST = 0.0032;
const PARAMETER_GRID = [20, 40].flatMap(breakoutBars => [0.02, 0.05].map(oiThreshold => ({
  breakoutBars,
  oiLookbackBars: 6,
  oiThreshold,
  fundingLimit: 0.0005,
  stopAtr: 2,
  trailAtr: 3,
  maxHoldHours: 72,
  riskFraction: 0.005,
  maxNotional: 1
})));

function parseFunding(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map(line => {
    const [fundingTime, fundingRate, markPrice] = line.split(',');
    return { fundingTime: Number(fundingTime), fundingRate: Number(fundingRate), markPrice: markPrice === '' ? null : Number(markPrice) };
  });
}

function loadBtcData(cutoff) {
  const to = Date.parse(`${cutoff}T23:59:59.999Z`);
  const loaded = loadBars(path.join(DATA_DIR, 'BTCUSDT_4h.csv'), 'BTCUSDT');
  const bars = loaded.bars.filter(row => row.openTime <= to);
  const metricsRows = parseMetrics(path.join(DATA_DIR, 'BTCUSDT_metrics_4h.csv')).filter(row => row.openTime <= to);
  const funding = parseFunding(path.join(DATA_DIR, 'BTCUSDT_funding.csv')).filter(row => row.fundingTime <= to);
  const alignedMetrics = new Set(metricsRows.map(row => row.openTime));
  return {
    bars, metricsRows, funding,
    quality: {
      barWarnings: loaded.warnings,
      bars: bars.length,
      metrics: metricsRows.length,
      alignedMetricBars: bars.filter(row => alignedMetrics.has(row.openTime)).length,
      firstMetricTime: metricsRows[0]?.openTime,
      lastMetricTime: metricsRows.at(-1)?.openTime
    }
  };
}

function metric(data, params, dates, cost) {
  const run = simulate({ ...data, params, start: dates[0], end: dates[1], cost });
  const summary = summarize({
    trades: run.trades,
    equity: run.equity,
    signalCount: run.signalCount,
    startTime: Date.parse(`${dates[0]}T00:00:00Z`),
    endTime: Date.parse(`${dates[1]}T00:00:00Z`)
  });
  return { run, summary };
}

function evaluatePeriod(data, params, dates) {
  return {
    base: metric(data, params, dates, CONFIG.baseCost),
    stress: metric(data, params, dates, CONFIG.stressCost),
    extreme: metric(data, params, dates, EXTREME_COST)
  };
}

function sideRobustness(trades) {
  const robust = side => {
    const rows = trades.filter(trade => trade.side === side).map(trade => trade.netPnl).sort((a, b) => b - a);
    return rows.length >= 10 && rows.slice(1).reduce((a, b) => a + b, 0) > 0;
  };
  return { long: robust(1), short: robust(-1) };
}

function diagnostics(evaluated, dates, quarters) {
  const bootstrap = weeklyBlockBootstrap(evaluated.stress.run.trades, Date.parse(`${dates[0]}T00:00:00Z`));
  const positiveQuarterShare = quarters.filter(row => row.totalReturn > 0).length / quarters.length;
  const profitWithoutBest5 = profitAfterRemovingBest(evaluated.stress.run.trades, 5);
  const sides = sideRobustness(evaluated.stress.run.trades);
  return {
    gate: acceptance({
      base: evaluated.base.summary,
      stress: evaluated.stress.summary,
      extreme: evaluated.extreme.summary,
      positiveQuarterShare,
      profitWithoutBest5,
      bootstrapProbabilityPositive: bootstrap.probabilityPositive,
      sideRobustness: sides
    }),
    positiveQuarterShare,
    profitWithoutBest5,
    bootstrap,
    sideRobustness: sides
  };
}

function evaluateCandidate(data, params, index) {
  const evaluated = evaluatePeriod(data, params, CONFIG.train);
  const quarters = validationWindows(...CONFIG.train).map(dates => ({ dates, ...metric(data, params, dates, CONFIG.stressCost).summary }));
  return {
    id: `oi${String(index + 1).padStart(2, '0')}`,
    params,
    base: evaluated.base.summary,
    stress: evaluated.stress.summary,
    extreme: evaluated.extreme.summary,
    quarterlyStress: quarters,
    medianQuarterlyStressPf: median(quarters.map(row => Number.isFinite(row.profitFactor) ? row.profitFactor : 0)),
    positiveQuarterShare: quarters.filter(row => row.totalReturn > 0).length / quarters.length,
    profitWithoutBest5: profitAfterRemovingBest(evaluated.stress.run.trades, 5)
  };
}

function freeze(selected) {
  const payload = {
    createdAt: new Date().toISOString(),
    selected,
    provenance: {
      selectionData: CONFIG.train,
      validationDataNotReadBeforeFreeze: CONFIG.validation,
      candidates: 'breakout 20/40 bars x 24h OI expansion 2%/5%; all other parameters fixed',
      dataManifest: path.join(DATA_DIR, 'btc-metrics-manifest.json')
    }
  };
  if (fs.existsSync(FROZEN_FILE)) {
    const existing = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
    if (JSON.stringify(existing.selected.params) !== JSON.stringify(selected.params)) throw new Error('existing BTC OI freeze differs from training selection');
    return existing;
  }
  fs.writeFileSync(FROZEN_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

function compact(evaluated, quarters, analysis) {
  return {
    base: evaluated.base.summary,
    stress: evaluated.stress.summary,
    extreme: evaluated.extreme.summary,
    quarterlyStress: quarters,
    acceptance: analysis
  };
}

function markdown(result) {
  const pct = value => `${(100 * value).toFixed(2)}%`;
  const pf = value => value == null ? 'N/A' : value.toFixed(3);
  const line = period => `基准 ${pct(period.base.totalReturn)} / PF ${pf(period.base.profitFactor)}；压力 ${pct(period.stress.totalReturn)} / PF ${pf(period.stress.profitFactor)}；极端 ${pct(period.extreme.totalReturn)} / PF ${pf(period.extreme.profitFactor)}`;
  return `# BTC 永续 OI 突破系统 V4 验证\n\n` +
    `## 结论\n\n2024-01-01 至 2025-06-30 封存验证：**${result.validation.acceptance.gate.pass ? '通过' : '未通过'}**。参数仅从 2021-02-06 至 2023-12-31 选择。\n\n` +
    `## 冻结规则\n\n- 前 ${result.selected.params.breakoutBars} 根 4 小时 K 线突破\n- 24 小时 OI 增长至少 ${pct(result.selected.params.oiThreshold)}，主动买卖比确认方向\n- 单笔风险 0.5%，名义仓位上限 1x；2 ATR 初始止损、3 ATR 跟踪、最长 72 小时\n- 多头资金费率不得高于 0.05%，空头不得低于 -0.05%\n\n` +
    `## 训练期\n\n${line(result.training)}\n\n` +
    `## 封存验证期\n\n${line(result.validation)}\n\n` +
    `- 压力成本交易 ${result.validation.stress.trades} 笔，${result.validation.stress.tradesPerDay.toFixed(3)} 笔/日\n` +
    `- 原始合格信号 ${result.validation.stress.signals} 个，${result.validation.stress.signalsPerDay.toFixed(3)} 个/日\n` +
    `- 最大回撤 ${pct(result.validation.stress.maxDrawdown)}；盈利季度 ${pct(result.validation.acceptance.positiveQuarterShare)}\n` +
    `- 去除最佳 5 笔后 ${result.validation.acceptance.profitWithoutBest5.toFixed(0)} USDT\n` +
    `- 手续费 ${result.validation.stress.totalFees.toFixed(0)} USDT；资金费 ${result.validation.stress.totalFunding.toFixed(0)} USDT\n\n` +
    `## 暴露区间诊断\n\n${line(result.exposedDiagnostic)}\n\n` +
    `## 证据边界\n\n这是历史模拟，不是盈利保证。只使用 BTCUSDT 永续，降低了币种幸存者偏差，但未模拟订单簿深度、强平、ADL、交易所故障和滑点尾部。2026-07-01 至 2026-07-11 的资金费归档缺失，仅影响暴露诊断末段。\n`;
}

function runAll() {
  const trainingData = loadBtcData(CONFIG.train[1]);
  const candidates = PARAMETER_GRID.map((params, index) => evaluateCandidate(trainingData, params, index));
  const selected = chooseCandidate(candidates);
  fs.writeFileSync(DEVELOPMENT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), selectionDates: CONFIG.train, candidateCount: candidates.length, selectedId: selected.id, candidates }, null, 2));
  const frozen = freeze(selected);

  const training = evaluatePeriod(trainingData, frozen.selected.params, CONFIG.train);
  const trainingQuarters = validationWindows(...CONFIG.train).map(dates => ({ dates, ...metric(trainingData, frozen.selected.params, dates, CONFIG.stressCost).summary }));
  const trainingAnalysis = diagnostics(training, CONFIG.train, trainingQuarters);

  const validationData = loadBtcData(CONFIG.validation[1]);
  const validation = evaluatePeriod(validationData, frozen.selected.params, CONFIG.validation);
  const validationQuarters = validationWindows(...CONFIG.validation).map(dates => ({ dates, ...metric(validationData, frozen.selected.params, dates, CONFIG.stressCost).summary }));
  const validationAnalysis = diagnostics(validation, CONFIG.validation, validationQuarters);

  const diagnosticData = loadBtcData(CONFIG.final[1]);
  const exposed = evaluatePeriod(diagnosticData, frozen.selected.params, CONFIG.final);
  const exposedQuarters = validationWindows(...CONFIG.final).map(dates => ({ dates, ...metric(diagnosticData, frozen.selected.params, dates, CONFIG.stressCost).summary }));
  const exposedAnalysis = diagnostics(exposed, CONFIG.final, exposedQuarters);

  const result = {
    generatedAt: new Date().toISOString(),
    version: 'btc-oi-breakout-v4',
    design: 'BTCUSDT perpetual 4h breakout confirmed by 24h open-interest expansion, taker direction, and funding crowding filter',
    evidenceStatus: 'parameters_frozen_on_2021_2023_before_2024_2025_validation',
    selected: frozen.selected,
    costs: { base: CONFIG.baseCost, stress: CONFIG.stressCost, extreme: EXTREME_COST },
    training: { dates: CONFIG.train, ...compact(training, trainingQuarters, trainingAnalysis) },
    validation: { dates: CONFIG.validation, ...compact(validation, validationQuarters, validationAnalysis) },
    exposedDiagnostic: { dates: CONFIG.final, ...compact(exposed, exposedQuarters, exposedAnalysis) },
    candidates,
    dataQuality: diagnosticData.quality,
    caveats: [
      'Historical simulation is not a profit guarantee.',
      'Order-book depth, liquidation, ADL, exchange outages, and tail slippage are not modeled.',
      'Funding archive is missing from 2026-07-01 through 2026-07-11; this affects only the exposed diagnostic tail.'
    ]
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  const tradeColumns = ['side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld'];
  const equityColumns = ['time','equity','cash','position','notional'];
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_btc_oi_v4_validation_trades.csv'), serializeCsv(validation.base.run.trades, tradeColumns));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_btc_oi_v4_validation_equity.csv'), serializeCsv(validation.base.run.equity, equityColumns));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_btc_oi_v4_diagnostic_trades.csv'), serializeCsv(exposed.base.run.trades, tradeColumns));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_btc_oi_v4_diagnostic_equity.csv'), serializeCsv(exposed.base.run.equity, equityColumns));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_btc_oi_v4_summary.md'), markdown(result));
  return {
    resultFile: RESULT_FILE,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex'),
    selected: selected.id,
    validationPass: validationAnalysis.gate.pass,
    validationStress: validation.stress.summary,
    diagnosticPass: exposedAnalysis.gate.pass
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runAll(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { PARAMETER_GRID, parseFunding, loadBtcData, metric, evaluatePeriod, sideRobustness, diagnostics, evaluateCandidate, runAll };

