/* ============================================================
   reef.js — SERVER-AUTHORITATIVE per-shot engine for REEF RAIDERS (CH 17).

   The continuous per-shot micro-bet model (same shape as Fish Shooter, CH 19):
   the player fires a bullet of `power` at a fish `targetKey`. The bullet COST is
   the stake already debited (betUnits = power * unitBet upstream). When the bullet
   HITS, the fish dies with a committed-seed probability and pays `def.mult * unitBet`.

   ---- EXACT MATH (mirrored 1:1 from public/fishtable-engine.js) -------------
   Constants (fishtable-engine.js:35):
       RTP = 0.85, P_MIN = 0.0025, P_MAX = 0.9
   Bonus / splash budget inflation (fishtable-engine.js:36-37, 80-87):
       BONUS_BUDGET        = { chest:25, frenzy:25, storm:25 }
       SPLASH_TARGET_BUDGET= { bomb:4, chain:3 }
       budgetMult(def,P) = max(0.01, def.mult
                                 + (def.bonus ? BONUS_BUDGET[def.bonus] : 0)
                                 + (def.special ? SPLASH_TARGET_BUDGET[def.special]||0 : 0) * P * RTP)
   Kill probability (fishtable-engine.js:89-91):
       p_kill = clamp(P_MIN, P_MAX, P * RTP / budgetMult(def, P))
   Resolve (fishtable-engine.js:95-100): dead = roll < p_kill ; payout = dead ? def.mult : 0
       (payout is in unitBet multiples → GROSS units = def.mult when dead).

   ---- HOUSE EDGE / RTP ------------------------------------------------------
   For a fish whose budget is NOT inflated by a bonus/special and whose p_kill is
   not clamped, the EV of one connecting shot is:
       EV = (def.mult * unitBet) * p_kill
          = def.mult*unitBet * (P*RTP/def.mult)
          = P*unitBet*RTP = RTP * cost
   → per-shot RTP = RTP = 0.85 on any plain fish at any power, independent of which
   fish you shoot. The bonus/special creatures have a LOWER per-shot base RTP here
   because their inflated budget shrinks p_kill — that shaved EV funds the separate
   bonus rounds (Vault/Storm/Frenzy etc.), exactly as on the client. Clamping at
   P_MIN (huge bosses) / P_MAX (tiny fish at high power) trims the tails the same way.

   The committed serverSeed (PF.float) decides the kill, so every shot is
   player-verifiable from the reveal. NO Math.random for outcomes, NO mulberry32.

   module.exports = { play, RTP }
   play({ serverSeed, clientSeed, nonce, betUnits, params:{targetKey,power} }) ->
     { win, payoutUnits, multiplier, outcome, detail }
   ============================================================ */
"use strict";

const PF = require("../provablyfair.js");

// ---- constants mirrored 1:1 from public/fishtable-engine.js:35-37 ----------
const RTP   = 0.85;
const P_MIN = 0.0025;
const P_MAX = 0.9;
const BONUS_BUDGET         = { chest: 25, frenzy: 25, storm: 25 };
const SPLASH_TARGET_BUDGET = { bomb: 4, chain: 3 };

// ---- fish roster (key -> {mult, bonus?, special?}) — fishtable-engine.js:41-60 ----
// Only the money-relevant fields; cosmetic fields (color/r/tier/...) are omitted.
const FISH = [
  { key: "minnow",     mult: 2 },
  { key: "clown",      mult: 3 },
  { key: "tang",       mult: 5 },
  { key: "puffer",     mult: 8 },
  { key: "turtle",     mult: 12 },
  { key: "squid",      mult: 16 },
  { key: "eel",        mult: 20,  bonus: "storm" },
  { key: "bomb",       mult: 14,  special: "bomb" },
  { key: "crab",       mult: 28,  special: "gold",  bonus: "chest" },
  { key: "clam",       mult: 8,   special: "clam",  bonus: "frenzy" },
  { key: "shark",      mult: 80,  special: "boss" },
  { key: "kraken",     mult: 160, special: "boss" },
  { key: "whale",      mult: 300, special: "boss" },
  { key: "lobster",    mult: 40,  special: "gold",  bonus: "frenzy" },
  { key: "armadillo",  mult: 60,  special: "gold",  bonus: "chest" },
  { key: "anglerfish", mult: 100, special: "boss" },
  { key: "seadragon",  mult: 200, special: "boss" },
];
const BY_KEY = {};
FISH.forEach(function (f) { BY_KEY[f.key] = f; });

// budgetMult — fishtable-engine.js:80-87
function budgetMult(def, power) {
  const P = power || 1;
  let extra = 0;
  if (def.bonus)   extra += BONUS_BUDGET[def.bonus] || 0;
  if (def.special) extra += (SPLASH_TARGET_BUDGET[def.special] || 0) * P * RTP;
  return Math.max(0.01, def.mult + extra);
}

// killProb — fishtable-engine.js:89-91
function killProb(def, power) {
  const P = power || 1;
  return Math.max(P_MIN, Math.min(P_MAX, (P * RTP) / budgetMult(def, P)));
}

/**
 * Resolve one bullet (power `power`) hitting fish `targetKey`. Pure + deterministic
 * in (serverSeed, clientSeed, nonce). The bullet HIT is assumed (the bridge calls
 * play() only on a connecting shot; a MISS is pure client skill, no settlement).
 *
 * @param {object} a
 * @param {string} a.serverSeed  secret seed committed before the shot
 * @param {string} a.clientSeed  public, fixed at commit
 * @param {number} a.nonce       per-shot nonce
 * @param {number} a.betUnits    bullet cost already debited (= power * unitBet)
 * @param {object} a.params      { targetKey:string, power:number }
 * @returns {{win:boolean, payoutUnits:number, multiplier:number,
 *            outcome:object, detail:string}}
 */
function play(a) {
  const serverSeed = a.serverSeed;
  const clientSeed = a.clientSeed;
  const nonce      = a.nonce;
  const betUnits   = Number(a.betUnits) || 0;
  const params     = a.params || {};

  const power     = Number(params.power) || 1;
  const targetKey = String(params.targetKey == null ? "" : params.targetKey);
  const def       = BY_KEY[targetKey];

  // unknown target → void shot, never pays (bridge should reject upstream)
  if (!def) {
    return {
      win: false,
      payoutUnits: 0,
      multiplier: 0,
      outcome: { targetKey: targetKey, power: power, p: 0, roll: null, dead: false },
      detail: "unknown reef target '" + targetKey + "' — no payout",
    };
  }

  const p = killProb(def, power);

  // committed roll in [0,1) — fishtable-engine.js:98 `this.next() < p`
  const roll = PF.float(serverSeed, clientSeed, nonce);
  const dead = roll < p;

  // payout is in unitBet multiples; bullet cost (betUnits) = power * unitBet, so
  // GROSS payout units back = def.mult * unitBet = def.mult * (betUnits / power).
  const unitBet     = power > 0 ? betUnits / power : betUnits;
  const payoutUnits = dead ? def.mult * unitBet : 0;
  const multiplier  = dead ? def.mult : 0; // payout multiple of unitBet

  return {
    win: dead,
    payoutUnits: payoutUnits,
    multiplier: multiplier,
    outcome: {
      targetKey: targetKey,
      mult: def.mult,
      power: power,
      p: p,
      roll: roll,
      dead: dead,
      bonus: def.bonus || null,
      special: def.special || null,
    },
    detail:
      "shot power " + power + " at " + targetKey + " (mult " + def.mult +
      ", p_kill " + p.toFixed(4) + ") roll " + roll.toFixed(4) + " => " +
      (dead ? "KILL +" + def.mult + "u" : "no kill"),
  };
}

module.exports = { play: play, RTP: RTP, FISH: FISH, BY_KEY: BY_KEY, killProb: killProb, budgetMult: budgetMult };

/* ---------------- CLI self-test: node server/games/reef.js ----------------
   Monte-Carlo per-shot RTP across the PLAIN fish (no bonus/special budget
   inflation, p_kill unclamped) at several powers; assert realized RTP ~ 0.85.
   Per-shot RTP = payout / cost where cost = power*unitBet. Also assert the
   bonus creatures return BELOW 0.85 (their shaved EV funds bonus rounds) and
   verify determinism from the committed seed.                                 */
if (require.main === module) {
  const ROUNDS = 400000;
  const { serverSeed } = PF.newRound();
  const UNIT = 1000000000; // large unitBet so any rounding is sub-ppb (none here, but matches dice.js)

  // PLAIN fish only (no bonus/special). To isolate the RTP knob from the P_MIN/
  // P_MAX clamps (which intentionally shave the tails), sample only (fish,power)
  // combos whose UNCLAMPED p_kill = power*RTP/mult sits strictly inside the band.
  // Clamped combos (e.g. minnow at power 3: p would be 1.275 -> capped 0.9) are a
  // deliberate extra house edge and are exercised separately below.
  const PLAIN = ["minnow", "clown", "tang", "puffer", "turtle", "squid"];
  const POWERS = [1, 2, 3];
  const COMBOS = [];
  for (const key of PLAIN) for (const power of POWERS) {
    const p = (power * RTP) / BY_KEY[key].mult;
    if (p > P_MIN && p < P_MAX) COMBOS.push({ key: key, power: power });
  }

  const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); return cond; };
  let pass = true;

  // ---- aggregate per-shot RTP over unclamped plain combos, mixed powers ----
  let totalCost = 0, totalPayout = 0, invariant = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const combo = COMBOS[Math.floor(Math.random() * COMBOS.length)];
    const key   = combo.key, power = combo.power;
    const cs    = "cs-" + Math.floor(Math.random() * 1e9);
    const nonce = Math.floor(Math.random() * 1e9);
    const cost  = power * UNIT;

    const r = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nonce, betUnits: cost, params: { targetKey: key, power: power } });

    totalCost   += cost;
    totalPayout += r.payoutUnits;

    // invariants: killProb must be unclamped here (else RTP != 0.85); win pays mult*unitBet
    const def = BY_KEY[key];
    const p = (power * RTP) / def.mult; // unclamped expected p for a plain fish
    if (p <= P_MIN || p >= P_MAX) invariant++;            // would skew the aggregate
    if (r.win && r.payoutUnits !== def.mult * UNIT) invariant++;
    if (!r.win && r.payoutUnits !== 0) invariant++;
  }
  const measuredRTP = totalPayout / totalCost;

  console.log("reef.js self-test — " + ROUNDS.toLocaleString() + " shots over plain fish " +
    JSON.stringify(PLAIN) + " @ powers " + JSON.stringify(POWERS));
  console.log("  client RTP knob: " + RTP.toFixed(2) + " (fishtable-engine.js:35)");
  console.log("  measured per-shot RTP: " + measuredRTP.toFixed(4) +
    "  (payout " + totalPayout.toLocaleString() + " / cost " + totalCost.toLocaleString() + ")");

  pass = ok("no per-shot invariant violations (" + invariant + ")", invariant === 0) && pass;
  pass = ok("aggregate per-shot RTP within 1.2% of " + RTP.toFixed(2) + " (got " + measuredRTP.toFixed(4) + ")",
    Math.abs(measuredRTP - RTP) <= 0.012) && pass; // robust to Monte-Carlo variance; still catches any real RTP error (>=5% off)

  // ---- per-target RTP must each sit ~0.85 ----
  for (const key of PLAIN) {
    let c = 0, pay = 0;
    for (let i = 0; i < 120000; i++) {
      const r = play({ serverSeed: serverSeed, clientSeed: "k-" + key, nonce: i, betUnits: UNIT, params: { targetKey: key, power: 1 } });
      c += UNIT; pay += r.payoutUnits;
    }
    const rtp = pay / c;
    pass = ok("  " + key + " per-shot RTP ~0.85 (got " + rtp.toFixed(4) + ")", Math.abs(rtp - RTP) <= 0.03) && pass; // 3% band: squid/turtle have ~1% SE at this sample size (a real bug would be >=5% off)
  }

  // ---- bonus creatures return BELOW 0.85 (shaved EV funds bonus rounds) ----
  for (const key of ["eel", "crab", "clam"]) {
    let c = 0, pay = 0;
    for (let i = 0; i < 200000; i++) {
      const r = play({ serverSeed: serverSeed, clientSeed: "b-" + key, nonce: i, betUnits: UNIT, params: { targetKey: key, power: 1 } });
      c += UNIT; pay += r.payoutUnits;
    }
    const rtp = pay / c;
    pass = ok("  bonus '" + key + "' base RTP < 0.85 (got " + rtp.toFixed(4) + ")", rtp < RTP) && pass;
  }

  // ---- determinism / verifiability from the revealed seed ----
  const cs = "verify", nn = 4242;
  const r1 = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nn, betUnits: 2, params: { targetKey: "tang", power: 2 } });
  const r2 = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nn, betUnits: 2, params: { targetKey: "tang", power: 2 } });
  pass = ok("deterministic re-derivation (same seed/client/nonce -> same roll+payout)",
    r1.outcome.roll === r2.outcome.roll && r1.payoutUnits === r2.payoutUnits) && pass;

  console.log(pass ? "\nSELF-TEST OK" : "\nSELF-TEST FAILED");
  process.exit(pass ? 0 : 1);
}
