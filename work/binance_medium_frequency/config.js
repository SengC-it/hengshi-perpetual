const SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','LTCUSDT','BCHUSDT'];

const CONFIG = Object.freeze({
  symbols: SYMBOLS,
  interval: '4h',
  intervalMs: 4 * 60 * 60 * 1000,
  eligibilityBars: 200,
  train: ['2021-02-06','2023-12-31'],
  validation: ['2024-01-01','2025-06-30'],
  final: ['2025-07-01','2026-07-11'],
  baseCost: 0.0016,
  stressCost: 0.0024,
  riskPerTrade: 0.0075,
  maxSymbolNotional: 0.5,
  maxGross: 2,
  maxPositions: 4,
  maxSameSide: 3,
  cooldownBars: 2,
  stopEquityFloor: 0.2
});

const PARAMETER_GRID = [
  { fast: 40, slow: 160 },
  { fast: 50, slow: 200 }
].flatMap(ema => [72, 96].flatMap(longMomentum => [1.5, 2].flatMap(stopAtr => [48, 72].map(maxHoldHours => ({
  ...ema, shortMomentum: 24, longMomentum, stopAtr, maxHoldHours
})))));

module.exports = { SYMBOLS, CONFIG, PARAMETER_GRID };
