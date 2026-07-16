const FUNDING_GRID = [0.0005, 0.001].flatMap(threshold => [72, 168].map(maxHoldHours => ({
  threshold,
  maxHoldHours,
  rollingEvents: 3,
  minSymbols: 8,
  stopEquityFraction: 0.03,
  maxGross: 1
})));

function sum(values) { return values.reduce((a, b) => a + b, 0); }
function finite(value) { return Number.isFinite(value) ? value : 0; }

function chooseFundingCandidate(rows) {
  if (!rows.length) throw new Error('no funding candidates');
  return rows.slice().sort((a, b) => finite(b.medianQuarterlyStressPf) - finite(a.medianQuarterlyStressPf)
    || finite(b.positiveQuarterShare) - finite(a.positiveQuarterShare)
    || finite(b.stress?.profitFactor) - finite(a.stress?.profitFactor)
    || finite(b.stress?.totalReturn) - finite(a.stress?.totalReturn)
    || Math.abs(finite(a.stress?.maxDrawdown)) - Math.abs(finite(b.stress?.maxDrawdown))
    || a.id.localeCompare(b.id))[0];
}

function summarizeFundingPairs({ trades, equity, startTime, endTime }) {
  const wins = trades.filter(x => x.netPnl > 0), losses = trades.filter(x => x.netPnl < 0);
  let peak = equity[0]?.equity || 1, maxDrawdown = 0;
  for (const point of equity) { peak = Math.max(peak, point.equity); maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1); }
  const first = equity[0]?.equity || 1, last = equity.at(-1)?.equity || first;
  const pairPnl = {};
  for (const trade of trades) {
    const key = `${trade.longSymbol}|${trade.shortSymbol}`;
    pairPnl[key] = (pairPnl[key] || 0) + trade.netPnl;
  }
  const positives = Object.values(pairPnl).filter(x => x > 0), totalPositive = sum(positives);
  const days = Math.max(1, (endTime - startTime) / 86400000 + 1);
  return {
    trades: trades.length,
    entriesPerDay: trades.length / days,
    winRate: trades.length ? wins.length / trades.length : 0,
    expectancy: trades.length ? sum(trades.map(x => x.netPnl)) / trades.length : 0,
    profitFactor: losses.length ? sum(wins.map(x => x.netPnl)) / Math.abs(sum(losses.map(x => x.netPnl))) : null,
    totalReturn: last / first - 1,
    maxDrawdown,
    totalPricePnl: sum(trades.map(x => x.pricePnl || 0)),
    totalFundingPnl: sum(trades.map(x => x.fundingPnl || 0)),
    totalFees: sum(trades.map(x => x.fees || 0)),
    fundingToFees: sum(trades.map(x => x.fees || 0)) > 0 ? sum(trades.map(x => x.fundingPnl || 0)) / sum(trades.map(x => x.fees || 0)) : null,
    pairStopRate: trades.length ? trades.filter(x => x.reason === 'pair_stop').length / trades.length : 0,
    positivePairs: positives.length,
    maxContributionShare: totalPositive ? Math.max(...positives) / totalPositive : 1,
    pairPnl
  };
}

function fundingAcceptance({ base, stress, extreme, positiveQuarterShare, profitWithoutBest5, bootstrapProbabilityPositive }) {
  const checks = {
    tradeCount: stress.trades >= 50,
    baseProfitFactor: base.profitFactor >= 1.30,
    stressProfitFactor: stress.profitFactor >= 1.20,
    extremeProfitFactor: extreme.profitFactor >= 1,
    stressPositiveReturn: stress.totalReturn > 0,
    drawdown: stress.maxDrawdown > -0.20,
    positiveQuarters: positiveQuarterShare >= 0.625,
    concentration: stress.maxContributionShare <= 0.35,
    withoutBestFive: profitWithoutBest5 > 0,
    bootstrapProbability: bootstrapProbabilityPositive >= 0.70,
    positiveFundingCarry: stress.totalFundingPnl > 0
  };
  return { pass: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) };
}

module.exports = { FUNDING_GRID, chooseFundingCandidate, summarizeFundingPairs, fundingAcceptance };
