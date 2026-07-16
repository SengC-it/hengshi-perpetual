const { FOUR_HOURS } = require('./v41_engine');
const { costForLayer } = require('./v41_portfolio');

function selectPair(rows, direction) {
  const byBase = new Map();
  for (const row of rows) if (!byBase.has(row.baseAsset) || row.quoteVolume > byBase.get(row.baseAsset).quoteVolume) byBase.set(row.baseAsset, row);
  const ranked = [...byBase.values()].sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
  if (ranked.length < 2) return null;
  if (direction === 'momentum') return { long: ranked[0], short: ranked.at(-1) };
  if (direction === 'reversal') return { long: ranked.at(-1), short: ranked[0] };
  throw new Error(`unknown direction ${direction}`);
}

function choosePairCandidate(rows) {
  const eligible = rows.filter(row => row.trades >= 60 && row.profitFactor > 1.05 && row.totalReturn > 0 && row.positiveQuarterShare >= 0.5 && row.profitWithoutBest5 > 0);
  if (!eligible.length) return { id: 'cash', direction: 'cash', reason: 'no_training_pair_passed' };
  return eligible.slice().sort((a, b) => b.positiveQuarterShare - a.positiveQuarterShare
    || b.medianQuarterPf - a.medianQuarterPf
    || b.profitFactor - a.profitFactor
    || b.totalReturn - a.totalReturn
    || a.id.localeCompare(b.id))[0];
}

function pairLegNotional({ equity, longEntry, longAtr, shortEntry, shortAtr, riskFraction = 0.0025, notionalCap = 0.25, stopAtr = 3 }) {
  const worstStopFraction = Math.max(stopAtr * longAtr / longEntry, stopAtr * shortAtr / shortEntry);
  if (!(equity > 0) || !(worstStopFraction > 0)) return 0;
  return Math.min(equity * notionalCap, equity * riskFraction / worstStopFraction);
}

function candidateRows(preparedSymbols, layers, layer, time, lookbackBars, occupiedBases = new Set()) {
  const rows = [];
  for (const prepared of preparedSymbols) {
    if (layers.get(prepared.symbol) !== layer || occupiedBases.has(prepared.baseAsset)) continue;
    const index = prepared.indexByTime.get(time);
    if (index == null || index < lookbackBars || index + 1 >= prepared.bars.length || prepared.bars[index + 1].openTime !== time + FOUR_HOURS) continue;
    const bar = prepared.bars[index], past = prepared.bars[index - lookbackBars];
    if (!(bar.qv > 0) || !(past.c > 0)) continue;
    rows.push({ symbol: prepared.symbol, baseAsset: prepared.baseAsset, market: prepared.market, momentum: bar.c / past.c - 1, quoteVolume: bar.qv, prepared, signalIndex: index });
  }
  return rows;
}

function summarizePairRun(run) {
  const wins = run.trades.filter(trade => trade.netPnl > 0), losses = run.trades.filter(trade => trade.netPnl < 0);
  const sum = rows => rows.reduce((a, trade) => a + trade.netPnl, 0);
  let peak = run.equity[0]?.equity || run.initialEquity, maxDrawdown = 0;
  for (const point of run.equity) { peak = Math.max(peak, point.equity); maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1); }
  const bySymbol = {};
  for (const trade of run.trades) bySymbol[trade.symbol] = (bySymbol[trade.symbol] || 0) + trade.netPnl;
  const positive = Object.values(bySymbol).filter(value => value > 0), positiveTotal = positive.reduce((a, b) => a + b, 0);
  return {
    trades: run.trades.length,
    pairs: run.trades.length / 2,
    finalSignals: run.finalSignals.length,
    executedSignals: run.executedSignals,
    winRate: run.trades.length ? wins.length / run.trades.length : 0,
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    totalReturn: run.finalEquity / run.initialEquity - 1,
    maxDrawdown,
    netPnl: sum(run.trades),
    fees: run.trades.reduce((a, trade) => a + trade.fees, 0),
    funding: run.trades.reduce((a, trade) => a + trade.fundingPnl, 0),
    longTrades: run.trades.filter(trade => trade.side === 1).length,
    shortTrades: run.trades.filter(trade => trade.side === -1).length,
    profitableSymbols: positive.length,
    maxSymbolContribution: positiveTotal ? Math.max(...positive) / positiveTotal : 1,
    bySymbol
  };
}

function simulatePairPeriod({ preparedSymbols, layers, candidate, startTime, endTime, scenario, initialEquity = 100000 }) {
  const bySymbol = new Map(preparedSymbols.map(prepared => [prepared.symbol, prepared]));
  const positions = [], trades = [], equity = [], finalSignals = [];
  let pending = null, cash = initialEquity, executedSignals = 0;
  const cost = candidate.id === 'cash' ? 0 : costForLayer(candidate.layer, scenario);
  const markEquity = time => cash + positions.reduce((total, position) => total + position.legs.reduce((legTotal, leg) => {
    const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), price = index == null ? leg.lastPrice : prepared.bars[index].c;
    return legTotal + leg.side * leg.qty * (price - leg.entryPrice);
  }, 0), 0);
  const closePair = (position, time, reason, explicitPrices = null) => {
    for (const leg of position.legs) {
      const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), price = explicitPrices?.get(leg.symbol) ?? (index == null ? leg.lastPrice : (reason === 'period_end' ? prepared.bars[index].c : prepared.bars[index].o));
      const grossPnl = leg.side * leg.qty * (price - leg.entryPrice), exitFee = leg.qty * price * cost / 2;
      cash += grossPnl - exitFee;
      trades.push({ symbol: leg.symbol, baseAsset: leg.baseAsset, market: leg.market, layer: candidate.layer, direction: candidate.direction, lookbackBars: candidate.lookbackBars, side: leg.side, signalTime: position.signalTime, entryTime: position.entryTime, exitTime: time, entryPrice: leg.entryPrice, exitPrice: price, qty: leg.qty, notional: leg.qty * leg.entryPrice, momentum: leg.momentum, grossPnl, fees: leg.entryFee + exitFee, fundingPnl: leg.fundingPnl, netPnl: grossPnl - leg.entryFee - exitFee + leg.fundingPnl, reason });
    }
    positions.splice(positions.indexOf(position), 1);
  };

  for (let time = startTime; time <= endTime; time += FOUR_HOURS) {
    for (const position of positions.slice()) {
      let stopPrices = null;
      for (const leg of position.legs) {
        const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
        if (!bar) continue;
        leg.lastPrice = bar.c;
        const rate = prepared.fundingMap.get(time);
        if (Number.isFinite(rate)) { const payment = -leg.side * leg.qty * bar.o * rate; cash += payment; leg.fundingPnl += payment; }
        let stopPrice = null;
        if (leg.side === 1) { if (bar.o <= leg.stop) stopPrice = bar.o; else if (bar.l <= leg.stop) stopPrice = leg.stop; }
        else { if (bar.o >= leg.stop) stopPrice = bar.o; else if (bar.h >= leg.stop) stopPrice = leg.stop; }
        if (stopPrice != null && !stopPrices) {
          stopPrices = new Map(position.legs.map(other => {
            const otherPrepared = bySymbol.get(other.symbol), otherIndex = otherPrepared.indexByTime.get(time), otherBar = otherIndex == null ? null : otherPrepared.bars[otherIndex];
            return [other.symbol, other.symbol === leg.symbol ? stopPrice : (otherBar?.c ?? other.lastPrice)];
          }));
        }
      }
      if (stopPrices) { closePair(position, time, 'stop', stopPrices); continue; }
      if (time - position.entryTime >= candidate.holdBars * FOUR_HOURS) closePair(position, time, 'time');
    }
    if (pending && pending.entryTime === time) {
      const longBar = pending.long.prepared.bars[pending.long.prepared.indexByTime.get(time)], shortBar = pending.short.prepared.bars[pending.short.prepared.indexByTime.get(time)];
      if (longBar && shortBar) {
        const equityNow = markEquity(time), longAtr = pending.long.prepared.atr[pending.long.signalIndex], shortAtr = pending.short.prepared.atr[pending.short.signalIndex];
        const legNotional = pairLegNotional({ equity: equityNow, longEntry: longBar.o, longAtr, shortEntry: shortBar.o, shortAtr });
        const legs = [[pending.long, 1, longBar], [pending.short, -1, shortBar]].map(([row, side, bar]) => {
          const qty = legNotional / bar.o, entryFee = legNotional * cost / 2;
          cash -= entryFee; executedSignals++;
          const initialAtr = row.prepared.atr[row.signalIndex];
          return { symbol: row.symbol, baseAsset: row.baseAsset, market: row.market, side, momentum: row.momentum, qty, entryPrice: bar.o, stop: bar.o - side * 3 * initialAtr, entryFee, fundingPnl: 0, lastPrice: bar.o };
        });
        positions.push({ signalTime: pending.signalTime, entryTime: time, legs });
        let sameBarStops = null;
        for (const leg of legs) {
          const prepared = bySymbol.get(leg.symbol), bar = prepared.bars[prepared.indexByTime.get(time)];
          let fill = null;
          if (leg.side === 1 && bar.l <= leg.stop) fill = leg.stop;
          if (leg.side === -1 && bar.h >= leg.stop) fill = leg.stop;
          if (fill != null && !sameBarStops) sameBarStops = new Map(legs.map(other => {
            const otherPrepared = bySymbol.get(other.symbol), otherBar = otherPrepared.bars[otherPrepared.indexByTime.get(time)];
            return [other.symbol, other.symbol === leg.symbol ? fill : otherBar.c];
          }));
        }
        if (sameBarStops) closePair(positions.at(-1), time, 'stop', sameBarStops);
      }
      pending = null;
    }
    if (candidate.id !== 'cash' && !pending && positions.length < 2 && new Date(time).getUTCHours() === 0 && Math.floor(time / 86400000) % 2 === 0 && time + FOUR_HOURS <= endTime) {
      const occupiedBases = new Set(positions.flatMap(position => position.legs.map(leg => leg.baseAsset)));
      const pair = selectPair(candidateRows(preparedSymbols, layers, candidate.layer, time, candidate.lookbackBars, occupiedBases), candidate.direction);
      if (pair) {
        pending = { ...pair, signalTime: time, entryTime: time + FOUR_HOURS };
        finalSignals.push(
          { symbol: pair.long.symbol, baseAsset: pair.long.baseAsset, market: pair.long.market, layer: candidate.layer, direction: candidate.direction, lookbackBars: candidate.lookbackBars, side: 1, momentum: pair.long.momentum, signalTime: time, entryTime: time + FOUR_HOURS },
          { symbol: pair.short.symbol, baseAsset: pair.short.baseAsset, market: pair.short.market, layer: candidate.layer, direction: candidate.direction, lookbackBars: candidate.lookbackBars, side: -1, momentum: pair.short.momentum, signalTime: time, entryTime: time + FOUR_HOURS }
        );
      }
    }
    equity.push({ time, equity: markEquity(time), cash, pairs: positions.length, grossExposure: positions.reduce((a, position) => a + position.legs.reduce((b, leg) => b + leg.qty * leg.lastPrice, 0), 0) });
  }
  const lastTime = equity.at(-1)?.time;
  if (lastTime != null) {
    for (const position of positions.slice()) closePair(position, lastTime, 'period_end');
    equity[equity.length - 1] = { ...equity[equity.length - 1], equity: cash, cash, pairs: 0, grossExposure: 0 };
  }
  const run = { initialEquity, finalEquity: cash, trades, equity, finalSignals, executedSignals };
  run.summary = summarizePairRun(run);
  return run;
}

module.exports = { selectPair, choosePairCandidate, pairLegNotional, candidateRows, summarizePairRun, simulatePairPeriod };
