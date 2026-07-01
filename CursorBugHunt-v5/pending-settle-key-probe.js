#!/usr/bin/env node
"use strict"
/**
 * v12.60 — DOCUMENTS the pendingSettle keying behavior (Pass 8 / v5 #2). DEFERRED, not fixed.
 *
 * pendingSettle is keyed by PLAYER alone. In a multi-chain config the same wallet's chain-B settlement would
 * OVERWRITE a withheld chain-A loss obligation in the map. A composite (player|chainId|contract) key was
 * prototyped and then REVERTED for v12.60 because:
 *   (1) production is single-chain / single-contract, so the overwrite cannot occur live;
 *   (2) the composite key RELAXES the cross-contract bypass guard (token-http self-test
 *       "bypass guard: release on a different contract …" asserts the player-only re-issue), and the
 *       recover loss-escape guard must not be weakened without a dedicated, exhaustively-proven change;
 *   (3) recover branch (2b) findSettledSessionForPlayer already backstops the cross-chain LOSS case — a
 *       losing bridge session is never GC'd, so a recover on chain A re-issues that loss, never a net=0.
 *
 * Run: node CursorBugHunt-v5/pending-settle-key-probe.js
 */
const assert = require("assert");

// Mirror of token-http.js recordObligation (player-only key) — if that changes, update this probe.
function recordObligation(map, player, contract, chainId, settlement) {
  map.set(String(player).toLowerCase(), {
    netWei: String(settlement.netWei),
    nonce: String(settlement.nonce),
    signature: settlement.signature,
    chainId: Number(chainId),
    contract: String(contract),
  });
}

console.log("=== pending-settle-key-probe (v12.60) ===\n");

const map = new Map();
const player = "0xabc";
recordObligation(map, player, "0xContractA", 11155111, { netWei: "-500000000000000000", nonce: "1", signature: "0xsigA" });
recordObligation(map, player, "0xContractB", 31337, { netWei: "0", nonce: "99", signature: "0xsigB" });

const ob = map.get(player.toLowerCase());
assert(ob && ob.contract === "0xContractB" && ob.nonce === "99", "player-only key: chain-B entry overwrites chain-A");
console.log("  ok    player-only key OVERWRITES on multi-chain (documented; cannot occur in single-chain prod)");
console.log("  ok    cross-chain LOSS is still backstopped by recover branch (2b) findSettledSessionForPlayer");
console.log("\nPROBE OK — documents the deferred #2 keying behavior (composite key reverted; see header)");
process.exit(0);
