import { EXIT_SHADOW, STRATEGY } from '../config/strategy.js';
import { fetchMarkPrices } from '../lib/binance.js';
import { getDashboardData, isDatabaseConfigured } from '../lib/db.js';
import { buildSignalPnlRows } from '../lib/pnl.js';

function metrics(trades) {
  const pnl = trades.map(row => Number(row.net_pnl));
  const wins = pnl.filter(value => value > 0);
  const losses = pnl.filter(value => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = losses.reduce((sum, value) => sum + value, 0);
  let equity = STRATEGY.portfolio.initialEquity;
  let peak = equity;
  let maxDrawdown = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return {
    trades: trades.length,
    netPnl: pnl.reduce((sum, value) => sum + value, 0),
    totalReturn: equity / STRATEGY.portfolio.initialEquity - 1,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    maxDrawdown
  };
}

export default async function handler(_request, response) {
  response.setHeader('cache-control', 'no-store');
  if (!isDatabaseConfigured()) {
    return response.status(503).json({
      ok: false,
      status: 'awaiting_supabase_configuration',
      strategy: STRATEGY.version,
      liveOrdersEnabled: false
    });
  }
  try {
    const [data, exitShadowData] = await Promise.all([
      getDashboardData(STRATEGY.version),
      EXIT_SHADOW.enabled ? getDashboardData(EXIT_SHADOW.version) : Promise.resolve(null)
    ]);
    let markPrices = new Map();
    let markPriceStatus = 'not_needed';
    if (data.positions.length) {
      try {
        markPrices = await fetchMarkPrices(data.positions.map(position => position.symbol));
        markPriceStatus = markPrices.size === data.positions.length ? 'live' : 'partial';
      } catch (error) {
        markPriceStatus = 'unavailable';
      }
    }
    return response.status(200).json({
      ok: true,
      strategy: {
        name: STRATEGY.name,
        version: STRATEGY.version,
        authorization: STRATEGY.authorization,
        liveOrdersEnabled: false,
        validFrom: new Date(STRATEGY.validFrom).toISOString(),
        validThrough: new Date(STRATEGY.validThrough).toISOString(),
        causalSelection: true
      },
      summary: metrics(data.trades),
      exitComparison: {
        baseline: {
          version: STRATEGY.version,
          maxShortHoldBars: STRATEGY.short.exit.maxHoldBars,
          summary: metrics(data.trades),
          openPositions: data.positions.length
        },
        candidate: exitShadowData && {
          version: EXIT_SHADOW.version,
          maxShortHoldBars: EXIT_SHADOW.short.maxHoldBars,
          summary: metrics(exitShadowData.trades),
          openPositions: exitShadowData.positions.length
        }
      },
      signals: data.signals,
      runs: data.runs,
      openPositions: data.positions,
      recentTrades: data.trades.slice(-30).reverse(),
      signalPnl: buildSignalPnlRows(data.trades, data.positions, markPrices),
      markPriceStatus
    });
  } catch (error) {
    return response.status(500).json({ ok: false, error: error.message, liveOrdersEnabled: false });
  }
}
