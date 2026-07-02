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
const pressureEngine = require("./games/pressure.js"); // pressure (Balloon Pop) runs on this round-runner too — but with a HIGHER cash-out floor

const K = CE.DEFAULT_K; // curve constant — the CLIENT animates with the identical k

// mega-hunt CRITICAL: the minimum bankable multiplier is PER-GAME. Pressure VOID-REFUNDS the full stake for any
// settle below its 1.20x MIN_CASHOUT, so the round-runner MUST use pressure's floor (not crash's 1.01x) at EVERY
// clamp — auto target, manual cash-out, and the bust target. Using 1.01 let a pressure loss/bust land in the
// 1.01–1.19 VOID window and get the stake REFUNDED (net 0 on a loss) = systematic house drain. crash/plane/swoop
// keep the 1.01x floor. (For a bust we also floor the target to gameFloor so a low pop can't VOID-refund.)
function gameFloor(gameKey) { return gameKey === "pressure" ? pressureEngine.MIN_CASHOUT : crashEngine.MIN_TARGET_X; }

// M5: server-side stake ceilings for the crash family (TOKEN units = USD). The client caps these too, but a
// raw `cr:start` WS frame could bypass client validation — so enforce here as the real boundary. Checked
// BEFORE bridge.reserve() so a rejected bet never debits tokens or burns a nonce. Owner-set: plane $500.
// Blackjack + the shooters do NOT run on this round-runner. Unknown key → the conservative crash cap.
const MAX_STAKE = { crash: 100, pressure: 500, plane: 500, swoop: 1000 };

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
    const _cap = MAX_STAKE[gameKey] != null ? MAX_STAKE[gameKey] : MAX_STAKE.crash; // M5: reject over-cap BEFORE reserve() (no debit, no burned nonce)
    if (bet > _cap + 1e-9) throw new Error("bet above the " + gameKey + " max of " + _cap);
    const clientSeed = String(o.clientSeed || ("rnd-" + (++_seq)));
    // RESERVE up front: PIN the nonce + DEBIT the full stake + balance-check, all atomically
    // in the ledger. This is the atomic fix for the nonce-desync (#1 — an interleaved play()
    // can no longer move this round's point, since its nonce is already burned) and the
    // unreserved-stake loss-escape (#2/#14 — the stake is gone now, so a mid-round drain or an
    // over-balance bet can't dodge the loss; reserve() throws "insufficient tokens" HERE,
    // before any round state is created). The point is derived at the PINNED nonce, so the
    // eventual resolveReserved() at that same nonce always agrees with the paced curve.
    const rsv = bridge.reserve({ sessionId: sessionId, game: gameKey, betUnits: bet, clientSeed: clientSeed });
    const crashPoint = rsv.point != null ? rsv.point : rsv.crashPoint;
    const nonce = rsv.nonce;
    const crashMs = CE.msToReach(crashPoint, K);
    const atCap = crashPoint >= crashEngine.MAX_CRASH_X;
    // Optional auto-cash-out (opt-in; default OFF = manual). Clamp BOTH ends: floor at the
    // engine's MIN_TARGET_X and ceil at MAX_CRASH_X so a caller can't pass an unbounded /
    // non-finite target (#126) — the resolve engine clamps too, this keeps the timer sane.
    let autoTarget = o.autoTarget != null ? Number(o.autoTarget) : 0;
    if (!Number.isFinite(autoTarget) || autoTarget < 0) autoTarget = 0;
    if (autoTarget && autoTarget < gameFloor(gameKey)) autoTarget = gameFloor(gameKey); // per-game floor (pressure 1.20, else 1.01) — below pressure's floor an auto-target would VOID-refund
    if (autoTarget > crashEngine.MAX_CRASH_X) autoTarget = crashEngine.MAX_CRASH_X;

    const id = "cr" + (++_seq);
    const startedAt = now();
    const round = { id: id, sessionId: sessionId, gameKey: gameKey, bet: bet, clientSeed: clientSeed, nonce: nonce,
      crashPoint: crashPoint, crashMs: crashMs, autoTarget: autoTarget || 0, startedAt: startedAt, settled: false, timer: null };
    rounds.set(id, round);
    activeBySession.set(sessionId, id);

    // Timer callbacks must NEVER throw out of the event loop (an uncaught throw in a
    // setTimeout callback crashes Node → wipes the in-memory bank). safeResolve swallows
    // any ledger error; the round simply stays live for the prune sweep / next attempt.
    const safeResolve = (target, didBust) => { try { _resolve(round, target, didBust); } catch (e) { try { console.error("crash timer _resolve error:", (e && e.message) || e); } catch (_) {} } };
    if (autoTarget && autoTarget <= crashPoint) {
      // auto-cash-out reached before the bust → win at the target
      round.timer = setTimer(Math.max(0, CE.msToReach(autoTarget, K)), () => safeResolve(autoTarget, false));
    } else if (atCap) {
      // never busts below the 1000x cap → forced cash-out at the cap (a win)
      round.timer = setTimer(Math.max(0, crashMs), () => safeResolve(crashEngine.MAX_CRASH_X, false));
    } else {
      // manual: bust at the crash time unless the player cashes out first
      round.timer = setTimer(Math.max(0, crashMs), () => safeResolve(0, true));
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
    const floor = gameFloor(round.gameKey);
    // Below the game's floor: pressure can't bank yet (banking below 1.20x would VOID-REFUND the stake — the
    // drain) → REJECT so the round stays live and the player keeps holding. crash-type games floor an ultra-early
    // tap up to 1.01x (a tiny legit win) as before.
    if (round.gameKey === "pressure") { if (m < floor) throw new Error("hold longer — Balloon Pop banks from " + floor.toFixed(2) + "x"); }
    else if (m < floor) m = floor;
    if (m > round.crashPoint) throw new Error("already crashed"); // raced past the bust
    return _resolve(round, m, false);
  }

  // Settle the round by FINALIZING its reservation in the ledger, then clean up the maps.
  // ORDER MATTERS (fixes #13): we resolve the LEDGER FIRST (credit the win against the stake
  // already reserved at start) and only AFTER it succeeds do we mark the round settled + clear
  // the maps. If the ledger call throws, we roll back `settled` and leave the round live so the
  // caller (manual cash-out) sees the error and the server timer can still bust it — no orphaned
  // state, no stake stuck out of the ledger. The whole body is guarded so a stray throw in a
  // TIMER callback can never crash the process (which would wipe the in-memory bank).
  function _resolve(round, cashOutAt, busted) {
    if (round.settled) return null;
    // bust loses by resolving a target just ABOVE the crash point (crashPoint < target -> 0 payout). mega-hunt
    // CRITICAL: floor the bust target to the game's own floor too — for pressure a low pop (burst < 1.19) made
    // crashPoint+0.01 land BELOW 1.20x, where pressure.play VOID-REFUNDS the stake on what must be a LOSS. Flooring
    // to gameFloor (1.20) keeps target > burst (loss, payout 0) AND out of the void window. crash: crashPoint+0.01
    // is already >= 1.01 so this is a no-op. Stored as cashOutAt in the ledger → verifyRederive replays to the same 0.
    const target = busted ? Math.max(round.crashPoint + 0.01, gameFloor(round.gameKey)) : cashOutAt;
    let res;
    try {
      // LEDGER FIRST — credit the gross payout at the PINNED nonce (stake was debited at reserve).
      res = bridge.resolveReserved({ sessionId: round.sessionId, nonce: round.nonce, cashOutAt: target });
    } catch (e) {
      // Ledger failed. For a WIN cash-out there's a synchronous caller — surface it so the player
      // keeps holding (the round stays live; the stake is intact, reserved at start). But for a
      // timer-fired BUST there is NO caller and NO retry (the one-shot timer already fired, and there
      // is no prune sweep). If we leave the round live, activeBySession/hasActive stay TRUE forever →
      // liveCrashPlayer blocks settle/RECOVER permanently, stranding the on-chain lock (the "$X locked
      // in a past session — Recover doesn't work" trap). A bust that can't book is a LOSS THAT ALREADY
      // STANDS: the stake was debited at reserve(); resolveReserved throws here only when the record is
      // already finalized (idempotent → wouldn't throw) or the session is closed/gone (nothing left to
      // credit anyway). So RETIRE the RAM round — freeing the liveness guard, house-safe (payout stays 0).
      if (busted) {
        try { console.error("crash _resolve bust ledger error (retiring stale round):", (e && e.message) || e); } catch (_) {}
        round.settled = true;
        if (round.timer != null) { try { clearTimer(round.timer); } catch (_) {} round.timer = null; }
        activeBySession.delete(round.sessionId);
        rounds.delete(round.id);
        return null;
      }
      throw e;
    }
    // Ledger committed — NOW finalize round state.
    round.settled = true;
    if (round.timer != null) { try { clearTimer(round.timer); } catch (e) {} round.timer = null; }
    activeBySession.delete(round.sessionId);
    rounds.delete(round.id);   // PRUNE: drop the finished round so the map can't grow forever (#82).
    const out = { roundId: round.id, sessionId: round.sessionId, gameKey: round.gameKey, busted: !!busted,
      win: !!res.win, cashOutAt: busted ? null : cashOutAt, crashPoint: round.crashPoint,
      bet: round.bet, payoutUnits: res.payoutUnits, tokens: res.tokens };
    try { onResolve(out, round); } catch (e) {} // notify the ws layer (push cr:result); never let it break settlement
    return out;
  }

  function active(sessionId) { const id = activeBySession.get(sessionId); return id ? rounds.get(id) : null; }
  // Is a live (unsettled) round running for this session? Used by the token-http liveness guard to
  // refuse settle/recover/play while a server-paced round is in flight (#3/#15).
  function hasActive(sessionId) { const r = active(sessionId); return !!(r && !r.settled); }
  // RECOVER SELF-HEAL: retire a RAM round whose ledger side can NO LONGER be a genuinely-live round —
  // its bridge session is closed/gone or its reserved record is already finalized (b.open === false).
  // A timer-bust whose resolveReserved threw (session closed mid-round) leaves the RAM round live with
  // NO retry, so hasActive() would block Recover FOREVER; doRelease calls this first so a lock with no
  // genuinely-live round can ALWAYS be recovered. Returns true if it cleared a stale round. Never throws.
  // isLive(round) → the caller's authority on whether the underlying ledger round is still live.
  function finalizeStale(sessionId, isLive) {
    try {
      const r = active(sessionId);
      if (!r || r.settled) return false;
      if (typeof isLive === "function" && isLive(r)) return false; // genuinely live → leave it (don't yank a real round)
      r.settled = true;
      if (r.timer != null) { try { clearTimer(r.timer); } catch (_) {} r.timer = null; }
      activeBySession.delete(r.sessionId);
      rounds.delete(r.id);
      return true;
    } catch (_) { return false; }
  }
  // #94 RESUME: a SAFE, crashPoint-FREE snapshot of the session's live round, for re-binding a reconnecting
  // socket after a mobile app-switch / network blip so the player can resume the animation and still cash out
  // (the round keeps ticking on the server after a drop — onClose only detaches the dead socket). NEVER exposes
  // crashPoint (same guarantee as cr:started at :98). Returns null if no live round (already settled / none).
  function liveView(sessionId) {
    const r = active(sessionId);
    if (!r || r.settled) return null;
    return { roundId: r.id, gameKey: r.gameKey, bet: r.bet, startedAt: r.startedAt, k: K, autoTarget: r.autoTarget || 0 };
  }
  // GRACEFUL-SHUTDOWN DRAIN (#141): settle every in-flight round NOW (at its current server multiplier) so a
  // SIGTERM/redeploy never destroys a live round's timer with the stake un-debited (the house would otherwise
  // eat every in-flight losing bet — the stake was reserved but the win/loss never booked). _resolve is
  // idempotent (round.settled), so this can't double-settle a round that resolves concurrently. Never throws.
  function drain() {
    const outs = [];
    for (const round of Array.from(rounds.values())) {
      if (!round || round.settled) continue;
      try {
        let m = CE.multiplierAtMs(now() - round.startedAt, K);
        m = Math.floor(m * 100) / 100;
        const floor = gameFloor(round.gameKey);
        // v7 #3 (CRITICAL): below the game floor, a PRESSURE round must drain as a LOSS — settling it at 1.01x
        // lands in pressure.play's VOID window (< 1.20x) → the stake is REFUNDED on a redeploy = house drain.
        // (cashOut/_resolve already use gameFloor; drain() was missed.) crash-type games floor to 1.01x as before.
        if (round.gameKey === "pressure") {
          if (m < floor) { outs.push(_resolve(round, 0, true)); continue; } // sub-1.20x pressure drain → BUST (loss, payout 0)
        } else if (m < floor) { m = floor; }
        if (m > round.crashPoint) outs.push(_resolve(round, 0, true));   // already past the crash → bust
        else outs.push(_resolve(round, m, false));                       // still climbing → cash out where it is
      } catch (e) { try { _resolve(round, 0, true); } catch (e2) {} }
    }
    return outs;
  }
  return { startRound: startRound, cashOut: cashOut, active: active, hasActive: hasActive, finalizeStale: finalizeStale, liveView: liveView, drain: drain, K: K, _rounds: rounds };
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

  // stub bridge with a FIXED crash point so pacing + settlement use the same value.
  // Mirrors the real reserve/resolveReserved contract: reserve DEBITS the stake + pins a
  // nonce; resolveReserved CREDITS the gross payout for that nonce (idempotent).
  let CRASH = 4.00; let tokens = 1000; let nextNonce = 0; const reserved = new Map();
  const bridge = {
    reserve: (p) => { if (p.betUnits > tokens + 1e-9) throw new Error("insufficient tokens"); const nonce = nextNonce++; tokens = Math.round((tokens - p.betUnits) * 100) / 100; reserved.set(nonce, { bet: p.betUnits, open: true }); return { nonce: nonce, point: CRASH, crashPoint: CRASH, betUnits: p.betUnits, tokens: tokens }; },
    resolveReserved: (p) => { const rec = reserved.get(p.nonce); if (!rec) throw new Error("no reserved round"); if (!rec.open) return { win: rec.win, payoutUnits: rec.pay, tokens: tokens }; const c = p.cashOutAt; const win = CRASH >= c; const pay = win ? Math.round(rec.bet * c * 100) / 100 : 0; tokens = Math.round((tokens + pay) * 100) / 100; rec.open = false; rec.win = win; rec.pay = pay; return { win: win, payoutUnits: pay, tokens: tokens }; },
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
