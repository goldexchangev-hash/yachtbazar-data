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
  else if (intent === "topup") { lines.push("Session: " + String(o.sessionId || "")); lines.push("Buy-in wei: " + String(o.buyInWei || "0")); }
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
    // Bound every RPC call: without a timeout a slow/hung node lets an attacker flood
    // /api/token/start with valid-looking txHashes and pin server requests open indefinitely.
    const fr = new ethers.FetchRequest(url); fr.timeout = 12000;
    const provider = new ethers.JsonRpcProvider(fr, undefined, { staticNetwork: true });
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
    // eventLocked = the player's TOTAL on-chain bjLocked right after this buy-in. Returned so the
    // caller can detect a SECOND concurrent session (cross-session-drain guard).
    return { lockedWei: o.buyInWei, eventLocked: eventLocked.toString() };
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

  // ── durable replay guard + open-session map ──────────────────────────────
  // A restart MUST preserve usedBuyIns (so a confirmed buy-in tx can never re-fund a
  // second session) AND openByPlayer (so the one-open-session rule survives). Both ride
  // the SAME injected persist store as the bridge, under a namespace so they don't clobber
  // the bridge's { sessions } blob. We split one physical store into two logical views.
  const rawPersist = opts.persist || null;
  let _blob = null; // cached merged blob: { http:{usedBuyIns,openByPlayer}, bridge:{sessions} }
  function _read() {
    if (_blob) return _blob;
    let st = null;
    if (rawPersist && rawPersist.load) { try { st = rawPersist.load(); } catch (e) {} }
    _blob = (st && typeof st === "object") ? st : {};
    return _blob;
  }
  function _write() { if (rawPersist && rawPersist.save) { try { rawPersist.save(_read()); } catch (e) {} } }
  // Namespaced sub-store handed to a consumer: load()/save() see only their slice.
  function nsPersist(key) {
    if (!rawPersist) return null;
    return {
      load() { return _read()[key] || null; },
      save(slice) { _read()[key] = slice; _write(); },
    };
  }

  // Rehydrate the HTTP-layer guard state from the durable store.
  const httpPersist = nsPersist("http");
  const usedBuyIns = new Set();
  const tokenForSession = new Map(); // sessionId -> bearer token
  const openByPlayer = new Map();    // player -> sessionId (one open session per player)
  if (httpPersist) {
    try {
      const st = httpPersist.load() || {};
      for (const tx of st.usedBuyIns || []) usedBuyIns.add(String(tx));
      for (const [p, sid] of st.openByPlayer || []) openByPlayer.set(String(p), String(sid));
      // CRITICAL (the "frozen balance" bug): the per-session bearer MUST survive a process
      // restart/redeploy. The bridge sessions are persisted, but if the bearer is lost every
      // /play 400s "invalid session token" while the session still looks open client-side —
      // the balance freezes silently. Rehydrate the bearers alongside the open sessions.
      for (const [sid, tok] of st.tokenForSession || []) tokenForSession.set(String(sid), String(tok));
    } catch (e) {}
  }
  function saveHttp() {
    if (!httpPersist) return;
    try {
      httpPersist.save({
        usedBuyIns: Array.from(usedBuyIns),
        openByPlayer: Array.from(openByPlayer.entries()),
        tokenForSession: Array.from(tokenForSession.entries()),
      });
    } catch (e) {}
  }

  const bridge = makeTokenBridge({ signer: opts.signer || null, persist: nsPersist("bridge") });

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
    // Don't grant tokens at a guessed price: if the live ETH/USD hasn't synced yet (cold start),
    // the wei→token valuation would use the stale fallback and inflate the grant (~2x). Make the
    // player retry a moment later instead of crediting the wrong amount.
    if (opts.ethUsdReady && !opts.ethUsdReady()) throw new Error("price is still syncing — try the buy-in again in a few seconds");
    verifyWalletSignature("start", body, { player, contract, chainId, buyInWei: buyInWei.toString() });
    const proof = await verifyBuyIn({ txHash, player, contract, chainId, buyInWei });
    const lockedWei = BigInt(proof.lockedWei);
    // CROSS-SESSION-DRAIN GUARD: the contract's bjLocked is ONE per-player accumulator shared with
    // the on-chain blackjack bridge. If anything was already locked BEFORE this buy-in, the player
    // has another open session (blackjack, or a stranded one) — opening a 2nd would let a single
    // settlement claim the COMBINED lock. A token session always starts clean (openByPlayer already
    // guarantees no other token session), so require a FRESH lock here. (Top-up: see doTopUp.)
    if (proof.eventLocked != null && (BigInt(proof.eventLocked) - lockedWei) > 0n)
      throw new Error("you have funds locked in another session — cash out / finish it before buying in");
    const buyInUnits = weiToUsd(lockedWei, ethUsdFn());
    if (!(buyInUnits > 0)) throw new Error("buy-in USD value is invalid");

    const started = bridge.start({ player, chainId, contract, buyInUnits, lockedWei: lockedWei.toString(), now: (opts.now && opts.now()) || 0 });
    usedBuyIns.add(txKey);
    openByPlayer.set(player, started.sessionId);
    const sessionToken = crypto.randomBytes(24).toString("hex");
    tokenForSession.set(started.sessionId, sessionToken);
    saveHttp(); // durably record the spent txHash + open session + bearer BEFORE handing it back
    return { ok: true, sessionId: started.sessionId, sessionToken, commit: started.commit, tokens: started.tokens, buyInUnits, games: started.games };
  }

  function doPlay(body) {
    const sessionId = String((body && body.sessionId) || "");
    const token = String((body && body.sessionToken) || "");
    if (!token || tokenForSession.get(sessionId) !== token) throw new Error("invalid session token");
    const r = bridge.play({ sessionId, game: body.game, betUnits: body.betUnits, params: body.params, clientSeed: body.clientSeed });
    return { ok: true, ...r }; // NOTE: never includes serverSeed — only the commit is exposed pre-settle
  }

  // TOP UP an OPEN session without cashing out: the player locked MORE on-chain (a second
  // blackjackBuyIn, which ACCUMULATES bjLocked) → verify that new lock tx + add its value to the
  // session's principal + tokens. Reuses the SAME on-chain verifier + replay guard as start.
  async function doTopUp(body) {
    const sessionId = String((body && body.sessionId) || "");
    const token = String((body && body.sessionToken) || "");
    if (!token || tokenForSession.get(sessionId) !== token) throw new Error("invalid session token");
    const s = bridge.session(sessionId);
    if (!s || s.closed) throw new Error("no open session to top up");
    const player = address(body && body.player, "player");
    if (s.player.toLowerCase() !== player.toLowerCase()) throw new Error("session does not belong to player");
    const contract = address(s.contract, "contract");
    const chainId = Number(s.chainId);
    const txHash = String((body && body.txHash) || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("top-up transaction hash is invalid");
    const txKey = txHash.toLowerCase();
    if (usedBuyIns.has(txKey)) throw new Error("top-up transaction was already used");
    const addWei = positiveWei(body && body.buyInWei, "top-up");
    if (opts.ethUsdReady && !opts.ethUsdReady()) throw new Error("price is still syncing — try the top-up again in a few seconds");
    verifyWalletSignature("topup", body, { player, contract, chainId, sessionId, buyInWei: addWei.toString() });
    const proof = await verifyBuyIn({ txHash, player, contract, chainId, buyInWei: addWei });
    const addLockedWei = BigInt(proof.lockedWei);
    // CROSS-SESSION-DRAIN GUARD: the prior on-chain lock must be EXACTLY this session's current
    // lock — anything more means a second (blackjack) session is mixed into bjLocked.
    if (proof.eventLocked != null && s.lockedWei != null && (BigInt(proof.eventLocked) - addLockedWei) > BigInt(s.lockedWei))
      throw new Error("an unexpected on-chain lock was found — top-up blocked for safety");
    const addUnits = weiToUsd(addLockedWei, ethUsdFn());
    if (!(addUnits > 0)) throw new Error("top-up USD value is invalid");
    const r = bridge.topUp({ sessionId, addUnits, addLockedWei: addLockedWei.toString() });
    usedBuyIns.add(txKey);
    saveHttp(); // durably record the spent top-up txHash
    return { ok: true, ...r };
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
    saveHttp(); // the session is no longer open — persist the freed slot + dropped bearer (txHash stays spent)
    return settlement; // includes netWei, signature, serverSeedReveal (now safe), commit
  }

  function status() { return { ok: true, enabled: true, signerAddress: (opts.signerAddress ? opts.signerAddress() : null), ethUsd: (opts.ethUsd ? opts.ethUsd() : null), games: bridge.games(), model: "server commit-reveal token bridge (no VRF)" }; }

  // Owner-facing AGGREGATE of every OPEN token session — so the house can see its live
  // exposure at a glance (locked principal it can't withdraw yet + unrealized P&L that
  // only hits the on-chain bankroll at cash-out). Aggregate-only: NO player addresses, so
  // it's safe to expose. unrealized = Σ(buyIn − tokens): positive = players are down (house
  // ahead, pending settle); negative = players are up (house behind, pending settle).
  function houseState() {
    let lockedWei = 0n, buyInUnits = 0, tokens = 0, open = 0;
    try {
      for (const s of bridge._sessions.values()) {
        if (!s || s.closed) continue;
        open++;
        buyInUnits += Number(s.buyInUnits) || 0;
        tokens += Number(s.tokens) || 0;
        if (s.lockedWei != null) { try { lockedWei += BigInt(s.lockedWei); } catch (e) {} }
      }
    } catch (e) {}
    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      ok: true, openSessions: open, lockedWei: lockedWei.toString(),
      buyInUnits: r2(buyInUnits), currentTokens: r2(tokens),
      houseUnrealizedUnits: r2(buyInUnits - tokens),
      ethUsd: (opts.ethUsd ? opts.ethUsd() : null),
    };
  }

  // Validate a (sessionId, bearer-token) pair WITHOUT mutating anything — the ws crash
  // round-runner uses this to authorize cr:start over the socket, reusing the exact same
  // per-session bearer the HTTP /play path checks (no second auth scheme). Returns the
  // live bridge session on match, else null. EDIT: this is the single auth gate for ws play.
  function verifySession(sessionId, token) {
    const sid = String(sessionId || "");
    if (!sid || tokenForSession.get(sid) !== String(token || "")) return null;
    return bridge.session(sid) || null;
  }

  return { doStart, doPlay, doTopUp, doSettle, status, houseState, verifySession, _bridge: bridge };
}

// Wire the service onto an Express app, behind a flag. Live demo is untouched.
function attachTokenBridge(app, opts) {
  opts = opts || {};
  const enabled = () => !!(opts.enabled && opts.enabled());
  const svc = makeTokenService(opts);
  const guard = (res) => { if (!enabled()) { res.status(503).json({ ok: false, error: "token bridge is not enabled" }); return false; } return true; };
  const fail = (res, e) => res.status(400).json({ ok: false, error: (e && e.message) || "request failed" });

  app.get("/api/token/status", (req, res) => res.json(enabled() ? svc.status() : {
    ok: true, enabled: false,
    // diagnostics so a stuck setup is self-explaining: which half is missing?
    flagSet: (opts.flag ? !!opts.flag() : (process.env.ENABLE_TOKEN_BRIDGE === "1")),
    signerAddress: (function () { try { return opts.signerAddress ? opts.signerAddress() : null; } catch (e) { return null; } })(),
  }));
  app.get("/api/token/house-state", (req, res) => { if (!guard(res)) return; try { res.json(svc.houseState()); } catch (e) { fail(res, e); } });
  app.post("/api/token/start", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doStart(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/play", (req, res) => { if (!guard(res)) return; try { res.json(svc.doPlay(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/topup", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doTopUp(req.body || {})); } catch (e) { fail(res, e); } });
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

    // CROSS-SESSION-DRAIN GUARD: a buy-in landing on a player who ALREADY has a prior on-chain lock
    // (eventLocked > this buy-in) is rejected — else a single settle could claim the combined lock.
    const svcG = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei, eventLocked: (BigInt(o.buyInWei) * 2n).toString() }) });
    const gw = ethers.Wallet.createRandom(); const gp = gw.address;
    const gBody = { player: gp, contract, chainId, txHash: "0x" + "9".repeat(64), buyInWei: lockedWei.toString() };
    gBody.signature = await gw.signMessage(tokenAuthMessage("start", { player: gp, contract, chainId, buyInWei: lockedWei.toString() }));
    let drainGuard = 0; try { await svcG.doStart(gBody); } catch (e) { drainGuard = 1; }
    eq("cross-session guard: rejects a buy-in stacked on a prior lock", drainGuard === 1);

    // play requires the session token
    let badtok = 0; try { svc.doPlay({ sessionId: started.sessionId, sessionToken: "nope", game: "coinflip", betUnits: 1 }); } catch (e) { badtok++; }
    eq("play rejects a wrong session token", badtok === 1);

    // play a run; tokens move; serverSeed never leaks
    let leaked = false;
    for (let i = 0; i < 50; i++) { const r = svc.doPlay({ sessionId: started.sessionId, sessionToken: started.sessionToken, game: "coinflip", betUnits: 10, params: { side: i % 2 }, clientSeed: "c" + i }); if (r.serverSeed) leaked = true; }
    eq("play never leaks the serverSeed", !leaked);

    // TOP UP: a second on-chain lock adds tokens to the SAME open session (no cash-out needed)
    const topTx = "0x" + "f".repeat(64);
    const topBody = { player, sessionId: started.sessionId, sessionToken: started.sessionToken, txHash: topTx, buyInWei: lockedWei.toString() };
    topBody.signature = await sign("topup", { player, contract, chainId, sessionId: started.sessionId, buyInWei: lockedWei.toString() });
    const beforeTopTokens = svc._bridge.session(started.sessionId).tokens;
    const topped = await svc.doTopUp(topBody);
    eq("top-up adds another $1000 of tokens to the open session", Math.round((topped.tokens - beforeTopTokens) * 100) / 100 === 1000);
    eq("top-up doubles buyInUnits to $2000", svc._bridge.session(started.sessionId).buyInUnits === 2000);
    let topReused = 0; try { await svc.doTopUp(topBody); } catch (e) { topReused = 1; }
    eq("top-up rejects a reused txHash", topReused === 1);
    let topBadTok = 0; try { await svc.doTopUp({ ...topBody, sessionToken: "nope", txHash: "0x" + "1".repeat(64) }); } catch (e) { topBadTok = 1; }
    eq("top-up rejects a wrong session token", topBadTok === 1);

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

    // ── PERSISTED replay guard survives a restart ───────────────────────────
    // A single in-memory store stands in for the durable persist sink (e.g. a JSON file).
    const store = { _state: null, load() { return this._state; }, save(s) { this._state = JSON.parse(JSON.stringify(s)); } };
    const mkSvc = () => makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), persist: store });

    const w2 = ethers.Wallet.createRandom(); const p2 = w2.address;
    const sign2 = (intent, o) => w2.signMessage(tokenAuthMessage(intent, o));
    const tx2 = "0x" + "d".repeat(64);

    const svcA = mkSvc();
    const sb2 = { player: p2, contract, chainId, txHash: tx2, buyInWei: lockedWei.toString() };
    sb2.signature = await sign2("start", { player: p2, contract, chainId, buyInWei: lockedWei.toString() });
    const started2 = await svcA.doStart(sb2);
    eq("fresh buy-in starts under a persisting service", started2.tokens === 1000);

    // RESTART: a brand-new service loads ONLY from the durable store.
    const svcB = mkSvc();
    let reusedAfterRestart = 0; try { await svcB.doStart(sb2); } catch (e) { reusedAfterRestart = 1; }
    eq("PERSIST: a used buy-in txHash is still rejected after restart", reusedAfterRestart === 1);

    // the open session also survived the restart → a NEW txHash for the same player is blocked
    const sb2b = { player: p2, contract, chainId, txHash: "0x" + "e".repeat(64), buyInWei: lockedWei.toString() };
    sb2b.signature = await sign2("start", { player: p2, contract, chainId, buyInWei: lockedWei.toString() });
    let openSurvived = 0; try { await svcB.doStart(sb2b); } catch (e) { openSurvived = 1; }
    eq("PERSIST: the open-session lock survives restart", openSurvived === 1);

    // THE FROZEN-BALANCE REGRESSION: the per-session BEARER must survive the restart too, so a
    // mid-session player keeps playing after a redeploy instead of every /play silently 400ing.
    let playAfterRestart = false;
    try { const pr = svcB.doPlay({ sessionId: started2.sessionId, sessionToken: started2.sessionToken, game: "coinflip", betUnits: 10, params: { side: 0 }, clientSeed: "post-restart" }); playAfterRestart = !!pr.ok; } catch (e) { playAfterRestart = false; }
    eq("PERSIST: play() works after restart (bearer survived → no frozen balance)", playAfterRestart === true);
    let staleTokRejected = 0; try { svcB.doPlay({ sessionId: started2.sessionId, sessionToken: "wrong-token", game: "coinflip", betUnits: 10 }); } catch (e) { staleTokRejected = 1; }
    eq("PERSIST: a wrong bearer is still rejected after restart", staleTokRejected === 1);

    // and the bridge session itself survived — settle works on the restarted service
    const settleSig2 = await sign2("settle", { player: p2, contract, chainId, sessionId: started2.sessionId });
    const stl2 = await svcB.doSettle({ player: p2, sessionId: started2.sessionId, signature: settleSig2 });
    eq("PERSIST: the bridge session survives restart and settles", !!stl2.serverSeedReveal);

    // after settle on the restarted service the player is free again — but the spent tx stays spent
    const svcC = mkSvc();
    let stillSpent = 0; try { await svcC.doStart(sb2); } catch (e) { stillSpent = 1; }
    eq("PERSIST: spent txHash stays spent even after the session is settled", stillSpent === 1);

    console.log(ok ? "\nSELF-TEST OK — token HTTP service: verified buy-in → token-gated play → wallet-authed signed settle (+ persisted replay guard)." : "\nSELF-TEST FAILED");
    process.exit(ok ? 0 : 1);
  })().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
}
