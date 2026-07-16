# Binance USD-M 4h Medium-Frequency V2 Validation

## Objective

Test whether the V1 long-side observation survives a simpler, lower-risk, cost-stressed system without using signal frequency as the optimization target.

## Evidence boundary

V2 was motivated by V1 validation and final-period diagnostics. Therefore, no existing historical interval is a clean new holdout. The 2024-01-01 through 2025-06-30 interval is used for retrospective rolling robustness; 2025-07-01 through 2026-07-11 is explicitly labeled an exposed diagnostic interval. Confirmatory evidence must come from forward data after 2026-07-14.

## Candidate grid

- Fixed EMA regime: 50/200.
- Fixed momentum horizons: 24/96 hours.
- Side modes: long-only; long plus strictly gated shorts.
- Initial stop: 1.5 or 2.0 ATR.
- Maximum hold: 72 or 96 hours.
- Total: 8 candidates.

Strict shorts require a BTC bear regime, falling BTC EMA50, at least 65% of eligible symbols below EMA50, and negative 24/96-hour absolute momentum for the candidate.

## Risk and costs

- Approximate risk per trade: 0.5% of equity.
- Maximum gross exposure: approximately 1.33x.
- Base round-trip cost: 0.16%.
- Stress round-trip cost: 0.24%.
- Extreme round-trip cost: 0.32%.
- Historical funding is included when available.

## Selection and acceptance

Candidates are ranked by median quarterly stress-cost profit factor, then positive-quarter share, aggregate stress profit factor, stress return, and drawdown. The historical gate requires at least 150 trades, base PF at least 1.30, stress PF at least 1.15, extreme PF at least 1.00, positive stress return, drawdown better than -25%, at least 62.5% positive quarters, breadth and concentration limits, positive profit after removing the five best trades, and at least 70% positive weekly-block bootstrap samples.

## Result

The selected candidate is long-only, 1.5 ATR stop, and 96-hour maximum hold. It fails the historical gate: base return -11.21% with PF 0.851; stress return -14.82% with PF 0.806; only 33.3% of quarters are positive; weekly-block bootstrap probability of positive P&L is 13.3%; and P&L after removing the five best trades is -27,952 USDT.

The exposed diagnostic interval is positive but concentrated in 2025 Q3 and fails the diagnostic gate. V2 is rejected for deployment.
