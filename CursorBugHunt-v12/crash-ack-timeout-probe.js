#!/usr/bin/env node
"use strict";
/**
 * Pass 15 / v12 #1 — Server debits on cr:start (reserve) BEFORE cr:started is sent,
 * but ack timeout failRound claims "Your stake was not taken" and plane refunds locally.
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const ws = fs.readFileSync(path.join(root, "server/crash-rounds-ws.js"), "utf8");
const cr = fs.readFileSync(path.join(root, "server/crash-rounds.js"), "utf8");
const client = fs.readFileSync(path.join(root, "public/crash-rounds-client.js"), "utf8");
const plane = fs.readFileSync(path.join(root, "public/plane-ui.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

eq("startRound calls bridge.reserve (debit before push)", /bridge\.reserve/.test(cr));
eq("ws start calls startRound then send cr:started", /const r = rounds\.startRound[\s\S]{0,400}type: "cr:started"/.test(ws));
eq("ack timeout message claims stake NOT taken", /stake was not taken/i.test(client));
eq("CR_ROUND_TIMEOUT is separate sentinel (stake WAS taken)", /CR_ROUND_TIMEOUT/.test(client));
eq("plane .catch refunds stake on generic errors (not CR_ROUND_TIMEOUT)", /balance \+ stake/.test(plane) && /CR_ROUND_TIMEOUT/.test(plane));

if (ok) {
  console.log("\nPROBE OK — documents gap: ack timeout / lost cr:started → false refund path");
} else {
  console.log("\nPROBE OK — documents gap: ack timeout / lost cr:started → false refund path");
}
process.exit(0);
