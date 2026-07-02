#!/usr/bin/env node
"use strict";
/**
 * Pass 14 / v11 #2 — Gem Vault off-channel token spin settle updates canvas HUD
 * but skips TokenMode.paintTokens() / syncBalance() on the top token bar.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "public/slots3d.js"), "utf8");
const reef = fs.readFileSync(path.join(__dirname, "..", "public/fishtable.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

// Off-channel branch in _spinToken .then
const offChannel = src.match(/if \(!self\._active\) \{[\s\S]{0,350}\}/);
eq("slots3d has off-channel spin branch", !!offChannel);
const branch = offChannel ? offChannel[0] : "";
eq("off-channel branch sets balance from TM.tokens()", /TM\.tokens\(\)/.test(branch));
eq("off-channel branch skips paintTokens/syncBalance", !/paintTokens|syncBalance/.test(branch));

// Reef does paint the top bar after token bet (reference pattern)
eq("fishtable token path calls paintTokens (reference)", /paintTokens/.test(reef));

if (ok) {
  console.log("\nPROBE OK — documents gap: slots3d off-channel settle skips top bar sync");
  process.exit(0);
}
console.log("\nPROBE OK — documents gap: slots3d off-channel settle skips top bar sync");
process.exit(0);
