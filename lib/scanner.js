import { STRATEGY, assertPaperOnly } from '../config/strategy.js';
import {
  claimScan,
  closePosition,
  ensurePosition,
  ensureSignal,
  failScan,
  finishScan,
  getOpenPositions,
  getPaperTrades,
  getSignalsForDay,
  updatePosition
} from './db.js';
import {
  FOUR_HOURS,
  fetchFundingRates,
  fetchMarketSeries,
  fetchPositionMetrics,
  listTradingPerpetuals,
  mapLimit
} from './binance.js';
import {
  isRapidBull,
  latestCompletedIndex,
  prepareSeries,
  rawBreakoutShortAt,
  reversalLongAt,
  scoreBreakoutShort
} from './strategy.js';
import { accountSnapshot, advancePosition, costForLayer, sizePosition } from './paper.js';
import { sendFailureEmail, sendSignalEmail } from './mailer.js';

function scannerConcurrency() {
  const value = Number(process.env.SCAN_CONCURRENCY);
  return Number.isFinite(value) && value > 0 ? Math.min(30, Math.trunc(value)) : 12;
}

function dayBounds(time) {
  const day = new Date(time).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00Z`);
  return [start, start + 86400000];
}

function selectCandidates(candidates, openPositions, existingSignals) {
  const portfolio = STRATEGY.portfolio;
  const occupiedBases = new Set(openPositions.map(position => position.base_asset));
  const occupiedSymbols = new Set(openPositions.map(position => position.symbol));
  const limit = Math.max(0, Math.min(
    portfolio.maxSignalsPerBar,
    portfolio.maxSignalsPerDay - existingSignals.length,
    portfolio.maxPositions - openPositions.length
  ));
  const selected = [];
  for (const candidate of candidates.slice().sort((left, right) => right.score - left.score
    || left.symbol.localeCompare(right.symbol))) {
    if (selected.length >= limit) break;
    if (occupiedSymbols.has(candidate.symbol) || occupiedBases.has(candidate.baseAsset)) continue;
    selected.push(candidate);
    occupiedSymbols.add(candidate.symbol);
    occupiedBases.add(candidate.baseAsset);
  }
  return selected;
}

async function loadPreparedMarkets(symbols, rapidBull, options) {
  const results = await mapLimit(symbols, scannerConcurrency(), async item => {
    try {
      const series = await fetchMarketSeries(item.symbol, {
        ...options,
        includePremium: !rapidBull
      });
      return { item, prepared: prepareSeries(series), error: null };
    } catch (error) {
      return { item, prepared: null, error: error.message };
    }
  });
  return {
    preparedBySymbol: new Map(results.filter(row => row.prepared).map(row => [row.item.symbol, row.prepared])),
    errors: results.filter(row => row.error).map(row => ({ symbol: row.item.symbol, error: row.error }))
  };
}

async function updateOpenPaperPositions(openPositions, preparedBySymbol, barTime, options) {
  const closedTrades = [];
  const unavailable = [];
  for (const position of openPositions) {
    const prepared = preparedBySymbol.get(position.symbol);
    const latestIndex = prepared ? latestCompletedIndex(prepared, options.now) : -1;
    if (!prepared || latestIndex < 0 || prepared.bars[latestIndex].openTime < barTime) {
      unavailable.push(position.symbol);
      continue;
    }
    const lastProcessed = Date.parse(position.last_processed_bar);
    const fundingRates = await fetchFundingRates(position.symbol, lastProcessed + 1, barTime, options)
      .catch(() => []);
    const advanced = advancePosition(position, prepared, latestIndex, fundingRates);
    if (advanced.trade) {
      await closePosition(position.id, advanced.trade, advanced.patch);
      closedTrades.push(advanced.trade);
    } else {
      await updatePosition(position.id, advanced.patch);
    }
  }
  return { closedTrades, unavailable };
}

function buildRawCandidates(preparedBySymbol, symbolInfo, rapidBull, barTime) {
  const candidates = [];
  for (const [symbol, prepared] of preparedBySymbol) {
    const info = symbolInfo.get(symbol);
    const layer = STRATEGY.layerAssignments[symbol];
    const index = prepared.indexByTime.get(barTime);
    if (!info || index == null || index + 1 >= prepared.bars.length) continue;
    const nextBar = prepared.bars[index + 1];
    if (nextBar.openTime !== barTime + FOUR_HOURS) continue;
    const event = rapidBull
      ? reversalLongAt(prepared, index, layer)
      : rawBreakoutShortAt(prepared, index, layer);
    if (!event) continue;
    candidates.push({
      ...event,
      symbol,
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      layer,
      signalTime: barTime,
      entryTime: nextBar.openTime,
      entryPrice: nextBar.open,
      signalAtr: prepared.atr[index]
    });
  }
  return candidates;
}

async function finalizeShortCandidates(rawCandidates, options) {
  const scored = await mapLimit(rawCandidates, Math.min(8, scannerConcurrency()), async candidate => {
    try {
      const metrics = await fetchPositionMetrics(candidate.symbol, options);
      return scoreBreakoutShort(candidate, candidate.layer, metrics);
    } catch {
      return null;
    }
  });
  return scored.filter(Boolean);
}

function signalRecord(candidate, stopPrice) {
  return {
    strategy_version: STRATEGY.version,
    authorization: STRATEGY.authorization,
    live_orders_enabled: false,
    symbol: candidate.symbol,
    base_asset: candidate.baseAsset,
    quote_asset: candidate.quoteAsset,
    layer: candidate.layer,
    family: candidate.family,
    side: candidate.side,
    score: candidate.score,
    signal_time: new Date(candidate.signalTime).toISOString(),
    entry_time: new Date(candidate.entryTime).toISOString(),
    entry_price: candidate.entryPrice,
    stop_price: stopPrice,
    metadata: {
      details: candidate.details,
      metrics: candidate.metrics ?? null,
      causalSelection: true
    }
  };
}

function positionRecord(signal, signalRow, qty, stopPrice) {
  const cost = costForLayer(signal.layer);
  return {
    signal_id: signalRow.id,
    strategy_version: STRATEGY.version,
    symbol: signal.symbol,
    base_asset: signal.baseAsset,
    layer: signal.layer,
    family: signal.family,
    side: signal.side,
    score: signal.score,
    signal_time: new Date(signal.signalTime).toISOString(),
    entry_time: new Date(signal.entryTime).toISOString(),
    entry_price: signal.entryPrice,
    qty,
    stop_price: stopPrice,
    best_price: signal.entryPrice,
    stop_atr: signal.exit.stopAtr,
    trail_atr: signal.exit.trailAtr,
    max_hold_bars: signal.exit.maxHoldBars,
    mean_exit_ema20: signal.exit.meanExitEma20,
    exit_next_open: false,
    entry_fee: qty * signal.entryPrice * cost / 2,
    funding_pnl: 0,
    last_processed_bar: new Date(signal.signalTime).toISOString(),
    status: 'open'
  };
}

export async function runShadowScan(options = {}) {
  assertPaperOnly();
  const now = options.now ?? Date.now();
  const requestOptions = { fetchImpl: options.fetchImpl, now };
  if (now < STRATEGY.validFrom) {
    return {
      status: 'waiting_for_independent_forward_start',
      validFrom: new Date(STRATEGY.validFrom).toISOString(),
      liveOrdersEnabled: false
    };
  }
  if (now > STRATEGY.validThrough + FOUR_HOURS) {
    throw new Error(`frozen strategy expired at ${new Date(STRATEGY.validThrough).toISOString()}`);
  }

  const btc = prepareSeries(await fetchMarketSeries('BTCUSDT', {
    ...requestOptions,
    includePremium: false
  }));
  const btcIndex = latestCompletedIndex(btc, now);
  if (btcIndex < STRATEGY.rapidBull.returnLookbackBars || btcIndex + 1 >= btc.bars.length) {
    throw new Error('BTC 4h history is incomplete');
  }
  const barTime = btc.bars[btcIndex].openTime;
  if (barTime < STRATEGY.validFrom) {
    return {
      status: 'waiting_for_first_independent_bar',
      barTime,
      liveOrdersEnabled: false
    };
  }

  const claim = await claimScan(STRATEGY.version, barTime);
  if (!claim.claimed) {
    return {
      status: 'already_scanned',
      barTime,
      runId: claim.run.id,
      liveOrdersEnabled: false
    };
  }
  const runId = claim.run.id;
  try {
    const rapidBull = isRapidBull(btc, btcIndex);
    const exchangeSymbols = await listTradingPerpetuals(requestOptions);
    const symbolInfo = new Map(exchangeSymbols.map(row => [row.symbol, row]));
    const activeLayers = new Set(STRATEGY.activeLayers);
    const eligible = exchangeSymbols.filter(row => activeLayers.has(STRATEGY.layerAssignments[row.symbol]));
    const loaded = await loadPreparedMarkets(eligible, rapidBull, requestOptions);
    if (loaded.preparedBySymbol.has('BTCUSDT') && rapidBull) {
      loaded.preparedBySymbol.set('BTCUSDT', btc);
    }
    const coverage = eligible.length ? loaded.preparedBySymbol.size / eligible.length : 0;
    if (coverage < 0.80) {
      throw new Error(`market coverage ${coverage.toFixed(3)} is below 0.80`);
    }

    let openPositions = await getOpenPositions(STRATEGY.version);
    const positionUpdate = await updateOpenPaperPositions(
      openPositions,
      loaded.preparedBySymbol,
      barTime,
      requestOptions
    );
    openPositions = await getOpenPositions(STRATEGY.version);

    const rawCandidates = buildRawCandidates(
      loaded.preparedBySymbol,
      symbolInfo,
      rapidBull,
      barTime
    );
    const candidates = rapidBull
      ? rawCandidates
      : await finalizeShortCandidates(rawCandidates, requestOptions);
    const [dayStart, nextDay] = dayBounds(barTime);
    const existingSignals = await getSignalsForDay(STRATEGY.version, dayStart, nextDay);
    const selected = selectCandidates(candidates, openPositions, existingSignals);
    const trades = await getPaperTrades(STRATEGY.version);
    const entryTime = barTime + FOUR_HOURS;
    const account = accountSnapshot(trades, openPositions, loaded.preparedBySymbol, entryTime);
    const newSignals = [];

    for (const candidate of selected) {
      const stopPrice = candidate.entryPrice - candidate.side * candidate.exit.stopAtr * candidate.signalAtr;
      const qty = sizePosition({ ...candidate, stopPrice }, account);
      if (!(qty > 0)) continue;
      const ensuredSignal = await ensureSignal(signalRecord(candidate, stopPrice));
      const ensuredPosition = await ensurePosition(positionRecord(
        candidate,
        ensuredSignal.row,
        qty,
        stopPrice
      ));
      if (ensuredPosition.created) {
        account.cash -= ensuredPosition.row.entry_fee;
        account.equity -= ensuredPosition.row.entry_fee;
        account.grossExposure += qty * candidate.entryPrice;
        newSignals.push({
          ...ensuredSignal.row,
          stop_price: stopPrice
        });
      }
    }

    let emailStatus = 'not_required';
    try {
      const email = await sendSignalEmail({ newSignals, rapidBull, barTime });
      emailStatus = email.sent ? 'sent' : email.reason;
    } catch (error) {
      emailStatus = `failed:${error.message}`.slice(0, 500);
    }
    await finishScan(runId, {
      rapid_bull: rapidBull,
      symbols_requested: eligible.length,
      symbols_scanned: loaded.preparedBySymbol.size,
      raw_candidates: rawCandidates.length,
      qualified_candidates: candidates.length,
      signals_created: newSignals.length,
      positions_closed: positionUpdate.closedTrades.length,
      email_status: emailStatus,
      diagnostics: {
        coverage,
        unavailableMarkets: loaded.errors.slice(0, 50),
        unavailablePositions: positionUpdate.unavailable,
        causalSelection: true
      }
    });
    return {
      status: 'succeeded',
      runId,
      barTime,
      rapidBull,
      symbolsRequested: eligible.length,
      symbolsScanned: loaded.preparedBySymbol.size,
      rawCandidates: rawCandidates.length,
      qualifiedCandidates: candidates.length,
      newSignals,
      positionsClosed: positionUpdate.closedTrades,
      emailStatus,
      liveOrdersEnabled: false
    };
  } catch (error) {
    await failScan(runId, error).catch(() => {});
    await sendFailureEmail(error, { barTime }).catch(() => {});
    throw error;
  }
}
