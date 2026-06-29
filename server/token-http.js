/* ============================================================
   token-http.js — Express + on-chain wiring for the server-side token games.

   Exposes the token bridge (server/token-bridge.js) over HTTP, behind a flag, so
   the discrete games (coinflip/dice/dice2/crash/pressure/slots/slots3d) can take a
   real on-chain buy-in, be played provably-fairly off a committed seed, and cash
   out with a house-signed net the player claims on-chain. NO VRF.

   FLOW
     POST /api/token/start   { player, contract, chainId, txHash, buyInWei, signature }
        → verify the on-chain lock (a confirmed BlackjackBuyIn tx, bjLocked>=amount,
          txHash not reused) + the player's wallet signature → grant tokens, return
          { sessionId, sessionToken, commit, tokens }.
     POST /api/token/play    { sessionId, sessionToken, game, betUnits, params, clientSeed }
        → run the game's server engine over the committed seed → { outcome, tokens }.
     POST /api/token/settle  { sessionId, player, signature }
        → sign (player, netWei, nonce, chainId, contract), reveal the seed → the
          player submits settleBlackjack(...) to claim locked+net.

   HARDENING baked in (from the audit): net→wei pinned to the verified lockedWei
   (token-bridge core); txHash replay-dedupe; one open session per player; the
   serverSeed is NEVER returned before settle; play is gated by a per-session bearer
   token; settle requires the player's wallet signature.

   Shares the existing blackjackBuyIn / bjLocked / settleBlackjack contract slots, so
   for now a player may have only ONE open bridge session (blackjack OR token) at a
   time — the per-session-lock contract upgrade removes that limit.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { ethers } = require("ethers");
const { makeTokenBridge } = require("./token-bridge.js");

const BUYIN_ABI = [
  "event BlackjackBuyIn(address indexed player,uint256 amount,uint256 locked)",
  "function bjLocked(address player) view returns (uint256)",
];
const WEI_PER_ETH = 10n ** 18n;

function address(v, label) { if (!ethers.isAddress(v)) throw new Error((label || "address") + " is invalid"); return ethers.getAddress(v); }
function positiveWei(v, label) { const o = BigInt(String(v || "0")); if (o <= 0n) throw new Error((label || "amount") + " must be positive"); return o; }
function weiToUsd(wei, ethUsd) { return Math.round((Number(wei) / Number(WEI_PER_ETH)) * ethUsd * 100) / 100; }

// The message the player signs to authorize an action (EIP-191 personal_sign).
function tokenAuthMessage(intent, o) {
  const lines = [
    "Crypto TV Token Bridge",
    "Action: " + String(intent || ""),
    "Player: " + address(o.player, "player"),
    "Contract: " + address(o.contract, "contract"),
    "Chain ID: " + Number(o.chainId),
  ];
  if (intent === "start") lines.push("Buy-in wei: " + String(o.buyInWei || "0"));
  else if (intent === "settle") lines.push("Session: " + String(o.sessionId || ""));
  return lines.join("\n");
}
function verifyWalletSignature(intent, body, o) {
  const sig = String((body && body.signature) || "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("wallet signature is required");
  const recovered = ethers.verifyMessage(tokenAuthMessage(intent, o), sig);
  if (String(recovered).toLowerCase() !== String(o.player).toLowerCase()) throw new Error("wallet signature does not match player");
}

// Real on-chain buy-in proof: a confirmed BlackjackBuyIn tx to the contract for this
// player+amount, still locked. Returns the locked wei. (Injectable for tests.)
function makeOnChainVerifier(rpcUrlFor, minConfirmations) {
  return async function verifyBuyIn(o) {
    const url = rpcUrlFor(o.chainId);
    if (!url) throw new Error("bridge RPC not configured");
    const provider = new ethers.JsonRpcProvider(url);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== o.chainId) throw new Error("bridge RPC is on the wrong chain");
    const receipt = await provider.getTransactionReceipt(o.txHash);
    if (!receipt || receipt.status !== 1) throw new Error("buy-in transaction is not confirmed");
    if (receipt.to && receipt.to.toLowerCase() !== o.contract.toLowerCase()) throw new Error("buy-in went to the wrong contract");
    if (minConfirmations > 1) { const conf = await receipt.confirmations(); if (conf < minConfirmations) throw new Error("buy-in needs more confirmations"); }
    const iface = new ethers.Interface(BUYIN_ABI);
    let eventLocked = null;
    for (const log of receipt.logs || []) {
      if (String(log.address).toLowerCase() !== o.contract.toLowerCase()) continue;
      let parsed = null; try { parsed = iface.parseLog(log); } catch {}
      if (!parsed || parsed.name !== "BlackjackBuyIn") continue;
      if (String(parsed.args.player).toLowerCase() !== o.player.toLowerCase()) continue;
      if (BigInt(parsed.args.amount.toString()) !== o.buyInWei) continue;
      eventLocked = BigInt(parsed.args.locked.toString());
      break;
    }
    if (eventLocked == null) throw new Error("buy-in event was not found in the transaction");
    const contract = new ethers.Contract(o.contract, BUYIN_ABI, provider);
    const currentLocked = BigInt((await contract.bjLocked(o.player)).toString());
    if (currentLocked < eventLocked) throw new Error("buy-in is no longer locked on-chain");
    return { lockedWei: o.buyInWei };
  };
}

/**
 * Build the token service (pure-ish orchestration — no Express). Testable directly.
 * opts: { signer:{sign}, verifyBuyIn(o)->{lockedWei}, ethUsd():number, persist, now():number }
 */
function makeTokenService(opts) {
  opts = opts || {};
  const ethUsdFn = typeof opts.ethUsd === "function" ? opts.ethUsd : () => Number(opts.ethUsd) || 3400;
  const verifyBuyIn = opts.verifyBuyIn || makeOnChainVerifier(opts.rpcUrlFor || (() => ""), opts.minConfirmations || 1);
  const usedBuyIns = new Set();
  const tokenForSession = new Map(); // sessionId -> bearer token
  const openByPlayer = new Map();    // player -> sessionId (one open session per player)

  const bridge = makeTokenBridge({ signer: opts.signer || null, persist: opts.persist || null });

  async function doStart(body) {
    const player = address(body && body.player, "player");
    if (openByPlayer.has(player)) throw new Error("finish your open token session before buying in again");
    const contract = address(body && body.contract, "contract");
    const chainId = Number(body && body.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
    const txHash = String((body && body.txHash) || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("buy-in transaction hash is invalid");
    const txKey = txHash.toLowerCase();
    if (usedBuyIns.has(txKey)) throw new Error("buy-in transaction was already used");
    const buyInWei = positiveWei(body && body.buyInWei, "buy-in");
    verifyWalletSignature("start", body, { player, contract, chainId, buyInWei: buyInWei.toString() });
    const proof = await verifyBuyIn({ txHash, player, contract, chainId, buyInWei });
    const lockedWei = BigInt(proof.lockedWei);
    const buyInUnits = weiToUsd(lockedWei, ethUsdFn());
    if (!(buyInUnits > 0)) throw new Error("buy-in USD value is invalid");

    const started = bridge.start({ player, chainId, contract, buyInUnits, lockedWei: lockedWei.toString(), now: (opts.now && opts.now()) || 0 });
    usedBuyIns.add(txKey);
    openByPlayer.set(player, started.sessionId);
    const sessionToken = crypto.randomBytes(24).toString("hex");
    tokenForSession.set(started.sessionId, sessionToken);
    return { ok: true, sessionId: started.sessionId, sessionToken, commit: started.commit, tokens: started.tokens, buyInUnits, games: started.games };
  }

  function doPlay(body) {
    const sessionId = String((body && body.sessionId) || "");
    const token = String((body && body.sessionToken) || "");
    if (!token || tokenForSession.get(sessionId) !== token) throw new Error("invalid session token");
    const r = bridge.play({ sessionId, game: body.game, betUnits: body.betUnits, params: body.params, clientSeed: body.clientSeed });
    return { ok: true, ...r }; // NOTE: never includes serverSeed — only the commit is exposed pre-settle
  }

  async function doSettle(body) {
    const player = address(body && body.player, "player");
    const s = bridge.session(body && body.sessionId);
    if (!s) throw new Error("no such session");
    if (s.player.toLowerCase() !== player.toLowerCase()) throw new Error("session does not belong to player");
    verifyWalletSignature("settle", body, { player, contract: s.contract, chainId: s.chainId, sessionId: s.id });
    const settlement = await bridge.settle({ sessionId: s.id });
    openByPlayer.delete(player);
    tokenForSession.delete(s.id);
    return settlement; // includes netWei, signature, serverSeedReveal (now safe), commit
  }

  function status() { return { ok: true, enabled: true, games: bridge.games(), model: "server commit-reveal token bridge (no VRF)" }; }

  return { doStart, doPlay, doSettle, status, _bridge: bridge };
}

// Wire the service onto an Express app, behind a flag. Live demo is untouched.
function attachTokenBridge(app, opts) {
  opts = opts || {};
  const enabled = () => !!(opts.enabled && opts.enabled());
  const svc = makeTokenService(opts);
  const guard = (res) => { if (!enabled()) { res.status(503).json({ ok: false, error: "token bridge is not enabled" }); return false; } return true; };
  const fail = (res, e) => res.status(400).json({ ok: false, error: (e && e.message) || "request failed" });

  app.get("/api/token/status", (req, res) => res.json(enabled() ? svc.status() : { ok: true, enabled: false }));
  app.post("/api/token/start", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doStart(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/play", (req, res) => { if (!guard(res)) return; try { res.json(svc.doPlay(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/settle", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doSettle(req.body || {})); } catch (e) { fail(res, e); } });
  return svc;
}

module.exports = { attachTokenBridge, makeTokenService, tokenAuthMessage, verifyWalletSignature, makeOnChainVerifier, weiToUsd };

/* ---------------- CLI self-test: node server/token-http.js ---------------- */
if (require.main === module) {
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };
  (async () => {
    const wallet = ethers.Wallet.createRandom();          // the PLAYER
    const house = ethers.Wallet.createRandom();           // the HOUSE signer
    const player = wallet.address;
    const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
    const chainId = 11155111;
    const lockedWei = (25n * 10n ** 16n); // 0.25 ETH
    const settlementHash = (p, net, nonce, cid, c) => ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, net, nonce, cid, c]);
    const signer = { sign: (p, net, nonce, cid, c) => house.signMessage(ethers.getBytes(settlementHash(p, BigInt(net), BigInt(nonce), cid, c))) };

    const svc = makeTokenService({
      signer,
      ethUsd: () => 4000,                                  // $4000/ETH → 0.25 ETH = $1000 tokens
      verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), // stub the chain
    });

    // auth helper
    const sign = (intent, o) => wallet.signMessage(tokenAuthMessage(intent, o));

    // bad signature is rejected
    let threw = 0;
    try { await svc.doStart({ player, contract, chainId, txHash: "0x" + "a".repeat(64), buyInWei: lockedWei.toString(), signature: "0x" + "0".repeat(130) }); } catch (e) { threw++; }
    eq("start rejects a bad wallet signature", threw === 1);

    // good start
    const startBody = { player, contract, chainId, txHash: "0x" + "b".repeat(64), buyInWei: lockedWei.toString() };
    startBody.signature = await sign("start", { player, contract, chainId, buyInWei: lockedWei.toString() });
    const started = await svc.doStart(startBody);
    eq("start grants tokens = $1000 from 0.25 ETH @ $4000", started.tokens === 1000);
    eq("start returns a commit but NO serverSeed", /^[0-9a-f]{64}$/.test(started.commit) && started.serverSeed === undefined);

    // reused txHash rejected
    let reused = 0; try { await svc.doStart(startBody); } catch (e) { reused++; }
    eq("reused buy-in txHash rejected", reused === 1);

    // play requires the session token
    let badtok = 0; try { svc.doPlay({ sessionId: started.sessionId, sessionToken: "nope", game: "coinflip", betUnits: 1 }); } catch (e) { badtok++; }
    eq("play rejects a wrong session token", badtok === 1);

    // play a run; tokens move; serverSeed never leaks
    let leaked = false;
    for (let i = 0; i < 50; i++) { const r = svc.doPlay({ sessionId: started.sessionId, sessionToken: started.sessionToken, game: "coinflip", betUnits: 10, params: { side: i % 2 }, clientSeed: "c" + i }); if (r.serverSeed) leaked = true; }
    eq("play never leaks the serverSeed", !leaked);

    // settle: wallet sig required, net pinned to lockedWei, signature recovers to house
    const settleSig = await sign("settle", { player, contract, chainId, sessionId: started.sessionId });
    const stl = await svc.doSettle({ player, sessionId: started.sessionId, signature: settleSig });
    const netWei = BigInt(stl.netWei);
    eq("settle net never below -lockedWei", netWei >= -lockedWei);
    eq("settle netWei pinned to lockedWei ratio", netWei === (lockedWei * BigInt(Math.round(stl.netUnits * 100))) / BigInt(Math.round(1000 * 100)));
    const rec = ethers.verifyMessage(ethers.getBytes(settlementHash(player, netWei, BigInt(stl.nonce), chainId, contract)), stl.signature);
    eq("settlement signature recovers to the house signer", rec === house.address);
    eq("settle reveals the serverSeed (now safe)", !!stl.serverSeedReveal);

    // one-session-per-player frees after settle
    let again = 0; try { startBody.txHash = "0x" + "c".repeat(64); startBody.signature = await sign("start", { player, contract, chainId, buyInWei: lockedWei.toString() }); await svc.doStart(startBody); } catch (e) { again++; }
    eq("can open a new session after settling", again === 0);

    console.log(ok ? "\nSELF-TEST OK — token HTTP service: verified buy-in → token-gated play → wallet-authed signed settle." : "\nSELF-TEST FAILED");
    process.exit(ok ? 0 : 1);
  })().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
}
