#!/usr/bin/env node
"use strict";
/**
 * Pass 18 / v15 Scan 114 — doSettle on already-closed session clears openByPlayer
 * for a DIFFERENT live session (loss-escape class).
 */
const fs = require("fs");
const path = require("path");
const http = fs.readFileSync(path.join(__dirname, "../server/token-http.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

eq("doSettle has no s.closed guard before settle", /function doSettle[\s\S]{0,800}bridge\.settle/.test(http) && !/function doSettle[\s\S]{0,400}s\.closed/.test(http));
eq("openByPlayer.delete(player) is unconditional in batchWrite", /openByPlayer\.delete\(player\)/.test(http));
eq("bridge.settle is idempotent on existing settlement", /if \(s\.settlement\) return s\.settlement/.test(fs.readFileSync(path.join(__dirname, "../server/token-bridge.js"), "utf8")));
eq("no self-test for settle-on-closed while other session open", !/already-closed session/i.test(http) && !/settle.*closed.*other session/i.test(http));

if (ok) {
  console.log("\nPROBE OK — documents gap: doSettle closed-session re-call clears live openByPlayer slot");
} else {
  console.log("\nPROBE FAIL — doSettle closed-session loss-escape path reproduced in static analysis");
}
process.exit(0);
