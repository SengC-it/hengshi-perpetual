update public.hengshi_signals
set metadata = jsonb_set(
  metadata,
  '{exit}',
  jsonb_strip_nulls(jsonb_build_object(
    'stopAtr', case when side = -1 then 2.0 else 1.5 end,
    'trailAtr', case when side = -1 then 3.0 else null end,
    'maxHoldBars', case when side = -1 then 18 else 6 end,
    'meanExitEma20', side = 1,
    'signalAtr', abs(stop_price - entry_price) / case when side = -1 then 2.0 else 1.5 end,
    'referenceProfitPrice', case
      when side = -1 then entry_price - 3.0 * abs(stop_price - entry_price) / 2.0
      else null
    end
  )),
  true
)
where strategy_version = 'hengshi-v12.4-shadow-2026q3'
  and not (metadata ? 'exit');

insert into public.hengshi_signals (
  strategy_version,
  "authorization",
  live_orders_enabled,
  symbol,
  base_asset,
  quote_asset,
  layer,
  family,
  side,
  score,
  signal_time,
  entry_time,
  entry_price,
  stop_price,
  metadata
)
select
  'hengshi-v12.7-exit-shadow-2026q3',
  s."authorization",
  false,
  s.symbol,
  s.base_asset,
  s.quote_asset,
  s.layer,
  s.family,
  s.side,
  s.score,
  s.signal_time,
  s.entry_time,
  s.entry_price,
  s.stop_price,
  jsonb_set(
    jsonb_set(
      s.metadata,
      '{exit,maxHoldBars}',
      to_jsonb(case when s.side = -1 then 24 else 6 end),
      true
    ),
    '{comparison}',
    jsonb_build_object(
      'role', 'exit-shadow',
      'baselineStrategyVersion', s.strategy_version,
      'baselineSignalId', s.id
    ),
    true
  )
from public.hengshi_signals s
join public.hengshi_paper_positions p on p.signal_id = s.id and p.status = 'open'
where s.strategy_version = 'hengshi-v12.4-shadow-2026q3'
on conflict (strategy_version, symbol, signal_time, side) do nothing;

insert into public.hengshi_paper_positions (
  signal_id,
  strategy_version,
  symbol,
  base_asset,
  layer,
  family,
  side,
  score,
  signal_time,
  entry_time,
  entry_price,
  qty,
  stop_price,
  best_price,
  stop_atr,
  trail_atr,
  max_hold_bars,
  mean_exit_ema20,
  exit_next_open,
  entry_fee,
  funding_pnl,
  last_processed_bar,
  status
)
select
  shadow.id,
  'hengshi-v12.7-exit-shadow-2026q3',
  baseline.symbol,
  baseline.base_asset,
  baseline.layer,
  baseline.family,
  baseline.side,
  baseline.score,
  baseline.signal_time,
  baseline.entry_time,
  baseline.entry_price,
  baseline.qty,
  baseline.stop_price,
  baseline.best_price,
  baseline.stop_atr,
  baseline.trail_atr,
  case when baseline.side = -1 then 24 else baseline.max_hold_bars end,
  baseline.mean_exit_ema20,
  baseline.exit_next_open,
  baseline.entry_fee,
  baseline.funding_pnl,
  baseline.last_processed_bar,
  baseline.status
from public.hengshi_paper_positions baseline
join public.hengshi_signals source on source.id = baseline.signal_id
join public.hengshi_signals shadow
  on shadow.strategy_version = 'hengshi-v12.7-exit-shadow-2026q3'
  and shadow.symbol = source.symbol
  and shadow.signal_time = source.signal_time
  and shadow.side = source.side
where source.strategy_version = 'hengshi-v12.4-shadow-2026q3'
  and baseline.status = 'open'
on conflict (signal_id) do nothing;
