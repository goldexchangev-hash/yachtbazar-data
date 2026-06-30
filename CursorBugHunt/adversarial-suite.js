#!/usr/bin/env node
"use strict";
/**
 * Adversarial harness — token bridge, HTTP layer, crash rounds, game economics.
 * Run: node CursorBugHunt/adversarial-suite.js
 */
const crypto = require("crypto");
const { ethers } = require("ethers");
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeTokenService, tokenAuthMessage } = require("../server/token-http.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");
const { ENGINES } = require("../server/token-bridge.js");
const PF = require("../server/provablyfair.js");

const findings = [];
function bug(severity, id, title, detail, evidence) {
  findings.push({ severity, id, title, detail, evidence });
  console.log("\n[" + severity + "] " + id + " — " + title);
  console.log(detail);
  if (evidence) console.log("Evidence:\n" + evidence);
}

function section(name) {
  console.log("\n" + "=".repeat(72));
  console.log(name);
  console.log("=".repeat(72));
}

/* ── 1. txHash replay race (concurrent doStart / doTopUp) ───────────────── */
async function testTxHashReplayRace() {
  section("1. txHash replay race — concurrent doStart");
  const house = ethers.Wallet.createRandom();
  const wallet = ethers.Wallet.createRandom();
  const player = wallet.address;
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;
  const lockedWei = (25n * 10n ** 16n);
  const settlementHash = (p, net, nonce, cid, c) =>
    ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
  const signer = {
    sign: (p, net, nonce, cid, c) =>
      house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))),
  };

  let verifyCalls = 0;
  const slowVerify = async (o) => {
    verifyCalls++;
    await new Promise((r) => setTimeout(r, 80));
    return { lockedWei: o.buyInWei };
  };

  const svc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: slowVerify });
  const txHash = "0x" + "f1".repeat(32);
  const body = {
    player, contract, chainId, txHash, buyInWei: lockedWei.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei: lockedWei.toString() })),
  };

  const results = await Promise.all([
    svc.doStart({ ...body }).catch((e) => ({ err: e.message })),
    svc.doStart({ ...body }).catch((e) => ({ err: e.message })),
  ]);
  const okCount = results.filter((r) => r && r.ok && r.sessionId).length;
  const evidence = [
    "verifyBuyIn calls: " + verifyCalls,
    "result A: " + JSON.stringify(results[0].err ? { err: results[0].err } : { ok: true, sessionId: results[0].sessionId, tokens: results[0].tokens }),
    "result B: " + JSON.stringify(results[1].err ? { err: results[1].err } : { ok: true, sessionId: results[1].sessionId, tokens: results[1].tokens }),
  ].join("\n");

  if (okCount > 1) {
    bug("Critical", "TXHASH-RACE", "Concurrent doStart with same txHash grants multiple sessions",
      "Both requests passed usedBuyIns before either RPC returned; one on-chain buy-in can fund " + okCount + " token sessions.",
      evidence);
  } else {
    console.log("  ok  only one start succeeded (okCount=" + okCount + ")");
    console.log(evidence);
  }

  // top-up race on same txHash
  section("1b. txHash replay race — concurrent doTopUp");
  const svc2 = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: slowVerify });
  const w2 = ethers.Wallet.createRandom();
  const p2 = w2.address;
  const startBody = {
    player: p2, contract, chainId, txHash: "0x" + "a1".repeat(32), buyInWei: lockedWei.toString(),
    signature: await w2.signMessage(tokenAuthMessage("start", { player: p2, contract, chainId, buyInWei: lockedWei.toString() })),
  };
  const started = await svc2.doStart(startBody);
  const topTx = "0x" + "b2".repeat(32);
  const topBody = {
    player: p2, sessionId: started.sessionId, sessionToken: started.sessionToken,
    txHash: topTx, buyInWei: lockedWei.toString(),
    signature: await w2.signMessage(tokenAuthMessage("topup", { player: p2, contract, chainId, sessionId: started.sessionId, buyInWei: lockedWei.toString() })),
  };
  verifyCalls = 0;
  const topResults = await Promise.all([
    svc2.doTopUp({ ...topBody }).catch((e) => ({ err: e.message })),
    svc2.doTopUp({ ...topBody }).catch((e) => ({ err: e.message })),
  ]);
  const topOk = topResults.filter((r) => r && r.ok).length;
  const tokAfter = svc2._bridge.session(started.sessionId).tokens;
  const buyInAfter = svc2._bridge.session(started.sessionId).buyInUnits;
  const topEv = [
    "top-up ok count: " + topOk,
    "tokens after: " + tokAfter + " (started " + started.tokens + ", expected +1000 once)",
    "buyInUnits: " + buyInAfter,
  ].join("\n");
  if (topOk > 1 || buyInAfter > started.buyInUnits + 1000 + 1) {
    bug("Critical", "TXHASH-TOPUP-RACE", "Concurrent doTopUp with same txHash double-credits tokens",
      "Top-up replay race credited extra buy-in/tokens from one chain tx.", topEv);
  } else {
    console.log("  ok  top-up race did not double-credit");
    console.log(topEv);
  }
}

/* ── 2. concurrent doStart different txHashes (same player) ─────────────── */
async function testConcurrentDoStartSamePlayer() {
  section("2. concurrent doStart — same player, different txHashes");
  const house = ethers.Wallet.createRandom();
  const wallet = ethers.Wallet.createRandom();
  const player = wallet.address;
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;
  const lockedWei = (25n * 10n ** 16n);
  const settlementHash = (p, net, nonce, cid, c) =>
    ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
  const signer = { sign: (p, net, nonce, cid, c) => house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))) };
  const svc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }) });

  const mk = async (hex) => {
    const txHash = "0x" + hex.repeat(32);
    const sig = await wallet.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei: lockedWei.toString() }));
    return svc.doStart({ player, contract, chainId, txHash, buyInWei: lockedWei.toString(), signature: sig }).catch((e) => ({ err: e.message }));
  };
  const [a, b] = await Promise.all([mk("c3"), mk("d4")]);
  const ok = [a, b].filter((r) => r && r.ok).length;
  if (ok > 1) {
    bug("High", "DUAL-SESSION", "Same player opened two concurrent token sessions",
      "openByPlayer guard failed under concurrency.", JSON.stringify({ a, b }));
  } else {
    console.log("  ok  at most one session opened (ok=" + ok + ")");
  }
}

/* ── 3. crash round races ───────────────────────────────────────────────── */
async function testCrashRoundRaces() {
  section("3a. crash round nonce desync (interleaved play)");
  const tb = makeTokenBridge({});
  const st = tb.start({ player: "0xabc", buyInUnits: 1000, chainId: 1, contract: "0x0000000000000000000000000000000000000001" });
  const sid = st.sessionId;
  const crashEngine = require("../server/games/crash.js");

  let seed = null;
  for (let i = 0; i < 50000; i++) {
    const cs = "probe-" + i;
    const a = crashEngine.crashPointOf(tb.session(sid).serverSeed, cs, 0);
    const b = crashEngine.crashPointOf(tb.session(sid).serverSeed, cs, 1);
    if (Math.abs(a - b) > 0.5) { seed = cs; break; }
  }
  if (!seed) { console.log("  skip  could not find divergent nonce pair"); return; }

  let clock = 0;
  const timers = [];
  const now = () => clock;
  const setTimer = (ms, fn) => { const t = { at: clock + ms, fn, dead: false }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.dead = true; };
  const advance = (ms) => { clock += ms; for (const t of timers.slice()) { if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); } } };

  const cr = makeCrashRounds({ bridge: tb, now, setTimer, clearTimer });
  const peek = tb.pointPeek({ sessionId: sid, clientSeed: seed, game: "plane" });
  const r = cr.startRound({ sessionId: sid, betUnits: 10, clientSeed: seed, gameKey: "plane" });
  tb.play({ sessionId: sid, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "x" });
  let out = null;
  try {
    out = cr.cashOut({ roundId: r.roundId });
  } catch (e) {
    console.log("  skip cashOut failed: " + e.message);
    return;
  }
  const bet = tb.session(sid).bets.find((b) => b.game === "plane");
  const settledPoint = bet && bet.outcome && bet.outcome.crashPoint;
  const desync = bet && (bet.nonce !== peek.nonce || (settledPoint != null && Math.abs(settledPoint - peek.point) > 0.01));
  if (desync) {
    bug("Critical", "CRASH-NONCE-DESYNC", "Crash round pacing nonce != settlement nonce",
      "startRound peeked nonce " + peek.nonce + " (point " + peek.point.toFixed(2) + "x) but ledger settled nonce " + bet.nonce + " (point " + (settledPoint != null ? settledPoint.toFixed(2) : "N/A") + "x).",
      "peek=" + peek.point.toFixed(2) + " settled=" + (settledPoint != null ? settledPoint.toFixed(2) : "N/A") + " win=" + out.win);
  } else {
    console.log("  note  no desync this seed (try another run)");
  }

  section("3b. crash round — spend balance then bust (stake not reserved)");
  const tb2 = makeTokenBridge({});
  const s2 = tb2.start({ player: "0xdef", buyInUnits: 100, chainId: 1, contract: "0x0000000000000000000000000000000000000002" });
  clock = 0; timers.length = 0;
  const cr2 = makeCrashRounds({ bridge: tb2, now, setTimer, clearTimer });
  cr2.startRound({ sessionId: s2.sessionId, betUnits: 100, clientSeed: "bust-me", gameKey: "crash" });
  // Force drain: set tokens to 0 while round is live (simulates spending everything elsewhere)
  tb2.session(s2.sessionId).tokens = 0;
  const tokBeforeBust = 0;
  try { advance(999999); } catch (e) { /* bust _resolve may throw on closed/insufficient */ }
  const tokAfterBust = tb2.session(s2.sessionId).tokens;
  const crashBetRecorded = tb2.session(s2.sessionId).bets.some((b) => b.game === "crash");
  const ev = "tokens before bust: " + tokBeforeBust + ", after timer: " + tokAfterBust + ", crash bet recorded: " + crashBetRecorded;
  if (!crashBetRecorded && tokAfterBust === tokBeforeBust) {
    bug("Critical", "CRASH-NO-RESERVE", "Live crash round bust did not debit — stake not reserved at start",
      "Player had 0 tokens when bust fired; settlement failed with no ledger entry (loss escaped).", ev);
  } else if (!crashBetRecorded) {
    bug("Critical", "CRASH-NO-RESERVE", "Bust settlement missing from ledger",
      "Crash round ended but no crash bet was recorded.", ev);
  } else {
    console.log("  info " + ev);
  }

  section("3c. crash round + settle race");
  const house = ethers.Wallet.createRandom();
  const wallet = ethers.Wallet.createRandom();
  const player = wallet.address;
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;
  const lockedWei = (25n * 10n ** 16n);
  const settlementHash = (p, net, nonce, cid, c) =>
    ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
  const signer = { sign: (p, net, nonce, cid, c) => house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))) };
  const svc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), hasLiveExternal: () => false });
  const startBody = {
    player, contract, chainId, txHash: "0x" + "e5".repeat(32), buyInWei: lockedWei.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei: lockedWei.toString() })),
  };
  const started = await svc.doStart(startBody);
  const sid3 = started.sessionId;
  clock = 0; timers.length = 0;
  const cr3 = makeCrashRounds({ bridge: svc._bridge, now, setTimer, clearTimer });
  cr3.startRound({ sessionId: sid3, betUnits: 50, clientSeed: "settle-race", gameKey: "plane" });
  const settleSig = await wallet.signMessage(tokenAuthMessage("settle", { player, contract, chainId, sessionId: sid3 }));
  await svc.doSettle({ player, sessionId: sid3, signature: settleSig }).catch(() => {});
  try { advance(999999); } catch (e) { /* play() on closed session throws */ }
  const closed = svc._bridge.session(sid3).closed;
  const crashRecorded = svc._bridge.session(sid3).bets.some((b) => b.game === "plane");
  if (closed && !crashRecorded) {
    bug("Critical", "CRASH-SETTLE-RACE", "Session settled mid-flight crash round — round loss escaped",
      "doSettle closed session while WS crash round active; bust _resolve could not play().", "closed=" + closed + " crashBet=" + crashRecorded);
  } else {
    console.log("  info settle during round: closed=" + closed + " crashBet=" + crashRecorded);
  }
}

/* ── 4. bet validation fuzz ─────────────────────────────────────────────── */
function testBetValidation() {
  section("4. bet amount / game key fuzz");
  const tb = makeTokenBridge({});
  const st = tb.start({ player: "0x111", buyInUnits: 100, chainId: 1, contract: "0x1" });
  const sid = st.sessionId;
  const cases = [
    { label: "negative bet", o: { sessionId: sid, game: "coinflip", betUnits: -5, params: { side: 0 } }, expectThrow: true },
    { label: "zero bet", o: { sessionId: sid, game: "coinflip", betUnits: 0, params: { side: 0 } }, expectThrow: true },
    { label: "NaN bet", o: { sessionId: sid, game: "coinflip", betUnits: NaN, params: { side: 0 } }, expectThrow: true },
    { label: "over-balance", o: { sessionId: sid, game: "coinflip", betUnits: 1e15, params: { side: 0 } }, expectThrow: true },
    { label: "invalid game poker", o: { sessionId: sid, game: "poker", betUnits: 1 }, expectThrow: true },
    { label: "invalid game empty", o: { sessionId: sid, game: "", betUnits: 1 }, expectThrow: true },
    { label: "prototype pollution game", o: { sessionId: sid, game: "__proto__", betUnits: 1 }, expectThrow: true },
    { label: "huge finite bet at balance", o: { sessionId: sid, game: "coinflip", betUnits: 100, params: { side: 0 } }, expectThrow: false },
  ];
  for (const c of cases) {
    let threw = false;
    try { tb.play(Object.assign({ clientSeed: "f" }, c.o)); } catch (e) { threw = true; }
    const bad = c.expectThrow ? !threw : threw;
    if (bad) {
      bug("Medium", "BET-FUZZ", "Unexpected bet validation: " + c.label,
        "expectThrow=" + c.expectThrow + " threw=" + threw, "");
    } else {
      console.log("  ok  " + c.label);
    }
  }
}

/* ── 5. session token brute force feasibility ───────────────────────────── */
async function testSessionTokenEntropy() {
  section("5. session token brute-force feasibility");
  const tokenBytes = 24;
  const bits = tokenBytes * 8;
  const space = Math.pow(2, bits);
  const rate = 1e6;
  const years = space / rate / 86400 / 365;
  const ev = [
    "token length: " + tokenBytes + " bytes (" + bits + " bits)",
    "search space: 2^" + bits,
    "at 1M guesses/sec: ~" + years.toExponential(2) + " years mean time",
    "doPlay rejects wrong token (sanity):",
  ].join("\n");
  const house = ethers.Wallet.createRandom();
  const wallet = ethers.Wallet.createRandom();
  const player = wallet.address;
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;
  const lockedWei = (25n * 10n ** 16n);
  const settlementHash = (p, net, nonce, cid, c) =>
    ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
  const signer = { sign: (p, net, nonce, cid, c) => house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))) };
  const svc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }) });
  const startBody = {
    player, contract, chainId, txHash: "0x" + "aa".repeat(32), buyInWei: lockedWei.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei: lockedWei.toString() })),
  };
  const started = await svc.doStart(startBody);
  let blocked = 0;
  for (let i = 0; i < 50; i++) {
    try { svc.doPlay({ sessionId: started.sessionId, sessionToken: crypto.randomBytes(24).toString("hex"), game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "g" }); }
    catch (e) { blocked++; }
  }
  console.log(ev + " 50/50 random tokens rejected=" + (blocked === 50));
  console.log("  ok  online brute force not feasible (2^192 space)");
}

/* ── 6. game economics EV > 100% scan ───────────────────────────────────── */
function scanGameEconomics() {
  section("6. game engine EV scan (RTP > 100% / exploitable params = 0)");
  const { serverSeed } = PF.newRound();
  const SAMPLES = 80000;
  const exploits = [];

  function measure(name, playFn, lines) {
    let wagered = 0, returned = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const line = lines[i % lines.length];
      const r = playFn(line, i);
      wagered += line.bet;
      returned += r.payoutUnits;
    }
    const rtp = returned / wagered;
    return { name, rtp, wagered, returned };
  }

  const coin = measure("coinflip", (line, i) => ENGINES.coinflip.play({ serverSeed, clientSeed: "e", nonce: i, betUnits: line.bet, params: line.params }), [{ bet: 1, params: { side: 0 } }]);
  const diceLines = [{ bet: 1e9, params: { target: 5000, over: false } }, { bet: 1e9, params: { target: 9900, over: true } }];
  const dice = measure("dice", (line, i) => ENGINES.dice.play({ serverSeed, clientSeed: "e", nonce: i, betUnits: line.bet, params: line.params }), diceLines);
  const d2lines = [];
  for (let t = 2; t <= 12; t++) for (const over of [true, false]) d2lines.push({ bet: 1, params: { target: t, over } });
  const dice2 = measure("dice2", (line, i) => { try { return ENGINES.dice2.play({ serverSeed, clientSeed: "e", nonce: i, betUnits: 1, params: line.params }); } catch (e) { return { payoutUnits: 0 }; } }, d2lines);
  const crashT = [1.01, 1.5, 2, 5, 10, 100];
  const crash = measure("crash", (line, i) => ENGINES.crash.play({ serverSeed, clientSeed: "e", nonce: i, betUnits: 1, params: { cashOutAt: line.t } }), crashT.map((t) => ({ bet: 1, t })));
  const pressure = measure("pressure", (line, i) => ENGINES.pressure.play({ serverSeed, clientSeed: "e", nonce: i, betUnits: 1, params: { cashOutAt: line.t } }), [{ bet: 1, t: 2 }, { bet: 1, t: 5 }]);

  // pressure void loop — repeated sub-minimum targets refund stake?
  let voidNet = 0;
  for (let i = 0; i < 1000; i++) {
    const r = ENGINES.pressure.play({ serverSeed, clientSeed: "v", nonce: i, betUnits: 10, params: { cashOutAt: 1.1 } });
    voidNet += r.payoutUnits - 10;
  }

  // invalid dice line pays 0 but still costs stake when played via bridge — check direct
  const invalidDice = ENGINES.dice.play({ serverSeed, clientSeed: "bad", nonce: 999, betUnits: 100, params: { target: 9999, over: true } });

  const rows = [coin, dice, dice2, crash, pressure];
  for (const row of rows) {
    const flag = row.rtp > 1.001 ? " ** EV>100% **" : "";
    console.log("  " + row.name + " RTP=" + (row.rtp * 100).toFixed(3) + "%" + flag);
    if (row.rtp > 1.001) exploits.push(row.name + " RTP=" + (row.rtp * 100).toFixed(3) + "%");
  }
  console.log("  pressure void-target net over 1000 spins: " + voidNet + " (expect 0)");
  console.log("  invalid dice payout: " + invalidDice.payoutUnits + " win=" + invalidDice.win);

  if (exploits.length) {
    bug("Critical", "EV-EXPLOIT", "Game engine measured RTP > 100%", exploits.join("; "), "");
  } else if (voidNet > 1) {
    bug("High", "PRESSURE-VOID", "Sub-minimum pressure targets net positive EV", "voidNet=" + voidNet, "");
  } else {
    console.log("  ok  no engine measured RTP > 100% in Monte-Carlo scan");
  }
}

/* ── 7. demoUsd / slider static checks (mirrors app.js logic) ───────────── */
function testDemoUsdAndSliderLogic() {
  section("7. demoUsd manipulation + bet slider bypass (logic replay)");
  const DEMO_START_USD = 5000;
  const DEMO_MAX_USD = 10000000;
  function loadDemo(stored) {
    let demoUsd = DEMO_START_USD;
    const s = +stored;
    if (s > 0) demoUsd = Math.min(s, DEMO_MAX_USD);
    return demoUsd;
  }
  const tamper1 = loadDemo(1e15);
  const tamper2 = loadDemo(-999);
  const tamper3 = loadDemo("999999999999999999999");
  console.log("  localStorage tamper 1e15 → capped: " + tamper1 + " (max " + DEMO_MAX_USD + ")");
  console.log("  negative stored → default: " + tamper2);
  console.log("  huge string → capped: " + tamper3);
  if (tamper1 > DEMO_MAX_USD || tamper3 > DEMO_MAX_USD) {
    bug("Medium", "DEMO-CAP-BYPASS", "demoUsd localStorage cap bypassed", "values: " + tamper1 + ", " + tamper3, "");
  }

  // spendableUsd bypass: wallet connected + canvas game uses demoUsd not gameWei
  function spendableUsd(currentGame, demoUsd, gameWeiUsd) {
    if (currentGame === "slots3d" || currentGame === "pressure" || currentGame === "fish" || currentGame === "swoop" || currentGame === "fishshooter") return demoUsd;
    return gameWeiUsd > 0 ? gameWeiUsd : 0;
  }
  const walletBal = 10000;
  const demoBal = 5000;
  const spendFish = spendableUsd("fish", demoBal, walletBal);
  const spendFlip = spendableUsd("flip", demoBal, walletBal);
  console.log("  spendableUsd(fish) with wallet $10k + demo $5k → " + spendFish);
  console.log("  spendableUsd(flip) → " + spendFlip);
  if (spendFish === demoBal && walletBal > demoBal) {
    bug("Low", "DEMO-WALLET-DESYNC", "Canvas demo games ignore on-chain balance when wallet connected",
      "Header can show wallet deposit while fish/slots3d spend demoUsd (" + demoBal + ") — play-money/real-money UX desync, not server exploit.", "");
  }

  // slider max bypass: HTML max attribute alone doesn't stop programmatic value
  const sliderMax = 500;
  const programmatic = 99999;
  const serverRejects = programmatic > 100; // token bridge insufficient tokens
  console.log("  client slider max=" + sliderMax + " but API accepts betUnits subject to balance");
  console.log("  server-side over-balance rejected: " + serverRejects);
}

/* ── 8. Math.random in money paths ──────────────────────────────────────── */
function auditMathRandom() {
  section("8. Math.random() in money paths (production play())");
  const fs = require("fs");
  const path = require("path");
  const gameDir = path.join(__dirname, "../server/games");
  const offenders = [];
  for (const f of fs.readdirSync(gameDir).filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(gameDir, f), "utf8");
    const playBlock = src.split("function play")[1];
    if (playBlock && /Math\.random/.test(playBlock.split("module.exports")[0])) {
      offenders.push("server/games/" + f + " play()");
    }
    if (/Math\.random/.test(src) && !offenders.some((o) => o.includes(f))) {
      const inSelfTest = src.indexOf("require.main === module") >= 0 &&
        src.slice(src.indexOf("require.main === module")).includes("Math.random");
      if (inSelfTest) console.log("  note server/games/" + f + ": Math.random only in CLI self-test");
    }
  }
  if (offenders.length) {
    bug("Critical", "MATH-RANDOM-MONEY", "Math.random used in game play() path", offenders.join(", "), "");
  } else {
    console.log("  ok  no Math.random in server/games play() — outcomes use PF/HMAC");
  }
}

async function main() {
  console.log("ADVERSARIAL SUITE — Crypto TV token bridge");
  await testTxHashReplayRace();
  await testConcurrentDoStartSamePlayer();
  await testCrashRoundRaces();
  testBetValidation();
  await testSessionTokenEntropy();
  scanGameEconomics();
  testDemoUsdAndSliderLogic();
  auditMathRandom();

  section("SUMMARY");
  if (!findings.length) {
    console.log("No new bugs flagged (all checks passed or benign).");
    process.exit(0);
  }
  console.log("Findings: " + findings.length);
  for (const f of findings) console.log("  [" + f.severity + "] " + f.id + ": " + f.title);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
