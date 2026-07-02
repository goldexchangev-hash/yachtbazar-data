#!/usr/bin/env node
"use strict";
/**
 * Pass 18 / v15 Scan 107 — token-bridge save() silently swallows persist failures.
 */
const fs = require("fs");
const path = require("path");
const tb = fs.readFileSync(path.join(__dirname, "../server/token-bridge.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

const saveFn = tb.match(/function save\(\)[\s\S]{0,200}/);
eq("save() exists", !!saveFn);
eq("save() catch block swallows errors", /function save\(\)[\s\S]{0,180}catch \(e\) \{\}/.test(tb));
eq("save() has no error logging", !/function save\(\)[\s\S]{0,220}console\.(error|warn)/.test(tb));
eq("mutating paths call save()", (tb.match(/save\(\)/g) || []).length >= 8);

if (ok) {
  console.log("\nPROBE OK — documents gap: silent save() failure → memory/disk divergence");
} else {
  console.log("\nPROBE FAIL — silent save gap reproduced");
}
process.exit(0);
