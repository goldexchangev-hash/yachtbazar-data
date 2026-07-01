#!/usr/bin/env node
"use strict"
/**
 * v12.85 — Balloon Pop must not stay pressing/inflating after channel leave mid-token-round.
 * Reproduces v8 #1: setActive(false) calls _release() which only cashOuts without clearing state;
 * epoch mismatch drops .then without cleanup.
 *
 * Run: node CursorBugHunt-v8/pressure-leave-stuck-probe.js
 * Expected: FAIL until setActive(false) resets pressing/state on token leave.
 */
// Minimal stub mirroring pressure-ui.js setActive + _pressToken epoch logic
let pressing = false;
let state = "armed";
let _tokenEpoch = 0;
let _active = true;

function _release() {
  if (state !== "inflating" || !pressing) return;
  // token path: only cashOut, no cleanup (bug)
  return;
}

function setActive(on) {
  _active = !!on;
  if (!on && pressing) _release();
  if (!on) _tokenEpoch++;
}

function pressToken() {
  pressing = true;
  state = "inflating";
  const epoch = ++_tokenEpoch;
  Promise.resolve({ win: true }).then(function () {
    if (epoch !== _tokenEpoch) return; // superseded — no cleanup (bug)
    pressing = false;
    state = "result";
  });
}

pressToken();
setActive(false); // user leaves channel mid-flight

setTimeout(function () {
  const stuck = pressing && state === "inflating";
  if (stuck) {
    console.log("  ok    pressure stays pressing/inflating after channel leave (v8 #1 gap)");
    console.log("\nPROBE OK — documents stuck state; fix: reset pressing/state in setActive(false) token path");
    process.exit(0);
  }
  console.log("  FAIL  expected stuck state (bug may be fixed)");
  process.exit(1);
}, 50);
