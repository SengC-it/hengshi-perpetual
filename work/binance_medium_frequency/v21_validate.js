const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { summarize } = require('./metrics');
const { chooseV2Candidate } = require('./v2');
const { excursionSummary } = require('./v21');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split(',').map((value, index) => {
    const numeric = value !== '' && Number.isFinite(Number(value));
    return [headers[index], numeric ? Number(value) : value];
  })));
}

function nearlyEqual(a, b, tolerance = 1e-8) { return Math.abs(a - b) <= tolerance; }

function verifyPeriod(name, dates, expected, expectedExcursions) {
  const trades = parseCsv(path.join(OUTPUT_DIR, `binance_futures_4h_medium_frequency_v21_${name}_trades.csv`));
  const equity = parseCsv(path.join(OUTPUT_DIR, `binance_futures_4h_medium_frequency_v21_${name}_equity.csv`));
  const actual = summarize({
    trades,
    equity,
    startTime: Date.parse(`${dates[0]}T00:00:00Z`),
    endTime: Date.parse(`${dates[1]}T00:00:00Z`)
  });
  const excursions = excursionSummary(trades);
  const checks = {
    trades: actual.trades === expected.trades,
    profitFactor: nearlyEqual(actual.profitFactor, expected.profitFactor),
    totalReturn: nearlyEqual(actual.totalReturn, expected.totalReturn),
    maxDrawdown: nearlyEqual(actual.maxDrawdown, expected.maxDrawdown),
    fees: nearlyEqual(actual.totalFees, expected.totalFees),
    funding: nearlyEqual(actual.totalFunding, expected.totalFunding),
    stopShare: nearlyEqual(excursions.stopShare, expectedExcursions.stopShare),
    loserMedianMfe: nearlyEqual(excursions.losers.medianMfeAtr, expectedExcursions.losers.medianMfeAtr),
    loserMedianMae: nearlyEqual(excursions.losers.medianMaeAtr, expectedExcursions.losers.medianMaeAtr)
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    actual,
    excursions,
    sameEntryBarStops: trades.filter(x => x.reason === 'stop' && x.barsHeld === 0).length
  };
}

function validate() {
  const resultFile = path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v21_results.json');
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const development = JSON.parse(fs.readFileSync(path.join(ROOT, 'v21-development-results.json'), 'utf8'));
  const selectedAgain = chooseV2Candidate(development.candidates);
  const validation = verifyPeriod('validation', result.historicalValidation.dates, result.historicalValidation.base, result.historicalValidation.excursions);
  const diagnostic = verifyPeriod('diagnostic', result.exposedDiagnostic.dates, result.exposedDiagnostic.base, result.exposedDiagnostic.excursions);
  const checks = {
    selectionReproduced: selectedAgain.id === result.selected.id,
    validationCsvReproduced: validation.pass,
    diagnosticCsvReproduced: diagnostic.pass,
    evidenceLabelPresent: result.evidenceStatus === 'exploratory_historical_robustness_only_no_clean_holdout',
    excursionsPresent: validation.excursions.trades === result.historicalValidation.base.trades
  };
  const output = {
    generatedAt: new Date().toISOString(),
    pass: Object.values(checks).every(Boolean),
    checks,
    validation,
    diagnostic,
    resultSha256: crypto.createHash('sha256').update(fs.readFileSync(resultFile)).digest('hex')
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_4h_medium_frequency_v21_validation.json'), JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) {
  try { console.log(JSON.stringify(validate(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { parseCsv, verifyPeriod, validate };
