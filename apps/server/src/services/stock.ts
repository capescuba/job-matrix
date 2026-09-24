/**
 * Stock price for public companies, from Yahoo Finance's chart feed (no key, no AI cost).
 * Stooq's CSV feed was the first choice but now sits behind a browser check.
 */
export interface StockQuote {
  ticker: string;
  name: string | null;
  currency: string | null;
  exchange: string | null;
  price: number;
  /** Percent change over the returned history (~1 year). */
  change1yPct: number | null;
  high52: number | null;
  low52: number | null;
  asOf: string;
  /** Weekly closes for a sparkline. */
  series: { date: string; close: number }[];
  source: string;
}

interface YahooChart {
  chart?: {
    result?: {
      meta: {
        symbol: string;
        currency?: string;
        fullExchangeName?: string;
        regularMarketPrice?: number;
        regularMarketTime?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        longName?: string;
        shortName?: string;
      };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
}

export function parseYahooChart(json: YahooChart): StockQuote | null {
  const r = json.chart?.result?.[0];
  if (!r) return null;
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const series = (r.timestamp ?? [])
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((p): p is { date: string; close: number } => typeof p.close === 'number');
  const m = r.meta;
  const price = m.regularMarketPrice ?? series.at(-1)?.close;
  if (price == null) return null;
  const first = series[0]?.close;
  return {
    ticker: m.symbol,
    name: m.longName ?? m.shortName ?? null,
    currency: m.currency ?? null,
    exchange: m.fullExchangeName ?? null,
    price,
    change1yPct: first ? ((price - first) / first) * 100 : null,
    high52: m.fiftyTwoWeekHigh ?? null,
    low52: m.fiftyTwoWeekLow ?? null,
    asOf: new Date((m.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString(),
    series,
    source: 'Yahoo Finance',
  };
}

const CACHE_MS = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; quote: StockQuote | null }>();

/** Quote + ~1 year of weekly closes; null for unknown tickers. Cached for 6 hours. */
export async function getStock(
  ticker: string,
  f: typeof fetch = fetch,
): Promise<StockQuote | null> {
  const t = ticker.trim().toUpperCase();
  if (!/^[A-Z0-9.\-^]{1,12}$/.test(t)) return null;
  const hit = cache.get(t);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.quote;
  const res = await f(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1y&interval=1wk`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) },
  );
  const quote =
    res.status === 404 ? null : res.ok ? parseYahooChart((await res.json()) as YahooChart) : null;
  if (res.ok || res.status === 404) cache.set(t, { at: Date.now(), quote });
  return quote;
}
