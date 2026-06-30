#!/usr/bin/env node
"use strict"
/**
 * v12.59 — pendingSettle must be keyed by (player, chainId, contract), not player alone.
 * Demonstrates cross-chain obligation overwrite (Pass 8 / v5 #2).
 *
 * Run: node CursorBugHunt-v5/pending-settle-key-probe.js
 */
const assert = require("assert");

// Inline the keying logic from token-http.js — if this ever changes, update the probe.
function recordObligation(map, player, contract, chainId, settlement) {
  map.set(String(player).toLowerCase(), {
    netWei: String(settlement.netWei),
    nonce: String(settlement.nonce),
    signature: settlement.signature,
    chainId: Number(chainId),
    contract: String(contract),
  });
}

console.log("=== pending-settle-key-probe (v12.59) ===\n");

const map = new Map();
const player = "0xabc";

recordObligation(map, player, "0xContractA", 11155111, { netWei: "-500000000000000000", nonce: "1", signature: "0xsigA" });
recordObligation(map, player, "0xContractB", 31337, { netWei: "0", nonce: "99", signature: "0xsigB" });

const ob = map.get(player.toLowerCase());
const overwritten = ob && ob.contract === "0xContractB" && ob.nonce === "99";

if (overwritten) {
  console.log("  ok    player-only key OVERWRITES chain-A loss obligation with chain-B entry (v5 #2 gap confirmed)");
  console.log("\nPROBE OK — documents the keying bug; fix = composite key (player, chainId, contract)");
  process.exit(0);
}

console.log("  FAIL  expected player-only overwrite behavior");
process.exit(1);
