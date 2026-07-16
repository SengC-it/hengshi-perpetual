# Binance 4H Medium-Frequency System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and strictly backtest a reproducible Binance USDⓈ-M 4-hour long/short system that targets 0.5–2 new entries per day across 12 symbols.

**Architecture:** A small CommonJS Node.js project separates immutable configuration, market data, indicators, signal generation, portfolio execution, metrics, parameter selection, and final reporting. Development and validation commands cannot read the final-test date range; a frozen parameter file is required before the one-time final command runs.

**Tech Stack:** Node.js 20+, built-in `fetch`, `node:test`, CommonJS modules, CSV and JSON files, Binance USDⓈ-M REST market-data endpoints.

## Global Constraints

- Symbols: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, LINKUSDT, AVAXUSDT, DOTUSDT, LTCUSDT, BCHUSDT.
- Bar interval: 4h, timestamps and cutoffs in UTC.
- Training: 2021-02-06 through 2023-12-31; validation: 2024-01-01 through 2025-06-30; final: 2025-07-01 through 2026-07-11.
- Signal on a completed bar; fill at next bar open.
- Baseline round-trip cost 0.16%; stress cost 0.24%; funding reported separately.
- Risk per new position 0.75% equity, single-symbol notional cap 0.5x, portfolio gross cap 2x, maximum four positions and three in one direction.
- No per-symbol parameter search; exactly 16 approved parameter combinations.
- Final acceptance requires 0.5–2 new entries per calendar day and at least 200 completed trades.
- Final acceptance requires baseline profit factor at least 1.25, stress-cost profit factor at least 1.10, and positive net return.
- The 2x portfolio maximum drawdown must remain below 35%.
- At least six symbols must contribute positive net P&L and no one symbol may contribute more than 35% of total positive P&L.
- Long and short books must each remain profitable after removing their single best trade; otherwise the side-robustness criterion fails.
- Both 1x and 2x results must be reported without selecting the better leverage after seeing final results.
- The final-test command runs only after a frozen parameter file exists and writes a final-run lock file.
- The current directory is not a Git repository. Commit steps are conditional on execution inside a Git worktree.

---

## File Map

- `work/binance_medium_frequency/config.js`: symbols, dates, costs, risk limits, and 16-parameter grid.
- `work/binance_medium_frequency/indicators.js`: EMA, ATR, median, returns, and realized volatility.
- `work/binance_medium_frequency/data.js`: CSV parsing, validation, time slicing, and symbol eligibility.
- `work/binance_medium_frequency/signals.js`: BTC regime, cross-sectional scores, ranking, and pullback entries.
- `work/binance_medium_frequency/portfolio.js`: next-open fills, stops, trailing exits, funding, cooldowns, and portfolio constraints.
- `work/binance_medium_frequency/metrics.js`: equity, return, drawdown, profit factor, breadth, concentration, and acceptance checks.
- `work/binance_medium_frequency/selection.js`: development/validation scoring and frozen-parameter creation.
- `work/binance_medium_frequency/download.js`: paginated Binance Kline and funding downloads.
- `work/binance_medium_frequency/run.js`: `download`, `develop`, `freeze`, and `final` commands.
- `work/binance_medium_frequency/tests/*.test.js`: deterministic unit and integration tests.
- `work/binance_medium_frequency/data/*.csv`: downloaded 4-hour bars and funding records.
- `work/binance_medium_frequency/frozen-params.json`: immutable choice produced before final evaluation.
- `outputs/binance_futures_4h_medium_frequency_results.json`: complete results.
- `outputs/binance_futures_4h_medium_frequency_trades.csv`: final trade ledger.
- `outputs/binance_futures_4h_medium_frequency_equity.csv`: final portfolio series.
- `outputs/binance_futures_4h_medium_frequency_bundle.zip`: reproducible delivery package.

### Task 1: Configuration and Indicators

**Files:**
- Create: `work/binance_medium_frequency/config.js`
- Create: `work/binance_medium_frequency/indicators.js`
- Test: `work/binance_medium_frequency/tests/indicators.test.js`

**Interfaces:**
- Produces: `CONFIG`, `PARAMETER_GRID`, `ema(values, period)`, `atr(bars, period)`, `median(values)`, `windowReturn(values, bars)`, `realizedVol(values, bars)`.

- [ ] **Step 1: Write failing indicator and grid tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { ema, atr, median, windowReturn } = require('../indicators');
const { PARAMETER_GRID } = require('../config');

test('approved grid has exactly sixteen unique combinations', () => {
  assert.equal(PARAMETER_GRID.length, 16);
  assert.equal(new Set(PARAMETER_GRID.map(JSON.stringify)).size, 16);
});

test('indicators are deterministic and preserve warmup nulls', () => {
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.equal(median([9, 1, 5, 3]), 4);
  assert.equal(windowReturn([100, 110, 121], 2)[2], 0.21);
  const bars = [
    { h: 11, l: 9, c: 10 }, { h: 13, l: 10, c: 12 },
    { h: 14, l: 11, c: 13 }, { h: 15, l: 12, c: 14 }
  ];
  assert.equal(atr(bars, 3)[0], null);
  assert.ok(atr(bars, 3)[3] > 0);
});
```

- [ ] **Step 2: Run the test and confirm module-not-found failure**

Run: `node --test work/binance_medium_frequency/tests/indicators.test.js`

Expected: FAIL because `../indicators` and `../config` do not exist.

- [ ] **Step 3: Implement configuration and pure indicators**

```js
const SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','LTCUSDT','BCHUSDT'];
const CONFIG = Object.freeze({
  symbols: SYMBOLS,
  interval: '4h', eligibilityBars: 200,
  train: ['2021-02-06','2023-12-31'], validation: ['2024-01-01','2025-06-30'], final: ['2025-07-01','2026-07-11'],
  baseCost: 0.0016, stressCost: 0.0024, riskPerTrade: 0.0075,
  maxSymbolNotional: 0.5, maxGross: 2, maxPositions: 4, maxSameSide: 3,
  cooldownBars: 2, stopEquityFloor: 0.2
});
const PARAMETER_GRID = [40,50].flatMap(fast => [160,200].filter(slow => slow === fast * 4)
  .flatMap(slow => [72,96].flatMap(longMomentum => [1.5,2]
  .flatMap(stopAtr => [48,72].map(maxHoldHours => ({ fast, slow, shortMomentum: 24, longMomentum, stopAtr, maxHoldHours }))))));
module.exports = { CONFIG, PARAMETER_GRID };
```

Implement `ema`, `atr`, `median`, `windowReturn`, and `realizedVol` as pure array functions. EMA seeds with an SMA at index `period - 1`; ATR uses true range and Wilder smoothing; missing warmup values are `null`.

- [ ] **Step 4: Run tests**

Run: `node --test work/binance_medium_frequency/tests/indicators.test.js`

Expected: all tests PASS and grid length equals 16.

- [ ] **Step 5: Commit when Git is available**

Run: `git add work/binance_medium_frequency && git commit -m "feat: add medium-frequency indicators and configuration"`

Expected in the current projectless directory: skip with a recorded note because no Git repository exists.

### Task 2: Data Parsing, Validation, and Downloader

**Files:**
- Create: `work/binance_medium_frequency/data.js`
- Create: `work/binance_medium_frequency/download.js`
- Test: `work/binance_medium_frequency/tests/data.test.js`

**Interfaces:**
- Produces: `parseKlineCsv(text, symbol)`, `validateBars(bars)`, `sliceBars(bars, start, end)`, `isEligible(index, firstIndex, minimum)`, `downloadAll()`.

- [ ] **Step 1: Write failing tests for duplicate, gap, and eligibility handling**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKlineCsv, validateBars, isEligible } = require('../data');

test('parser rejects duplicate or non-increasing timestamps', () => {
  const csv = 'openTime,open,high,low,close,volume,closeTime\n1000,1,2,0.5,1.5,10,2000\n1000,1,2,0.5,1.5,10,2000';
  assert.throws(() => validateBars(parseKlineCsv(csv, 'BTCUSDT')), /timestamp/);
});

test('eligibility starts after two hundred completed bars', () => {
  assert.equal(isEligible(199, 0, 200), false);
  assert.equal(isEligible(200, 0, 200), true);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test work/binance_medium_frequency/tests/data.test.js`

Expected: FAIL because `../data` does not exist.

- [ ] **Step 3: Implement deterministic CSV and data validation**

`parseKlineCsv` converts numeric columns to numbers and preserves `openTime`/`closeTime` as integer milliseconds. `validateBars` rejects non-finite OHLCV, `high < max(open, close)`, `low > min(open, close)`, duplicate timestamps, and intervals not divisible by four hours. Gaps are returned as warnings rather than filled.

```js
function isEligible(index, firstIndex, minimum) { return index - firstIndex >= minimum; }
function sliceBars(bars, start, end) {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T23:59:59Z`);
  return bars.filter(b => b.openTime >= from && b.openTime <= to);
}
```

- [ ] **Step 4: Implement paginated downloads**

Use `/fapi/v1/klines` with `interval=4h`, `limit=1500`, advancing `startTime` to the last open time plus four hours. Use `/fapi/v1/fundingRate` with `limit=1000`, advancing to the last funding time plus one millisecond. Write stable CSV headers and sort records ascending before writing. Retry HTTP 429/5xx responses at 1, 2, 4, and 8 seconds; fail after four retries without writing a partial final file.

- [ ] **Step 5: Run tests and a two-page mocked pagination test**

Run: `node --test work/binance_medium_frequency/tests/data.test.js`

Expected: all tests PASS; the mock asserts the second request starts after the last timestamp from page one.

- [ ] **Step 6: Commit when Git is available**

Run: `git add work/binance_medium_frequency && git commit -m "feat: add validated Binance data ingestion"`

### Task 3: Regime, Ranking, and Entry Signals

**Files:**
- Create: `work/binance_medium_frequency/signals.js`
- Test: `work/binance_medium_frequency/tests/signals.test.js`

**Interfaces:**
- Consumes: validated aligned bars and indicator functions.
- Produces: `computeRegime(btcBars, params)`, `scoreAt(bars, index, params)`, `rankEligible(universe, index, params)`, `entryCandidates(context)`.

- [ ] **Step 1: Write failing no-lookahead and symmetry tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRegime, rankEligible, entryCandidates } = require('../signals');

test('regime at index never changes when later bars are modified', () => {
  const bars = makeTrendingBars(260);
  const before = computeRegime(bars, { fast: 50, slow: 200 })[220];
  bars[250].c *= 10;
  assert.equal(computeRegime(bars, { fast: 50, slow: 200 })[220], before);
});

test('rank ties use symbol alphabetical order', () => {
  const ranked = rankEligible([{ symbol:'ETHUSDT', score:1 }, { symbol:'BTCUSDT', score:1 }]);
  assert.deepEqual(ranked.map(x => x.symbol), ['BTCUSDT','ETHUSDT']);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test work/binance_medium_frequency/tests/signals.test.js`

Expected: FAIL because `../signals` does not exist.

- [ ] **Step 3: Implement regime and cross-sectional score**

```js
function regimeAt(close, fast, slow) {
  if (fast == null || slow == null) return 'neutral';
  if (close > slow && fast > slow) return 'bull';
  if (close < slow && fast < slow) return 'bear';
  return 'neutral';
}
function combinedScore(r24, v24, rLong, vLong) {
  if (![r24,v24,rLong,vLong].every(Number.isFinite) || v24 === 0 || vLong === 0) return null;
  return 0.5 * r24 / v24 + 0.5 * rLong / vLong;
}
```

Build long candidates only in `bull` and short candidates only in `bear`. Require top/bottom three rank, price on the correct side of EMA50, an EMA20 touch on the current or prior bar, close back across EMA20, and volume above the trailing-20-bar median. Return no candidates in neutral state.

- [ ] **Step 4: Add explicit future-bar mutation tests**

For every generated signal index, clone the dataset, replace all later OHLCV values, and assert the candidate list at that index is unchanged.

- [ ] **Step 5: Run tests and commit when available**

Run: `node --test work/binance_medium_frequency/tests/signals.test.js`

Expected: all tests PASS.

### Task 4: Portfolio Execution and Risk Engine

**Files:**
- Create: `work/binance_medium_frequency/portfolio.js`
- Test: `work/binance_medium_frequency/tests/portfolio.test.js`

**Interfaces:**
- Produces: `positionSize({equity, entry, stop, side, limits})`, `simulate({barsBySymbol, fundingBySymbol, params, leverageScale, cost})` returning `{ trades, equity, orders, warnings }`.

- [ ] **Step 1: Write failing sizing and next-open tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { positionSize, simulate } = require('../portfolio');

test('risk and notional caps both apply', () => {
  assert.equal(positionSize({ equity:10000, entry:100, stop:98, riskFraction:0.0075, notionalCap:0.5 }), 50);
  assert.equal(positionSize({ equity:10000, entry:100, stop:90, riskFraction:0.0075, notionalCap:0.5 }), 7.5);
});

test('signal fills at next bar open rather than signal close', () => {
  const result = simulate(oneSignalFixture({ signalClose:100, nextOpen:103 }));
  assert.equal(result.trades[0].entryPrice, 103);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test work/binance_medium_frequency/tests/portfolio.test.js`

Expected: FAIL because `../portfolio` does not exist.

- [ ] **Step 3: Implement sizing and portfolio constraints**

```js
function positionSize({ equity, entry, stop, riskFraction, notionalCap }) {
  const byRisk = equity * riskFraction / Math.abs(entry - stop);
  const byNotional = equity * notionalCap / entry;
  return Math.max(0, Math.min(byRisk, byNotional));
}
```

At each bar: process conservative intrabar exits, funding events, and time exits; mark equity; create candidates from the prior completed bar; sort by absolute score then symbol; enforce four total positions, three same-side positions, BTC/ETH one-per-side group, 0.5x symbol cap, and 2x gross cap; then enter at current open. New entries stop when equity is at or below 20% of initial equity.

- [ ] **Step 4: Implement conservative stop ordering**

For long positions, if bar open is below the active stop, fill at the open; otherwise fill at the stop if `low <= stop`. For shorts, use the symmetric rule. If a bar can trigger both a favorable trail update and an exit, evaluate the exit against the stop known before that bar; update the trailing stop only after surviving the bar.

- [ ] **Step 5: Add tests for gross cap, correlation group, cooldown, time exit, funding, and gap stops**

Each fixture contains fewer than 20 bars and asserts exact trade count, entry/exit price, size, fees, funding, and ending cash. Use a long and short mirror fixture to verify directional symmetry.

- [ ] **Step 6: Run tests and commit when available**

Run: `node --test work/binance_medium_frequency/tests/portfolio.test.js`

Expected: all tests PASS.

### Task 5: Metrics and Acceptance Gate

**Files:**
- Create: `work/binance_medium_frequency/metrics.js`
- Test: `work/binance_medium_frequency/tests/metrics.test.js`

**Interfaces:**
- Produces: `summarize(run)`, `acceptance(summary)`, `bySymbol(trades)`, `bySide(trades)`.

- [ ] **Step 1: Write failing metric tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, acceptance } = require('../metrics');

test('profit factor and drawdown use portfolio cash flows', () => {
  const s = summarize(metricFixture([10,-5,20,-10], [100,110,105,125,115]));
  assert.equal(s.profitFactor, 2);
  assert.equal(s.maxDrawdown, 105/110-1);
});

test('acceptance reports every failed rule', () => {
  const a = acceptance({ entriesPerDay:0.2, trades:50, profitFactor:1, stressProfitFactor:0.9, totalReturn:-0.1, maxDrawdown:-0.4, positiveSymbols:2, maxContributionShare:0.8, longRobust:false, shortRobust:false });
  assert.equal(a.pass, false);
  assert.ok(a.failures.length >= 8);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test work/binance_medium_frequency/tests/metrics.test.js`

Expected: FAIL because `../metrics` does not exist.

- [ ] **Step 3: Implement metrics and explicit acceptance checks**

Calculate portfolio total return, CAGR, annualized volatility, Sharpe without a risk-free adjustment, maximum drawdown, trade count, entries per calendar day, win rate, expectancy, profit factor, long/short results, symbol contributions, maximum contribution share, average hold, exposure, turnover, total cost, and funding. `acceptance` must return one Boolean per approved criterion plus an array of human-readable failures.

- [ ] **Step 4: Add invariants**

Assert that symbol P&L plus fees plus funding reconciles to portfolio P&L within `1e-8`, equity timestamps are strictly increasing, exposure never exceeds configured caps, and all accepted metrics are finite.

- [ ] **Step 5: Run tests and commit when available**

Run: `node --test work/binance_medium_frequency/tests/metrics.test.js`

Expected: all tests PASS.

### Task 6: Parameter Selection and Final-Test Lock

**Files:**
- Create: `work/binance_medium_frequency/selection.js`
- Create: `work/binance_medium_frequency/tests/selection.test.js`

**Interfaces:**
- Produces: `evaluateDevelopment(grid, data)`, `chooseParameter(rows)`, `freezeParameter(row, path)`, `assertFinalAllowed(lockPath, frozenPath)`.

- [ ] **Step 1: Write failing selection and lock tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseParameter, assertFinalAllowed } = require('../selection');

test('selection uses validation median score, not highest training return', () => {
  const chosen = chooseParameter([
    { id:'overfit', medianValidationPf:0.9, validationReturn:0.5, validationDd:-0.5, frequencyPass:true },
    { id:'robust', medianValidationPf:1.3, validationReturn:0.2, validationDd:-0.2, frequencyPass:true }
  ]);
  assert.equal(chosen.id, 'robust');
});

test('second final run is rejected', () => {
  assert.throws(() => assertFinalAllowed('fixture/final.lock','fixture/frozen.json'), /already run/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test work/binance_medium_frequency/tests/selection.test.js`

Expected: FAIL because `../selection` does not exist.

- [ ] **Step 3: Implement development evaluation**

Run all 16 combinations only on training and validation dates. Rank eligible rows by: frequency pass first; median validation profit factor descending; validation return descending; absolute validation drawdown ascending; serialized parameter JSON ascending. Save all 16 rows so rejected candidates remain auditable.

- [ ] **Step 4: Implement immutable freeze and one-time final lock**

`freezeParameter` writes selected parameters, selection metrics, data hashes, UTC creation time, and specification path. It refuses to overwrite an existing file. `assertFinalAllowed` requires the frozen file and rejects an existing `final-run.lock`. The final command creates the lock with frozen-file SHA-256 before reading final-period bars.

- [ ] **Step 5: Run tests and commit when available**

Run: `node --test work/binance_medium_frequency/tests/selection.test.js`

Expected: all tests PASS.

### Task 7: CLI, Full Verification, and Final Artifacts

**Files:**
- Create: `work/binance_medium_frequency/run.js`
- Create: `work/binance_medium_frequency/README.md`
- Create: `work/binance_medium_frequency/tests/integration.test.js`
- Create after final run: `outputs/binance_futures_4h_medium_frequency_results.json`
- Create after final run: `outputs/binance_futures_4h_medium_frequency_trades.csv`
- Create after final run: `outputs/binance_futures_4h_medium_frequency_equity.csv`
- Create after final run: `outputs/binance_futures_4h_medium_frequency_bundle.zip`

**Interfaces:**
- Commands: `node run.js download`, `node run.js develop`, `node run.js freeze`, `node run.js final`.

- [ ] **Step 1: Write a failing end-to-end fixture test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPipeline } = require('../run');

test('fixture pipeline freezes before final and writes reconciled outputs', async () => {
  const result = await runPipeline({ dataDir:'tests/fixtures', outputDir:'tests/tmp', allowFinal:true });
  assert.equal(result.selection.candidates, 16);
  assert.equal(result.final.acceptance.failures.length >= 0, true);
  assert.equal(result.reconciliation.pass, true);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test work/binance_medium_frequency/tests/integration.test.js`

Expected: FAIL because `../run` does not exist.

- [ ] **Step 3: Implement command routing**

`download` retrieves and validates data without running strategies. `develop` reads only training and validation slices and writes the 16-candidate comparison. `freeze` selects one candidate and creates `frozen-params.json`. `final` checks the lock, runs the frozen candidate at 1x and 2x with baseline/stress costs, runs approved ablations, evaluates acceptance, and writes JSON/CSV outputs.

- [ ] **Step 4: Run all tests before downloading**

Run: `node --test work/binance_medium_frequency/tests/*.test.js`

Expected: all unit and integration tests PASS.

- [ ] **Step 5: Download and validate source data**

Run: `node work/binance_medium_frequency/run.js download`

Expected: 12 Kline CSVs, funding CSVs or an explicit funding-access warning, strictly increasing timestamps, no duplicate bars, and SHA-256 hashes in `data-manifest.json`.

- [ ] **Step 6: Run development and inspect all candidates**

Run: `node work/binance_medium_frequency/run.js develop`

Expected: `development-results.json` contains exactly 16 candidates, no date later than 2025-06-30, and no final-period metric.

- [ ] **Step 7: Freeze the selected parameter**

Run: `node work/binance_medium_frequency/run.js freeze`

Expected: a new `frozen-params.json`; rerunning the command exits non-zero and does not overwrite it.

- [ ] **Step 8: Run the final test once**

Run: `node work/binance_medium_frequency/run.js final`

Expected: final-run lock plus 1x/2x baseline/stress results, ablations, trade ledger, equity series, acceptance pass/fail, and explicit funding treatment. A second run exits non-zero.

- [ ] **Step 9: Independently validate headline calculations**

Run a separate read-only Node command that recomputes total return, maximum drawdown, profit factor, trade count, entries per day, symbol breadth, and maximum contribution share from the saved trade/equity CSVs; compare every value with the JSON at tolerance `1e-8`.

- [ ] **Step 10: Build and inspect the report and bundle**

Create one reader-facing Data Analytics report containing the direct pass/fail conclusion, architecture comparison, equity/drawdown chart, monthly returns, long/short and by-symbol contribution, signal frequency, cost sensitivity, and limitations. Package source, tests, data manifest, frozen parameters, final lock, outputs, specification, implementation plan, and README. List the ZIP contents and verify all expected files before delivery.

- [ ] **Step 11: Commit when Git is available**

Run: `git add work/binance_medium_frequency outputs docs/superpowers && git commit -m "feat: add validated Binance 4h medium-frequency backtest"`

Expected in the current projectless directory: skip with a recorded note because no Git repository exists.

## Completion Evidence

The implementation is complete only when all tests pass, data hashes are recorded, exactly one frozen parameter exists, the final lock prevents reruns, independent calculations reconcile, the acceptance gate reports every criterion, and the report clearly states either “passes the approved research gate” or “no deployable edge found.”
