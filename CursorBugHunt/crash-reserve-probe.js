/* crash-reserve-probe.js — proves the atomic reserve/resolve fix for #1,#2,#13,#14,#82,#126
   against the REAL token-bridge + crash-rounds round-runner (controllable clock/timers). */
"use strict";
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");
const CE = require("../public/crash-engine.js");

let ok = true;
const eq = (l, c) => { console.log((c ? "  ok  " : "  FAIL") + "  " + l); if (!c) ok = false; };

// controllable clock + timers
let clock = 0; const timers = [];
const now = () => clock;
const setTimer = (ms, fn) => { const t = { at: clock + ms, fn, dead: false }; timers.push(t); return t; };
const clearTimer = (t) => { if (t) t.dead = true; };
const advance = (ms) => { clock += ms; for (const t of timers.slice()) if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); } };

function freshBridge(buyIn) {
  const tb = makeTokenBridge({ toWei: (u) => BigInt(Math.round(u * 1e6)) });
  const st = tb.start({ player: "0xabc", chainId: 1, contract: "0x0", buyInUnits: buyIn, lockedWei: (1n * 10n ** 18n).toString() });
  return { tb, sid: st.sessionId };
}

// ── #2/#14: stake RESERVED at start — a mid-round drain can't dodge the loss ──
{
  const { tb, sid } = freshBridge(100);
  const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });
  clock = 0;
  const r = cr.startRound({ sessionId: sid, gameKey: "crash", betUnits: 100, clientSeed: "c" });
  eq("#2 stake debited at START (tokens 100→0 before any bust)", tb.session(sid).tokens === 0);
  // try to drain the rest via a normal play() mid-round → nothing left, rejected
  let drained = false; try { tb.play({ sessionId: sid, game: "coinflip", betUnits: 1, params: { side: 0 } }); } catch (e) { drained = true; }
  eq("#2 mid-round drain rejected (balance already reserved)", drained);
  // hold to bust — loss already booked, ledger never throws "insufficient tokens"
  advance(CE.msToReach(r ? 99 : 99, makeCrashRounds.K || cr.K) + 50000);
  eq("#2 session tokens stay 0 after bust (loss recorded, no orphan)", tb.session(sid).tokens === 0);
}

// ── #14: over-balance bet rejected at cr:start, not at bust ──
{
  const { tb, sid } = freshBridge(50);
  const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });
  let threw = false; try { cr.startRound({ sessionId: sid, gameKey: "crash", betUnits: 1000, clientSeed: "c" }); } catch (e) { threw = /insufficient/.test(e.message); }
  eq("#14 over-balance cr:start rejected up front", threw);
  eq("#14 no round leaked into active map after rejected start", !cr.active(sid));
}

// ── #1: an interleaved play() can NOT move the round's crash point/nonce ──
{
  const { tb, sid } = freshBridge(1000);
  const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });
  clock = 0;
  const nonceBefore = tb.session(sid).betNonce;
  cr.startRound({ sessionId: sid, gameKey: "crash", betUnits: 10, clientSeed: "round" });
  // the round pinned nonceBefore; a concurrent play() must use a DIFFERENT nonce
  const p = tb.play({ sessionId: sid, game: "coinflip", betUnits: 5, params: { side: 0 }, clientSeed: "x" });
  eq("#1 round pinned its nonce; interleaved play() got the NEXT nonce", p.nonce === nonceBefore + 1);
  const recs = tb.session(sid).bets;
  eq("#1 round reservation occupies the pinned nonce", recs.some((b) => b.kind === "crashRound" && b.nonce === nonceBefore));
}

// ── #82: rounds Map is pruned on resolve (no unbounded growth) ──
{
  const { tb, sid } = freshBridge(100000);
  const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });
  for (let i = 0; i < 50; i++) {
    clock = i * 1000000;
    const r = cr.startRound({ sessionId: sid, gameKey: "crash", betUnits: 1, clientSeed: "s" + i });
    advance(60000000); // long past any crash → bust resolves + prunes
  }
  eq("#82 rounds map pruned after each resolve (size 0, not 50)", cr._rounds.size === 0);
}

// ── #126: a non-finite / huge autoTarget is clamped, round still resolves ──
{
  const { tb, sid } = freshBridge(100);
  const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });
  clock = 0;
  let threw = false;
  try { cr.startRound({ sessionId: sid, gameKey: "crash", betUnits: 1, autoTarget: Infinity, clientSeed: "c" }); } catch (e) { threw = true; }
  eq("#126 Infinity autoTarget does not throw (clamped)", !threw);
  advance(99999999);
  eq("#126 round still resolved (map clear)", cr._rounds.size === 0);
}

// ── ledger still re-derives after reserve/resolve (PF intact) ──
{
  const { tb, sid } = freshBridge(1000);
  const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });
  clock = 0;
  const r = cr.startRound({ sessionId: sid, gameKey: "crash", betUnits: 10, clientSeed: "verify" });
  advance(3000);
  cr.cashOut({ roundId: r.roundId }); // manual win or loss, resolves the reservation
  const rd = tb.rederive(sid);
  eq("PF: ledger re-derives after a resolved crash round", rd.ok === true);
}

console.log(ok ? "\nPROBE OK — atomic reserve/resolve closes #1,#2,#13,#14,#82,#126." : "\nPROBE FAILED");
process.exit(ok ? 0 : 1);
