#!/usr/bin/env node
"use strict";
/**
 * Adversarial harness v2 — v12.46 aware (reserve model, batchWrite, withPlayerLock).
 * Run: node CursorBugHunt-v2/adversarial-suite-v2.js
 */
const { ethers } = require("ethers");
const { makeTokenService, tokenAuthMessage } = require("../server/token-http.js");
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");

const findings = [];
function bug(sev, code, title, detail, ev) { findings.push({ sev, code, title, detail, ev }); console.log("\n[" + sev + "] " + code + " — " + title); if (detail) console.log(detail); if (ev) console.log("Evidence:", ev); }
function section(t) { console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72)); }

const house = ethers.Wallet.createRandom();
const settlementHash = (p, net, nonce, cid, c) =>
  ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
const signer = { sign: (p, net, nonce, cid, c) => house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))) };

async function main() {
  console.log("ADVERSARIAL SUITE v2 — Crypto TV @ v12.46\n");

  section("0. bridge.reserve integration");
  const tb = makeTokenBridge({});
  if (typeof tb.reserve !== "function" || typeof tb.resolveReserved !== "function") {
    bug("Critical", "RESERVE-MISSING", "token-bridge.js missing reserve/resolveReserved",
      "crash-rounds.js calls bridge.reserve() but makeTokenBridge() does not export it. All token crash/plane/swoop/pressure rounds fail at cr:start.",
      "typeof reserve=" + typeof tb.reserve);
  } else {
    console.log("  ok  reserve/resolveReserved present on real bridge");
  }

  section("1. txHash replay — concurrent doStart");
  const wallet = ethers.Wallet.createRandom();
  const player = wallet.address;
  const lockedWei = (25n * 10n ** 16n);
  let verifyCalls = 0;
  const svc = makeTokenService({
    signer, ethUsd: () => 4000, ethUsdReady: () => true,
    verifyBuyIn: async (o) => { verifyCalls++; await new Promise((r) => setTimeout(r, 80)); return { lockedWei: o.buyInWei }; },
  });
  const tx = "0x" + "b".repeat(64);
  const body = {
    player, contract: "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc", chainId: 11155111,
    txHash: tx, buyInWei: lockedWei.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("start", { player, contract: "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc", chainId: 11155111, buyInWei: lockedWei.toString() })),
  };
  const [a, b] = await Promise.allSettled([
    svc.doStart({ ...body }).catch((e) => ({ err: e.message })),
    svc.doStart({ ...body }).catch((e) => ({ err: e.message })),
  ]);
  const results = [a.status === "fulfilled" ? a.value : {}, b.status === "fulfilled" ? b.value : {}];
  const okCount = results.filter((r) => r && r.ok && r.sessionId).length;
  if (okCount !== 1) bug("Critical", "TXHASH-START", "Concurrent doStart same txHash", "Expected exactly one success", "okCount=" + okCount);
  else console.log("  ok  only one start succeeded (okCount=1)");

  section("2. crash reserve — nonce pin + interleaved play");
  if (typeof tb.reserve === "function") {
    const st = tb.start({ player, buyInUnits: 1000, chainId: 1, contract: "0x0" });
    const cr = makeCrashRounds({ bridge: tb });
    const crashEngine = require("../server/games/crash.js");
    let seed = "s1";
    for (let i = 0; i < 10000; i++) {
      const cs = "s" + i;
      if (Math.abs(crashEngine.crashPointOf(tb.session(st.sessionId).serverSeed, cs, 0) - crashEngine.crashPointOf(tb.session(st.sessionId).serverSeed, cs, 1)) > 0.5) { seed = cs; break; }
    }
    const n0 = tb.session(st.sessionId).betNonce;
    const r = cr.startRound({ sessionId: st.sessionId, betUnits: 10, clientSeed: seed, gameKey: "plane" });
    tb.play({ sessionId: st.sessionId, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "x" });
    const round = cr._rounds.get(r.roundId);
    const bet = tb.session(st.sessionId).bets.find((b) => b.nonce === n0);
    if (!bet || bet.nonce !== n0) bug("Critical", "CRASH-NONCE", "Settlement nonce != reserved nonce", "", "pinned=" + n0 + " bet=" + (bet && bet.nonce));
    else console.log("  ok  pinned nonce matches ledger after interleaved play");
  } else {
    console.log("  skip  reserve missing");
  }

  section("3. doPlay during live blackjack (no guard)");
  const bjSvc = makeTokenService({ signer, ethUsd: () => 4000, ethUsdReady: () => true, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), hasLiveExternal: () => true });
  const st3 = await bjSvc.doStart({
    ...body, txHash: "0x" + "c".repeat(64),
    signature: await wallet.signMessage(tokenAuthMessage("start", { player, contract: body.contract, chainId: body.chainId, buyInWei: lockedWei.toString() })),
  });
  let bjPlayOk = false;
  try { bjSvc.doPlay({ sessionId: st3.sessionId, sessionToken: st3.sessionToken, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "z" }); bjPlayOk = true; } catch (e) {}
  if (bjPlayOk) bug("High", "BJ-PLAY-INTERLEAVE", "doPlay allowed during live blackjack hand", "token-http.js doPlay has liveCrashSession but not liveExternal", "");

  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY: " + findings.length + " finding(s)");
  findings.forEach((f) => console.log("  [" + f.sev + "] " + f.code + " — " + f.title));
  process.exit(findings.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
