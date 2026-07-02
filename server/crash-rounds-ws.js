/* ============================================================
   crash-rounds-ws.js — the "cr:*" WebSocket sub-protocol for token crash rounds.

   This is the transport that connects the (tested) server-paced round-runner
   (crash-rounds.js) to the game screens, mirroring how blackjack uses the "bj:*"
   sub-protocol on the same socket. It owns NOTHING about money/fairness — the
   round-runner + token bridge do that. It just:
     • authorizes a player (reusing the HTTP bridge's per-session bearer token),
     • starts/cashes-out rounds, and
     • pushes the reveal to the right socket when a round settles.

   ── WIRE FORMAT ─────────────────────────────────────────────────────────────
   Client → server:
     { type:"cr:start",   sessionId, sessionToken, gameKey, betUnits, autoTarget?, clientSeed? }
                                         autoTarget absent/0  ⇒  MANUAL (the DEFAULT)
     { type:"cr:cashout", roundId }      manual tap — settle at the server multiplier
     { type:"cr:ping" }                  liveness probe
   Server → client:
     { type:"cr:started", roundId, startedAt, k, gameKey, bet, autoTarget, serverNow }
                                         animate e^(k·elapsed); crashPoint is NOT sent
     { type:"cr:result",  roundId, busted, win, cashOutAt, crashPoint, payoutUnits, tokens, ... }
                                         busted ⇒ show explosion at crashPoint; else win
     { type:"cr:error",   code, message, roundId? }
     { type:"cr:pong" }

   The crash point is revealed ONLY inside cr:result (i.e. at settle). The client
   animates the climb locally from startedAt + k; if it busts, the server timer fires
   cr:result and the client snaps to the revealed crashPoint. Because the client's
   local clock can only lag the server (never lead, after network latency), a manual
   tap is always validated against the SERVER multiplier — the player can't claim a
   stale-low value, and can't out-run the bust.

   ── EDIT MAP ────────────────────────────────────────────────────────────────
   • CRASH_GAMES                — which channels run on the live round-runner.
   • make…/onResolve            — single place every settlement is pushed from.
   • verifySession (injected)   — the auth gate (token-http.js exposes it).
   ============================================================ */
"use strict";

const { makeCrashRounds } = require("./crash-rounds.js");

// Channels that play through the server-paced round-runner (rising-curve / tap-to-cash-out).
// Add a key here to route a new crash-family channel onto it. plane/swoop/pressure all
// settle through the "crash" engine in the bridge (aliased), so the math is identical.
const CRASH_GAMES = { crash: 1, plane: 1, swoop: 1, pressure: 1 };

function defaultSend(ws, obj) {
  try { if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj)); } catch (e) {}
}

function makeCrashWs(opts) {
  opts = opts || {};
  const verifySession = typeof opts.verifySession === "function" ? opts.verifySession : function () { return null; };
  // liveExternal(player) → true if the player has a LIVE blackjack hand funded by their token session.
  // Injected by server.js (→ blackjack.hasLiveHand). cr:start must refuse while it's true: the HTTP
  // doPlay/doTopUp guards already do, but without this the WS start would reserve+debit a crash stake
  // mid-hand, draining the frozen funding pool the hand needs → applyExternal throws → hand stuck (v3 #1).
  const liveExternal = typeof opts.liveExternal === "function" ? opts.liveExternal : function () { return false; };
  const send = typeof opts.send === "function" ? opts.send : defaultSend;
  const nowOf = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };
  const wsByRound = new Map(); // roundId -> ws to push the result to (null once the socket drops)

  // One round-runner for all crash-family channels. onResolve is the SINGLE exit point:
  // every settlement (manual cash-out, timer bust, auto-target) lands here and is pushed
  // to the owning socket. EDIT here to also broadcast/log every result.
  const rounds = makeCrashRounds({
    bridge: opts.bridge,
    now: opts.now,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
    onResolve: function (out) {
      const ws = wsByRound.get(out.roundId);
      wsByRound.delete(out.roundId);
      if (ws && ws._crRounds) ws._crRounds.delete(out.roundId); // v6 #18: prune the per-socket ownership Set too — else it grows for the life of the socket (onClose was the only reaper)
      if (ws) send(ws, Object.assign({ type: "cr:result" }, out));
    },
  });

  function handle(ws, data) {
    const t = data && data.type;
    if (t === "cr:ping") { send(ws, { type: "cr:pong" }); return; }
    if (t === "cr:start") { start(ws, data); return; }
    if (t === "cr:resume") { resume(ws, data); return; } // #94: re-bind a reconnecting socket to its live round
    if (t === "cr:cashout") { cashout(ws, data); return; }
    // any other cr:* — ignore quietly (forward-compat for new message types)
  }

  function start(ws, data) {
    const sess = verifySession(data && data.sessionId, data && data.sessionToken);
    if (!sess) { send(ws, { type: "cr:error", code: "auth", message: "buy in with tokens first" }); return; }
    // v3 #1: refuse a crash round while this player has a LIVE blackjack hand on the same token session —
    // reserving the crash stake would drain the hand's frozen funding pool (mirrors the HTTP doPlay guard).
    if (liveExternal(sess.player)) { send(ws, { type: "cr:error", code: "live", message: "finish your blackjack hand before starting a round" }); return; }
    // v4 #6: cap the clientSeed BEFORE startRound — an unbounded seed is HMAC'd synchronously (provablyfair),
    // so a multi-MB seed is a CPU-DoS per message (the WS rate limit slows the flood but doesn't bound payload
    // size). A real seed is well under 256 chars.
    if (data && data.clientSeed != null && String(data.clientSeed).length > 256) { send(ws, { type: "cr:error", code: "seed", message: "client seed is too long" }); return; }
    const gameKey = (data && CRASH_GAMES[data.gameKey]) ? data.gameKey : "crash";
    try {
      const r = rounds.startRound({
        sessionId: sess.id,
        gameKey: gameKey,
        betUnits: data && data.betUnits,
        autoTarget: data && data.autoTarget,  // 0 / absent ⇒ MANUAL (the default)
        clientSeed: data && data.clientSeed,
      });
      wsByRound.set(r.roundId, ws);
      (ws._crRounds || (ws._crRounds = new Set())).add(r.roundId); // remember ownership for onClose
      send(ws, {
        type: "cr:started", roundId: r.roundId, startedAt: r.startedAt, k: r.k,
        gameKey: r.gameKey, bet: r.bet, autoTarget: r.autoTarget, serverNow: nowOf(),
      });
    } catch (e) {
      send(ws, { type: "cr:error", code: "start", message: (e && e.message) || "could not start round" });
    }
  }

  function cashout(ws, data) {
    const roundId = data && data.roundId;
    // v4 #15: a missing roundId is a malformed message, not a crashed round — give a clear validation error
    // instead of the misleading "already crashed" (which the undefined-lookup below would otherwise produce).
    if (!roundId) { send(ws, { type: "cr:error", code: "validation", message: "roundId is required", roundId: roundId }); return; }
    const owner = wsByRound.get(roundId);
    // gone from the map (undefined) ⇒ already settled — busted or cashed out a moment ago.
    if (owner === undefined) { send(ws, { type: "cr:error", code: "cashout", message: "already crashed", roundId: roundId }); return; }
    // present but a different socket ⇒ not yours.
    if (owner !== ws) { send(ws, { type: "cr:error", code: "owner", message: "not your round", roundId: roundId }); return; }
    try {
      rounds.cashOut({ roundId: roundId }); // result is pushed via onResolve (one settlement path)
    } catch (e) {
      send(ws, { type: "cr:error", code: "cashout", message: (e && e.message) || "already crashed", roundId: roundId });
    }
  }

  // #94 RESUME: a reconnecting client (mobile app-switch / network blip) re-binds to its session's STILL-LIVE
  // round instead of silently riding it to a bust. onClose (below) keeps the round alive + detaches the dead
  // socket; this re-points the push target to the new socket and replays cr:started so the client resumes the
  // animation from startedAt. crashPoint is never leaked (liveView omits it); cashOut stays server-clock-validated
  // (m ≤ crashPoint), so a resumed tap can never pay above the crash and can't double-settle. Auth-gated like cr:start.
  function resume(ws, data) {
    const sess = verifySession(data && data.sessionId, data && data.sessionToken);
    if (!sess) { send(ws, { type: "cr:error", code: "auth", message: "buy in with tokens first" }); return; }
    const v = rounds.liveView ? rounds.liveView(sess.id) : null;
    if (!v) { send(ws, { type: "cr:noround" }); return; } // nothing live to resume (already settled while offline / none)
    wsByRound.set(v.roundId, ws);
    (ws._crRounds || (ws._crRounds = new Set())).add(v.roundId);
    send(ws, {
      type: "cr:started", roundId: v.roundId, startedAt: v.startedAt, k: v.k,
      gameKey: v.gameKey, bet: v.bet, autoTarget: v.autoTarget, serverNow: nowOf(), resumed: true,
    });
  }

  // A dropped socket can't cash out — the server timer still fires and settles the bet
  // into the ledger (the player simply doesn't see the reveal). Just detach the dead
  // socket so onResolve never tries to send to it.
  function onClose(ws) {
    if (ws && ws._crRounds) for (const id of ws._crRounds) { if (wsByRound.get(id) === ws) wsByRound.set(id, null); }
  }

  // Passthroughs for the token-http liveness guard (hasActiveRound) and graceful-shutdown drain (#3/#141).
  function hasActiveRound(sessionId) { return rounds.hasActive ? rounds.hasActive(sessionId) : false; }
  // RECOVER SELF-HEAL passthrough: retire a RAM round that can no longer be genuinely live (its bridge
  // session is closed/gone → resolveReserved would throw). doRelease calls this before the liveness guard
  // so a stale timer-bust orphan can't strand the on-chain lock. isLive(round) decides "genuinely live".
  function finalizeStaleRound(sessionId, isLive) { return rounds.finalizeStale ? rounds.finalizeStale(sessionId, isLive) : false; }
  function drain() { return rounds.drain ? rounds.drain() : []; }
  return { handle: handle, onClose: onClose, hasActiveRound: hasActiveRound, finalizeStaleRound: finalizeStaleRound, drain: drain, _rounds: rounds, _wsByRound: wsByRound };
}

module.exports = { makeCrashWs: makeCrashWs, CRASH_GAMES: CRASH_GAMES };

/* ---------------- CLI self-test: node server/crash-rounds-ws.js ---------------- */
if (require.main === module) {
  const CE = require("../public/crash-engine.js");
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

  // controllable clock + timers (same harness as crash-rounds.js)
  let clock = 0; const timers = [];
  const now = () => clock;
  const setTimer = (ms, fn) => { const t = { at: clock + ms, fn: fn, dead: false }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.dead = true; };
  const advance = (ms) => { clock += ms; for (const t of timers.slice()) { if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); } } };

  // stub bridge with a FIXED crash point so pacing + settlement agree.
  // Mirrors the real reserve/resolveReserved contract: reserve DEBITS the stake + pins a
  // nonce; resolveReserved CREDITS the gross payout for that nonce (idempotent).
  let CRASH = 4.0, tokens = 1000, nextNonce = 0; const reserved = new Map();
  const bridge = {
    reserve: (p) => { if (p.betUnits > tokens + 1e-9) throw new Error("insufficient tokens"); const nonce = nextNonce++; tokens = Math.round((tokens - p.betUnits) * 100) / 100; reserved.set(nonce, { bet: p.betUnits, open: true }); return { nonce, point: CRASH, crashPoint: CRASH, betUnits: p.betUnits, tokens }; },
    resolveReserved: (p) => { const rec = reserved.get(p.nonce); if (!rec) throw new Error("no reserved round"); if (!rec.open) return { win: rec.win, payoutUnits: rec.pay, multiplier: rec.win ? rec.c : 0, outcome: { crashPoint: CRASH }, tokens }; const c = p.cashOutAt; const win = CRASH >= c; const pay = win ? Math.round(rec.bet * c * 100) / 100 : 0; tokens = Math.round((tokens + pay) * 100) / 100; rec.open = false; rec.win = win; rec.pay = pay; rec.c = c; return { win, payoutUnits: pay, multiplier: win ? c : 0, outcome: { crashPoint: CRASH }, tokens }; },
  };
  // stub socket: captures every message it's sent
  const mkWs = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, last() { return this.sent[this.sent.length - 1]; } });

  // only "s1" with token "good" is a valid session
  const verifySession = (sid, tok) => (sid === "s1" && tok === "good") ? { id: "s1" } : null;
  const cr = makeCrashWs({ bridge, verifySession, now, setTimer, clearTimer });

  // 1) auth gate
  CRASH = 4.0; tokens = 1000; clock = 0;
  let ws = mkWs();
  cr.handle(ws, { type: "cr:start", sessionId: "s1", sessionToken: "WRONG", betUnits: 10 });
  eq("cr:start with a bad token → cr:error auth", ws.last().type === "cr:error" && ws.last().code === "auth");

  // 2) good start → cr:started, no crashPoint leaked
  cr.handle(ws, { type: "cr:start", sessionId: "s1", sessionToken: "good", betUnits: 10, clientSeed: "cs" });
  const started = ws.last();
  eq("cr:start → cr:started with roundId + startedAt + k", started.type === "cr:started" && !!started.roundId && started.startedAt === 0 && started.k === cr._rounds.K);
  eq("cr:started never includes the crash point", started.crashPoint === undefined);

  // 3) manual cash-out before the bust → cr:result win at the server multiplier
  advance(5000); // ~1.64x
  cr.handle(ws, { type: "cr:cashout", roundId: started.roundId });
  const res = ws.last();
  const expM = Math.floor(CE.multiplierAtMs(5000, started.k) * 100) / 100;
  eq("manual cash-out → cr:result win at server multiplier (" + expM + "x)", res.type === "cr:result" && res.win && res.cashOutAt === expM && res.crashPoint === 4.0);

  // 4) HOLD past the crash → server timer fires cr:result busted, ledger debited
  CRASH = 2.0; tokens = 1000; clock = 0;
  ws = mkWs();
  cr.handle(ws, { type: "cr:start", sessionId: "s1", sessionToken: "good", betUnits: 10 });
  const rid = ws.last().roundId;
  advance(CE.msToReach(2.0, cr._rounds.K) + 5);
  const bust = ws.last();
  eq("hold past crash → cr:result busted, lost the bet", bust.type === "cr:result" && bust.busted && tokens === 990);

  // 5) cash-out after the bust is rejected
  cr.handle(ws, { type: "cr:cashout", roundId: rid });
  eq("cash-out after bust → cr:error", ws.last().type === "cr:error" && ws.last().code === "cashout");

  // 6) AUTO target reached → cr:result win (auto is opt-in)
  CRASH = 5.0; tokens = 1000; clock = 0;
  ws = mkWs();
  cr.handle(ws, { type: "cr:start", sessionId: "s1", sessionToken: "good", betUnits: 10, autoTarget: 2.0 });
  eq("cr:started echoes the auto target", ws.last().autoTarget === 2.0);
  advance(CE.msToReach(2.0, cr._rounds.K) + 1);
  eq("auto target hit → cr:result win (+profit)", ws.last().type === "cr:result" && ws.last().win && tokens === 1010);

  // 7) a dropped socket still settles in the ledger, but we don't push to it
  CRASH = 2.0; tokens = 1000; clock = 0;
  ws = mkWs();
  cr.handle(ws, { type: "cr:start", sessionId: "s1", sessionToken: "good", betUnits: 10 });
  const before = ws.sent.length;
  cr.onClose(ws); // player disconnects mid-round
  advance(CE.msToReach(2.0, cr._rounds.K) + 5);
  eq("disconnect mid-round still settles the bet in the ledger", tokens === 990);
  eq("…but no cr:result is pushed to the dead socket", ws.sent.length === before);

  // 8) can't cash out someone else's round
  CRASH = 9.0; tokens = 1000; clock = 0;
  const wsA = mkWs(), wsB = mkWs();
  cr.handle(wsA, { type: "cr:start", sessionId: "s1", sessionToken: "good", betUnits: 1 });
  const ridA = wsA.last().roundId;
  cr.handle(wsB, { type: "cr:cashout", roundId: ridA });
  eq("a different socket can't cash out the round → cr:error owner", wsB.last().type === "cr:error" && wsB.last().code === "owner");
  cr.handle(wsA, { type: "cr:cashout", roundId: ridA }); // settle case 8's leftover round so s1 is free for the resume tests

  // 9) #94 RESUME — a reconnecting socket re-binds to its still-live round and can cash out safely.
  // T1: the round survives a socket drop (server keeps it live; there's something to re-bind to)
  CRASH = 4.0; tokens = 1000; clock = 0;
  let ws1 = mkWs();
  cr.handle(ws1, { type: "cr:start", sessionId: "s1", sessionToken: "good", betUnits: 10 });
  const rrid = ws1.last().roundId;
  cr.onClose(ws1); // drop
  eq("resume/T1: round still live server-side after a drop", cr._rounds.hasActive("s1") === true);
  eq("resume/T1: dead socket detached, stake still reserved (not refunded)", cr._wsByRound.get(rrid) === null && tokens === 990);
  // T2: cr:resume re-binds + replays cr:started (never leaks crashPoint)
  let ws2 = mkWs();
  cr.handle(ws2, { type: "cr:resume", sessionId: "s1", sessionToken: "good" });
  const rs = ws2.last();
  eq("resume/T2: cr:resume → cr:started{resumed:true} for the same round", rs.type === "cr:started" && rs.roundId === rrid && rs.resumed === true && rs.startedAt === 0 && rs.k === cr._rounds.K);
  eq("resume/T2: the resumed cr:started never leaks crashPoint", rs.crashPoint === undefined);
  eq("resume/T2: push target re-bound to the reconnected socket", cr._wsByRound.get(rrid) === ws2);
  // T3: a resumed cash-out BEFORE the crash pays at the server multiplier
  advance(3000); // ~1.35x, below 4.0
  cr.handle(ws2, { type: "cr:cashout", roundId: rrid });
  const r3 = ws2.last();
  const m3 = Math.floor(CE.multiplierAtMs(3000, cr._rounds.K) * 100) / 100;
  const expTokens3 = Math.round((990 + Math.round(10 * m3 * 100) / 100) * 100) / 100;
  eq("resume/T3: resumed cash-out before crash → win at server multiplier", r3.type === "cr:result" && r3.win && r3.cashOutAt === m3 && r3.crashPoint === 4.0);
  eq("resume/T3: paid exactly once at the server multiplier, round pruned", tokens === expTokens3 && cr._rounds.hasActive("s1") === false);
  // T4: a round that BUSTS while offline → resume finds nothing (cr:noround); stake lost, never paid above crash
  CRASH = 2.0; tokens = 1000; clock = 0;
  ws1 = mkWs();
  cr.handle(ws1, { type: "cr:start", sessionId: "s1", sessionToken: "good", betUnits: 10 });
  cr.onClose(ws1);
  advance(CE.msToReach(2.0, cr._rounds.K) + 5); // server timer busts it while detached
  ws2 = mkWs();
  cr.handle(ws2, { type: "cr:resume", sessionId: "s1", sessionToken: "good" });
  eq("resume/T4: a round busted while offline → cr:noround", ws2.last().type === "cr:noround");
  eq("resume/T4: stake lost on the offline bust (never refunded / paid above crash)", tokens === 990);
  // T5: no double-settle — a resumed cash-out that RACES the bust timer settles exactly once
  CRASH = 2.0; tokens = 1000; clock = 0;
  ws1 = mkWs();
  cr.handle(ws1, { type: "cr:start", sessionId: "s1", sessionToken: "good", betUnits: 10 });
  const rid5 = ws1.last().roundId;
  cr.onClose(ws1);
  ws2 = mkWs();
  cr.handle(ws2, { type: "cr:resume", sessionId: "s1", sessionToken: "good" });
  advance(CE.msToReach(2.0, cr._rounds.K) + 5);          // bust timer fires → settles once
  cr.handle(ws2, { type: "cr:cashout", roundId: rid5 }); // late tap → rejected, no second settle
  eq("resume/T5: no double-settle — stake moved once (bust), late tap rejected", tokens === 990 && ws2.last().type === "cr:error");
  // T6: cr:resume is auth-gated like cr:start
  ws2 = mkWs();
  cr.handle(ws2, { type: "cr:resume", sessionId: "s1", sessionToken: "WRONG" });
  eq("resume/T6: bad token → cr:error auth", ws2.last().type === "cr:error" && ws2.last().code === "auth");
  cr.handle(ws2, { type: "cr:resume", sessionId: "nope", sessionToken: "good" });
  eq("resume/T6: unknown session → cr:error auth", ws2.last().type === "cr:error" && ws2.last().code === "auth");

  console.log(ok ? "\nSELF-TEST OK — cr:* ws protocol: auth, manual cash-out, bust, auto-target, disconnect-safe, ownership, RESUME."
                 : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
