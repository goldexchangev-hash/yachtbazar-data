#!/usr/bin/env node
"use strict";
/**
 * v12.46 crash reserve model probe — tests the REAL makeTokenBridge() integration.
 * Legacy CursorBugHunt/repro-crash-nonce-desync.js uses pointPeek+play and is obsolete.
 *
 * Run from repo root: node CursorBugHunt-v2/crash-reserve-probe.js
 */
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");
const crashEngine = require("../server/games/crash.js");

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };
const fail = (label, msg) => { console.log("  FAIL  " + label + (msg ? " — " + msg : "")); failed++; };

let clock = 0;
const timers = [];
const now = () => clock;
const setTimer = (ms, fn) => { const t = { at: clock + ms, fn, dead: false }; timers.push(t); return t; };
const clearTimer = (t) => { if (t) t.dead = true; };
const advance = (ms) => { clock += ms; for (const t of timers.slice()) { if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); } } };

console.log("=== crash-reserve-probe (v12.46 real bridge) ===\n");

const tb = makeTokenBridge({});
ok("bridge.reserve is a function", typeof tb.reserve === "function");
ok("bridge.resolveReserved is a function", typeof tb.resolveReserved === "function");

if (typeof tb.reserve !== "function") {
  console.log("\nBLOCKER: token-bridge.js does not export reserve/resolveReserved.");
  console.log("crash-rounds.js calls bridge.reserve() at startRound — all token crash-family rounds fail.");
  process.exit(1);
}

const st = tb.start({ player: "0xabc", buyInUnits: 1000, chainId: 1, contract: "0x0" });
const sid = st.sessionId;
const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });

// Find clientSeed where nonce 0 vs 1 diverge
let seed = null;
for (let i = 0; i < 50000; i++) {
  const cs = "probe-" + i;
  const a = crashEngine.crashPointOf(tb.session(sid).serverSeed, cs, 0);
  const b = crashEngine.crashPointOf(tb.session(sid).serverSeed, cs, 1);
  if (Math.abs(a - b) > 0.5) { seed = cs; break; }
}
if (!seed) { console.log("skip  could not find divergent nonce pair"); process.exit(2); }

clock = 0;
const nonceBefore = tb.session(sid).betNonce;
const tokensBefore = tb.session(sid).tokens;

let round;
try {
  round = cr.startRound({ sessionId: sid, betUnits: 10, clientSeed: seed, gameKey: "plane" });
} catch (e) {
  fail("startRound succeeds", e.message);
  process.exit(1);
}

const nonceAfterStart = tb.session(sid).betNonce;
const tokensAfterStart = tb.session(sid).tokens;
const activeRound = cr._rounds.get(round.roundId);

ok("reserve burns nonce at start (0→1)", nonceAfterStart === nonceBefore + 1);
ok("reserve debits stake at start", Math.abs(tokensAfterStart - (tokensBefore - 10)) < 1e-9);
ok("round stores pinned nonce", activeRound && activeRound.nonce === nonceBefore);

// Interleaved instant play uses NEXT nonce — must not change round's crash point
const inter = tb.play({ sessionId: sid, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "interleave" });
ok("interleaved play uses different nonce", inter.nonce === nonceAfterStart);

advance(500);
const result = cr.cashOut({ roundId: round.roundId });
const planeBet = tb.session(sid).bets.find((b) => b.nonce === nonceBefore && (b.game === "plane" || b.kind === "reserved"));

ok("settlement uses pinned nonce", planeBet && planeBet.nonce === nonceBefore);
if (activeRound && result) {
  const ledgerPoint = planeBet && planeBet.outcome && planeBet.outcome.crashPoint;
  ok("paced crashPoint matches ledger", ledgerPoint != null && Math.abs(ledgerPoint - activeRound.crashPoint) < 0.01);
}

// Balance check at start
const st2 = tb.start({ player: "0xdef", buyInUnits: 5, chainId: 1, contract: "0x0" });
const cr2 = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });
let overbet = false;
try { cr2.startRound({ sessionId: st2.sessionId, betUnits: 100, clientSeed: "x", gameKey: "crash" }); } catch (e) { overbet = true; }
ok("over-balance bet rejected at cr:start", overbet);

console.log(failed ? "\nPROBE FAILED (" + failed + ")" : "\nPROBE OK — reserve model verified on real bridge");
process.exit(failed ? 1 : 0);
