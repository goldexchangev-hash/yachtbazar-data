/* ============================================================
   coinflip.js — SERVER-AUTHORITATIVE engine for CH 8 "Coin Flip".

   Pure function mirror of the on-chain settlement in
   contracts/CoinFlipBetting.sol::_settle (vs-house path) and the client
   reveal math in public/app.js::flipReveal / updateFlipButton.

   THE MATH (cited):
     • Fair 50/50 coin. Contract: headsLanded = (_random % 2 == 0), and the
       player (room creator) wins when headsLanded == their chosen side.
       (CoinFlipBetting.sol:580-582)
     • On a win the winner takes the POT minus a flat 3% house fee:
           pot     = bet * 2
           fee     = pot * HOUSE_FEE_BPS / 10000   (HOUSE_FEE_BPS = 300 → 3%)
           payout  = pot - fee  =  bet * 2 * 0.97  =  1.94 * bet   (GROSS back)
       (CoinFlipBetting.sol:40, 584-586  +  app.js:149 "pot minus the 3% house
        cut → 1.94× stake"  +  app.js:304 win hint = stake * 0.94 net profit)
     • House edge = 3% (HOUSE_FEE_BPS). On a fair coin this IS the player edge.
       (CoinFlipBetting.sol:37-40)

   RTP  = P(win) * winMultiplier  =  0.5 * 1.94  =  0.97  (3% house edge).

   params: { side }  — 0 or 1 (e.g. 0 = heads, 1 = tails). Defaults to 0.
   win    = chosen side equals the coin's landed side.
   ============================================================ */
"use strict";

const PF = require("../provablyfair.js");

// Mirror of the contract constant (basis points). 300 bps = 3% house fee.
const HOUSE_FEE_BPS = 300;
const BPS_DENOMINATOR = 10000;

// Win multiplier as a contract-exact ratio: pot(2) minus the 3% fee = 1.94.
// Kept as integer bps internally so it matches the on-chain integer math 1:1.
const WIN_MULT_BPS = 2 * (BPS_DENOMINATOR - HOUSE_FEE_BPS); // 2 * 9700 = 19400 = 1.94x

// Documented RTP (for the self-test tolerance check): 0.5 * 1.94 = 0.97.
const RTP = 0.97;

/**
 * Settle one coin flip.
 * @returns {win, payoutUnits, multiplier, outcome, detail}
 */
function play({ serverSeed, clientSeed, nonce, betUnits, params }) {
  const bet = Number(betUnits) || 0;
  // Normalize the chosen side to 0/1 (0 = heads, 1 = tails). Anything truthy
  // non-zero collapses to 1 so a bad param can't dodge the 50/50.
  const sideRaw = params && params.side != null ? params.side : 0;
  const side = Number(sideRaw) ? 1 : 0;

  // Fair coin from the committed stream: first float → 0/1. This is the direct
  // analogue of the contract's (_random % 2) — an even split of [0,1).
  const landed = PF.intBelow(serverSeed, clientSeed, nonce, 2, 0); // 0 or 1

  const win = landed === side;

  // GROSS returned to the player. Integer-exact to the contract:
  //   payout = bet * WIN_MULT_BPS / BPS_DENOMINATOR  =  bet * 1.94
  // (For the abstract unit ledger we keep the float result; the bridge scales
  //  units→wei downstream where the contract's exact integer division applies.)
  const payoutUnits = win ? (bet * WIN_MULT_BPS) / BPS_DENOMINATOR : 0;
  const multiplier = win ? WIN_MULT_BPS / BPS_DENOMINATOR : 0; // 1.94 or 0

  const sideName = (s) => (s === 0 ? "heads" : "tails");
  const detail =
    "coin landed " + sideName(landed) + " — you picked " + sideName(side) +
    (win ? " · WIN " + (WIN_MULT_BPS / BPS_DENOMINATOR).toFixed(2) + "x" : " · LOSE");

  return {
    win: win,
    payoutUnits: payoutUnits,
    multiplier: multiplier,
    outcome: { landed: landed, side: side }, // 0/1 each
    detail: detail,
  };
}

module.exports = { play: play, RTP: RTP };

/* ---------------- CLI self-test: node server/games/coinflip.js ---------------- */
if (require.main === module) {
  const ROUNDS = 300000;
  const bet = 1; // 1 unit stake

  let wagered = 0;
  let returned = 0;
  let wins = 0;

  // A fresh committed seed per round (as in production), with random client
  // seeds + nonces, so the Monte-Carlo exercises the real PF stream end-to-end.
  for (let i = 0; i < ROUNDS; i++) {
    const { serverSeed } = PF.newRound();
    const clientSeed = "mc-" + Math.floor(Math.random() * 1e9).toString(36);
    const nonce = Math.floor(Math.random() * 1e9);
    const side = Math.random() < 0.5 ? 0 : 1; // player picks a random side each round

    const r = play({ serverSeed, clientSeed, nonce, betUnits: bet, params: { side } });

    wagered += bet;
    returned += r.payoutUnits;
    if (r.win) wins++;

    // Per-round invariant: a win pays EXACTLY 1.94x, a loss pays 0.
    if (r.win && Math.abs(r.payoutUnits - bet * 1.94) > 1e-9) {
      console.log("  FAIL  win payout not 1.94x:", r.payoutUnits);
      process.exit(1);
    }
    if (!r.win && r.payoutUnits !== 0) {
      console.log("  FAIL  loss payout not 0:", r.payoutUnits);
      process.exit(1);
    }
  }

  const measuredRTP = returned / wagered;
  const winRate = wins / ROUNDS;
  const documented = RTP; // 0.97

  console.log("Coin Flip — server engine self-test");
  console.log("  rounds          : " + ROUNDS);
  console.log("  win rate        : " + (winRate * 100).toFixed(3) + "%  (expect ~50%)");
  console.log("  win multiplier  : 1.94x  (pot*2 - 3% fee)");
  console.log("  documented RTP  : " + (documented * 100).toFixed(2) + "%");
  console.log("  measured  RTP   : " + (measuredRTP * 100).toFixed(3) + "%");

  const rtpOk = Math.abs(measuredRTP - documented) <= 0.008; // within ~0.8%
  const winOk = Math.abs(winRate - 0.5) <= 0.01; // fair coin sanity

  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };
  eq("measured RTP within 0.8% of documented 97%", rtpOk);
  eq("win rate ~50% (fair coin)", winOk);

  // Determinism: identical inputs → identical outcome.
  const seed = PF.newRound().serverSeed;
  const a = play({ serverSeed: seed, clientSeed: "det", nonce: 42, betUnits: 1, params: { side: 0 } });
  const b = play({ serverSeed: seed, clientSeed: "det", nonce: 42, betUnits: 1, params: { side: 0 } });
  eq("deterministic for identical inputs", JSON.stringify(a) === JSON.stringify(b));

  // Picking the opposite side on the same flip must invert the win.
  const h = play({ serverSeed: seed, clientSeed: "det", nonce: 42, betUnits: 1, params: { side: 0 } });
  const t = play({ serverSeed: seed, clientSeed: "det", nonce: 42, betUnits: 1, params: { side: 1 } });
  eq("opposite side flips the result on the same coin", h.win !== t.win);

  console.log(ok ? "\nSELF-TEST OK" : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
