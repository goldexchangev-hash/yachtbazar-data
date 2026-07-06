/**
 * Live bot hook: evaluate the latest 4H bar and return an action.
 *
 * Usage:
 *   import { createConfig, evaluateLatest, fetchHistory } from './index.js';
 *   const bars = await fetchHistory({ bars: 400 });
 *   const signal = evaluateLatest(bars, createConfig());
 *   if (signal.longSignal) { ... }
 */

import { createConfig } from "./config.js";
import { evaluateLatest } from "./signals.js";
import { fetchHistory } from "./data.js";

const cfg = createConfig({ capGodPct: 50 });
const bars = await fetchHistory({ bars: 400 });
const latest = evaluateLatest(bars, cfg);

const action = latest.longSignal
  ? {
      side: "long",
      sizePct: latest.godLong ? cfg.effectiveGodPct : cfg.basePct,
      type: latest.godLong ? "god" : "base",
    }
  : latest.shortSignal
    ? {
        side: "short",
        sizePct: latest.godShort ? cfg.effectiveGodPct : cfg.basePct,
        type: latest.godShort ? "god" : "base",
      }
    : { side: "flat" };

console.log(JSON.stringify({ time: latest.time, close: latest.close, action, stopHint: null }, null, 2));
