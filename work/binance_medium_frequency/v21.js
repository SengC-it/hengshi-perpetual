const V21_GRID = [1.5, 2].flatMap(stopAtr => [72, 96].map(maxHoldHours => ({
  fast: 50,
  slow: 200,
  shortMomentum: 24,
  longMomentum: 96,
  sideMode: 'strict_long',
  stopAtr,
  maxHoldHours
})));

function median(values) {
  if (!values.length) return null;
  const rows = values.slice().sort((a, b) => a - b);
  return rows.length % 2 ? rows[(rows.length - 1) / 2] : (rows[rows.length / 2 - 1] + rows[rows.length / 2]) / 2;
}

function excursionGroup(rows) {
  return {
    trades: rows.length,
    medianMfeAtr: median(rows.map(x => x.mfeAtr).filter(Number.isFinite)),
    medianMaeAtr: median(rows.map(x => x.maeAtr).filter(Number.isFinite)),
    lowFollowThroughShare: rows.length ? rows.filter(x => Number.isFinite(x.mfeAtr) && x.mfeAtr < 0.5).length / rows.length : 0
  };
}

function excursionSummary(trades) {
  return {
    trades: trades.length,
    stopShare: trades.length ? trades.filter(x => x.reason === 'stop').length / trades.length : 0,
    all: excursionGroup(trades),
    winners: excursionGroup(trades.filter(x => x.netPnl > 0)),
    losers: excursionGroup(trades.filter(x => x.netPnl <= 0))
  };
}

module.exports = { V21_GRID, excursionSummary };
