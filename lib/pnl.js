import { costForLayer } from './paper.js';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pnlPercent(netPnl, notional) {
  return notional > 0 ? netPnl / notional : null;
}

function closedTradeRow(trade) {
  const notional = number(trade.notional) || number(trade.qty) * number(trade.entry_price);
  const netPnl = number(trade.net_pnl);
  return {
    state: 'closed',
    positionId: trade.position_id,
    signalId: trade.signal_id,
    symbol: trade.symbol,
    side: number(trade.side),
    layer: trade.layer,
    signalTime: trade.signal_time,
    entryTime: trade.entry_time,
    closeTime: trade.exit_time,
    entryPrice: number(trade.entry_price),
    closePrice: number(trade.exit_price),
    netPnl,
    pnlPercent: pnlPercent(netPnl, notional),
    grossPnl: number(trade.gross_pnl),
    fees: number(trade.fees),
    fundingPnl: number(trade.funding_pnl),
    reason: trade.reason,
    barsHeld: number(trade.bars_held)
  };
}

function openPositionRow(position, markPrice, markedAt) {
  const entryPrice = number(position.entry_price);
  const qty = number(position.qty);
  const notional = qty * entryPrice;
  const markAvailable = Number.isFinite(markPrice) && markPrice > 0;
  const grossPnl = markAvailable ? number(position.side) * qty * (markPrice - entryPrice) : null;
  const exitFee = markAvailable ? qty * markPrice * costForLayer(position.layer) / 2 : null;
  const fees = markAvailable ? number(position.entry_fee) + exitFee : null;
  const fundingPnl = number(position.funding_pnl);
  const netPnl = markAvailable ? grossPnl - fees + fundingPnl : null;
  return {
    state: 'open',
    positionId: position.id,
    signalId: position.signal_id,
    symbol: position.symbol,
    side: number(position.side),
    layer: position.layer,
    signalTime: position.signal_time,
    entryTime: position.entry_time,
    closeTime: markedAt,
    entryPrice,
    closePrice: markAvailable ? markPrice : null,
    netPnl,
    pnlPercent: netPnl == null ? null : pnlPercent(netPnl, notional),
    grossPnl,
    fees,
    fundingPnl,
    reason: 'open',
    barsHeld: null,
    markAvailable
  };
}

export function buildSignalPnlRows(trades, positions, markPrices, markedAt = new Date().toISOString()) {
  return [
    ...trades.map(closedTradeRow),
    ...positions.map(position => openPositionRow(position, markPrices.get(position.symbol), markedAt))
  ].sort((left, right) => Date.parse(right.entryTime) - Date.parse(left.entryTime));
}
