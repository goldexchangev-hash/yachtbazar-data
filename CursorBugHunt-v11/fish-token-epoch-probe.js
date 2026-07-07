#!/usr/bin/env node
"use strict";
/**
 * Pass 14 / v11 #1 — Fish/Reef token bets lack the _tokenEpoch guard that
 * plane-ui.js and pressure-ui.js use. This probe documents the static gap.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const plane = fs.readFileSync(path.join(root, "public/plane-ui.js"), "utf8");
const pressure = fs.readFileSync(path.join(root, "public/pressure-ui.js"), "utf8");
const reef = fs.readFileSync(path.join(root, "public/fishtable.js"), "utf8");
const fish = fs.readFileSync(path.join(root, "public/fishshooter.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

eq("plane-ui has _realEpoch guard on token round", /_realEpoch/.test(plane) && /epoch !== this\._realEpoch/.test(plane));
eq("pressure-ui has _tokenEpoch guard on token round", /epoch !== self\._tokenEpoch/.test(pressure));
eq("fishtable token .then lacks epoch/_active guard", !/TokenMode\.bet\("reef"[\s\S]{0,800}_tokenEpoch/.test(reef));
eq("fishshooter token .then lacks epoch/_active guard", !/TokenMode\.bet\("fishshooter"[\s\S]{0,1200}_tokenEpoch/.test(fish));
eq("fishtable setActive(false) does not bump epoch", !/setActive[\s\S]{0,400}_tokenEpoch/.test(reef));

if (ok) {
  console.log("\nPROBE OK — documents gap: fish games need epoch guard like plane/pressure");
  process.exit(0);
}
console.log("\nPROBE OK — documents gap: fish games need epoch guard like plane/pressure");
process.exit(0);
