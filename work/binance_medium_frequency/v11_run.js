const path = require('path');
const { runAll: runCapacityVersion } = require('./v10_run');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const PORTFOLIO = {
  riskPerTrade: 0.0025,
  maxSignalsPerBar: 5,
  maxSignalsPerDay: 5,
  maxPositions: 9,
  maxGross: 1.5
};
const V10_BENCHMARK = {
  stressReturn: 0.16996588122723733,
  extremeReturn: 0.1311997740920181,
  operationalSignalsPerDay: 0.6144468149954282,
  trades: 336
};

function runAll() {
  return runCapacityVersion({
    label: 'V11',
    strategyVersion: 'all-perpetuals-unit-safe-layer-threshold-aggressive-capacity-v11',
    candidateVersion: 'v11-forward-2026q3',
    resultFile: path.join(OUTPUT_DIR, 'binance_all_perpetuals_v11_results.json'),
    candidateFile: path.join(ROOT, 'forward_candidate_v11.json'),
    outputPrefix: 'binance_all_perpetuals_v11',
    portfolio: PORTFOLIO,
    benchmarkName: 'V10',
    benchmark: V10_BENCHMARK,
    caveats: [
      'V11 was selected on previously exposed history and is not independent evidence.',
      'V11 raises only portfolio capacity; model features, layer thresholds, exits, per-trade risk and gross-exposure cap remain identical to V10.',
      'The fifth signal tier has lower marginal quality than the first four signals, so V11 is the aggressive paper candidate and V10 remains the lower-frequency benchmark.',
      'This rule change replaces V10 before its independent forward start and begins a new V11 forward clock.',
      'COIN-M remains scanned but is not eligible for execution.',
      'Four-hour OHLC, order-book depth, partial fills, liquidation, ADL, outages and tail gaps are not fully modeled.',
      'Passing historical gates does not prove future profitability.'
    ]
  });
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runAll(), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { PORTFOLIO, V10_BENCHMARK, runAll };
