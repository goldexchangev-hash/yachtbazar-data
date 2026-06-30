/* ============================================================
   fishhunter3000-engine.js — FISH HUNTER 3000 money/odds brain.
   Completely separate from fishshooter-engine.js / fishtable-engine.js.
   NO Pixi / NO DOM.

   Catching pays mult × unitBet. A bullet of power P costs P × unitBet.
   On hit: p_kill = clamp(P*RTP/budgetMult, P_MIN, P_MAX) → ~88% RTP per
   connecting shot. Bonus fish pre-fund vault/storm/frenzy waves via budgetMult.

   globalThis.FishHunter3000Engine
   ============================================================ */
(function (root) {
  "use strict";

  var RTP = 0.88;
  var P_MIN = 0.006;
  var P_MAX = 0.85;
  var JACKPOT_RAKE = 0.05;
  var BONUS_BUDGET = { vault: 22, storm: 22, frenzy: 22 };

  var FISH = [
    { id: "pixel",   key: "pixel",   name: "Pixel Fry",       mult: 2,  weight: 28, size: 0.45, tier: 1, color: 0x00f5ff },
    { id: "neon",    key: "neon",    name: "Neon Tetra",      mult: 3,  weight: 22, size: 0.55, tier: 1, color: 0xff3dff },
    { id: "chrome",  key: "chrome",  name: "Chrome Bass",     mult: 5,  weight: 16, size: 0.65, tier: 2, color: 0xc0d8ff },
    { id: "plasma",  key: "plasma",  name: "Plasma Ray",      mult: 8,  weight: 12, size: 0.85, tier: 2, color: 0x7b5cff },
    { id: "glitch",  key: "glitch",  name: "Glitch Puffer",   mult: 12, weight: 9,  size: 0.7,  tier: 2, color: 0xff6b35 },
    { id: "quantum", key: "quantum", name: "Quantum Jelly",   mult: 18, weight: 6,  size: 0.9,  tier: 3, color: 0x39ff14 },
    { id: "laser",   key: "laser",   name: "Laser Swordfish", mult: 25, weight: 4,  size: 1.1,  tier: 3, color: 0xffd700 },
    { id: "cyber",   key: "cyber",   name: "Cyber Shark",     mult: 40, weight: 2.5,size: 1.25, tier: 4, color: 0x8899aa },
    { id: "holo",    key: "holo",    name: "Holo Whale",      mult: 80, weight: 0.8,size: 1.8,  tier: 4, color: 0x66ccff },
    { id: "vault",   key: "vault",   name: "Vault Drone",     mult: 15, weight: 1.2,size: 0.75, tier: 3, color: 0xffd23f, special: "vault",  bonus: "vault" },
    { id: "storm",   key: "storm",   name: "Storm Eel",       mult: 15, weight: 1.0,size: 0.95, tier: 3, color: 0x44eeff, special: "storm",  bonus: "storm" },
    { id: "frenzy",  key: "frenzy",  name: "Frenzy Bot",      mult: 15, weight: 1.0,size: 0.8,  tier: 3, color: 0xff4488, special: "frenzy", bonus: "frenzy" },
  ];

  var BOSS = { id: "leviathan", key: "leviathan", name: "MEGA LEVIATHAN", mult: 200, size: 2.4, tier: 5, color: 0xff0044, special: "boss" };

  var BY_KEY = {};
  FISH.forEach(function (f) { BY_KEY[f.key] = f; });
  BY_KEY.leviathan = BOSS;
  var TOTAL_WEIGHT = FISH.reduce(function (s, f) { return s + f.weight; }, 0);

  function strSeed(s) {
    var h = 1779033703 ^ s.length, i;
    for (i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randomSeed(n) {
    var s = "", cs = "0123456789abcdef", i;
    for (i = 0; i < (n || 24); i++) s += cs[(Math.random() * 16) | 0];
    return s;
  }
  function commit(seed) {
    var h1 = strSeed(seed), h2 = strSeed(seed + ":r");
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }

  function Engine(serverSeed) {
    this.serverSeed = serverSeed || randomSeed(24);
    this.commitHash = commit(this.serverSeed);
    this.shot = 0;
    this._rng = mulberry32(strSeed(this.serverSeed));
  }
  Engine.prototype.next = function () { this.shot++; return this._rng(); };

  Engine.prototype.budgetMult = function (target, power) {
    var def = target && typeof target === "object" ? target : null;
    var mult = def ? def.mult : +target;
    var extra = 0;
    if (def && def.bonus) extra += BONUS_BUDGET[def.bonus] || 0;
    return Math.max(0.01, mult + extra);
  };

  Engine.prototype.killProb = function (target, power) {
    var p = (power || 1) * RTP / this.budgetMult(target, power);
    return Math.max(P_MIN, Math.min(P_MAX, p));
  };

  Engine.prototype.resolveHit = function (target, power) {
    var p = this.killProb(target, power);
    var mult = target && typeof target === "object" ? target.mult : +target;
    var dead = this.next() < p;
    return {
      dead: dead,
      payout: dead ? mult : 0,
      p: p,
      special: dead && target ? target.special || null : null,
      bonus: dead && target ? target.bonus || null : null,
    };
  };

  Engine.prototype.resolveSplash = function (target, power) {
    return this.resolveHit(target, power);
  };

  Engine.prototype.pickFish = function (rng) {
    var r = (rng || this.next.bind(this))() * TOTAL_WEIGHT, acc = 0, i;
    for (i = 0; i < FISH.length; i++) {
      acc += FISH[i].weight;
      if (r < acc) return FISH[i];
    }
    return FISH[0];
  };

  Engine.prototype.rollVaultMult = function () {
    var pool = [2, 3, 3, 5, 5, 8, 10, 12, 15];
    return pool[Math.floor(this.next() * pool.length)];
  };

  Engine.prototype.rollStormTargets = function () {
    return 2 + Math.floor(this.next() * 3);
  };

  Engine.prototype.bonusBudget = function (unitBet) {
    return Math.round((unitBet || 1) * 22 * 100) / 100;
  };

  root.FishHunter3000Engine = {
    FISH: FISH,
    BOSS: BOSS,
    BY_KEY: BY_KEY,
    RTP: RTP,
    P_MIN: P_MIN,
    P_MAX: P_MAX,
    JACKPOT_RAKE: JACKPOT_RAKE,
    BONUS_BUDGET: BONUS_BUDGET,
    create: function (seed) { return new Engine(seed); },
    randomSeed: randomSeed,
    commit: commit,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
