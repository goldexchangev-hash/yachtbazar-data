/* ============================================================
   crash-rounds.js — SERVER-PACED live crash rounds for token play.

   This is what makes MANUAL tap-to-cash-out work provably-fairly for the crash
   family (crash / plane / swoop / pressure). The crash point is committed (from the
   session seed) but SECRET during the round, so the server runs the round: it knows
   the crash point, paces the rising curve, fires the bust at the exact millisecond,
   and validates each cash-out against the server clock — exactly the Bustabit/Stake
   model. Manual is the DEFAULT; an optional auto-cash-out target just pre-schedules
   the cash-out. The client only ever receives the start time + curve constant to
   animate — never the crash point until it busts.

   The round settles through the token ledger via bridge.play("crash", ...) with the
   SAME clientSeed used to pace it, so the live round and the signed ledger always
   agree and the whole session re-derives from the revealed seed.

   makeCrashRounds({ bridge, now?, setTimer?, clearTimer? }) — startRound/cashOut/active
   ============================================================ */
"use strict";

const CE = require("../public/crash-engine.js");   // multiplierAtMs / msToReach (cosmetic curve)
const crashEngine = require("./games/crash.js");    // MIN_TARGET_X / MAX_CRASH_X

const K = CE.DEFAULT_K; // curve constant — the CLIENT animates with the identical k

function makeCrashRounds(opts) {
  opts = opts || {};
  const bridge = opts.bridge;
  const now = opts.now || (() => Date.now());
  const setTimer = opts.setTimer || ((ms, fn) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
  // onResolve(result, round) fires whenever a round settles — manual cash-out, a
  // server-timer bust, or an auto-target. The ws layer hooks this to push the result
  // to the player (esp. the timer-fired bust, which has no synchronous caller). EDIT
  // HERE if you want a single place to log/broadcast every settlement. Default no-op.
  const onResolve = typeof opts.onResolve === "function" ? opts.onResolve : function () {};
  const rounds = new Map();           // roundId -> round
  const activeBySession = new Map();  // sessionId -> roundId (ONE live round per session)
  let _seq = 0;

  function startRound(o) {
    const sessionId = o.sessionId;
    if (!sessionId) throw new Error("sessionId required");
    if (activeBySession.has(sessionId)) throw new Error("a crash round is already live");
    const gameKey = o.gameKey || "crash";
    const bet = Math.round((Number(o.betUnits) || 0) * 100) / 100;
    if (!(bet > 0)) throw new Error("bet must be positive");
    const clientSeed = String(o.clientSeed || ("rnd-" + (++_seq)));
    // Derive the SECRET crash point (server only) + the moment it busts.
    const peek = bridge.crashPointPeek({ sessionId: sessionId, clientSeed: clientSeed });
    const crashPoint = peek.crashPoint;
    const crashMs = CE.msToReach(crashPoint, K);
    const atCap = crashPoint >= crashEngine.MAX_CRASH_X;
    // Optional auto-cash-out (opt-in; default OFF = manual).
    let autoTarget = o.autoTarget != null ? Number(o.autoTarget) : 0;
    if (autoTarget && autoTarget < crashEngine.MIN_TARGET_X) autoTarget = crashEngine.MIN_TARGET_X;

    const id = "cr" + (++_seq);
    const startedAt = now();
    const round = { id: id, sessionId: sessionId, gameKey: gameKey, bet: bet, clientSeed: clientSeed,
      crashPoint: crashPoint, crashMs: crashMs, autoTarget: autoTarget || 0, startedAt: startedAt, settled: false, timer: null };
    rounds.set(id, round);
    activeBySession.set(sessionId, id);

    if (autoTarget && autoTarget <= crashPoint) {
      // auto-cash-out reached before the bust → win at the target
      round.timer = setTimer(Math.max(0, CE.msToReach(autoTarget, K)), () => _resolve(round, autoTarget, false));
    } else if (atCap) {
      // never busts below the 1000x cap → forced cash-out at the cap (a win)
      round.timer = setTimer(Math.max(0, crashMs), () => _resolve(round, crashEngine.MAX_CRASH_X, false));
    } else {
      // manual: bust at the crash time unless the player cashes out first
      round.timer = setTimer(Math.max(0, crashMs), () => _resolve(round, 0, true));
    }
    // The client animates from startedAt with curve constant k — it NEVER gets crashPoint.
    return { roundId: id, startedAt: startedAt, k: K, gameKey: gameKey, bet: bet, autoTarget: round.autoTarget };
  }

  // Manual cash-out: settle at the multiplier the SERVER computes from elapsed time
  // (the client's displayed number is never trusted — prevents claiming a stale low M).
  function cashOut(o) {
    const round = rounds.get(o && o.roundId);
    if (!round || round.settled) throw new Error("no live round");
    let m = CE.multiplierAtMs(now() - round.startedAt, K);
    m = Math.floor(m * 100) / 100;
    if (m < crashEngine.MIN_TARGET_X) m = crashEngine.MIN_TARGET_X;
    if (m > round.crashPoint) throw new Error("already crashed"); // raced past the bust
    return _resolve(round, m, false);
  }

  // Settle the round through the atomic ledger play() + reveal the crash point.
  function _resolve(round, cashOutAt, busted) {
    if (round.settled) return null;
    round.settled = true;
    if (round.timer != null) { try { clearTimer(round.timer); } catch (e) {} round.timer = null; }
    activeBySession.delete(round.sessionId);
    // bust loses by settling a target just ABOVE the crash point (crashPoint < target -> 0 payout).
    const target = busted ? round.crashPoint + 0.01 : cashOutAt;
    const res = bridge.play({ sessionId: round.sessionId, game: round.gameKey, betUnits: round.bet, params: { cashOutAt: target }, clientSeed: round.clientSeed });
    const out = { roundId: round.id, sessionId: round.sessionId, gameKey: round.gameKey, busted: !!busted,
      win: !!res.win, cashOutAt: busted ? null : cashOutAt, crashPoint: round.crashPoint,
      bet: round.bet, payoutUnits: res.payoutUnits, tokens: res.tokens };
    try { onResolve(out, round); } catch (e) {} // notify the ws layer (push cr:result); never let it break settlement
    return out;
  }

  function active(sessionId) { const id = activeBySession.get(sessionId); return id ? rounds.get(id) : null; }
  return { startRound: startRound, cashOut: cashOut, active: active, K: K, _rounds: rounds };
}

module.exports = { makeCrashRounds: makeCrashRounds, K: K };

/* ---------------- CLI self-test: node server/crash-rounds.js ---------------- */
if (require.main === module) {
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

  // controllable clock + timers
  let clock = 0; const timers = [];
  const now = () => clock;
  const setTimer = (ms, fn) => { const t = { at: clock + ms, fn: fn, dead: false }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.dead = true; };
  const advance = (ms) => { clock += ms; for (const t of timers.slice()) { if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); } } };

  // stub bridge with a FIXED crash point so pacing + settlement use the same value
  let CRASH = 4.00; let tokens = 1000;
  const bridge = {
    crashPointPeek: () => ({ nonce: 0, crashPoint: CRASH }),
    play: (p) => { const c = p.params.cashOutAt; const win = CRASH >= c; const pay = win ? p.betUnits * c : 0; tokens = Math.round((tokens - p.betUnits + pay) * 100) / 100; return { win: win, payoutUnits: pay, tokens: tokens }; },
  };
  const cr = makeCrashRounds({ bridge: bridge, now: now, setTimer: setTimer, clearTimer: clearTimer });

  // 1) MANUAL cash-out before the crash → win at the server-computed multiplier
  CRASH = 4.00; tokens = 1000; clock = 0;
  let r = cr.startRound({ sessionId: "s1", betUnits: 10 });
  eq("startRound returns roundId + startedAt + k", !!r.roundId && r.startedAt === 0 && r.k === K);
  advance(5000); // ~1.64x at k=0.0001 (e^0.5)
  const cashed = cr.cashOut({ roundId: r.roundId });
  const expM = Math.floor(CE.multiplierAtMs(5000, K) * 100) / 100;
  eq("manual cash-out wins at the server multiplier (" + expM + "x)", cashed.win && cashed.cashOutAt === expM && Math.abs(cashed.payoutUnits - 10 * expM) < 1e-9);
  eq("crash point revealed only on settle", cashed.crashPoint === 4.00);

  // 2) BUST: hold past the crash time → lose, ledger debited
  CRASH = 2.00; tokens = 1000; clock = 0;
  r = cr.startRound({ sessionId: "s2", betUnits: 10 });
  advance(CE.msToReach(2.00, K) + 5); // past the crash
  eq("busts and loses when held past the crash", tokens === 990);
  let threw = 0; try { cr.cashOut({ roundId: r.roundId }); } catch (e) { threw++; }
  eq("cash-out after bust is rejected", threw === 1);

  // 3) AUTO-cash-out target reached before the crash → win at the target
  CRASH = 5.00; tokens = 1000; clock = 0;
  r = cr.startRound({ sessionId: "s3", betUnits: 10, autoTarget: 2.0 });
  advance(CE.msToReach(2.0, K) + 1);
  eq("auto-cash-out wins at the target (2x)", tokens === 1010); // +10 profit

  // 4) AUTO target ABOVE the crash → busts (loss)
  CRASH = 1.50; tokens = 1000; clock = 0;
  r = cr.startRound({ sessionId: "s4", betUnits: 10, autoTarget: 3.0 });
  advance(CE.msToReach(1.50, K) + 1);
  eq("auto target above the crash busts", tokens === 990);

  // 5) one live round per session
  CRASH = 4.0; clock = 0; cr.startRound({ sessionId: "s5", betUnits: 1 });
  let dbl = 0; try { cr.startRound({ sessionId: "s5", betUnits: 1 }); } catch (e) { dbl++; }
  eq("only one live round per session", dbl === 1);

  console.log(ok ? "\nSELF-TEST OK — server-paced crash rounds: manual cash-out, bust, auto-target, all ledger-settled." : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
