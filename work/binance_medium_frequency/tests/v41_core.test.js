const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUniverse, chooseLayerStrategy, signalAcceptance } = require('../v41_core');

test('universe classification uses only trailing liquidity and volatility ranks', () => {
  const rows = [
    { symbol: 'A', historyBars: 1200, quoteVolume: 1000, volatility: 0.01 },
    { symbol: 'B', historyBars: 1200, quoteVolume: 900, volatility: 0.10 },
    { symbol: 'C', historyBars: 1200, quoteVolume: 100, volatility: 0.02 },
    { symbol: 'D', historyBars: 1200, quoteVolume: 90, volatility: 0.20 },
    { symbol: 'NEW', historyBars: 100, quoteVolume: 5000, volatility: 0.30 }
  ];
  const result = classifyUniverse(rows, 1000);
  assert.equal(result.get('A'), 'liquid_low_vol');
  assert.equal(result.get('B'), 'liquid_high_vol');
  assert.equal(result.get('C'), 'tail_low_vol');
  assert.equal(result.get('D'), 'tail_high_vol');
  assert.equal(result.get('NEW'), 'insufficient_history');
});

test('layer selection keeps cash when no family passes training gates', () => {
  const selected = chooseLayerStrategy([
    { family: 'breakout', trades: 20, profitFactor: 2, totalReturn: 0.2, medianQuarterPf: 2 },
    { family: 'reversal', trades: 100, profitFactor: 0.9, totalReturn: -0.1, medianQuarterPf: 0.8 }
  ]);
  assert.equal(selected.family, 'cash');
});

test('layer selection prioritizes quarterly robustness over headline return', () => {
  const selected = chooseLayerStrategy([
    { family: 'breakout', trades: 100, profitFactor: 1.5, totalReturn: 0.3, medianQuarterPf: 1.01 },
    { family: 'momentum', trades: 80, profitFactor: 1.3, totalReturn: 0.1, medianQuarterPf: 1.20 }
  ]);
  assert.equal(selected.family, 'momentum');
});

test('signal acceptance requires every final signal to have a trade', () => {
  const result = signalAcceptance({
    finalSignals: 100,
    executedSignals: 99,
    signalsPerDay: 1,
    stress: { trades: 99, profitFactor: 1.3, totalReturn: 0.1, maxDrawdown: -0.1 },
    extreme: { profitFactor: 1.1 },
    positiveQuarterShare: 0.8,
    profitWithoutBest10: 1,
    bootstrapProbabilityPositive: 0.8,
    longRobust: true,
    shortRobust: true,
    profitableLayers: 2,
    maxSymbolContribution: 0.1
  });
  assert.equal(result.pass, false);
  assert.ok(result.failures.includes('completeSignalCoverage'));
});

