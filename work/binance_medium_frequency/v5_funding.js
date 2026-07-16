const { FOUR_HOURS } = require('./v41_engine');
const { costForLayer } = require('./v41_portfolio');
const { betaNeutralNotionals, pairRows, summarizeResidualRun } = require('./v5_residual');

function rollingFundingAverages(prepared, windows = [21, 42]) {
  const result = Object.fromEntries(windows.map(window => [window, Array(prepared.bars.length).fill(null)]));
  const queues = Object.fromEntries(windows.map(window => [window, []]));
  const sums = Object.fromEntries(windows.map(window => [window, 0]));
  const funding = prepared.funding.slice().sort((a, b) => a.fundingTime - b.fundingTime);
  let pointer = 0;
  for (let index = 0; index < prepared.bars.length; index++) {
    const time = prepared.bars[index].openTime;
    while (pointer < funding.length && funding[pointer].fundingTime <= time) {
      const rate = funding[pointer++].fundingRate;
      if (!Number.isFinite(rate)) continue;
      for (const window of windows) {
        queues[window].push(rate); sums[window] += rate;
        if (queues[window].length > window) sums[window] -= queues[window].shift();
      }
    }
    for (const window of windows) if (queues[window].length >= Math.min(6, window)) result[window][index] = sums[window] / queues[window].length;
  }
  return result;
}

function attachFundingFeatures(preparedSymbols, windows = [21, 42]) {
  for (const prepared of preparedSymbols) prepared.fundingAverage = rollingFundingAverages(prepared, windows);
  return preparedSymbols;
}

function selectFundingPair(rows, candidate) {
  const byBase = new Map();
  for (const row of rows) if (!byBase.has(row.baseAsset) || row.quoteVolume > byBase.get(row.baseAsset).quoteVolume) byBase.set(row.baseAsset, row);
  const ranked = [...byBase.values()].sort((a, b) => a.fundingAverage - b.fundingAverage || a.symbol.localeCompare(b.symbol));
  if (ranked.length < 2) return null;
  const width = Math.min(10, Math.max(2, Math.ceil(ranked.length * 0.2)));
  let best = null;
  for (const long of ranked.slice(0, width)) for (const short of ranked.slice(-width)) {
    if (long.baseAsset === short.baseAsset || !(long.beta > 0) || !(short.beta > 0) || !(long.volatility > 0) || !(short.volatility > 0)) continue;
    const betaRatio = long.beta / short.beta, volRatio = long.volatility / short.volatility;
    if (betaRatio < 0.5 || betaRatio > 2 || volRatio < 0.5 || volRatio > 2) continue;
    const fundingSpread = short.fundingAverage - long.fundingAverage;
    if (!(fundingSpread > 0)) continue;
    const expectedCarry = fundingSpread * Math.ceil(candidate.holdBars / 2);
    let residualGap = short.residualZ - long.residualZ;
    if (candidate.strategy === 'funding_carry') {
      if (expectedCarry < 1.25 * candidate.stressCost) continue;
      residualGap = 0;
    } else if (candidate.strategy === 'funding_crowding_reversal') {
      if (!(long.residualZ < 0 && short.residualZ > 0 && residualGap >= 2) || expectedCarry < 0.5 * candidate.stressCost) continue;
    } else throw new Error(`unknown funding strategy ${candidate.strategy}`);
    const mismatch = Math.abs(Math.log(betaRatio)) + Math.abs(Math.log(volRatio));
    const score = (expectedCarry / candidate.stressCost + Math.max(0, residualGap)) / (1 + mismatch);
    if (!best || score > best.score || (score === best.score && `${long.symbol}:${short.symbol}` < `${best.long.symbol}:${best.short.symbol}`)) best = { long, short, fundingSpread, expectedCarry, residualGap, score };
  }
  return best;
}

function chooseFundingCandidate(rows) {
  const eligible = rows.filter(row => row.pairs >= 30 && row.pairProfitFactor > 1.05 && row.totalReturn > 0 && row.positiveQuarterShare >= 0.5 && row.profitWithoutBest5Pairs > 0);
  if (!eligible.length) return { id: 'cash', reason: 'no_training_candidate_passed' };
  return eligible.slice().sort((a, b) => b.positiveQuarterShare - a.positiveQuarterShare
    || b.medianQuarterPairPf - a.medianQuarterPairPf
    || b.pairProfitFactor - a.pairProfitFactor
    || b.totalReturn - a.totalReturn
    || a.id.localeCompare(b.id))[0];
}

function candidateRows(preparedSymbols, layers, candidate, time, occupiedBases = new Set()) {
  const rows = [];
  for (const prepared of preparedSymbols) {
    if (layers.get(prepared.symbol) !== candidate.layer || occupiedBases.has(prepared.baseAsset) || !prepared.factor || !prepared.fundingAverage) continue;
    const index = prepared.indexByTime.get(time);
    if (index == null || index < 42 || index + 1 >= prepared.bars.length || prepared.bars[index + 1].openTime !== time + FOUR_HOURS) continue;
    const beta = prepared.factor.beta[index], volatility = prepared.factor.volatility[index], residual = prepared.factor.residualReturn(index, 42), fundingAverage = prepared.fundingAverage[candidate.fundingEvents][index];
    if (!(beta >= 0.2 && beta <= 3) || !(volatility > 0) || !Number.isFinite(residual) || !Number.isFinite(fundingAverage)) continue;
    rows.push({ symbol: prepared.symbol, baseAsset: prepared.baseAsset, market: prepared.market, fundingAverage, beta, volatility, residual, residualZ: residual / (volatility * Math.sqrt(42)), quoteVolume: prepared.bars[index].qv, prepared, signalIndex: index });
  }
  return rows;
}

function simulateFundingPeriod({ preparedSymbols, layers, candidate, startTime, endTime, scenario, initialEquity = 100000 }) {
  const bySymbol = new Map(preparedSymbols.map(row => [row.symbol, row]));
  const positions = [], trades = [], equity = [], finalSignals = [];
  let cash = initialEquity, pending = null, executedSignals = 0;
  const cost = candidate.id === 'cash' ? 0 : costForLayer(candidate.layer, scenario);
  const stressCost = candidate.id === 'cash' ? 0 : costForLayer(candidate.layer, 'stress');
  const markEquity = time => cash + positions.reduce((total, position) => total + position.legs.reduce((pairTotal, leg) => {
    const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), price = index == null ? leg.lastPrice : prepared.bars[index].c;
    return pairTotal + leg.side * leg.qty * (price - leg.entryPrice);
  }, 0), 0);
  const closePair = (position, time, reason, useClose = false, explicitPrices = null) => {
    for (const leg of position.legs) {
      const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
      const price = explicitPrices?.get(leg.symbol) ?? (bar ? (useClose ? bar.c : bar.o) : leg.lastPrice);
      const grossPnl = leg.side * leg.qty * (price - leg.entryPrice), exitFee = leg.qty * price * cost / 2;
      cash += grossPnl - exitFee;
      trades.push({ symbol: leg.symbol, baseAsset: leg.baseAsset, market: leg.market, layer: candidate.layer, strategy: candidate.strategy, fundingEvents: candidate.fundingEvents, holdBars: candidate.holdBars, side: leg.side, signalTime: position.signalTime, entryTime: position.entryTime, exitTime: time, entryPrice: leg.entryPrice, exitPrice: price, qty: leg.qty, notional: leg.qty * leg.entryPrice, beta: leg.beta, fundingAverage: leg.fundingAverage, residualZ: leg.residualZ, expectedCarry: position.expectedCarry, grossPnl, fees: leg.entryFee + exitFee, fundingPnl: leg.fundingPnl, netPnl: grossPnl - leg.entryFee - exitFee + leg.fundingPnl, reason });
    }
    positions.splice(positions.indexOf(position), 1);
  };

  for (let time = startTime; time <= endTime; time += FOUR_HOURS) {
    for (const position of positions.slice()) {
      const bars = new Map(); let missing = false;
      for (const leg of position.legs) {
        const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
        if (!bar) { missing = true; continue; }
        bars.set(leg.symbol, bar);
      }
      if (missing) {
        const prices = new Map(position.legs.map(leg => [leg.symbol, leg.lastPrice * (1 - leg.side * 0.01)]));
        closePair(position, time, 'missing_or_delist', false, prices); continue;
      }
      if (position.exitNextOpen) { closePair(position, time, 'pair_stop'); continue; }
      if (time - position.entryTime >= candidate.holdBars * FOUR_HOURS) { closePair(position, time, 'time'); continue; }
      for (const leg of position.legs) {
        const prepared = bySymbol.get(leg.symbol), bar = bars.get(leg.symbol); leg.lastPrice = bar.c;
        const rate = prepared.fundingMap.get(time);
        if (Number.isFinite(rate)) { const payment = -leg.side * leg.qty * bar.o * rate; cash += payment; leg.fundingPnl += payment; }
      }
      const closePnl = position.legs.reduce((sum, leg) => sum + leg.side * leg.qty * (bars.get(leg.symbol).c - leg.entryPrice), 0);
      const funding = position.legs.reduce((sum, leg) => sum + leg.fundingPnl, 0), entryFees = position.legs.reduce((sum, leg) => sum + leg.entryFee, 0);
      if (closePnl + funding - entryFees <= -position.riskBudget) position.exitNextOpen = true;
    }

    if (pending && pending.entryTime === time) {
      const longIndex = pending.long.prepared.indexByTime.get(time), shortIndex = pending.short.prepared.indexByTime.get(time);
      const longBar = longIndex == null ? null : pending.long.prepared.bars[longIndex], shortBar = shortIndex == null ? null : pending.short.prepared.bars[shortIndex];
      if (longBar && shortBar) {
        const openEquity = markEquity(time), notionals = betaNeutralNotionals({ equity: openEquity, longBeta: pending.long.beta, shortBeta: pending.short.beta });
        const legs = [[pending.long, 1, longBar, notionals.longNotional], [pending.short, -1, shortBar, notionals.shortNotional]].map(([row, side, bar, notional]) => {
          const qty = notional / bar.o, entryFee = notional * cost / 2; cash -= entryFee; executedSignals++;
          return { symbol: row.symbol, baseAsset: row.baseAsset, market: row.market, side, beta: row.beta, fundingAverage: row.fundingAverage, residualZ: row.residualZ, qty, entryPrice: bar.o, entryFee, fundingPnl: 0, lastPrice: bar.o };
        });
        const position = { signalTime: pending.signalTime, entryTime: time, expectedCarry: pending.expectedCarry, riskBudget: openEquity * 0.0025, legs, exitNextOpen: false };
        positions.push(position);
        const closePnl = legs.reduce((sum, leg) => sum + leg.side * leg.qty * ((leg.side === 1 ? longBar.c : shortBar.c) - leg.entryPrice), 0);
        if (closePnl - legs.reduce((sum, leg) => sum + leg.entryFee, 0) <= -position.riskBudget) position.exitNextOpen = true;
      }
      pending = null;
    }

    if (candidate.id !== 'cash' && !pending && positions.length < 3 && new Date(time).getUTCHours() === 0 && time + FOUR_HOURS <= endTime) {
      const occupiedBases = new Set(positions.flatMap(position => position.legs.map(leg => leg.baseAsset)));
      const pair = selectFundingPair(candidateRows(preparedSymbols, layers, candidate, time, occupiedBases), { ...candidate, stressCost });
      if (pair) {
        pending = { ...pair, signalTime: time, entryTime: time + FOUR_HOURS };
        finalSignals.push(
          { symbol: pair.long.symbol, baseAsset: pair.long.baseAsset, market: pair.long.market, layer: candidate.layer, strategy: candidate.strategy, fundingEvents: candidate.fundingEvents, holdBars: candidate.holdBars, side: 1, beta: pair.long.beta, fundingAverage: pair.long.fundingAverage, residualZ: pair.long.residualZ, expectedCarry: pair.expectedCarry, signalTime: time, entryTime: time + FOUR_HOURS },
          { symbol: pair.short.symbol, baseAsset: pair.short.baseAsset, market: pair.short.market, layer: candidate.layer, strategy: candidate.strategy, fundingEvents: candidate.fundingEvents, holdBars: candidate.holdBars, side: -1, beta: pair.short.beta, fundingAverage: pair.short.fundingAverage, residualZ: pair.short.residualZ, expectedCarry: pair.expectedCarry, signalTime: time, entryTime: time + FOUR_HOURS }
        );
      }
    }
    equity.push({ time, equity: markEquity(time), cash, pairs: positions.length, grossExposure: positions.reduce((sum, position) => sum + position.legs.reduce((a, leg) => a + leg.qty * leg.lastPrice, 0), 0) });
  }
  const lastTime = equity.at(-1)?.time;
  if (lastTime != null) {
    for (const position of positions.slice()) closePair(position, lastTime, 'period_end', true);
    equity[equity.length - 1] = { ...equity[equity.length - 1], equity: cash, cash, pairs: 0, grossExposure: 0 };
  }
  const run = { initialEquity, finalEquity: cash, trades, equity, finalSignals, executedSignals };
  run.summary = summarizeResidualRun(run);
  return run;
}

module.exports = { rollingFundingAverages, attachFundingFeatures, selectFundingPair, chooseFundingCandidate, candidateRows, pairRows, summarizeFundingRun: summarizeResidualRun, simulateFundingPeriod };
