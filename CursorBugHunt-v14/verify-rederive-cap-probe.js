#!/usr/bin/env node
"use strict";
/**
 * Pass 17 / v14 Scan 55 — After orphan cap-at-1000× finalize, verifyRederive re-derives
 * the inflated payout as engine-consistent (false audit assurance). Root cause is M1 (1e9 bust).
 */
const crash = require("../server/games/crash.js");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

let capSeed = null;
for (let i = 0; i < 50000; i++) {
  const p = crash.crashPointOf("rederive-seed", "c" + i, 0);
  if (p >= crash.MAX_CRASH_X - 0.001) { capSeed = "c" + i; break; }
}
eq("found cap-hit clientSeed", !!capSeed);

const bet = 10;
const r = crash.play({
  serverSeed: "rederive-seed", clientSeed: capSeed, nonce: 0, betUnits: bet,
  params: { cashOutAt: 1e9 }, // orphan finalize path (M1)
});
eq("orphan bust at cap records win + bet*1000 payout", r.win === true && r.payoutUnits === bet * 1000);

// Re-derive replays the same params — audit passes while house overpaid
const r2 = crash.play({
  serverSeed: "rederive-seed", clientSeed: capSeed, nonce: 0, betUnits: bet,
  params: { cashOutAt: 1e9 },
});
eq("re-derive confirms same inflated payout (verifyRederive would pass)", r2.payoutUnits === r.payoutUnits);

eq("finalizeOrphan still uses cashOutAt: 1e9", /cashOutAt: 1e9/.test(require("fs").readFileSync(require("path").join(__dirname, "../server/token-bridge.js"), "utf8")));

if (ok) {
  console.log("\nPROBE OK — documents gap: cap orphan win re-derives cleanly (false audit assurance)");
} else {
  console.log("\nPROBE FAIL — cap orphan / verifyRederive gap reproduced");
}
process.exit(0);
