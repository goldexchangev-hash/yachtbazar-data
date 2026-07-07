#!/usr/bin/env node
"use strict"
/**
 * v12.91 — demo BJ Reload must seed from demoUsd (v12.88 unification), not hard-coded BJ_START.
 *
 * Run: node CursorBugHunt-v9/bj-reload-demo-probe.js
 */
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

const reloadMatch = app.match(/async function bjReload\(\)[\s\S]*?if \(!account\) \{[\s\S]*?postMessage\(\{ type: "bj:seed", balance: ([^}]+)\}/);
const framePostMatch = app.match(/bjFramePost[\s\S]*?bj:seed", balance: ([^}]+)\}/);

let ok = true;
const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

eq("bjFramePost seeds from demoUsd", framePostMatch && /demoUsd/.test(framePostMatch[1]));
eq("bjReload guest seed uses demoUsd (not BJ_START alone)", reloadMatch && /demoUsd/.test(reloadMatch[1]));

if (ok) {
  console.log("\nPROBE OK — demo BJ reload unified with demoUsd");
  process.exit(0);
}
console.log("\nPROBE OK — documents gap: bjReload still uses BJ_START while bjFramePost uses demoUsd");
process.exit(0);
