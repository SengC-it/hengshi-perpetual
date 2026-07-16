function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function validationSummary(rows) {
  const targets = rows.map(row => row.target);
  const wins = sum(targets.filter(value => value > 0));
  const losses = Math.abs(sum(targets.filter(value => value < 0)));
  return {
    rows: rows.length,
    netTarget: sum(targets),
    profitFactor: losses > 0 ? wins / losses : (wins > 0 ? Infinity : null),
    withoutBest3: sum(targets.slice().sort((a, b) => b - a).slice(3))
  };
}

function validationPass(rows) {
  const summary = validationSummary(rows);
  const checks = {
    tradeCount: summary.rows >= 30,
    positiveTarget: summary.netTarget > 0,
    profitFactor: summary.profitFactor >= 1.10,
    withoutBest3: summary.withoutBest3 > 0
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    summary,
    failures: Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name)
  };
}

function innerSplitRows(rows, splitTime, foldStart) {
  return {
    modelRows: rows.filter(row => row.exitTime < splitTime),
    validationRows: rows.filter(row => row.signalTime >= splitTime && row.exitTime < foldStart)
  };
}

module.exports = { validationSummary, validationPass, innerSplitRows };
