const { CONFIG } = require('./config');

function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }

function fundingPayment(side, qty, markPrice, fundingRate) {
  return -side * qty * markPrice * fundingRate;
}

function pairPricePnl({ longQty, longEntry, longExit, shortQty, shortEntry, shortExit }) {
  return longQty * (longExit - longEntry) + shortQty * (shortEntry - shortExit);
}

function buildFundingSignals({ fundingBySymbol, threshold, rollingEvents = 3, minSymbols = 8 }) {
  const events = new Map(), queues = new Map();
  for (const [symbol, rows] of Object.entries(fundingBySymbol)) for (const row of rows) {
    if (!events.has(row.fundingTime)) events.set(row.fundingTime, []);
    events.get(row.fundingTime).push({ symbol, ...row });
  }
  const signals = [];
  for (const signalTime of [...events.keys()].sort((a, b) => a - b)) {
    for (const row of events.get(signalTime)) {
      const queue = queues.get(row.symbol) || [];
      queue.push(row.fundingRate);
      if (queue.length > rollingEvents) queue.shift();
      queues.set(row.symbol, queue);
    }
    const available = events.get(signalTime).map(row => ({ symbol: row.symbol, queue: queues.get(row.symbol) }))
      .filter(x => x.queue.length === rollingEvents)
      .map(x => ({ symbol: x.symbol, trailingRate: mean(x.queue) }));
    if (available.length < minSymbols) continue;
    available.sort((a, b) => a.trailingRate - b.trailingRate || a.symbol.localeCompare(b.symbol));
    const low = available[0], high = available.at(-1), spread = high.trailingRate - low.trailingRate;
    if (spread >= threshold && low.symbol !== high.symbol) signals.push({
      signalTime,
      longSymbol: low.symbol,
      shortSymbol: high.symbol,
      longTrailingRate: low.trailingRate,
      shortTrailingRate: high.trailingRate,
      spread
    });
  }
  return signals;
}

function simulateFundingPairs({
  barsBySymbol,
  fundingBySymbol,
  params,
  start,
  end,
  cost = CONFIG.baseCost,
  initialEquity = 100000
}) {
  const from = Date.parse(`${start}T00:00:00Z`), to = Date.parse(`${end}T23:59:59.999Z`);
  const indexMaps = Object.fromEntries(Object.entries(barsBySymbol).map(([symbol, bars]) => [symbol, new Map(bars.map((bar, index) => [bar.openTime, index]))]));
  const fundingMaps = Object.fromEntries(Object.entries(fundingBySymbol).map(([symbol, rows]) => [symbol, new Map(rows.map(row => [row.fundingTime, row]))]));
  const signals = buildFundingSignals({ fundingBySymbol, threshold: params.threshold, rollingEvents: params.rollingEvents || 3, minSymbols: params.minSymbols || 8 });
  const signalMap = new Map(signals.map(signal => [signal.signalTime, signal]));
  const times = (barsBySymbol.BTCUSDT || []).map(bar => bar.openTime).filter(time => time >= from && time <= to);
  const trades = [], equity = [], orders = [];
  let cash = initialEquity, position = null;

  function barsAt(time, pair = position) {
    if (!pair) return null;
    const longIndex = indexMaps[pair.longSymbol]?.get(time), shortIndex = indexMaps[pair.shortSymbol]?.get(time);
    if (longIndex == null || shortIndex == null) return null;
    return { long: barsBySymbol[pair.longSymbol][longIndex], short: barsBySymbol[pair.shortSymbol][shortIndex] };
  }

  function markEquity(time, useOpen = false) {
    if (!position) return cash;
    const bars = barsAt(time);
    if (!bars) return cash + position.lastPricePnl;
    const longExit = useOpen ? bars.long.o : bars.long.c, shortExit = useOpen ? bars.short.o : bars.short.c;
    return cash + pairPricePnl({ ...position, longExit, shortExit });
  }

  function exitPair(longExit, shortExit, exitTime, reason) {
    const pricePnl = pairPricePnl({ ...position, longExit, shortExit });
    const exitFee = (position.longQty * longExit + position.shortQty * shortExit) * cost / 2;
    cash += pricePnl - exitFee;
    const netPnl = pricePnl + position.fundingPnl - position.entryFee - exitFee;
    trades.push({
      longSymbol: position.longSymbol,
      shortSymbol: position.shortSymbol,
      signalTime: position.signalTime,
      entryTime: position.entryTime,
      exitTime,
      longEntry: position.longEntry,
      longExit,
      shortEntry: position.shortEntry,
      shortExit,
      longQty: position.longQty,
      shortQty: position.shortQty,
      legNotional: position.legNotional,
      signalSpread: position.signalSpread,
      pricePnl,
      fundingPnl: position.fundingPnl,
      fees: position.entryFee + exitFee,
      netPnl,
      reason,
      hoursHeld: (exitTime - position.entryTime) / 3600000
    });
    position = null;
  }

  for (const time of times) {
    if (position) {
      const currentBars = barsAt(time);
      if (!currentBars) continue;
      if ((time - position.entryTime) / 3600000 >= params.maxHoldHours) {
        exitPair(currentBars.long.o, currentBars.short.o, time, 'time');
      } else {
        for (const [symbol, side, qty, fallback] of [
          [position.longSymbol, 1, position.longQty, currentBars.long.o],
          [position.shortSymbol, -1, position.shortQty, currentBars.short.o]
        ]) {
          const funding = fundingMaps[symbol]?.get(time);
          if (funding && time > position.entryTime && !position.fundingTimes.has(`${symbol}:${time}`)) {
            const payment = fundingPayment(side, qty, Number.isFinite(funding.markPrice) ? funding.markPrice : fallback, funding.fundingRate);
            cash += payment;
            position.fundingPnl += payment;
            position.fundingTimes.add(`${symbol}:${time}`);
          }
        }
        const pricePnl = pairPricePnl({ ...position, longExit: currentBars.long.c, shortExit: currentBars.short.c });
        position.lastPricePnl = pricePnl;
        if (pricePnl + position.fundingPnl - position.entryFee <= -params.stopEquityFraction * position.entryEquity) {
          exitPair(currentBars.long.c, currentBars.short.c, time + CONFIG.intervalMs, 'pair_stop');
        }
      }
    }

    if (!position) {
      const signal = signalMap.get(time - CONFIG.intervalMs);
      if (signal) {
        const longIndex = indexMaps[signal.longSymbol]?.get(time), shortIndex = indexMaps[signal.shortSymbol]?.get(time);
        if (longIndex != null && shortIndex != null) {
          const longEntry = barsBySymbol[signal.longSymbol][longIndex].o, shortEntry = barsBySymbol[signal.shortSymbol][shortIndex].o;
          const entryEquity = cash, legNotional = entryEquity * (params.maxGross || 1) / 2;
          const longQty = legNotional / longEntry, shortQty = legNotional / shortEntry;
          const entryFee = (legNotional * 2) * cost / 2;
          cash -= entryFee;
          position = {
            ...signal,
            longEntry,
            shortEntry,
            longQty,
            shortQty,
            legNotional,
            signalSpread: signal.spread,
            entryTime: time,
            entryEquity,
            entryFee,
            fundingPnl: 0,
            fundingTimes: new Set(),
            lastPricePnl: 0
          };
          orders.push({ ...signal, entryTime: time, longEntry, shortEntry, legNotional });
        }
      }
    }
    equity.push({ time, equity: markEquity(time), cash, position: position ? 1 : 0, grossExposure: position ? position.legNotional * 2 : 0 });
  }

  if (position && times.length) {
    const lastTime = times.at(-1), currentBars = barsAt(lastTime);
    if (currentBars) exitPair(currentBars.long.c, currentBars.short.c, lastTime + CONFIG.intervalMs, 'end');
    if (equity.length) equity[equity.length - 1].equity = cash;
  }
  return { trades, equity, orders, signals };
}

module.exports = { fundingPayment, pairPricePnl, buildFundingSignals, simulateFundingPairs };
