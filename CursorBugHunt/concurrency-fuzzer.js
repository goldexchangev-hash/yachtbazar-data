#!/usr/bin/env node
"use strict";
/**
 * Concurrency fuzzer — token bridge + crash rounds under parallel load.
 * Run: node CursorBugHunt/concurrency-fuzzer.js
 */
const crypto = require("crypto");
const { ethers } = require("ethers");
const { makeTokenBridge } = require("../server/token-bridge.js");
const { makeTokenService, tokenAuthMessage } = require("../server/token-http.js");
const { makeCrashRounds } = require("../server/crash-rounds.js");
const { makeCrashWs } = require("../server/crash-rounds-ws.js");
const crashEngine = require("../server/games/crash.js");

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

function makeClock() {
  let clock = 0;
  const timers = [];
  const now = () => clock;
  const setTimer = (ms, fn) => { const t = { at: clock + ms, fn, dead: false }; timers.push(t); return t; };
  const clearTimer = (t) => { if (t) t.dead = true; };
  const advance = (ms) => {
    clock += ms;
    for (const t of timers.slice()) {
      if (!t.dead && t.at <= clock) {
        t.dead = true;
        try { t.fn(); } catch (e) { /* timer settlement may throw on closed/insufficient */ }
      }
    }
  };
  return { now, setTimer, clearTimer, advance, clock: () => clock };
}

function makeSigners() {
  const house = ethers.Wallet.createRandom();
  const settlementHash = (p, net, nonce, cid, c) =>
    ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
  const signer = {
    sign: async (p, net, nonce, cid, c) => {
      await new Promise((r) => setTimeout(r, 15));
      return house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c)));
    },
  };
  return { house, signer };
}

async function mkSession(svc, wallet, opts) {
  opts = opts || {};
  const player = wallet.address;
  const contract = opts.contract || "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = opts.chainId || 11155111;
  const lockedWei = opts.lockedWei || (25n * 10n ** 16n);
  const txHash = opts.txHash || ("0x" + crypto.randomBytes(32).toString("hex"));
  const body = {
    player, contract, chainId, txHash, buyInWei: lockedWei.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei: lockedWei.toString() })),
  };
  const started = await svc.doStart(body);
  return { player, contract, chainId, lockedWei, started, sessionId: started.sessionId, sessionToken: started.sessionToken };
}

function ledgerInvariant(bridge, sid, ctx) {
  const s = bridge.session(sid);
  if (!s) return { ok: false, reason: "no session", ctx };
  const issues = [];
  if (s.tokens < -1e-9) issues.push("negative tokens: " + s.tokens);
  if (s.betNonce !== s.bets.length) issues.push("betNonce " + s.betNonce + " != bets.length " + s.bets.length);
  const nonces = s.bets.map((b) => b.nonce);
  const dup = nonces.filter((n, i) => nonces.indexOf(n) !== i);
  if (dup.length) issues.push("duplicate nonces: " + dup.join(","));
  for (let i = 0; i < s.bets.length; i++) {
    if (s.bets[i].nonce !== i) issues.push("nonce gap at index " + i + " got " + s.bets[i].nonce);
  }
  let ledger = s.buyInUnits;
  for (const b of s.bets) ledger = Math.round((ledger - b.betUnits + (b.payoutUnits || 0)) * 100) / 100;
  if (Math.abs(ledger - s.tokens) > 0.02) issues.push("ledger drift: computed " + ledger + " vs tokens " + s.tokens);
  return { ok: !issues.length, issues, session: s, ctx };
}

function playBody(sess, game, betUnits, extra) {
  return Object.assign({
    sessionId: sess.sessionId,
    sessionToken: sess.sessionToken,
    game,
    betUnits,
    clientSeed: crypto.randomBytes(8).toString("hex"),
  }, extra || {});
}

/* ── 1. Same session: parallel doPlay (fish, coinflip, dice) during crash round ─ */
async function testParallelPlayDuringCrashRound() {
  section("1. parallel doPlay (fish/coinflip/dice) while crash round active");
  const { signer } = makeSigners();
  const wallet = ethers.Wallet.createRandom();
  const svc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), playBurst: 200, playRatePerSec: 100 });
  const sess = await mkSession(svc, wallet);
  const bridge = svc._bridge;
  const sid = sess.sessionId;
  const clk = makeClock();
  const cr = makeCrashRounds({ bridge, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });

  const ITER = 12;
  let desyncHits = 0;
  let negativeTokens = 0;
  let ledgerDrift = 0;
  let playDuringCrashOk = 0;

  for (let iter = 0; iter < ITER; iter++) {
    const seed = "fuzz-cr-" + iter + "-" + crypto.randomBytes(4).toString("hex");
    const tok0 = bridge.session(sid).tokens;
    if (tok0 < 30) break;
    const bet = Math.min(10, Math.floor(tok0 / 4));
    let round = null;
    try {
      const peek = bridge.pointPeek({ sessionId: sid, clientSeed: seed, game: "plane" });
      round = cr.startRound({ sessionId: sid, betUnits: bet, clientSeed: seed, gameKey: "plane" });
      const peekNonce = peek.nonce;
      const peekPoint = peek.point;

      const burst = [];
      for (let i = 0; i < 24; i++) {
        burst.push(new Promise((resolve) => {
          setImmediate(() => {
            const g = i % 3 === 0 ? "fishshooter" : i % 3 === 1 ? "coinflip" : "dice";
            const params = g === "fishshooter"
              ? { targetKey: "clown", power: 1 }
              : g === "coinflip"
                ? { side: i & 1 }
                : { target: 5000, over: false };
            const units = g === "fishshooter" ? 1 : 1;
            try {
              const r = svc.doPlay(playBody(sess, g, units, { params }));
              resolve({ ok: true, game: g, tokens: r.tokens, nonce: r.nonce });
            } catch (e) {
              resolve({ ok: false, game: g, err: e.message });
            }
          });
        }));
      }
      const results = await Promise.all(burst);
      playDuringCrashOk += results.filter((r) => r.ok).length;

      try { cr.cashOut({ roundId: round.roundId }); } catch (e) {
        clk.advance(999999);
      }

      const s = bridge.session(sid);
      const planeBet = s.bets.filter((b) => b.game === "plane").pop();
      if (planeBet && (planeBet.nonce !== peekNonce || (planeBet.outcome && planeBet.outcome.crashPoint != null && Math.abs(planeBet.outcome.crashPoint - peekPoint) > 0.02))) {
        desyncHits++;
      }
      const inv = ledgerInvariant(bridge, sid, "iter=" + iter);
      if (!inv.ok) {
        if (inv.issues.some((x) => x.includes("negative"))) negativeTokens++;
        if (inv.issues.some((x) => x.includes("drift") || x.includes("nonce"))) ledgerDrift++;
      }
    } catch (e) {
      if (round) try { clk.advance(999999); } catch (e2) {}
    }
  }

  const sFinal = bridge.session(sid);
  const ev = [
    "iterations: " + ITER,
    "interleaved plays succeeded during live crash: " + playDuringCrashOk,
    "nonce/point desync hits: " + desyncHits,
    "negative token invariant breaks: " + negativeTokens,
    "ledger/nonce invariant breaks: " + ledgerDrift,
    "final tokens: " + (sFinal ? sFinal.tokens : "N/A") + " betNonce: " + (sFinal ? sFinal.betNonce : "N/A"),
  ].join("\n");
  console.log(ev);

  if (desyncHits > 0) {
    bug("Critical", "CONC-CRASH-NONCE", "Interleaved doPlay during live crash round desyncs nonce/point",
      "pointPeek at round start disagrees with plane bet settlement after concurrent instant-game plays.", ev);
  }
  if (negativeTokens > 0 || ledgerDrift > 0) {
    bug("Critical", "CONC-CRASH-LEDGER", "Ledger invariant broken after crash+instant-game concurrency",
      "Token balance or nonce sequence corrupted under parallel doPlay during active crash round.", ev);
  }
  if (playDuringCrashOk > 0) {
    bug("High", "CONC-CRASH-INTERLEAVE", "Instant doPlay accepted while WS crash round is live",
      "HTTP instant bets interleave with server-paced crash round and advance betNonce (stake not reserved at cr:start).", ev);
  }
}

/* ── 2. doSettle + doPlay concurrent ─────────────────────────────────────── */
async function testSettlePlayConcurrent() {
  section("2. doSettle + doPlay concurrent");
  const { signer } = makeSigners();
  const wallet = ethers.Wallet.createRandom();
  const svc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), playBurst: 100, playRatePerSec: 50 });
  const sess = await mkSession(svc, wallet);
  const bridge = svc._bridge;
  const sid = sess.sessionId;
  const { player, contract, chainId } = sess;

  const settleSig = await wallet.signMessage(tokenAuthMessage("settle", { player, contract, chainId, sessionId: sid }));
  const ROUNDS = 8;
  let playAfterClose = 0;
  let settleWithExtraPlays = 0;
  let lossEscape = 0;

  for (let r = 0; r < ROUNDS; r++) {
    const tokBefore = bridge.session(sid).tokens;
    const plays = [];
    for (let i = 0; i < 30; i++) {
      plays.push(new Promise((resolve) => {
        setTimeout(() => {
          try {
            const out = svc.doPlay(playBody(sess, "coinflip", 1, { params: { side: 0 } }));
            resolve({ ok: true, tokens: out.tokens });
          } catch (e) {
            resolve({ ok: false, err: e.message });
          }
        }, i * 2);
      }));
    }
    const settleP = svc.doSettle({ player, sessionId: sid, signature: settleSig }).catch((e) => ({ err: e.message }));
    const all = await Promise.all([settleP, ...plays]);
    const settleRes = all[0];
    const playRes = all.slice(1);
    const succeeded = playRes.filter((p) => p.ok);
    if (succeeded.length) playAfterClose++;
    const s = bridge.session(sid);
    if (s && !s.closed && succeeded.length) settleWithExtraPlays++;
    if (settleRes && settleRes.serverSeedReveal && succeeded.length) {
      const extra = succeeded.reduce((acc, p) => acc, 0);
      if (extra) lossEscape++;
    }
    if (r < ROUNDS - 1) {
      // need fresh session for next round — only first settle closes
      break;
    }
  }

  const s = bridge.session(sid);
  const crashActive = false;
  const ev = [
    "rounds: " + ROUNDS,
    "doPlay succeeded after/beside settle: " + playAfterClose + " rounds with ≥1 success",
    "session closed: " + (s && s.closed),
    "final tokens: " + (s ? s.tokens : "gone"),
    "bets recorded: " + (s ? s.bets.length : 0),
  ].join("\n");
  console.log(ev);

  if (playAfterClose > 0) {
    const succeededDuringSettle = true;
    bug("Critical", "CONC-SETTLE-PLAY", "doPlay succeeded concurrently with doSettle",
      "Plays landed while session was closing/settling — ledger may diverge from signed net.", ev);
  }

  // Crash round + settle race (known class)
  const wallet2 = ethers.Wallet.createRandom();
  const svc2 = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), hasLiveExternal: () => false });
  const sess2 = await mkSession(svc2, wallet2);
  const sid2 = sess2.sessionId;
  const clk = makeClock();
  const cr2 = makeCrashRounds({ bridge: svc2._bridge, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  cr2.startRound({ sessionId: sid2, betUnits: 50, clientSeed: "settle-race-fuzz", gameKey: "plane" });
  const sig2 = await wallet2.signMessage(tokenAuthMessage("settle", { player: wallet2.address, contract: sess2.contract, chainId: sess2.chainId, sessionId: sid2 }));
  await svc2.doSettle({ player: wallet2.address, sessionId: sid2, signature: sig2 }).catch(() => {});
  try { clk.advance(999999); } catch (e) {}
  const s2 = svc2._bridge.session(sid2);
  const planeBet = s2 && s2.bets.some((b) => b.game === "plane");
  const ev2 = "closed=" + (s2 && s2.closed) + " planeBetRecorded=" + planeBet + " tokens=" + (s2 ? s2.tokens : "N/A");
  console.log("  crash+settle: " + ev2);
  if (s2 && s2.closed && !planeBet) {
    bug("Critical", "CONC-SETTLE-CRASH", "Session settled during live crash round — loss escaped",
      "doSettle closed session while crash round active; bust could not debit stake.", ev2);
  }
}

/* ── 3. doTopUp + doPlay concurrent ────────────────────────────────────────── */
async function testTopUpPlayConcurrent() {
  section("3. doTopUp + doPlay concurrent");
  const { signer } = makeSigners();
  const wallet = ethers.Wallet.createRandom();
  let verifyCalls = 0;
  const slowVerify = async (o) => {
    verifyCalls++;
    await new Promise((r) => setTimeout(r, 60));
    return { lockedWei: o.buyInWei };
  };
  const svc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: slowVerify, playBurst: 100, playRatePerSec: 50 });
  const sess = await mkSession(svc, wallet);
  const bridge = svc._bridge;
  const { player, contract, chainId, sessionId, sessionToken } = sess;
  const lockedWei = 25n * 10n ** 16n;
  const tokStart = bridge.session(sessionId).tokens;

  const topTx = "0x" + "cafe".repeat(16);
  const topBody = {
    player, sessionId, sessionToken, txHash: topTx, buyInWei: lockedWei.toString(),
    signature: await wallet.signMessage(tokenAuthMessage("topup", { player, contract, chainId, sessionId, buyInWei: lockedWei.toString() })),
  };

  verifyCalls = 0;
  const topTasks = [
    svc.doTopUp({ ...topBody }).catch((e) => ({ err: e.message })),
    svc.doTopUp({ ...topBody }).catch((e) => ({ err: e.message })),
  ];
  const playTasks = [];
  for (let i = 0; i < 20; i++) {
    playTasks.push(new Promise((resolve) => {
      setImmediate(() => {
        try {
          const r = svc.doPlay(playBody(sess, "dice", 1, { params: { target: 5000, over: false } }));
          resolve({ ok: true, tokens: r.tokens });
        } catch (e) {
          resolve({ ok: false, err: e.message });
        }
      });
    }));
  }
  const results = await Promise.all([...topTasks, ...playTasks]);
  const topOk = results.slice(0, 2).filter((r) => r && r.ok).length;
  const tokAfter = bridge.session(sessionId).tokens;
  const buyInAfter = bridge.session(sessionId).buyInUnits;
  const inv = ledgerInvariant(bridge, sessionId, "topup+play");

  const ev = [
    "verifyBuyIn calls: " + verifyCalls,
    "top-up ok count: " + topOk,
    "tokens: " + tokStart + " → " + tokAfter + " (buyInUnits " + buyInAfter + ")",
    "plays during top-up: " + playTasks.length,
    "invariant: " + (inv.ok ? "ok" : inv.issues.join("; ")),
  ].join("\n");
  console.log(ev);

  if (topOk > 1 || buyInAfter > tokStart + 1000 + 1) {
    bug("Critical", "CONC-TOPUP-REPLAY", "Concurrent doTopUp double-credits from one txHash",
      "TOCTOU on usedBuyIns during slow verifyBuyIn.", ev);
  }
  if (!inv.ok) {
    bug("Critical", "CONC-TOPUP-LEDGER", "Ledger corrupted during concurrent top-up + play",
      inv.issues.join("; "), ev);
  }
}

/* ── 4. applyBlackjackNet + doPlay concurrent ──────────────────────────────── */
async function testBjNetPlayConcurrent() {
  section("4. applyBlackjackNet + doPlay concurrent (token-http internals)");
  const { signer } = makeSigners();
  const wallet = ethers.Wallet.createRandom();
  let liveHand = true;
  const svc = makeTokenService({
    signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }),
    hasLiveExternal: () => liveHand, playBurst: 100, playRatePerSec: 50,
  });
  const sess = await mkSession(svc, wallet);
  const bridge = svc._bridge;
  const { player, sessionId } = sess;
  const tok0 = bridge.session(sessionId).tokens;

  const tasks = [];
  for (let i = 0; i < 15; i++) {
    tasks.push(new Promise((resolve) => {
      setTimeout(() => {
        try {
          const t = svc.applyBlackjackNet(player, sessionId, 10, i % 3 === 0 ? 20 : 0, "hand:" + i);
          resolve({ kind: "bj", ok: true, tokens: t });
        } catch (e) {
          resolve({ kind: "bj", ok: false, err: e.message });
        }
      }, i * 3);
    }));
  }
  for (let i = 0; i < 25; i++) {
    tasks.push(new Promise((resolve) => {
      setTimeout(() => {
        try {
          const r = svc.doPlay(playBody(sess, "coinflip", 1, { params: { side: i & 1 } }));
          resolve({ kind: "play", ok: true, tokens: r.tokens });
        } catch (e) {
          resolve({ kind: "play", ok: false, err: e.message });
        }
      }, i * 2);
    }));
  }

  const results = await Promise.all(tasks);
  const bjOk = results.filter((r) => r.kind === "bj" && r.ok).length;
  const playOk = results.filter((r) => r.kind === "play" && r.ok).length;
  const inv = ledgerInvariant(bridge, sessionId, "bj+play");
  const s = bridge.session(sessionId);

  const ev = [
    "simulate live BJ hand: hasLiveExternal=true (settle would block)",
    "applyBlackjackNet ok: " + bjOk + "/15",
    "doPlay ok during live hand: " + playOk + "/25",
    "tokens: " + tok0 + " → " + s.tokens,
    "betNonce: " + s.betNonce + " bets: " + s.bets.length,
    "invariant: " + (inv.ok ? "ok" : inv.issues.join("; ")),
  ].join("\n");
  console.log(ev);

  if (playOk > 0) {
    bug("Critical", "CONC-BJ-PLAY", "doPlay accepted during live blackjack hand",
      "Token bridge allows instant games while applyBlackjackNet marks active external hand.", ev);
  }
  if (!inv.ok) {
    bug("Critical", "CONC-BJ-LEDGER", "Ledger corrupted under concurrent BJ net + doPlay",
      inv.issues.join("; "), ev);
  }

  let settleBlocked = 0;
  try {
    await svc.doSettle({
      player, sessionId,
      signature: await wallet.signMessage(tokenAuthMessage("settle", { player, contract: sess.contract, chainId: sess.chainId, sessionId })),
    });
  } catch (e) {
    if (/finish your blackjack hand/.test(e.message)) settleBlocked = 1;
  }
  if (!settleBlocked) {
    bug("High", "CONC-BJ-SETTLE", "doSettle did not block while hasLiveExternal true",
      "Expected cash-out to refuse during simulated live blackjack hand.", "settleBlocked=" + settleBlocked);
  }
  liveHand = false;
}

/* ── 5. Rapid cr:start attempts ────────────────────────────────────────────── */
async function testRapidCrStart() {
  section("5. rapid cr:start attempts");
  const bridge = makeTokenBridge({});
  const st = bridge.start({ player: "0xf00d", buyInUnits: 500, chainId: 1, contract: "0x1" });
  const sid = st.sessionId;
  const token = "tok-" + crypto.randomBytes(8).toString("hex");
  const clk = makeClock();
  const mkWs = () => ({ readyState: 1, sent: [], send(obj) { this.sent.push(typeof obj === "string" ? JSON.parse(obj) : obj); }, last() { return this.sent[this.sent.length - 1]; } });
  const verifySession = (s, t) => (s === sid && t === token) ? bridge.session(sid) : null;
  const cr = makeCrashWs({ bridge, verifySession, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });

  const ws = mkWs();
  const ATTEMPTS = 40;
  const starts = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    starts.push(new Promise((resolve) => {
      setImmediate(() => {
        cr.handle(ws, { type: "cr:start", sessionId: sid, sessionToken: token, betUnits: 5, clientSeed: "rapid-" + i, gameKey: "plane" });
        resolve(ws.sent[ws.sent.length - 1]);
      });
    }));
  }
  const msgs = await Promise.all(starts);
  const started = msgs.filter((m) => m && m.type === "cr:started");
  const errors = msgs.filter((m) => m && m.type === "cr:error");
  let multiLive = 0;
  try {
    const roundsMap = cr._rounds._rounds;
    if (roundsMap && roundsMap instanceof Map) {
      const live = [...roundsMap.values()].filter((r) => r.sessionId === sid && !r.settled);
      if (live.length > 1) multiLive = live.length;
    }
  } catch (e) {}

  const tokBefore = bridge.session(sid).tokens;
  clk.advance(999999);
  const tokAfter = bridge.session(sid).tokens;

  const ev = [
    "attempts: " + ATTEMPTS,
    "cr:started count: " + started.length,
    "cr:error count: " + errors.length,
    "multi live rounds same session: " + multiLive,
    "tokens before bust: " + tokBefore + " after: " + tokAfter,
    "active round after burst: " + (cr._rounds.active(sid) ? "yes" : "no"),
  ].join("\n");
  console.log(ev);

  if (started.length > 1 || multiLive > 1) {
    bug("Critical", "CONC-CR-MULTI", "Multiple live crash rounds started for one session",
      "Rapid cr:start created overlapping rounds — double stake exposure.", ev);
  }
  if (started.length >= 1 && tokBefore === tokAfter && cr._rounds.active(sid)) {
    bug("High", "CONC-CR-NODEBIT", "Live crash round never debited after rapid start burst",
      "Round stuck live without ledger settlement.", ev);
  }
  if (started.length === 1 && errors.length === ATTEMPTS - 1) {
    console.log("  ok  exactly one cr:started; rest rejected");
  }

  // Over-balance start (no balance check at cr:start)
  bridge.session(sid).tokens = 3;
  const betsBefore = bridge.session(sid).bets.length;
  const ws2 = mkWs();
  cr.handle(ws2, { type: "cr:start", sessionId: sid, sessionToken: token, betUnits: 100, clientSeed: "oob" });
  const oob = ws2.last();
  clk.advance(999999);
  const tokOob = bridge.session(sid).tokens;
  const newPlaneBets = bridge.session(sid).bets.slice(betsBefore).filter((b) => b.game === "plane");
  const oobEv = "betUnits=100 balance=3 → " + (oob && oob.type) + " tokens after=" + tokOob + " newPlaneBets=" + newPlaneBets.length;
  console.log("  over-balance: " + oobEv);
  if (oob && oob.type === "cr:started" && newPlaneBets.length === 0 && tokOob >= 3) {
    bug("Critical", "CONC-CR-OOB", "cr:start over-balance bet; bust did not debit — loss escaped",
      "Stake not reserved at start; settlement failed without ledger entry.", oobEv);
  } else if (oob && oob.type === "cr:started" && newPlaneBets.length === 0) {
    bug("High", "CONC-CR-OOB", "cr:start over-balance round ended without new ledger bet",
      "Bust timer fired but plane bet missing from ledger.", oobEv);
  }
}

/* ── 6. Session resume during active play burst ────────────────────────────── */
async function testSessionResumeDuringPlayBurst() {
  section("6. session resume (doSession) during active play burst");
  const { signer } = makeSigners();
  const wallet = ethers.Wallet.createRandom();
  const store = { data: null, load() { return this.data; }, save(d) { this.data = JSON.parse(JSON.stringify(d)); } };
  const svc = makeTokenService({
    signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }),
    persist: store, playBurst: 200, playRatePerSec: 100,
  });
  const sess = await mkSession(svc, wallet);
  const bridge = svc._bridge;
  const { sessionId, sessionToken } = sess;

  const BURST = 60;
  const tasks = [];
  for (let i = 0; i < BURST; i++) {
    tasks.push(new Promise((resolve) => {
      setImmediate(() => {
        try {
          const r = svc.doPlay(playBody(sess, i % 2 ? "coinflip" : "dice", 1, {
            params: i % 2 ? { side: 0 } : { target: 5000, over: false },
          }));
          resolve({ kind: "play", ok: true, tokens: r.tokens });
        } catch (e) {
          resolve({ kind: "play", ok: false, err: e.message });
        }
      });
    }));
  }
  for (let i = 0; i < 15; i++) {
    tasks.push(new Promise((resolve) => {
      setImmediate(() => {
        const r = svc.doSession({ sessionId, sessionToken });
        resolve({ kind: "resume", ok: r.ok, tokens: r.tokens });
      });
    }));
  }
  // Simulate stale/wrong token resume attempts interleaved
  for (let i = 0; i < 5; i++) {
    tasks.push(new Promise((resolve) => {
      setImmediate(() => {
        const r = svc.doSession({ sessionId, sessionToken: crypto.randomBytes(12).toString("hex") });
        resolve({ kind: "bad-resume", ok: r.ok });
      });
    }));
  }

  const results = await Promise.all(tasks);
  const playOk = results.filter((r) => r.kind === "play" && r.ok);
  const resumes = results.filter((r) => r.kind === "resume" && r.ok);
  const badResumes = results.filter((r) => r.kind === "bad-resume" && r.ok);
  const s = bridge.session(sessionId);
  const inv = ledgerInvariant(bridge, sessionId, "resume-burst");

  const tokenMismatch = resumes.some((r) => r.tokens != null && Math.abs(r.tokens - s.tokens) > 0.01);
  const ev = [
    "plays ok: " + playOk.length + "/" + BURST,
    "doSession ok: " + resumes.length + "/15",
    "bad token resume ok (should be 0): " + badResumes.length,
    "resume token mismatch vs live: " + tokenMismatch,
    "live tokens: " + s.tokens,
    "invariant: " + (inv.ok ? "ok" : inv.issues.join("; ")),
  ].join("\n");
  console.log(ev);

  if (badResumes.length > 0) {
    bug("Critical", "CONC-RESUME-AUTH", "doSession accepted wrong bearer token during burst",
      "Session resume auth bypass under concurrency.", ev);
  }
  if (tokenMismatch) {
    bug("High", "CONC-RESUME-STALE", "doSession returned stale token balance during play burst",
      "Client could display wrong balance mid-burst.", ev);
  }
  if (!inv.ok) {
    bug("Critical", "CONC-RESUME-LEDGER", "Ledger corrupted during resume + play burst",
      inv.issues.join("; "), ev);
  }

  // Persist/rehydrate: bearer must survive for resume after "restart"
  const savedTok = sessionToken;
  const savedSid = sessionId;
  const liveTokens = s.tokens;
  const svc2 = makeTokenService({
    signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }),
    persist: store, playBurst: 200, playRatePerSec: 100,
  });
  const resumed = svc2.doSession({ sessionId: savedSid, sessionToken: savedTok });
  const reEv = "rehydrate ok=" + resumed.ok + " tokens=" + (resumed.tokens || "N/A") + " expected=" + liveTokens;
  console.log("  persist rehydrate: " + reEv);
  if (!resumed.ok || Math.abs((resumed.tokens || 0) - liveTokens) > 0.01) {
    bug("High", "CONC-RESUME-PERSIST", "Session resume failed after persist rehydrate",
      "Bearer or balance lost across simulated restart.", reEv);
  }
}

async function main() {
  console.log("CONCURRENCY FUZZER — Crypto TV token bridge + crash rounds");
  await testParallelPlayDuringCrashRound();
  await testSettlePlayConcurrent();
  await testTopUpPlayConcurrent();
  await testBjNetPlayConcurrent();
  await testRapidCrStart();
  await testSessionResumeDuringPlayBurst();

  section("SUMMARY");
  if (!findings.length) {
    console.log("No bugs flagged — all concurrency checks passed or benign.");
    process.exit(0);
  }
  console.log("Findings: " + findings.length);
  for (const f of findings) {
    console.log("  [" + f.severity + "] " + f.id + ": " + f.title);
  }
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
