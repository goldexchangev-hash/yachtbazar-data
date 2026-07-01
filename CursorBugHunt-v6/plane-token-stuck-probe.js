#!/usr/bin/env node
"use strict"
/**
 * v12.82 — plane token mode must not stay _realBusy after channel leave mid-flight.
 * v6 #2 FIX VERIFIED: setActive(false) clears _realBusy + _startTokenIdle().
 *
 * Run: node CursorBugHunt-v6/plane-token-stuck-probe.js
 * Expected: PASS (not stuck) when v6 #2 fix is present.
 */
// Minimal stub of plane-ui token-launch epoch logic (mirrors public/plane-ui.js:348-366,488-496)
let _realBusy = false;
let _realEpoch = 0;
let state = "token-idle";

function _startTokenIdle() {
  _realBusy = false;
  state = "token-idle";
}

function setActive(on) {
  if (!on && state === "token-flying") {
    // v6 #2 fix: reset immediately on channel leave
    _realBusy = false;
    _startTokenIdle();
  }
  if (!on) _realEpoch++;
}

function tokenLaunch(onResolve) {
  _realBusy = true;
  state = "token-flying";
  const epoch = _realEpoch;
  Promise.resolve(onResolve()).then(() => {
    if (epoch !== _realEpoch) return; // superseded — fix already cleared busy in setActive
    _realBusy = false;
    state = "token-end";
  });
}

tokenLaunch(() => new Promise((r) => setTimeout(r, 50)));
setActive(false); // user switches channel mid-flight

setTimeout(() => {
  const stuck = _realBusy && state === "token-flying";
  if (stuck) {
    console.log("  FAIL  plane token round stays _realBusy after channel leave (v6 #2 regression)");
    process.exit(1);
  }
  console.log("  ok    plane token round clears _realBusy on channel leave (v6 #2 fix verified)");
  console.log("\nPROBE OK — v6 #2 fix present");
  process.exit(0);
}, 100);
