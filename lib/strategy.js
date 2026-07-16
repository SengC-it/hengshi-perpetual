import { STRATEGY } from '../config/strategy.js';
import { atr, clip, ema, rollingMedianPrevious, rollingZ, safeLog } from './math.js';

export function prepareSeries(marketSeries) {
  const bars = marketSeries.bars;
  const premiumByTime = new Map(marketSeries.premiums.map(row => [row.openTime, row.close]));
  const premiums = bars.map(bar => premiumByTime.get(bar.openTime) ?? null);
  const closes = bars.map(bar => bar.close);
  return {
    symbol: marketSeries.symbol,
    bars,
    premiums,
    premiumZ: rollingZ(premiums),
    atr: atr(bars, 14),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    volumeMedian20: rollingMedianPrevious(bars.map(bar => bar.quoteVolume), 20),
    indexByTime: new Map(bars.map((bar, index) => [bar.openTime, index]))
  };
}

export function latestCompletedIndex(prepared, now = Date.now()) {
  for (let index = prepared.bars.length - 1; index >= 0; index--) {
    if (prepared.bars[index].closeTime < now - 5000) return index;
  }
  return -1;
}

export function isRapidBull(preparedBtc, index) {
  const config = STRATEGY.rapidBull;
  if (index < config.returnLookbackBars) return false;
  return Number.isFinite(preparedBtc.ema20[index])
    && Number.isFinite(preparedBtc.ema50[index])
    && preparedBtc.ema20[index] > preparedBtc.ema50[index]
    && preparedBtc.bars[index].close / preparedBtc.bars[index - config.returnLookbackBars].close - 1
      > config.minimumReturn;
}

export function reversalLongAt(prepared, index, layer) {
  const config = STRATEGY.long;
  if (!STRATEGY.activeLayers.includes(layer) || index < Math.max(50, config.shockLookbackBars)) return null;
  const bar = prepared.bars[index];
  const currentAtr = prepared.atr[index];
  const volumeMedian = prepared.volumeMedian20[index];
  const trendGap = Math.abs(prepared.ema20[index] / prepared.ema50[index] - 1);
  if (!(currentAtr > 0)
    || !(volumeMedian > 0)
    || bar.quoteVolume <= config.volumeMultiple * volumeMedian
    || !Number.isFinite(trendGap)
    || trendGap > config.maximumTrendGap) return null;
  const change = bar.close / prepared.bars[index - config.shockLookbackBars].close - 1;
  const threshold = config.shockAtr * currentAtr / bar.close;
  if (!(change < -threshold)) return null;
  const score = -change / threshold + safeLog(bar.quoteVolume / volumeMedian);
  if (score < config.scoreCutoff) return null;
  return {
    family: 'reversal',
    side: 1,
    score,
    exit: config.exit,
    details: {
      change,
      threshold,
      trendGap,
      volumeRatio: bar.quoteVolume / volumeMedian
    }
  };
}

export function rawBreakoutShortAt(prepared, index, layer) {
  const config = STRATEGY.short;
  if (!STRATEGY.activeLayers.includes(layer) || index < 20) return null;
  const bar = prepared.bars[index];
  const premium = prepared.premiums[index];
  const premiumZ = prepared.premiumZ[index];
  const currentAtr = prepared.atr[index];
  const volumeMedian = prepared.volumeMedian20[index];
  const takerShare = bar.quoteVolume > 0 ? bar.takerBuyQuoteVolume / bar.quoteVolume : null;
  if (![premium, premiumZ, currentAtr, volumeMedian, takerShare].every(Number.isFinite)
    || !(currentAtr > 0)
    || !(volumeMedian > 0)) return null;
  let priorLow = Infinity;
  for (let cursor = index - 20; cursor < index; cursor++) {
    priorLow = Math.min(priorLow, prepared.bars[cursor].low);
  }
  const volumeRatio = bar.quoteVolume / volumeMedian;
  const selected = volumeRatio >= config.volumeMultiple
    && bar.close < priorLow
    && takerShare <= 0.5 - config.takerEdge
    && premium < 0
    && premiumZ <= -config.premiumZ;
  if (!selected) return null;
  return {
    family: 'breakout',
    side: -1,
    premium,
    premiumZ,
    takerShare,
    volumeRatio,
    breakoutAtr: (priorLow - bar.close) / currentAtr,
    exit: config.exit
  };
}

export function ridgeFeatures(event, layer, metrics) {
  const side = event.side === -1 ? -1 : 1;
  return {
    directionalPremiumZ: clip(side * event.premiumZ, -10, 10),
    directionalPremiumBps: clip(side * event.premium * 10000, -50, 50),
    barTakerImbalance: clip(side * (2 * event.takerShare - 1), -1, 1),
    metricsTakerLog: clip(side * safeLog(metrics.takerRatio), -2, 2),
    topTraderPositionLog: clip(side * safeLog(metrics.topTraderPositionRatio), -2, 2),
    topTraderAccountLog: clip(side * safeLog(metrics.topTraderAccountRatio), -2, 2),
    accountRatioLog: clip(side * safeLog(metrics.accountRatio), -2, 2),
    oiChange24h: clip(metrics.oiChange24h, -0.5, 2),
    logVolumeRatio: clip(safeLog(event.volumeRatio), -2, 4),
    breakoutAtr: clip(event.breakoutAtr, -1, 10),
    marketCm: 0,
    layerLiquid: String(layer).startsWith('liquid_') ? 1 : 0,
    layerHighVol: String(layer).endsWith('high_vol') ? 1 : 0,
    sideLong: side === 1 ? 1 : 0
  };
}

export function scoreBreakoutShort(event, layer, metrics) {
  const model = STRATEGY.short.model;
  if (!Object.values(metrics).every(Number.isFinite)) return null;
  const features = ridgeFeatures(event, layer, metrics);
  const score = model.intercept + model.featureNames.reduce((sum, name) => sum
    + model.coefficients[name] * (features[name] - model.means[name]) / model.scales[name], 0);
  const cutoff = STRATEGY.short.scoreCutoffByLayer[layer];
  if (!Number.isFinite(cutoff) || score < cutoff) return null;
  return {
    ...event,
    score,
    metrics,
    details: {
      premium: event.premium,
      premiumZ: event.premiumZ,
      takerShare: event.takerShare,
      volumeRatio: event.volumeRatio,
      breakoutAtr: event.breakoutAtr,
      cutoff
    }
  };
}
