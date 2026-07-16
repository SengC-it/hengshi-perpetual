const fs = require('fs');
const { atr, ema, median } = require('./indicators');

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const FAMILY_CONFIG = Object.freeze({
  breakout: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 },
  momentum: { stopAtr: 1.8, trailAtr: 2.5, maxHoldBars: 12 },
  reversal: { stopAtr: 1.5, trailAtr: null, maxHoldBars: 6 }
});

function parseBars(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map(line => {
    const value = line.split(',');
    return { openTime: +value[0], o: +value[1], h: +value[2], l: +value[3], c: +value[4], v: +value[5], closeTime: +value[6], qv: +value[7], trades: +value[8], takerBuyQv: +value[9] };
  });
}

function parseFunding(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map(line => {
    const value = line.split(',');
    return { fundingTime: +value[0], fundingRate: +value[1] };
  });
}

function rollingMedianPrevious(values, window) {
  return values.map((_, index) => index < window ? null : median(values.slice(index - window, index)));
}

function prepareSymbol({ symbol, baseAsset, market, bars, funding }) {
  const closes = bars.map(bar => bar.c), quoteVolumes = bars.map(bar => bar.qv);
  return {
    symbol,
    baseAsset,
    market,
    bars,
    funding,
    fundingMap: new Map(funding.map(row => [row.fundingTime, row.fundingRate])),
    indexByTime: new Map(bars.map((bar, index) => [bar.openTime, index])),
    atr: atr(bars, 14),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    volumeMedian20: rollingMedianPrevious(quoteVolumes, 20)
  };
}

function familySignalAt(prepared, index, family) {
  const { bars, atr: atrs, ema20, ema50, volumeMedian20 } = prepared;
  const bar = bars[index], currentAtr = atrs[index], volumeMedian = volumeMedian20[index];
  if (!bar || !(currentAtr > 0) || !(volumeMedian > 0) || !(bar.qv > volumeMedian)) return null;
  if (family === 'breakout') {
    if (index < 20) return null;
    let high = -Infinity, low = Infinity;
    for (let i = index - 20; i < index; i++) { high = Math.max(high, bars[i].h); low = Math.min(low, bars[i].l); }
    if (bar.c > high) return { side: 1, score: (bar.c - high) / currentAtr + Math.log(bar.qv / volumeMedian) };
    if (bar.c < low) return { side: -1, score: (low - bar.c) / currentAtr + Math.log(bar.qv / volumeMedian) };
    return null;
  }
  if (family === 'momentum') {
    if (index < 50 || !(ema20[index] > 0) || !(ema50[index] > 0)) return null;
    const change = bar.c / bars[index - 12].c - 1, threshold = 1.5 * currentAtr / bar.c;
    if (change > threshold && ema20[index] > ema50[index]) return { side: 1, score: change / threshold + Math.log(bar.qv / volumeMedian) };
    if (change < -threshold && ema20[index] < ema50[index]) return { side: -1, score: -change / threshold + Math.log(bar.qv / volumeMedian) };
    return null;
  }
  if (family === 'reversal') {
    if (index < 50 || bar.qv <= 1.5 * volumeMedian) return null;
    const change = bar.c / bars[index - 6].c - 1, threshold = 2.5 * currentAtr / bar.c;
    const trendGap = Math.abs(ema20[index] / ema50[index] - 1);
    if (trendGap > 0.08) return null;
    if (change > threshold) return { side: -1, score: change / threshold + Math.log(bar.qv / volumeMedian) };
    if (change < -threshold) return { side: 1, score: -change / threshold + Math.log(bar.qv / volumeMedian) };
    return null;
  }
  throw new Error(`unknown family ${family}`);
}

function indexBefore(bars, time) {
  let low = 0, high = bars.length - 1, answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].openTime < time) { answer = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return answer;
}

function trailingStats(prepared, asOfTime, window = 540) {
  const index = indexBefore(prepared.bars, asOfTime), historyBars = index + 1;
  if (index < 1) return { symbol: prepared.symbol, historyBars, quoteVolume: 0, volatility: 0 };
  const start = Math.max(1, index - window + 1), quoteVolume = median(prepared.bars.slice(start, index + 1).map(bar => bar.qv));
  const returns = [];
  for (let i = start; i <= index; i++) returns.push(Math.log(prepared.bars[i].c / prepared.bars[i - 1].c));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volatility = Math.sqrt(returns.reduce((a, value) => a + (value - mean) ** 2, 0) / returns.length);
  return { symbol: prepared.symbol, historyBars, quoteVolume, volatility };
}

function stopFill(position, bar) {
  if (position.side === 1) {
    if (bar.o <= position.stop) return bar.o;
    if (bar.l <= position.stop) return position.stop;
  } else {
    if (bar.o >= position.stop) return bar.o;
    if (bar.h >= position.stop) return position.stop;
  }
  return null;
}

function summarizeAudit(trades) {
  const wins = trades.filter(trade => trade.netReturn > 0).reduce((sum, trade) => sum + trade.netReturn, 0);
  const losses = trades.filter(trade => trade.netReturn < 0).reduce((sum, trade) => sum + trade.netReturn, 0);
  return {
    trades: trades.length,
    winRate: trades.length ? trades.filter(trade => trade.netReturn > 0).length / trades.length : 0,
    profitFactor: losses < 0 ? wins / Math.abs(losses) : null,
    totalReturn: trades.reduce((sum, trade) => sum + trade.netReturn, 0),
    averageReturn: trades.length ? trades.reduce((sum, trade) => sum + trade.netReturn, 0) / trades.length : 0
  };
}

function auditFamily(prepared, family, startTime, endTime, cost) {
  const config = FAMILY_CONFIG[family], trades = [];
  let position = null, pending = null, lastIndex = -1;
  const close = (price, time, reason) => {
    const exitRatio = price / position.entryPrice;
    const grossReturn = position.side * (exitRatio - 1);
    const feeReturn = cost / 2 * (1 + exitRatio);
    trades.push({ symbol: prepared.symbol, baseAsset: prepared.baseAsset, market: prepared.market, family, side: position.side, signalTime: position.signalTime, entryTime: position.entryTime, exitTime: time, entryPrice: position.entryPrice, exitPrice: price, score: position.score, grossReturn, feeReturn, fundingReturn: position.fundingReturn, netReturn: grossReturn - feeReturn + position.fundingReturn, reason });
    position = null;
  };
  for (let index = 0; index < prepared.bars.length; index++) {
    const bar = prepared.bars[index], time = bar.openTime;
    if (time < startTime || time > endTime) continue;
    lastIndex = index;
    if (position) {
      const rate = prepared.fundingMap.get(time);
      if (Number.isFinite(rate)) position.fundingReturn += -position.side * (bar.o / position.entryPrice) * rate;
      if (position.exitNextOpen) close(bar.o, time, 'mean');
      else {
        const stop = stopFill(position, bar);
        if (stop != null) close(stop, time, 'stop');
        else if (index - position.entryIndex >= config.maxHoldBars) close(bar.o, time, 'time');
      }
    }
    if (!position && pending && pending.entryIndex === index) {
      const entry = bar.o, initialAtr = prepared.atr[pending.signalIndex];
      position = { ...pending, entryPrice: entry, entryTime: time, entryIndex: index, stop: entry - pending.side * config.stopAtr * initialAtr, best: entry, fundingReturn: 0, exitNextOpen: false };
      const sameBarStop = stopFill(position, bar);
      if (sameBarStop != null) close(sameBarStop, time, 'stop');
    }
    pending = null;
    if (position) {
      if (config.trailAtr != null) {
        if (position.side === 1) { position.best = Math.max(position.best, bar.h); position.stop = Math.max(position.stop, position.best - config.trailAtr * prepared.atr[index]); }
        else { position.best = Math.min(position.best, bar.l); position.stop = Math.min(position.stop, position.best + config.trailAtr * prepared.atr[index]); }
      }
      if (family === 'reversal' && ((position.side === 1 && bar.c >= prepared.ema20[index]) || (position.side === -1 && bar.c <= prepared.ema20[index]))) position.exitNextOpen = true;
    }
    if (!position && index + 1 < prepared.bars.length && prepared.bars[index + 1].openTime <= endTime) {
      const signal = familySignalAt(prepared, index, family);
      if (signal) pending = { ...signal, signalTime: time, signalIndex: index, entryIndex: index + 1 };
    }
  }
  if (position && lastIndex >= 0) close(prepared.bars[lastIndex].c, prepared.bars[lastIndex].openTime + FOUR_HOURS, 'end');
  return trades;
}

module.exports = { FOUR_HOURS, FAMILY_CONFIG, parseBars, parseFunding, prepareSymbol, familySignalAt, trailingStats, stopFill, summarizeAudit, auditFamily };
