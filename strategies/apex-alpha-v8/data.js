/**
 * Fetch Binance klines and normalize to bar objects.
 * @param {object} opts
 * @param {string} [opts.symbol='ETHUSDT']
 * @param {string} [opts.interval='4h']
 * @param {number} [opts.limit=1000]
 * @param {number} [opts.startTime] - ms timestamp
 */
export async function fetchBinanceKlines({
  symbol = "ETHUSDT",
  interval = "4h",
  limit = 1000,
  startTime,
}) {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(Math.min(limit, 1000)),
  });
  if (startTime) params.set("startTime", String(startTime));

  const url = `https://api.binance.com/api/v3/klines?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status} ${await res.text()}`);

  /** @type {Array<[number, string, string, string, string, string]>} */
  const raw = await res.json();
  return raw.map((k) => ({
    time: new Date(k[0]).toISOString(),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/** Paginate Binance history (1000 bars per request). */
export async function fetchBinanceHistory({
  symbol = "ETHUSDT",
  interval = "4h",
  bars = 3000,
}) {
  const all = [];
  let startTime;

  while (all.length < bars) {
    const batch = await fetchBinanceKlines({
      symbol,
      interval,
      limit: Math.min(1000, bars - all.length),
      startTime,
    });
    if (batch.length === 0) break;

    if (all.length > 0 && batch[0].time === all.at(-1).time) {
      batch.shift();
    }
    if (batch.length === 0) break;

    all.push(...batch);
    const lastOpen = new Date(batch.at(-1).time).getTime();
    startTime = lastOpen + 1;

    if (batch.length < 1000) break;
  }

  return all.slice(0, bars);
}

/** Coinbase Pro/Exchange candles fallback (4h = 14400 seconds). */
export async function fetchCoinbaseHistory({
  product = "ETH-USD",
  bars = 3000,
}) {
  const granularity = 14400;
  const all = [];
  let before;

  while (all.length < bars) {
    const params = new URLSearchParams({ granularity: String(granularity) });
    if (before) params.set("before", String(before));
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase API error: ${res.status}`);

    /** @type {Array<[number, number, number, number, number, number]>} */
    const raw = await res.json();
    if (!raw.length) break;

    const batch = raw
      .map(([time, low, high, open, close, volume]) => ({
        time: new Date(time * 1000).toISOString(),
        open,
        high,
        low,
        close,
        volume,
      }))
      .reverse();

    all.unshift(...batch);
    before = raw.at(-1)[0];
    if (raw.length < 300) break;
  }

  return all.slice(-bars);
}

/** Try Binance first, fall back to Coinbase. */
export async function fetchHistory(opts = {}) {
  try {
    return await fetchBinanceHistory(opts);
  } catch {
    return fetchCoinbaseHistory({
      product: "ETH-USD",
      bars: opts.bars ?? 3000,
    });
  }
}

/** Load OHLCV from CSV: time,open,high,low,close,volume */
export async function loadCsv(path) {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].toLowerCase();

  const startIdx = header.includes("time") || header.includes("open") ? 1 : 0;
  return lines.slice(startIdx).map((line) => {
    const [time, open, high, low, close, volume] = line.split(",");
    return {
      time: time.includes("T") ? time : new Date(time).toISOString(),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    };
  });
}
