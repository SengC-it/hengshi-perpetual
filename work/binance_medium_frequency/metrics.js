function sum(values) { return values.reduce((a, b) => a + b, 0); }

function summarize({ trades, equity, startTime, endTime }) {
  const wins = trades.filter(t => t.netPnl > 0), losses = trades.filter(t => t.netPnl < 0);
  let maxDrawdown = 0, peak = equity[0]?.equity || 1;
  for (const p of equity) { peak = Math.max(peak, p.equity); maxDrawdown = Math.min(maxDrawdown, p.equity / peak - 1); }
  const first = equity[0]?.equity || 1, last = equity.at(-1)?.equity || first;
  const days = Math.max(1, (endTime - startTime) / 86400000 + 1);
  const symbolPnl = {};
  for (const t of trades) symbolPnl[t.symbol] = (symbolPnl[t.symbol] || 0) + t.netPnl;
  const positives = Object.values(symbolPnl).filter(x => x > 0), totalPositive = sum(positives);
  const sideRobust = side => { const x = trades.filter(t => t.side === side).map(t => t.netPnl).sort((a, b) => b - a); return x.length > 1 && sum(x.slice(1)) > 0; };
  return {
    trades: trades.length,
    entriesPerDay: trades.length / days,
    winRate: trades.length ? wins.length / trades.length : 0,
    expectancy: trades.length ? sum(trades.map(t => t.netPnl)) / trades.length : 0,
    profitFactor: losses.length ? sum(wins.map(t => t.netPnl)) / Math.abs(sum(losses.map(t => t.netPnl))) : null,
    totalReturn: last / first - 1,
    maxDrawdown,
    positiveSymbols: positives.length,
    maxContributionShare: totalPositive ? Math.max(...positives) / totalPositive : 1,
    longRobust: sideRobust(1),
    shortRobust: sideRobust(-1),
    totalFees: sum(trades.map(t => t.fees || 0)),
    totalFunding: sum(trades.map(t => t.fundingPnl || 0)),
    symbolPnl
  };
}

function acceptance(s) {
  const checks = {
    frequency: s.entriesPerDay >= 0.5 && s.entriesPerDay <= 2,
    tradeCount: s.trades >= 200,
    baseProfitFactor: s.profitFactor >= 1.25,
    stressProfitFactor: s.stressProfitFactor >= 1.10,
    positiveReturn: s.totalReturn > 0,
    drawdown: s.maxDrawdown > -0.35,
    breadth: s.positiveSymbols >= 6,
    concentration: s.maxContributionShare <= 0.35,
    longRobust: s.longRobust === true,
    shortRobust: s.shortRobust === true
  };
  return { pass: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) };
}

module.exports = { summarize, acceptance };
