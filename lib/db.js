export const TABLES = Object.freeze({
  scanRuns: 'hengshi_scan_runs',
  signals: 'hengshi_signals',
  paperPositions: 'hengshi_paper_positions',
  paperTrades: 'hengshi_paper_trades'
});

function databaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server credentials are not configured');
  return { url, key };
}

async function request(table, options = {}) {
  const { url, key } = databaseConfig();
  const endpoint = new URL(`${url}/rest/v1/${table}`);
  for (const [name, value] of options.query ?? []) endpoint.searchParams.append(name, value);
  const response = await fetch(endpoint, {
    method: options.method ?? 'GET',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: options.prefer ?? 'return=representation'
    },
    body: options.body == null ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status} ${table}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

export function selectRows(table, query = []) {
  return request(table, { query: [['select', '*'], ...query], prefer: 'return=minimal' });
}

export function insertRows(table, rows, options = {}) {
  const query = [];
  if (options.onConflict) query.push(['on_conflict', options.onConflict]);
  return request(table, {
    method: 'POST',
    query,
    body: rows,
    prefer: options.ignoreDuplicates
      ? 'resolution=ignore-duplicates,return=representation'
      : 'return=representation'
  });
}

export function updateRows(table, patch, query) {
  return request(table, {
    method: 'PATCH',
    query,
    body: patch,
    prefer: 'return=representation'
  });
}

export async function claimScan(strategyVersion, barTime) {
  const iso = new Date(barTime).toISOString();
  const existing = await selectRows(TABLES.scanRuns, [
    ['strategy_version', `eq.${strategyVersion}`],
    ['bar_time', `eq.${iso}`],
    ['limit', '1']
  ]);
  if (existing[0]?.status === 'succeeded') return { claimed: false, run: existing[0] };
  if (existing[0]) {
    const [run] = await updateRows(TABLES.scanRuns, {
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null
    }, [['id', `eq.${existing[0].id}`]]);
    return { claimed: true, run };
  }
  const [run] = await insertRows(TABLES.scanRuns, [{
    strategy_version: strategyVersion,
    bar_time: iso,
    status: 'running'
  }]);
  return { claimed: true, run };
}

export function finishScan(id, patch) {
  return updateRows(TABLES.scanRuns, {
    ...patch,
    status: 'succeeded',
    finished_at: new Date().toISOString()
  }, [['id', `eq.${id}`]]);
}

export function failScan(id, error) {
  return updateRows(TABLES.scanRuns, {
    status: 'failed',
    finished_at: new Date().toISOString(),
    error: String(error?.stack || error?.message || error).slice(0, 4000)
  }, [['id', `eq.${id}`]]);
}

export function getOpenPositions(strategyVersion) {
  return selectRows(TABLES.paperPositions, [
    ['strategy_version', `eq.${strategyVersion}`],
    ['status', 'eq.open'],
    ['order', 'entry_time.asc']
  ]);
}

export function getPaperTrades(strategyVersion, limit = 10000) {
  return selectRows(TABLES.paperTrades, [
    ['strategy_version', `eq.${strategyVersion}`],
    ['order', 'exit_time.asc'],
    ['limit', String(limit)]
  ]);
}

export function getSignalsForDay(strategyVersion, dayStart, nextDay) {
  return selectRows(TABLES.signals, [
    ['strategy_version', `eq.${strategyVersion}`],
    ['signal_time', `gte.${new Date(dayStart).toISOString()}`],
    ['signal_time', `lt.${new Date(nextDay).toISOString()}`],
    ['order', 'score.desc']
  ]);
}

export async function ensureSignal(signal) {
  const existing = await selectRows(TABLES.signals, [
    ['strategy_version', `eq.${signal.strategy_version}`],
    ['symbol', `eq.${signal.symbol}`],
    ['signal_time', `eq.${signal.signal_time}`],
    ['side', `eq.${signal.side}`],
    ['limit', '1']
  ]);
  if (existing[0]) return { row: existing[0], created: false };
  const [row] = await insertRows(TABLES.signals, [signal]);
  return { row, created: true };
}

export async function ensurePosition(position) {
  const existing = await selectRows(TABLES.paperPositions, [
    ['signal_id', `eq.${position.signal_id}`],
    ['limit', '1']
  ]);
  if (existing[0]) return { row: existing[0], created: false };
  const [row] = await insertRows(TABLES.paperPositions, [position]);
  return { row, created: true };
}

export function updatePosition(id, patch) {
  return updateRows(TABLES.paperPositions, patch, [['id', `eq.${id}`]]);
}

export async function closePosition(positionId, trade, positionPatch) {
  await insertRows(TABLES.paperTrades, [trade], {
    onConflict: 'position_id',
    ignoreDuplicates: true
  });
  return updateRows(TABLES.paperPositions, {
    ...positionPatch,
    status: 'closed',
    closed_at: new Date().toISOString()
  }, [['id', `eq.${positionId}`]]);
}

export async function getDashboardData(strategyVersion) {
  const [signals, runs, positions, trades] = await Promise.all([
    selectRows(TABLES.signals, [
      ['strategy_version', `eq.${strategyVersion}`],
      ['order', 'signal_time.desc'],
      ['limit', '30']
    ]),
    selectRows(TABLES.scanRuns, [
      ['strategy_version', `eq.${strategyVersion}`],
      ['order', 'bar_time.desc'],
      ['limit', '20']
    ]),
    getOpenPositions(strategyVersion),
    getPaperTrades(strategyVersion)
  ]);
  return { signals, runs, positions, trades };
}

export function isDatabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
