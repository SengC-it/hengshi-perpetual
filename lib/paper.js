import { STRATEGY } from '../config/strategy.js';
import { FOUR_HOURS } from './binance.js';

export function costForLayer(layer) {
  return String(layer).startsWith('tail_') ? 0.0040 : 0.0024;
}

export function stopFill(position, bar) {
  if (position.side === 1) {
    if (bar.open <= position.stop_price) return bar.open;
    if (bar.low <= position.stop_price) return position.stop_price;
  } else {
    if (bar.open >= position.stop_price) return bar.open;
    if (bar.high >= position.stop_price) return position.stop_price;
  }
  return null;
}

function closeTrade(position, price, time, reason, fundingPnl) {
  const cost = costForLayer(position.layer);
  const grossPnl = position.side * position.qty * (price - position.entry_price);
  const exitFee = position.qty * price * cost / 2;
  const fees = position.entry_fee + exitFee;
  return {
    position_id: position.id,
    signal_id: position.signal_id,
    strategy_version: position.strategy_version,
    symbol: position.symbol,
    base_asset: position.base_asset,
    layer: position.layer,
    family: position.family,
    side: position.side,
    signal_time: position.signal_time,
    entry_time: position.entry_time,
    exit_time: new Date(time).toISOString(),
    entry_price: position.entry_price,
    exit_price: price,
    qty: position.qty,
    notional: position.qty * position.entry_price,
    gross_pnl: grossPnl,
    fees,
    funding_pnl: fundingPnl,
    net_pnl: grossPnl - fees + fundingPnl,
    reason,
    bars_held: Math.max(0, Math.round((time - Date.parse(position.entry_time)) / FOUR_HOURS))
  };
}

export function advancePosition(position, prepared, latestIndex, fundingRates = []) {
  const startAfter = Date.parse(position.last_processed_bar);
  const entryTime = Date.parse(position.entry_time);
  const fundingByTime = new Map(fundingRates.map(row => [row.time, row.rate]));
  let stopPrice = Number(position.stop_price);
  let bestPrice = Number(position.best_price);
  let exitNextOpen = Boolean(position.exit_next_open);
  let fundingPnl = Number(position.funding_pnl);
  let lastProcessedBar = startAfter;

  for (let index = 0; index <= latestIndex; index++) {
    const bar = prepared.bars[index];
    if (bar.openTime <= startAfter || bar.openTime < entryTime) continue;
    if (bar.openTime > entryTime) {
      const fundingRate = fundingByTime.get(bar.openTime);
      if (Number.isFinite(fundingRate)) fundingPnl += -position.side * position.qty * bar.open * fundingRate;
    }
    if (exitNextOpen) {
      return {
        trade: closeTrade(position, bar.open, bar.openTime, 'mean', fundingPnl),
        patch: { last_processed_bar: new Date(bar.openTime).toISOString(), funding_pnl: fundingPnl }
      };
    }
    if (bar.openTime - entryTime >= position.max_hold_bars * FOUR_HOURS) {
      return {
        trade: closeTrade(position, bar.open, bar.openTime, 'time', fundingPnl),
        patch: { last_processed_bar: new Date(bar.openTime).toISOString(), funding_pnl: fundingPnl }
      };
    }
    const fill = stopFill({ ...position, stop_price: stopPrice }, bar);
    if (fill != null) {
      return {
        trade: closeTrade(position, fill, bar.openTime, 'stop', fundingPnl),
        patch: { last_processed_bar: new Date(bar.openTime).toISOString(), funding_pnl: fundingPnl }
      };
    }
    const currentAtr = prepared.atr[index];
    if (position.trail_atr != null && Number.isFinite(currentAtr)) {
      if (position.side === 1) {
        bestPrice = Math.max(bestPrice, bar.high);
        stopPrice = Math.max(stopPrice, bestPrice - position.trail_atr * currentAtr);
      } else {
        bestPrice = Math.min(bestPrice, bar.low);
        stopPrice = Math.min(stopPrice, bestPrice + position.trail_atr * currentAtr);
      }
    }
    if (position.mean_exit_ema20 && Number.isFinite(prepared.ema20[index])) {
      if ((position.side === 1 && bar.close >= prepared.ema20[index])
        || (position.side === -1 && bar.close <= prepared.ema20[index])) {
        exitNextOpen = true;
      }
    }
    lastProcessedBar = bar.openTime;
  }
  return {
    trade: null,
    patch: {
      stop_price: stopPrice,
      best_price: bestPrice,
      exit_next_open: exitNextOpen,
      funding_pnl: fundingPnl,
      last_processed_bar: new Date(lastProcessedBar).toISOString()
    }
  };
}

export function accountSnapshot(trades, openPositions, preparedBySymbol, currentBarTime) {
  const closedPnl = trades.reduce((sum, trade) => sum + Number(trade.net_pnl), 0);
  const openEntryFees = openPositions.reduce((sum, position) => sum + Number(position.entry_fee), 0);
  const openFunding = openPositions.reduce((sum, position) => sum + Number(position.funding_pnl), 0);
  const cash = STRATEGY.portfolio.initialEquity + closedPnl - openEntryFees + openFunding;
  let unrealizedPnl = 0;
  let grossExposure = 0;
  for (const position of openPositions) {
    const prepared = preparedBySymbol.get(position.symbol);
    const index = prepared?.indexByTime.get(currentBarTime);
    const price = index == null ? Number(position.entry_price) : prepared.bars[index].open;
    unrealizedPnl += position.side * position.qty * (price - position.entry_price);
    grossExposure += position.qty * price;
  }
  return {
    cash,
    equity: cash + unrealizedPnl,
    unrealizedPnl,
    grossExposure
  };
}

export function sizePosition(signal, account) {
  const portfolio = STRATEGY.portfolio;
  const distance = Math.abs(signal.entryPrice - signal.stopPrice);
  const remainingGross = account.equity * portfolio.maxGross - account.grossExposure;
  if (!(account.equity > 0) || !(distance > 0) || !(remainingGross > 0)) return 0;
  return Math.max(0, Math.min(
    account.equity * portfolio.riskPerTrade / distance,
    account.equity * portfolio.symbolCap / signal.entryPrice,
    remainingGross / signal.entryPrice
  ));
}
