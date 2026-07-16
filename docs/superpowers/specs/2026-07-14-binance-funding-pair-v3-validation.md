# Binance USD-M Funding Pair V3 Validation

## Objective

Test a new structural return source after V1 through V2.1 price-signal systems failed. V3 is a dollar-neutral cross-sectional funding carry pair: long the symbol with the lowest trailing funding rate and short the symbol with the highest trailing funding rate.

## Signal and execution

- Use the mean of the latest three realized funding events.
- Candidate thresholds, selected only on 2021-2023 training data: 0.05% or 0.10% cross-sectional spread.
- Candidate maximum holding times: 72 or 168 hours.
- Enter at the next 4-hour bar open after the funding event.
- Hold one equal-notional pair at a time with 1x total gross exposure.
- Stop the pair when marked loss including realized funding and entry fees reaches 3% of entry equity.
- Include realized funding, both legs' price P&L, and both legs' trading costs.

## Selection discipline

The four candidates were evaluated only on 2021-02-06 through 2023-12-31. The candidate with the highest median training-quarter stress-cost profit factor was frozen before loading the 2024-01-01 through 2025-06-30 validation data.

The frozen candidate uses a 0.05% three-event funding spread and 168-hour maximum hold.

## Training result

Stress-cost training return is +296.46% with PF 1.543, but maximum drawdown is -43.38%, only 41.7% of training quarters are positive, and P&L after removing the best five trades is -79,403 USDT. Funding income is 42,003 USDT versus 68,508 USDT fees; the apparent profit comes primarily from 322,968 USDT relative price P&L, especially in 2021.

## Validation result

The frozen strategy fails the 2024-2025 validation:

- 25 trades, 0.046 entries per day.
- Base: -6.66% return, PF 0.845, -24.47% drawdown.
- Stress: -8.35% return, PF 0.808, -24.89% drawdown.
- Extreme: -10.19% return, PF 0.769, -25.46% drawdown.
- Stress decomposition: -7,835 USDT relative price P&L, +5,332 USDT funding, and -5,848 USDT fees.
- Three of six quarters are positive.
- Weekly-block bootstrap probability of positive P&L is 31.3%.
- P&L after removing the best five trades is -35,967 USDT.

## Exposed diagnostic

The 2025-07-01 through 2026-07-11 diagnostic period has only nine trades. Stress return is +7.95% with PF 1.426, but 9,506 USDT price P&L dominates 778 USDT funding income, one pair contributes more than 70% of positive P&L, and removing the five best trades leaves -16,614 USDT.

## Decision

Reject V3 for deployment. The funding spread has statistical persistence, but this implementation does not isolate it economically: trading costs and unhedged relative price exposure dominate realized funding carry.
