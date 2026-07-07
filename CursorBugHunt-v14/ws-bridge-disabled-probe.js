#!/usr/bin/env node
"use strict";
/**
 * Pass 17 / v14 Scan 82 — WS cr:start / BJ still work when HTTP token bridge guard() returns 503.
 * HTTP routes check enabled(); crash-rounds-ws and blackjack-server do not mirror that gate.
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const http = fs.readFileSync(path.join(root, "server/token-http.js"), "utf8");
const ws = fs.readFileSync(path.join(root, "server/crash-rounds-ws.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server/server.js"), "utf8");
const bj = fs.readFileSync(path.join(root, "server/blackjack-server.js"), "utf8");

let ok = true;
const eq = (label, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + "  " + label);
  if (!cond) ok = false;
};

eq("HTTP attachTokenBridge uses guard() on routes", /const guard = \(res\)[\s\S]{0,120}token bridge is not enabled/.test(http));
eq("makeCrashWs start does NOT check bridge enabled flag", !/enabled\(\)|ENABLE_TOKEN_BRIDGE/.test(ws));
eq("server.js wires crashWs regardless of bridge enabled", /makeCrashWs/.test(server));
eq("blackjack bridgeAuth has no TTL/expiry", /bridgeAuth\.set/.test(bj) && !/bridgeAuth[\s\S]{0,800}expir/.test(bj));
eq("WS cr:start only checks verifySession (not HTTP guard)", /verifySession\(data/.test(ws) && !/guard\(/.test(ws));

if (ok) {
  console.log("\nPROBE OK — documents gap: WS path bypasses HTTP bridge disabled gate");
} else {
  console.log("\nPROBE FAIL — WS/HTTP gate mismatch not found (regression?)");
}
process.exit(0);
