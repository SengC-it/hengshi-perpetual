const fs = require('fs');
const path = require('path');
const { runAll } = require('./v74_forward');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');
const CANDIDATE_FILE = path.join(ROOT, 'forward_candidate_v92.json');
const DOWNLOAD_START = Date.parse('2026-07-01T00:00:00Z');

function dataEndFromArgs(args = process.argv.slice(2)) {
  const value = args.find(argument => argument.startsWith('--end='))?.slice('--end='.length);
  if (!value) {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return Date.parse(`${yesterday.toISOString().slice(0, 10)}T20:00:00Z`);
  }
  const parsed = Date.parse(`${value}T20:00:00Z`);
  if (!Number.isFinite(parsed)) throw new Error(`invalid --end date: ${value}`);
  return parsed;
}

async function run(args) {
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'));
  const dataEnd = dataEndFromArgs(args);
  if (dataEnd < candidate.validFrom) throw new Error('no independent V9.2 forward day is complete yet');
  const endDate = new Date(dataEnd).toISOString().slice(0, 10);
  return runAll({
    candidateFile: CANDIDATE_FILE,
    resultFile: path.join(OUTPUT_DIR, `binance_all_perpetuals_v92_forward_${endDate}.json`),
    outputPrefix: 'binance_all_perpetuals_v92_forward',
    forwardStart: candidate.validFrom,
    downloadStart: DOWNLOAD_START,
    dataEnd,
    updateCandidate: true,
    evidenceStatus: 'FROZEN_INDEPENDENT_FORWARD',
    status: 'PAPER_ONLY_FORWARD_IN_PROGRESS'
  });
}

if (require.main === module) {
  run().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { dataEndFromArgs, run };
