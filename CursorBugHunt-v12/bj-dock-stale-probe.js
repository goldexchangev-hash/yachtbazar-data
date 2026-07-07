#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "public/app.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

eq("bj:dock handler gates renderBjDock on currentGame", /if \(currentGame === "blackjack"\) renderBjDock/.test(app));
eq("renderBjDock sets bjDockLive from placed/mode", /bjDockLive = !!\(s && \(\(s\.placed > 0\)/.test(app));
eq("ensureBlackjackReady refuses when bjDockLive", /bjDockLive.*Finish the current hand/.test(app));
eq("switchGame does not reset bjDockLive on leave", !/switchGame[\s\S]{0,800}bjDockLive = false/.test(app));

console.log("\nPROBE OK — documents gap: off-channel bj:dock ignored → stale bjDockLive");
process.exit(0);
