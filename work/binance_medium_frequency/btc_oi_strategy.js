const fs = require('fs');
const { atr } = require('./indicators');

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function parseMetrics(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  return lines.filter(Boolean).map(line => {
    const values = line.split(',');
    const row = Object.fromEntries(headers.map((header, index) => {
      const value = values[index];
      return [header, value !== '' && Number.isFinite(Number(value)) ? Number(value) : null];
    }));
    return row;
  });
}

function fundingRatesByBar(bars, funding) {
  const rates = Array(bars.length).fill(0), byTime = new Map(funding.map(row => [row.fundingTime, row.fundingRate]));
  for (let i = 0; i < bars.length; i++) rates[i] = byTime.get(bars[i].openTime) || 0;
  return rates;
}

function signalAt({ bars, metrics, fundingRates, index, params }) {
  const start = index - params.breakoutBars;
  if (start < 0 || index - params.oiLookbackBars < 0) return 0;
  const metric = metrics[index], pastMetric = metrics[index - params.oiLookbackBars];
  if (!metric || !pastMetric || !(metric.openInterest > 0) || !(pastMetric.openInterest > 0) || !Number.isFinite(metric.takerRatio)) return 0;
  const oiChange = metric.openInterest / pastMetric.openInterest - 1;
  if (oiChange < params.oiThreshold) return 0;
  let priorHigh = -Infinity, priorLow = Infinity;
  for (let i = start; i < index; i++) {
    priorHigh = Math.max(priorHigh, bars[i].h);
    priorLow = Math.min(priorLow, bars[i].l);
  }
  const funding = fundingRates[index] || 0;
  if (bars[index].c > priorHigh && metric.takerRatio > 1 && funding <= params.fundingLimit) return 1;
  if (bars[index].c < priorLow && metric.takerRatio < 1 && funding >= -params.fundingLimit) return -1;
  return 0;
}

function positionSize({ equity, entry, stop, riskFraction, maxNotional }) {
  const distance = Math.abs(entry - stop);
  if (!(equity > 0) || !(entry > 0) || !(distance > 0)) return 0;
  return Math.min(equity * riskFraction / distance, equity * maxNotional / entry);
}

function stopFillPrice(position, bar) {
  if (position.side === 1) {
    if (bar.o <= position.stop) return bar.o;
    if (bar.l <= position.stop) return position.stop;
  } else {
    if (bar.o >= position.stop) return bar.o;
    if (bar.h >= position.stop) return position.stop;
  }
  return null;
}

function finite(value) { return Number.isFinite(value) ? value : 0; }

function chooseCandidate(rows) {
  if (!rows.length) throw new Error('no BTC OI candidates');
  return rows.slice().sort((a, b) => finite(b.medianQuarterlyStressPf) - finite(a.medianQuarterlyStressPf)
    || finite(b.positiveQuarterShare) - finite(a.positiveQuarterShare)
    || finite(b.stress?.profitFactor) - finite(a.stress?.profitFactor)
    || finite(b.stress?.totalReturn) - finite(a.stress?.totalReturn)
    || Math.abs(finite(a.stress?.maxDrawdown)) - Math.abs(finite(b.stress?.maxDrawdown))
    || a.id.localeCompare(b.id))[0];
}

function acceptance({ base, stress, extreme, positiveQuarterShare, profitWithoutBest5, bootstrapProbabilityPositive, sideRobustness }) {
  const checks = {
    tradeCount: stress.trades >= 50,
    signalFrequency: stress.signalsPerDay >= 0.5 && stress.signalsPerDay <= 2,
    baseProfitFactor: base.profitFactor >= 1.30,
    stressProfitFactor: stress.profitFactor >= 1.15,
    extremeProfitFactor: extreme.profitFactor >= 1,
    stressPositiveReturn: stress.totalReturn > 0,
    drawdown: stress.maxDrawdown > -0.20,
    positiveQuarters: positiveQuarterShare >= 0.625,
    withoutBestFive: profitWithoutBest5 > 0,
    bootstrapProbability: bootstrapProbabilityPositive >= 0.70,
    longRobust: sideRobustness.long === true,
    shortRobust: sideRobustness.short === true
  };
  return { pass: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) };
}

function summarize({ trades, equity, startTime, endTime, signalCount = 0 }) {
  const wins = trades.filter(t => t.netPnl > 0), losses = trades.filter(t => t.netPnl < 0);
  const sum = rows => rows.reduce((total, row) => total + row.netPnl, 0);
  let peak = equity[0]?.equity || 100000, maxDrawdown = 0;
  for (const point of equity) { peak = Math.max(peak, point.equity); maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1); }
  const first = equity[0]?.equity || 100000, last = equity.at(-1)?.equity || first;
  const days = Math.max(1, (endTime - startTime) / 86400000 + 1);
  return {
    trades: trades.length,
    signals: signalCount,
    tradesPerDay: trades.length / days,
    signalsPerDay: signalCount / days,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    totalReturn: last / first - 1,
    maxDrawdown,
    netPnl: sum(trades),
    totalFees: trades.reduce((a, t) => a + t.fees, 0),
    totalFunding: trades.reduce((a, t) => a + t.fundingPnl, 0),
    longTrades: trades.filter(t => t.side === 1).length,
    shortTrades: trades.filter(t => t.side === -1).length
  };
}

function simulate({ bars, metricsRows, funding, params, start, end, cost, initialEquity = 100000 }) {
  const metricMap = new Map(metricsRows.map(row => [row.openTime, row]));
  const metrics = bars.map(bar => metricMap.get(bar.openTime) || null);
  const fundingRates = fundingRatesByBar(bars, funding);
  const fundingMap = new Map(funding.map(row => [row.fundingTime, row]));
  const atrs = atr(bars, 14);
  const from = Date.parse(`${start}T00:00:00Z`), to = Date.parse(`${end}T23:59:59.999Z`);
  const trades = [], equity = [];
  let cash = initialEquity, position = null, pending = null, signalCount = 0;

  const markEquity = price => cash + (position ? position.side * position.qty * (price - position.entryPrice) : 0);
  const closePosition = (price, time, reason) => {
    const grossPnl = position.side * position.qty * (price - position.entryPrice);
    const exitFee = position.qty * price * cost / 2;
    cash += grossPnl - exitFee;
    const netPnl = grossPnl - position.entryFee - exitFee + position.fundingPnl;
    trades.push({
      side: position.side, signalTime: position.signalTime, entryTime: position.entryTime, exitTime: time,
      entryPrice: position.entryPrice, exitPrice: price, qty: position.qty, notional: position.notional,
      grossPnl, fees: position.entryFee + exitFee, fundingPnl: position.fundingPnl, netPnl, reason,
      barsHeld: Math.round((time - position.entryTime) / FOUR_HOURS)
    });
    position = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i], time = bar.openTime;
    if (time < from || time > to) continue;

    if (position) {
      const event = fundingMap.get(time);
      if (event && !position.fundingTimes.has(time)) {
        const mark = Number.isFinite(event.markPrice) ? event.markPrice : bar.o;
        const payment = -position.side * position.qty * mark * event.fundingRate;
        cash += payment; position.fundingPnl += payment; position.fundingTimes.add(time);
      }
      const stopPrice = stopFillPrice(position, bar);
      if (stopPrice != null) closePosition(stopPrice, time, 'stop');
      else if ((time - position.entryTime) / 3600000 >= params.maxHoldHours) closePosition(bar.o, time, 'time');
    }

    if (!position && pending && pending.entryTime === time && atrs[pending.signalIndex] > 0) {
      const entry = bar.o, stop = entry - pending.side * params.stopAtr * atrs[pending.signalIndex];
      const qty = positionSize({ equity: cash, entry, stop, riskFraction: params.riskFraction, maxNotional: params.maxNotional });
      if (qty > 0) {
        const entryFee = qty * entry * cost / 2;
        cash -= entryFee;
        position = {
          side: pending.side, signalTime: pending.signalTime, entryTime: time, entryPrice: entry,
          qty, notional: qty * entry, stop, best: entry, entryFee, fundingPnl: 0, fundingTimes: new Set()
        };
        const sameBarStop = stopFillPrice(position, bar);
        if (sameBarStop != null) closePosition(sameBarStop, time, 'stop');
      }
    }
    pending = null;

    if (position) {
      if (position.side === 1) {
        position.best = Math.max(position.best, bar.h);
        position.stop = Math.max(position.stop, position.best - params.trailAtr * atrs[i]);
      } else {
        position.best = Math.min(position.best, bar.l);
        position.stop = Math.min(position.stop, position.best + params.trailAtr * atrs[i]);
      }
    }

    const signal = signalAt({ bars, metrics, fundingRates, index: i, params });
    if (signal) signalCount++;
    if (!position && signal && i + 1 < bars.length && bars[i + 1].openTime <= to) {
      pending = { side: signal, signalTime: time, signalIndex: i, entryTime: bars[i + 1].openTime };
    }
    equity.push({ time, equity: markEquity(bar.c), cash, position: position?.side || 0, notional: position?.notional || 0 });
  }

  if (position && equity.length) {
    const lastTime = equity.at(-1).time, lastBar = bars.find(bar => bar.openTime === lastTime);
    closePosition(lastBar.c, lastTime + FOUR_HOURS, 'end');
    equity[equity.length - 1].equity = cash;
    equity[equity.length - 1].cash = cash;
    equity[equity.length - 1].position = 0;
    equity[equity.length - 1].notional = 0;
  }
  return { trades, equity, signalCount };
}

module.exports = {
  parseMetrics, fundingRatesByBar, signalAt, positionSize, stopFillPrice,
  chooseCandidate, acceptance, summarize, simulate
};
