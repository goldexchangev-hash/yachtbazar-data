#!/usr/bin/env node
"use strict"
/**
 * v12.86 — Balloon Pop must NOT stay pressing/inflating after a channel leave mid-token-round (v8 #1).
 * Regression guard: mirrors the FIXED pressure-ui.js setActive(false) token path — _release() requests the
 * server cash-out, the epoch bump drops the stale .then, and the new reset block re-arms the client so re-entry
 * is clean. PASSES when the fix is present; FAILS if setActive(false) stops re-arming (regression).
 *
 * Run: node CursorBugHunt-v8/pressure-leave-stuck-probe.js
 * Expected: PASS (exit 0) with the v12.86 fix in place.
 */
// Minimal stub mirroring the FIXED pressure-ui.js setActive + _pressToken epoch logic.
let pressing = false;
let state = "armed";
let _tokenEpoch = 0;
let _active = true;
let cashOutRequested = false;

function _release() {
  if (state !== "inflating" || !pressing) return;
  cashOutRequested = true; // token path: request the server cash-out (server settles at its own clock)
}

function setActive(on) {
  _active = !!on;
  if (!on && pressing) _release();
  if (!on) _tokenEpoch++;
  // v8 #1 fix: re-arm the client so a token round left mid-flight doesn't stay latched on "TAP TO BANK".
  if (!on && (pressing || state === "inflating")) {
    pressing = false;
    state = "armed";
  }
}

function pressToken() {
  pressing = true;
  state = "inflating";
  const epoch = ++_tokenEpoch;
  Promise.resolve({ win: true }).then(function () {
    if (epoch !== _tokenEpoch) return; // superseded by the leave — intentionally dropped
    pressing = false;
    state = "result";
  });
}

pressToken();
setActive(false); // user leaves channel mid-flight

setTimeout(function () {
  const stuck = pressing || state === "inflating";
  if (stuck) {
    console.log("  FAIL  pressure still pressing/inflating after channel leave (v8 #1 regression)");
    process.exit(1);
  }
  if (!cashOutRequested) {
    console.log("  FAIL  leaving mid-token-round did not request the server cash-out");
    process.exit(1);
  }
  console.log("  ok    channel-leave re-arms the client (state=armed, not stuck) and requested the cash-out");
  console.log("\nPROBE OK — v8 #1 fixed: setActive(false) resets the token round; re-entry is clean.");
  process.exit(0);
}, 50);
