#!/usr/bin/env node
"use strict";

require("../public/fishtable-engine.js");

const E = globalThis.FishTableEngine;
const FISH = E.FISH;
const ODDS = E.create("audit");
const BY_KEY = Object.fromEntries(FISH.map((f) => [f.key, f]));
const TOTAL = FISH.reduce((s, f) => s + f.weight, 0);
const SMALL = FISH.filter((f) => f.tier === "small");
const FRENZY = FISH.filter((f) => f.tier !== "boss" && !f.bonus);
const CHEST_POOL = [1, 1, 2, 2, 3, 3, 5, 5, 8, 10, 15];

function seed(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function rng(seedText) {
  let a = seed(seedText);
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(r, list, total) {
  let x = r() * total;
  for (const f of list) {
    x -= f.weight;
    if (x <= 0) return f;
  }
  return list[0];
}

function pickAll(r) { return pick(r, FISH, TOTAL); }
function pickSmall(r) { return pick(r, SMALL, SMALL.reduce((s, f) => s + f.weight, 0)); }
function pickFrenzy(r) { return pick(r, FRENZY, FRENZY.reduce((s, f) => s + f.weight, 0)); }

function bestOf(r, n) {
  let best = null;
  for (let i = 0; i < n; i++) {
    const f = pickAll(r);
    if (!best || f.mult > best.mult) best = f;
  }
  return best || pickAll(r);
}

function target(mode, r) {
  if (mode === "random") return pickAll(r);
  if (mode === "small") return pickSmall(r);
  if (mode === "boss") return r() < 0.72 ? BY_KEY.shark : BY_KEY.kraken;
  if (mode.startsWith("lock")) return bestOf(r, Number(mode.slice(4)) || 12);
  return pickAll(r);
}

function killed(f, power, r) {
  return r() < ODDS.killProb(f, power);
}

function chest(unit, r) {
  const n = 4 + (r() * 3 | 0);
  let total = 0;
  for (let i = 0; i < n; i++) total += CHEST_POOL[(r() * CHEST_POOL.length) | 0] * unit;
  return total;
}

function splash(power, unit, mode, r, count) {
  let won = 0;
  for (let i = 0; i < count; i++) {
    const f = mode.startsWith("lock") ? bestOf(r, 7) : pickAll(r);
    if (killed(f, power, r)) won += f.mult * unit;
  }
  return won;
}

function frenzy(power, unit, r) {
  const budget = unit * 25;
  let won = 0;
  for (let i = 0; i < 66 && won < budget; i++) {
    const f = pickFrenzy(r);
    if (!killed(f, power, r)) continue;
    won += Math.min(f.mult * unit, budget - won);
  }
  return won;
}

function run(mode, power, shots, unit) {
  const r = rng(`${mode}:${power}:${shots}:${unit}`);
  let spent = 0, won = 0, jackpotPool = 0, jackpotMeter = 0;
  const parts = { base: 0, jackpot: 0, chest: 0, frenzy: 0, splash: 0 };
  for (let i = 0; i < shots; i++) {
    const cost = unit * power;
    spent += cost;
    jackpotPool += cost * 0.05;
    const f = target(mode, r);
    if (!killed(f, power, r)) continue;
    const base = f.mult * unit;
    won += base; parts.base += base;
    jackpotMeter = Math.min(1, jackpotMeter + 0.0022 * power);
    if (jackpotMeter >= 1) {
      won += jackpotPool; parts.jackpot += jackpotPool; jackpotPool = 0; jackpotMeter = 0;
    }
    if (f.special === "bomb") { const x = splash(power, unit, mode, r, 4); won += x; parts.splash += x; }
    else if (f.special === "chain") { const x = splash(power, unit, mode, r, 3); won += x; parts.splash += x; }
    if (f.bonus === "chest") { const x = chest(unit, r); won += x; parts.chest += x; }
    else if (f.bonus === "frenzy") { const x = frenzy(power, unit, r); won += x; parts.frenzy += x; }
  }
  won += jackpotPool; parts.jackpot += jackpotPool;
  return { mode, power, rtp: won / spent, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v / spent])) };
}

const shots = Number(process.argv[2] || 500000);
const unit = Number(process.argv[3] || 50);
const modes = ["random", "lock8", "lock12", "lock20", "boss", "small"];
console.log(`Reef RTP audit: ${shots.toLocaleString()} shots/style/power, $${unit} unit`);
console.log("mode     pwr  rtp      base     jp       chest    frenzy   splash");
for (const power of [1, 5, 7]) {
  for (const mode of modes) {
    const out = run(mode, power, shots, unit);
    const p = out.parts;
    const fmt = (n) => (n * 100).toFixed(2).padStart(7) + "%";
    console.log(`${mode.padEnd(8)} ${String(power).padStart(3)} ${fmt(out.rtp)} ${fmt(p.base)} ${fmt(p.jackpot)} ${fmt(p.chest)} ${fmt(p.frenzy)} ${fmt(p.splash)}`);
  }
}
