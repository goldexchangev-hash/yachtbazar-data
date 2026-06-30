#!/usr/bin/env node
"use strict"
/**
 * v12.55 — BJ token debits must refuse while a server-paced crash round is live
 * (mirror of v3 #1 / crash-bj-interleave-probe.js, inverse direction).
 *
 * Run: node CursorBugHunt-v4/crash-bj-inverse-probe.js
 */
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };
const fail = (label, msg) => { console.log("  FAIL  " + label + (msg ? " — " + msg : "")); failed++; };

console.log("=== crash-bj-inverse-probe (v12.55) ===\n");

const tb = makeTokenBridge({});
const cr = makeCrashRounds({ bridge: tb });
const st = tb.start({ player: "0xabc", buyInUnits: 1000, chainId: 1, contract: "0x0" });
const sid = st.sessionId;

cr.startRound({ sessionId: sid, gameKey: "plane", betUnits: 100, clientSeed: "probe" });
const before = tb.session(sid).betNonce;
let interleaved = false;
try {
  tb.applyExternal({ sessionId: sid, game: "blackjack", betUnits: 50, payoutUnits: 0, ref: "probe:bet" });
  interleaved = tb.session(sid).betNonce > before;
} catch (e) {
  if (/live crash|finish your live|crash round/i.test(String(e && e.message))) {
    ok("BJ debit blocked during live crash round", true);
  } else {
    fail("BJ debit blocked during live crash round", (e && e.message) || "unexpected throw");
  }
}

if (interleaved) {
  fail("BJ debit blocked during live crash round", "applyExternal succeeded — nonce " + before + "→" + tb.session(sid).betNonce);
}
ok("crash round still live", cr.hasActive(sid));

console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
process.exit(failed ? 1 : 0);
