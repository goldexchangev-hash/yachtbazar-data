#!/usr/bin/env node
"use strict";
/**
 * Reproduce crash-rounds nonce desync: pointPeek at startRound uses betNonce N,
 * but if another play() runs before _resolve(), settlement uses N+1 with a
 * potentially different crash point.
 *
 * Run from repo root: node CursorBugHunt/repro-crash-nonce-desync.js
 */
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");
const crashEngine = require("../server/games/crash.js");

let clock = 0;
const timers = [];
const now = () => clock;
const setTimer = (ms, fn) => { const t = { at: clock + ms, fn, dead: false }; timers.push(t); return t; };
const clearTimer = (t) => { if (t) t.dead = true; };
const advance = (ms) => { clock += ms; for (const t of timers.slice()) { if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); } } };

const tb = makeTokenBridge({});
const st = tb.start({ player: "0xabc", buyInUnits: 1000, chainId: 1, contract: "0x0" });
const sid = st.sessionId;

const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });

let seed = null;
let p0 = null, p1 = null;
for (let i = 0; i < 50000; i++) {
  const cs = "probe-" + i;
  const a = crashEngine.crashPointOf(tb.session(sid).serverSeed, cs, 0);
  const b = crashEngine.crashPointOf(tb.session(sid).serverSeed, cs, 1);
  if (Math.abs(a - b) > 0.5) { seed = cs; p0 = a; p1 = b; break; }
}
if (!seed) {
  console.log("Could not find divergent nonce pair in 50k probes.");
  process.exit(2);
}

console.log("Found clientSeed:", seed);
console.log("  crashPoint @ nonce 0:", p0.toFixed(2) + "x");
console.log("  crashPoint @ nonce 1:", p1.toFixed(2) + "x");

clock = 0;
const peekAtStart = tb.pointPeek({ sessionId: sid, clientSeed: seed, game: "plane" });
console.log("\nAt startRound peek (nonce " + peekAtStart.nonce + "): point =", peekAtStart.point.toFixed(2) + "x");

const r = cr.startRound({ sessionId: sid, betUnits: 10, clientSeed: seed, gameKey: "plane" });
console.log("Round started, paced crashPoint =", cr._rounds.get(r.roundId).crashPoint.toFixed(2) + "x");
console.log("betNonce after start (should still be 0):", tb.session(sid).betNonce);

const inter = tb.play({ sessionId: sid, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "interleave" });
console.log("\nInterleaved coinflip at nonce", inter.nonce, "→ betNonce now", tb.session(sid).betNonce);

advance(1000);
const result = cr.cashOut({ roundId: r.roundId });
console.log("\nCash-out result:");
console.log("  paced crashPoint (round):", result.crashPoint.toFixed(2) + "x");
console.log("  settlement used nonce:", tb.session(sid).bets[tb.session(sid).bets.length - 1].nonce);
console.log("  win:", result.win, " payout:", result.payoutUnits);

const settledCrash = tb.session(sid).bets.find((b) => b.game === "plane");
const actualCrash = settledCrash && settledCrash.outcome && settledCrash.outcome.crashPoint;

console.log("\n--- DESYNC CHECK ---");
console.log("Peek/paced point (nonce 0):", peekAtStart.point.toFixed(2) + "x");
console.log("Ledger crashPoint (nonce " + (settledCrash && settledCrash.nonce) + "):", actualCrash != null ? actualCrash.toFixed(2) + "x" : "N/A");

const desync = Math.abs(peekAtStart.point - (actualCrash || 0)) > 0.01;
const wrongNonce = settledCrash && settledCrash.nonce !== peekAtStart.nonce;

if (desync || wrongNonce) {
  console.log("\nBUG REPRODUCED: pacing used nonce", peekAtStart.nonce, "but settlement used nonce", settledCrash && settledCrash.nonce);
  console.log("Player saw bust at", peekAtStart.point.toFixed(2) + "x but ledger settled with", (actualCrash || 0).toFixed(2) + "x");
  process.exit(1);
}
console.log("\nNo desync in this run (points happened to match).");
process.exit(0);
