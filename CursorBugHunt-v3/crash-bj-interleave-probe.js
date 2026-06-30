#!/usr/bin/env node
"use strict";
/**
 * v12.50 — cr:start (WS) must refuse while player has live blackjack hand (#1).
 * HTTP doPlay is guarded; WS start() was not (Pass 6 finding).
 *
 * Run: node CursorBugHunt-v3/crash-bj-interleave-probe.js
 */
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");
const { makeCrashWs } = require("../server/crash-rounds-ws.js");

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };
const fail = (label, msg) => { console.log("  FAIL  " + label + (msg ? " — " + msg : "")); failed++; };

console.log("=== crash-bj-interleave-probe (v12.50) ===\n");

const tb = makeTokenBridge({});
const st = tb.start({ player: "0xabc", buyInUnits: 1000, chainId: 1, contract: "0x0" });
const sid = st.sessionId;
const token = "test-bearer";
const verifySession = (id, t) => (id === sid && t === token ? tb.session(sid) : null);

let liveBj = true;
const cr = makeCrashRounds({ bridge: tb });
const ws = makeCrashWs({
  bridge: tb,
  verifySession,
  liveExternal: (player) => liveBj && player === "0xabc",
});

// Minimal fake socket. The real defaultSend() does ws.send(JSON.stringify(obj)) — the wire
// is a STRING, not an object (see crash-rounds-ws.js:48 and its own self-test stub at :163).
// Parse it the same way so we actually read the cr:error the gate emits.
const sock = { readyState: 1, _crRounds: new Set(), send: () => {} };
let errMsg = null;
sock.send = (raw) => {
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
  if (obj && obj.type === "cr:error") errMsg = obj.message || obj.code;
};

ws.handle(sock, {
  type: "cr:start",
  sessionId: sid,
  sessionToken: token,
  betUnits: 100,
  gameKey: "plane",
  clientSeed: "probe",
});

if (errMsg && /blackjack|live hand|finish your/i.test(errMsg)) {
  ok("cr:start blocked during live BJ hand", true);
} else if (!errMsg && tb.session(sid).betNonce > 0) {
  fail("cr:start blocked during live BJ hand", "round started — reserve burned nonce");
} else {
  fail("cr:start blocked during live BJ hand", errMsg || "no error, no round");
}

liveBj = false;
errMsg = null;
ws.handle(sock, {
  type: "cr:start",
  sessionId: sid,
  sessionToken: token,
  betUnits: 10,
  gameKey: "plane",
  clientSeed: "probe2",
});

ok("cr:start allowed after BJ hand ends", !errMsg || !/blackjack|live hand/i.test(errMsg));

console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
process.exit(failed ? 1 : 0);
