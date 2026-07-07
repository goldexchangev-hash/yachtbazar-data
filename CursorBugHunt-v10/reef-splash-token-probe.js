#!/usr/bin/env node
"use strict"
/**
 * v12.91 — Reef token bomb splash must be visual-only (fishshooter guard missing).
 *
 * Run: node CursorBugHunt-v10/reef-splash-token-probe.js
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../public/fishtable.js"), "utf8");

const fishshooterGuard = fs.readFileSync(path.join(__dirname, "../public/fishshooter.js"), "utf8")
  .includes("_tokenActive() && !shot.free) return");

const reefBombGuard = /_bombSplash[\s\S]{0,400}_tokenActive\(\)[\s\S]{0,80}return/.test(src);
const reefChainGuard = /_eelChain[\s\S]{0,400}_tokenActive\(\)[\s\S]{0,80}return/.test(src);

let ok = true;
const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

eq("fishshooter has token splash visual-only guard", fishshooterGuard);
eq("reef _bombSplash has token visual-only guard", reefBombGuard);
eq("reef _eelChain has token visual-only guard", reefChainGuard);

if (!reefBombGuard || !reefChainGuard) {
  console.log("\nPROBE OK — documents gap: reef splash/chain still client-kills fish in token mode");
  process.exit(0);
}
console.log("\nPROBE FAIL — reef guards present (fixed)");
process.exit(1);
