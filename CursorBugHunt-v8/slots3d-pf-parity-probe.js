#!/usr/bin/env node
"use strict";
/**
 * mega-hunt #13 / v7 #8 — the Gem Vault (slots3d) FAIRNESS panel must re-derive the EXACT grid the SERVER
 * settled, so a player can verify their spin from the revealed seed. The client engine used `uint32 % len` on
 * HMAC(serverSeed, cs:nonce); the server uses `floor(float·len)` on the PF float stream HMAC(serverSeed,
 * cs:nonce:cursor). Both are uniform (same odds), but the SPECIFIC grids differed → verification never matched.
 * v12.90 unified the client onto the server's derivation. This probe proves byte-for-byte parity.
 *
 * Run: node CursorBugHunt-v8/slots3d-pf-parity-probe.js   (PASS = client grid === server grid for every case)
 */
const server = require("../server/games/slots3d.js");
const client = require("../public/slots3d-engine.js");
const Shuffle = require("../public/blackjack-shuffle.js");

let ok = true, checked = 0, mism = 0;
function eqGrid(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Deterministic spread of (serverSeed, clientSeed, nonce), incl. free-spin nonce strings.
const clientSeeds = ["", "player-A", "abc123", "c" + "9".repeat(30), "🎰emoji"];
for (let s = 0; s < 40; s++) {
  const serverSeed = Shuffle.commitHash("seed-" + s); // 64-hex, a valid HMAC key
  for (const cs of clientSeeds) {
    for (let nonce = 0; nonce < 6; nonce++) {
      const sg = server.deriveGrid(serverSeed, cs, nonce);
      const cg = client.deriveGrid(serverSeed, cs, nonce);
      checked++;
      if (!eqGrid(sg, cg)) { ok = false; if (mism++ < 3) console.log("  MISMATCH base", { s, cs, nonce, sg, cg }); }
      // also the evaluate() must agree on the shared grid (ported verbatim — belt & suspenders).
      // server returns { win }, client returns { winUsd } — same value, different key.
      const se = server.evaluate(sg, 100).win, ce = client.evaluate(cg, 100).winUsd;
      if (se !== ce) { ok = false; if (mism++ < 3) console.log("  EVAL MISMATCH", { s, cs, nonce, se, ce }); }
      // free-spin grids (bonus round derives at nonce:free:i)
      for (let i = 0; i < 3; i++) {
        const fn = String(nonce) + ":free:" + i;
        const sfg = server.deriveGrid(serverSeed, cs, fn), cfg = client.deriveGrid(serverSeed, cs, fn);
        checked++;
        if (!eqGrid(sfg, cfg)) { ok = false; if (mism++ < 3) console.log("  MISMATCH free", { s, cs, fn }); }
      }
    }
  }
}

console.log((ok ? "  ok  " : "  FAIL") + "  slots3d client/server grid parity — " + checked + " grids compared, " + mism + " mismatches");
console.log(ok ? "\nPROBE OK — the Gem Vault fairness panel re-derives the exact server grid (mega-hunt #13 / v7 #8 fixed)." : "\nPROBE FAILED — client grid derivation still diverges from the server.");
process.exit(ok ? 0 : 1);
