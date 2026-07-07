#!/usr/bin/env node
"use strict";
/**
 * Pass 17 / v14 Scan 64 — Pressure early-bank reject leaves server round live.
 * Server throws on cashOut below MIN_CASHOUT (1.20); WS sends cr:error; client onError
 * tears down local state but server round + reserved stake stay active.
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const cr = fs.readFileSync(path.join(root, "server/crash-rounds.js"), "utf8");
const ws = fs.readFileSync(path.join(root, "server/crash-rounds-ws.js"), "utf8");
const client = fs.readFileSync(path.join(root, "public/crash-rounds-client.js"), "utf8");
const pressure = fs.readFileSync(path.join(root, "public/pressure-ui.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

eq("pressure cashOut rejects below gameFloor (hold longer)", /gameKey === "pressure"[\s\S]{0,120}throw new Error\("hold longer/.test(cr));
eq("ws cashout catch sends cr:error (does not settle)", /catch \(e\)[\s\S]{0,120}type: "cr:error"[\s\S]{0,80}code: "cashout"/.test(ws));
eq("client onError nulls live + rejects start promise", /function onError[\s\S]{0,200}live = null[\s\S]{0,80}l\.reject/.test(client));
eq("onError does NOT call cr:resume or keep round alive locally", !/function onError[\s\S]{0,300}resume\(/.test(client));
eq("pressure launch .catch tears down UI on round error", /\.catch\(function \(e\)[\s\S]{0,900}_toArmed/.test(pressure));
eq("no client path to re-bind after early-bank cr:error without visibility resume", !/hold longer/.test(client));

if (ok) {
  console.log("\nPROBE OK — documents gap: early-bank cr:error orphans server round + stake");
} else {
  console.log("\nPROBE FAIL — early-bank orphan trap reproduced in static analysis");
}
process.exit(0);
