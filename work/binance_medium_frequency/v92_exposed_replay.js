const path = require('path');
const { runAll } = require('./v74_forward');

const ROOT = __dirname;
const OUTPUT_DIR = path.resolve(ROOT, '..', '..', 'outputs');

async function run() {
  return runAll({
    candidateFile: path.join(ROOT, 'forward_candidate_v92.json'),
    resultFile: path.join(OUTPUT_DIR, 'binance_all_perpetuals_v92_exposed_replay_2026-07-15.json'),
    outputPrefix: 'binance_all_perpetuals_v92_exposed_replay',
    forwardStart: Date.parse('2026-07-01T00:00:00Z'),
    downloadStart: Date.parse('2026-07-01T00:00:00Z'),
    dataEnd: Date.parse('2026-07-15T20:00:00Z'),
    updateCandidate: false,
    evidenceStatus: 'EXPOSED_REPLAY_NOT_INDEPENDENT_FORWARD',
    status: 'PAPER_ONLY_EXPOSED_REPLAY'
  });
}

if (require.main === module) {
  run().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { run };
