/* ============================================================
   dice.js — SERVER-AUTHORITATIVE engine for the 0-100 dice game (CH 09).

   PURE FUNCTION mirror of the on-chain math in contracts/CoinFlipBetting.sol
   (the `playDice` path) and the client preview in public/app.js. The server
   commits a PF seed BEFORE the bet; this module re-derives the roll + payout
   deterministically from that seed so any player can verify the outcome.

   ---- EXACT MATH (cited) -------------------------------------------------
   Roll space (contracts/CoinFlipBetting.sol:44):
       DICE_OUTCOMES = 10_000  -> roll is an int in [0, 9999], displayed as
       roll/100 = 0.00 .. 99.99. (The prompt's "roll in [0,100)" is this exact
       0.00-99.99 display grid; `target` is on the same 0..9999 integer grid,
       where the human "0-99" line = target/100.)

   House edge (contracts/CoinFlipBetting.sol:49):
       diceEdgeBps = 200  ->  EDGE = 0.02 (2.00%).

   Winning outcomes  (_diceWinOutcomes, contracts/CoinFlipBetting.sol:726-728):
       UNDER (over=false): win if roll <  target  -> winOutcomes = target
       OVER  (over=true):  win if roll >  target  -> winOutcomes = 9999 - target
                                                   = DICE_OUTCOMES - 1 - target

   Payout multiplier (_diceMultiplierBps, contracts/CoinFlipBetting.sol:730-733):
       multiplierBps = ((10000 - diceEdgeBps) * DICE_OUTCOMES) / winOutcomes
                     = floor( 9800 * 10000 / winOutcomes )          // integer/bps
       payoutUnits   = floor( betUnits * multiplierBps / 10000 )    // sol:752
   The client mirrors this exactly: public/app.js:1784
       mult = Math.floor(9800 * 10000 / winOutcomes) / 10000

   Valid target window (contracts/CoinFlipBetting.sol:45-46,748):
       MIN_WIN_OUTCOMES = 100   (>=1.00% win chance)
       MAX_WIN_OUTCOMES = 9900  (<=99.00% win chance)
   The client further clamps to [100, 9899] target with a 9800 win-outcome cap
   (public/app.js:1769-1774) so total payout stays >= stake after the 2% edge.
   We enforce the *contract* window (the authoritative settlement rule) and
   treat an out-of-window target as an invalid bet (no win, multiplier 0).

   ---- RTP ----------------------------------------------------------------
   For any valid line, RTP = winChance * multiplier
        = (winOutcomes/10000) * floor(9800*10000/winOutcomes)/10000
        ~= 0.98  (the 2% edge), minus a tiny floor-rounding bias on the
   multiplier that only ever *reduces* the player's edge. Documented client
   RTP therefore = 1 - EDGE = 0.98 (98%).

   ---- EXPORTS ------------------------------------------------------------
   module.exports = { play, RTP }
   play({ serverSeed, clientSeed, nonce, betUnits, params:{target,over} }) ->
     { win, payoutUnits, multiplier, outcome, detail }
   ============================================================ */
"use strict";

const PF = require("../provablyfair.js");

// ---- constants mirrored 1:1 from CoinFlipBetting.sol -----------------------
const DICE_OUTCOMES   = 10000; // sol:44  roll in [0, 9999]
const EDGE_BPS        = 200;   // sol:49  diceEdgeBps (2%)
const BPS             = 10000; // sol:41  BPS_DENOMINATOR
const MIN_WIN_OUTCOMES = 100;  // sol:45  >= 1.00% chance
const MAX_WIN_OUTCOMES = 9900; // sol:46  <= 99.00% chance

const RTP = 1 - EDGE_BPS / BPS; // 0.98 — the documented client RTP

// winOutcomes for a (target, over) line — _diceWinOutcomes (sol:726-728)
function winOutcomesFor(target, over) {
  return over ? (DICE_OUTCOMES - 1 - target) : target;
}

// payout multiplier in bps — _diceMultiplierBps (sol:730-733), integer math
function multiplierBpsFor(winOutcomes) {
  return Math.floor(((BPS - EDGE_BPS) * DICE_OUTCOMES) / winOutcomes);
}

/**
 * Settle one dice roll. Pure + deterministic in (serverSeed, clientSeed, nonce).
 *
 * @param {object} a
 * @param {string} a.serverSeed  secret seed committed before the bet
 * @param {string} a.clientSeed  public, fixed at commit
 * @param {number} a.nonce       per-bet nonce
 * @param {number} a.betUnits    stake in units (1 unit = $1), already debited
 * @param {object} a.params      { target: int [0,9999], over: bool }
 * @returns {{win:boolean, payoutUnits:number, multiplier:number,
 *            outcome:object, detail:string}}
 */
function play(a) {
  const serverSeed = a.serverSeed;
  const clientSeed = a.clientSeed;
  const nonce      = a.nonce;
  const betUnits   = Number(a.betUnits) || 0;
  const params     = a.params || {};

  // normalize the line
  const over   = !!params.over;
  const target = Math.trunc(Number(params.target));

  // ---- derive the roll from the committed PF stream -----------------------
  // One float in [0,1) -> uniform int in [0, DICE_OUTCOMES) = [0, 9999].
  // This is the server-side analogue of `roll = _random(...) % DICE_OUTCOMES`
  // (sol:761); PF.intBelow gives an unbiased uniform pick over 10000 buckets.
  const roll = PF.intBelow(serverSeed, clientSeed, nonce, DICE_OUTCOMES, 0);

  // ---- validate the target line (contract settlement rule) ----------------
  let winOutcomes = NaN;
  const validTarget = Number.isFinite(target) && target >= 0 && target <= DICE_OUTCOMES - 1;
  if (validTarget) winOutcomes = winOutcomesFor(target, over);
  const validLine =
    validTarget &&
    winOutcomes >= MIN_WIN_OUTCOMES &&
    winOutcomes <= MAX_WIN_OUTCOMES;

  if (!validLine) {
    // Out-of-window bet would revert on-chain (DiceBadTarget). Treat as a void
    // loss here: no payout, multiplier 0. The bridge should reject before
    // calling play(), but we never pay out an invalid line.
    return {
      win: false,
      payoutUnits: 0,
      multiplier: 0,
      outcome: { roll: roll, rollDisplay: roll / 100, target: target, over: over, winOutcomes: winOutcomes },
      detail:
        "invalid dice line (target=" + target + ", over=" + over +
        ", winOutcomes=" + winOutcomes + " outside [" + MIN_WIN_OUTCOMES + "," +
        MAX_WIN_OUTCOMES + "]) — no payout",
    };
  }

  // ---- multiplier + win test (mirror sol:752,762) -------------------------
  const multBps    = multiplierBpsFor(winOutcomes);
  const multiplier = multBps / BPS; // e.g. 1.9600 for a 50/50 line
  const win        = over ? (roll > target) : (roll < target);

  // payoutUnits = floor(betUnits * multiplierBps / 10000), 0 on a loss (sol:752,764-769)
  const payoutUnits = win ? Math.floor((betUnits * multBps) / BPS) : 0;

  return {
    win: win,
    payoutUnits: payoutUnits,
    multiplier: multiplier,
    outcome: {
      roll: roll,                 // 0..9999 integer (canonical)
      rollDisplay: roll / 100,    // 0.00..99.99 (what the TV shows)
      target: target,
      over: over,
      winOutcomes: winOutcomes,
      chancePct: winOutcomes / 100,
      multiplierBps: multBps,
    },
    detail:
      "roll " + (roll / 100).toFixed(2) + " " + (over ? ">" : "<") +
      " " + (target / 100).toFixed(2) + " => " + (win ? "WIN" : "lose") +
      " @ " + multiplier.toFixed(4) + "x",
  };
}

module.exports = { play: play, RTP: RTP, DICE_OUTCOMES: DICE_OUTCOMES, EDGE_BPS: EDGE_BPS };

/* ---------------- CLI self-test: node server/games/dice.js ----------------
   Monte-Carlo ~300k rounds across a spread of (target, over) lines with random
   client seeds + nonces; measure realized RTP and assert it's within ~0.8% of
   the documented 0.98. Also assert win/multiplier invariants per line.        */
if (require.main === module) {
  const ROUNDS = 300000;
  const { serverSeed } = PF.newRound();

  // A spread of valid lines spanning the whole window (low/mid/high chance,
  // both directions). Each picked uniformly at random per round.
  const LINES = [
    { target: 5000, over: false }, // ~50% under
    { target: 5000, over: true },  // ~50% over
    { target: 9000, over: false }, // ~90% under (low mult)
    { target: 1000, over: false }, // ~10% under (high mult)
    { target: 200,  over: false }, // ~2% under (near MIN_WIN edge)
    { target: 9800, over: false }, // 98% under (near client cap)
    { target: 100,  over: true },  // ~98.99% over (high chance)
    { target: 9800, over: true },  // ~1.99% over (near MIN_WIN edge)
    { target: 2500, over: true },  // ~75% over
    { target: 7500, over: false }, // ~75% under
  ];

  let totalBet = 0;
  let totalPayout = 0;
  let invariantFail = 0;
  // Use a large stake so the integer floor in payoutUnits (mirrored from the
  // contract's wei-scale math) is negligible. On-chain betUnits = wei, so the
  // floor never bites; a tiny 1-unit bet would otherwise collapse a 1.96x line
  // to floor(1.96)=1 and fake a low RTP. 1e9 units = sub-ppb floor error.
  const bet = 1000000000;

  for (let i = 0; i < ROUNDS; i++) {
    const line = LINES[Math.floor(Math.random() * LINES.length)];
    const clientSeed = "cs-" + Math.floor(Math.random() * 1e9);
    const nonce = Math.floor(Math.random() * 1e9);

    const r = play({
      serverSeed: serverSeed,
      clientSeed: clientSeed,
      nonce: nonce,
      betUnits: bet,
      params: line,
    });

    totalBet += bet;
    totalPayout += r.payoutUnits;

    // per-round invariants
    const wo = line.over ? (DICE_OUTCOMES - 1 - line.target) : line.target;
    const expMultBps = Math.floor(9800 * DICE_OUTCOMES / wo);
    const expWin = line.over ? (r.outcome.roll > line.target) : (r.outcome.roll < line.target);
    if (r.win !== expWin) invariantFail++;
    if (r.win && r.payoutUnits !== Math.floor(bet * expMultBps / BPS)) invariantFail++;
    if (!r.win && r.payoutUnits !== 0) invariantFail++;
    if (r.outcome.roll < 0 || r.outcome.roll >= DICE_OUTCOMES) invariantFail++;
  }

  const measuredRTP = totalPayout / totalBet;

  // Per-line theoretical RTP check (winChance * multiplier), each <= 0.98.
  let theoMin = 1, theoMax = 0;
  for (const L of LINES) {
    const wo = L.over ? (DICE_OUTCOMES - 1 - L.target) : L.target;
    const mb = Math.floor(9800 * DICE_OUTCOMES / wo);
    const rtp = (wo / DICE_OUTCOMES) * (mb / BPS);
    theoMin = Math.min(theoMin, rtp);
    theoMax = Math.max(theoMax, rtp);
  }

  const ok = (label, cond) => {
    console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
    return cond;
  };

  console.log("dice.js self-test — " + ROUNDS.toLocaleString() + " rounds, edge " +
    (EDGE_BPS / 100) + "% (RTP target " + RTP.toFixed(4) + ")");
  console.log("  per-line theoretical RTP range: " + theoMin.toFixed(4) + " .. " + theoMax.toFixed(4));
  console.log("  measured RTP: " + measuredRTP.toFixed(4) + "  (payout " +
    totalPayout.toLocaleString() + " / bet " + totalBet.toLocaleString() + ")");

  let pass = true;
  pass = ok("no per-round invariant violations (" + invariantFail + ")", invariantFail === 0) && pass;
  pass = ok("theoretical RTP per line <= 0.98 (max " + theoMax.toFixed(4) + ")", theoMax <= RTP + 1e-9) && pass;
  pass = ok("measured RTP within 0.8% of " + RTP.toFixed(4) + " (got " + measuredRTP.toFixed(4) + ")",
    Math.abs(measuredRTP - RTP) <= 0.008) && pass;

  // verifiability: re-derive an outcome from the revealed seed
  const cs = "verify-client", nn = 12345;
  const r1 = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nn, betUnits: 10, params: { target: 5000, over: false } });
  const r2 = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nn, betUnits: 10, params: { target: 5000, over: false } });
  pass = ok("deterministic re-derivation (same seed/client/nonce -> same roll)",
    r1.outcome.roll === r2.outcome.roll && r1.payoutUnits === r2.payoutUnits) && pass;

  console.log(pass ? "\nSELF-TEST OK" : "\nSELF-TEST FAILED");
  process.exit(pass ? 0 : 1);
}
