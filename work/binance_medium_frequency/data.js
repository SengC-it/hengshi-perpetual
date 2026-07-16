const fs = require('fs');

function parseKlineCsv(text, symbol) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  return lines.slice(1).filter(Boolean).map(line => {
    const [openTime, open, high, low, close, volume, closeTime] = line.split(',');
    return { symbol, openTime: +openTime, o: +open, h: +high, l: +low, c: +close, v: +volume, closeTime: +closeTime };
  });
}

function validateBars(bars, intervalMs = 14400000) {
  const warnings = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (![b.openTime,b.o,b.h,b.l,b.c,b.v,b.closeTime].every(Number.isFinite)) throw new Error(`non-finite bar at ${i}`);
    if (b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c) || b.h < b.l) throw new Error(`invalid OHLC at ${i}`);
    if (i && b.openTime <= bars[i - 1].openTime) throw new Error(`timestamp order or duplicate at ${i}`);
    if (i && b.openTime - bars[i - 1].openTime !== intervalMs) warnings.push({ type: 'gap', after: bars[i - 1].openTime, before: b.openTime });
  }
  return warnings;
}

function isEligible(index, firstIndex, minimum) { return index - firstIndex >= minimum; }

function sliceBars(bars, start, end) {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T23:59:59.999Z`);
  return bars.filter(b => b.openTime >= from && b.openTime <= to);
}

function loadBars(file, symbol) {
  const bars = parseKlineCsv(fs.readFileSync(file, 'utf8'), symbol);
  const warnings = validateBars(bars);
  return { bars, warnings };
}

module.exports = { parseKlineCsv, validateBars, isEligible, sliceBars, loadBars };
