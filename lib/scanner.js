import { EXIT_SHADOW, STRATEGY, assertPaperOnly } from '../config/strategy.js';
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
  fetchKlines,
  fetchMarkPrices,
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
import { accountSnapshot, advancePositionFiveMinute, costForLayer, sizePosition } from './paper.js';
import { sendFailureEmail, sendSignalEmail } from './mailer.js';

export const MAX_SCAN_DELAY_MS = 10 * 60 * 1000;

function scannerConcurrency() {
  const value = Number(process.env.SCAN_CONCURRENCY);
  return Number.isFinite(value) && value > 0 ? Math.min(30, Math.trunc(value)) : 12;
}

function dayBounds(time) {
  const day = new Date(time).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00Z`);
  return [start, start + 86400000];
}

export function expectedCompletedBarTime(now) {
  return Math.floor(now / FOUR_HOURS) * FOUR_HOURS - FOUR_HOURS;
}

export function scanDelayMs(now, barTime) {
  return now - (barTime + FOUR_HOURS);
}

function scanLog(level, event, details = {}) {
  console[level](JSON.stringify({
    component: 'hengshi-shadow-scan',
    event,
    strategyVersion: STRATEGY.version,
    liveOrdersEnabled: false,
    ...details
  }));
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

async function updateOpenPaperPositions(openPositions, preparedBySymbol, barTime, now, options) {
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
    let fiveMinuteBars;
    try {
      fiveMinuteBars = await fetchKlines(position.symbol, '5m', Math.max(Date.parse(position.entry_time), lastProcessed + 1), now, options);
    } catch {
      unavailable.push(position.symbol);
      continue;
    }
    const fundingRates = await fetchFundingRates(position.symbol, lastProcessed + 1, now, options)
      .catch(() => []);
    const advanced = advancePositionFiveMinute(position, prepared, fiveMinuteBars, now, fundingRates);
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
      signalAtr: prepared.atr[index],
      signalEma20: prepared.ema20[index]
    });
  }
  return candidates;
}

export function withExecutableEntries(candidates, markPrices, entryTime) {
  return candidates.flatMap(candidate => {
    const entryPrice = markPrices.get(candidate.symbol);
    return Number.isFinite(entryPrice) && entryPrice > 0
      ? [{ ...candidate, entryTime, entryPrice }]
      : [];
  });
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

function signalRecord(candidate, stopPrice, strategyVersion = STRATEGY.version, comparison = null) {
  const referenceProfitPrice = candidate.exit.trailAtr == null
    ? null
    : candidate.entryPrice + candidate.side * candidate.exit.trailAtr * candidate.signalAtr;
  return {
    strategy_version: strategyVersion,
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
      causalSelection: true,
      exit: {
        stopAtr: candidate.exit.stopAtr,
        trailAtr: candidate.exit.trailAtr,
        maxHoldBars: candidate.exit.maxHoldBars,
        meanExitEma20: candidate.exit.meanExitEma20,
        signalAtr: candidate.signalAtr,
        referenceProfitPrice: Number.isFinite(referenceProfitPrice) && referenceProfitPrice > 0
          ? referenceProfitPrice
          : null,
        referenceEma20: Number.isFinite(candidate.signalEma20) ? candidate.signalEma20 : null
      },
      comparison
    }
  };
}

function positionRecord(signal, signalRow, qty, stopPrice, strategyVersion = STRATEGY.version) {
  const cost = costForLayer(signal.layer);
  return {
    signal_id: signalRow.id,
    strategy_version: strategyVersion,
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
    last_processed_bar: new Date(signal.entryTime - STRATEGY.implementation.entryDelayMs).toISOString(),
    status: 'open'
  };
}

export async function runShadowScan(options = {}) {
  assertPaperOnly();
  const now = options.now ?? Date.now();
  const requestOptions = { fetchImpl: options.fetchImpl, now };
  const dependencies = {
    claimScan: options.dependencies?.claimScan ?? claimScan,
    failScan: options.dependencies?.failScan ?? failScan,
    sendFailureEmail: options.dependencies?.sendFailureEmail ?? sendFailureEmail
  };
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

  const barTime = expectedCompletedBarTime(now);
  if (barTime < STRATEGY.validFrom) {
    return {
      status: 'waiting_for_first_independent_bar',
      barTime,
      liveOrdersEnabled: false
    };
  }

  let runId = null;
  scanLog('info', 'scan_started', {
    now: new Date(now).toISOString(),
    barTime: new Date(barTime).toISOString(),
    delayMs: scanDelayMs(now, barTime)
  });
  try {
    const claim = await dependencies.claimScan(STRATEGY.version, barTime);
    if (!claim.claimed) {
      scanLog('info', 'scan_skipped', { runId: claim.run.id, reason: 'already_scanned' });
      return {
        status: 'already_scanned',
        barTime,
        runId: claim.run.id,
        liveOrdersEnabled: false
      };
    }
    runId = claim.run.id;
    scanLog('info', 'scan_claimed', { runId, barTime: new Date(barTime).toISOString() });

    const delayMs = scanDelayMs(now, barTime);
    if (delayMs > MAX_SCAN_DELAY_MS) {
      throw new Error(
        `stale scan rejected: started ${(delayMs / 1000).toFixed(3)} seconds after the 4h bar closed; maximum is 600 seconds`
      );
    }

    const btc = prepareSeries(await fetchMarketSeries('BTCUSDT', {
      ...requestOptions,
      includePremium: false
    }));
    const btcIndex = latestCompletedIndex(btc, now);
    if (btcIndex < STRATEGY.rapidBull.returnLookbackBars || btcIndex + 1 >= btc.bars.length) {
      throw new Error('BTC 4h history is incomplete');
    }
    if (btc.bars[btcIndex].openTime !== barTime) {
      throw new Error(`BTC latest completed bar ${btc.bars[btcIndex].openTime} does not match expected ${barTime}`);
    }

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
    let exitShadowOpenPositions = [];
    let exitShadowPositionUpdate = { closedTrades: [], unavailable: [] };
    const positionUpdate = await updateOpenPaperPositions(openPositions, loaded.preparedBySymbol, barTime, now, requestOptions);
    if (EXIT_SHADOW.enabled) {
      exitShadowOpenPositions = await getOpenPositions(EXIT_SHADOW.version);
      exitShadowPositionUpdate = await updateOpenPaperPositions(exitShadowOpenPositions, loaded.preparedBySymbol, barTime, now, requestOptions);
    }
    openPositions = await getOpenPositions(STRATEGY.version);
    if (EXIT_SHADOW.enabled) exitShadowOpenPositions = await getOpenPositions(EXIT_SHADOW.version);

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
    const markedSymbols = [...new Set([...selected, ...openPositions].map(row => row.symbol))];
    const markPrices = markedSymbols.length ? await fetchMarkPrices(markedSymbols, requestOptions) : new Map();
    const entryTime = options.executionTime ?? Date.now();
    if (scanDelayMs(entryTime, barTime) > MAX_SCAN_DELAY_MS) {
      throw new Error('execution price became stale before the mark-price fill was captured');
    }
    const executableSelected = withExecutableEntries(selected, markPrices, entryTime);
    const account = accountSnapshot(trades, openPositions, loaded.preparedBySymbol, barTime + FOUR_HOURS, markPrices);
    const newSignals = [];

    for (const candidate of executableSelected) {
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
      if (EXIT_SHADOW.enabled) {
        const exitShadowCandidate = {
          ...candidate,
          exit: candidate.side === -1 ? EXIT_SHADOW.short : EXIT_SHADOW.long
        };
        const exitShadowStopPrice = exitShadowCandidate.entryPrice
          - exitShadowCandidate.side * exitShadowCandidate.exit.stopAtr * exitShadowCandidate.signalAtr;
        const exitShadowSignal = await ensureSignal(signalRecord(
          exitShadowCandidate,
          exitShadowStopPrice,
          EXIT_SHADOW.version,
          {
            role: 'exit-shadow',
            baselineStrategyVersion: STRATEGY.version,
            baselineSignalId: ensuredSignal.row.id
          }
        ));
        await ensurePosition(positionRecord(
          exitShadowCandidate,
          exitShadowSignal.row,
          Number(ensuredPosition.row.qty),
          exitShadowStopPrice,
          EXIT_SHADOW.version
        ));
      }
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
        causalSelection: true,
        execution: {
          entryTime: new Date(entryTime).toISOString(),
          selectedCandidates: selected.length,
          executableCandidates: executableSelected.length,
          missingMarkPrices: selected.length - executableSelected.length
        },
        exitShadow: {
          enabled: EXIT_SHADOW.enabled,
          version: EXIT_SHADOW.version,
          openPositions: exitShadowOpenPositions.length,
          positionsClosed: exitShadowPositionUpdate.closedTrades.length,
          unavailablePositions: exitShadowPositionUpdate.unavailable
        }
      }
    });
    scanLog('info', 'scan_succeeded', {
      runId,
      barTime: new Date(barTime).toISOString(),
      rapidBull,
      symbolsRequested: eligible.length,
      symbolsScanned: loaded.preparedBySymbol.size,
      signalsCreated: newSignals.length,
      positionsClosed: positionUpdate.closedTrades.length,
      emailStatus
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
      executableCandidates: executableSelected.length,
      newSignals,
      positionsClosed: positionUpdate.closedTrades,
      exitShadowPositionsClosed: exitShadowPositionUpdate.closedTrades,
      emailStatus,
      liveOrdersEnabled: false
    };
  } catch (error) {
    let databaseStatus = runId ? 'failed_to_record' : 'not_claimed';
    if (runId) {
      databaseStatus = await dependencies.failScan(runId, error)
        .then(() => 'recorded')
        .catch(recordError => `failed:${recordError.message}`.slice(0, 500));
    }
    const emailStatus = await dependencies.sendFailureEmail(error, { barTime })
      .then(result => result.sent ? 'sent' : result.reason)
      .catch(emailError => `failed:${emailError.message}`.slice(0, 500));
    scanLog('error', 'scan_failed', {
      runId,
      barTime: new Date(barTime).toISOString(),
      error: String(error?.message || error).slice(0, 1000),
      databaseStatus,
      emailStatus
    });
    throw error;
  }
}
