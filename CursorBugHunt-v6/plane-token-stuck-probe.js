#!/usr/bin/env node
"use strict"
/**
 * v12.69 — plane token mode must not stay _realBusy after channel leave mid-flight.
 * Reproduces v6 #2: epoch bump drops .then without clearing busy latch.
 *
 * Run: node CursorBugHunt-v6/plane-token-stuck-probe.js
 */
// Minimal stub of plane-ui token-launch epoch logic (mirrors public/plane-ui.js:348-366)
let _realBusy = false;
let _realEpoch = 0;
let state = "token-idle";

function setActive(on) {
  if (!on && state === "token-flying") { /* onTokenCashOut */ }
  if (!on) _realEpoch++;
}

function tokenLaunch(onResolve) {
  _realBusy = true;
  state = "token-flying";
  const epoch = _realEpoch;
  Promise.resolve(onResolve()).then(() => {
    if (epoch !== _realEpoch) return; // BUG: early return leaves _realBusy true
    _realBusy = false;
    state = "token-end";
  });
}

tokenLaunch(() => new Promise((r) => setTimeout(r, 50)));
setActive(false); // user switches channel mid-flight

setTimeout(() => {
  const stuck = _realBusy && state === "token-flying";
  if (stuck) {
    console.log("  ok    plane token round stays _realBusy after channel leave (v6 #2 gap)");
    console.log("\nPROBE OK — documents stuck state; fix: clear _realBusy in epoch-mismatch path or on setActive(false)");
    process.exit(0);
  }
  console.log("  FAIL  expected stuck state");
  process.exit(1);
}, 100);
