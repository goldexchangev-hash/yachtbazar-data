#!/usr/bin/env node
"use strict";
/**
 * v12.53 — #13: a signer outage mid-settle (bridge.settle sets s.closed=true, then signer.sign throws
 * before s.settlement is written) must NOT let a retry recover the LOSS as a net=0 orphan. The retry
 * has to re-run settle and re-issue the real (losing) settlement.
 *
 * Run: node CursorBugHunt-v3/wave2-money-probe.js
 */
const { ethers } = require("ethers");
const { makeTokenService, tokenAuthMessage } = require("../server/token-http.js");

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };

(async () => {
  console.log("=== wave2-money-probe (v12.53) ===\n");
  const house = ethers.Wallet.createRandom();
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;
  const lockedWei = 25n * 10n ** 16n; // 0.25 ETH → $1000 @ $4000
  const hash = (p, net, nonce, cid, c) => ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);

  // A signer that THROWS on its first call (simulating a transient outage), then works.
  let signCalls = 0;
  const flakySigner = { sign: (p, net, nonce, cid, c) => { signCalls++; if (signCalls === 1) throw new Error("signer temporarily down"); return house.signMessage(ethers.getBytes(hash(p, BigInt(net), BigInt(nonce), cid, c))); } };

  const svc = makeTokenService({
    signer: flakySigner, ethUsd: () => 4000,
    verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }),
    readBjLocked: async () => lockedWei, readNonceUsed: async () => false,
  });

  const w = ethers.Wallet.createRandom(); const p = w.address;
  const sign = (intent, o) => w.signMessage(tokenAuthMessage(intent, o));
  const start = { player: p, contract, chainId, txHash: "0x" + "1d".repeat(32), buyInWei: lockedWei.toString() };
  start.signature = await sign("start", { player: p, contract, chainId, buyInWei: lockedWei.toString() });
  const started = await svc.doStart(start);
  svc._bridge.session(started.sessionId).tokens = 800; // drive a $200 LOSS

  const relSign = async () => { const e = Math.floor(Date.now() / 1000) + 120; return { expiry: e, signature: await sign("release", { player: p, contract, chainId, expiry: e }) }; };

  // First recover: the signer throws mid-settle → doRelease propagates the error, leaving the bridge session
  // closed WITHOUT a recorded settlement, and openByPlayer still set.
  let firstThrew = false;
  try { const r = await relSign(); await svc.doRelease({ player: p, contract, chainId, expiry: r.expiry, signature: r.signature }); }
  catch (e) { firstThrew = /signer temporarily down/.test(e.message); }
  ok("#13 first recover throws when the signer is down (mid-settle)", firstThrew);

  const sAfter = svc._bridge.session(started.sessionId);
  ok("#13 the session is now CLOSED but has NO recorded settlement (the limbo)", !!(sAfter && sAfter.closed && !sAfter.settlement));

  // Second recover: signer works now → must RE-SETTLE and re-issue the real LOSS (netWei < 0), never net=0.
  let r2 = null, secondErr = "";
  try { const r = await relSign(); r2 = await svc.doRelease({ player: p, contract, chainId, expiry: r.expiry, signature: r.signature }); }
  catch (e) { secondErr = e.message; }
  ok("#13 retry recovers a settlement (no throw)", !!r2 && !secondErr);
  ok("#13 retry RE-ISSUES the real LOSS (netWei < 0), NOT a net=0 orphan that forgives it",
     !!r2 && r2.mode === "session" && BigInt(r2.netWei) < 0n);

  // And a THIRD recover re-issues the SAME loss (idempotent obligation), still never net=0.
  let r3 = null;
  try { const r = await relSign(); r3 = await svc.doRelease({ player: p, contract, chainId, expiry: r.expiry, signature: r.signature }); } catch (e) {}
  ok("#13 a further recover re-issues the SAME loss (idempotent, no net=0)",
     !!r3 && BigInt(r3.netWei) < 0n && r3.netWei === r2.netWei);

  console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
