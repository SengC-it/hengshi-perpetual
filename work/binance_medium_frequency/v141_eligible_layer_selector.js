const path = require('path');
const { runAll: runV14 } = require('./v14_causal_reversal_selector');

const OUTPUT_FILE = path.resolve(__dirname, '..', '..', 'outputs', 'binance_all_perpetuals_v141_eligible_layer_selector.json');

function runAll() {
  return runV14({
    outputFile: OUTPUT_FILE,
    eligibleTrainingOnly: true,
    version: 'v14.1-eligible-layer-only-causal-reversal-selector'
  });
}

if (require.main === module) {
  try {
    const result = runAll();
    console.log(JSON.stringify({
      outputFile: result.outputFile,
      researchStatus: result.researchStatus,
      validationPass: result.validationPass,
      bestValidatedCandidate: result.bestValidatedCandidate,
      universe: result.universe,
      targetSummary: result.targetSummary,
      variants: result.variants.map(row => ({
        id: row.id,
        modelCandidates: row.modelCandidates,
        stressReturn: row.stress.totalReturn,
        extremeReturn: row.extreme.totalReturn,
        frequency: row.stress.operationalSignalsPerDay,
        trades: row.stress.trades,
        longTrades: row.stress.longTrades,
        longProfitFactor: row.stress.longAudit.profitFactor,
        longWithoutBest5: row.stress.longAudit.profitWithoutBest5,
        headlineSuperior: row.versusV124.headlineSuperior,
        leaveOneOutPass: row.leaveOneQuarterOut.pass,
        minimumLongWithoutBest5: row.leaveOneQuarterOut.minimumLongWithoutBest5,
        validationPass: row.validationPass
      }))
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { OUTPUT_FILE, runAll };
