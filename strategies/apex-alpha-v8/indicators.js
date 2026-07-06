/** Technical indicators aligned with TradingView ta.* helpers */

export function rma(values, length) {
  const out = new Array(values.length).fill(NaN);
  if (length <= 0 || values.length === 0) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (i < length) {
      sum += v;
      if (i === length - 1) out[i] = sum / length;
    } else {
      out[i] = (out[i - 1] * (length - 1) + v) / length;
    }
  }
  return out;
}

export function ema(values, length) {
  const out = new Array(values.length).fill(NaN);
  const alpha = 2 / (length + 1);
  let started = false;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (!started) {
      out[i] = v;
      started = true;
    } else {
      out[i] = alpha * v + (1 - alpha) * out[i - 1];
    }
  }
  return out;
}

export function sma(values, length) {
  const out = new Array(values.length).fill(NaN);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - length + 1; j <= i; j++) {
      if (!Number.isNaN(values[j])) {
        sum += values[j];
        count++;
      }
    }
    if (count === length) out[i] = sum / length;
  }
  return out;
}

export function rsi(closes, length = 14) {
  const out = new Array(closes.length).fill(NaN);
  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = diff > 0 ? diff : 0;
    losses[i] = diff < 0 ? -diff : 0;
  }

  const avgGain = rma(gains, length);
  const avgLoss = rma(losses, length);

  for (let i = 0; i < closes.length; i++) {
    if (Number.isNaN(avgGain[i]) || Number.isNaN(avgLoss[i])) continue;
    if (avgLoss[i] === 0) {
      out[i] = 100;
    } else {
      const rs = avgGain[i] / avgLoss[i];
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

export function mfi(bars, length = 14) {
  const out = new Array(bars.length).fill(NaN);
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const rawFlow = tp.map((v, i) => v * bars[i].volume);

  for (let i = length; i < bars.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - length + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) pos += rawFlow[j];
      else if (tp[j] < tp[j - 1]) neg += rawFlow[j];
    }
    if (neg === 0) out[i] = 100;
    else out[i] = 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** Pine: ta.stoch(rsi, rsi, rsi, stochLen) -> K, D */
export function stochRsiKd(closes, rsiLen = 14, stochLen = 14, kLen = 3, dLen = 3) {
  const rsiVals = rsi(closes, rsiLen);
  const stoch = new Array(closes.length).fill(NaN);

  for (let i = stochLen - 1; i < closes.length; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i - stochLen + 1; j <= i; j++) {
      if (rsiVals[j] < lo) lo = rsiVals[j];
      if (rsiVals[j] > hi) hi = rsiVals[j];
    }
    const span = hi - lo;
    stoch[i] = span === 0 ? 0 : (100 * (rsiVals[i] - lo)) / span;
  }

  const k = sma(stoch, kLen);
  const d = sma(k, dLen);
  return { k, d, rsiVals };
}

/**
 * TradingView ta.supertrend(factor, atrLen)
 * direction < 0 => bull, direction > 0 => bear
 */
export function supertrend(bars, factor, atrLen) {
  const n = bars.length;
  const st = new Array(n).fill(NaN);
  const direction = new Array(n).fill(1);

  const tr = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = bars[i].high - bars[i].low;
    } else {
      tr[i] = Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      );
    }
  }
  const atr = rma(tr, atrLen);

  const finalUpper = new Array(n).fill(NaN);
  const finalLower = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    if (Number.isNaN(atr[i])) continue;
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const basicUpper = hl2 + factor * atr[i];
    const basicLower = hl2 - factor * atr[i];

    if (i === 0) {
      finalUpper[i] = basicUpper;
      finalLower[i] = basicLower;
      direction[i] = 1;
      st[i] = finalUpper[i];
      continue;
    }

    finalUpper[i] =
      basicUpper < finalUpper[i - 1] || bars[i - 1].close > finalUpper[i - 1]
        ? basicUpper
        : finalUpper[i - 1];

    finalLower[i] =
      basicLower > finalLower[i - 1] || bars[i - 1].close < finalLower[i - 1]
        ? basicLower
        : finalLower[i - 1];

    if (direction[i - 1] === -1) {
      direction[i] = bars[i].close > finalUpper[i] ? -1 : 1;
    } else {
      direction[i] = bars[i].close < finalLower[i] ? 1 : -1;
    }

    st[i] = direction[i] < 0 ? finalLower[i] : finalUpper[i];
  }

  return { st, direction };
}

/** Daily EMA mapped to intraday bars without lookahead */
export function dailyMacroEma(bars, emaLen = 200) {
  const dayMap = new Map();
  for (const bar of bars) {
    const day = bar.time.slice(0, 10);
    dayMap.set(day, bar.close);
  }

  const days = [...dayMap.keys()].sort();
  const dailyEma = ema(days.map((d) => dayMap.get(d)), emaLen);
  const emaByDay = new Map(days.map((d, i) => [d, dailyEma[i]]));

  const result = new Array(bars.length).fill(NaN);
  for (let i = 0; i < bars.length; i++) {
    const dayIdx = days.indexOf(bars[i].time.slice(0, 10));
    result[i] = dayIdx > 0 ? emaByDay.get(days[dayIdx - 1]) : NaN;
  }
  return result;
}

export function crossover(a, b, i) {
  return a[i] > b[i] && a[i - 1] <= b[i - 1];
}

export function crossunder(a, b, i) {
  return a[i] < b[i] && a[i - 1] >= b[i - 1];
}
