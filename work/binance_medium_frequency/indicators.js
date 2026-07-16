function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function atr(bars, period) {
  const out = Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const tr = bars.map((b, i) => i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  out[period] = seed / period;
  for (let i = period + 1; i < bars.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

function median(values) {
  const x = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}

function windowReturn(values, bars) {
  return values.map((v, i) => i < bars ? null : v / values[i - bars] - 1);
}

function realizedVol(values, bars) {
  const ret = values.map((v, i) => i ? Math.log(v / values[i - 1]) : null);
  return values.map((_, i) => {
    if (i < bars) return null;
    const x = ret.slice(i - bars + 1, i + 1);
    const mean = x.reduce((a, b) => a + b, 0) / x.length;
    return Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / x.length);
  });
}

module.exports = { ema, atr, median, windowReturn, realizedVol };
