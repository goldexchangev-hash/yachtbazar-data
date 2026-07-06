import {
  dailyMacroEma,
  ema,
  mfi,
  stochRsiKd,
  supertrend,
  rsi,
  crossover,
  crossunder,
} from "./indicators.js";

/**
 * @typedef {{ time: string, open: number, high: number, low: number, close: number, volume: number }} Bar
 * @typedef {import('./config.js').DEFAULT_CONFIG & { effectiveGodPct: number }} Config
 */

/**
 * Compute indicators + entry signals for each bar.
 * @param {Bar[]} bars
 * @param {Config} cfg
 */
export function buildSignalSeries(bars, cfg) {
  const closes = bars.map((b) => b.close);
  const macroEma = dailyMacroEma(bars, cfg.macroEmaLen);
  const ema150 = ema(closes, cfg.emaLen);
  const { st, direction } = supertrend(bars, cfg.factor, cfg.atrLen);
  const { k, d } = stochRsiKd(closes, cfg.rsiLen, cfg.stochLen, cfg.kLen, cfg.dLen);
  const mfiVals = mfi(bars, cfg.mfiLen);
  const rsiMain = rsi(closes, 14);

  const series = bars.map((bar, i) => {
    const macroBull = closes[i] > macroEma[i];
    const stBull = direction[i] < 0;
    const stBear = direction[i] > 0;

    const macroOkLong = cfg.useMacroFilter ? macroBull : true;
    const macroOkShort = cfg.useMacroFilter ? !macroBull : true;
    const trendOkLong = cfg.useEmaFilter ? closes[i] > ema150[i] : true;
    const trendOkShort = cfg.useEmaFilter ? closes[i] < ema150[i] : true;
    const rsiOkLong = cfg.useRsiFilter ? rsiMain[i] < cfg.rsiOkLevel : true;
    const rsiOkShort = cfg.useRsiFilter ? rsiMain[i] > cfg.rsiOkShortLevel : true;

    const baseLong =
      stBull &&
      i > 0 &&
      crossover(k, d, i) &&
      k[i] < cfg.overSold &&
      trendOkLong &&
      rsiOkLong &&
      macroOkLong;

    const baseShort =
      stBear &&
      i > 0 &&
      crossunder(k, d, i) &&
      k[i] > cfg.overBought &&
      trendOkShort &&
      rsiOkShort &&
      macroOkShort;

    const godLong = cfg.useMfiGod && baseLong && mfiVals[i] > cfg.mfiStrong;
    const godShort = cfg.useMfiGod && baseShort && mfiVals[i] < 100 - cfg.mfiStrong;

    return {
      ...bar,
      index: i,
      macroEma: macroEma[i],
      ema150: ema150[i],
      st: st[i],
      stDir: direction[i],
      k: k[i],
      d: d[i],
      mfi: mfiVals[i],
      rsiMain: rsiMain[i],
      baseLong,
      baseShort,
      godLong,
      godShort,
      longSignal: godLong || baseLong,
      shortSignal: godShort || baseShort,
    };
  });

  return series;
}

/**
 * Evaluate a single bar for live bot use (needs recent history).
 * @param {Bar[]} bars - full history ending at current bar
 * @param {Config} cfg
 */
export function evaluateLatest(bars, cfg) {
  const series = buildSignalSeries(bars, cfg);
  return series[series.length - 1];
}
