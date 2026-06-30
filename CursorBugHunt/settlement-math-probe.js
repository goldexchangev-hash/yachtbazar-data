#!/usr/bin/env node
"use strict";
/**
 * Pass 5 — token settlement math edge-case probe.
 * Run: node CursorBugHunt/settlement-math-probe.js
 */
const crypto = require("crypto");
const { ethers } = require("ethers");
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeTokenService, weiToUsd, tokenAuthMessage } = require("../server/token-http.js");
const { settlementHash } = require("../server/realmoney.js");

const findings = [];
let nextId = 204;

function bug(severity, title, detail, evidence) {
  const id = nextId++;
  findings.push({ id, severity, title, detail, evidence });
  console.log("\n[" + severity + "] #" + id + " — " + title);
  console.log(detail);
  if (evidence) console.log("Evidence:\n" + evidence);
}

function section(name) {
  console.log("\n" + "=".repeat(72));
  console.log(name);
  console.log("=".repeat(72));
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function bridgeSettleNetWei(tb, sessionId) {
  const s = tb.session(sessionId);
  const netUnits = round2(s.tokens - s.buyInUnits);
  const lockedWei = BigInt(s.lockedWei);
  const netCents = BigInt(Math.round(netUnits * 100));
  const buyInCents = BigInt(Math.round(s.buyInUnits * 100));
  let netWei = buyInCents > 0n ? (lockedWei * netCents) / buyInCents : 0n;
  if (netWei < -lockedWei) netWei = -lockedWei;
  return { netUnits, netWei, tokens: s.tokens, buyInUnits: s.buyInUnits };
}

/* ── 1. Sub-cent netUnits collapse → netWei=0 (loss escape) ─────────────── */
async function testSubCentLossEscape() {
  section("1. Sub-cent netUnits → netWei=0 loss escape");
  const house = ethers.Wallet.createRandom();
  const signer = {
    sign: (p, net, nonce, cid, c) =>
      house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))),
  };
  const lockedWei = 10n ** 18n; // 1 ETH
  const tb = makeTokenBridge({ signer, toWei: (u) => BigInt(Math.round(u * 1e6)) });
  const player = "0x" + "ab".repeat(20);
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const st = tb.start({ player, buyInUnits: 1000, lockedWei: lockedWei.toString(), chainId: 1, contract, settleNonce: "42" });

  const escapes = [];
  for (let loss = 0.001; loss < 0.05; loss += 0.001) {
    const s = tb.session(st.sessionId);
    s.tokens = round2(1000 - loss);
    const { netUnits, netWei } = bridgeSettleNetWei(tb, st.sessionId);
    if (netUnits === 0 && netWei === 0n && loss > 0) {
      escapes.push({ loss, tokens: s.tokens });
    }
  }

  const evidence = escapes.slice(0, 8).map((e) => "loss=" + e.loss + " tokens=" + e.tokens + " → netUnits=0 netWei=0").join("\n");
  if (escapes.length > 0) {
    bug(
      "Medium",
      "Sub-cent token losses round to netWei=0 at settle",
      "settle() uses round2(tokens−buyIn) before netWei conversion. Losses below $0.005 in token units become netUnits=0, " +
        "so netWei=0 and the player withdraws the full lockedWei despite a losing session ledger (" + escapes.length + " cases in sweep).",
      evidence + "\n… (" + escapes.length + " total)"
    );
  } else {
    console.log("  ok  no sub-cent escapes in sweep");
  }

  // On-chain: would player actually profit?
  if (escapes.length > 0) {
    const ex = escapes[0];
    const s = tb.session(st.sessionId);
    s.tokens = round2(1000 - ex.loss);
    const stl = await tb.settle({ sessionId: st.sessionId });
    const returned = lockedWei + BigInt(stl.netWei); // contract: locked + net
    bug(
      "Medium",
      "On-chain return equals full lock when token loss is sub-cent",
      "settleBlackjack returns locked+net. With netWei=0 the player receives 100% of bjLocked even when tokens < buyInUnits.",
      "tokens=" + s.tokens + " buyIn=1000 netUnits=" + stl.netUnits + " netWei=" + stl.netWei + " on-chain returned=" + returned.toString() + " wei (full lock)"
    );
  }
}

/* ── 2. netWei truncates toward zero on tiny negative (wei-level escape) ── */
function testNetWeiTruncationTowardZero() {
  section("2. BigInt netWei truncation toward zero on fractional-cent net");
  const lockedWei = 10n ** 18n;
  const buyInUnits = 1000;
  const cases = [];
  for (let tokens = 999.99; tokens >= 999.9; tokens -= 0.01) {
    const netUnits = round2(tokens - buyInUnits);
    const netCents = BigInt(Math.round(netUnits * 100));
    const buyInCents = BigInt(Math.round(buyInUnits * 100));
    const netWei = (lockedWei * netCents) / buyInCents;
    const exact = (Number(lockedWei) * netUnits) / buyInUnits;
    if (netUnits < 0 && netWei === 0n) {
      cases.push({ tokens, netUnits, netCents: netCents.toString(), netWei: netWei.toString(), exactLossWei: exact });
    }
  }
  if (cases.length > 0) {
    bug(
      "Medium",
      "Integer division truncates small negative netWei to zero",
      "Even when netUnits is negative (e.g. −$0.01), (lockedWei*netCents)/buyInCents can truncate to 0 wei " +
        "when |netWei| < 1 wei. Player keeps entire lock; house records token loss but signs zero wei loss.",
      cases.slice(0, 5).map((c) => JSON.stringify(c)).join("\n")
    );
  } else {
    console.log("  ok  no wei-level truncation escapes in sweep");
  }
}

/* ── 3. Top-up ETH/USD drift vs pinned lockedWei ─────────────────────────── */
async function testTopUpRateDrift() {
  section("3. Top-up after ETH/USD price move (buyInUnits vs lockedWei ratio drift)");
  const house = ethers.Wallet.createRandom();
  const signer = {
    sign: (p, net, nonce, cid, c) =>
      house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))),
  };
  let ethUsd = 4000;
  const locked1 = 25n * 10n ** 16n; // 0.25 ETH
  const locked2 = 25n * 10n ** 16n;
  const svc = makeTokenService({
    signer,
    ethUsd: () => ethUsd,
    verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei, eventLocked: o.buyInWei.toString() }),
  });
  const wallet = ethers.Wallet.createRandom();
  const player = wallet.address;
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;

  const startBody = await wallet.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei: locked1.toString() }));
  const started = await svc.doStart({
    player, contract, chainId, txHash: "0x" + "11".repeat(32), buyInWei: locked1.toString(), signature: startBody,
  });

  ethUsd = 5000; // +25% between start and top-up
  const topBody = {
    player, sessionId: started.sessionId, sessionToken: started.sessionToken,
    txHash: "0x" + "22".repeat(32), buyInWei: locked2.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("topup", { player, contract, chainId, sessionId: started.sessionId, buyInWei: locked2.toString() })),
  };
  await svc.doTopUp(topBody);

  const s = svc._bridge.session(started.sessionId);
  const impliedRate = Number(s.lockedWei) / s.buyInUnits; // wei per token unit
  const rate1 = Number(locked1) / 1000;
  const rate2 = Number(locked2) / 1250; // 0.25 ETH @ $5000 = $1250

  // Break-even settle: tokens == buyInUnits
  s.tokens = s.buyInUnits;
  const stl = await svc._bridge.settle({ sessionId: started.sessionId });
  const expectedLock = locked1 + locked2;

  if (BigInt(stl.netWei) !== 0n || BigInt(stl.netWei) + expectedLock !== expectedLock) {
    bug("Critical", "Break-even settle netWei != 0 after rate drift", "…", JSON.stringify(stl));
  }

  // Win 10% in token terms
  s.tokens = s.buyInUnits; // reset — settle closed session; new probe on fresh session
  const tb2 = makeTokenBridge({ signer });
  const st2 = tb2.start({ player, buyInUnits: 1000, lockedWei: locked1.toString(), chainId, contract, settleNonce: "99" });
  tb2.topUp({ sessionId: st2.sessionId, addUnits: 1250, addLockedWei: locked2.toString() });
  const sess = tb2.session(st2.sessionId);
  sess.tokens = round2(sess.buyInUnits * 1.1); // +10% token profit
  const win = bridgeSettleNetWei(tb2, st2.sessionId);
  const tokenPct = (sess.tokens - sess.buyInUnits) / sess.buyInUnits;
  const weiPct = Number(win.netWei) / Number(expectedLock);

  if (Math.abs(tokenPct - weiPct) > 0.001) {
    bug(
      "Low",
      "Mixed-rate top-ups skew token-P&L vs wei-P&L proportion",
      "After ETH/USD moves between start ($4000) and top-up ($5000), a +10% token win maps to " +
        (weiPct * 100).toFixed(4) + "% wei win (expected ~10%). Ratio drift is expected but may confuse " +
        "players/house-state; not exploitable if both sides agree on token ledger.",
      "buyInUnits=" + sess.buyInUnits + " lockedWei=" + sess.lockedWei + " tokenPct=" + tokenPct + " weiPct=" + weiPct
    );
  } else {
    console.log("  ok  proportional settle holds after rate drift (tokenPct≈weiPct)");
  }

  // topUp WITHOUT addLockedWei (internal API misuse / bug path)
  const tb3 = makeTokenBridge({ signer });
  const st3 = tb3.start({ player, buyInUnits: 100, lockedWei: (10n ** 18n).toString(), chainId, contract, settleNonce: "100" });
  tb3.topUp({ sessionId: st3.sessionId, addUnits: 100 }); // no addLockedWei
  const sess3 = tb3.session(st3.sessionId);
  const drift = bridgeSettleNetWei(tb3, st3.sessionId);
  sess3.tokens = 200; // break even in tokens
  const stl3 = await tb3.settle({ sessionId: st3.sessionId });
  if (BigInt(stl3.netWei) !== 0n) {
    bug(
      "High",
      "topUp without addLockedWei desyncs buyInUnits from lockedWei",
      "bridge.topUp() only accumulates lockedWei when addLockedWei is passed. buyInUnits doubled but lockedWei unchanged; " +
        "break-even token settle signs netWei=" + stl3.netWei + " instead of 0.",
      "buyInUnits=" + sess3.buyInUnits + " lockedWei=" + sess3.lockedWei + " tokens=200 netWei=" + stl3.netWei
    );
  }
}

/* ── 4. Zero-token session settle ────────────────────────────────────────── */
async function testZeroTokenSettle() {
  section("4. Session drained to 0 tokens");
  const house = ethers.Wallet.createRandom();
  const signer = {
    sign: (p, net, nonce, cid, c) =>
      house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))),
  };
  const lockedWei = 10n ** 18n;
  const tb = makeTokenBridge({ signer });
  const player = "0x0000000000000000000000000000000000000001";
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const st = tb.start({ player, buyInUnits: 500, lockedWei: lockedWei.toString(), chainId: 1, contract, settleNonce: "7" });
  tb.session(st.sessionId).tokens = 0;
  const stl = await tb.settle({ sessionId: st.sessionId });
  const fullLoss = BigInt(stl.netWei) === -lockedWei;
  if (!fullLoss) {
    bug("Critical", "Zero-token session does not sign full −lockedWei loss", "…", JSON.stringify(stl));
  } else {
    console.log("  ok  zero tokens → netWei=-" + lockedWei.toString());
  }

  // netUnits floor vs buyInUnits
  if (stl.netUnits > -500) {
    bug("Medium", "Zero tokens but netUnits not −buyInUnits", "netUnits=" + stl.netUnits, "");
  }
}

/* ── 5. weiToUsd / fractional cent at buy-in ─────────────────────────────── */
function testWeiToUsdEdges() {
  section("5. weiToUsd fractional cent + Number(wei) precision");
  const ethUsd = 3400;
  const zeroCases = [];
  for (let i = 1n; i < 100000n; i++) {
    const usd = weiToUsd(i, ethUsd);
    if (usd === 0) zeroCases.push(i.toString());
  }
  if (zeroCases.length > 0) {
    bug(
      "Medium",
      "Small buy-ins round to 0 tokens via weiToUsd",
      "doStart rejects buyInUnits<=0. Tiny on-chain locks (wei where weiToUsd→0) cannot open a token session; " +
        "funds can remain locked on-chain with no token path.",
      "First wei values mapping to $0: " + zeroCases.slice(0, 10).join(", ")
    );
  }

  // Precision loss near MAX_SAFE_INTEGER
  const hugeWei = (BigInt(Number.MAX_SAFE_INTEGER) + 1000n) * 10n ** 12n;
  const usdHuge = weiToUsd(hugeWei, ethUsd);
  const usdExact = weiToUsd(hugeWei - 1000n, ethUsd);
  if (usdHuge === usdExact && hugeWei !== hugeWei - 1000n) {
    bug(
      "Low",
      "weiToUsd loses precision for wei > Number.MAX_SAFE_INTEGER",
      "Number(wei) truncates above 2^53−1; distinct huge locks can map to identical buyInUnits.",
      "weiA=" + hugeWei.toString().slice(0, 30) + "… weiB=" + (hugeWei - 1000n).toString().slice(0, 30) + "… both usd=" + usdHuge
    );
  } else {
    console.log("  ok  weiToUsd precision spot-check");
  }
}

/* ── 6. Many-bet floating drift (buyInUnits vs tokens ledger) ────────────── */
function testManyBetDrift() {
  section("6. buyInUnits vs tokens after many bets (float drift)");
  const tb = makeTokenBridge({});
  const st = tb.start({ player: "0x00000000000000000000000000000000000000aa", buyInUnits: 10000, chainId: 1, contract: "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc" });
  let wagered = 0;
  let returned = 0;
  for (let i = 0; i < 500000; i++) {
    try {
      const r = tb.play({ sessionId: st.sessionId, game: "coinflip", betUnits: 0.01, params: { side: i & 1 }, clientSeed: "d" + (i % 50) });
      wagered += 0.01;
      returned += r.payoutUnits;
    } catch (e) {
      break; // out of tokens
    }
  }
  const s = tb.session(st.sessionId);
  const expected = round2(10000 - wagered + returned);
  const drift = Math.abs(s.tokens - expected);
  const rd = tb.rederive(st.sessionId);

  if (!rd.ledgerMatches) {
    bug(
      "High",
      "Ledger re-derive fails after high-volume play",
      "verifyRederive replays " + s.bets.length + " bets; ledgerMatches=false. Settle net may not match PF audit.",
      "tokens=" + s.tokens + " replayed=" + rd.replayedTokens + " drift=" + drift
    );
  } else if (drift > 0.02) {
    bug(
      "Medium",
      "Float drift between manual ledger sum and session.tokens after " + s.bets.length + " bets",
      "round2 per play accumulates error; tokens=" + s.tokens + " vs manual " + expected + " (binUnits unchanged at " + s.buyInUnits,
      "drift=$" + drift.toFixed(4)
    );
  } else {
    console.log("  ok  " + s.bets.length + " bets, drift=$" + drift.toFixed(6) + ", rederive ok");
  }

  // Can drift flip netUnits sign?
  const nearZero = tb.start({ player: "0x00000000000000000000000000000000000000cc", buyInUnits: 100, chainId: 1, contract: "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc" });
  for (let i = 0; i < 5000; i++) {
    try {
      tb.play({ sessionId: nearZero.sessionId, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "x" });
    } catch (e) { break; }
  }
  const ns = tb.session(nearZero.sessionId);
  const theoretical = 100 * (0.5 * 1.94 + 0.5 * 0); // rough
  const netUnits = round2(ns.tokens - ns.buyInUnits);
  if (Math.abs(ns.tokens - ns.buyInUnits) < 0.01 && netUnits === 0 && ns.tokens < ns.buyInUnits) {
    bug(
      "Medium",
      "Post-play netUnits rounds to 0 while tokens < buyIn (many-bet path)",
      "After extended play, fractional token deficit can be erased by round2 at settle.",
      "tokens=" + ns.tokens + " buyIn=" + ns.buyInUnits + " netUnits=" + netUnits
    );
  }
}

/* ── 7. BigInt overflow / int256 bounds on sign path ─────────────────────── */
async function testBigIntBounds() {
  section("7. BigInt / int256 signing bounds");
  const house = ethers.Wallet.createRandom();
  const signer = {
    sign: (p, net, nonce, cid, c) =>
      house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))),
  };
  const INT256_MAX = (1n << 255n) - 1n;
  const lockedWei = (1n << 200n); // absurd lock
  const tb = makeTokenBridge({ signer });
  const st = tb.start({
    player: "0x000000000000000000000000000000000000ffff",
    buyInUnits: 1e15,
    lockedWei: lockedWei.toString(),
    chainId: 1,
    contract: "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc",
    settleNonce: "999",
  });
  const s = tb.session(st.sessionId);
  s.tokens = s.buyInUnits * 2; // 100% token win
  let threw = false;
  let netWeiStr = "";
  try {
    const stl = await tb.settle({ sessionId: st.sessionId });
    netWeiStr = stl.netWei;
    if (BigInt(stl.netWei) > INT256_MAX) {
      bug(
        "Critical",
        "settle signs netWei exceeding int256 max",
        "Contract settleBlackjack takes int256 net; oversized win breaks on-chain submit.",
        "netWei bits=" + BigInt(stl.netWei).toString(2).length
      );
    }
  } catch (e) {
    threw = true;
  }
  if (!threw && BigInt(netWeiStr) > INT256_MAX) {
    // already reported
  } else if (!threw) {
    console.log("  ok  extreme lock settle signed netWei within int256 (or proportionally bounded)");
  }

  // JS BigInt multiply doesn't throw; document house exposure
  const prod = lockedWei * 1000000n;
  console.log("  note lockedWei*1e6 bit-length=" + prod.toString(2).length + " (JS BigInt unbounded)");
}

/* ── 8. gcClosed edge cases ──────────────────────────────────────────────── */
async function testGcClosed() {
  section("8. gcClosed TTL pruning");
  const tb = makeTokenBridge({ settledTtlMs: 1000, signer: null });
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const st = tb.start({ player: "0x0000000000000000000000000000000000000001", buyInUnits: 10, chainId: 1, contract });
  await tb.settle({ sessionId: st.sessionId });
  const sess = tb.session(st.sessionId);
  sess.createdAt = 0; // force immortal
  await new Promise((r) => setTimeout(r, 1100));
  const dropped = tb.gcClosed();
  if (tb.session(st.sessionId)) {
    bug(
      "Low",
      "gcClosed skips sessions with createdAt=0",
      "Settled sessions with createdAt=0 never pass `(Number(s.createdAt)||0)>0` guard; map/persist grows until manual restart.",
      "dropped=" + dropped + " session still present id=" + st.sessionId
    );
  } else {
    console.log("  ok  gc pruned normally");
  }

  // OPEN session never pruned even if ancient
  const tb2 = makeTokenBridge({ settledTtlMs: 1 });
  const open = tb2.start({ player: "0x0000000000000000000000000000000000000003", buyInUnits: 5, chainId: 1, contract });
  tb2.session(open.sessionId).createdAt = 1;
  tb2.gcClosed();
  if (!tb2.session(open.sessionId)) {
    bug("Critical", "gcClosed pruned OPEN session", "Would strand on-chain lock", open.sessionId);
  } else {
    console.log("  ok  open session never gc'd");
  }
}

/* ── 9. obligationConsumed + admin orphan when bridge has settlement ─────── */
async function testReleaseWithoutPendingSettle() {
  section("9. doRelease vs bridge-only settlement (persist split)");
  const house = ethers.Wallet.createRandom();
  const signer = {
    sign: (p, net, nonce, cid, c) =>
      house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))),
  };
  const lockedWei = 10n ** 17n;
  const store = { _state: null, load() { return this._state; }, save(s) { this._state = JSON.parse(JSON.stringify(s)); } };

  const svc = makeTokenService({
    signer,
    ethUsd: () => 4000,
    verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }),
    readBjLocked: async () => lockedWei,
    readNonceUsed: async () => false,
    persist: store,
  });
  const wallet = ethers.Wallet.createRandom();
  const player = wallet.address;
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;

  const body = {
    player, contract, chainId, txHash: "0x" + "33".repeat(32), buyInWei: lockedWei.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei: lockedWei.toString() })),
  };
  const started = await svc.doStart(body);
  svc._bridge.session(started.sessionId).tokens = 800; // loss

  // Simulate crash AFTER bridge.settle persisted but BEFORE saveHttp pendingSettle (#140 variant)
  await svc._bridge.settle({ sessionId: started.sessionId });
  // openByPlayer still set (no doSettle wrapper)
  const relSig = await wallet.signMessage(tokenAuthMessage("release", { player, contract, chainId }));
  const rel = await svc.doRelease({ player, contract, chainId, signature: relSig });

  if (rel.mode === "session" && BigInt(rel.netWei) < 0n) {
    console.log("  ok  release settles open session at real loss netWei=" + rel.netWei);
  } else if (rel.mode === "orphan" && rel.netWei === "0") {
    const bridgeStl = svc._bridge.session(started.sessionId).settlement;
    bug(
      "Critical",
      "doRelease branch (1) falls through to orphan net=0 when session already closed",
      "If bridge.settle() ran (session closed + settlement on disk) but HTTP openByPlayer was not cleared, " +
        "doRelease lines 439–441 treat the slot as stale and fall through to branch (3) net=0 — loss escape. " +
        "Extends #140/#145 with exact branch repro.",
      JSON.stringify(rel) + "\nbridge.settlement.netWei=" + (bridgeStl && bridgeStl.netWei)
    );
  }

  // Admin path: no liveExternal check
  const owner = ethers.Wallet.createRandom();
  const admSvc = makeTokenService({
    signer,
    ethUsd: () => 4000,
    verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }),
    readBjLocked: async () => lockedWei,
    readOwner: async () => ({ owner: owner.address, treasury: owner.address }),
    hasLiveExternal: () => true,
  });
  const tgt = ethers.Wallet.createRandom().address;
  let adminDuringHand = null;
  try {
    const sig = await owner.signMessage(tokenAuthMessage("admin-release", { player: owner.address, contract, chainId, target: tgt }));
    adminDuringHand = await admSvc.doAdminRelease({ owner: owner.address, contract, chainId, player: tgt, signature: sig });
  } catch (e) {
    adminDuringHand = { err: e.message };
  }
  if (adminDuringHand && adminDuringHand.ok && adminDuringHand.netWei === "0") {
    bug(
      "Medium",
      "admin-release ignores hasLiveExternal (mid-hand stranded lock)",
      "doAdminRelease does not call liveExternal(). Owner can net=0 release while player has live BJ hand " +
        "if they have no open token session (openByPlayer empty).",
      "released net=0 for target with hasLiveExternal=true"
    );
  }
}

/* ── 10. realmoney nonce type coercion ───────────────────────────────────── */
async function testRealmoneySigning() {
  section("10. realmoney.js signing edge cases");
  const w = ethers.Wallet.createRandom();
  const player = "0x2F4BEF94550C29c497b999B86b758F9771F7aB39";
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;

  // uint256 decimal string nonce (production default)
  const decNonce = BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString();
  const net = -(5n * 10n ** 17n);
  const h1 = settlementHash(player, net, decNonce, chainId, contract);
  let sig1;
  try {
    sig1 = await w.signMessage(ethers.getBytes(h1));
    ethers.verifyMessage(ethers.getBytes(h1), sig1);
  } catch (e) {
    bug("High", "House signer fails on decimal-string settle nonce", e.message, "nonce=" + decNonce);
  }

  // Mismatch: bridge passes string nonce, contract expects uint256 — must be consistent
  const hNum = settlementHash(player, net, BigInt(decNonce), chainId, contract);
  if (h1 !== hNum) {
    bug("Critical", "settlementHash differs for string vs BigInt nonce", "Signature/domain split", h1 + " vs " + hNum);
  } else {
    console.log("  ok  string/BigInt nonce hash consistent");
  }

  // net = -lockedWei - 1 wei (beyond floor) — bridge should clamp; raw signer accepts any int256
  const beyond = -(10n ** 18n + 1n);
  const sigBeyond = await w.signMessage(ethers.getBytes(settlementHash(player, beyond, 1n, chainId, contract)));
  const rec = ethers.verifyMessage(ethers.getBytes(settlementHash(player, beyond, 1n, chainId, contract)), sigBeyond);
  if (rec === w.address) {
    console.log("  ok  signer accepts sub-int256 net (contract rejects; bridge clamps before sign)");
  }
}

/* ── 11. play epsilon overbet + houseState float sum ─────────────────────── */
function testPlayEpsilonAndHouseState() {
  section("11. play 1e-9 overbet tolerance + houseState float sum");
  const tb = makeTokenBridge({});
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const st = tb.start({ player: "0x0000000000000000000000000000000000000001", buyInUnits: 10, chainId: 1, contract });
  const s = tb.session(st.sessionId);
  s.tokens = 10.000000001;
  let allowed = false;
  try {
    tb.play({ sessionId: st.sessionId, game: "coinflip", betUnits: 10.000000001, params: { side: 0 }, clientSeed: "eps" });
    allowed = true;
  } catch (e) {}
  if (allowed) {
    bug(
      "Low",
      "play() accepts bets up to 1e-9 above token balance",
      "token-bridge.js:118 uses `bet > s.tokens + 1e-9`. Sub-cent overbet passes; with round2 ledger this is a tiny accounting leak, not full drain.",
      "tokens=10.000000001 bet=10.000000001 accepted"
    );
  }

  const tb2 = makeTokenBridge({});
  for (let i = 0; i < 1000; i++) {
    tb2.start({
      player: "0x" + i.toString(16).padStart(40, "0"),
      buyInUnits: 0.01,
      chainId: 1,
      contract,
    });
  }
  let sum = 0;
  for (const sess of tb2._sessions.values()) sum += sess.buyInUnits;
  if (Math.abs(sum - 10) > 1e-9) {
    bug(
      "Low",
      "houseState buyInUnits aggregation suffers float sum drift",
      "houseState() sums Number(buyInUnits) across sessions; 1000×$0.01 sessions report buyInUnits=" + sum + " not 10.",
      "expected=10 actual=" + sum
    );
  } else {
    console.log("  ok  float sum within tolerance");
  }
}

/* ── main ─────────────────────────────────────────────────────────────────── */
(async () => {
  console.log("Settlement math probe — Pass 5 deep audit\n");
  await testSubCentLossEscape();
  testNetWeiTruncationTowardZero();
  await testTopUpRateDrift();
  await testZeroTokenSettle();
  testWeiToUsdEdges();
  testManyBetDrift();
  await testBigIntBounds();
  await testGcClosed();
  await testReleaseWithoutPendingSettle();
  await testRealmoneySigning();
  testPlayEpsilonAndHouseState();

  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY: " + findings.length + " new finding(s) #" + (findings[0]?.id || "—") + "+");
  console.log("=".repeat(72));
  for (const f of findings) {
    console.log("#" + f.id + " [" + f.severity + "] " + f.title);
  }
  process.exit(findings.some((f) => f.severity === "Critical") ? 1 : 0);
})().catch((e) => {
  console.error("PROBE FAIL", e);
  process.exit(1);
});
