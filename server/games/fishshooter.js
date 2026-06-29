/* ============================================================
   fishshooter.js — SERVER-AUTHORITATIVE PER-SHOT engine for "FISH SHOOTER" (CH 19).

   PURE FUNCTION mirror of the client money/odds brain in
   public/fishshooter-engine.js (globalThis.FishShooterEngine). Fish Shooter is a
   CONTINUOUS table: there are no discrete "rounds" — every BULLET is a micro-bet.
   The client sends shot INTENT only (which fish it aimed at + the cannon power);
   the server owns the outcome, derived from a PF seed committed before the shot so
   any player can re-derive the catch from the reveal. NO Math.random for outcomes.

   ---- THE MICRO-BET ------------------------------------------------------------
   A bullet of power P costs  cost = unitBet * P  (= betUnits, already debited).
   So  unitBet = betUnits / P  (the table's base stake; what every mult multiplies).
   A HIT on the aimed fish kills it with probability
        p_kill = clamp(P*RTP / budgetMult, P_MIN, P_MAX)          (engine line 89-91)
   and a kill pays GROSS  def.mult * unitBet  back (0 on a non-kill / miss).

   ---- EXACT MATH (cited: public/fishshooter-engine.js) -------------------------
   RTP knob ....... RTP   = 0.95          (line 34)  — flat per-connecting-shot return
   prob clamps .... P_MIN = 0.0025, P_MAX = 0.9      (line 34)
   bonus budget ... BONUS_BUDGET   = { chest:25, frenzy:25, storm:25 }   (line 35)
   splash budget .. SPLASH_TARGET_BUDGET = { bomb:4, chain:3 }           (line 36)
   roster ......... FISH[] (lines 39-63), mult + weight + special/bonus per fish.

   budgetMult(target,power) (engine lines 81-88):
       extra  = (def.bonus   ? BONUS_BUDGET[def.bonus]        : 0)
              + (def.special ? SPLASH_TARGET_BUDGET[def.special]*power*RTP : 0)
       budget = max(0.01, def.mult + extra)
   killProb(target,power) (engine lines 89-91):
       p = clamp(power*RTP / budget, P_MIN, P_MAX)
   resolveHit (engine lines 92-97): dead = rng() < p ; payout = dead ? mult : 0.

   ---- WHY EV IS FLAT & TARGET-INDEPENDENT --------------------------------------
   For a PLAIN fish (no bonus, no splash), budget = mult, so
       p_kill = P*RTP/mult  (well clear of both clamps: see the engine's invariants
       — min mult 6 ≥ 2*0.95/0.9 = 2.11, and whale 300 → 0.95/300 = 0.00317 > P_MIN),
   and the EV per connecting shot is
       EV = (mult*unitBet)*p_kill = mult*unitBet*(P*RTP/mult) = P*unitBet*RTP = RTP*cost.
   => a flat ~95% return on EVERY connecting shot, independent of which fish you aim
   at. This is the FULL v1 return: the bonus/jackpot EV is FOLDED IN by the same
   budgetMult mechanism the client already uses — the `extra` budget on bonus/splash
   fish lowers their kill-prob so their *direct* catch pays less, and that withheld
   slice is exactly the EV the client later disburses as a bonus wave / splash kill.
   So per-shot EV stays RTP*cost across all targets; we do NOT separately add a
   bonus payout here (see NOTE below for how full bonus rounds layer on later).

   ---- RTP ----------------------------------------------------------------------
   Per CONNECTING shot, RTP ≈ 0.95 (target-independent, both in-game powers). The
   client docs (engine lines 25-33) note auto-fire OVERKILL erodes the *realized*
   table RTP below 0.95 (x1≈95% felt-on-catches, x2≈85-90%, x3 cratered → power
   capped at 2). That overkill is a CLIENT firing-cadence effect (redundant bullets
   on an already-dead fish), NOT part of the per-shot settlement this engine owns —
   so the per-shot RTP this module measures is the pure 0.95 knob.

   ---- POWER --------------------------------------------------------------------
   In-game power is 1..2 (capped at x2; see engine line 18). We clamp here too.

   ---- EXPORTS ------------------------------------------------------------------
   module.exports = { play, RTP, FISH, BY_KEY, killProb, budgetMult }
   play({ serverSeed, clientSeed, nonce, betUnits, params:{targetKey,power} }) ->
     { win, payoutUnits, multiplier, outcome, detail }
   ============================================================ */
"use strict";

const PF = require("../provablyfair.js");

// ---- constants mirrored 1:1 from public/fishshooter-engine.js ----------------
const RTP   = 0.95;    // line 34 — flat per-connecting-shot return knob
const P_MIN = 0.0025;  // line 34
const P_MAX = 0.9;     // line 34
const POWER_MIN = 1, POWER_MAX = 2; // in-game power range (engine line 18: capped x2)

const BONUS_BUDGET         = { chest: 25, frenzy: 25, storm: 25 }; // line 35
const SPLASH_TARGET_BUDGET = { bomb: 4, chain: 3 };                // line 36

// fish roster — mult/weight/special/bonus copied verbatim from FISH[] (lines 39-63).
// (Only the money-relevant fields are kept; render fields like color/r are dropped.)
const FISH = [
  { id: 0,  key: "minnow",     mult: 6,   tier: "small",   weight: 26 },
  { id: 1,  key: "clown",      mult: 7,   tier: "small",   weight: 22 },
  { id: 2,  key: "tang",       mult: 8,   tier: "small",   weight: 16 },
  { id: 3,  key: "puffer",     mult: 8,   tier: "medium",  weight: 11 },
  { id: 4,  key: "turtle",     mult: 12,  tier: "medium",  weight: 8 },
  { id: 5,  key: "squid",      mult: 16,  tier: "medium",  weight: 6 },
  { id: 6,  key: "eel",        mult: 20,  tier: "special", weight: 4 },
  { id: 7,  key: "bomb",       mult: 14,  tier: "special", weight: 4,   special: "bomb" },
  { id: 8,  key: "crab",       mult: 28,  tier: "special", weight: 3,   special: "gold" },
  { id: 11, key: "clam",       mult: 8,   tier: "special", weight: 2.6, special: "clam" },
  { id: 9,  key: "shark",      mult: 80,  tier: "boss",    weight: 1.3, special: "boss" },
  { id: 10, key: "kraken",     mult: 160, tier: "boss",    weight: 0.5, special: "boss" },
  { id: 12, key: "whale",      mult: 300, tier: "boss",    weight: 0.28, special: "boss" },
  { id: 13, key: "lobster",    mult: 40,  tier: "special", weight: 1.6, special: "gold" },
  { id: 14, key: "armadillo",  mult: 60,  tier: "special", weight: 1.1, special: "gold" },
  { id: 15, key: "anglerfish", mult: 100, tier: "boss",    weight: 0.8, special: "boss" },
  { id: 16, key: "seadragon",  mult: 200, tier: "boss",    weight: 0.4, special: "boss" },
  // dedicated bonus-round creatures (engine lines 60-62): catching one triggers a
  // wave; budgetMult adds BONUS_BUDGET[bonus] (=25) so its direct catch pays less,
  // pre-funding that wave's EV.
  { id: 17, key: "warturtle",  mult: 18,  tier: "special", weight: 0.8, special: "gold", bonus: "chest" },
  { id: 18, key: "gator",      mult: 18,  tier: "special", weight: 0.8, special: "gold", bonus: "storm" },
  { id: 19, key: "stormjelly", mult: 18,  tier: "special", weight: 0.8, special: "gold", bonus: "frenzy" },
];
const BY_KEY = {};
FISH.forEach(function (f) { BY_KEY[f.key] = f; });

// ---- budgetMult / killProb — byte-mirror of engine lines 81-91 ----------------
// `target` is a fish def object (from BY_KEY). Same shape as the client (which also
// accepts a bare number, but here we always resolve to a def first).
function budgetMult(def, power) {
  const mult = def.mult;
  let extra = 0;
  if (def.bonus)   extra += BONUS_BUDGET[def.bonus] || 0;
  if (def.special) extra += (SPLASH_TARGET_BUDGET[def.special] || 0) * (power || 1) * RTP;
  return Math.max(0.01, mult + extra);
}
function killProb(def, power) {
  return Math.max(P_MIN, Math.min(P_MAX, (power || 1) * RTP / budgetMult(def, power)));
}

/**
 * Settle ONE bullet (micro-bet). Pure + deterministic in (serverSeed, clientSeed, nonce).
 *
 * @param {object} a
 * @param {string} a.serverSeed  secret seed committed before the shot
 * @param {string} a.clientSeed  public, fixed at commit
 * @param {number} a.nonce       per-shot nonce (every bullet gets its own)
 * @param {number} a.betUnits    shot COST in units (= unitBet * power), already debited
 * @param {object} a.params      { targetKey: string, power: 1..2 }
 * @returns {{win:boolean, payoutUnits:number, multiplier:number,
 *            outcome:object, detail:string}}
 */
function play(a) {
  const serverSeed = a.serverSeed;
  const clientSeed = a.clientSeed;
  const nonce      = a.nonce;
  const cost       = Number(a.betUnits) || 0; // the bullet cost = unitBet * power
  const params     = a.params || {};

  // normalize the shot intent
  const targetKey = String(params.targetKey == null ? "" : params.targetKey);
  let power = Math.trunc(Number(params.power));
  if (!Number.isFinite(power)) power = POWER_MIN;
  power = Math.max(POWER_MIN, Math.min(POWER_MAX, power)); // clamp to in-game 1..2

  const def = BY_KEY[targetKey];

  // unitBet = cost / power (the base stake the fish mult multiplies). Power is >=1
  // after the clamp, so this never divides by zero.
  const unitBet = cost / power;

  // ---- invalid target: not a real fish key → void (no payout) ----------------
  if (!def) {
    return {
      win: false,
      payoutUnits: 0,
      multiplier: 0,
      outcome: { targetKey: targetKey, power: power, p: 0, dead: false },
      detail: "invalid target '" + targetKey + "' — no such fish; no payout",
    };
  }

  // ---- derive the catch from the committed PF stream -------------------------
  // One float in [0,1) < p_kill => the fish dies (engine resolveHit, line 95).
  const p   = killProb(def, power);
  const roll = PF.float(serverSeed, clientSeed, nonce);
  const dead = roll < p;

  // a kill pays GROSS def.mult * unitBet back (engine line 96: payout = mult on a kill).
  const multiplier  = def.mult; // payout as a multiple of unitBet
  const payoutUnits = dead ? def.mult * unitBet : 0;

  return {
    win: dead,
    payoutUnits: payoutUnits,
    multiplier: multiplier,
    outcome: {
      targetKey: targetKey,
      fishId: def.id,
      tier: def.tier,
      power: power,
      unitBet: unitBet,
      cost: cost,
      p: p,                      // kill probability used
      budgetMult: budgetMult(def, power),
      roll: roll,                // the PF float (canonical, re-derivable)
      dead: dead,
      bonus: def.bonus || null,  // NOTE: client triggers a wave on a kill of a bonus fish
    },
    detail:
      "shot @ " + targetKey + " (mult " + def.mult + "x, power " + power + ", p_kill " +
      p.toFixed(4) + ") roll " + roll.toFixed(4) + " => " +
      (dead ? ("CATCH pays " + payoutUnits.toFixed(2) + " (" + def.mult + "x unit " + unitBet.toFixed(2) + ")") : "fish survives"),
  };
}

/* ----------------------------------------------------------------------------
   NOTE — how FULL bonus rounds layer on later (v2):
   In v1 the EV of the bonus/jackpot is FOLDED into the per-shot return: a bonus/
   splash fish carries `extra` budget (BONUS_BUDGET / SPLASH_TARGET_BUDGET) that
   lowers its direct kill-prob, so the slice it does NOT pay on the catch is exactly
   the EV reserved for its wave. Per-shot EV therefore stays RTP*cost on every
   connecting shot, target-independent — which is what this module settles.

   A v2 that actually disburses bonus waves would, on a kill where def.bonus is set
   (or a splash special), enter a sub-session keyed on a FRESH PF nonce range and
   pay out an extra stream whose EXPECTED total equals the withheld budget
   (BONUS_BUDGET[bonus] * unitBet for a bonus wave; SPLASH_TARGET_BUDGET[special]
   *power*RTP*unitBet for splash collateral). Because that expectation already equals
   the slice removed from the direct catch above, layering it on leaves total RTP at
   0.95 — the budgetMult bookkeeping is the single source of truth for the split.
   ---------------------------------------------------------------------------- */

module.exports = {
  play: play,
  RTP: RTP,
  P_MIN: P_MIN,
  P_MAX: P_MAX,
  FISH: FISH,
  BY_KEY: BY_KEY,
  killProb: killProb,
  budgetMult: budgetMult,
};

/* ---------------- CLI self-test: node server/games/fishshooter.js ----------------
   Monte-Carlo many shots across a spread of TARGET fish + BOTH powers, measuring
   the per-CONNECTING-shot RTP. Per connecting shot, EV = payout (mult*unitBet on a
   kill, else 0) over cost; misses are pure skill and not settled here.

   Two distinct expectations, both straight from the client engine math:
   (1) PLAIN fish (no `special`, no `bonus`): budget = mult, so the DIRECT catch RTP
       is the flat 0.95 knob (target- AND power-independent). This is the headline
       per-shot RTP the engine advertises — assert each plain (target,power) ~0.95.
   (2) BONUS/SPLASH fish (bomb/clam/crab/boss/bonus-triggers): budgetMult adds
       `extra`, so their DIRECT catch RTP is BELOW 0.95 ON PURPOSE — the withheld
       slice is the bonus/splash EV folded in (disbursed later as a wave/splash; see
       the v2 NOTE above). For these we assert the direct RTP equals the EXPECTED
       folded value mult/budget*0.95 (i.e. < 0.95), proving the budget split is
       faithful rather than leaking money. The full per-shot RTP (direct + folded
       bonus) is still 0.95 for them too; v1 only settles the direct slice. */
if (require.main === module) {
  const { serverSeed } = PF.newRound();
  const POWERS = [1, 2];
  // Large base unit so the analog payout (mult*unitBet) has no float-precision drift.
  const UNIT = 1e6;

  const ok = function (label, cond) {
    console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
    return cond;
  };

  // A fish is ECONOMICALLY PLAIN when budgetMult == mult (no `extra`): then its
  // DIRECT catch RTP is the flat 0.95 knob. Note `special:"gold"/"boss"` add NO
  // budget (only "bomb"/"chain" are in SPLASH_TARGET_BUDGET), so crab/shark/whale
  // etc. are plain too; only `bomb` (splash) and the bonus-trigger fish fold EV out.
  function isPlain(def, power) {
    return Math.abs(budgetMult(def, power) - def.mult) < 1e-9;
  }

  // Run one (target,power) cell. Per-shot variance of payout (in cost units) is
  // mult^2*p(1-p)/power^2; size the sample so the RTP std-error is < ~0.0018, then
  // assert within ~4 std-errs. Rare high-mult fish auto-get more shots this way.
  function runCell(targetKey, power, baseNonce) {
    const def = BY_KEY[targetKey];
    const expP = killProb(def, power);
    const expDirect = def.mult / budgetMult(def, power) * RTP;
    // per-shot payout/cost = mult/power on a kill; variance:
    const perVar = Math.pow(def.mult / power, 2) * expP * (1 - expP);
    const targetSE = 0.0022;
    let SHOTS = Math.ceil(perVar / (targetSE * targetSE));
    SHOTS = Math.max(40000, Math.min(SHOTS, 2000000));
    const cost = UNIT * power; // betUnits = unitBet*power, unitBet = UNIT
    let totalCost = 0, totalPayout = 0, fail = 0;
    for (let i = 0; i < SHOTS; i++) {
      const r = play({
        serverSeed: serverSeed,
        clientSeed: "cs-" + targetKey + "-" + power,
        nonce: baseNonce + i,
        betUnits: cost,
        params: { targetKey: targetKey, power: power },
      });
      totalCost += cost;
      totalPayout += r.payoutUnits;
      if (Math.abs(r.outcome.p - expP) > 1e-12) fail++;
      if (r.win && Math.abs(r.payoutUnits - def.mult * UNIT) > 1e-3) fail++;
      if (!r.win && r.payoutUnits !== 0) fail++;
      if (r.win !== (r.outcome.roll < expP)) fail++;
    }
    const rtp = totalPayout / totalCost;
    const se = Math.sqrt(perVar / SHOTS); // std-error of the realized RTP
    return { rtp: rtp, p: expP, fail: fail, expDirect: expDirect, se: se, shots: SHOTS };
  }

  // Spread across every tier + both economic classes. (We skip the mult-200/300
  // whale/seadragon here: at p≈0.003 their realized RTP needs >6M shots to settle —
  // shark (mult 80, boss tier) already proves the high-mult boss path. The full
  // overall-RTP analysis lives in the Lundberg economy study, task #33.)
  const TARGETS = ["minnow", "tang", "puffer", "turtle", "squid", "eel",
                   "crab", "clam", "shark",       // plain (gold/boss add no budget)
                   "bomb", "warturtle", "gator"]; // folded (splash / bonus-trigger)

  console.log("fishshooter.js self-test — variance-sized Monte-Carlo (RTP knob " + RTP.toFixed(4) + ")");
  console.log("  PLAIN fish: direct RTP == flat " + RTP.toFixed(4) +
    " | FOLDED (bonus/splash): direct RTP == mult/budget*" + RTP.toFixed(4) + " (< 0.95, rest is bonus EV)");

  let pass = true, invariantFail = 0, nonce = 1;
  let plainMaxErrSE = 0, foldedMaxErrSE = 0;

  TARGETS.forEach(function (k) {
    POWERS.forEach(function (pw) {
      const c = runCell(k, pw, (nonce += 7000001));
      invariantFail += c.fail;
      const def = BY_KEY[k];
      const plain = isPlain(def, pw);
      const expect = plain ? RTP : c.expDirect;
      const errSE = Math.abs(c.rtp - expect) / c.se; // deviation in std-errors
      if (plain) plainMaxErrSE = Math.max(plainMaxErrSE, errSE);
      else       foldedMaxErrSE = Math.max(foldedMaxErrSE, errSE);
      console.log("    " + (k + "@x" + pw).padEnd(14) + (plain ? "PLAIN " : "FOLD  ") +
        "p " + c.p.toFixed(4) + "  RTP " + c.rtp.toFixed(4) +
        "  exp " + expect.toFixed(4) + "  (" + errSE.toFixed(1) + " SE, n=" +
        (c.shots / 1000).toFixed(0) + "k)");
    });
  });

  pass = ok("no per-shot invariant violations (" + invariantFail + ")", invariantFail === 0) && pass;
  pass = ok("every PLAIN direct RTP == 0.95 within 5 SE (max " + plainMaxErrSE.toFixed(1) + " SE)",
    plainMaxErrSE <= 5) && pass;
  pass = ok("every FOLDED direct RTP == mult/budget*0.95 within 5 SE (max " + foldedMaxErrSE.toFixed(1) + " SE)",
    foldedMaxErrSE <= 5) && pass;

  // verifiability: re-derive an outcome from the revealed seed
  const cs = "verify-client", nn = 98765;
  const r1 = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nn, betUnits: 2, params: { targetKey: "shark", power: 2 } });
  const r2 = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nn, betUnits: 2, params: { targetKey: "shark", power: 2 } });
  pass = ok("deterministic re-derivation (same seed/client/nonce -> same roll+payout)",
    r1.outcome.roll === r2.outcome.roll && r1.payoutUnits === r2.payoutUnits) && pass;

  // invalid target voids
  const rv = play({ serverSeed: serverSeed, clientSeed: cs, nonce: 1, betUnits: 5, params: { targetKey: "nope", power: 1 } });
  pass = ok("invalid target pays nothing", rv.win === false && rv.payoutUnits === 0) && pass;

  console.log(pass ? "\nSELF-TEST OK" : "\nSELF-TEST FAILED");
  process.exit(pass ? 0 : 1);
}
