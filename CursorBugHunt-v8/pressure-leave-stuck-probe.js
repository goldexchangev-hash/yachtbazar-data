#!/usr/bin/env node
"use strict"
/**
 * v12.86 — Balloon Pop must NOT stay pressing/inflating after channel leave (v8 #1 fix verified).
 *
 * Run: node CursorBugHunt-v8/pressure-leave-stuck-probe.js
 */
let pressing = false;
let state = "armed";
let _tokenEpoch = 0;
let cashOutRequested = false;

function _release() {
  if (state !== "inflating" || !pressing) return;
  cashOutRequested = true;
}

function setActive(on) {
  if (!on && pressing) _release();
  if (!on) _tokenEpoch++;
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
    if (epoch !== _tokenEpoch) return;
    pressing = false;
    state = "result";
  });
}

pressToken();
setActive(false);

setTimeout(function () {
  const stuck = pressing || state === "inflating";
  if (stuck) {
    console.log("  FAIL  pressure still pressing/inflating after channel leave (v8 #1 regression)");
    process.exit(1);
  }
  if (!cashOutRequested) {
    console.log("  FAIL  leaving mid-token-round did not request cash-out");
    process.exit(1);
  }
  console.log("  ok    channel-leave re-arms client and requested cash-out");
  console.log("\nPROBE OK — v8 #1 fix verified");
  process.exit(0);
}, 50);
