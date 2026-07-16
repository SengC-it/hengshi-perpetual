const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chooseCandidate, summarize } = require('./btc_oi_strategy');

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

function verifyPeriod(name, dates, expected) {
  const trades = parseCsv(path.join(OUTPUT_DIR, `binance_futures_btc_oi_v4_${name}_trades.csv`));
  const equity = parseCsv(path.join(OUTPUT_DIR, `binance_futures_btc_oi_v4_${name}_equity.csv`));
  const actual = summarize({
    trades,
    equity,
    startTime: Date.parse(`${dates[0]}T00:00:00Z`),
    endTime: Date.parse(`${dates[1]}T00:00:00Z`)
  });
  const checks = {
    trades: actual.trades === expected.trades,
    profitFactor: nearlyEqual(actual.profitFactor, expected.profitFactor),
    totalReturn: nearlyEqual(actual.totalReturn, expected.totalReturn),
    maxDrawdown: nearlyEqual(actual.maxDrawdown, expected.maxDrawdown),
    netPnl: nearlyEqual(actual.netPnl, expected.netPnl),
    fees: nearlyEqual(actual.totalFees, expected.totalFees),
    funding: nearlyEqual(actual.totalFunding, expected.totalFunding)
  };
  return { pass: Object.values(checks).every(Boolean), checks, actual };
}

function validate() {
  const resultFile = path.join(OUTPUT_DIR, 'binance_futures_btc_oi_v4_results.json');
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const development = JSON.parse(fs.readFileSync(path.join(ROOT, 'btc-oi-development-results.json'), 'utf8'));
  const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'btc-oi-frozen-params.json'), 'utf8'));
  const selectedAgain = chooseCandidate(development.candidates);
  const validation = verifyPeriod('validation', result.validation.dates, result.validation.base);
  const diagnostic = verifyPeriod('diagnostic', result.exposedDiagnostic.dates, result.exposedDiagnostic.base);
  const checks = {
    selectionReproduced: selectedAgain.id === result.selected.id,
    freezeMatchesResult: JSON.stringify(frozen.selected.params) === JSON.stringify(result.selected.params),
    selectedOnlyFromTraining: development.selectionDates[1] === result.training.dates[1],
    validationCsvReproduced: validation.pass,
    diagnosticCsvReproduced: diagnostic.pass,
    evidenceLabelPresent: result.evidenceStatus === 'parameters_frozen_on_2021_2023_before_2024_2025_validation'
  };
  const output = {
    generatedAt: new Date().toISOString(),
    pass: Object.values(checks).every(Boolean),
    checks,
    validation,
    diagnostic,
    resultSha256: crypto.createHash('sha256').update(fs.readFileSync(resultFile)).digest('hex')
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'binance_futures_btc_oi_v4_validation.json'), JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) {
  try { console.log(JSON.stringify(validate(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { parseCsv, verifyPeriod, validate };

