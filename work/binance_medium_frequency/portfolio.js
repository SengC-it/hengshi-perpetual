const { CONFIG } = require('./config');
const { atr } = require('./indicators');
const { computeRegime, prepareSymbol, entryCandidates } = require('./signals');

function positionSize({ equity, entry, stop, riskFraction, notionalCap }) {
  const distance = Math.abs(entry - stop);
  if (!(equity > 0) || !(entry > 0) || !(distance > 0)) return 0;
  return Math.max(0, Math.min(equity * riskFraction / distance, equity * notionalCap / entry));
}

function stopFillPrice(position, bar) {
  if (position.side === 1) {
    if (bar.o <= position.stop) return bar.o;
    if (bar.l <= position.stop) return position.stop;
  } else {
    if (bar.o >= position.stop) return bar.o;
    if (bar.h >= position.stop) return position.stop;
  }
  return null;
}

function updateExcursions(position, bar) {
  if (!(position.initialAtr > 0)) return position;
  const favorable = position.side === 1 ? bar.h - position.entryPrice : position.entryPrice - bar.l;
  const adverse = position.side === 1 ? position.entryPrice - bar.l : bar.h - position.entryPrice;
  position.mfeAtr = Math.max(position.mfeAtr || 0, favorable / position.initialAtr, 0);
  position.maeAtr = Math.max(position.maeAtr || 0, adverse / position.initialAtr, 0);
  return position;
}

function canAddPosition(positions, candidate, equity, limits) {
  if (positions.length >= limits.maxPositions) return false;
  if (positions.filter(p => p.side === candidate.side).length >= limits.maxSameSide) return false;
  if (positions.some(p => p.symbol === candidate.symbol)) return false;
  if (['BTCUSDT','ETHUSDT'].includes(candidate.symbol) && positions.some(p => p.side === candidate.side && ['BTCUSDT','ETHUSDT'].includes(p.symbol))) return false;
  return positions.reduce((a, p) => a + p.notional, 0) + candidate.notional <= equity * limits.maxGross + 1e-8;
}

function simulate({ barsBySymbol, fundingBySymbol = {}, params, start, end, leverageScale = 2, cost = CONFIG.baseCost, initialEquity = 100000 }) {
  const prepared = {}, indexMaps = {}, atrs = {};
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    prepared[symbol] = prepareSymbol(bars, params);
    atrs[symbol] = atr(bars, 14);
    indexMaps[symbol] = new Map(bars.map((b, i) => [b.openTime, i]));
  }
  const btc = barsBySymbol.BTCUSDT;
  if (!btc) throw new Error('BTCUSDT bars required');
  const regimes = computeRegime(btc, params), btcIndex = indexMaps.BTCUSDT;
  const from = Date.parse(`${start}T00:00:00Z`), to = Date.parse(`${end}T23:59:59.999Z`);
  const times = [...new Set(Object.values(barsBySymbol).flatMap(x => x.map(b => b.openTime)).filter(t => t >= from && t <= to))].sort((a, b) => a - b);
  const positions = [], trades = [], orders = [], equitySeries = [], cooldownUntil = new Map();
  let cash = initialEquity;
  const riskFraction = CONFIG.riskPerTrade * leverageScale / 2;
  const limits = { maxPositions: CONFIG.maxPositions, maxSameSide: CONFIG.maxSameSide, maxGross: CONFIG.maxGross * leverageScale / 2 };
  const symbolCap = CONFIG.maxSymbolNotional * leverageScale / 2;

  const markEquity = (time, useOpen = false) => cash + positions.reduce((sum, p) => {
    const i = indexMaps[p.symbol].get(time), bar = i == null ? null : barsBySymbol[p.symbol][i];
    const price = bar ? (useOpen ? bar.o : bar.c) : p.lastPrice;
    return sum + p.side * p.qty * (price - p.entryPrice);
  }, 0);

  function exitPosition(p, price, time, reason) {
    const grossPnl = p.side * p.qty * (price - p.entryPrice);
    const exitFee = p.qty * price * cost / 2;
    cash += grossPnl - exitFee;
    const netPnl = grossPnl - p.entryFee - exitFee + p.fundingPnl;
    trades.push({ symbol: p.symbol, side: p.side, signalTime: p.signalTime, entryTime: p.entryTime, exitTime: time, entryPrice: p.entryPrice, exitPrice: price, qty: p.qty, notional: p.notional, grossPnl, fees: p.entryFee + exitFee, fundingPnl: p.fundingPnl, netPnl, reason, barsHeld: Math.round((time - p.entryTime) / CONFIG.intervalMs), initialAtr: p.initialAtr, mfeAtr: p.mfeAtr, maeAtr: p.maeAtr });
    cooldownUntil.set(`${p.symbol}:${p.side}`, time + CONFIG.cooldownBars * CONFIG.intervalMs);
    positions.splice(positions.indexOf(p), 1);
  }

  for (const time of times) {
    for (const p of positions.slice()) {
      const i = indexMaps[p.symbol].get(time);
      if (i == null) continue;
      const bar = barsBySymbol[p.symbol][i];
      p.lastPrice = bar.c;
      updateExcursions(p, bar);
      const stopPrice = stopFillPrice(p, bar);
      if (stopPrice != null) { exitPosition(p, stopPrice, time, 'stop'); continue; }
      if ((time - p.entryTime) / 3600000 >= params.maxHoldHours) { exitPosition(p, bar.o, time, 'time'); continue; }
      for (const f of fundingBySymbol[p.symbol] || []) {
        if (f.fundingTime >= time && f.fundingTime < time + CONFIG.intervalMs && !p.fundingTimes.has(f.fundingTime)) {
          const mark = Number.isFinite(f.markPrice) ? f.markPrice : bar.c;
          const delta = -p.side * p.qty * mark * f.fundingRate;
          cash += delta; p.fundingPnl += delta; p.fundingTimes.add(f.fundingTime);
        }
      }
    }

    const equityAtOpen = markEquity(time, true);
    const currentBtc = btcIndex.get(time), signalBtc = currentBtc == null ? null : currentBtc - 1;
    if (signalBtc != null && signalBtc >= 0 && equityAtOpen > initialEquity * CONFIG.stopEquityFloor) {
      const indexBySymbol = {};
      for (const symbol of Object.keys(prepared)) {
        const i = indexMaps[symbol].get(time);
        if (i != null && i - 1 >= CONFIG.eligibilityBars) indexBySymbol[symbol] = i - 1;
      }
      const candidates = entryCandidates({ prepared, indexBySymbol, regime: regimes[signalBtc] });
      for (const c of candidates) {
        if ((cooldownUntil.get(`${c.symbol}:${c.side}`) || 0) > time) continue;
        const i = indexMaps[c.symbol].get(time), bar = i == null ? null : barsBySymbol[c.symbol][i], signalI = i - 1;
        if (!bar || atrs[c.symbol][signalI] == null) continue;
        const entry = bar.o, stop = entry - c.side * params.stopAtr * atrs[c.symbol][signalI];
        const equityNow = markEquity(time, true);
        const qty = positionSize({ equity: equityNow, entry, stop, riskFraction, notionalCap: symbolCap });
        const notional = qty * entry;
        const candidate = { ...c, qty, entry, stop, notional };
        if (!(qty > 0) || !canAddPosition(positions, candidate, equityNow, limits)) continue;
        const entryFee = notional * cost / 2; cash -= entryFee;
        positions.push({ symbol: c.symbol, side: c.side, qty, notional, entryPrice: entry, stop, signalTime: c.signalTime, entryTime: time, entryFee, fundingPnl: 0, fundingTimes: new Set(), lastPrice: entry, best: entry, initialAtr: atrs[c.symbol][signalI], mfeAtr: 0, maeAtr: 0 });
        orders.push({ symbol: c.symbol, side: c.side, signalTime: c.signalTime, fillTime: time, fillPrice: entry, qty, notional, score: c.score });
      }
    }

    for (const p of positions.slice()) {
      const i = indexMaps[p.symbol].get(time);
      if (i == null) continue;
      const bar = barsBySymbol[p.symbol][i], a = atrs[p.symbol][i];
      if (a == null) continue;
      if (p.entryTime === time) {
        updateExcursions(p, bar);
        const sameBarStop = stopFillPrice(p, bar);
        if (sameBarStop != null) { exitPosition(p, sameBarStop, time, 'stop'); continue; }
      }
      if (p.side === 1) { p.best = Math.max(p.best, bar.h); p.stop = Math.max(p.stop, p.best - 2 * a); }
      else { p.best = Math.min(p.best, bar.l); p.stop = Math.min(p.stop, p.best + 2 * a); }
    }
    equitySeries.push({ time, equity: markEquity(time), cash, grossExposure: positions.reduce((a, p) => a + p.notional, 0), positions: positions.length });
  }
  const lastTime = times.at(-1);
  for (const p of positions.slice()) {
    const i = indexMaps[p.symbol].get(lastTime), price = i == null ? p.lastPrice : barsBySymbol[p.symbol][i].c;
    exitPosition(p, price, lastTime, 'end');
  }
  if (equitySeries.length) equitySeries[equitySeries.length - 1].equity = cash;
  return { trades, equity: equitySeries, orders, warnings: [] };
}

module.exports = { positionSize, stopFillPrice, updateExcursions, canAddPosition, simulate };
