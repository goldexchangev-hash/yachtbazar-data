#!/usr/bin/env node
"use strict";
/**
 * v12.52 — Wave 1 auth hardening: #10 release replay-window, #12 uniform settle error,
 * #20 owner-authed house-state, #48 verifySession rejects closed sessions.
 *
 * Run: node CursorBugHunt-v3/wave1-auth-probe.js
 */
const { ethers } = require("ethers");
const { makeTokenService, tokenAuthMessage } = require("../server/token-http.js");

let failed = 0;
const ok = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) failed++; };

(async () => {
  console.log("=== wave1-auth-probe (v12.52) ===\n");
  const house = ethers.Wallet.createRandom();
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;
  const lockedWei = 25n * 10n ** 16n; // 0.25 ETH
  const hash = (p, net, nonce, cid, c) => ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
  const signer = { sign: (p, net, nonce, cid, c) => house.signMessage(ethers.getBytes(hash(p, BigInt(net), BigInt(nonce), cid, c))) };
  const base = { signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }) };
  const nowSec = () => Math.floor(Date.now() / 1000);

  // ── #10: release replay window ────────────────────────────────────────────
  const relSvc = makeTokenService(Object.assign({}, base, { readBjLocked: async () => lockedWei }));
  const rw = ethers.Wallet.createRandom(); const rp = rw.address;
  const relMsg = (expiry) => rw.signMessage(tokenAuthMessage("release", { player: rp, contract, chainId, expiry }));

  // fresh expiry → accepted
  let freshOk = false;
  try { const e = nowSec() + 300; const sig = await relMsg(e); const r = await relSvc.doRelease({ player: rp, contract, chainId, expiry: e, signature: sig }); freshOk = (r && r.netWei === "0"); } catch (e) {}
  ok("#10 release with a FRESH expiry is accepted", freshOk);

  // expired → rejected
  let expiredBlocked = false;
  try { const e = nowSec() - 600; const sig = await relMsg(e); await relSvc.doRelease({ player: rp, contract, chainId, expiry: e, signature: sig }); } catch (err) { expiredBlocked = /expired/i.test(err.message); }
  ok("#10 release with an EXPIRED expiry is rejected (replay window closed)", expiredBlocked);

  // far-future → rejected
  let futureBlocked = false;
  try { const e = nowSec() + 5000; const sig = await relMsg(e); await relSvc.doRelease({ player: rp, contract, chainId, expiry: e, signature: sig }); } catch (err) { futureBlocked = /not valid yet/i.test(err.message); }
  ok("#10 release with a FAR-FUTURE expiry is rejected", futureBlocked);

  // legacy (no expiry) still works (backward-compatible)
  let legacyOk = false;
  try { const sig = await rw.signMessage(tokenAuthMessage("release", { player: rp, contract, chainId })); const r = await relSvc.doRelease({ player: rp, contract, chainId, signature: sig }); legacyOk = (r && r.netWei === "0"); } catch (e) {}
  ok("#10 legacy release (no expiry) still works (backward-compatible)", legacyOk);

  // a captured expiry-bearing sig can't be downgraded to the legacy no-expiry message
  let noDowngrade = false;
  try { const e = nowSec() + 300; const sig = await relMsg(e); await relSvc.doRelease({ player: rp, contract, chainId, signature: sig }); } catch (err) { noDowngrade = /signature does not match/i.test(err.message); }
  ok("#10 an expiry-bearing signature can't be replayed as a no-expiry request", noDowngrade);

  // ── #12: uniform settle error (no enumeration) ────────────────────────────
  const setSvc = makeTokenService(Object.assign({}, base, {}));
  const sw = ethers.Wallet.createRandom(); const sp = sw.address;
  const sStart = { player: sp, contract, chainId, txHash: "0x" + "a1".repeat(32), buyInWei: lockedWei.toString() };
  sStart.signature = await sw.signMessage(tokenAuthMessage("start", { player: sp, contract, chainId, buyInWei: lockedWei.toString() }));
  const sStarted = await setSvc.doStart(sStart);
  let errNoSession = "", errBadSig = "";
  try { await setSvc.doSettle({ player: sp, sessionId: "deadbeef-nonexistent", signature: "0x" + "0".repeat(130) }); } catch (e) { errNoSession = e.message; }
  try { await setSvc.doSettle({ player: sp, sessionId: sStarted.sessionId, signature: "0x" + "0".repeat(130) }); } catch (e) { errBadSig = e.message; }
  ok("#12 settle: non-existent session and bad-sig give the SAME uniform error (no enumeration)", errNoSession && errNoSession === errBadSig && /could not be verified/i.test(errNoSession));

  // ── #48: verifySession rejects a closed session ───────────────────────────
  const vsToken = sStarted.sessionToken, vsId = sStarted.sessionId;
  ok("#48 verifySession returns the OPEN session before close", !!setSvc.verifySession(vsId, vsToken));
  await setSvc._bridge.settle({ sessionId: vsId }); // close it directly
  ok("#48 verifySession returns NULL once the session is closed", setSvc.verifySession(vsId, vsToken) === null);

  // ── #20: owner-authed house-state ─────────────────────────────────────────
  const ownerW = ethers.Wallet.createRandom();
  const hsSvc = makeTokenService(Object.assign({}, base, { readOwner: async () => ({ owner: ownerW.address, treasury: ownerW.address }) }));
  const hsSign = (expiry, who) => who.signMessage(tokenAuthMessage("house-state", { player: who.address, contract, chainId, expiry }));
  // owner with fresh expiry → ok
  let hsOwnerOk = false;
  try { const e = nowSec() + 600; const sig = await hsSign(e, ownerW); const r = await hsSvc.doHouseState({ owner: ownerW.address, contract, chainId, expiry: e, signature: sig }); hsOwnerOk = !!(r && r.ok); } catch (e) {}
  ok("#20 house-state: owner with a fresh signature is accepted", hsOwnerOk);
  // non-owner → rejected
  let hsDeny = false;
  const notOwner = ethers.Wallet.createRandom();
  try { const e = nowSec() + 600; const sig = await hsSign(e, notOwner); await hsSvc.doHouseState({ owner: notOwner.address, contract, chainId, expiry: e, signature: sig }); } catch (err) { hsDeny = /only the house owner/i.test(err.message); }
  ok("#20 house-state: a non-owner signer is rejected", hsDeny);
  // expired → rejected
  let hsExpired = false;
  try { const e = nowSec() - 600; const sig = await hsSign(e, ownerW); await hsSvc.doHouseState({ owner: ownerW.address, contract, chainId, expiry: e, signature: sig }); } catch (err) { hsExpired = /expired/i.test(err.message); }
  ok("#20 house-state: an expired authorization is rejected", hsExpired);

  console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
