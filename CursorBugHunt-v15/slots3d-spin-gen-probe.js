#!/usr/bin/env node
"use strict";
/**
 * Pass 18 / v15 Scan 181 — slots3d token spin lacks generation counter;
 * stale .then can corrupt state after off-channel cancel + re-spin.
 */
const fs = require("fs");
const path = require("path");
const s3d = fs.readFileSync(path.join(__dirname, "../public/slots3d.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

eq("setActive(false) cancels _awaitingServer by clearing _spinning", /setActive[\s\S]{0,600}_awaitingServer = false[\s\S]{0,80}_spinning = false/.test(s3d));
eq("_spinToken .then guards on _spinning only (no gen counter)", /TM\.bet[\s\S]{0,400}if \(!self\._spinning\) return/.test(s3d));
eq("no _spinGen or equivalent stale-promise guard", !/_spinGen|spinGen|myGen/.test(s3d));

if (ok) {
  console.log("\nPROBE OK — documents gap: stale token spin .then can corrupt nonce/result after re-entry");
} else {
  console.log("\nPROBE FAIL — spin gen race reproduced");
}
process.exit(0);
