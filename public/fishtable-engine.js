/* ============================================================
   fishtable-engine.js — "REEF RAIDERS": the money/odds brain for an arcade
   fish-shooter (Fu-Fish / fish-table style). NO Pixi / NO DOM here.

   ── How the money works (house edge lives in the KILL PROBABILITY) ──
   Every fish has a payout multiple `mult` → catching it pays `mult × unitBet`.
   A bullet of power P costs `P × unitBet`. When a bullet HITS a fish, the fish
   dies with probability:
        p_kill = clamp( P * RTP / mult , pMin , pMax )
   So the expected payout of a hitting shot =
        mult*unitBet * (P*RTP/mult) = P*unitBet*RTP = RTP * cost.
   → the return-to-player is RTP on every shot that connects, no matter which
   fish you shoot. MISSES are pure player skill (you paid, hit nothing) — that's
   the arcade part, not extra house edge. Big fish have tiny p_kill (many bullets,
   big payout); small fish die fast for small payouts. Higher gun power = more
   kill chance per shot for proportionally more cost (RTP preserved).

   Provably-fair-ready: kill rolls come from a seeded stream (mulberry32 keyed by
   a committed serverSeed + an advancing shot counter), so a session is fully
   reproducible. Full on-chain settlement is a later pass (demo/play-money first),
   mirroring how the slot's real-money mode is parked.

   globalThis.FishTableEngine
   ============================================================ */
(function (root) {
  "use strict";

  // House edge lives in the kill RTP. ~85% on kills leaves ~5% headroom for the
  // PROGRESSIVE JACKPOT, which is funded by a 5%-of-every-shot rake (see fishtable.js)
  // and pays its accumulated pool — so the jackpot returns what it takes and the
  // OVERALL game lands near a ~10% house edge instead of the old >100% (the meter used
  // to hand out a free 300-900x every ~83 catches).
  // P_MIN must stay BELOW RTP/maxMult (0.85/160 = 0.0053) or the boss fish get
  // over-rewarded: a flat 0.02 floor made the Kraken pay 320% and the Gold Shark 160%
  // (you could farm bosses at power 1). At 0.005 every fish returns a true 85% at power
  // 1 no matter which you shoot. P_MAX favors the house on small fish at high power.
  const RTP = 0.85, P_MIN = 0.005, P_MAX = 0.9;

  /* ---- fish roster. mult = payout multiple of unitBet. kind drives behaviour ---- */
  // tier: small | medium | special | boss   (spawn weight = how often it appears)
  const FISH = [
    { id: 0, key: "minnow",   name: "Minnow",        mult: 2,   tier: "small",   weight: 26, r: 16, color: 0x6fe3ff, accent: 0x1d6e8c },
    { id: 1, key: "clown",    name: "Clownfish",     mult: 3,   tier: "small",   weight: 22, r: 18, color: 0xff9a3d, accent: 0xc4521a },
    { id: 2, key: "tang",     name: "Blue Tang",     mult: 5,   tier: "small",   weight: 16, r: 20, color: 0x4d7bff, accent: 0xffd23f },
    { id: 3, key: "puffer",   name: "Pufferfish",    mult: 8,   tier: "medium",  weight: 11, r: 24, color: 0xffe08a, accent: 0x7a5400 },
    { id: 4, key: "turtle",   name: "Sea Turtle",    mult: 12,  tier: "medium",  weight: 8,  r: 30, color: 0x45f0a6, accent: 0x0b5e3c },
    { id: 5, key: "squid",    name: "Squid",         mult: 16,  tier: "medium",  weight: 6,  r: 28, color: 0xff5d9e, accent: 0x6e0440 },
    { id: 6, key: "eel",      name: "Electric Eel",  mult: 20,  tier: "special", weight: 4,  r: 26, color: 0xfff15a, accent: 0x39e7ff, special: "chain" },
    { id: 7, key: "bomb",     name: "Bomb Fish",     mult: 14,  tier: "special", weight: 4,  r: 26, color: 0xff4d4d, accent: 0x2a0606, special: "bomb" },
    { id: 8, key: "crab",     name: "Gold Crab",     mult: 28,  tier: "special", weight: 3,  r: 30, color: 0xffd23f, accent: 0x7a4a00, special: "gold", bonus: "chest" },
    { id: 11, key: "clam",    name: "Treasure Clam", mult: 8,   tier: "special", weight: 2.6, r: 30, color: 0xff8ad0, accent: 0x6e1f56, special: "clam", bonus: "frenzy" },
    { id: 9, key: "shark",    name: "Gold Shark",    mult: 80,  tier: "boss",    weight: 1.3, r: 52, color: 0xcfe2ff, accent: 0x33507a, special: "boss" },
    { id: 10, key: "kraken",  name: "Kraken Boss",   mult: 160, tier: "boss",    weight: 0.5, r: 70, color: 0xb14dff, accent: 0x2b0b54, special: "boss" },
  ];
  const BY_KEY = {}; FISH.forEach((f) => (BY_KEY[f.key] = f));
  const TOTAL_WEIGHT = FISH.reduce((s, f) => s + f.weight, 0);

  /* ---- deterministic seeded RNG (mulberry32) ---- */
  function strSeed(s) { let h = 1779033703 ^ s.length; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function randomSeed(n) { let s = ""; const cs = "0123456789abcdef"; for (let i = 0; i < (n || 24); i++) s += cs[(Math.random() * 16) | 0]; return s; }
  // tiny non-crypto commit just for display (real PF settlement is a later pass)
  function commit(seed) { let h1 = strSeed(seed), h2 = strSeed(seed + ":r"); return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0"); }

  function Engine(serverSeed) {
    this.serverSeed = serverSeed || randomSeed(24);
    this.commitHash = commit(this.serverSeed);
    this.shot = 0;            // advancing counter → every kill-roll is reproducible
    this._rng = mulberry32(strSeed(this.serverSeed));
  }
  Engine.prototype.next = function () { this.shot++; return this._rng(); };

  /* kill probability for a fish of multiple `mult` hit by a gun of power `power` */
  Engine.prototype.killProb = function (mult, power) {
    return Math.max(P_MIN, Math.min(P_MAX, (power || 1) * RTP / mult));
  };

  /* Resolve a bullet (power `power`) hitting a fish of `mult`.
     Returns { dead, payout } where payout is in unitBet multiples (caller × unitBet). */
  Engine.prototype.resolveHit = function (mult, power) {
    const p = this.killProb(mult, power);
    const dead = this.next() < p;
    return { dead: dead, payout: dead ? mult : 0, p: p };
  };

  /* A secondary kill (bomb splash / eel chain) — same odds, fresh roll. */
  Engine.prototype.resolveSplash = function (mult, power) { return this.resolveHit(mult, power); };

  /* weighted pick of a fish type for spawning (optionally bias toward small fish) */
  Engine.prototype.pickFish = function (rng) {
    const r = (rng || Math.random)() * TOTAL_WEIGHT; let acc = 0;
    for (const f of FISH) { acc += f.weight; if (r < acc) return f; }
    return FISH[0];
  };

  /* Jackpot: a rare progressive on any kill. Returns the jackpot multiple (× unitBet)
     if it pops, else 0. ~1 in 4000 base, scaled by gun power. */
  Engine.prototype.rollJackpot = function (power) {
    const chance = 0.00025 * (power || 1);
    return this.next() < chance ? 500 + Math.floor(this._rng() * 1500) : 0;
  };

  root.FishTableEngine = {
    FISH: FISH, BY_KEY: BY_KEY, RTP: RTP,
    create: function (seed) { return new Engine(seed); },
    randomSeed: randomSeed, commit: commit,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
