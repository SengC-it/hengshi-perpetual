const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG } = require('./config');
const { loadDataset, metricRun, validationWindows, serializeCsv } = require('./run');
const { V2_RISK_SCALE, chooseV2Candidate, profitAfterRemovingBest, breakdownBySide } = require('./v2');
const { median, evaluatePeriod, buildAcceptance } = require('./v2_run');
const { V21_GRID, excursionSummary } = require('./v21');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const DEVELOPMENT_FILE = path.join(ROOT, 'v21-development-results.json');
const FROZEN_FILE = path.join(ROOT, 'v21-frozen-params.json');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v21_results.json');

function evaluateCandidate(data, params, index) {
  const train = metricRun(data, params, CONFIG.train, V2_RISK_SCALE, CONFIG.baseCost).summary;
  const validation = evaluatePeriod(data, params, CONFIG.validation);
  const quarterlyStress = validationWindows(...CONFIG.validation).map(dates => ({
    dates,
    ...metricRun(data, params, dates, V2_RISK_SCALE, CONFIG.stressCost).summary
  }));
  return {
    id: `v21p${String(index + 1).padStart(2, '0')}`,
    params,
    train,
    base: validation.base.summary,
    stress: validation.stress.summary,
    extreme: validation.extreme.summary,
    quarterlyStress,
    medianQuarterlyStressPf: median(quarterlyStress.map(x => x.profitFactor)),
    positiveQuarterShare: quarterlyStress.filter(x => x.totalReturn > 0).length / quarterlyStress.length,
    profitWithoutBest5: profitAfterRemovingBest(validation.stress.run.trades, 5),
    validationExcursions: excursionSummary(validation.base.run.trades)
  };
}

function freezeSelected(selected) {
  const payload = {
    createdAt: new Date().toISOString(),
    status: 'exploratory_historical_selection_no_clean_holdout',
    selected,
    provenance: {
      developmentCutoff: CONFIG.validation[1],
      exposedDiagnosticRange: CONFIG.final,
      hypothesis: 'strict long synchronization: BTC bull and rising EMA50, >=65% breadth above EMA50, candidate 24h/96h momentum positive',
      executionChange: 'same-entry-bar stop is evaluated conservatively; MAE/MFE recorded in ATR units',
      dataManifest: path.join(ROOT, 'data', 'data-manifest.json')
    }
  };
  if (fs.existsSync(FROZEN_FILE)) {
    const existing = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
    if (JSON.stringify(existing.selected.params) !== JSON.stringify(selected.params)) throw new Error('existing V2.1 freeze differs from newly selected candidate');
    return existing;
  }
  fs.writeFileSync(FROZEN_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

function conciseCandidate(candidate) {
  return {
    id: candidate.id,
    params: candidate.params,
    train: candidate.train,
    base: candidate.base,
    stress: candidate.stress,
    extreme: candidate.extreme,
    medianQuarterlyStressPf: candidate.medianQuarterlyStressPf,
    positiveQuarterShare: candidate.positiveQuarterShare,
    profitWithoutBest5: candidate.profitWithoutBest5,
    validationExcursions: candidate.validationExcursions
  };
}

function summaryMarkdown(result) {
  const v = result.historicalValidation, d = result.exposedDiagnostic;
  const pct = value => `${(100 * value).toFixed(2)}%`;
  return `# 币安合约4小时中频系统 V2.1 验证\n\n` +
    `## 结论\n\n历史稳健性验收：**${v.acceptance.gate.pass ? '通过' : '未通过'}**。V2.1是严格同步多头研究，现有历史区间均已暴露。\n\n` +
    `## 冻结研究候选\n\n- 候选：${result.selected.id}\n- 止损：${result.selected.params.stopAtr} ATR\n- 最长持仓：${result.selected.params.maxHoldHours}小时\n- 条件：BTC牛市且EMA50上升、至少65%币种高于EMA50、候选24/96小时动量均为正\n\n` +
    `## 历史稳健性验证\n\n- 基准：${pct(v.base.totalReturn)}，PF ${v.base.profitFactor?.toFixed(3)}，回撤 ${pct(v.base.maxDrawdown)}，${v.base.trades}笔\n- 压力：${pct(v.stress.totalReturn)}，PF ${v.stress.profitFactor?.toFixed(3)}，回撤 ${pct(v.stress.maxDrawdown)}\n- 极端：${pct(v.extreme.totalReturn)}，PF ${v.extreme.profitFactor?.toFixed(3)}\n- 盈利季度：${pct(v.acceptance.positiveQuarterShare)}\n- 周区块重采样盈利比例：${pct(v.acceptance.bootstrap.probabilityPositive)}\n- 删除最佳5笔后的压力成本利润：${v.acceptance.profitWithoutBest5.toFixed(0)} USDT\n\n` +
    `## 已暴露区间诊断\n\n- 基准：${pct(d.base.totalReturn)}，PF ${d.base.profitFactor?.toFixed(3)}，回撤 ${pct(d.base.maxDrawdown)}，${d.base.trades}笔\n- 压力：${pct(d.stress.totalReturn)}，PF ${d.stress.profitFactor?.toFixed(3)}，回撤 ${pct(d.stress.maxDrawdown)}\n- 极端：${pct(d.extreme.totalReturn)}，PF ${d.extreme.profitFactor?.toFixed(3)}\n\n` +
    `## MAE/MFE\n\n历史验证亏损交易中，${pct(v.excursions.losers.lowFollowThroughShare)}从未达到0.5 ATR有利波动；所有交易止损占比为${pct(v.excursions.stopShare)}。\n\n` +
    `## 证据边界\n\nV2.1不能使用任何现有历史区间提供新的确认性证明。部署前必须依赖2026-07-14之后的前向模拟。\n`;
}

function runAll() {
  const developmentData = loadDataset(CONFIG.validation[1]);
  const candidates = V21_GRID.map((params, index) => evaluateCandidate(developmentData, params, index));
  const selected = chooseV2Candidate(candidates);
  const development = {
    generatedAt: new Date().toISOString(),
    version: '2.1',
    cutoff: CONFIG.validation[1],
    candidateCount: candidates.length,
    selectedId: selected.id,
    candidates
  };
  fs.writeFileSync(DEVELOPMENT_FILE, JSON.stringify(development, null, 2));
  const frozen = freezeSelected(selected);

  const validation = evaluatePeriod(developmentData, frozen.selected.params, CONFIG.validation);
  const validationQuarters = validationWindows(...CONFIG.validation).map(dates => ({ dates, ...metricRun(developmentData, frozen.selected.params, dates, V2_RISK_SCALE, CONFIG.stressCost).summary }));
  const validationAcceptance = buildAcceptance(validation, CONFIG.validation, validationQuarters);

  const diagnosticData = loadDataset(CONFIG.final[1]);
  const diagnostic = evaluatePeriod(diagnosticData, frozen.selected.params, CONFIG.final);
  const diagnosticQuarters = validationWindows(...CONFIG.final).map(dates => ({ dates, ...metricRun(diagnosticData, frozen.selected.params, dates, V2_RISK_SCALE, CONFIG.stressCost).summary }));
  const diagnosticAcceptance = buildAcceptance(diagnostic, CONFIG.final, diagnosticQuarters);

  const result = {
    generatedAt: new Date().toISOString(),
    version: '2.1',
    design: 'strict synchronized long-only 4h cross-sectional trend pullback',
    evidenceStatus: 'exploratory_historical_robustness_only_no_clean_holdout',
    execution: 'signal at close, next 4h open entry, conservative same-entry-bar stop, ATR-normalized MAE/MFE',
    selected: frozen.selected,
    costs: { base: CONFIG.baseCost, stress: CONFIG.stressCost, extreme: 0.0032 },
    risk: { approximateRiskPerTrade: CONFIG.riskPerTrade * V2_RISK_SCALE / 2, maxGross: CONFIG.maxGross * V2_RISK_SCALE / 2 },
    historicalValidation: {
      dates: CONFIG.validation,
      base: validation.base.summary,
      stress: validation.stress.summary,
      extreme: validation.extreme.summary,
      quarterlyStress: validationQuarters,
      acceptance: validationAcceptance,
      excursions: excursionSummary(validation.base.run.trades),
      baseSideBreakdown: breakdownBySide(validation.base.run.trades)
    },
    exposedDiagnostic: {
      dates: CONFIG.final,
      base: diagnostic.base.summary,
      stress: diagnostic.stress.summary,
      extreme: diagnostic.extreme.summary,
      quarterlyStress: diagnosticQuarters,
      acceptance: diagnosticAcceptance,
      excursions: excursionSummary(diagnostic.base.run.trades),
      baseSideBreakdown: breakdownBySide(diagnostic.base.run.trades)
    },
    candidates: candidates.map(conciseCandidate),
    caveats: [
      'V2.1 logic was informed by previously observed V1/V2 evidence; no existing historical interval is a clean holdout.',
      'The fixed 12-symbol universe has survivorship bias.',
      '2026-07-01 through 2026-07-11 funding archive was unavailable when the dataset was built.',
      'The simulator does not model full order-book depth, liquidation, ADL, or intrabar high-low ordering beyond conservative same-bar stop handling.'
    ]
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  const columns = ['symbol','side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld','initialAtr','mfeAtr','maeAtr'];
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v21_validation_trades.csv'), serializeCsv(validation.base.run.trades, columns));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v21_validation_equity.csv'), serializeCsv(validation.base.run.equity, ['time','equity','cash','grossExposure','positions']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v21_diagnostic_trades.csv'), serializeCsv(diagnostic.base.run.trades, columns));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v21_diagnostic_equity.csv'), serializeCsv(diagnostic.base.run.equity, ['time','equity','cash','grossExposure','positions']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v21_summary.md'), summaryMarkdown(result));
  return {
    resultFile: RESULT_FILE,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex'),
    selected: selected.id,
    validationPass: validationAcceptance.gate.pass,
    diagnosticPass: diagnosticAcceptance.gate.pass
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runAll(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { evaluateCandidate, summaryMarkdown, runAll };
