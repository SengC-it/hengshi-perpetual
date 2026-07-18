-- V12.7 is a per-signal exit experiment. Its 96-hour holding period can overlap
-- a later V12.4 signal for the same symbol, so only that paper-only version is
-- excluded from the portfolio's one-open-position-per-symbol constraint.
drop index if exists public.hengshi_paper_positions_one_open_symbol;

create unique index hengshi_paper_positions_one_open_symbol
  on public.hengshi_paper_positions (strategy_version, symbol)
  where status = 'open'
    and strategy_version <> 'hengshi-v12.7-exit-shadow-2026q3';
