const FUTURES_API = 'https://fapi.binance.com';
const FOUR_HOURS = 4 * 60 * 60 * 1000;

function requestTimeout() {
  const parsed = Number(process.env.BINANCE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 15000;
}

export async function fetchJson(path, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 3;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(`${FUTURES_API}${path}`, {
        headers: { 'user-agent': 'hengshi-perpetual/0.1 paper-only' },
        signal: AbortSignal.timeout(requestTimeout())
      });
      if (response.ok) return await response.json();
      const body = (await response.text()).slice(0, 300);
      const error = new Error(`Binance ${response.status}: ${body}`);
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 300 * 2 ** attempt;
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError ?? new Error(`Binance request failed: ${path}`);
}

export function parseKline(values) {
  return {
    openTime: Number(values[0]),
    open: Number(values[1]),
    high: Number(values[2]),
    low: Number(values[3]),
    close: Number(values[4]),
    volume: Number(values[5]),
    closeTime: Number(values[6]),
    quoteVolume: Number(values[7]),
    trades: Number(values[8]),
    takerBuyQuoteVolume: Number(values[10])
  };
}

export function parsePremiumKline(values) {
  return {
    openTime: Number(values[0]),
    close: Number(values[4]),
    closeTime: Number(values[6])
  };
}

export async function listTradingPerpetuals(options = {}) {
  const exchange = await fetchJson('/fapi/v1/exchangeInfo', options);
  return exchange.symbols
    .filter(row => row.contractType === 'PERPETUAL' && row.status === 'TRADING')
    .map(row => ({
      symbol: row.symbol,
      baseAsset: row.baseAsset,
      quoteAsset: row.quoteAsset
    }));
}

export async function fetchMarketSeries(symbol, options = {}) {
  const includePremium = options.includePremium ?? true;
  const limit = options.limit ?? 240;
  const encoded = encodeURIComponent(symbol);
  const requests = [
    fetchJson(`/fapi/v1/klines?symbol=${encoded}&interval=4h&limit=${limit}`, options)
  ];
  if (includePremium) {
    requests.push(fetchJson(`/fapi/v1/premiumIndexKlines?symbol=${encoded}&interval=4h&limit=${limit}`, options));
  }
  const [klines, premiumKlines = []] = await Promise.all(requests);
  return {
    symbol,
    bars: klines.map(parseKline),
    premiums: premiumKlines.map(parsePremiumKline)
  };
}

function latestRatio(rows, field = 'longShortRatio') {
  const value = Number(rows?.at(-1)?.[field]);
  return Number.isFinite(value) ? value : null;
}

export async function fetchPositionMetrics(symbol, options = {}) {
  const encoded = encodeURIComponent(symbol);
  const [openInterest, topPosition, topAccount, account, taker] = await Promise.all([
    fetchJson(`/futures/data/openInterestHist?symbol=${encoded}&period=4h&limit=7`, options),
    fetchJson(`/futures/data/topLongShortPositionRatio?symbol=${encoded}&period=4h&limit=2`, options),
    fetchJson(`/futures/data/topLongShortAccountRatio?symbol=${encoded}&period=4h&limit=2`, options),
    fetchJson(`/futures/data/globalLongShortAccountRatio?symbol=${encoded}&period=4h&limit=2`, options),
    fetchJson(`/futures/data/takerlongshortRatio?symbol=${encoded}&period=4h&limit=2`, options)
  ]);
  const firstOpenInterest = Number(openInterest?.[0]?.sumOpenInterestValue);
  const lastOpenInterest = Number(openInterest?.at(-1)?.sumOpenInterestValue);
  return {
    openInterestValue: Number.isFinite(lastOpenInterest) ? lastOpenInterest : null,
    oiChange24h: firstOpenInterest > 0 && Number.isFinite(lastOpenInterest)
      ? lastOpenInterest / firstOpenInterest - 1
      : null,
    topTraderPositionRatio: latestRatio(topPosition),
    topTraderAccountRatio: latestRatio(topAccount),
    accountRatio: latestRatio(account),
    takerRatio: latestRatio(taker, 'buySellRatio')
  };
}

export async function fetchFundingRates(symbol, startTime, endTime, options = {}) {
  if (!(endTime > startTime)) return [];
  const encoded = encodeURIComponent(symbol);
  const rows = await fetchJson(
    `/fapi/v1/fundingRate?symbol=${encoded}&startTime=${Math.trunc(startTime)}&endTime=${Math.trunc(endTime)}&limit=1000`,
    options
  );
  return rows.map(row => ({
    time: Number(row.fundingTime),
    rate: Number(row.fundingRate)
  })).filter(row => Number.isFinite(row.time) && Number.isFinite(row.rate));
}

export async function mapLimit(items, limit, mapper) {
  const output = Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return output;
}

export { FOUR_HOURS };
