# Binance USD-M 4h Medium-Frequency V2.1 Validation

## Hypothesis

V2.1 tests one incremental hypothesis: long entries should be allowed only when the market is synchronized. BTC must be in the existing 50/200 EMA bull regime, BTC EMA50 must be rising over the prior 24 hours, at least 65% of eligible symbols must trade above EMA50, and the candidate must have positive 24-hour and 96-hour absolute momentum.

Short entries remain disabled. The four candidates vary only the initial stop (1.5 or 2.0 ATR) and maximum holding time (72 or 96 hours).

## Execution correction

Entries remain at the next 4-hour bar open after the signal close. V2.1 conservatively evaluates whether the stop was touched during that same entry bar. ATR-normalized maximum favorable excursion (MFE) and maximum adverse excursion (MAE) are recorded for every trade.

## Evidence boundary

The hypothesis was informed by V1 and V2 results. The 2021-02-06 through 2023-12-31 training interval, 2024-01-01 through 2025-06-30 retrospective validation interval, and 2025-07-01 through 2026-07-11 diagnostic interval are all exposed. None is a clean confirmatory holdout.

## Selected research candidate

- Strict long-only synchronization.
- 1.5 ATR initial stop.
- 72-hour maximum hold.
- Approximate risk per trade: 0.5%.
- Approximate maximum gross exposure: 1.33x.

## Result

All four candidates lose money in the 2021-2023 training interval. The selected candidate returns -4.87% with PF 0.898 in training.

In retrospective 2024-2025 validation, the selected candidate has 143 trades and 0.261 entries per day. Base-cost return is +0.50% with PF 1.014 and -5.93% drawdown. Stress-cost return is -1.33% with PF 0.962 and -6.98% drawdown. Extreme-cost return is -3.13% with PF 0.914. Three of six quarters are positive, weekly-block bootstrap probability of positive P&L is 44.0%, and stress-cost P&L after removing the five best trades is -15,100 USDT.

The exposed diagnostic interval is positive but concentrated in 2025 Q3. Stress-cost return is +5.98% with PF 1.429, but only one of four complete quarters is positive and P&L after removing the five best trades is -6,968 USDT.

Validation losers have median MFE 0.76 ATR and median MAE 1.63 ATR. Only 34.8% of losers have full-trade MFE below 0.5 ATR, so the evidence does not support applying a simple no-follow-through exit without a separate time-indexed excursion study.

V2.1 fails the deployment gate and is rejected for live trading.
