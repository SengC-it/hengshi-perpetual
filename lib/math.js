export function clip(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function safeLog(value) {
  return value > 0 && Number.isFinite(value) ? Math.log(value) : 0;
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function ema(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;
  let seed = 0;
  for (let index = 0; index < period; index++) seed += values[index];
  output[period - 1] = seed / period;
  const weight = 2 / (period + 1);
  for (let index = period; index < values.length; index++) {
    output[index] = values[index] * weight + output[index - 1] * (1 - weight);
  }
  return output;
}

export function atr(bars, period = 14) {
  const output = Array(bars.length).fill(null);
  if (bars.length <= period) return output;
  const trueRanges = bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - bars[index - 1].close),
      Math.abs(bar.low - bars[index - 1].close)
    ));
  let seed = 0;
  for (let index = 1; index <= period; index++) seed += trueRanges[index];
  output[period] = seed / period;
  for (let index = period + 1; index < bars.length; index++) {
    output[index] = (output[index - 1] * (period - 1) + trueRanges[index]) / period;
  }
  return output;
}

export function rollingMedianPrevious(values, window) {
  return values.map((_, index) => index < window ? null : median(values.slice(index - window, index)));
}

export function rollingZ(values, window = 126) {
  const output = Array(values.length).fill(null);
  const queue = [];
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (Number.isFinite(value) && queue.length >= Math.min(30, window)) {
      const mean = sum / queue.length;
      const variance = Math.max(0, sumSquares / queue.length - mean ** 2);
      const deviation = Math.sqrt(variance);
      output[index] = deviation > 1e-12
        ? (value - mean) / deviation
        : (value === mean ? 0 : Math.sign(value - mean) * Infinity);
    }
    if (Number.isFinite(value)) {
      queue.push(value);
      sum += value;
      sumSquares += value ** 2;
    }
    if (queue.length > window) {
      const removed = queue.shift();
      sum -= removed;
      sumSquares -= removed ** 2;
    }
  }
  return output;
}
