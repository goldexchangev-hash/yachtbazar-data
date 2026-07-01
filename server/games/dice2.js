/* ============================================================
   server/games/dice2.js — SERVER-AUTHORITATIVE engine for "dice2" (Two-d6, CH 10).

   Mirrors the on-chain TwoDice game in contracts/CoinFlipBetting.sol and the
   client readouts in public/app.js EXACTLY. Roll two independent six-sided dice,
   sum them (2..12), and bet whether the sum lands strictly OVER or strictly UNDER
   a target line.

   ── House math (verbatim from the sources, do NOT re-derive) ──────────────────
   ways(s)            = 6 - |s - 7|                 for s in [2,12]   (combos per sum)
     contract:  _waysForSum  CoinFlipBetting.sol:814-817
     client:    tdWays       public/app.js:1868
   winCombos(T,over)  = OVER : sum of ways(s) for s in (T, 12]
                        UNDER: sum of ways(s) for s in [2, T)
     contract:  _twoDiceWinCombos  CoinFlipBetting.sol:821-827
     client:    tdWinCombos        public/app.js:1869-1874
   multiplierBps      = floor( (10000 - twoDiceEdgeBps) * 36 / winCombos )
                      = floor( 9800 * 36 / winCombos )     (twoDiceEdgeBps = 200 = 2%)
     contract:  _twoDiceMultiplierBps  CoinFlipBetting.sol:830-832  (BPS_DENOMINATOR=10000,
                twoDiceEdgeBps=200 :74, TWO_DICE_COMBOS=36 :72)
     client:    Math.floor(9800 * 36 / combos) / 10000     public/app.js:1881
   payout (gross)     = bet * multiplierBps / 10000        (total returned on a win)
     contract:  playTwoDice  CoinFlipBetting.sol:859
   won                = OVER : sum > target ; UNDER : sum < target
     contract:  CoinFlipBetting.sol:871 ; client mode in app.js
   Edge is the floored multiplier → documented RTP = 98.0% (true ≈ 0.97999, the floor
   only nicks T=3-over and T=11-under by ~0.0001).

   ── Randomness ────────────────────────────────────────────────────────────────
   Two INDEPENDENT d6 are drawn from the committed PF float stream (k=0, k=1) — never
   Math.random. The contract draws its two faces independently too (r%6, (r/6)%6);
   drawing two independent uniform d6 is the identical distribution, fully verifiable
   from the revealed seed.

   PURE FUNCTION — module.exports = { play, RTP }.
   ============================================================ */
"use strict";

const PF = require("../provablyfair.js");

const TWO_DICE_COMBOS = 36;     // 6 x 6 equally-likely faces        (contract :72)
const TWO_DICE_EDGE_BPS = 200;  // 2% house edge                     (contract :74)
const BPS_DENOMINATOR = 10000;  //                                    (contract :41)
const NET_BPS = BPS_DENOMINATOR - TWO_DICE_EDGE_BPS; // 9800

// Documented/intended RTP for the bridge & self-test tolerance.
const RTP = NET_BPS / BPS_DENOMINATOR; // 0.98

// Combos that produce a two-dice sum s: 6 - |s - 7|, s in [2,12].   (contract :814 / app.js:1868)
function waysForSum(s) {
  return 6 - Math.abs(s - 7);
}

// Winning combinations for a target line + direction.               (contract :821 / app.js:1869)
//   OVER : win if sum > target  → sum of ways(s) for s in (target, 12]
//   UNDER: win if sum < target  → sum of ways(s) for s in [2, target)
function winCombos(target, over) {
  let c = 0;
  if (over) {
    for (let s = target + 1; s <= 12; s++) c += waysForSum(s);
  } else {
    for (let s = 2; s < target; s++) c += waysForSum(s);
  }
  return c;
}

// Payout multiplier in bps (10000 = 1.00x), floored to match on-chain integer bps.
//   floor( 9800 * 36 / winCombos )                                  (contract :830 / app.js:1881)
function multiplierBps(combos) {
  return Math.floor((NET_BPS * TWO_DICE_COMBOS) / combos);
}

/* ── play: pure, deterministic, server-committed ──────────────────────────────
   params: { target (int 2..12), over (bool) }
   Returns GROSS payoutUnits the player gets back (0 on loss); net = payoutUnits - betUnits.
*/
function play({ serverSeed, clientSeed, nonce, betUnits, params }) {
  const p = params || {};
  const target = (p.target | 0);
  const over = !!p.over;

  // Validate the line exactly like the contract (target in [2,12], non-degenerate).
  if (target < 2 || target > 12) {
    throw new Error("dice2: target must be an integer in [2,12], got " + p.target);
  }
  const combos = winCombos(target, over);
  if (combos === 0 || combos >= TWO_DICE_COMBOS) {
    // No winning combos, or no losing combos — the contract reverts (DiceBadTarget).
    throw new Error("dice2: degenerate target (" + (over ? "over" : "under") + " " + target + ") — winCombos=" + combos);
  }

  const bet = Number(betUnits) || 0;
  const multBps = multiplierBps(combos);
  const multiplier = multBps / BPS_DENOMINATOR;

  // Two INDEPENDENT d6 from the committed float stream (positions k=0 and k=1).
  const d1 = PF.intBelow(serverSeed, clientSeed, nonce, 6, 0) + 1; // 1..6
  const d2 = PF.intBelow(serverSeed, clientSeed, nonce, 6, 1) + 1; // 1..6
  const sum = d1 + d2;

  const win = over ? (sum > target) : (sum < target);

  // Gross returned on a win = bet * multiplierBps / 10000 (contract :859). 0 on loss.
  // Units are abstract (1 unit = $1); the bridge scales units→wei downstream where the
  // integer-bps division happens at wei granularity, so we keep the exact fractional
  // value here (no unit-level floor, which would mangle small stakes).
  const payoutUnits = win ? (bet * multBps) / BPS_DENOMINATOR : 0;

  return {
    win: win,
    payoutUnits: payoutUnits,
    multiplier: win ? multiplier : 0,
    outcome: { d1: d1, d2: d2, sum: sum, target: target, over: over, winCombos: combos, multiplierBps: multBps },
    detail:
      "two-d6 " + d1 + "+" + d2 + "=" + sum + " vs " +
      (over ? "over " : "under ") + target +
      " (winCombos " + combos + "/36, x" + multiplier.toFixed(4) + ") → " +
      (win ? "WIN" : "LOSE"),
  };
}

module.exports = { play: play, RTP: RTP, winCombos: winCombos, waysForSum: waysForSum, multiplierBps: multiplierBps };

/* ---------------- CLI self-test: node server/games/dice2.js ---------------- */
if (require.main === module) {
  // Enumerate every non-degenerate (target, over) line, exactly as the UI allows.
  const lines = [];
  for (let t = 2; t <= 12; t++) {
    for (const over of [true, false]) {
      const wc = winCombos(t, over);
      if (wc > 0 && wc < TWO_DICE_COMBOS) lines.push({ target: t, over: over, wc: wc });
    }
  }

  // ---- Determinism + face-distribution sanity ----
  const { serverSeed, commit } = PF.newRound();
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };
  eq("commit verifies for the seed", PF.verify(commit, serverSeed));

  const r1 = play({ serverSeed, clientSeed: "c", nonce: 42, betUnits: 100, params: { target: 7, over: true } });
  const r2 = play({ serverSeed, clientSeed: "c", nonce: 42, betUnits: 100, params: { target: 7, over: true } });
  eq("deterministic for identical inputs", JSON.stringify(r1) === JSON.stringify(r2));

  // ---- Monte-Carlo RTP, randomizing the betting line each round ----
  const ROUNDS = 300000;
  const BET = 1;
  let staked = 0, returned = 0;
  // Independent face-frequency check (both dice should be ~uniform over 1..6).
  const faceCounts = new Array(7).fill(0);

  // A fresh random client seed per round (like real bets), nonce = round index.
  for (let i = 0; i < ROUNDS; i++) {
    const line = lines[Math.floor(Math.random() * lines.length)];
    const cs = "cs-" + Math.floor(Math.random() * 1e9) + "-" + i;
    const res = play({ serverSeed, clientSeed: cs, nonce: i, betUnits: BET, params: { target: line.target, over: line.over } });
    staked += BET;
    returned += res.payoutUnits;
    faceCounts[res.outcome.d1]++;
    faceCounts[res.outcome.d2]++;
  }

  const measuredRTP = returned / staked;
  console.log("\n  rounds              " + ROUNDS);
  console.log("  client documented   RTP = " + (RTP * 100).toFixed(3) + "%  (2% edge, floored bps)");
  console.log("  measured Monte-Carlo RTP = " + (measuredRTP * 100).toFixed(3) + "%");

  // Faces: each die uniform → each value ~ (2*ROUNDS)/6 occurrences.
  const expFace = (2 * ROUNDS) / 6;
  let facesOk = true;
  for (let v = 1; v <= 6; v++) if (Math.abs(faceCounts[v] - expFace) > expFace * 0.05) facesOk = false;
  eq("both d6 roughly uniform (" + faceCounts.slice(1).join("/") + ")", facesOk);

  // Within ~0.8% of documented RTP (floor pulls it a hair under 98%, never over).
  const within = Math.abs(measuredRTP - RTP) <= 0.008;
  eq("measured RTP within 0.8% of documented", within);

  // Spot-check a couple of multiplier values against the known on-chain bps.
  eq("T=7 over multiplierBps == 23520", multiplierBps(winCombos(7, true)) === 23520);
  eq("T=11 over (wc=1) multiplierBps == 352800", multiplierBps(winCombos(11, true)) === 352800);
  eq("T=2 over (wc=35) multiplierBps == 10080", multiplierBps(winCombos(2, true)) === 10080);

  console.log(ok && within && facesOk
    ? "\nSELF-TEST OK — dice2 mirrors the on-chain two-d6 math; RTP within tolerance."
    : "\nSELF-TEST FAILED");
  process.exit(ok && within && facesOk ? 0 : 1);
}
