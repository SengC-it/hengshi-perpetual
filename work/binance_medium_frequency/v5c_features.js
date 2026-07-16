const fs = require('fs');

function rollingPremiumFeatures(values, window = 126) {
  const close = values.slice(), z = Array(values.length).fill(null), queue = [];
  let sum = 0, sumSq = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (Number.isFinite(value) && queue.length >= Math.min(30, window)) {
      const mean = sum / queue.length, variance = Math.max(0, sumSq / queue.length - mean ** 2), deviation = Math.sqrt(variance);
      z[index] = deviation > 1e-12 ? (value - mean) / deviation : (value === mean ? 0 : Math.sign(value - mean) * Infinity);
    }
    if (Number.isFinite(value)) { queue.push(value); sum += value; sumSq += value ** 2; }
    if (queue.length > window) { const removed = queue.shift(); sum -= removed; sumSq -= removed ** 2; }
  }
  return { close, z };
}

function loadPremium(file, bars) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean), byTime = new Map();
  for (const line of lines) { const value = line.split(','); byTime.set(Number(value[0]), Number(value[4])); }
  const values = bars.map(bar => byTime.get(bar.openTime) ?? null);
  return rollingPremiumFeatures(values);
}

function potentialEventsAt(prepared, index) {
  if (index < 42 || index + 1 >= prepared.bars.length) return [];
  const bar = prepared.bars[index], premium = prepared.premium?.close[index], premiumZ = prepared.premium?.z[index];
  const funding = prepared.fundingAverage?.[21]?.[index], beta = prepared.factor?.beta[index], volatility = prepared.factor?.volatility[index];
  const residual = prepared.factor?.residualReturn(index, 42), residualZ = Number.isFinite(residual) && volatility > 0 ? residual / (volatility * Math.sqrt(42)) : null;
  const takerShare = bar.qv > 0 ? bar.takerBuyQv / bar.qv : null, volumeMedian = prepared.volumeMedian20[index];
  if (![premium,premiumZ,funding,beta,volatility,residualZ,takerShare,volumeMedian].every(Number.isFinite)) return [];
  const common = { signalTime: bar.openTime, entryTime: prepared.bars[index + 1].openTime, premium, premiumZ, funding, beta, volatility, residualZ, takerShare };
  const events = [];
  if (premiumZ >= 2 && funding >= 0.00005 && residualZ >= 1.5 && takerShare >= 0.60) events.push({ ...common, type: 'crowding_unwind', side: -1, score: premiumZ + residualZ + 5 * (takerShare - 0.5) });
  if (premiumZ <= -2 && funding <= -0.00001 && residualZ <= -1.5 && takerShare <= 0.40) events.push({ ...common, type: 'crowding_unwind', side: 1, score: -premiumZ - residualZ + 5 * (0.5 - takerShare) });
  let priorHigh = -Infinity, priorLow = Infinity;
  for (let cursor = index - 20; cursor < index; cursor++) { priorHigh = Math.max(priorHigh, prepared.bars[cursor].h); priorLow = Math.min(priorLow, prepared.bars[cursor].l); }
  if (bar.qv >= 1.5 * volumeMedian && bar.c > priorHigh && takerShare >= 0.60 && premium > 0 && premiumZ >= 0.5) events.push({ ...common, type: 'oi_breakout', side: 1, score: (bar.c - priorHigh) / (prepared.atr?.[index] || bar.c) + premiumZ + 5 * (takerShare - 0.5) });
  if (bar.qv >= 1.5 * volumeMedian && bar.c < priorLow && takerShare <= 0.40 && premium < 0 && premiumZ <= -0.5) events.push({ ...common, type: 'oi_breakout', side: -1, score: (priorLow - bar.c) / (prepared.atr?.[index] || bar.c) - premiumZ + 5 * (0.5 - takerShare) });
  return events;
}

function confirmWithMetrics(event, metrics) {
  if (!metrics || !(metrics.oiChange24h > 0)) return false;
  if (event.type === 'oi_breakout') return metrics.oiChange24h >= 0.02 && (event.side === 1 ? metrics.takerRatio >= 1.1 : metrics.takerRatio <= 0.9);
  if (event.type === 'crowding_unwind') {
    if (metrics.oiChange24h < 0.05) return false;
    if (event.side === -1) return metrics.topTraderPositionRatio >= 1.1 && metrics.accountRatio >= 1.1 && metrics.takerRatio >= 1.1;
    return metrics.topTraderPositionRatio <= 0.9 && metrics.accountRatio <= 0.9 && metrics.takerRatio <= 0.9;
  }
  return false;
}

function scanPotentialEvents(preparedSymbols, startTime, endTime) {
  const best = new Map();
  for (const prepared of preparedSymbols) for (let index = 42; index < prepared.bars.length - 1; index++) {
    const time = prepared.bars[index].openTime;
    if (time < startTime || time > endTime) continue;
    for (const event of potentialEventsAt(prepared, index)) {
      const day = new Date(event.signalTime).toISOString().slice(0, 10), key = `${prepared.market}:${prepared.symbol}:${day}:${event.type}`;
      const row = { ...event, market: prepared.market, symbol: prepared.symbol, baseAsset: prepared.baseAsset, day };
      if (!best.has(key) || row.score > best.get(key).score) best.set(key, row);
    }
  }
  return [...best.values()].sort((a, b) => a.signalTime - b.signalTime || a.symbol.localeCompare(b.symbol) || a.type.localeCompare(b.type));
}

module.exports = { rollingPremiumFeatures, loadPremium, potentialEventsAt, confirmWithMetrics, scanPotentialEvents };
