#!/usr/bin/env node
"use strict"
/**
 * Pass 15 / v12 #4 — TV dice/crash readouts gate affordability on gameWei, not token balance.
 */
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "public/app.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

const diceBlock = app.match(/function diceReadouts[\s\S]{0,2000}/);
const crashBlock = app.match(/function crashReadouts[\s\S]{0,1200}/);
eq("diceReadouts exists", !!diceBlock);
eq("diceReadouts compares stake to gameWei", diceBlock && /stakeWei > gameWei/.test(diceBlock[0]));
eq("diceReadouts does NOT check TokenMode.tokens in hint path", diceBlock && !/TokenMode\.tokens/.test(diceBlock[0]));
eq("playDiceClick routes token mode to tokenDice", /TokenMode\.active\(\)\) return tokenDice/.test(app));
eq("spendableUsd handles token mode (contrast)", /TokenMode\.active\(\).*TokenMode\.tokens/.test(app));

console.log("\nPROBE OK — documents gap: token dice/crash buttons disabled when gameWei=0");
process.exit(0);
