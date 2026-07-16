const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG } = require('./config');
const { loadDataset, metricRun, validationWindows, serializeCsv } = require('./run');
const {
  V2_GRID,
  V2_RISK_SCALE,
  chooseV2Candidate,
  profitAfterRemovingBest,
  weeklyBlockBootstrap,
  v2Acceptance,
  breakdownBySide
} = require('./v2');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const DEVELOPMENT_FILE = path.join(ROOT, 'v2-development-results.json');
const FROZEN_FILE = path.join(ROOT, 'v2-frozen-params.json');
const RESULT_FILE = path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v2_results.json');
const BASE_COST = CONFIG.baseCost;
const STRESS_COST = CONFIG.stressCost;
const EXTREME_COST = 0.0032;

function median(values) {
  const rows = values.map(x => Number.isFinite(x) ? x : 0).sort((a, b) => a - b);
  return rows.length % 2 ? rows[(rows.length - 1) / 2] : (rows[rows.length / 2 - 1] + rows[rows.length / 2]) / 2;
}

function evaluatePeriod(data, params, dates) {
  return {
    base: metricRun(data, params, dates, V2_RISK_SCALE, BASE_COST),
    stress: metricRun(data, params, dates, V2_RISK_SCALE, STRESS_COST),
    extreme: metricRun(data, params, dates, V2_RISK_SCALE, EXTREME_COST)
  };
}

function evaluateCandidate(data, params, index) {
  const train = metricRun(data, params, CONFIG.train, V2_RISK_SCALE, BASE_COST).summary;
  const validation = evaluatePeriod(data, params, CONFIG.validation);
  const windows = validationWindows(...CONFIG.validation);
  const quarters = windows.map(dates => {
    const evaluated = metricRun(data, params, dates, V2_RISK_SCALE, STRESS_COST);
    return { dates, ...evaluated.summary };
  });
  return {
    id: `v2p${String(index + 1).padStart(2, '0')}`,
    params,
    train,
    base: validation.base.summary,
    stress: validation.stress.summary,
    extreme: validation.extreme.summary,
    quarterlyStress: quarters,
    medianQuarterlyStressPf: median(quarters.map(x => x.profitFactor)),
    positiveQuarterShare: quarters.filter(x => x.totalReturn > 0).length / quarters.length,
    profitWithoutBest5: profitAfterRemovingBest(validation.stress.run.trades, 5)
  };
}

function freezeSelected(selected) {
  const payload = {
    createdAt: new Date().toISOString(),
    status: 'historically_selected_not_clean_holdout',
    selected,
    provenance: {
      developmentCutoff: CONFIG.validation[1],
      exposedDiagnosticRange: CONFIG.final,
      selectionRule: 'median quarterly stress-cost profit factor, then positive-quarter share, aggregate stress PF, return, drawdown',
      dataManifest: path.join(ROOT, 'data', 'data-manifest.json')
    }
  };
  if (fs.existsSync(FROZEN_FILE)) {
    const existing = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
    if (JSON.stringify(existing.selected.params) !== JSON.stringify(selected.params)) throw new Error('existing V2 freeze differs from newly selected candidate');
    return existing;
  }
  fs.writeFileSync(FROZEN_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

function buildAcceptance(evaluated, dates, quarters) {
  const bootstrap = weeklyBlockBootstrap(evaluated.stress.run.trades, Date.parse(`${dates[0]}T00:00:00Z`));
  const positiveQuarterShare = quarters.filter(x => x.totalReturn > 0).length / quarters.length;
  const profitWithoutBest5 = profitAfterRemovingBest(evaluated.stress.run.trades, 5);
  return {
    gate: v2Acceptance({
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
  const v = result.historicalValidation, d = result.exposedDiagnostic;
  const pct = x => `${(100 * x).toFixed(2)}%`;
  return `# 币安合约4小时中频系统 V2 验证\n\n` +
    `## 结论\n\n历史稳健性验收：**${v.acceptance.gate.pass ? '通过' : '未通过'}**。现有最终区间已经暴露，因此诊断结果不能视为新的独立样本外证明。\n\n` +
    `## 冻结候选\n\n- 候选：${result.selected.id}\n- 方向：${result.selected.params.sideMode}\n- 止损：${result.selected.params.stopAtr} ATR\n- 最长持仓：${result.selected.params.maxHoldHours} 小时\n- 风险刻度：单笔约0.5%，最大总敞口约1.33x\n\n` +
    `## 历史验证（2024-01-01至2025-06-30）\n\n- 基准成本：收益 ${pct(v.base.totalReturn)}，PF ${v.base.profitFactor?.toFixed(3)}，回撤 ${pct(v.base.maxDrawdown)}\n- 压力成本：收益 ${pct(v.stress.totalReturn)}，PF ${v.stress.profitFactor?.toFixed(3)}，回撤 ${pct(v.stress.maxDrawdown)}\n- 极端成本：收益 ${pct(v.extreme.totalReturn)}，PF ${v.extreme.profitFactor?.toFixed(3)}\n- 压力成本盈利季度占比：${pct(v.acceptance.positiveQuarterShare)}\n- 周区块重采样盈利比例：${pct(v.acceptance.bootstrap.probabilityPositive)}\n\n` +
    `## 已暴露区间诊断（2025-07-01至2026-07-11）\n\n- 基准成本：收益 ${pct(d.base.totalReturn)}，PF ${d.base.profitFactor?.toFixed(3)}，回撤 ${pct(d.base.maxDrawdown)}\n- 压力成本：收益 ${pct(d.stress.totalReturn)}，PF ${d.stress.profitFactor?.toFixed(3)}，回撤 ${pct(d.stress.maxDrawdown)}\n- 极端成本：收益 ${pct(d.extreme.totalReturn)}，PF ${d.extreme.profitFactor?.toFixed(3)}\n\n` +
    `## 证据边界\n\nV2改动受V1结果启发，所有现有历史区间都不再是完全未见数据。只有从2026-07-14之后积累的前向模拟结果，才能提供新的确认性证据。\n`;
}

function runAll() {
  const developmentData = loadDataset(CONFIG.validation[1]);
  const candidates = V2_GRID.map((params, index) => evaluateCandidate(developmentData, params, index));
  const selected = chooseV2Candidate(candidates);
  const development = {
    generatedAt: new Date().toISOString(),
    cutoff: CONFIG.validation[1],
    candidateCount: candidates.length,
    selectedId: selected.id,
    costs: { base: BASE_COST, stress: STRESS_COST, extreme: EXTREME_COST },
    riskScale: V2_RISK_SCALE,
    candidates
  };
  fs.writeFileSync(DEVELOPMENT_FILE, JSON.stringify(development, null, 2));
  const frozen = freezeSelected(selected);

  const validation = evaluatePeriod(developmentData, frozen.selected.params, CONFIG.validation);
  const validationQuarters = validationWindows(...CONFIG.validation).map(dates => ({ dates, ...metricRun(developmentData, frozen.selected.params, dates, V2_RISK_SCALE, STRESS_COST).summary }));
  const validationAcceptance = buildAcceptance(validation, CONFIG.validation, validationQuarters);

  const diagnosticData = loadDataset(CONFIG.final[1]);
  const diagnostic = evaluatePeriod(diagnosticData, frozen.selected.params, CONFIG.final);
  const diagnosticQuarters = validationWindows(...CONFIG.final).map(dates => ({ dates, ...metricRun(diagnosticData, frozen.selected.params, dates, V2_RISK_SCALE, STRESS_COST).summary }));
  const diagnosticAcceptance = buildAcceptance(diagnostic, CONFIG.final, diagnosticQuarters);

  const result = {
    generatedAt: new Date().toISOString(),
    design: 'V2 asymmetric 4h cross-sectional trend pullback',
    evidenceStatus: 'historical_robustness_only_no_clean_holdout',
    selected: frozen.selected,
    costs: { base: BASE_COST, stress: STRESS_COST, extreme: EXTREME_COST },
    risk: { approximateRiskPerTrade: CONFIG.riskPerTrade * V2_RISK_SCALE / 2, maxGross: CONFIG.maxGross * V2_RISK_SCALE / 2 },
    historicalValidation: {
      dates: CONFIG.validation,
      base: validation.base.summary,
      stress: validation.stress.summary,
      extreme: validation.extreme.summary,
      quarterlyStress: validationQuarters,
      acceptance: validationAcceptance
    },
    exposedDiagnostic: {
      dates: CONFIG.final,
      base: diagnostic.base.summary,
      stress: diagnostic.stress.summary,
      extreme: diagnostic.extreme.summary,
      quarterlyStress: diagnosticQuarters,
      acceptance: diagnosticAcceptance,
      baseSideBreakdown: breakdownBySide(diagnostic.base.run.trades)
    },
    candidates: candidates.map(x => ({ id: x.id, params: x.params, base: x.base, stress: x.stress, extreme: x.extreme, medianQuarterlyStressPf: x.medianQuarterlyStressPf, positiveQuarterShare: x.positiveQuarterShare, profitWithoutBest5: x.profitWithoutBest5 })),
    caveats: [
      'V2 hypotheses were informed by V1 validation and final diagnostics; no existing period is a clean new holdout.',
      '2026-07-01 through 2026-07-11 funding archive was unavailable when the source dataset was built.',
      'The fixed 12-symbol universe has survivorship bias and the simulation does not model full order-book depth, liquidation, or ADL.'
    ]
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v2_diagnostic_trades.csv'), serializeCsv(diagnostic.base.run.trades, ['symbol','side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v2_diagnostic_equity.csv'), serializeCsv(diagnostic.base.run.equity, ['time','equity','cash','grossExposure','positions']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v2_validation_trades.csv'), serializeCsv(validation.base.run.trades, ['symbol','side','signalTime','entryTime','exitTime','entryPrice','exitPrice','qty','notional','grossPnl','fees','fundingPnl','netPnl','reason','barsHeld']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v2_validation_equity.csv'), serializeCsv(validation.base.run.equity, ['time','equity','cash','grossExposure','positions']));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v2_summary.md'), summaryMarkdown(result));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(RESULT_FILE)).digest('hex');
  return { resultFile: RESULT_FILE, sha256: hash, selected: selected.id, validationPass: validationAcceptance.gate.pass, diagnosticPass: diagnosticAcceptance.gate.pass };
}

if (require.main === module) {
  try { console.log(JSON.stringify(runAll(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { median, evaluatePeriod, evaluateCandidate, buildAcceptance, runAll, summaryMarkdown };
