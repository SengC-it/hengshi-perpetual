const { FOUR_HOURS } = require('./v41_engine');
const { costForLayer, positionSize, selectCandidates } = require('./v41_portfolio');
const { stopFill } = require('./v5c_strategy');

const CONFIGS = [
  { configId: 'strict', volumeMultiple: 1.5, takerEdge: 0.10, premiumZ: 0.5 },
  { configId: 'moderate', volumeMultiple: 1.25, takerEdge: 0.075, premiumZ: 0.25 },
  { configId: 'broad', volumeMultiple: 1.10, takerEdge: 0.05, premiumZ: 0 }
];
const EXIT = { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 };

function eventExit(event) {
  return event.exit || EXIT;
}

function breakoutEventAt(prepared, index, config) {
  if (index < 20 || index + 1 >= prepared.bars.length) return null;
  const bar = prepared.bars[index], premium = prepared.premium?.close[index], premiumZ = prepared.premium?.z[index];
  const takerShare = bar.qv > 0 ? bar.takerBuyQv / bar.qv : null, volumeMedian = prepared.volumeMedian20[index], atr = prepared.atr[index];
  if (![premium,premiumZ,takerShare,volumeMedian,atr].every(Number.isFinite) || !(volumeMedian > 0) || !(atr > 0)) return null;
  let priorHigh = -Infinity, priorLow = Infinity;
  for (let cursor = index - 20; cursor < index; cursor++) { priorHigh = Math.max(priorHigh, prepared.bars[cursor].h); priorLow = Math.min(priorLow, prepared.bars[cursor].l); }
  const volumeRatio = bar.qv / volumeMedian, long = bar.c > priorHigh && takerShare >= 0.5 + config.takerEdge && premium > 0 && premiumZ >= config.premiumZ;
  const short = bar.c < priorLow && takerShare <= 0.5 - config.takerEdge && premium < 0 && premiumZ <= -config.premiumZ;
  if (volumeRatio < config.volumeMultiple || (!long && !short)) return null;
  const side = long ? 1 : -1, breakoutAtr = side === 1 ? (bar.c - priorHigh) / atr : (priorLow - bar.c) / atr;
  return {
    configId: config.configId, type: 'premium_breakout', side, signalTime: bar.openTime, entryTime: prepared.bars[index + 1].openTime,
    premium, premiumZ, takerShare, volumeRatio, breakoutAtr,
    score: breakoutAtr + Math.abs(premiumZ) + 5 * Math.abs(takerShare - 0.5) + Math.log(volumeRatio)
  };
}

function scanBreakoutEvents(preparedSymbols, configs = CONFIGS, startTime = -Infinity, endTime = Infinity) {
  const best = new Map();
  for (const prepared of preparedSymbols) for (let index = 20; index < prepared.bars.length - 1; index++) {
    const time = prepared.bars[index].openTime;
    if (time < startTime || time > endTime) continue;
    for (const config of configs) {
      const event = breakoutEventAt(prepared, index, config);
      if (!event) continue;
      const day = new Date(time).toISOString().slice(0, 10), key = `${config.configId}:${prepared.market}:${prepared.symbol}:${day}`;
      const row = { ...event, market: prepared.market, symbol: prepared.symbol, baseAsset: prepared.baseAsset, day };
      if (!best.has(key) || row.score > best.get(key).score) best.set(key, row);
    }
  }
  return [...best.values()].sort((a, b) => a.signalTime - b.signalTime || a.configId.localeCompare(b.configId) || a.symbol.localeCompare(b.symbol));
}

function chooseBreakoutCandidate(rows) {
  const eligible = rows.filter(row => row.trades >= 30 && row.profitFactor > 1.05 && row.totalReturn > 0 && row.positiveQuarterShare >= 0.5 && row.profitWithoutBest5 > 0);
  if (!eligible.length) return { id: 'cash', configId: 'cash', reason: 'no_training_candidate_passed' };
  return eligible.slice().sort((a, b) => b.positiveQuarterShare - a.positiveQuarterShare
    || b.medianQuarterPf - a.medianQuarterPf || b.profitFactor - a.profitFactor || b.totalReturn - a.totalReturn || a.id.localeCompare(b.id))[0];
}

function summarizeBreakoutRun(run) {
  const wins = run.trades.filter(row => row.netPnl > 0), losses = run.trades.filter(row => row.netPnl < 0), sum = rows => rows.reduce((total, row) => total + row.netPnl, 0);
  let peak = run.equity[0]?.equity || run.initialEquity, maxDrawdown = 0;
  for (const point of run.equity) { peak = Math.max(peak, point.equity); maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1); }
  const bySymbol = {}, byLayer = {};
  for (const trade of run.trades) { const key = `${trade.market}:${trade.symbol}`; bySymbol[key] = (bySymbol[key] || 0) + trade.netPnl; byLayer[trade.layer] = (byLayer[trade.layer] || 0) + trade.netPnl; }
  const positive = Object.values(bySymbol).filter(value => value > 0), positiveTotal = positive.reduce((a, b) => a + b, 0);
  return {
    trades: run.trades.length, finalSignals: run.finalSignals.length, executedSignals: run.executedSignals,
    winRate: run.trades.length ? wins.length / run.trades.length : 0, profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    totalReturn: run.finalEquity / run.initialEquity - 1, maxDrawdown, netPnl: sum(run.trades),
    fees: run.trades.reduce((a, row) => a + row.fees, 0), funding: run.trades.reduce((a, row) => a + row.fundingPnl, 0),
    longTrades: run.trades.filter(row => row.side === 1).length, shortTrades: run.trades.filter(row => row.side === -1).length,
    profitableSymbols: positive.length, maxSymbolContribution: positiveTotal ? Math.max(...positive) / positiveTotal : 1,
    profitableLayers: Object.values(byLayer).filter(value => value > 0).length, byLayer, bySymbol
  };
}

function simulateBreakoutPeriod({ preparedSymbols, events, layers, selections, startTime, endTime, scenario, initialEquity = 100000, maxPerBar = 1, maxPerDay = 2, maxPositions = 6 }) {
  const keyOf = row => `${row.market}:${row.symbol}`, bySymbol = new Map(preparedSymbols.map(row => [keyOf(row), row]));
  const eligibleEvents = events.filter(event => event.signalTime >= startTime && event.signalTime <= endTime && selections[layers.get(event.symbol)]?.configId === event.configId);
  const eventsByTime = new Map();
  for (const event of eligibleEvents) { if (!eventsByTime.has(event.signalTime)) eventsByTime.set(event.signalTime, []); eventsByTime.get(event.signalTime).push(event); }
  const positions = new Map(), trades = [], equity = [], finalSignals = [], dailySignals = new Map();
  let pending = [], cash = initialEquity, executedSignals = 0;
  const priceAt = (prepared, time, open = false) => { const index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index]; return bar ? (open ? bar.o : bar.c) : null; };
  const markEquity = (time, open = false) => cash + [...positions.values()].reduce((total, position) => total + position.side * position.qty * ((priceAt(bySymbol.get(position.key), time, open) ?? position.lastPrice) - position.entryPrice), 0);
  const grossExposure = time => [...positions.values()].reduce((total, position) => total + position.qty * (priceAt(bySymbol.get(position.key), time, true) ?? position.lastPrice), 0);
  const close = (position, price, time, reason) => {
    const cost = costForLayer(position.layer, scenario), grossPnl = position.side * position.qty * (price - position.entryPrice), exitFee = position.qty * price * cost / 2;
    cash += grossPnl - exitFee;
    trades.push({ ...position.event, layer: position.layer, exitTime: time, entryPrice: position.entryPrice, exitPrice: price, qty: position.qty, notional: position.qty * position.entryPrice, grossPnl, fees: position.entryFee + exitFee, fundingPnl: position.fundingPnl, netPnl: grossPnl - position.entryFee - exitFee + position.fundingPnl, reason, barsHeld: Math.max(0, Math.round((time - position.event.entryTime) / FOUR_HOURS)) });
    positions.delete(position.key);
  };
  for (let time = startTime; time <= endTime; time += FOUR_HOURS) {
    for (const position of [...positions.values()]) {
      const prepared = bySymbol.get(position.key), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
      if (!bar) { if (time > prepared.bars.at(-1).openTime) close(position, position.lastPrice * (1 - position.side * 0.01), time, 'delist'); continue; }
      position.lastPrice = bar.c;
      const rate = prepared.fundingMap.get(time); if (Number.isFinite(rate)) { const payment = -position.side * position.qty * bar.o * rate; cash += payment; position.fundingPnl += payment; }
      if (position.exitNextOpen) { close(position, bar.o, time, 'mean'); continue; }
      const exit = eventExit(position.event);
      if (time - position.event.entryTime >= exit.maxHoldBars * FOUR_HOURS) { close(position, bar.o, time, 'time'); continue; }
      const fill = stopFill(position, bar); if (fill != null) { close(position, fill, time, 'stop'); continue; }
      const atr = prepared.atr[index];
      if (exit.trailAtr != null && position.side === 1) { position.best = Math.max(position.best, bar.h); position.stop = Math.max(position.stop, position.best - exit.trailAtr * atr); }
      else if (exit.trailAtr != null) { position.best = Math.min(position.best, bar.l); position.stop = Math.min(position.stop, position.best + exit.trailAtr * atr); }
      if (exit.meanExitEma20
        && ((position.side === 1 && bar.c >= prepared.ema20[index]) || (position.side === -1 && bar.c <= prepared.ema20[index]))) {
        position.exitNextOpen = true;
      }
    }
    for (const event of pending) {
      const key = keyOf(event), prepared = bySymbol.get(key), index = prepared?.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
      if (!bar || positions.has(key) || [...positions.values()].some(position => position.event.baseAsset === event.baseAsset)) continue;
      const layer = layers.get(event.symbol), initialAtr = prepared.atr[index - 1], stop = bar.o - event.side * eventExit(event).stopAtr * initialAtr, openEquity = markEquity(time, true);
      const qty = positionSize({ equity: openEquity, entry: bar.o, stop, remainingGross: openEquity * 1.5 - grossExposure(time) });
      if (!(qty > 0)) continue;
      const entryFee = qty * bar.o * costForLayer(layer, scenario) / 2; cash -= entryFee; executedSignals++;
      const position = { key, event, layer, side: event.side, qty, entryPrice: bar.o, stop, best: bar.o, lastPrice: bar.o, entryFee, fundingPnl: 0 };
      positions.set(key, position); const fill = stopFill(position, bar); if (fill != null) close(position, fill, time, 'stop');
    }
    pending = [];
    const candidates = (eventsByTime.get(time) || []).filter(event => {
      const key = keyOf(event); return !positions.has(key) && time + FOUR_HOURS <= endTime;
    }).map(event => ({ ...event, layer: layers.get(event.symbol) }));
    const day = new Date(time).toISOString().slice(0, 10), used = dailySignals.get(day) || 0, occupied = new Set([...positions.values()].map(position => position.event.baseAsset));
    const selected = selectCandidates(candidates, { occupiedBases: occupied, slots: maxPositions - positions.size, remainingToday: maxPerDay - used, maxPerBar });
    if (selected.length) { pending = selected; finalSignals.push(...selected); dailySignals.set(day, used + selected.length); }
    equity.push({ time, equity: markEquity(time), cash, positions: positions.size, grossExposure: grossExposure(time) });
  }
  const finalTime = equity.at(-1)?.time;
  if (finalTime != null) for (const position of [...positions.values()]) close(position, priceAt(bySymbol.get(position.key), finalTime) ?? position.lastPrice, finalTime + FOUR_HOURS, 'period_end');
  if (equity.length) equity[equity.length - 1] = { ...equity.at(-1), equity: cash, cash, positions: 0, grossExposure: 0 };
  const run = { initialEquity, finalEquity: cash, trades, equity, finalSignals, executedSignals }; run.summary = summarizeBreakoutRun(run); return run;
}

module.exports = { CONFIGS, EXIT, eventExit, breakoutEventAt, scanBreakoutEvents, chooseBreakoutCandidate, summarizeBreakoutRun, simulateBreakoutPeriod };
