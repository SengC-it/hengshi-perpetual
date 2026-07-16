const { FOUR_HOURS, FAMILY_CONFIG, familySignalAt, stopFill } = require('./v41_engine');

function positionSize({ equity, entry, stop, riskFraction = 0.0025, symbolCap = 0.35, remainingGross }) {
  const distance = Math.abs(entry - stop);
  if (!(equity > 0) || !(entry > 0) || !(distance > 0) || !(remainingGross > 0)) return 0;
  return Math.max(0, Math.min(equity * riskFraction / distance, equity * symbolCap / entry, remainingGross / entry));
}

function costForLayer(layer, scenario) {
  const tail = String(layer).startsWith('tail_');
  if (scenario === 'base') return tail ? 0.0024 : 0.0016;
  if (scenario === 'stress') return tail ? 0.0040 : 0.0024;
  if (scenario === 'extreme') return tail ? 0.0080 : 0.0040;
  throw new Error(`unknown cost scenario ${scenario}`);
}

function selectCandidates(candidates, { occupiedBases, slots, remainingToday, maxPerBar = 1 }) {
  const selected = [], used = new Set(occupiedBases);
  const limit = Math.max(0, Math.min(slots, remainingToday, maxPerBar));
  for (const candidate of candidates.slice().sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))) {
    if (selected.length >= limit) break;
    if (used.has(candidate.baseAsset)) continue;
    selected.push(candidate); used.add(candidate.baseAsset);
  }
  return selected;
}

function simulatePortfolioQuarter({ preparedSymbols, layers, selections, startTime, endTime, scenario, initialEquity = 100000 }) {
  const bySymbol = new Map(preparedSymbols.map(item => [item.symbol, item]));
  const eligible = preparedSymbols.filter(item => layers.get(item.symbol) && layers.get(item.symbol) !== 'insufficient_history' && selections[layers.get(item.symbol)]?.family !== 'cash');
  const positions = new Map(), trades = [], equity = [], finalSignals = [], candidateAudit = [];
  let pending = [], cash = initialEquity, executedSignals = 0;
  const dailySignals = new Map();

  const priceAt = (prepared, time, useOpen) => {
    const index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
    return bar ? (useOpen ? bar.o : bar.c) : null;
  };
  const markEquity = (time, useOpen = false) => cash + [...positions.values()].reduce((total, position) => {
    const price = priceAt(bySymbol.get(position.symbol), time, useOpen) ?? position.lastPrice;
    return total + position.side * position.qty * (price - position.entryPrice);
  }, 0);
  const grossExposure = time => [...positions.values()].reduce((total, position) => {
    const price = priceAt(bySymbol.get(position.symbol), time, true) ?? position.lastPrice;
    return total + position.qty * price;
  }, 0);
  const closePosition = (position, price, time, reason) => {
    const cost = costForLayer(position.layer, scenario), grossPnl = position.side * position.qty * (price - position.entryPrice);
    const exitFee = position.qty * price * cost / 2;
    cash += grossPnl - exitFee;
    trades.push({
      symbol: position.symbol, baseAsset: position.baseAsset, market: position.market, layer: position.layer, family: position.family,
      side: position.side, signalTime: position.signalTime, entryTime: position.entryTime, exitTime: time,
      entryPrice: position.entryPrice, exitPrice: price, qty: position.qty, notional: position.entryPrice * position.qty,
      score: position.score, grossPnl, fees: position.entryFee + exitFee, fundingPnl: position.fundingPnl,
      netPnl: grossPnl - position.entryFee - exitFee + position.fundingPnl, reason,
      barsHeld: Math.max(0, Math.round((time - position.entryTime) / FOUR_HOURS))
    });
    positions.delete(position.symbol);
  };

  for (let time = startTime; time <= endTime; time += FOUR_HOURS) {
    for (const position of [...positions.values()]) {
      const prepared = bySymbol.get(position.symbol), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
      if (!bar) {
        if (time > prepared.bars.at(-1).openTime) closePosition(position, position.lastPrice * (1 - position.side * 0.01), time, 'delist');
        continue;
      }
      position.lastPrice = bar.c;
      const rate = prepared.fundingMap.get(time);
      if (Number.isFinite(rate)) {
        const payment = -position.side * position.qty * bar.o * rate;
        cash += payment; position.fundingPnl += payment;
      }
      if (position.exitNextOpen) { closePosition(position, bar.o, time, 'mean'); continue; }
      const stop = stopFill(position, bar), config = FAMILY_CONFIG[position.family];
      if (stop != null) { closePosition(position, stop, time, 'stop'); continue; }
      if ((time - position.entryTime) / FOUR_HOURS >= config.maxHoldBars) { closePosition(position, bar.o, time, 'time'); continue; }
    }

    for (const signal of pending) {
      const prepared = bySymbol.get(signal.symbol), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
      if (!bar || positions.has(signal.symbol) || [...positions.values()].some(position => position.baseAsset === signal.baseAsset)) continue;
      const config = FAMILY_CONFIG[signal.family], initialAtr = prepared.atr[signal.signalIndex];
      const stop = bar.o - signal.side * config.stopAtr * initialAtr, openEquity = markEquity(time, true);
      const qty = positionSize({ equity: openEquity, entry: bar.o, stop, remainingGross: openEquity * 1.5 - grossExposure(time) });
      if (!(qty > 0)) continue;
      const cost = costForLayer(signal.layer, scenario), entryFee = qty * bar.o * cost / 2;
      cash -= entryFee; executedSignals++;
      const position = { ...signal, entryTime: time, entryPrice: bar.o, qty, stop, best: bar.o, entryFee, fundingPnl: 0, lastPrice: bar.o, exitNextOpen: false };
      positions.set(signal.symbol, position);
      const sameBarStop = stopFill(position, bar);
      if (sameBarStop != null) closePosition(position, sameBarStop, time, 'stop');
    }
    pending = [];

    for (const position of [...positions.values()]) {
      const prepared = bySymbol.get(position.symbol), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
      if (!bar) continue;
      const config = FAMILY_CONFIG[position.family], currentAtr = prepared.atr[index];
      if (config.trailAtr != null) {
        if (position.side === 1) { position.best = Math.max(position.best, bar.h); position.stop = Math.max(position.stop, position.best - config.trailAtr * currentAtr); }
        else { position.best = Math.min(position.best, bar.l); position.stop = Math.min(position.stop, position.best + config.trailAtr * currentAtr); }
      }
      if (position.family === 'reversal' && ((position.side === 1 && bar.c >= prepared.ema20[index]) || (position.side === -1 && bar.c <= prepared.ema20[index]))) position.exitNextOpen = true;
    }

    const candidates = [];
    for (const prepared of eligible) {
      if (positions.has(prepared.symbol) || pending.some(signal => signal.symbol === prepared.symbol)) continue;
      const index = prepared.indexByTime.get(time);
      if (index == null || index + 1 >= prepared.bars.length || prepared.bars[index + 1].openTime !== time + FOUR_HOURS || time + FOUR_HOURS > endTime) continue;
      const layer = layers.get(prepared.symbol), family = selections[layer]?.family;
      if (!family || family === 'cash') continue;
      const signal = familySignalAt(prepared, index, family);
      if (signal) candidates.push({ ...signal, symbol: prepared.symbol, baseAsset: prepared.baseAsset, market: prepared.market, layer, family, signalTime: time, signalIndex: index, entryTime: time + FOUR_HOURS });
    }
    const day = new Date(time).toISOString().slice(0, 10), usedToday = dailySignals.get(day) || 0;
    const occupiedBases = new Set([...positions.values()].map(position => position.baseAsset));
    const selected = selectCandidates(candidates, { occupiedBases, slots: 6 - positions.size, remainingToday: 2 - usedToday, maxPerBar: 1 });
    const selectedKeys = new Set(selected.map(signal => `${signal.symbol}:${signal.side}`));
    for (const candidate of candidates) candidateAudit.push({ ...candidate, selected: selectedKeys.has(`${candidate.symbol}:${candidate.side}`), reason: selectedKeys.has(`${candidate.symbol}:${candidate.side}`) ? 'selected' : 'rank_or_capacity' });
    if (selected.length) {
      pending = selected;
      finalSignals.push(...selected);
      dailySignals.set(day, usedToday + selected.length);
    }
    equity.push({ time, equity: markEquity(time), cash, positions: positions.size, grossExposure: grossExposure(time) });
  }

  const finalTime = equity.at(-1)?.time;
  if (finalTime != null) {
    for (const position of [...positions.values()]) {
      const prepared = bySymbol.get(position.symbol), index = prepared.indexByTime.get(finalTime), price = index == null ? position.lastPrice : prepared.bars[index].c;
      closePosition(position, price, finalTime + FOUR_HOURS, 'quarter_end');
    }
    equity[equity.length - 1] = { ...equity[equity.length - 1], equity: cash, cash, positions: 0, grossExposure: 0 };
  }
  return { trades, equity, finalSignals, candidateAudit, executedSignals, finalEquity: cash };
}

module.exports = { positionSize, costForLayer, selectCandidates, simulatePortfolioQuarter };

