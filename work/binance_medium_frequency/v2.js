const V2_RISK_SCALE = 4 / 3;

const V2_GRID = ['long_only', 'strict_short'].flatMap(sideMode => [1.5, 2].flatMap(stopAtr => [72, 96].map(maxHoldHours => ({
  fast: 50,
  slow: 200,
  shortMomentum: 24,
  longMomentum: 96,
  sideMode,
  stopAtr,
  maxHoldHours
}))));

function finite(value) { return Number.isFinite(value) ? value : 0; }

function chooseV2Candidate(rows) {
  if (!rows.length) throw new Error('no V2 candidates');
  return rows.slice().sort((a, b) => finite(b.medianQuarterlyStressPf) - finite(a.medianQuarterlyStressPf)
    || finite(b.positiveQuarterShare) - finite(a.positiveQuarterShare)
    || finite(b.stress?.profitFactor) - finite(a.stress?.profitFactor)
    || finite(b.stress?.totalReturn) - finite(a.stress?.totalReturn)
    || Math.abs(finite(a.stress?.maxDrawdown)) - Math.abs(finite(b.stress?.maxDrawdown))
    || a.id.localeCompare(b.id))[0];
}

function profitAfterRemovingBest(trades, count = 5) {
  return trades.map(t => t.netPnl).sort((a, b) => b - a).slice(count).reduce((a, b) => a + b, 0);
}

function weeklyBlockBootstrap(trades, startTime, iterations = 100000) {
  const blocks = new Map();
  for (const trade of trades) {
    const key = Math.floor((trade.entryTime - startTime) / (7 * 86400000));
    blocks.set(key, (blocks.get(key) || 0) + trade.netPnl);
  }
  const values = [...blocks.values()];
  if (!values.length) return { blocks: 0, probabilityPositive: 0, interval95: [0, 0] };
  let seed = 2463534242;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) total += values[Math.floor(random() * values.length)];
    samples.push(total);
  }
  samples.sort((a, b) => a - b);
  return {
    blocks: values.length,
    probabilityPositive: samples.filter(x => x > 0).length / iterations,
    interval95: [samples[Math.floor(iterations * 0.025)], samples[Math.floor(iterations * 0.975) - 1]]
  };
}

function v2Acceptance({ base, stress, extreme, positiveQuarterShare, profitWithoutBest5, bootstrapProbabilityPositive }) {
  const checks = {
    tradeCount: stress.trades >= 150,
    baseProfitFactor: base.profitFactor >= 1.30,
    stressProfitFactor: stress.profitFactor >= 1.15,
    extremeProfitFactor: extreme == null || extreme.profitFactor >= 1,
    stressPositiveReturn: stress.totalReturn > 0,
    drawdown: stress.maxDrawdown > -0.25,
    positiveQuarters: positiveQuarterShare >= 0.625,
    breadth: stress.positiveSymbols >= 6,
    concentration: stress.maxContributionShare <= 0.35,
    withoutBestFive: profitWithoutBest5 > 0,
    bootstrapProbability: bootstrapProbabilityPositive >= 0.70
  };
  return { pass: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) };
}

function breakdownBySide(trades) {
  const result = {};
  for (const [name, side] of [['long', 1], ['short', -1]]) {
    const rows = trades.filter(t => t.side === side);
    const wins = rows.filter(t => t.netPnl > 0).reduce((a, t) => a + t.netPnl, 0);
    const losses = rows.filter(t => t.netPnl < 0).reduce((a, t) => a + t.netPnl, 0);
    result[name] = {
      trades: rows.length,
      grossPnl: rows.reduce((a, t) => a + t.grossPnl, 0),
      fees: rows.reduce((a, t) => a + t.fees, 0),
      funding: rows.reduce((a, t) => a + t.fundingPnl, 0),
      netPnl: rows.reduce((a, t) => a + t.netPnl, 0),
      profitFactor: losses < 0 ? wins / Math.abs(losses) : null
    };
  }
  return result;
}

module.exports = { V2_GRID, V2_RISK_SCALE, chooseV2Candidate, profitAfterRemovingBest, weeklyBlockBootstrap, v2Acceptance, breakdownBySide };
