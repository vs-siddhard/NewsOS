export interface TickerItem {
  symbol: string;
  price: number;
  changePercent: number;
}

export interface TickerResponse {
  ok: boolean;
  source: string | null;
  retrievedAt: string;
  items: TickerItem[];
  error?: string;
}

const BINANCE_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT',
  'XRPUSDT', 'DOTUSDT', 'LINKUSDT', 'AVAXUSDT',
  'DOGEUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT',
];

const COINGECKO_MAP: ReadonlyArray<{ id: string; symbol: string }> = [
  { id: 'bitcoin', symbol: 'BTC' },
  { id: 'ethereum', symbol: 'ETH' },
  { id: 'binancecoin', symbol: 'BNB' },
  { id: 'solana', symbol: 'SOL' },
  { id: 'cardano', symbol: 'ADA' },
  { id: 'ripple', symbol: 'XRP' },
  { id: 'polkadot', symbol: 'DOT' },
  { id: 'chainlink', symbol: 'LINK' },
  { id: 'avalanche-2', symbol: 'AVAX' },
  { id: 'dogecoin', symbol: 'DOGE' },
  { id: 'litecoin', symbol: 'LTC' },
  { id: 'uniswap', symbol: 'UNI' },
  { id: 'cosmos', symbol: 'ATOM' },
];

const CACHE_TTL_MS = 30 * 1000;
let cachedTicker: { data: TickerResponse; expiresAt: number } | null = null;

async function fetchFromBinance(): Promise<TickerItem[]> {
  const url = `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(BINANCE_SYMBOLS))}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{
    symbol?: string;
    lastPrice?: string;
    priceChangePercent?: string;
  }>;
  return rows
    .filter((r) => r.symbol && r.lastPrice != null)
    .map((r) => ({
      symbol: r.symbol!.replace(/USDT$/, ''),
      price: Number.parseFloat(r.lastPrice!),
      changePercent: Number.parseFloat(r.priceChangePercent ?? '0'),
    }))
    .filter((r) => Number.isFinite(r.price) && Number.isFinite(r.changePercent));
}

async function fetchFromCoinGecko(): Promise<TickerItem[]> {
  const ids = COINGECKO_MAP.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const payload = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
  const items: TickerItem[] = [];
  for (const entry of COINGECKO_MAP) {
    const row = payload[entry.id];
    if (row && typeof row.usd === 'number' && Number.isFinite(row.usd)) {
      items.push({
        symbol: entry.symbol,
        price: row.usd,
        changePercent: typeof row.usd_24h_change === 'number' && Number.isFinite(row.usd_24h_change) ? row.usd_24h_change : 0,
      });
    }
  }
  return items;
}

export async function getLiveTicker(): Promise<TickerResponse> {
  if (cachedTicker && Date.now() < cachedTicker.expiresAt) {
    return cachedTicker.data;
  }

  const retrievedAt = new Date().toISOString();

  try {
    const items = await fetchFromBinance();
    if (items.length > 0) {
      const data: TickerResponse = { ok: true, source: 'Binance Market Data', retrievedAt, items };
      cachedTicker = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    }
  } catch {
    // Fall through to secondary public provider
  }

  try {
    const items = await fetchFromCoinGecko();
    if (items.length > 0) {
      const data: TickerResponse = { ok: true, source: 'CoinGecko', retrievedAt, items };
      cachedTicker = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    }
  } catch {
    // Fall through to cached or honest unavailable state
  }

  if (cachedTicker?.data.items.length) {
    return cachedTicker.data;
  }

  return {
    ok: false,
    source: null,
    retrievedAt,
    items: [],
    error: 'Market ticker temporarily unavailable',
  };
}
