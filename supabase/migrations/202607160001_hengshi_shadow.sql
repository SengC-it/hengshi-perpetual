create table if not exists public.hengshi_scan_runs (
  id uuid primary key default gen_random_uuid(),
  strategy_version text not null,
  bar_time timestamptz not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  rapid_bull boolean,
  symbols_requested integer,
  symbols_scanned integer,
  raw_candidates integer,
  qualified_candidates integer,
  signals_created integer,
  positions_closed integer,
  email_status text,
  diagnostics jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (strategy_version, bar_time)
);

create table if not exists public.hengshi_signals (
  id bigint generated always as identity primary key,
  strategy_version text not null,
  "authorization" text not null check ("authorization" = 'PAPER_ONLY'),
  live_orders_enabled boolean not null default false check (live_orders_enabled = false),
  symbol text not null,
  base_asset text not null,
  quote_asset text not null,
  layer text not null,
  family text not null check (family in ('breakout', 'reversal')),
  side smallint not null check (side in (-1, 1)),
  score double precision not null,
  signal_time timestamptz not null,
  entry_time timestamptz not null,
  entry_price double precision not null check (entry_price > 0),
  stop_price double precision not null check (stop_price > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (strategy_version, symbol, signal_time, side)
);

create table if not exists public.hengshi_paper_positions (
  id uuid primary key default gen_random_uuid(),
  signal_id bigint not null unique references public.hengshi_signals(id) on delete restrict,
  strategy_version text not null,
  symbol text not null,
  base_asset text not null,
  layer text not null,
  family text not null check (family in ('breakout', 'reversal')),
  side smallint not null check (side in (-1, 1)),
  score double precision not null,
  signal_time timestamptz not null,
  entry_time timestamptz not null,
  entry_price double precision not null check (entry_price > 0),
  qty double precision not null check (qty > 0),
  stop_price double precision not null check (stop_price > 0),
  best_price double precision not null check (best_price > 0),
  stop_atr double precision not null check (stop_atr > 0),
  trail_atr double precision,
  max_hold_bars integer not null check (max_hold_bars > 0),
  mean_exit_ema20 boolean not null default false,
  exit_next_open boolean not null default false,
  entry_fee double precision not null default 0,
  funding_pnl double precision not null default 0,
  last_processed_bar timestamptz not null,
  status text not null check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index if not exists hengshi_paper_positions_one_open_symbol
  on public.hengshi_paper_positions (strategy_version, symbol)
  where status = 'open';

create table if not exists public.hengshi_paper_trades (
  id bigint generated always as identity primary key,
  position_id uuid not null unique references public.hengshi_paper_positions(id) on delete restrict,
  signal_id bigint not null references public.hengshi_signals(id) on delete restrict,
  strategy_version text not null,
  symbol text not null,
  base_asset text not null,
  layer text not null,
  family text not null,
  side smallint not null check (side in (-1, 1)),
  signal_time timestamptz not null,
  entry_time timestamptz not null,
  exit_time timestamptz not null,
  entry_price double precision not null,
  exit_price double precision not null,
  qty double precision not null,
  notional double precision not null,
  gross_pnl double precision not null,
  fees double precision not null,
  funding_pnl double precision not null,
  net_pnl double precision not null,
  reason text not null,
  bars_held integer not null,
  created_at timestamptz not null default now()
);

create index if not exists hengshi_scan_runs_bar_time_idx
  on public.hengshi_scan_runs (bar_time desc);
create index if not exists hengshi_signals_signal_time_idx
  on public.hengshi_signals (signal_time desc);
create index if not exists hengshi_paper_trades_exit_time_idx
  on public.hengshi_paper_trades (exit_time desc);

alter table public.hengshi_scan_runs enable row level security;
alter table public.hengshi_signals enable row level security;
alter table public.hengshi_paper_positions enable row level security;
alter table public.hengshi_paper_trades enable row level security;

revoke all on table public.hengshi_scan_runs from public, anon, authenticated, service_role;
revoke all on table public.hengshi_signals from public, anon, authenticated, service_role;
revoke all on table public.hengshi_paper_positions from public, anon, authenticated, service_role;
revoke all on table public.hengshi_paper_trades from public, anon, authenticated, service_role;
revoke all on sequence public.hengshi_signals_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.hengshi_paper_trades_id_seq from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.hengshi_scan_runs to service_role;
grant select, insert, update, delete on table public.hengshi_signals to service_role;
grant select, insert, update, delete on table public.hengshi_paper_positions to service_role;
grant select, insert, update, delete on table public.hengshi_paper_trades to service_role;
grant usage, select on sequence public.hengshi_signals_id_seq to service_role;
grant usage, select on sequence public.hengshi_paper_trades_id_seq to service_role;
