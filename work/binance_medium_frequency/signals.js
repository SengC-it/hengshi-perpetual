const { ema, median, windowReturn, realizedVol } = require('./indicators');

function computeRegime(bars, params) {
  const close = bars.map(b => b.c);
  const fast = ema(close, params.fast);
  const slow = ema(close, params.slow);
  return bars.map((b, i) => {
    if (fast[i] == null || slow[i] == null) return 'neutral';
    if (b.c > slow[i] && fast[i] > slow[i]) return 'bull';
    if (b.c < slow[i] && fast[i] < slow[i]) return 'bear';
    return 'neutral';
  });
}

function combinedScore(r24, v24, rLong, vLong) {
  if (![r24,v24,rLong,vLong].every(Number.isFinite) || v24 === 0 || vLong === 0) return null;
  return 0.5 * r24 / v24 + 0.5 * rLong / vLong;
}

function scoreSeries(bars, params) {
  const close = bars.map(b => b.c);
  const shortBars = params.shortMomentum / 4;
  const longBars = params.longMomentum / 4;
  const r1 = windowReturn(close, shortBars), r2 = windowReturn(close, longBars);
  const v1 = realizedVol(close, shortBars), v2 = realizedVol(close, longBars);
  return close.map((_, i) => combinedScore(r1[i], v1[i], r2[i], v2[i]));
}

function rankEligible(items) {
  return items.filter(x => Number.isFinite(x.score)).slice().sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

function prepareSymbol(bars, params) {
  const close = bars.map(b => b.c);
  const shortBars = params.shortMomentum / 4;
  const longBars = params.longMomentum / 4;
  return {
    params,
    bars,
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    r24: windowReturn(close, shortBars),
    rLong: windowReturn(close, longBars),
    scores: scoreSeries(bars, params)
  };
}

function strictShortGate({ prepared, indexBySymbol, regime, breadthThreshold = 0.65, slopeBars = 6 }) {
  if (regime !== 'bear') return false;
  const btc = prepared.BTCUSDT, i = indexBySymbol.BTCUSDT;
  if (!btc || !Number.isInteger(i) || i <= 0) return false;
  const prior = Math.max(0, i - slopeBars);
  if (![btc.bars[i]?.c, btc.ema50[i], btc.ema50[prior], btc.ema200[i]].every(Number.isFinite)) return false;
  if (!(btc.bars[i].c < btc.ema200[i] && btc.ema50[i] < btc.ema200[i] && btc.ema50[i] < btc.ema50[prior])) return false;
  const breadth = Object.entries(prepared).map(([symbol, p]) => {
    const j = indexBySymbol[symbol];
    return Number.isInteger(j) && Number.isFinite(p.bars[j]?.c) && Number.isFinite(p.ema50[j]) ? p.bars[j].c < p.ema50[j] : null;
  }).filter(x => x != null);
  return breadth.length > 0 && breadth.filter(Boolean).length / breadth.length >= breadthThreshold;
}

function strictLongGate({ prepared, indexBySymbol, regime, breadthThreshold = 0.65, slopeBars = 6 }) {
  if (regime !== 'bull') return false;
  const btc = prepared.BTCUSDT, i = indexBySymbol.BTCUSDT;
  if (!btc || !Number.isInteger(i) || i <= 0) return false;
  const prior = Math.max(0, i - slopeBars);
  if (![btc.bars[i]?.c, btc.ema50[i], btc.ema50[prior], btc.ema200[i]].every(Number.isFinite)) return false;
  if (!(btc.bars[i].c > btc.ema200[i] && btc.ema50[i] > btc.ema200[i] && btc.ema50[i] > btc.ema50[prior])) return false;
  const breadth = Object.entries(prepared).map(([symbol, p]) => {
    const j = indexBySymbol[symbol];
    return Number.isInteger(j) && Number.isFinite(p.bars[j]?.c) && Number.isFinite(p.ema50[j]) ? p.bars[j].c > p.ema50[j] : null;
  }).filter(x => x != null);
  return breadth.length > 0 && breadth.filter(Boolean).length / breadth.length >= breadthThreshold;
}

function entryCandidates({ prepared, indexBySymbol, regime, side }) {
  if (regime === 'neutral') return [];
  const params = prepared.BTCUSDT?.params || {};
  const sideMode = params.sideMode || 'symmetric';
  const strictLongMode = sideMode === 'strict_long' || sideMode === 'strict_both';
  const strictShortMode = sideMode === 'strict_short' || sideMode === 'strict_both';
  const longGate = !strictLongMode || strictLongGate({ prepared, indexBySymbol, regime });
  const shortGate = sideMode === 'symmetric' || sideMode === 'short_only' || (strictShortMode && strictShortGate({ prepared, indexBySymbol, regime }));
  const allowLong = regime === 'bull' && sideMode !== 'short_only' && longGate;
  const allowShort = regime === 'bear' && !['long_only', 'strict_long'].includes(sideMode) && shortGate;
  if (!allowLong && !allowShort) return [];
  const ranked = rankEligible(Object.entries(prepared).map(([symbol, p]) => ({ symbol, score: p.scores[indexBySymbol[symbol]] }))
    .filter(x => Number.isFinite(x.score)));
  const allowed = new Set((regime === 'bull' ? ranked.slice(0, 3) : ranked.slice(-3)).map(x => x.symbol));
  const result = [];
  for (const symbol of allowed) {
    const p = prepared[symbol], i = indexBySymbol[symbol];
    if (i < 20 || p.ema20[i] == null || p.ema50[i] == null) continue;
    const b = p.bars[i], prev = p.bars[i - 1];
    const volumeMedian = median(p.bars.slice(i - 20, i).map(x => x.v));
    const positiveMomentum = !strictLongMode || (p.r24[i] > 0 && p.rLong[i] > 0);
    const long = allowLong && positiveMomentum && b.c > p.ema50[i] && (b.l <= p.ema20[i] || prev.l <= p.ema20[i - 1]) && b.c > p.ema20[i];
    const negativeMomentum = sideMode !== 'strict_short' || (p.r24[i] < 0 && p.rLong[i] < 0);
    const short = regime === 'bear' && shortGate && negativeMomentum && b.c < p.ema50[i] && (b.h >= p.ema20[i] || prev.h >= p.ema20[i - 1]) && b.c < p.ema20[i];
    if ((long || short) && b.v > volumeMedian) result.push({ symbol, side: long ? 1 : -1, score: p.scores[i], signalTime: b.openTime });
  }
  return result.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.symbol.localeCompare(b.symbol));
}

module.exports = { computeRegime, combinedScore, scoreSeries, rankEligible, prepareSymbol, strictLongGate, strictShortGate, entryCandidates };
