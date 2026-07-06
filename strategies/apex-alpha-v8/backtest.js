import { buildSignalSeries } from "./signals.js";

/**
 * @typedef {import('./signals.js').Bar} Bar
 * @typedef {import('./config.js').DEFAULT_CONFIG & { effectiveGodPct: number }} Config
 */

function applySlippage(price, side, slippagePct, isEntry) {
  const mult = slippagePct / 100;
  if (side === "long") {
    return isEntry ? price * (1 + mult) : price * (1 - mult);
  }
  return isEntry ? price * (1 - mult) : price * (1 + mult);
}

function commission(notional, commissionPct) {
  return notional * (commissionPct / 100);
}

function longExitLevels(entry, cfg) {
  return {
    hardStop: entry * (1 - cfg.slPct / 100),
    activation: entry * (1 + cfg.trailPct / 100),
    trailDistance: entry * (cfg.trailOffsetPct / 100),
  };
}

function shortExitLevels(entry, cfg) {
  return {
    hardStop: entry * (1 + cfg.slPct / 100),
    activation: entry * (1 - cfg.trailPct / 100),
    trailDistance: entry * (cfg.trailOffsetPct / 100),
  };
}

function checkLongStop(bar, state) {
  const { hardStop, activation, trailDistance } = state.exit;
  let stop = hardStop;

  if (bar.high >= activation) {
    state.peak = Math.max(state.peak ?? bar.high, bar.high);
    stop = Math.max(hardStop, state.peak - trailDistance);
  }

  state.activeStop = stop;
  return bar.low <= stop;
}

function checkShortStop(bar, state) {
  const { hardStop, activation, trailDistance } = state.exit;
  let stop = hardStop;

  if (bar.low <= activation) {
    state.trough = Math.min(state.trough ?? bar.low, bar.low);
    stop = Math.min(hardStop, state.trough + trailDistance);
  }

  state.activeStop = stop;
  return bar.high >= stop;
}

function markEquity(cash, position, entryPrice, price) {
  if (position === 0) return cash;
  const qty = Math.abs(position);
  if (position > 0) return cash + qty * price;
  return cash + qty * (entryPrice - price);
}

function closePosition({ position, entryPrice, entryType, entryTime, price, row, cfg, reason }) {
  const side = position > 0 ? "long" : "short";
  const qty = Math.abs(position);
  const exitPx = applySlippage(price, side, cfg.slippagePct, false);
  const notional = qty * exitPx;
  const fee = commission(notional, cfg.commissionPct);
  const pnl =
    side === "long"
      ? qty * (exitPx - entryPrice) - fee
      : qty * (entryPrice - exitPx) - fee;
  const cashDelta = side === "long" ? notional - fee : -(notional + fee);

  return {
    trade: {
      side,
      type: entryType,
      entryTime,
      exitTime: row.time,
      entryPrice,
      exitPrice: exitPx,
      qty,
      pnl,
      reason,
    },
    cashDelta,
  };
}

/**
 * Bar-by-bar backtest matching Apex Alpha v8 Pine behavior.
 * @param {Bar[]} bars
 * @param {Config} cfg
 */
export function runBacktest(bars, cfg) {
  const series = buildSignalSeries(bars, cfg);

  let cash = cfg.initialCapital;
  let position = 0;
  let entryPrice = 0;
  let entryType = "";
  let entryTime = "";
  let lastEntryBar = -1e9;
  /** @type {null | object} */
  let exitState = null;

  const trades = [];
  const equityCurve = [];

  for (const row of series) {
    const i = row.index;
    const price = row.close;

    if (position !== 0 && exitState) {
      const stopBar = { high: row.high, low: row.low };
      const stopped =
        exitState.side === "long"
          ? checkLongStop(stopBar, exitState)
          : checkShortStop(stopBar, exitState);

      if (stopped) {
        const { trade, cashDelta } = closePosition({
          position,
          entryPrice,
          entryType,
          entryTime,
          price: exitState.activeStop,
          row,
          cfg,
          reason: "stop/trail",
        });
        cash += cashDelta;
        trades.push(trade);
        position = 0;
        exitState = null;
      }
    }

    const flat = position === 0;
    const cooldownOk = cfg.cooldownBars === 0 || i - lastEntryBar >= cfg.cooldownBars;
    const canOpenLong =
      row.longSignal && cooldownOk && (flat || (cfg.allowReverse && position < 0));
    const canOpenShort =
      row.shortSignal && cooldownOk && (flat || (cfg.allowReverse && position > 0));

    if (canOpenLong) {
      if (position < 0) {
        const closed = closePosition({
          position,
          entryPrice,
          entryType,
          entryTime,
          price,
          row,
          cfg,
          reason: "flip",
        });
        cash += closed.cashDelta;
        trades.push(closed.trade);
        position = 0;
        exitState = null;
      }

      if (position === 0) {
        const isGod = row.godLong;
        const pct = isGod ? cfg.effectiveGodPct : cfg.basePct;
        entryType = isGod ? `GOD ${cfg.effectiveGodPct}%` : `BASE ${cfg.basePct}%`;
        const entryPx = applySlippage(price, "long", cfg.slippagePct, true);
        const qty = (markEquity(cash, 0, 0, price) * (pct / 100)) / entryPx;
        const notional = qty * entryPx;
        const fee = commission(notional, cfg.commissionPct);
        cash -= notional + fee;
        position = qty;
        entryPrice = entryPx;
        entryTime = row.time;
        exitState = {
          side: "long",
          exit: longExitLevels(entryPx, cfg),
          activeStop: entryPx * (1 - cfg.slPct / 100),
        };
        lastEntryBar = i;
      }
    } else if (canOpenShort) {
      if (position > 0) {
        const closed = closePosition({
          position,
          entryPrice,
          entryType,
          entryTime,
          price,
          row,
          cfg,
          reason: "flip",
        });
        cash += closed.cashDelta;
        trades.push(closed.trade);
        position = 0;
        exitState = null;
      }

      if (position === 0) {
        const isGod = row.godShort;
        const pct = isGod ? cfg.effectiveGodPct : cfg.basePct;
        entryType = isGod ? `GOD ${cfg.effectiveGodPct}%` : `BASE ${cfg.basePct}%`;
        const entryPx = applySlippage(price, "short", cfg.slippagePct, true);
        const qty = (markEquity(cash, 0, 0, price) * (pct / 100)) / entryPx;
        const notional = qty * entryPx;
        const fee = commission(notional, cfg.commissionPct);
        cash += notional - fee;
        position = -qty;
        entryPrice = entryPx;
        entryTime = row.time;
        exitState = {
          side: "short",
          exit: shortExitLevels(entryPx, cfg),
          activeStop: entryPx * (1 + cfg.slPct / 100),
        };
        lastEntryBar = i;
      }
    }

    equityCurve.push({
      time: row.time,
      equity: markEquity(cash, position, entryPrice, price),
      position,
    });
  }

  const completed = trades.filter((t) => t.pnl !== null);
  const wins = completed.filter((t) => t.pnl > 0);
  const losses = completed.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const finalEquity = equityCurve.at(-1)?.equity ?? cfg.initialCapital;

  let peak = cfg.initialCapital;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak);
  }

  return {
    summary: {
      initialCapital: cfg.initialCapital,
      finalEquity,
      netPnl: finalEquity - cfg.initialCapital,
      totalTrades: completed.length,
      winRate: completed.length ? wins.length / completed.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      maxDrawdownPct: maxDrawdown * 100,
    },
    trades,
    equityCurve,
  };
}

export function formatSummary(result) {
  const s = result.summary;
  return [
    `Initial capital : $${s.initialCapital.toLocaleString()}`,
    `Final equity    : $${s.finalEquity.toFixed(2)}`,
    `Net PnL         : $${s.netPnl.toFixed(2)}`,
    `Total trades    : ${s.totalTrades}`,
    `Win rate        : ${(s.winRate * 100).toFixed(1)}%`,
    `Profit factor   : ${s.profitFactor?.toFixed(2) ?? "n/a"}`,
    `Max drawdown    : ${s.maxDrawdownPct.toFixed(2)}%`,
  ].join("\n");
}
