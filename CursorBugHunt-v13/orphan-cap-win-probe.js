#!/usr/bin/env node
"use strict";
/**
 * Pass 16 / v13 Scan 46 — orphan finalize uses cashOutAt:1e9 which clamps to 1000x.
 * When crashPoint === 1000, orphan "bust" pays bet*1000 instead of 0.
 */
const crash = require("../server/games/crash.js");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

// Find cap hit (same technique as token-bridge self-test)
let capSeed = null;
for (let i = 0; i < 50000; i++) {
  const p = crash.crashPointOf("orphan-seed", "c" + i, 0);
  if (p >= crash.MAX_CRASH_X - 0.001) { capSeed = "c" + i; break; }
}
eq("found clientSeed with crashPoint at cap", !!capSeed);

const bet = 10;
const r = crash.play({
  serverSeed: "orphan-seed", clientSeed: capSeed, nonce: 0, betUnits: bet,
  params: { cashOutAt: 1e9 }, // same as finalizeOrphanRounds / drainOrphanReservations
});
eq("orphan bust path pays 0 on cap hit", r.payoutUnits === 0);
eq("BUG: cap hit pays bet*1000 instead (house drain class)", r.win === true && r.payoutUnits === bet * 1000);

eq("finalizeOrphan uses 1e9 cashOutAt", /cashOutAt: 1e9/.test(require("fs").readFileSync(require("path").join(__dirname, "../server/token-bridge.js"), "utf8")));

if (ok) {
  console.log("\nPROBE OK — documents gap: cap orphan pays 1000x (unexpected win)");
} else {
  console.log("\nPROBE FAIL — cap orphan win reproduced (fix required)");
}
process.exit(0);
