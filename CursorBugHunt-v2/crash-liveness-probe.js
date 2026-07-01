#!/usr/bin/env node
"use strict";
/**
 * Tests token-http crash liveness guards (#3, #15) with injected hasActiveCrashCheck.
 * Run: node CursorBugHunt-v2/crash-liveness-probe.js
 */
const { ethers } = require("ethers");
const { makeTokenService, tokenAuthMessage } = require("../server/token-http.js");

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };

async function main() {
  const house = ethers.Wallet.createRandom();
  const wallet = ethers.Wallet.createRandom();
  const player = wallet.address;
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;
  const lockedWei = (25n * 10n ** 16n);
  const settlementHash = (p, net, nonce, cid, c) =>
    ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
  const signer = { sign: (p, net, nonce, cid, c) => house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))) };

  const svc = makeTokenService({
    signer,
    ethUsd: () => 4000,
    ethUsdReady: () => true,
    verifyBuyIn: async () => ({ lockedWei: lockedWei.toString(), eventLocked: lockedWei }),
  });

  console.log("=== crash-liveness-probe ===\n");

  let live = false;
  let openSid = null;
  svc.setActiveCrashCheck((sid) => live && sid === openSid);

  const startBody = {
    player, contract, chainId,
    txHash: "0x" + "d1".repeat(32),
    buyInWei: lockedWei.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei: lockedWei.toString() })),
  };
  const start = await svc.doStart(startBody);
  openSid = start.sessionId;
  const token = start.sessionToken;

  live = true;
  let playBlocked = false;
  try { svc.doPlay({ sessionId: openSid, sessionToken: token, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "x" }); }
  catch (e) { playBlocked = /live round/i.test(e.message); }
  ok("doPlay blocked during live crash round (#15)", playBlocked);

  let settleBlocked = false;
  try {
    await svc.doSettle({
      player, sessionId: openSid,
      signature: await wallet.signMessage(tokenAuthMessage("settle", { player, contract, chainId, sessionId: openSid })),
    });
  } catch (e) { settleBlocked = /live round/i.test(e.message); }
  ok("doSettle blocked during live crash round (#3)", settleBlocked);

  live = false;
  const playOk = svc.doPlay({ sessionId: openSid, sessionToken: token, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "y" });
  ok("doPlay allowed after round ends", playOk && playOk.ok);

  console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
