const { FOUR_HOURS } = require('./v41_engine');
const { costForLayer } = require('./v41_portfolio');

function rollingFactorFeatures(prepared, btc, windowBars = 270) {
  const beta = Array(prepared.bars.length).fill(null);
  const volatility = Array(prepared.bars.length).fill(null);
  const samples = [];
  let count = 0;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, sumYY = 0;
  for (let index = 1; index < prepared.bars.length; index++) {
    const time = prepared.bars[index].openTime;
    const btcIndex = btc.indexByTime.get(time);
    const priorBtcIndex = btc.indexByTime.get(prepared.bars[index - 1].openTime);
    let sample = null;
    if (btcIndex != null && priorBtcIndex != null && btcIndex === priorBtcIndex + 1) {
      const x = Math.log(btc.bars[btcIndex].c / btc.bars[priorBtcIndex].c);
      const y = Math.log(prepared.bars[index].c / prepared.bars[index - 1].c);
      if (Number.isFinite(x) && Number.isFinite(y)) sample = { x, y };
    }
    samples.push(sample);
    if (sample) {
      count++;
      sumX += sample.x; sumY += sample.y; sumXX += sample.x ** 2; sumXY += sample.x * sample.y; sumYY += sample.y ** 2;
    }
    if (samples.length > windowBars) {
      const removed = samples.shift();
      if (removed) {
        count--;
        sumX -= removed.x; sumY -= removed.y; sumXX -= removed.x ** 2; sumXY -= removed.x * removed.y; sumYY -= removed.y ** 2;
      }
    }
    if (count >= Math.min(30, windowBars)) {
      const covariance = sumXY - sumX * sumY / count;
      const varianceX = sumXX - sumX ** 2 / count;
      const varianceY = Math.max(0, (sumYY - sumY ** 2 / count) / count);
      beta[index] = varianceX > 1e-16 ? covariance / varianceX : 1;
      volatility[index] = Math.sqrt(varianceY);
    }
  }
  const residualReturn = (index, lookbackBars) => {
    if (index < lookbackBars || !Number.isFinite(beta[index])) return null;
    const now = prepared.bars[index], past = prepared.bars[index - lookbackBars];
    const btcNowIndex = btc.indexByTime.get(now.openTime), btcPastIndex = btc.indexByTime.get(past.openTime);
    if (btcNowIndex == null || btcPastIndex == null) return null;
    const assetMove = Math.log(now.c / past.c), btcMove = Math.log(btc.bars[btcNowIndex].c / btc.bars[btcPastIndex].c);
    return assetMove - beta[index] * btcMove;
  };
  return { beta, volatility, residualReturn };
}

function attachFactorFeatures(preparedSymbols, betaWindowBars = 270) {
  const btc = preparedSymbols.find(row => row.symbol === 'BTCUSDT');
  if (!btc) throw new Error('BTCUSDT history is required for residual features');
  for (const prepared of preparedSymbols) prepared.factor = rollingFactorFeatures(prepared, btc, betaWindowBars);
  return preparedSymbols;
}

function selectResidualPair(rows) {
  const byBase = new Map();
  for (const row of rows) if (!byBase.has(row.baseAsset) || row.quoteVolume > byBase.get(row.baseAsset).quoteVolume) byBase.set(row.baseAsset, row);
  const ranked = [...byBase.values()].sort((a, b) => a.residual - b.residual || a.symbol.localeCompare(b.symbol));
  if (ranked.length < 2) return null;
  const width = Math.min(10, Math.max(2, Math.ceil(ranked.length * 0.2)));
  const longs = ranked.slice(0, width), shorts = ranked.slice(-width);
  let best = null;
  for (const long of longs) for (const short of shorts) {
    if (long.baseAsset === short.baseAsset || !(long.beta > 0) || !(short.beta > 0) || !(long.volatility > 0) || !(short.volatility > 0)) continue;
    const betaRatio = long.beta / short.beta, volRatio = long.volatility / short.volatility;
    if (betaRatio < 0.5 || betaRatio > 2 || volRatio < 0.5 || volRatio > 2) continue;
    const gap = short.residual - long.residual;
    if (!(gap > 0)) continue;
    const mismatch = Math.abs(Math.log(betaRatio)) + Math.abs(Math.log(volRatio));
    const score = gap / (1 + mismatch);
    if (!best || score > best.score || (score === best.score && `${long.symbol}:${short.symbol}` < `${best.long.symbol}:${best.short.symbol}`)) best = { long, short, gap, score };
  }
  return best;
}

function betaNeutralNotionals({ equity, longBeta, shortBeta, grossFraction = 0.2 }) {
  if (!(equity > 0) || !(longBeta > 0) || !(shortBeta > 0) || !(grossFraction > 0)) return { longNotional: 0, shortNotional: 0 };
  const gross = equity * grossFraction, totalBeta = longBeta + shortBeta;
  return { longNotional: gross * shortBeta / totalBeta, shortNotional: gross * longBeta / totalBeta };
}

function adversePairPnl(position, barsByKey, keyForLeg = leg => leg.symbol) {
  return position.legs.reduce((sum, leg) => {
    const bar = barsByKey.get(keyForLeg(leg));
    if (!bar) return sum;
    const price = leg.side === 1 ? bar.l : bar.h;
    return sum + leg.side * leg.qty * (price - leg.entryPrice);
  }, 0);
}

function chooseResidualCandidate(rows) {
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
    if (layers.get(prepared.symbol) !== candidate.layer || occupiedBases.has(prepared.baseAsset) || !prepared.factor) continue;
    const index = prepared.indexByTime.get(time);
    if (index == null || index < candidate.lookbackBars || index + 1 >= prepared.bars.length || prepared.bars[index + 1].openTime !== time + FOUR_HOURS) continue;
    const beta = prepared.factor.beta[index], volatility = prepared.factor.volatility[index], residual = prepared.factor.residualReturn(index, candidate.lookbackBars);
    if (!(beta >= 0.2 && beta <= 3) || !(volatility > 0) || !Number.isFinite(residual)) continue;
    const residualZ = residual / (volatility * Math.sqrt(candidate.lookbackBars));
    rows.push({ symbol: prepared.symbol, baseAsset: prepared.baseAsset, market: prepared.market, residual, residualZ, beta, volatility, quoteVolume: prepared.bars[index].qv, prepared, signalIndex: index });
  }
  return rows;
}

function pairRows(trades) {
  const grouped = new Map();
  for (const trade of trades) {
    const key = `${trade.signalTime}|${trade.entryTime}`;
    const row = grouped.get(key) || { signalTime: trade.signalTime, entryTime: trade.entryTime, exitTime: trade.exitTime, layer: trade.layer, netPnl: 0, grossPnl: 0, fees: 0, fundingPnl: 0, reason: trade.reason };
    row.exitTime = Math.max(row.exitTime, trade.exitTime); row.netPnl += trade.netPnl; row.grossPnl += trade.grossPnl; row.fees += trade.fees; row.fundingPnl += trade.fundingPnl;
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => a.entryTime - b.entryTime);
}

function summarizeResidualRun(run) {
  const pairs = pairRows(run.trades), wins = pairs.filter(row => row.netPnl > 0), losses = pairs.filter(row => row.netPnl < 0);
  const sum = rows => rows.reduce((total, row) => total + row.netPnl, 0);
  const legWins = run.trades.filter(row => row.netPnl > 0), legLosses = run.trades.filter(row => row.netPnl < 0);
  let peak = run.equity[0]?.equity || run.initialEquity, maxDrawdown = 0;
  for (const point of run.equity) { peak = Math.max(peak, point.equity); maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1); }
  const bySymbol = {}, byLayer = {};
  for (const trade of run.trades) { bySymbol[trade.symbol] = (bySymbol[trade.symbol] || 0) + trade.netPnl; byLayer[trade.layer] = (byLayer[trade.layer] || 0) + trade.netPnl; }
  const positive = Object.values(bySymbol).filter(value => value > 0), positiveTotal = positive.reduce((a, b) => a + b, 0);
  return {
    trades: run.trades.length,
    pairs: pairs.length,
    finalSignals: run.finalSignals.length,
    executedSignals: run.executedSignals,
    pairWinRate: pairs.length ? wins.length / pairs.length : 0,
    pairProfitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    legProfitFactor: legLosses.length ? sum(legWins) / Math.abs(sum(legLosses)) : null,
    totalReturn: run.finalEquity / run.initialEquity - 1,
    maxDrawdown,
    netPnl: sum(pairs),
    fees: run.trades.reduce((a, row) => a + row.fees, 0),
    funding: run.trades.reduce((a, row) => a + row.fundingPnl, 0),
    longTrades: run.trades.filter(row => row.side === 1).length,
    shortTrades: run.trades.filter(row => row.side === -1).length,
    profitableSymbols: positive.length,
    maxSymbolContribution: positiveTotal ? Math.max(...positive) / positiveTotal : 1,
    profitableLayers: Object.values(byLayer).filter(value => value > 0).length,
    byLayer,
    bySymbol
  };
}

function simulateResidualPeriod({ preparedSymbols, layers, candidate, startTime, endTime, scenario, initialEquity = 100000 }) {
  const bySymbol = new Map(preparedSymbols.map(row => [row.symbol, row]));
  const positions = [], trades = [], equity = [], finalSignals = [];
  let cash = initialEquity, pending = null, executedSignals = 0;
  const cost = candidate.id === 'cash' ? 0 : costForLayer(candidate.layer, scenario);
  const signalCost = candidate.id === 'cash' ? 0 : costForLayer(candidate.layer, 'stress');
  const markEquity = time => cash + positions.reduce((total, position) => total + position.legs.reduce((pairTotal, leg) => {
    const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), price = index == null ? leg.lastPrice : prepared.bars[index].c;
    return pairTotal + leg.side * leg.qty * (price - leg.entryPrice);
  }, 0), 0);
  const closePair = (position, time, reason, prices = null) => {
    for (const leg of position.legs) {
      const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
      const price = prices?.get(leg.symbol) ?? (reason === 'period_end' ? (bar?.c ?? leg.lastPrice) : (bar?.o ?? leg.lastPrice));
      const grossPnl = leg.side * leg.qty * (price - leg.entryPrice), exitFee = leg.qty * price * cost / 2;
      cash += grossPnl - exitFee;
      trades.push({ symbol: leg.symbol, baseAsset: leg.baseAsset, market: leg.market, layer: candidate.layer, strategy: 'btc_residual_reversal', lookbackBars: candidate.lookbackBars, holdBars: candidate.holdBars, side: leg.side, signalTime: position.signalTime, entryTime: position.entryTime, exitTime: time, entryPrice: leg.entryPrice, exitPrice: price, qty: leg.qty, notional: leg.qty * leg.entryPrice, beta: leg.beta, residual: leg.residual, residualZ: leg.residualZ, grossPnl, fees: leg.entryFee + exitFee, fundingPnl: leg.fundingPnl, netPnl: grossPnl - leg.entryFee - exitFee + leg.fundingPnl, reason });
    }
    positions.splice(positions.indexOf(position), 1);
  };

  for (let time = startTime; time <= endTime; time += FOUR_HOURS) {
    for (const position of positions.slice()) {
      const bars = new Map(); let missing = false;
      for (const leg of position.legs) {
        const prepared = bySymbol.get(leg.symbol), index = prepared.indexByTime.get(time), bar = index == null ? null : prepared.bars[index];
        if (!bar) { missing = true; continue; }
        bars.set(leg.symbol, bar); leg.lastPrice = bar.c;
        const rate = prepared.fundingMap.get(time);
        if (Number.isFinite(rate)) { const payment = -leg.side * leg.qty * bar.o * rate; cash += payment; leg.fundingPnl += payment; }
      }
      if (missing) {
        const prices = new Map(position.legs.map(leg => [leg.symbol, leg.lastPrice * (1 - leg.side * 0.01)]));
        closePair(position, time, 'missing_or_delist', prices); continue;
      }
      const accumulatedFunding = position.legs.reduce((sum, leg) => sum + leg.fundingPnl, 0);
      const entryFees = position.legs.reduce((sum, leg) => sum + leg.entryFee, 0);
      if (adversePairPnl(position, bars) + accumulatedFunding - entryFees <= -position.riskBudget) {
        const prices = new Map(position.legs.map(leg => [leg.symbol, leg.side === 1 ? bars.get(leg.symbol).l : bars.get(leg.symbol).h]));
        closePair(position, time, 'pair_stop', prices); continue;
      }
      if (time - position.entryTime >= candidate.holdBars * FOUR_HOURS) closePair(position, time, 'time');
    }

    if (pending && pending.entryTime === time) {
      const longIndex = pending.long.prepared.indexByTime.get(time), shortIndex = pending.short.prepared.indexByTime.get(time);
      const longBar = longIndex == null ? null : pending.long.prepared.bars[longIndex], shortBar = shortIndex == null ? null : pending.short.prepared.bars[shortIndex];
      if (longBar && shortBar) {
        const openEquity = markEquity(time), notionals = betaNeutralNotionals({ equity: openEquity, longBeta: pending.long.beta, shortBeta: pending.short.beta });
        const legs = [[pending.long, 1, longBar, notionals.longNotional], [pending.short, -1, shortBar, notionals.shortNotional]].map(([row, side, bar, notional]) => {
          const qty = notional / bar.o, entryFee = notional * cost / 2; cash -= entryFee; executedSignals++;
          return { symbol: row.symbol, baseAsset: row.baseAsset, market: row.market, side, beta: row.beta, residual: row.residual, residualZ: row.residualZ, qty, entryPrice: bar.o, entryFee, fundingPnl: 0, lastPrice: bar.o };
        });
        const position = { signalTime: pending.signalTime, entryTime: time, riskBudget: openEquity * 0.0025, legs };
        positions.push(position);
        const bars = new Map([[pending.long.symbol, longBar], [pending.short.symbol, shortBar]]);
        if (adversePairPnl(position, bars) - legs.reduce((sum, leg) => sum + leg.entryFee, 0) <= -position.riskBudget) {
          const prices = new Map(legs.map(leg => [leg.symbol, leg.side === 1 ? bars.get(leg.symbol).l : bars.get(leg.symbol).h]));
          closePair(position, time, 'pair_stop', prices);
        }
      }
      pending = null;
    }

    if (candidate.id !== 'cash' && !pending && positions.length < 2 && new Date(time).getUTCHours() === 0 && Math.floor(time / 86400000) % 2 === 0 && time + FOUR_HOURS <= endTime) {
      const occupiedBases = new Set(positions.flatMap(position => position.legs.map(leg => leg.baseAsset)));
      const pair = selectResidualPair(candidateRows(preparedSymbols, layers, candidate, time, occupiedBases));
      if (pair && pair.short.residualZ - pair.long.residualZ >= 3 && pair.gap >= 2.5 * signalCost) {
        pending = { ...pair, signalTime: time, entryTime: time + FOUR_HOURS };
        finalSignals.push(
          { symbol: pair.long.symbol, baseAsset: pair.long.baseAsset, market: pair.long.market, layer: candidate.layer, strategy: 'btc_residual_reversal', lookbackBars: candidate.lookbackBars, holdBars: candidate.holdBars, side: 1, beta: pair.long.beta, residual: pair.long.residual, residualZ: pair.long.residualZ, signalTime: time, entryTime: time + FOUR_HOURS },
          { symbol: pair.short.symbol, baseAsset: pair.short.baseAsset, market: pair.short.market, layer: candidate.layer, strategy: 'btc_residual_reversal', lookbackBars: candidate.lookbackBars, holdBars: candidate.holdBars, side: -1, beta: pair.short.beta, residual: pair.short.residual, residualZ: pair.short.residualZ, signalTime: time, entryTime: time + FOUR_HOURS }
        );
      }
    }
    equity.push({ time, equity: markEquity(time), cash, pairs: positions.length, grossExposure: positions.reduce((sum, position) => sum + position.legs.reduce((a, leg) => a + leg.qty * leg.lastPrice, 0), 0) });
  }
  const lastTime = equity.at(-1)?.time;
  if (lastTime != null) {
    for (const position of positions.slice()) closePair(position, lastTime, 'period_end');
    equity[equity.length - 1] = { ...equity[equity.length - 1], equity: cash, cash, pairs: 0, grossExposure: 0 };
  }
  const run = { initialEquity, finalEquity: cash, trades, equity, finalSignals, executedSignals };
  run.summary = summarizeResidualRun(run);
  return run;
}

module.exports = {
  rollingFactorFeatures,
  attachFactorFeatures,
  selectResidualPair,
  betaNeutralNotionals,
  adversePairPnl,
  chooseResidualCandidate,
  candidateRows,
  pairRows,
  summarizeResidualRun,
  simulateResidualPeriod
};
