#!/usr/bin/env node
"use strict";
/**
 * v12.55 — verifyRederive must replay kind:"crashRound" ledger entries (plane/crash WS path).
 *
 * Run: node CursorBugHunt-v4/verify-rederive-crash-probe.js
 */
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };

console.log("=== verify-rederive-crash-probe (v12.55) ===\n");

const tb = makeTokenBridge({});
const cr = makeCrashRounds({ bridge: tb });
const st = tb.start({ player: "0xprobe", buyInUnits: 1000, chainId: 1, contract: "0x0" });
const sid = st.sessionId;

const started = cr.startRound({ sessionId: sid, gameKey: "crash", betUnits: 10, clientSeed: "rd-probe" });
const sMid = tb.session(sid);
const openBet = sMid.bets.find((b) => b && b.kind === "crashRound" && b.open);
ok("open crashRound entry exists mid-round", !!openBet);

const midVerify = tb.verifyRederive({
  commit: sMid.commit,
  revealedSeed: sMid.serverSeed,
  orderedBets: sMid.bets,
  buyInUnits: sMid.buyInUnits,
  claimedFinalTokens: sMid.tokens,
});
ok("verifyRederive FAILS on open crashRound (needs cashOutAt params)", midVerify.ok === false);

const round = cr.active(sid);
cr.cashOut({ roundId: round.id });

const s = tb.session(sid);
const hasCrashRoundBet = s.bets.some((b) => b && b.kind === "crashRound");
ok("ledger contains crashRound entry", hasCrashRoundBet);

const rd = tb.rederive(sid);
ok("rederive() ok after WS crash round", rd && rd.ok === true);

console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
process.exit(failed ? 1 : 0);
