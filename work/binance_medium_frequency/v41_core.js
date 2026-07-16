function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function classifyUniverse(rows, minimumHistoryBars = 1080) {
  const eligible = rows.filter(row => row.historyBars >= minimumHistoryBars && row.quoteVolume > 0 && row.volatility > 0);
  const volumeCut = median(eligible.map(row => row.quoteVolume));
  const volatilityCut = median(eligible.map(row => row.volatility));
  const result = new Map(rows.map(row => [row.symbol, 'insufficient_history']));
  for (const row of eligible) {
    const liquidity = row.quoteVolume >= volumeCut ? 'liquid' : 'tail';
    const volatility = row.volatility >= volatilityCut ? 'high_vol' : 'low_vol';
    result.set(row.symbol, `${liquidity}_${volatility}`);
  }
  return result;
}

function finite(value) { return Number.isFinite(value) ? value : 0; }

function chooseLayerStrategy(rows) {
  const eligible = rows.filter(row => row.trades >= 30 && row.profitFactor > 1.05 && row.totalReturn > 0 && row.medianQuarterPf > 1);
  if (!eligible.length) return { family: 'cash', reason: 'no_training_candidate_passed' };
  return eligible.slice().sort((a, b) => finite(b.medianQuarterPf) - finite(a.medianQuarterPf)
    || finite(b.profitFactor) - finite(a.profitFactor)
    || finite(b.totalReturn) - finite(a.totalReturn)
    || a.family.localeCompare(b.family))[0];
}

function signalAcceptance({
  finalSignals,
  executedSignals,
  signalsPerDay,
  stress,
  extreme,
  positiveQuarterShare,
  profitWithoutBest10,
  bootstrapProbabilityPositive,
  longRobust,
  shortRobust,
  profitableLayers,
  maxSymbolContribution
}) {
  const checks = {
    completeSignalCoverage: finalSignals === executedSignals,
    frequency: signalsPerDay >= 0.5 && signalsPerDay <= 2,
    tradeCount: stress.trades >= 300,
    stressProfitFactor: stress.profitFactor >= 1.15,
    extremeProfitFactor: extreme.profitFactor >= 1,
    stressPositiveReturn: stress.totalReturn > 0,
    drawdown: stress.maxDrawdown > -0.25,
    positiveQuarters: positiveQuarterShare >= 0.625,
    withoutBestTen: profitWithoutBest10 > 0,
    bootstrapProbability: bootstrapProbabilityPositive >= 0.70,
    longRobust: longRobust === true,
    shortRobust: shortRobust === true,
    layerBreadth: profitableLayers >= 2,
    symbolConcentration: maxSymbolContribution <= 0.20
  };
  return { pass: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) };
}

module.exports = { median, classifyUniverse, chooseLayerStrategy, signalAcceptance };

