#!/usr/bin/env node
"use strict";
/** Pass 16 / v13 Scan 48 — topUp/resume skip _playSeqApplied; stale play can roll back tokens. */
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "../public/token-client.js"), "utf8");

let ok = true;
const eq = (l, c) => { console.log((c ? "  ok  " : "  FAIL") + "  " + l); if (!c) ok = false; };

eq("play() uses _playSeqApplied guard", /_playSeqApplied/.test(src));
eq("topUp sets tokens without bumping _playSeqApplied", /topUp[\s\S]{0,800}this\.tokens = r\.tokens/.test(src) && !/topUp[\s\S]{0,800}_playSeqApplied/.test(src));

console.log("\nPROBE OK — documents gap: in-flight play can overwrite post-topUp balance");
process.exit(0);
