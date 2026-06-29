/* ============================================================================
 * server/games/crash.js — SERVER-AUTHORITATIVE engine for "crash" (CH 11).
 *
 * PURE FUNCTION. All randomness comes from the committed PF float stream
 * (server/provablyfair.js) — never Math.random — so every bust point is
 * server-committed before the bet and player-verifiable from the reveal.
 *
 * ── Math mirrored EXACTLY from the existing client + contract ───────────────
 *   • Client public/crash-engine.js:21-39  (crashFromUnit / unitFromHex / crashFromHash)
 *         crashFromUnit(x, edge) = floor( (100 * (1-edge)) / (1-x) ) / 100,
 *                                  then max(1.00, …)      — the canonical
 *         Bustabit/Stake inverse-CDF  P(crash >= M) = (1-edge)/M.
 *         unitFromHex takes the top 52 bits of the digest: h/2^52  (13 hex chars).
 *   • Contract contracts/CoinFlipBetting.sol:917-925 (_crashPoint)
 *         h = random % 2^52;  denom = 2^52 - h;
 *         x100 = (100 * (BPS - crashEdgeBps) * 2^52) / (BPS * denom);
 *         floor at 100 (1.00x), cap at CRASH_MAX_X100 = 100_000 (1000.00x).
 *     Same inverse-CDF, same 52-bit uniform, same floor; just expressed in x100.
 *   • Payout / win rule  app.js:1990-2002 + sol:931-966
 *         won  = crashPoint >= cashOutAt
 *         payout (gross) = bet * cashOutAt   (0 on loss)
 *   • Constants  sol:41,95,96,98
 *         crashEdgeBps = 100  -> CRASH_EDGE = 0.01 (1%)
 *         BPS_DENOMINATOR = 10_000
 *         CRASH_MIN_X100 = 101    -> min cashOutAt = 1.01x
 *         CRASH_MAX_X100 = 100_000 -> crash point cap = 1000.00x
 *
 * To reproduce the 52-bit uniform draw from the PF 32-bit float stream we
 * compose two PF floats into a 52-bit fraction (hi 32 bits + lo 20 bits),
 * which is the exact precision the client's unitFromHex / the contract's
 * `% 2^52` use. The crash point is then run through the identical formula.
 * ==========================================================================*/
"use strict";

const PF = require("../provablyfair.js");

// ── House edge + bounds — mirror the on-chain constants exactly ─────────────
const CRASH_EDGE = 0.01;        // crashEdgeBps = 100 / BPS_DENOMINATOR 10_000
const MAX_CRASH_X = 1000.0;     // CRASH_MAX_X100 = 100_000 -> 1000.00x cap
const MIN_TARGET_X = 1.01;      // CRASH_MIN_X100 = 101     -> min cash-out 1.01x

const RTP = 1 - CRASH_EDGE;     // 0.99 — documented client RTP for any valid target

// Map a uniform x in [0,1) -> crash multiplier (2-dp), with the house edge.
// Byte-identical to public/crash-engine.js crashFromUnit, plus the on-chain
// 1000x cap so the server can never quote a point the contract couldn't pay.
function crashFromUnit(x) {
  if (!(x >= 0)) x = 0;
  if (x >= 1) x = 1 - 1e-12;
  const m = Math.floor((100 * RTP) / (1 - x)) / 100;
  return Math.min(MAX_CRASH_X, Math.max(1.0, m));
}

// Build the 52-bit uniform draw the client/contract use, from the PF stream.
// hi = top 32 bits, lo = next 20 bits  ->  (hi*2^20 + lo)/2^52  in [0,1).
function unitFromFloats(f) {
  const TWO20 = 0x100000;       // 2^20
  const TWO52 = 0x10000000000000; // 2^52
  const hi = Math.floor(f[0] * 0x100000000); // 32 bits
  const lo = Math.floor(f[1] * TWO20);        // 20 bits
  return (hi * TWO20 + lo) / TWO52;
}

/**
 * play — pure crash round.
 * @param {string} serverSeed  secret seed (committed via PF.newRound before bet)
 * @param {string} clientSeed  public
 * @param {number} nonce       per-bet
 * @param {number} betUnits    stake (already debited), 1 unit = $1
 * @param {object} params      { cashOutAt }  auto-cash-out target (>=1.01)
 * @returns {{win, payoutUnits, multiplier, outcome, detail}}
 */
function play({ serverSeed, clientSeed, nonce, betUnits, params }) {
  const p = params || {};
  let cashOutAt = Number(p.cashOutAt);
  if (!(cashOutAt >= MIN_TARGET_X)) cashOutAt = MIN_TARGET_X; // clamp to 1.01x floor
  if (cashOutAt > MAX_CRASH_X) cashOutAt = MAX_CRASH_X;       // CRASH_MAX_X100 ceiling
  // round target to 2dp (x100 granularity the contract uses)
  cashOutAt = Math.round(cashOutAt * 100) / 100;

  // Two PF floats -> one 52-bit uniform -> the committed crash point.
  const f = PF.floats(serverSeed, clientSeed, nonce, 2);
  const crashPoint = crashFromUnit(unitFromFloats(f));

  const win = crashPoint >= cashOutAt;
  const multiplier = win ? cashOutAt : 0;           // realised payout multiple
  const payoutUnits = win ? betUnits * cashOutAt : 0; // GROSS returned (0 on loss)

  return {
    win: win,
    payoutUnits: payoutUnits,
    multiplier: multiplier,
    outcome: { crashPoint: crashPoint, cashOutAt: cashOutAt },
    detail:
      "rocket busted at " + crashPoint.toFixed(2) + "x; auto-cash-out " +
      cashOutAt.toFixed(2) + "x -> " + (win ? "CASHED OUT" : "BUSTED"),
  };
}

module.exports = { play: play, RTP: RTP, CRASH_EDGE: CRASH_EDGE };

/* ---------------- CLI self-test: node server/games/crash.js ----------------- */
if (require.main === module) {
  const ROUNDS = 300000;
  const { serverSeed } = PF.newRound();

  // Sweep a spread of cash-out targets; RTP is target-invariant at 1-edge, so
  // the aggregate must land on 0.99 regardless of the mix.
  const targets = [1.01, 1.10, 1.5, 2, 3, 5, 10, 50, 100];

  let wagered = 0, returned = 0, wins = 0;
  let sumCrash = 0, instaBust = 0, capHits = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const cashOutAt = targets[i % targets.length];
    const r = play({
      serverSeed: serverSeed,
      clientSeed: "selftest-" + (i % 997), // vary the client seed
      nonce: i,
      betUnits: 1,
      params: { cashOutAt: cashOutAt },
    });
    wagered += 1;
    returned += r.payoutUnits;
    if (r.win) wins++;
    sumCrash += r.outcome.crashPoint;
    if (r.outcome.crashPoint <= 1.0) instaBust++;
    if (r.outcome.crashPoint >= MAX_CRASH_X) capHits++;
  }

  const measuredRTP = returned / wagered;
  const clientRTP = RTP; // 0.99
  const tol = 0.008;     // within ~0.8%
  const meanCrash = sumCrash / ROUNDS;

  let ok = true;
  const eq = (label, cond) => {
    console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
    if (!cond) ok = false;
  };

  console.log("CRASH server engine — Monte-Carlo " + ROUNDS.toLocaleString() + " rounds");
  console.log("  client/documented RTP : " + (clientRTP * 100).toFixed(2) + "%");
  console.log("  measured RTP          : " + (measuredRTP * 100).toFixed(3) + "%");
  console.log("  win rate              : " + ((wins / ROUNDS) * 100).toFixed(2) + "%");
  console.log("  mean crash point      : " + meanCrash.toFixed(3) + "x");
  console.log("  instant-bust (1.00x)  : " + ((instaBust / ROUNDS) * 100).toFixed(2) + "%");
  console.log("  1000x cap hits        : " + capHits);

  eq("measured RTP within " + (tol * 100) + "% of " + (clientRTP * 100).toFixed(2) + "% (got " +
     (measuredRTP * 100).toFixed(3) + "%)", Math.abs(measuredRTP - clientRTP) <= tol);

  // Determinism: identical inputs reproduce the identical crash point.
  const a = play({ serverSeed, clientSeed: "det", nonce: 42, betUnits: 1, params: { cashOutAt: 2 } });
  const b = play({ serverSeed, clientSeed: "det", nonce: 42, betUnits: 1, params: { cashOutAt: 2 } });
  eq("deterministic for identical (seed,client,nonce)",
     a.outcome.crashPoint === b.outcome.crashPoint && a.payoutUnits === b.payoutUnits);

  // Spot-check the formula against the client crashFromUnit at fixed x.
  // Expected values are the EXACT output of the client crashFromUnit formula,
  // including its IEEE-754 floor behaviour (which the server mirrors byte-for-byte).
  const checks = [
    [0.0, 1.0],    // floor(99/1)/100 = 0.99 -> max(1.0,..) = 1.00 (the floor)
    [0.5, 1.98],   // floor(99/0.5)/100 = 1.98
    [0.9, 9.9],    // floor(99/0.1)/100 = 9.90
    [0.99, 98.99], // 99/0.01 = 9899.999… in float -> floor 9899 -> 98.99
  ];
  let formulaOk = true;
  for (const [x, exp] of checks) {
    const got = crashFromUnit(x);
    if (Math.abs(got - exp) > 1e-9) { formulaOk = false; console.log("    x=" + x + " got " + got + " exp " + exp); }
  }
  eq("crashFromUnit matches client crash-engine.js at sample points", formulaOk);

  // Win rule + payout: a 1.01x target wins iff crashPoint >= 1.01, payout = bet*1.01.
  const lowTarget = play({ serverSeed, clientSeed: "win", nonce: 7, betUnits: 10, params: { cashOutAt: 1.01 } });
  eq("payout = bet * cashOutAt on win (or 0 on loss)",
     lowTarget.win ? Math.abs(lowTarget.payoutUnits - 10 * 1.01) < 1e-9 : lowTarget.payoutUnits === 0);

  // Bounds: target below 1.01 clamps up; crash point never exceeds 1000x.
  const clamped = play({ serverSeed, clientSeed: "clamp", nonce: 1, betUnits: 1, params: { cashOutAt: 1.0 } });
  eq("cashOutAt clamps to 1.01 floor", clamped.outcome.cashOutAt === 1.01);
  eq("crash point capped at 1000x", crashFromUnit(1 - 1e-15) <= MAX_CRASH_X);

  console.log(ok ? "\nSELF-TEST OK — crash engine mirrors client+contract, RTP verified."
                 : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
