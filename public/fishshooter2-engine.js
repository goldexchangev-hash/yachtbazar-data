/* ============================================================
   fishshooter2-engine.js — "FISH SHOOTER V2 · NEON ABYSS": its OWN money/odds
   brain, DECOUPLED from Fish Shooter v1 (fishshooter-engine.js) and Reef Raiders
   (fishtable-engine.js). Same PROVEN math shape as v1 — only the roster identity
   changes — so v2 tuning can never touch v1 (owner: v2 is disableable; v1 stays).
   NO Pixi / NO DOM.

   ── How the money works (house edge lives in the KILL PROBABILITY) ──
   Catching a fish pays `mult × unitBet`. A bullet of power P costs `P × unitBet`.
   On a HIT, the fish dies with probability p_kill = clamp(P*RTP/mult, pMin, pMax),
   so EV per connecting shot = mult*unitBet*(P*RTP/mult) = P*unitBet*RTP = RTP*cost
   — a flat RTP on every connecting shot, target-independent. Misses are skill.

   POWER IS ~RTP-NEUTRAL HERE: the smallest fish mult (6) ≥ MAX_POWER(2)*RTP/P_MAX
   = 2*0.95/0.9 = 2.11, so NO fish ever hits the P_MAX clamp at the in-game power
   range. Power stays capped at x2 (v1 lesson: x3 fast-fire overkill cratered the
   realized RTP to ~72%).

   Invariants (identical to v1 — verified in the server module self-test):
   (1) min mult (6) ≥ MAX_POWER*RTP/P_MAX = 2.11; (2) P_MIN < RTP/maxMult
   (solaris 300 → 0.95/300 = 0.00317 > 0.0025 ✓).

   globalThis.FishShooter2Engine
   ============================================================ */
(function (root) {
  "use strict";

  const RTP = 0.95, P_MIN = 0.0025, P_MAX = 0.9;
  const BONUS_BUDGET = { chest: 25, frenzy: 25, storm: 25 };
  const SPLASH_TARGET_BUDGET = { bomb: 4, chain: 3 };

  /* ---- FS2 "NEON ABYSS" roster. mult/weight ladder copied EXACTLY from the proven v1
     roster (same spawn mix, same RTP shape) — only the identities are new. Fields:
     mult = payout multiple of unitBet. tier: small|medium|special|boss. ---- */
  const FISH = [
    { id: 0,  key: "wisp",       name: "Glow Wisp",         mult: 6,   tier: "small",   weight: 26,   r: 16, color: 0x6ff5ff, accent: 0x1d6e8c },
    { id: 1,  key: "ember",      name: "Ember Tetra",       mult: 7,   tier: "small",   weight: 22,   r: 18, color: 0xff8a3d, accent: 0xff4d9d },
    { id: 2,  key: "prism",      name: "Prism Guppy",       mult: 8,   tier: "small",   weight: 16,   r: 20, color: 0xd9e6ff, accent: 0xffd23f },
    { id: 3,  key: "lantern",    name: "Lantern Puffer",    mult: 8,   tier: "medium",  weight: 11,   r: 24, color: 0xffd76a, accent: 0x7a5400 },
    { id: 4,  key: "ray",        name: "Phantom Ray",       mult: 12,  tier: "medium",  weight: 8,    r: 30, color: 0xbfe8ff, accent: 0x39657a, sizeMul: 0.6 },
    { id: 5,  key: "hatchet",    name: "Hatchet Gleamer",   mult: 16,  tier: "medium",  weight: 6,    r: 28, color: 0xcfd8e6, accent: 0x39e7ff },
    { id: 6,  key: "voltjelly",  name: "Volt Jelly",        mult: 20,  tier: "special", weight: 4,    r: 26, color: 0x9db4ff, accent: 0x39e7ff, sizeMul: 0.6 },
    { id: 7,  key: "minecrab",   name: "Mine Crab",         mult: 14,  tier: "special", weight: 4,    r: 26, color: 0xff5d4d, accent: 0x2a0606, special: "bomb" },
    { id: 8,  key: "aurum",      name: "Aurum Seahorse",    mult: 28,  tier: "special", weight: 3,    r: 30, color: 0xffd23f, accent: 0x7a4a00, special: "gold", sizeMul: 0.8 },
    { id: 11, key: "nautilus",   name: "Pearl Nautilus",    mult: 8,   tier: "special", weight: 2.6,  r: 30, color: 0xffc9e8, accent: 0x6e1f56, special: "clam", sizeMul: 0.5 },
    { id: 9,  key: "hammer",     name: "Chrome Hammerhead", mult: 80,  tier: "boss",    weight: 1.3,  r: 52, color: 0xdfe8f2, accent: 0x39e7ff, special: "boss" },
    { id: 10, key: "voidkraken", name: "Void Leviathan",    mult: 160, tier: "boss",    weight: 0.5,  r: 70, color: 0xb14dff, accent: 0x1a0b3a, special: "boss" },
    { id: 12, key: "solaris",    name: "Solar Whale",       mult: 300, tier: "boss",    weight: 0.28, r: 80, color: 0xffe9b0, accent: 0xffd23f, special: "boss", sizeMul: 0.7 },
    { id: 13, key: "mantis",     name: "Magma Mantis",      mult: 40,  tier: "special", weight: 1.6,  r: 32, color: 0xff7a2d, accent: 0xff3b22, special: "gold", sizeMul: 0.5 },
    { id: 14, key: "isopod",     name: "Titan Isopod",      mult: 60,  tier: "special", weight: 1.1,  r: 36, color: 0x9aa8bb, accent: 0x2bd6ff, special: "gold" },
    { id: 15, key: "sovereign",  name: "Abyss Sovereign",   mult: 100, tier: "boss",    weight: 0.8,  r: 44, color: 0x39e7ff, accent: 0xffd23f, special: "boss", sizeMul: 0.75 },
    { id: 16, key: "aurora",     name: "Aurora Serpent",    mult: 200, tier: "boss",    weight: 0.4,  r: 60, color: 0x9ff0d8, accent: 0xb14dff, special: "boss" },
    // ── DEDICATED bonus-round creatures (RARE): catching one IS the trigger + pays its
    // mult; budgetMult = 18+25 = 43 pre-funds the wave (identical mechanism to v1).
    { id: 17, key: "vaultback", name: "Vaultback Turtle", mult: 18, tier: "special", weight: 0.8, r: 38, color: 0xffc24d, accent: 0x39e7ff, special: "gold", bonus: "chest",  sizeMul: 0.9 },  // → Treasure Vault
    { id: 18, key: "tempest",   name: "Tempest Ray",      mult: 18, tier: "special", weight: 0.8, r: 38, color: 0x9fb9c9, accent: 0x39e7ff, special: "gold", bonus: "storm",  sizeMul: 0.9 },  // → Lightning Storm
    { id: 19, key: "bloom",     name: "Bloom Jelly",      mult: 18, tier: "special", weight: 0.8, r: 36, color: 0xff4d9d, accent: 0x39e7ff, special: "gold", bonus: "frenzy", sizeMul: 0.85 }, // → Feeding Frenzy
  ];
  const BY_KEY = {}; FISH.forEach((f) => (BY_KEY[f.key] = f));
  const TOTAL_WEIGHT = FISH.reduce((s, f) => s + f.weight, 0);

  /* ---- deterministic seeded RNG (mulberry32) — byte-identical to v1 ---- */
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

  root.FishShooter2Engine = {
    FISH: FISH, BY_KEY: BY_KEY, RTP: RTP, P_MIN: P_MIN, P_MAX: P_MAX,
    create: function (seed) { return new Engine(seed); },
    randomSeed: randomSeed, commit: commit,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
