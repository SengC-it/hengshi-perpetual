const DAY = 86400000;

const FEATURE_NAMES = [
  'directionalPremiumZ',
  'directionalPremiumBps',
  'barTakerImbalance',
  'metricsTakerLog',
  'topTraderPositionLog',
  'topTraderAccountLog',
  'accountRatioLog',
  'oiChange24h',
  'logOpenInterest',
  'logVolumeRatio',
  'breakoutAtr',
  'marketCm',
  'layerLiquid',
  'layerHighVol',
  'sideLong'
];

function clip(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function safeLog(value) {
  return value > 0 && Number.isFinite(value) ? Math.log(value) : 0;
}

function featureVector(event, layer) {
  const metrics = event.metrics || {}, side = event.side === -1 ? -1 : 1;
  return {
    directionalPremiumZ: clip(side * event.premiumZ, -10, 10),
    directionalPremiumBps: clip(side * event.premium * 10000, -50, 50),
    barTakerImbalance: clip(side * (2 * event.takerShare - 1), -1, 1),
    metricsTakerLog: clip(side * safeLog(metrics.takerRatio), -2, 2),
    topTraderPositionLog: clip(side * safeLog(metrics.topTraderPositionRatio), -2, 2),
    topTraderAccountLog: clip(side * safeLog(metrics.topTraderAccountRatio), -2, 2),
    accountRatioLog: clip(side * safeLog(metrics.accountRatio), -2, 2),
    oiChange24h: clip(metrics.oiChange24h, -0.5, 2),
    logOpenInterest: clip(safeLog(1 + metrics.openInterestValue), 0, 30),
    logVolumeRatio: clip(safeLog(event.volumeRatio), -2, 4),
    breakoutAtr: clip(event.breakoutAtr, -1, 10),
    marketCm: event.market === 'cm' ? 1 : 0,
    layerLiquid: String(layer).startsWith('liquid_') ? 1 : 0,
    layerHighVol: String(layer).endsWith('high_vol') ? 1 : 0,
    sideLong: side === 1 ? 1 : 0
  };
}

function solveLinear(matrix, values) {
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < augmented.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < augmented.length; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error('ridge matrix is singular');
    for (let cursor = column; cursor <= augmented.length; cursor++) augmented[column][cursor] /= divisor;
    for (let row = 0; row < augmented.length; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let cursor = column; cursor <= augmented.length; cursor++) augmented[row][cursor] -= factor * augmented[column][cursor];
    }
  }
  return augmented.map(row => row.at(-1));
}

function fitRidge(rows, featureNames = FEATURE_NAMES, lambda = 1) {
  if (!rows.length) throw new Error('ridge requires training rows');
  const means = {}, scales = {};
  for (const name of featureNames) {
    means[name] = rows.reduce((sum, row) => sum + row.features[name], 0) / rows.length;
    const variance = rows.reduce((sum, row) => sum + (row.features[name] - means[name]) ** 2, 0) / rows.length;
    scales[name] = Math.sqrt(variance) || 1;
  }
  const size = featureNames.length + 1;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const values = Array(size).fill(0);
  for (const row of rows) {
    const x = [1, ...featureNames.map(name => (row.features[name] - means[name]) / scales[name])];
    for (let left = 0; left < size; left++) {
      values[left] += x[left] * row.target / rows.length;
      for (let right = 0; right < size; right++) matrix[left][right] += x[left] * x[right] / rows.length;
    }
  }
  for (let index = 1; index < size; index++) matrix[index][index] += lambda;
  const coefficients = solveLinear(matrix, values);
  return { featureNames, means, scales, lambda, intercept: coefficients[0], coefficients: Object.fromEntries(featureNames.map((name, index) => [name, coefficients[index + 1]])) };
}

function predictRidge(model, features) {
  return model.intercept + model.featureNames.reduce((sum, name) => sum
    + model.coefficients[name] * (features[name] - model.means[name]) / model.scales[name], 0);
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = clip(probability, 0, 1) * (sorted.length - 1), lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function quantileForTargetRate(eventCount, spanDays, targetPerDay) {
  if (!(eventCount > 0) || !(spanDays > 0) || !(targetPerDay > 0)) return 1;
  return clip(1 - targetPerDay / (eventCount / spanDays), 0, 1);
}

function trainingRowsForFold(rows, foldStart, lookbackDays = 730) {
  const start = foldStart - lookbackDays * DAY;
  return rows.filter(row => row.signalTime >= start && row.exitTime < foldStart);
}

module.exports = {
  FEATURE_NAMES,
  clip,
  featureVector,
  fitRidge,
  predictRidge,
  quantile,
  quantileForTargetRate,
  trainingRowsForFold
};
