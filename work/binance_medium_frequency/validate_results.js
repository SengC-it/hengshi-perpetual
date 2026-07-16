const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'outputs');

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/), header = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map(line => Object.fromEntries(line.split(',').map((value, i) => [header[i], value])));
}

function close(a, b, label) {
  if (Math.abs(a - b) > 1e-8) throw new Error(`${label} mismatch: ${a} vs ${b}`);
}

const result = JSON.parse(fs.readFileSync(path.join(OUT, 'binance_futures_4h_medium_frequency_results.json'), 'utf8'));
const expected = result.variants['2x_base'];
const trades = readCsv(path.join(OUT, 'binance_futures_4h_medium_frequency_trades.csv')).map(x => ({ ...x, netPnl: +x.netPnl, fees: +x.fees, fundingPnl: +x.fundingPnl }));
const equity = readCsv(path.join(OUT, 'binance_futures_4h_medium_frequency_equity.csv')).map(x => ({ time: +x.time, equity: +x.equity }));
const wins = trades.filter(x => x.netPnl > 0), losses = trades.filter(x => x.netPnl < 0);
const sum = x => x.reduce((a, b) => a + b, 0);
const pf = sum(wins.map(x => x.netPnl)) / Math.abs(sum(losses.map(x => x.netPnl)));
let peak = equity[0].equity, dd = 0;
for (const p of equity) { peak = Math.max(peak, p.equity); dd = Math.min(dd, p.equity / peak - 1); }
const totalReturn = equity.at(-1).equity / equity[0].equity - 1;
const symbolPnl = {};
for (const t of trades) symbolPnl[t.symbol] = (symbolPnl[t.symbol] || 0) + t.netPnl;
const positives = Object.values(symbolPnl).filter(x => x > 0), concentration = Math.max(...positives) / sum(positives);

close(trades.length, expected.trades, 'trade count');
close(pf, expected.profitFactor, 'profit factor');
close(dd, expected.maxDrawdown, 'max drawdown');
close(totalReturn, expected.totalReturn, 'total return');
close(sum(trades.map(x => x.fees)), expected.totalFees, 'fees');
close(sum(trades.map(x => x.fundingPnl)), expected.totalFunding, 'funding');
close(positives.length, expected.positiveSymbols, 'positive symbols');
close(concentration, expected.maxContributionShare, 'concentration');

console.log(JSON.stringify({ pass: true, trades: trades.length, profitFactor: pf, totalReturn, maxDrawdown: dd, fees: expected.totalFees, funding: expected.totalFunding, positiveSymbols: positives.length, concentration }, null, 2));
