const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG } = require('./config');
const { loadDataset, validationWindows, serializeCsv } = require('./run');
const { simulateFundingPairs } = require('./funding_pair');
const { FUNDING_GRID, chooseFundingCandidate, summarizeFundingPairs, fundingAcceptance } = require('./funding_strategy');
const { median } = require('./v2_run');
const { profitAfterRemovingBest, weeklyBlockBootstrap } = require('./v2');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const DEVELOPMENT_FILE = path.join(ROOT, 'funding-development-results.json');
const FROZEN_FILE = path.join(ROOT, 'funding-frozen-params.json');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_futures_funding_pair_v3_results.json');
const EXTREME_COST = 0.0032;

function pairMetric(data, params, dates, cost) {
  const run = simulateFundingPairs({ ...data, params, start: dates[0], end: dates[1], cost });
  const summary = summarizeFundingPairs({
    trades: run.trades,
    equity: run.equity,
    startTime: Date.parse(`${dates[0]}T00:00:00Z`),
    endTime: Date.parse(`${dates[1]}T00:00:00Z`)
  });
  return { run, summary };
}

function evaluatePeriod(data, params, dates) {
  return {
    base: pairMetric(data, params, dates, CONFIG.baseCost),
    stress: pairMetric(data, params, dates, CONFIG.stressCost),
    extreme: pairMetric(data, params, dates, EXTREME_COST)
  };
}

function evaluateTrainingCandidate(data, params, index) {
  const full = evaluatePeriod(data, params, CONFIG.train);
  const quarters = validationWindows(...CONFIG.train).map(dates => ({ dates, ...pairMetric(data, params, dates, CONFIG.stressCost).summary }));
  return {
    id: `fund${String(index + 1).padStart(2, '0')}`,
    params,
    base: full.base.summary,
    stress: full.stress.summary,
    extreme: full.extreme.summary,
    quarterlyStress: quarters,
    medianQuarterlyStressPf: median(quarters.map(x => x.profitFactor)),
    positiveQuarterShare: quarters.filter(x => x.totalReturn > 0).length / quarters.length,
    profitWithoutBest5: profitAfterRemovingBest(full.stress.run.trades, 5)
  };
}

function freezeSelected(selected) {
  const payload = {
    createdAt: new Date().toISOString(),
    selected,
    provenance: {
      selectionData: CONFIG.train,
      validationDataNotReadBeforeFreeze: CONFIG.validation,
      candidateRule: 'threshold 0.05% or 0.10%; hold 72h or 168h; select by median training-quarter stress PF',
      structure: 'equal-notional long lowest trailing funding and short highest trailing funding; one pair; 1x gross; 3% equity pair stop',
      dataManifest: path.join(ROOT, 'data', 'data-manifest.json')
    }
  };
  if (fs.existsSync(FROZEN_FILE)) {
    const existing = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
    if (JSON.stringify(existing.selected.params) !== JSON.stringify(selected.params)) throw new Error('existing funding freeze differs from training selection');
    return existing;
  }
  fs.writeFileSync(FROZEN_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

function acceptanceFor(evaluated, dates, quarters) {
  const bootstrap = weeklyBlockBootstrap(evaluated.stress.run.trades, Date.parse(`${dates[0]}T00:00:00Z`));
  const positiveQuarterShare = quarters.filter(x => x.totalReturn > 0).length / quarters.length;
  const profitWithoutBest5 = profitAfterRemovingBest(evaluated.stress.run.trades, 5);
  return {
    gate: fundingAcceptance({
      base: evaluated.base.summary,
      stress: evaluated.stress.summary,
      extreme: evaluated.extreme.summary,
      positiveQuarterShare,
      profitWithoutBest5,
      bootstrapProbabilityPositive: bootstrap.probabilityPositive
    }),
    bootstrap,
    positiveQuarterShare,
    profitWithoutBest5
  };
}

function summaryMarkdown(result) {
  const t = result.training, v = result.validation, d = result.exposedDiagnostic;
  const pct = x => `${(100 * x).toFixed(2)}%`;
  const line = section => `基准 ${pct(section.base.totalReturn)} / PF ${section.base.profitFactor?.toFixed(3)}；压力 ${pct(section.stress.totalReturn)} / PF ${section.stress.profitFactor?.toFixed(3)}；极端 ${pct(section.extreme.totalReturn)} / PF ${section.extreme.profitFactor?.toFixed(3)}`;
  return `# 币安资金费率市场中性配对 V3 验证\n\n` +
    `## 结论\n\n验证验收：**${v.acceptance.gate.pass ? '通过' : '未通过'}**。参数仅使用2021-2023训练期选择，随后冻结。\n\n` +
    `## 冻结候选\n\n- 阈值：${pct(result.selected.params.threshold)}（过去3次资金费率均值价差）\n- 最长持有：${result.selected.params.maxHoldHours}小时\n- 总敞口：1x，等名义多空；组合亏损3%止损\n\n` +
    `## 训练期\n\n${line(t)}\n\n` +
    `## 验证期\n\n${line(v)}\n\n- 压力成本资金费率收入：${v.stress.totalFundingPnl.toFixed(0)} USDT\n- 压力成本价格损益：${v.stress.totalPricePnl.toFixed(0)} USDT\n- 压力成本手续费：${v.stress.totalFees.toFixed(0)} USDT\n- 盈利季度：${pct(v.acceptance.positiveQuarterShare)}\n- 删除最佳5笔后：${v.acceptance.profitWithoutBest5.toFixed(0)} USDT\n\n` +
    `## 已暴露区间诊断\n\n${line(d)}\n\n` +
    `## 证据边界\n\n资金费率来自币安官方历史归档。固定12币种存在幸存者偏差；未模拟完整订单簿、强平和ADL。2026年7月1日至11日资金费率归档缺失。\n`;
}

function runAll() {
  const trainingData = loadDataset(CONFIG.train[1]);
  const candidates = FUNDING_GRID.map((params, index) => evaluateTrainingCandidate(trainingData, params, index));
  const selected = chooseFundingCandidate(candidates);
  const development = { generatedAt: new Date().toISOString(), candidateCount: candidates.length, selectionDates: CONFIG.train, selectedId: selected.id, candidates };
  fs.writeFileSync(DEVELOPMENT_FILE, JSON.stringify(development, null, 2));
  const frozen = freezeSelected(selected);

  const training = evaluatePeriod(trainingData, frozen.selected.params, CONFIG.train);
  const trainingQuarters = validationWindows(...CONFIG.train).map(dates => ({ dates, ...pairMetric(trainingData, frozen.selected.params, dates, CONFIG.stressCost).summary }));
  const trainingAcceptance = acceptanceFor(training, CONFIG.train, trainingQuarters);

  const validationData = loadDataset(CONFIG.validation[1]);
  const validation = evaluatePeriod(validationData, frozen.selected.params, CONFIG.validation);
  const validationQuarters = validationWindows(...CONFIG.validation).map(dates => ({ dates, ...pairMetric(validationData, frozen.selected.params, dates, CONFIG.stressCost).summary }));
  const validationAcceptance = acceptanceFor(validation, CONFIG.validation, validationQuarters);

  const diagnosticData = loadDataset(CONFIG.final[1]);
  const diagnostic = evaluatePeriod(diagnosticData, frozen.selected.params, CONFIG.final);
  const diagnosticQuarters = validationWindows(...CONFIG.final).map(dates => ({ dates, ...pairMetric(diagnosticData, frozen.selected.params, dates, CONFIG.stressCost).summary }));
  const diagnosticAcceptance = acceptanceFor(diagnostic, CONFIG.final, diagnosticQuarters);

  const result = {
    generatedAt: new Date().toISOString(),
    version: 'funding-pair-v3',
    design: 'equal-notional cross-sectional funding carry pair',
    evidenceStatus: 'parameters_frozen_on_2021_2023_before_strategy_level_validation',
    selected: frozen.selected,
    costs: { base: CONFIG.baseCost, stress: CONFIG.stressCost, extreme: EXTREME_COST },
    training: { dates: CONFIG.train, base: training.base.summary, stress: training.stress.summary, extreme: training.extreme.summary, quarterlyStress: trainingQuarters, acceptance: trainingAcceptance },
    validation: { dates: CONFIG.validation, base: validation.base.summary, stress: validation.stress.summary, extreme: validation.extreme.summary, quarterlyStress: validationQuarters, acceptance: validationAcceptance },
    exposedDiagnostic: { dates: CONFIG.final, base: diagnostic.base.summary, stress: diagnostic.stress.summary, extreme: diagnostic.extreme.summary, quarterlyStress: diagnosticQuarters, acceptance: diagnosticAcceptance },
    candidates,
    caveats: [
      'The 12-symbol universe is fixed retrospectively and has survivorship bias.',
      'The simulation is dollar-neutral, not beta-neutral, and relative price moves can dominate funding carry.',
      'Full order-book depth, liquidation, ADL, and exchange outages are not modeled.',
      '2026-07-01 through 2026-07-11 funding archive was unavailable in the source dataset.'
    ]
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  const columns = ['longSymbol','shortSymbol','signalTime','entryTime','exitTime','longEntry','longExit','shortEntry','shortExit','longQty','shortQty','legNotional','signalSpread','pricePnl','fundingPnl','fees','netPnl','reason','hoursHeld'];
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_funding_pair_v3_validation_trades.csv'), serializeCsv(validation.base.run.trades, columns));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_funding_pair_v3_validation_equity.csv'), serializeCsv(validation.base.run.equity, ['time','equity','cash','position','grossExposure']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_funding_pair_v3_diagnostic_trades.csv'), serializeCsv(diagnostic.base.run.trades, columns));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_funding_pair_v3_diagnostic_equity.csv'), serializeCsv(diagnostic.base.run.equity, ['time','equity','cash','position','grossExposure']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_funding_pair_v3_summary.md'), summaryMarkdown(result));
  return { resultFile: RESULT_FILE, sha256: crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex'), selected: selected.id, validationPass: validationAcceptance.gate.pass, diagnosticPass: diagnosticAcceptance.gate.pass };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runAll(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { pairMetric, evaluatePeriod, evaluateTrainingCandidate, acceptanceFor, runAll };
