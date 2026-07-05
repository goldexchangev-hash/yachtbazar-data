#!/usr/bin/env node
"use strict";
/**
 * v12.51 — every HTTP response must carry the hardening headers (#2).
 * Boots the REAL server.js as a child on a throwaway port, GETs "/", and asserts
 * the headers are present (and X-Powered-By is gone). No wallet/chain needed — the
 * static index serves without a bridge.
 *
 * Run: node CursorBugHunt-v3/security-headers-probe.js
 */
const http = require("http");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const PORT = 3477;
const root = path.join(__dirname, "..");
const tmp = path.join(os.tmpdir(), "cryptotv-hdr-probe");

const child = spawn(process.execPath, ["server/server.js"], {
  cwd: root,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    TOKEN_BRIDGE_FILE: path.join(tmp, "bridge.json"),
    BJ_BANK_FILE: path.join(tmp, "bank.json"),
    ENABLE_EXPERIMENTAL_BRIDGE: "0",
  }),
  stdio: ["ignore", "ignore", "inherit"],
});

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };

function check() {
  http.get({ host: "127.0.0.1", port: PORT, path: "/" }, (res) => {
    const h = res.headers;
    console.log("=== security-headers-probe (v12.51) ===\n");
    ok("X-Content-Type-Options: nosniff", h["x-content-type-options"] === "nosniff");
    ok("X-Frame-Options: SAMEORIGIN", h["x-frame-options"] === "SAMEORIGIN");
    ok("Referrer-Policy present", /strict-origin/i.test(h["referrer-policy"] || ""));
    ok("CSP frame-ancestors 'self'", /frame-ancestors 'self'/i.test(h["content-security-policy"] || ""));
    ok("Strict-Transport-Security (HSTS) present", /max-age=\d+/i.test(h["strict-transport-security"] || ""));
    ok("X-Powered-By removed", !h["x-powered-by"]);
    // CSP must NOT pin script-src (would break the injected wallet provider / ethers).
    ok("CSP does NOT restrict script-src (wallet-safe)", !/script-src/i.test(h["content-security-policy"] || ""));
    res.resume();
    child.kill();
    console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
    process.exit(failed ? 1 : 0);
  }).on("error", (e) => {
    console.error("request error:", e.message);
    child.kill();
    process.exit(1);
  });
}

// give the server a moment to bind, then poll until it answers
let tries = 0;
const poll = () => {
  tries++;
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/info", timeout: 500 }, (res) => { res.resume(); check(); });
  req.on("error", () => { if (tries > 40) { console.error("server never came up"); child.kill(); process.exit(1); } else setTimeout(poll, 150); });
  req.on("timeout", () => { req.destroy(); if (tries > 40) { child.kill(); process.exit(1); } else setTimeout(poll, 150); });
};
setTimeout(poll, 300);
