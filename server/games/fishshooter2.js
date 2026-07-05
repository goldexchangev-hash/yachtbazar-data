/* ============================================================
   fishshooter2.js — SERVER-AUTHORITATIVE PER-SHOT engine for "FISH SHOOTER V2 · NEON ABYSS".
   OWN module, decoupled from v1 (owner: v2 is disableable; v1 stays untouched).

   PURE FUNCTION mirror of the client money/odds brain in
   public/fishshooter2-engine.js (globalThis.FishShooter2Engine). Fish Shooter is a
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

   ---- EXACT MATH (cited: public/fishshooter2-engine.js) -------------------------
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

// ---- constants mirrored 1:1 from public/fishshooter2-engine.js ----------------
const RTP   = 0.95;    // line 34 — flat per-connecting-shot return knob
const P_MIN = 0.0025;  // line 34
const P_MAX = 0.9;     // line 34
const POWER_MIN = 1, POWER_MAX = 2; // in-game power range (engine line 18: capped x2)

const BONUS_BUDGET         = { chest: 25, frenzy: 25, storm: 25 }; // line 35
const SPLASH_TARGET_BUDGET = { bomb: 4, chain: 3 };                // line 36

// fish roster — mult/weight/special/bonus copied verbatim from FISH[] (lines 39-63).
// (Only the money-relevant fields are kept; render fields like color/r are dropped.)
const FISH = [
  { id: 0,  key: "wisp",       mult: 6,   tier: "small",   weight: 26 },
  { id: 1,  key: "ember",      mult: 7,   tier: "small",   weight: 22 },
  { id: 2,  key: "prism",      mult: 8,   tier: "small",   weight: 16 },
  { id: 3,  key: "lantern",    mult: 8,   tier: "medium",  weight: 11 },
  { id: 4,  key: "ray",        mult: 12,  tier: "medium",  weight: 8 },
  { id: 5,  key: "hatchet",    mult: 16,  tier: "medium",  weight: 6 },
  { id: 6,  key: "voltjelly",  mult: 20,  tier: "special", weight: 4 },
  { id: 7,  key: "minecrab",   mult: 14,  tier: "special", weight: 4,   special: "bomb" },
  { id: 8,  key: "aurum",      mult: 28,  tier: "special", weight: 3,   special: "gold" },
  { id: 11, key: "nautilus",   mult: 8,   tier: "special", weight: 2.6, special: "nautilus" },
  { id: 9,  key: "hammer",     mult: 80,  tier: "boss",    weight: 1.3, special: "boss" },
  { id: 10, key: "voidkraken", mult: 160, tier: "boss",    weight: 0.5, special: "boss" },
  { id: 12, key: "solaris",    mult: 300, tier: "boss",    weight: 0.28, special: "boss" },
  { id: 13, key: "mantis",     mult: 40,  tier: "special", weight: 1.6, special: "gold" },
  { id: 14, key: "isopod",     mult: 60,  tier: "special", weight: 1.1, special: "gold" },
  { id: 15, key: "sovereign",  mult: 100, tier: "boss",    weight: 0.8, special: "boss" },
  { id: 16, key: "aurora",     mult: 200, tier: "boss",    weight: 0.4, special: "boss" },
  // dedicated bonus-round creatures: catching one triggers a wave; budgetMult adds
  // BONUS_BUDGET[bonus] (=25) so its direct catch pays less, pre-funding that wave's EV.
  { id: 17, key: "vaultback",  mult: 18,  tier: "special", weight: 0.8, special: "gold", bonus: "chest" },
  { id: 18, key: "tempest",    mult: 18,  tier: "special", weight: 0.8, special: "gold", bonus: "storm" },
  { id: 19, key: "bloom",      mult: 18,  tier: "special", weight: 0.8, special: "gold", bonus: "frenzy" },
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

// ── v2 BONUS / SPLASH DISBURSEMENT ────────────────────────────────────────────
// On a KILL of a bonus-trigger fish (def.bonus) or a splash fish (def.special in
// {bomb,chain}), pay the EV that budgetMult withheld from the direct catch — i.e. the
// money reserved for the bonus wave / splash collateral — as a real, variable, provably-
// fair stream. By construction E[disbursement | kill] = (budgetMult - mult)*unitBet, so
//   E[payout per shot] = p_kill * (mult + (budget-mult)) * unitBet = RTP * cost
// for EVERY fish (plain AND bonus), i.e. the FULL ~0.95 RTP is now realized in token play
// instead of the house silently keeping the folded slice (v1). The variable factor is an
// exponential (mean 1) from a dedicated PF draw, so a bonus round can occasionally pay big
// (the fun of it); the session lock caps any extreme at cash-out.
function expDraw(serverSeed, clientSeed, tag, nonce) {
  const u = PF.float(serverSeed, clientSeed, tag + ":" + nonce);
  return -Math.log(1 - Math.min(u, 0.99999999)); // mean 1, occasionally large
}
function bonusDisbursement(serverSeed, clientSeed, nonce, def, power, unitBet) {
  let bonus = null, splash = null;
  if (def.bonus && BONUS_BUDGET[def.bonus]) {
    const total = BONUS_BUDGET[def.bonus] * unitBet * expDraw(serverSeed, clientSeed, "bonus", nonce);
    bonus = { kind: def.bonus, total: Math.max(0, total) };
  }
  if (def.special && SPLASH_TARGET_BUDGET[def.special]) {
    const total = SPLASH_TARGET_BUDGET[def.special] * (power || 1) * RTP * unitBet * expDraw(serverSeed, clientSeed, "splash", nonce);
    splash = { kind: def.special, total: Math.max(0, total) };
  }
  return { bonus: bonus, splash: splash };
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

  // a kill pays GROSS def.mult * unitBet back PLUS the v2 bonus/splash disbursement
  // (the EV budgetMult withheld) — so the FULL RTP is realized in token play.
  const multiplier  = def.mult; // direct catch multiple of unitBet
  let payoutUnits = dead ? def.mult * unitBet : 0;
  let bonus = null, splash = null;
  if (dead) {
    const disb = bonusDisbursement(serverSeed, clientSeed, nonce, def, power, unitBet);
    if (disb.bonus)  { bonus = disb.bonus;   payoutUnits += disb.bonus.total; }
    if (disb.splash) { splash = disb.splash; payoutUnits += disb.splash.total; }
  }
  payoutUnits = Math.round(payoutUnits * 1e8) / 1e8;

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
      bonus: bonus,              // v2: {kind,total} disbursed bonus wave (real money) — null if none/no kill
      splash: splash,            // v2: {kind,total} disbursed splash collateral — null if none/no kill
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

/* ---------------- CLI self-test: node server/games/fishshooter2.js ----------------
   v2: every connecting shot now realizes the FULL RTP (0.95) — the direct catch PLUS
   the disbursed bonus/splash stream (the EV budgetMult withheld). Two checks:
   (A) DISBURSEMENT MEAN (low-noise): E[disbursement | kill] == (budget - mult)*unitBet
       for every bonus/splash fish, sampled directly so the rare kill doesn't add noise.
       This is the load-bearing proof that the withheld slice is paid back EXACTLY.
   (B) FULL per-shot RTP: realized payout/cost over a spread of fish (plain + bonus +
       splash) at both powers lands on 0.95 — no more house-kept folded slice. */
if (require.main === module) {
  const { serverSeed } = PF.newRound();
  const UNIT = 1e6;
  const ok = function (label, cond) { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); return cond; };
  let pass = true;

  console.log("fishshooter2.js self-test — full RTP " + RTP.toFixed(4) + " (direct catch + disbursed bonus/splash)");

  // ── A) DISBURSEMENT MEAN == withheld budget (budget - mult)*unitBet ──────────
  const DIS_FISH = ["minecrab", "vaultback", "tempest", "bloom"]; // bomb=splash; others=bonus triggers
  let disMaxErrSE = 0;
  DIS_FISH.forEach(function (k) {
    [1, 2].forEach(function (pw) {
      const def = BY_KEY[k];
      const expectedMean = (budgetMult(def, pw) - def.mult) * UNIT; // the withheld slice, in units
      const N = 400000;
      let sum = 0, sumSq = 0;
      for (let i = 0; i < N; i++) {
        const d = bonusDisbursement(serverSeed, "dis2-" + k + "-" + pw, i, def, pw, UNIT);
        const t = (d.bonus ? d.bonus.total : 0) + (d.splash ? d.splash.total : 0);
        sum += t; sumSq += t * t;
      }
      const mean = sum / N, variance = sumSq / N - mean * mean, se = Math.sqrt(variance / N);
      const errSE = Math.abs(mean - expectedMean) / se;
      disMaxErrSE = Math.max(disMaxErrSE, errSE);
      console.log("    disb " + (k + "@x" + pw).padEnd(14) + "mean " + (mean / UNIT).toFixed(3) +
        "u  exp " + (expectedMean / UNIT).toFixed(3) + "u  (" + errSE.toFixed(1) + " SE)");
    });
  });
  pass = ok("disbursement mean == withheld budget for every bonus/splash fish (max " + disMaxErrSE.toFixed(1) + " SE)", disMaxErrSE <= 5) && pass;

  // ── B) FULL per-shot RTP + structure invariants ─────────────────────────────
  const TARGETS = ["wisp", "prism", "lantern", "ray", "hatchet", "voltjelly", "aurum", "nautilus", "hammer",
                   "minecrab", "vaultback", "tempest", "bloom"];
  let aggCost = 0, aggPay = 0, structFail = 0;
  TARGETS.forEach(function (k) {
    [1, 2].forEach(function (pw) {
      const def = BY_KEY[k];
      const shouldBonus = !!(def.bonus && BONUS_BUDGET[def.bonus]);
      const shouldSplash = !!(def.special && SPLASH_TARGET_BUDGET[def.special]);
      const N = 300000, cost = UNIT * pw;
      for (let i = 0; i < N; i++) {
        const r = play({ serverSeed: serverSeed, clientSeed: "rtp2-" + k + "-" + pw, nonce: i, betUnits: cost, params: { targetKey: k, power: pw } });
        aggCost += cost; aggPay += r.payoutUnits;
        if (!r.win && (r.outcome.bonus || r.outcome.splash)) structFail++;            // no disbursement without a kill
        if (r.win && (!!r.outcome.bonus !== shouldBonus)) structFail++;               // bonus iff bonus fish
        if (r.win && (!!r.outcome.splash !== shouldSplash)) structFail++;             // splash iff splash fish
        if (r.win && !shouldBonus && !shouldSplash && Math.abs(r.payoutUnits - def.mult * UNIT) > 1e-3) structFail++; // plain win pays exactly mult*unitBet
      }
    });
  });
  const aggRTP = aggPay / aggCost;
  console.log("  aggregate per-shot RTP over " + TARGETS.length + " fish × 2 powers: " + aggRTP.toFixed(4) + " (target " + RTP.toFixed(2) + ")");
  pass = ok("full per-shot RTP within 2% of " + RTP.toFixed(2) + " (got " + aggRTP.toFixed(4) + ")", Math.abs(aggRTP - RTP) <= 0.02) && pass;
  pass = ok("disbursement structure invariants (only on kill, only bonus/splash fish) — " + structFail + " violations", structFail === 0) && pass;

  // ── determinism + invalid target ────────────────────────────────────────────
  const cs = "verify-client", nn = 98765;
  const r1 = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nn, betUnits: 2, params: { targetKey: "vaultback", power: 2 } });
  const r2 = play({ serverSeed: serverSeed, clientSeed: cs, nonce: nn, betUnits: 2, params: { targetKey: "vaultback", power: 2 } });
  pass = ok("deterministic re-derivation (roll + payout + disbursement all reproduce)",
    r1.outcome.roll === r2.outcome.roll && r1.payoutUnits === r2.payoutUnits) && pass;
  const rv = play({ serverSeed: serverSeed, clientSeed: cs, nonce: 1, betUnits: 5, params: { targetKey: "nope", power: 1 } });
  pass = ok("invalid target pays nothing", rv.win === false && rv.payoutUnits === 0) && pass;

  console.log(pass ? "\nSELF-TEST OK — v2 disburses the withheld bonus EV; full RTP realized." : "\nSELF-TEST FAILED");
  process.exit(pass ? 0 : 1);
}
