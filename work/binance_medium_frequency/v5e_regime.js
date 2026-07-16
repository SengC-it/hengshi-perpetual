function marketRegimeAllows(event, benchmark) {
  const index = benchmark.indexByTime.get(event.signalTime);
  if (index == null || index < 50) return false;
  const fast = benchmark.ema20[index], slow = benchmark.ema50[index];
  if (!(fast > 0) || !(slow > 0)) return false;
  return event.side === 1 ? fast > slow : fast < slow;
}

function filterByMarketRegime(events, benchmark) {
  return events.filter(event => marketRegimeAllows(event, benchmark));
}

module.exports = { marketRegimeAllows, filterByMarketRegime };
