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

/** Coinbase Exchange candles fallback — aggregates 1h bars into 4h. */
export async function fetchCoinbaseHistory({
  product = "ETH-USD",
  bars = 3000,
}) {
  const granularity = 3600;
  const hourly = [];
  let before;

  while (hourly.length < bars * 4 + 4) {
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

    hourly.unshift(...batch);
    before = raw.at(-1)[0];
    if (raw.length < 300) break;
  }

  const fourHour = [];
  for (let i = 0; i + 3 < hourly.length; i += 4) {
    const chunk = hourly.slice(i, i + 4);
    fourHour.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[3].close,
      volume: chunk.reduce((s, b) => s + b.volume, 0),
    });
  }

  return fourHour.slice(-bars);
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
