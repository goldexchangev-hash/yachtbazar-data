#!/usr/bin/env node
"use strict"
/**
 * v12.91 — crash-rounds-client resume() requires in-memory `live`; after page refresh
 * a server-active round cannot be re-bound (v10 #1 gap).
 *
 * Run: node CursorBugHunt-v10/crash-cold-resume-probe.js
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../public/crash-rounds-client.js"), "utf8");

const hasEarlyReturn = /function resume\(\)\s*\{[\s\S]*?if \(!live \|\| !live\.sessionId\) return/.test(src);
const wsOpenCallsResume = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8")
  .includes("CrashRounds.resume");

let ok = true;
const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

eq("resume() early-returns when live is null", hasEarlyReturn);
eq("ws.onopen calls CrashRounds.resume (no-op without live)", wsOpenCallsResume);

if (hasEarlyReturn) {
  console.log("\nPROBE OK — documents gap: cold resume needs session credentials when live=null");
  process.exit(0);
}
console.log("\nPROBE FAIL — expected early-return guard (bug may be fixed)");
process.exit(1);
