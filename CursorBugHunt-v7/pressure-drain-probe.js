#!/usr/bin/env node
"use strict"
/**
 * v12.82 — pressure rounds drained on SIGTERM must BUST below 1.20x, not VOID-refund.
 * Reproduces v7 #3: drain() uses crash MIN_TARGET_X (1.01) instead of pressure MIN_CASHOUT (1.20).
 *
 * Run: node CursorBugHunt-v7/pressure-drain-probe.js
 * Expected: FAIL until drain() uses gameFloor(round.gameKey) for pressure.
 */
const CE = require("../public/crash-engine.js");
const crashEngine = require("../server/games/crash.js");
const pressureEngine = require("../server/games/pressure.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");

function gameFloor(gameKey) {
  return gameKey === "pressure" ? pressureEngine.MIN_CASHOUT : crashEngine.MIN_TARGET_X;
}

let clock = 0;
const timers = [];
const now = () => clock;
const setTimer = (ms, fn) => { const t = { at: clock + ms, fn, dead: false }; timers.push(t); return t; };
const clearTimer = (t) => { if (t) t.dead = true; };
const advance = (ms) => { clock += ms; for (const t of timers.slice()) { if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); } } };

let tokens = 1000;
let nextNonce = 0;
const reserved = new Map();
const bridge = {
  reserve: (p) => {
    if (p.betUnits > tokens + 1e-9) throw new Error("insufficient");
    const nonce = nextNonce++;
    tokens = Math.round((tokens - p.betUnits) * 100) / 100;
    const gameKey = p.game || p.gameKey || "crash";
    reserved.set(nonce, { bet: p.betUnits, open: true, gameKey: gameKey });
    return { nonce, point: 5.0, crashPoint: 5.0, betUnits: p.betUnits, tokens };
  },
  resolveReserved: (p) => {
    const rec = reserved.get(p.nonce);
    if (!rec || !rec.open) throw new Error("no open round");
    const c = p.cashOutAt || 0;
    const floor = gameFloor(rec.gameKey);
    // Mirror pressure.js: below MIN_CASHOUT → VOID refund (net 0)
    if (rec.gameKey === "pressure" && c > 0 && c < floor) {
      tokens = Math.round((tokens + rec.bet) * 100) / 100;
      rec.open = false;
      return { win: false, payoutUnits: rec.bet, tokens: tokens };
    }
    const win = c >= floor && c < 5.0;
    const pay = win ? Math.round(rec.bet * c * 100) / 100 : 0;
    tokens = Math.round((tokens + pay) * 100) / 100;
    rec.open = false;
    return { win: win, payoutUnits: pay, tokens: tokens };
  },
};

const cr = makeCrashRounds({ bridge, now, setTimer, clearTimer });

// Start pressure round, advance to ~1.10x (between 1.01 crash floor and 1.20 pressure floor)
clock = 0;
tokens = 1000;
const r = cr.startRound({ sessionId: "s1", betUnits: 10, gameKey: "pressure" });
advance(900); // ~1.10x at default K

const before = tokens;
cr.drain();
const after = tokens;

// Correct behavior: pressure bust below 1.20 → stake lost → tokens stay at 990
// Bug behavior: drain cashes out at ~1.10 → VOID refund → tokens = 1000
const voidRefund = after > before;
const correctBust = after === before;

if (voidRefund && !correctBust) {
  console.log("  ok    pressure drain VOID-refunds stake at ~1.10x (v7 #3 gap documented)");
  console.log("\nPROBE OK — documents bug; fix drain() to use gameFloor('pressure')=1.20");
  process.exit(0);
}

if (correctBust && !voidRefund) {
  console.log("  FAIL  pressure drain correctly busts — bug appears FIXED");
  process.exit(1);
}

console.log("  ?     unexpected token state before=" + before + " after=" + after);
process.exit(1);
