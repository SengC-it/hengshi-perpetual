const { downloadSymbolMetrics } = require('./download_btc_metrics');

const SYMBOLS = ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

async function main() {
  const results = [];
  for (const symbol of SYMBOLS) {
    console.error(`starting ${symbol}`);
    results.push(await downloadSymbolMetrics(symbol));
  }
  console.log(JSON.stringify(results, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { SYMBOLS, main };
