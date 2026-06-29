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
      if (ws) send(ws, Object.assign({ type: "cr:result" }, out));
    },
  });

  function handle(ws, data) {
    const t = data && data.type;
    if (t === "cr:ping") { send(ws, { type: "cr:pong" }); return; }
    if (t === "cr:start") { start(ws, data); return; }
    if (t === "cr:cashout") { cashout(ws, data); return; }
    // any other cr:* — ignore quietly (forward-compat for new message types)
  }

  function start(ws, data) {
    const sess = verifySession(data && data.sessionId, data && data.sessionToken);
    if (!sess) { send(ws, { type: "cr:error", code: "auth", message: "buy in with tokens first" }); return; }
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

  // A dropped socket can't cash out — the server timer still fires and settles the bet
  // into the ledger (the player simply doesn't see the reveal). Just detach the dead
  // socket so onResolve never tries to send to it.
  function onClose(ws) {
    if (ws && ws._crRounds) for (const id of ws._crRounds) { if (wsByRound.get(id) === ws) wsByRound.set(id, null); }
  }

  return { handle: handle, onClose: onClose, _rounds: rounds, _wsByRound: wsByRound };
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

  // stub bridge with a FIXED crash point so pacing + settlement agree
  let CRASH = 4.0, tokens = 1000;
  const bridge = {
    crashPointPeek: () => ({ nonce: 0, crashPoint: CRASH }),
    play: (p) => { const c = p.params.cashOutAt; const win = CRASH >= c; const pay = win ? p.betUnits * c : 0; tokens = Math.round((tokens - p.betUnits + pay) * 100) / 100; return { win, payoutUnits: pay, multiplier: win ? c : 0, outcome: { crashPoint: CRASH }, tokens }; },
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

  console.log(ok ? "\nSELF-TEST OK — cr:* ws protocol: auth, manual cash-out, bust, auto-target, disconnect-safe, ownership."
                 : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
