#!/usr/bin/env node
"use strict";
/**
 * v12.56 — #5: a crashRound RESERVED on disk but never resolved (SIGKILL, no SIGTERM drain) must be
 * finalized on the next boot so it can't (a) block blackjack forever (the #1 guard) or (b) let a new
 * cr:start stack a 2nd reservation. drainOrphanReservations() busts each orphan (stake already debited).
 *
 * Run: node CursorBugHunt-v4/orphan-drain-probe.js
 */
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };

console.log("=== orphan-drain-probe (v12.56) ===\n");

// Shared persist store so a "restart" (second bridge) rehydrates the same on-disk sessions.
const store = { _state: null, load() { return this._state; }, save(s) { this._state = JSON.parse(JSON.stringify(s)); } };

const tbA = makeTokenBridge({ persist: store });
const crA = makeCrashRounds({ bridge: tbA });
const st = tbA.start({ player: "0xorphan", buyInUnits: 1000, chainId: 1, contract: "0x0" });
const sid = st.sessionId;

crA.startRound({ sessionId: sid, gameKey: "plane", betUnits: 100, clientSeed: "orphan" });
const openRec = tbA.session(sid).bets.find((b) => b && b.kind === "crashRound" && b.open);
ok("a crashRound is RESERVED + open (stake debited)", !!openRec && tbA.session(sid).tokens === 900);

// SIGKILL: the round-runner's RAM timers vanish, but the bridge persisted the open reservation.
// Model the restart by building a SECOND bridge from the same store (its crash-rounds RAM map is empty).
const tbB = makeTokenBridge({ persist: store });
const sB = tbB.session(sid);
ok("the open reservation survived the 'restart'", !!sB && sB.bets.some((b) => b && b.kind === "crashRound" && b.open));

// Before draining: blackjack is correctly BLOCKED by the #1 guard (open round present).
let blockedBefore = false;
try { tbB.applyExternal({ sessionId: sid, game: "blackjack", betUnits: 10, payoutUnits: 0 }); }
catch (e) { blockedBefore = /live crash|finish your live|crash round/i.test(String(e && e.message)); }
ok("#1 guard blocks blackjack while the orphan is still open", blockedBefore);

// Boot drain (token-http calls this at service init).
const drained = tbB.drainOrphanReservations();
ok("drainOrphanReservations finalizes the orphan (count=1)", drained === 1);
const recAfter = tbB.session(sid).bets.find((b) => b && b.kind === "crashRound");
ok("the orphan is now RESOLVED as a bust (open=false, payout=0)", recAfter && recAfter.open === false && recAfter.payoutUnits === 0);
ok("the debited stake stays booked (tokens unchanged at 900)", tbB.session(sid).tokens === 900);

// After draining: blackjack works again (no open round to block it).
let bjOk = false;
try { const r = tbB.applyExternal({ sessionId: sid, game: "blackjack", betUnits: 10, payoutUnits: 0 }); bjOk = (r && r.tokens === 890); }
catch (e) { bjOk = false; }
ok("blackjack works again after the orphan is drained", bjOk);

// The ledger still re-derives cleanly (the bust is deterministic + re-derivable).
const rd = tbB.rederive(sid);
ok("rederive() ok after the orphan bust", rd && rd.ok === true);

console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
process.exit(failed ? 1 : 0);
