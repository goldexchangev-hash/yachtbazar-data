#!/usr/bin/env node
/**
 * Run Apex Alpha v8 backtest from Binance or CSV.
 *
 * Examples:
 *   node run-backtest.js
 *   node run-backtest.js --bars 4000
 *   node run-backtest.js --csv ./ethusdt_4h.csv
 *   node run-backtest.js --god-cap 50 --slippage 0.1
 */

import { createConfig } from "./config.js";
import { runBacktest, formatSummary } from "./backtest.js";
import { fetchHistory, loadCsv } from "./data.js";

function parseArgs(argv) {
  const opts = {
    symbol: "ETHUSDT",
    interval: "4h",
    bars: 3000,
    csv: null,
    godCap: 50,
    slippage: 0.05,
    commission: 0.1,
    trades: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--csv") opts.csv = argv[++i];
    else if (arg === "--symbol") opts.symbol = argv[++i];
    else if (arg === "--interval") opts.interval = argv[++i];
    else if (arg === "--bars") opts.bars = parseInt(argv[++i], 10);
    else if (arg === "--god-cap") opts.godCap = parseFloat(argv[++i]);
    else if (arg === "--slippage") opts.slippage = parseFloat(argv[++i]);
    else if (arg === "--commission") opts.commission = parseFloat(argv[++i]);
    else if (arg === "--trades") opts.trades = true;
    else if (arg === "--help") {
      console.log(`Usage: node run-backtest.js [options]
  --csv <path>       Load OHLCV CSV instead of Binance
  --symbol ETHUSDT   Binance symbol
  --interval 4h      Binance interval
  --bars 3000        Number of bars to fetch
  --god-cap 50       Cap God trade size %
  --slippage 0.05    Slippage %
  --commission 0.1   Commission %
  --trades           Print completed trades`);
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);
const cfg = createConfig({
  capGodPct: opts.godCap,
  slippagePct: opts.slippage,
  commissionPct: opts.commission,
});

console.log("Apex Alpha v8 — JavaScript backtest");
console.log(`Config: god cap=${cfg.effectiveGodPct}%, slip=${cfg.slippagePct}%, fee=${cfg.commissionPct}%\n`);

const bars = opts.csv
  ? await loadCsv(opts.csv)
  : await fetchHistory({
      symbol: opts.symbol,
      interval: opts.interval,
      bars: opts.bars,
    });

console.log(`Loaded ${bars.length} bars (${bars[0]?.time} → ${bars.at(-1)?.time})\n`);

const result = runBacktest(bars, cfg);
console.log(formatSummary(result));

if (opts.trades) {
  console.log("\nCompleted trades:");
  for (const t of result.trades.filter((x) => x.pnl !== null)) {
    console.log(
      `${t.entryTime} → ${t.exitTime} | ${t.side.toUpperCase()} ${t.type} | ` +
        `entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} pnl=${t.pnl.toFixed(2)} (${t.reason})`
    );
  }
}
