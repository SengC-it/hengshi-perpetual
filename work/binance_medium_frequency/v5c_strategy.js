const { FOUR_HOURS } = require('./v41_engine');
const { costForLayer } = require('./v41_portfolio');

const CONFIG = {
  oi_breakout: { stopAtr: 2, trailAtr: 3, maxHoldBars: 18 },
  crowding_unwind: { stopAtr: 1.5, trailAtr: null, maxHoldBars: 12 }
};

function stopFill(position, bar) {
  if (position.side === 1 && bar.l <= position.stop) return Math.min(position.stop, bar.o);
  if (position.side === -1 && bar.h >= position.stop) return Math.max(position.stop, bar.o);
  return null;
}

function simulateEvent(prepared, event, layer, scenario, equity = 100000) {
  const config = CONFIG[event.type], entryIndex = prepared.indexByTime.get(event.entryTime);
  if (!config || entryIndex == null || !(prepared.atr[entryIndex - 1] > 0)) return null;
  const entryBar = prepared.bars[entryIndex], entryPrice = entryBar.o, initialAtr = prepared.atr[entryIndex - 1];
  const stop = entryPrice - event.side * config.stopAtr * initialAtr;
  const qty = Math.min(equity * 0.0025 / Math.abs(entryPrice - stop), equity * 0.35 / entryPrice);
  if (!(qty > 0)) return null;
  const cost = costForLayer(layer, scenario), entryFee = qty * entryPrice * cost / 2;
  const position = { side: event.side, stop, best: entryPrice };
  let fundingPnl = 0, exitPrice = entryPrice, exitTime = event.entryTime, reason = 'time', barsHeld = 0;
  for (let index = entryIndex; index < prepared.bars.length; index++) {
    const bar = prepared.bars[index];
    if (bar.openTime > event.entryTime + config.maxHoldBars * FOUR_HOURS) break;
    barsHeld = index - entryIndex;
    const rate = prepared.fundingMap.get(bar.openTime);
    if (Number.isFinite(rate)) fundingPnl += -event.side * qty * bar.o * rate;
    const fill = stopFill(position, bar);
    if (fill != null) { exitPrice = fill; exitTime = bar.openTime; reason = 'stop'; break; }
    exitPrice = bar.c; exitTime = bar.openTime + FOUR_HOURS; reason = 'time';
    if (event.type === 'crowding_unwind') {
      const premiumZ = prepared.premium?.z[index];
      if (Number.isFinite(premiumZ) && ((event.side === 1 && premiumZ >= 0) || (event.side === -1 && premiumZ <= 0))) {
        exitPrice = bar.c; exitTime = bar.openTime + FOUR_HOURS; reason = 'premium_mean'; break;
      }
    } else {
      if (event.side === 1) { position.best = Math.max(position.best, bar.h); position.stop = Math.max(position.stop, position.best - config.trailAtr * prepared.atr[index]); }
      else { position.best = Math.min(position.best, bar.l); position.stop = Math.min(position.stop, position.best + config.trailAtr * prepared.atr[index]); }
    }
    if (barsHeld >= config.maxHoldBars - 1) break;
  }
  const grossPnl = event.side * qty * (exitPrice - entryPrice), exitFee = qty * exitPrice * cost / 2;
  return {
    ...event, metrics: undefined, layer, scenario, entryPrice, exitPrice, qty, notional: qty * entryPrice, exitTime, barsHeld,
    grossPnl, fees: entryFee + exitFee, fundingPnl, netPnl: grossPnl - entryFee - exitFee + fundingPnl, reason
  };
}

function summarizeTrades(trades) {
  const wins = trades.filter(row => row.netPnl > 0), losses = trades.filter(row => row.netPnl < 0);
  const sum = rows => rows.reduce((total, row) => total + row.netPnl, 0);
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    netPnl: sum(trades), fees: trades.reduce((total, row) => total + row.fees, 0), fundingPnl: trades.reduce((total, row) => total + row.fundingPnl, 0)
  };
}

module.exports = { CONFIG, stopFill, simulateEvent, summarizeTrades };
