/* ============================================================
   pressure.js — SERVER-AUTHORITATIVE engine for CH 13 "Balloon Pop" (a.k.a.
   PRESSURE). Crash-style: a hidden pop-point is committed before the bet; the
   player names a cash-out target and wins iff the balloon survives to it.

   Pure-function mirror of the client truth source public/pressure-engine.js
   (PressureEngine.deriveBurst + resolveRound) — the EXACT same pop-point and
   the EXACT same 3% house edge the Balloon Pop UI (public/pressure-ui.js) runs.

   ── THE MATH (cited to public/pressure-engine.js) ───────────────────────────
   • Uniform draw (deriveFloat, pressure-engine.js:102-105):
        float = parseInt( HMAC_SHA256(serverSeed, clientSeed + ":" + nonce)
                          .slice(0,8) , 16) / 2^32          ∈ [0,1)
     NOTE the HMAC message is "clientSeed:nonce" with NO ":cursor" suffix — the
     client takes the FIRST 8 hex of the raw HMAC digest. We reproduce that byte
     for byte using the same audited primitive PF itself wraps (Shuffle.hmacHex),
     so the server pop-point == the client pop-point for identical inputs.

   • Pop-point / burst B (deriveBurst, pressure-engine.js:107-117):
        B = (1 - houseEdge) / (1 - float)
        clamp B to [1, cap], then  B = floor(B * 100) / 100, re-floor to >= 1
     This is the canonical Bustabit/Stake inverse-CDF: P(B >= m) = (1-edge)/m.
     The whole house edge lives in the instant-pop mass at 1.00x (float < edge).

   • Defaults (pressure-engine.js:200 DEFAULTS): houseEdge = 0.03, cap = 1000.
     CH 13 builds the game with NO edge/cap override (app.js builds the play-money
     PressureGame without opts.houseEdge/opts.cap → pressure-ui.js:27-28 fall back
     to these defaults), so 3% / 1000x is what the live channel uses.

   • Win condition (resolveRound, pressure-engine.js:156-157):
        popped = releaseMult >= burst   →  a CLEAN cash-out (win) needs
        cashOutAt <= burst, i.e.  burst >= cashOutAt.
     On a win the single-target auto-cash-out banks stake * cashOutAt GROSS
     (this is the autoMult path of the ledger with no manual valve floors —
     unlockedFrac = 1, ridingWin = stake * releaseMult). On a pop, payout = 0.

   • Minimum cash-out (pressure-ui.js:22 MIN_CASHOUT = 1.20): a target below
     1.20x is void (the UI refunds the stake rather than booking a win/loss).
     We mirror it: cashOutAt < 1.20 → VOID, payout = stake (net 0), win = false.

   ── RTP ─────────────────────────────────────────────────────────────────────
   The edge is target-independent (the engine header proves S(m)=(1-edge)/m so
   EV of any target = 1-edge). For any valid cashOutAt >= MIN_CASHOUT:
        P(win) = P(burst >= cashOutAt) ≈ (1 - edge) / cashOutAt
        RTP    = P(win) * cashOutAt    = 1 - edge = 0.97   (3% house edge).
   (Tiny discrete-floor effects from floor(B*100)/100 nudge it tenths of a %.)

   params: { cashOutAt }  — the auto-cash-out target multiplier (>= 1.20).
                            Defaults to DEFAULTS.autoRelease = 2.0.
   ============================================================ */
"use strict";

const PF = require("../provablyfair.js");
// The exact SHA-256/HMAC primitive PF itself is built on (provablyfair.js:26).
// Used ONLY to reproduce the client's "clientSeed:nonce" (no-cursor) HMAC float
// byte-for-byte — NOT to reinvent hashing. Same module, same audited code path.
const Shuffle = require("../../public/blackjack-shuffle.js");

// Mirror of PressureEngine.DEFAULTS (pressure-engine.js:200) — the values CH 13 uses.
const HOUSE_EDGE = 0.03;   // 3% house edge
const CAP = 1000;          // 1000x pop-point ceiling
const MIN_CASHOUT = 1.20;  // pressure-ui.js:22 — below this a target is VOID (refund)
const DEFAULT_TARGET = 2.0; // DEFAULTS.autoRelease (pressure-engine.js:200)

// Documented RTP for the self-test tolerance: 1 - houseEdge = 0.97.
const RTP = 1 - HOUSE_EDGE;

// ── deriveFloat — EXACT mirror of pressure-engine.js:102-105 ──────────────────
// HMAC_SHA256(serverSeed, "clientSeed:nonce"), first 8 hex / 2^32 → [0,1).
function deriveFloat(serverSeed, clientSeed, nonce) {
  const hex = Shuffle.hmacHex(serverSeed, String(clientSeed) + ":" + String(nonce));
  return parseInt(hex.slice(0, 8), 16) / 0x100000000;
}

// ── deriveBurst — EXACT mirror of pressure-engine.js:107-117 ──────────────────
// The committed, hidden pop-point. Identical clamping + 2-dp floor as the client.
function deriveBurst(serverSeed, clientSeed, nonce) {
  const float = deriveFloat(serverSeed, clientSeed, nonce);
  let B = (1 - HOUSE_EDGE) / (1 - float);
  if (!isFinite(B) || B < 1) B = 1;
  if (B > CAP) B = CAP;
  B = Math.floor(B * 100) / 100;
  if (B < 1) B = 1;
  return B;
}

/**
 * Settle one Balloon Pop round at a fixed cash-out target.
 * @param {object} a
 * @param {string} a.serverSeed  secret seed (revealed after the round)
 * @param {string} a.clientSeed  public client entropy
 * @param {number} a.nonce       per-bet nonce
 * @param {number} a.betUnits    stake in abstract units (already debited)
 * @param {object} a.params      { cashOutAt }
 * @returns {{win:boolean, payoutUnits:number, multiplier:number, outcome:object, detail:string}}
 */
function play({ serverSeed, clientSeed, nonce, betUnits, params }) {
  const bet = Number(betUnits) || 0;

  // Player's auto-cash-out target. Clamp to the engine ceiling; below the 1.20x
  // minimum the round is VOID (stake refunded) exactly like the UI.
  let cashOutAt = params && params.cashOutAt != null ? Number(params.cashOutAt) : DEFAULT_TARGET;
  if (!isFinite(cashOutAt) || cashOutAt < 1) cashOutAt = 1;
  if (cashOutAt > CAP) cashOutAt = CAP;

  // The committed, hidden pop-point.
  const burst = deriveBurst(serverSeed, clientSeed, nonce);

  // VOID: target below the bankable minimum → refund the stake (net 0, not a win).
  if (cashOutAt < MIN_CASHOUT) {
    return {
      win: false,
      payoutUnits: bet, // stake returned → net 0
      multiplier: 1,
      outcome: { burst: burst, cashOutAt: cashOutAt, popPoint: burst, exit: "void" },
      detail:
        "target " + cashOutAt.toFixed(2) + "x is below the " + MIN_CASHOUT.toFixed(2) +
        "x minimum — VOID, stake refunded (pop was " + burst.toFixed(2) + "x)",
    };
  }

  // Win iff the balloon survives to the target: popPoint >= cashOutAt
  // (mirror of popped = releaseMult >= burst, pressure-engine.js:156).
  const win = burst >= cashOutAt;

  // GROSS returned: a clean cash-out banks stake * cashOutAt; a pop returns 0.
  const payoutUnits = win ? bet * cashOutAt : 0;
  const multiplier = win ? cashOutAt : 0;

  const detail = win
    ? "banked " + cashOutAt.toFixed(2) + "x — survived to target (pop was " + burst.toFixed(2) + "x)"
    : "POP at " + burst.toFixed(2) + "x before the " + cashOutAt.toFixed(2) + "x target — lost the bet";

  return {
    win: win,
    payoutUnits: payoutUnits,
    multiplier: multiplier,
    outcome: { burst: burst, cashOutAt: cashOutAt, popPoint: burst, exit: win ? "release" : "pop" },
    detail: detail,
  };
}

module.exports = { play: play, RTP: RTP, deriveBurst: deriveBurst, deriveFloat: deriveFloat };

/* ---------------- CLI self-test: node server/games/pressure.js ---------------- */
if (require.main === module) {
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

  // ── 1. Cross-check our pop-point against the CLIENT engine, byte for byte ──
  // This is the load-bearing parity test: our deriveBurst must equal the
  // shipped PressureEngine.deriveBurst for the same (seed,client,nonce,edge,cap).
  const Client = require("../../public/pressure-engine.js");
  let parityMismatches = 0;
  for (let i = 0; i < 20000; i++) {
    const { serverSeed } = PF.newRound();
    const clientSeed = "px-" + Math.floor(Math.random() * 1e9).toString(36);
    const nonce = Math.floor(Math.random() * 1e9);
    const mine = deriveBurst(serverSeed, clientSeed, nonce);
    const theirs = Client.deriveBurst(serverSeed, clientSeed, nonce, HOUSE_EDGE, CAP);
    if (mine !== theirs) { parityMismatches++; if (parityMismatches <= 3) console.log("    mismatch:", mine, "vs client", theirs); }
  }
  eq("server pop-point == client deriveBurst (20k samples, 0 mismatches)", parityMismatches === 0);

  // ── 2. Monte-Carlo RTP across many random cash-out targets ──
  const ROUNDS = 300000;
  const bet = 1;
  let wagered = 0, returned = 0, wins = 0, voids = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const { serverSeed } = PF.newRound();
    const clientSeed = "mc-" + Math.floor(Math.random() * 1e9).toString(36);
    const nonce = Math.floor(Math.random() * 1e9);
    // Random target in [1.20, 10.00) — RTP must hold for ANY target (edge is
    // target-independent). Stay >= MIN_CASHOUT so we measure real win/loss RTP.
    const cashOutAt = 1.2 + Math.random() * 8.8;

    const r = play({ serverSeed, clientSeed, nonce, betUnits: bet, params: { cashOutAt } });

    wagered += bet;
    returned += r.payoutUnits;
    if (r.win) wins++;

    // Per-round invariants.
    if (r.win) {
      if (Math.abs(r.payoutUnits - bet * cashOutAt) > 1e-9) { console.log("  FAIL  win payout != stake*cashOutAt:", r.payoutUnits); process.exit(1); }
      if (r.outcome.popPoint < cashOutAt - 1e-12) { console.log("  FAIL  win but popPoint < cashOutAt:", r.outcome.popPoint, cashOutAt); process.exit(1); }
    } else {
      if (r.payoutUnits !== 0) { console.log("  FAIL  loss payout not 0:", r.payoutUnits); process.exit(1); }
      if (r.outcome.popPoint >= cashOutAt) { console.log("  FAIL  loss but popPoint >= cashOutAt:", r.outcome.popPoint, cashOutAt); process.exit(1); }
    }
  }

  const measuredRTP = returned / wagered;
  console.log("Balloon Pop (pressure) — server engine self-test");
  console.log("  rounds          : " + ROUNDS);
  console.log("  win rate        : " + ((wins / ROUNDS) * 100).toFixed(3) + "%");
  console.log("  house edge      : " + (HOUSE_EDGE * 100).toFixed(2) + "%   cap " + CAP + "x");
  console.log("  documented RTP  : " + (RTP * 100).toFixed(2) + "%");
  console.log("  measured  RTP   : " + (measuredRTP * 100).toFixed(3) + "%");
  eq("measured RTP within 0.8% of documented 97%", Math.abs(measuredRTP - RTP) <= 0.008);

  // ── 3. Determinism: identical inputs → identical outcome ──
  const seed = PF.newRound().serverSeed;
  const a = play({ serverSeed: seed, clientSeed: "det", nonce: 7, betUnits: 1, params: { cashOutAt: 2 } });
  const b = play({ serverSeed: seed, clientSeed: "det", nonce: 7, betUnits: 1, params: { cashOutAt: 2 } });
  eq("deterministic for identical inputs", JSON.stringify(a) === JSON.stringify(b));

  // ── 4. Win condition: a target at/under the burst wins, just over it loses ──
  const burst = deriveBurst(seed, "edge", 11);
  const justUnder = play({ serverSeed: seed, clientSeed: "edge", nonce: 11, betUnits: 1, params: { cashOutAt: Math.max(MIN_CASHOUT, burst) } });
  const justOver = play({ serverSeed: seed, clientSeed: "edge", nonce: 11, betUnits: 1, params: { cashOutAt: burst + 0.01 } });
  eq("cashOutAt == burst wins (popPoint >= cashOutAt)", burst < MIN_CASHOUT ? true : justUnder.win === true);
  eq("cashOutAt just over burst loses", justOver.win === false && justOver.payoutUnits === 0);

  // ── 5. VOID below the 1.20x minimum refunds the stake (net 0) ──
  const v = play({ serverSeed: seed, clientSeed: "void", nonce: 3, betUnits: 25, params: { cashOutAt: 1.1 } });
  eq("target < 1.20x is void & refunds stake (net 0)", v.win === false && v.payoutUnits === 25);

  // ── 6. Higher target ⇒ rarer win (survival monotonicity) over a sample ──
  let winsLow = 0, winsHigh = 0;
  for (let i = 0; i < 50000; i++) {
    const ss = PF.newRound().serverSeed;
    if (play({ serverSeed: ss, clientSeed: "m", nonce: i, betUnits: 1, params: { cashOutAt: 1.5 } }).win) winsLow++;
    if (play({ serverSeed: ss, clientSeed: "m", nonce: i, betUnits: 1, params: { cashOutAt: 5.0 } }).win) winsHigh++;
  }
  eq("1.5x target wins more often than 5x target", winsLow > winsHigh);

  console.log(ok ? "\nSELF-TEST OK — server Balloon Pop mirrors the client pop-point + 3% edge." : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
