/* ============================================================
   fishshooter-engine.js — "FISH SHOOTER" (CH 19): its OWN money/odds brain,
   DECOUPLED from Reef Raiders (CH 17 uses fishtable-engine.js). Same math shape,
   but Fish Shooter tunes RTP + the roster independently so changes here never
   touch Reef. NO Pixi / NO DOM.

   ── How the money works (house edge lives in the KILL PROBABILITY) ──
   Catching a fish pays `mult × unitBet`. A bullet of power P costs `P × unitBet`.
   On a HIT, the fish dies with probability p_kill = clamp(P*RTP/mult, pMin, pMax),
   so EV per connecting shot = mult*unitBet*(P*RTP/mult) = P*unitBet*RTP = RTP*cost
   — a flat RTP on every connecting shot, target-independent. Misses are skill.

   POWER IS RTP-NEUTRAL HERE: the smallest fish mult (6) ≥ MAX_POWER(5)*RTP/P_MAX
   = 5*0.95/0.9 = 5.28, so NO fish ever hits the P_MAX clamp at the in-game power
   range — every power level returns a flat ~95%. (Reef's engine keeps its own
   85% + x2 minnow + power-7; the two are intentionally separate now.)

   globalThis.FishShooterEngine
   ============================================================ */
(function (root) {
  "use strict";

  // 95% RTP = player-friendly ~5% edge on a play-money demo (long, fun sessions). The 5% jackpot
  // rake is the player's own money cycled back via the boss round, so it's RTP-neutral (delays +
  // concentrates variance). Invariants: (1) min mult ≥ MAX_POWER*RTP/P_MAX (=5.28 → floor 6) so no
  // P_MAX clamp at any in-game power; (2) P_MIN < RTP/maxMult (whale 300 → 0.00317 > 0.0025 ✓).
  const RTP = 0.95, P_MIN = 0.0025, P_MAX = 0.9;
  const BONUS_BUDGET = { chest: 25, frenzy: 25, storm: 25 };
  const SPLASH_TARGET_BUDGET = { bomb: 4, chain: 3 };

  /* ---- fish roster. mult = payout multiple of unitBet. tier: small|medium|special|boss ---- */
  const FISH = [
    { id: 0, key: "minnow",   name: "Minnow",        mult: 6,   tier: "small",   weight: 26, r: 16, color: 0x6fe3ff, accent: 0x1d6e8c },
    { id: 1, key: "clown",    name: "Clownfish",     mult: 7,   tier: "small",   weight: 22, r: 18, color: 0xff9a3d, accent: 0xc4521a },
    { id: 2, key: "tang",     name: "Blue Tang",     mult: 8,   tier: "small",   weight: 16, r: 20, color: 0x4d7bff, accent: 0xffd23f },
    { id: 3, key: "puffer",   name: "Pufferfish",    mult: 8,   tier: "medium",  weight: 11, r: 24, color: 0xffe08a, accent: 0x7a5400 },
    { id: 4, key: "turtle",   name: "Sea Turtle",    mult: 12,  tier: "medium",  weight: 8,  r: 30, color: 0x45f0a6, accent: 0x0b5e3c, sizeMul: 0.6 },
    { id: 5, key: "squid",    name: "Squid",         mult: 16,  tier: "medium",  weight: 6,  r: 28, color: 0xff5d9e, accent: 0x6e0440 },
    { id: 6, key: "eel",      name: "Electric Eel",  mult: 20,  tier: "special", weight: 4,  r: 26, color: 0xfff15a, accent: 0x39e7ff, bonus: "storm", sizeMul: 0.6 },
    { id: 7, key: "bomb",     name: "Bomb Fish",     mult: 14,  tier: "special", weight: 4,  r: 26, color: 0xff4d4d, accent: 0x2a0606, special: "bomb" },
    { id: 8, key: "crab",     name: "Gold Crab",     mult: 28,  tier: "special", weight: 3,  r: 30, color: 0xffd23f, accent: 0x7a4a00, special: "gold", bonus: "chest", sizeMul: 0.8 },
    { id: 11, key: "clam",    name: "Treasure Clam", mult: 8,   tier: "special", weight: 2.6, r: 30, color: 0xff8ad0, accent: 0x6e1f56, special: "clam", bonus: "frenzy", sizeMul: 0.5 },
    { id: 9, key: "shark",    name: "Gold Shark",    mult: 80,  tier: "boss",    weight: 1.3, r: 52, color: 0xcfe2ff, accent: 0x33507a, special: "boss" },
    { id: 10, key: "kraken",  name: "Kraken Boss",   mult: 160, tier: "boss",    weight: 0.5, r: 70, color: 0xb14dff, accent: 0x2b0b54, special: "boss" },
    { id: 12, key: "whale",   name: "Golden Whale",  mult: 300, tier: "boss",    weight: 0.28, r: 80, color: 0xfff0c0, accent: 0xffd23f, special: "boss", sizeMul: 0.7 },
    { id: 13, key: "lobster",   name: "Magma Lobster",     mult: 40,  tier: "special", weight: 1.6, r: 32, color: 0xff7a2d, accent: 0x39e7ff, special: "gold", bonus: "frenzy", sizeMul: 0.5 },
    { id: 14, key: "armadillo", name: "Armored Reef Crab", mult: 60,  tier: "special", weight: 1.1, r: 36, color: 0xffb84d, accent: 0x7a4a00, special: "gold", bonus: "chest" },
    { id: 15, key: "anglerfish",name: "Abyssal Angler",    mult: 100, tier: "boss",    weight: 0.8, r: 44, color: 0x39e7ff, accent: 0x1a0b3a, special: "boss", sizeMul: 0.75 },
    { id: 16, key: "seadragon", name: "Royal Sea Dragon",  mult: 200, tier: "boss",    weight: 0.4, r: 60, color: 0x2fe0a0, accent: 0xffd23f, special: "boss" },
  ];
  const BY_KEY = {}; FISH.forEach((f) => (BY_KEY[f.key] = f));
  const TOTAL_WEIGHT = FISH.reduce((s, f) => s + f.weight, 0);

  /* ---- deterministic seeded RNG (mulberry32) ---- */
  function strSeed(s) { let h = 1779033703 ^ s.length; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function randomSeed(n) { let s = ""; const cs = "0123456789abcdef"; for (let i = 0; i < (n || 24); i++) s += cs[(Math.random() * 16) | 0]; return s; }
  function commit(seed) { let h1 = strSeed(seed), h2 = strSeed(seed + ":r"); return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0"); }

  function Engine(serverSeed) {
    this.serverSeed = serverSeed || randomSeed(24);
    this.commitHash = commit(this.serverSeed);
    this.shot = 0;
    this._rng = mulberry32(strSeed(this.serverSeed));
  }
  Engine.prototype.next = function () { this.shot++; return this._rng(); };

  Engine.prototype.budgetMult = function (target, power) {
    const def = target && typeof target === "object" ? target : null;
    const mult = def ? def.mult : +target;
    let extra = 0;
    if (def && def.bonus) extra += BONUS_BUDGET[def.bonus] || 0;
    if (def && def.special) extra += (SPLASH_TARGET_BUDGET[def.special] || 0) * (power || 1) * RTP;
    return Math.max(0.01, mult + extra);
  };
  Engine.prototype.killProb = function (target, power) {
    return Math.max(P_MIN, Math.min(P_MAX, (power || 1) * RTP / this.budgetMult(target, power)));
  };
  Engine.prototype.resolveHit = function (target, power) {
    const p = this.killProb(target, power);
    const mult = target && typeof target === "object" ? target.mult : target;
    const dead = this.next() < p;
    return { dead: dead, payout: dead ? mult : 0, p: p };
  };
  Engine.prototype.resolveSplash = function (target, power) { return this.resolveHit(target, power); };
  Engine.prototype.pickFish = function (rng) {
    const r = (rng || Math.random)() * TOTAL_WEIGHT; let acc = 0;
    for (const f of FISH) { acc += f.weight; if (r < acc) return f; }
    return FISH[0];
  };
  Engine.prototype.rollJackpot = function (power) {
    const chance = 0.00025 * (power || 1);
    return this.next() < chance ? 500 + Math.floor(this._rng() * 1500) : 0;
  };

  root.FishShooterEngine = {
    FISH: FISH, BY_KEY: BY_KEY, RTP: RTP, P_MIN: P_MIN, P_MAX: P_MAX,
    create: function (seed) { return new Engine(seed); },
    randomSeed: randomSeed, commit: commit,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
