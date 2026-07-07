#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "public/app.js"), "utf8");
const tm = fs.readFileSync(path.join(__dirname, "..", "public/token-mode.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

const connectBlock = app.match(/await startGameUI\(\);[\s\S]{0,400}TokenMode\.init/);
eq("connect: startGameUI before TokenMode.init", !!connectBlock);
eq("startGameUI calls checkStrandedLock", /function startGameUI[\s\S]{0,500}checkStrandedLock/.test(app));
eq("checkStrandedLock skips when TokenMode.active()", /TokenMode\.active\(\).*setStranded\(0\)/.test(app));
eq("TokenMode.init resume is async (not awaited before stranded check)", /client\.resume\(saved\)\.then/.test(tm));
eq("no resume-pending guard in checkStrandedLock", !/resume|pending|SKEY/.test(app.match(/function checkStrandedLock[\s\S]{0,400}/)?.[0] || ""));

console.log("\nPROBE OK — documents gap: Recover UI can race session resume");
process.exit(0);
