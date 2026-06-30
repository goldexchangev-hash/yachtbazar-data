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
  "function bjNonceUsed(uint256 nonce) view returns (bool)",
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
  // admin-release / admin-player: the OWNER signs (Player: = the owner's own address) and names a
  // TARGET player whose stranded lock to release / inspect. The server re-checks Player == on-chain owner.
  else if (intent === "admin-release" || intent === "admin-player") lines.push("Target: " + address(o.target, "target"));
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

// Read a wallet's current on-chain bjLocked (for stranded-lock recovery). Injectable for tests.
function makeBjLockedReader(rpcUrlFor) {
  return async function readBjLocked(contract, chainId, player) {
    const url = rpcUrlFor(chainId);
    if (!url) throw new Error("bridge RPC not configured");
    const fr = new ethers.FetchRequest(url); fr.timeout = 12000;
    const provider = new ethers.JsonRpcProvider(fr, undefined, { staticNetwork: true });
    const c = new ethers.Contract(contract, BUYIN_ABI, provider);
    return BigInt((await c.bjLocked(player)).toString());
  };
}

// Has a settle nonce already been consumed on-chain? Used to decide whether an outstanding settlement
// obligation is still LIVE (re-issue it) or has been claimed (clear it). Injectable for tests.
function makeNonceUsedReader(rpcUrlFor) {
  return async function readNonceUsed(contract, chainId, nonce) {
    const url = rpcUrlFor(chainId);
    if (!url) throw new Error("bridge RPC not configured");
    const fr = new ethers.FetchRequest(url); fr.timeout = 12000;
    const provider = new ethers.JsonRpcProvider(fr, undefined, { staticNetwork: true });
    const c = new ethers.Contract(contract, BUYIN_ABI, provider);
    return !!(await c.bjNonceUsed(BigInt(String(nonce))));
  };
}

// Read the contract's owner + treasury (the "house"). Used to authenticate an owner-signed
// admin-release: only the on-chain owner OR treasury may sign a release of a player's funds.
// (Safe because settleBlackjack always returns funds to the PLAYER — the owner gains nothing.)
const OWNER_ABI = ["function owner() view returns (address)", "function treasury() view returns (address)"];
function makeOwnerReader(rpcUrlFor) {
  return async function readOwner(contract, chainId) {
    const url = rpcUrlFor(chainId);
    if (!url) throw new Error("bridge RPC not configured");
    const fr = new ethers.FetchRequest(url); fr.timeout = 12000;
    const provider = new ethers.JsonRpcProvider(fr, undefined, { staticNetwork: true });
    const c = new ethers.Contract(contract, OWNER_ABI, provider);
    let owner = null, treasury = null;
    try { owner = String(await c.owner()); } catch (e) {}
    try { treasury = String(await c.treasury()); } catch (e) {}
    return { owner, treasury };
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
  const readBjLocked = opts.readBjLocked || makeBjLockedReader(opts.rpcUrlFor || (() => ""));
  const readNonceUsed = opts.readNonceUsed || makeNonceUsedReader(opts.rpcUrlFor || (() => ""));
  const readOwner = opts.readOwner || makeOwnerReader(opts.rpcUrlFor || (() => ""));

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
  // OUTSTANDING SETTLEMENT OBLIGATION — player(lowercased) -> { netWei, nonce, signature, chainId, contract }.
  // The instant the server signs ANY settlement for a player's current on-chain lock (cash-out OR a
  // recover that closed a session), it records the obligation here. Until the chain consumes that lock
  // (bjLocked → 0), every later recover/admin-release RE-ISSUES this same settlement instead of signing
  // a fresh net=0. Without it, a losing player could settle at a loss off-chain, NOT broadcast it, then
  // recover a net=0 settlement (different nonce) and reclaim the full principal — escaping the loss
  // (proven by the v12.34 adversarial audit). MUST be persisted so a redeploy can't reopen the hole.
  const pendingSettle = new Map();
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
      for (const [p, ob] of st.pendingSettle || []) if (ob) pendingSettle.set(String(p), ob);
    } catch (e) {}
  }
  function saveHttp() {
    if (!httpPersist) return;
    try {
      httpPersist.save({
        usedBuyIns: Array.from(usedBuyIns),
        openByPlayer: Array.from(openByPlayer.entries()),
        tokenForSession: Array.from(tokenForSession.entries()),
        pendingSettle: Array.from(pendingSettle.entries()),
      });
    } catch (e) {}
  }
  // Record the signed settlement the server just committed to for this player's current lock.
  function recordObligation(player, contract, chainId, settlement) {
    if (!settlement || settlement.netWei == null || settlement.nonce == null || !settlement.signature) return;
    pendingSettle.set(String(player).toLowerCase(), {
      netWei: String(settlement.netWei), nonce: String(settlement.nonce), signature: settlement.signature,
      chainId: Number(chainId), contract: String(contract),
    });
  }

  // PER-PLAYER MUTEX — serialize every settlement-SIGNING op (settle / release / admin-release) for a
  // given wallet so the check-then-record sequence is atomic. Without it, N concurrent releases on one
  // open losing session could each fall through and mint a DISTINCT net=0 (the player keeps a loss AND a
  // net=0 → escapes the loss). Chaining each call after the previous one's settlement closes that race.
  const _playerChain = new Map();
  function withPlayerLock(player, fn) {
    const key = String(player).toLowerCase();
    const prev = _playerChain.get(key) || Promise.resolve();
    const result = prev.then(fn, fn); // run fn once the prior op for this player has settled (success or fail)
    const settled = result.then(() => {}, () => {});
    _playerChain.set(key, settled);
    settled.then(() => { if (_playerChain.get(key) === settled) _playerChain.delete(key); });
    return result;
  }

  // Is a recorded obligation still LIVE (must be re-issued) or already claimed on-chain (clear it)?
  // Decided by the obligation's OWN contract/chainId/nonce — never request params — and tolerant of an
  // RPC failure (treat as LIVE so we never mint a fresh net=0 in the dark).
  async function obligationConsumed(ob) {
    if (!ob || ob.nonce == null) return false;
    try { return await readNonceUsed(ob.contract, ob.chainId, ob.nonce); }
    catch (e) { return false; }
  }

  const bridge = makeTokenBridge({ signer: opts.signer || null, persist: nsPersist("bridge") });

  // Per-session rate limit on /play so a malicious flood can't pin the single-instance event loop.
  // Generous token bucket — fish-shooter bills only CONNECTING shots (a few/sec), so legit fast
  // auto-fire never trips it; a few-hundred/sec flood does. In-memory (per-process) is fine.
  const PLAY_RATE = Number(opts.playRatePerSec) || 30;   // sustained plays/sec/session
  const PLAY_BURST = Number(opts.playBurst) || 60;        // bucket capacity
  const playBuckets = new Map();                          // sessionId -> { tokens, ts }
  function rateOk(sessionId) {
    const now = Date.now();
    let b = playBuckets.get(sessionId);
    if (!b) { b = { tokens: PLAY_BURST, ts: now }; playBuckets.set(sessionId, b); }
    b.tokens = Math.min(PLAY_BURST, b.tokens + ((now - b.ts) / 1000) * PLAY_RATE);
    b.ts = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

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
    // NOTE: we deliberately do NOT clear pendingSettle here. A stale obligation is harmless — recover's
    // branch (2) re-reads bjNonceUsed and clears it only when the chain proves it consumed; and the next
    // settle/release overwrites it. Clearing on doStart was attacker-poisonable (a fake contract could
    // doStart-clear a real loss obligation), so it's removed.
    const sessionToken = crypto.randomBytes(24).toString("hex");
    tokenForSession.set(started.sessionId, sessionToken);
    saveHttp(); // durably record the spent txHash + open session + bearer BEFORE handing it back
    return { ok: true, sessionId: started.sessionId, sessionToken, commit: started.commit, tokens: started.tokens, buyInUnits, games: started.games };
  }

  function doPlay(body) {
    const sessionId = String((body && body.sessionId) || "");
    const token = String((body && body.sessionToken) || "");
    if (!token || tokenForSession.get(sessionId) !== token) throw new Error("invalid session token");
    if (!rateOk(sessionId)) throw new Error("too many bets too fast — slow down a moment");
    const r = bridge.play({ sessionId, game: body.game, betUnits: body.betUnits, params: body.params, clientSeed: body.clientSeed });
    return { ok: true, ...r }; // NOTE: never includes serverSeed — only the commit is exposed pre-settle
  }

  // Resume after a page refresh: verify the (sessionId, bearer) pair and return the live balance so
  // the client can RECONNECT to an existing open session instead of orphaning it. Returns
  // { ok:false } if the server no longer has it (so the client clears its stale local copy cleanly).
  function doSession(q) {
    const sessionId = String((q && q.sessionId) || "");
    const token = String((q && q.sessionToken) || "");
    if (!token || tokenForSession.get(sessionId) !== token) return { ok: false };
    const s = bridge.session(sessionId);
    if (!s || s.closed) return { ok: false };
    return { ok: true, sessionId: s.id, tokens: s.tokens, buyInUnits: s.buyInUnits, commit: s.commit };
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

  function doSettle(body) {
    const player = address(body && body.player, "player");
    const s = bridge.session(body && body.sessionId);
    if (!s) throw new Error("no such session");
    if (s.player.toLowerCase() !== player.toLowerCase()) throw new Error("session does not belong to player");
    verifyWalletSignature("settle", body, { player, contract: s.contract, chainId: s.chainId, sessionId: s.id });
    // Serialize per player so a concurrent recover can't interleave with this cash-out (race-minted net=0).
    return withPlayerLock(player, async () => {
      if (liveExternal(player)) throw new Error("finish your blackjack hand before cashing out");
      const settlement = await bridge.settle({ sessionId: s.id });
      openByPlayer.delete(player);
      tokenForSession.delete(s.id);
      playBuckets.delete(s.id);
      // Record the obligation BEFORE freeing the slot: until the chain consumes this lock, a later
      // recover must re-issue THIS settlement (same nonce/net), never a fresh net=0 (loss-escape guard).
      recordObligation(player, s.contract, s.chainId, settlement);
      saveHttp(); // the session is no longer open — persist the freed slot + dropped bearer (txHash stays spent)
      return settlement; // includes netWei, signature, serverSeedReveal (now safe), commit
    });
  }

  // BULLETPROOF RECOVER — get back EVERYTHING locked on-chain, no matter the session state, while NEVER
  // letting a player escape a loss they already incurred.
  //
  // The contract's bjLocked is ONE per-player accumulator and settleBlackjack ALWAYS zeros it and
  // returns (locked + net). So a stranded lock and an open session's lock are inseparable on-chain —
  // you cannot release one without settling the other. The old code refused while a session was open,
  // which stranded funds whenever the client's view desynced from the server's. This unified path
  // removes that failure mode in THREE ordered branches:
  //
  //   (1) Open session → settle it at its real net (a normal cash-out). The contract returns the FULL
  //       bjLocked + that net, so any commingled stranded principal rides back automatically. We record
  //       the obligation so the next call can't hand out a different (net=0) settlement.
  //   (2) No open session but an OUTSTANDING obligation against the still-locked funds → re-issue the
  //       EXACT same settlement (same nonce/net/signature). This is the loss-escape guard: a player who
  //       settled at a loss but didn't broadcast it gets that same losing settlement back, never net=0.
  //   (3) No open session and NO obligation → a truly orphaned lock (e.g. lost before a disk was
  //       mounted) → net=0 release of exactly the locked principal.
  //
  // The PLAYER always signs to prove ownership; the house signs the net. Funds only ever return to
  // the player. Because every path against a given lock yields ONE settlement (re-issued idempotently),
  // a player can claim at most that one — they can never withhold a loss and claim a fresh net=0.
  function doRelease(body) {
    const player = address(body && body.player, "player");
    const contract = address(body && body.contract, "contract");
    const chainId = Number(body && body.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
    verifyWalletSignature("release", body, { player, contract, chainId });
    if (!opts.signer || !opts.signer.sign) throw new Error("signer not configured");
    const key = player.toLowerCase();
    // Serialize per player so the branch decision + obligation record can't interleave (no race-minted net=0).
    return withPlayerLock(player, async () => {
      if (liveExternal(player)) throw new Error("finish your blackjack hand before recovering");
      // (1) Open session → cash it out (returns full bjLocked + its real net).
      const sid = openByPlayer.get(player);
      if (sid) {
        const s = bridge.session(sid);
        if (s && !s.closed) {
          if (s.contract && s.contract.toLowerCase() !== contract.toLowerCase()) throw new Error("contract mismatch for your open session");
          const settlement = await bridge.settle({ sessionId: sid });
          openByPlayer.delete(player);
          tokenForSession.delete(sid);
          playBuckets.delete(sid);
          recordObligation(player, s.contract || contract, s.chainId || chainId, settlement); // pin this as the ONLY claimable settlement
          saveHttp();
          // mode:"session" tells the client this cashed out a live session (clear local session too).
          return { ok: true, mode: "session", ...settlement };
        }
        // The map pointed at a vanished/closed session — clear the stale slot, then fall through.
        openByPlayer.delete(player);
        saveHttp();
      }

      // (2) Outstanding obligation → re-issue the SAME settlement, UNLESS the chain already consumed its
      //     nonce. Gated by the obligation's OWN contract/nonce (NOT request params) so a player can't
      //     pass a different contract/chainId to dodge the guard and reach the net=0 branch.
      const ob = pendingSettle.get(key);
      if (ob) {
        if (!(await obligationConsumed(ob))) {
          let lw = "0"; try { lw = (await readBjLocked(ob.contract, ob.chainId, player)).toString(); } catch (e) {}
          return { ok: true, mode: "obligation", netWei: String(ob.netWei), nonce: String(ob.nonce), signature: ob.signature, lockedWei: lw };
        }
        pendingSettle.delete(key); saveHttp(); // consumed on-chain → safe to clear, then treat as a fresh lock
      }

      // (3) No live obligation → net=0 release of whatever is locked on the REQUEST's contract.
      const lockedWei = await readBjLocked(contract, chainId, player);
      if (!(lockedWei > 0n)) throw new Error("no locked funds found for this wallet");
      const nonce = BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString(); // fresh settle nonce
      const signature = await opts.signer.sign(player, 0n, nonce, chainId, contract);
      recordObligation(player, contract, chainId, { netWei: "0", nonce, signature }); // pin it (idempotent re-issue)
      saveHttp();
      return { ok: true, mode: "orphan", netWei: "0", nonce, signature, lockedWei: lockedWei.toString() };
    });
  }

  // OWNER-AUTHENTICATED owner check: the signer must be the contract's on-chain owner OR treasury.
  async function requireOwner(owner, contract, chainId) {
    const who = await readOwner(contract, chainId);
    const o = String(owner).toLowerCase();
    const isOwner = (who.owner && String(who.owner).toLowerCase() === o) || (who.treasury && String(who.treasury).toLowerCase() === o);
    if (!isOwner) throw new Error("only the house owner can do that");
  }

  // HOUSE TOOL — release a STRANDED player's locked funds back to THAT player. The owner signs
  // (proving they're the on-chain owner/treasury); the house signs a net=0 settlement for the target
  // player; the owner submits it. Funds go to the PLAYER's balance — the owner gains nothing, so this
  // is safe even though no player signature is involved. Refused while the player has an ACTIVE
  // session (that's theirs to cash out — force-settling would yank a live game), so this only ever
  // unwinds a truly orphaned lock.
  function doAdminRelease(body) {
    const owner = address(body && body.owner, "owner");
    const contract = address(body && body.contract, "contract");
    const chainId = Number(body && body.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
    const player = address(body && body.player, "player");
    verifyWalletSignature("admin-release", body, { player: owner, contract, chainId, target: player });
    if (!opts.signer || !opts.signer.sign) throw new Error("signer not configured");
    const key = player.toLowerCase();
    return withPlayerLock(player, async () => {
      await requireOwner(owner, contract, chainId);
      if (openByPlayer.has(player)) throw new Error("that player has an active session — they cash out themselves");
      // Respect any LIVE obligation first (same loss-escape guard as doRelease): if this player settled a
      // session (e.g. at a loss) and never broadcast it, re-issue THAT settlement — never a net=0 that
      // would forgive their loss. Gated by the obligation's OWN nonce, not request params.
      const ob = pendingSettle.get(key);
      if (ob) {
        if (!(await obligationConsumed(ob))) {
          let lw = "0"; try { lw = (await readBjLocked(ob.contract, ob.chainId, player)).toString(); } catch (e) {}
          return { ok: true, player, netWei: String(ob.netWei), nonce: String(ob.nonce), signature: ob.signature, lockedWei: lw };
        }
        pendingSettle.delete(key); saveHttp();
      }
      const lockedWei = await readBjLocked(contract, chainId, player);
      if (!(lockedWei > 0n)) throw new Error("no locked funds found for that player");
      const nonce = BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString();
      const signature = await opts.signer.sign(player, 0n, nonce, chainId, contract);
      recordObligation(player, contract, chainId, { netWei: "0", nonce, signature });
      saveHttp();
      return { ok: true, player, netWei: "0", nonce, signature, lockedWei: lockedWei.toString() };
    });
  }

  // HOUSE TOOL — per-player diagnostics for the owner's support view: on-chain locked principal +
  // whether the server holds an open session for them (and its live tokens / buy-in / unrealized
  // net). Owner-authenticated; returns NO secrets (the player's own public address + their public
  // on-chain lock). Lets the owner tell "stuck orphaned lock" (releasable) from "live session"
  // (player cashes out) at a glance when a player reports a problem.
  async function doAdminPlayer(body) {
    const owner = address(body && body.owner, "owner");
    const contract = address(body && body.contract, "contract");
    const chainId = Number(body && body.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
    const player = address(body && body.player, "player");
    verifyWalletSignature("admin-player", body, { player: owner, contract, chainId, target: player });
    await requireOwner(owner, contract, chainId);
    let lockedWei = 0n; try { lockedWei = await readBjLocked(contract, chainId, player); } catch (e) {}
    const ethUsd = ethUsdFn();
    const sid = openByPlayer.get(player);
    let session = null;
    if (sid) {
      const s = bridge.session(sid);
      if (s && !s.closed) {
        const buyInUnits = Number(s.buyInUnits) || 0, tokens = Number(s.tokens) || 0;
        session = {
          sessionId: s.id, buyInUnits: Math.round(buyInUnits * 100) / 100,
          tokens: Math.round(tokens * 100) / 100,
          unrealizedUnits: Math.round((tokens - buyInUnits) * 100) / 100, // player's current P&L vs buy-in
        };
      }
    }
    const lockedUsd = weiToUsd(lockedWei, ethUsd);
    return {
      ok: true, player, lockedWei: lockedWei.toString(), lockedUsd,
      hasOpenSession: !!session, session,
      // Funds locked on-chain that NO open session accounts for = a stranded/orphaned lock the owner
      // can release. (sessionLock subtracted via lockedUsd − session.buyInUnits when a session exists.)
      strandedUsd: Math.max(0, Math.round((lockedUsd - (session ? session.buyInUnits : 0)) * 100) / 100),
    };
  }

  function status() { return { ok: true, enabled: true, signerAddress: (opts.signerAddress ? opts.signerAddress() : null), ethUsd: (opts.ethUsd ? opts.ethUsd() : null), priceReady: (opts.ethUsdReady ? !!opts.ethUsdReady() : true), store: (opts.storeInfo ? opts.storeInfo() : null), games: bridge.games(), model: "server commit-reveal token bridge (no VRF)" }; }

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

  // ── TOKEN-FUNDED BLACKJACK bridge (multiplayer blackjack chips = this player's token session) ──
  // The blackjack server (server/blackjack-server.js) calls these in-process to read + move a player's
  // token balance as hands settle. tokensOf is a pure read; applyBlackjackNet debits the bet / credits
  // the payout via the bridge's bounded, ledgered applyExternal. SYNCHRONOUS (no chain call) so the
  // blackjack bank's get/credit/debit stay synchronous.
  function tokensOf(sessionId) {
    const s = bridge.session(String(sessionId || ""));
    return (s && !s.closed && !s.settlement) ? s.tokens : null; // null ⇒ no open session (settled / unknown)
  }
  function applyBlackjackNet(player, sessionId, betUnits, payoutUnits, ref) {
    const s = bridge.session(String(sessionId || ""));
    if (!s || s.closed || s.settlement) throw new Error("no open token session");
    if (String(s.player).toLowerCase() !== String(player || "").toLowerCase()) throw new Error("session does not belong to player");
    const r = bridge.applyExternal({ sessionId: s.id, game: "blackjack", betUnits: betUnits, payoutUnits: payoutUnits, ref: ref });
    return r.tokens;
  }
  // True if the player has a blackjack hand/bet in flight against their token session — used to REFUSE a
  // cash-out / recover mid-hand (else the settle would lock in a debited stake before the hand resolves).
  function liveExternal(player) { try { return !!(opts.hasLiveExternal && opts.hasLiveExternal(player)); } catch (e) { return false; } }

  return { doStart, doPlay, doTopUp, doSettle, doSession, doRelease, doAdminRelease, doAdminPlayer, status, houseState, verifySession, tokensOf, applyBlackjackNet, liveExternal, _bridge: bridge };
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
  app.get("/api/token/session", (req, res) => { if (!guard(res)) return; try { res.json(svc.doSession(req.query || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/start", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doStart(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/play", (req, res) => { if (!guard(res)) return; try { res.json(svc.doPlay(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/topup", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doTopUp(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/settle", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doSettle(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/release", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doRelease(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/admin-release", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doAdminRelease(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/admin-player", async (req, res) => { if (!guard(res)) return; try { res.json(await svc.doAdminPlayer(req.body || {})); } catch (e) { fail(res, e); } });
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

    // RESUME (page-refresh reconnect): a valid (sessionId, bearer) returns the live balance; a bad one doesn't.
    const resumeOk = svc.doSession({ sessionId: started.sessionId, sessionToken: started.sessionToken });
    eq("resume verifies a live session (returns tokens)", resumeOk.ok === true && typeof resumeOk.tokens === "number");
    eq("resume rejects a wrong bearer", svc.doSession({ sessionId: started.sessionId, sessionToken: "nope" }).ok === false);

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

    // RELEASE (stranded-lock recovery): house signs a net=0 settlement returning the locked principal.
    const relSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei });
    const relw = ethers.Wallet.createRandom(); const relp = relw.address;
    const relSig = await relw.signMessage(tokenAuthMessage("release", { player: relp, contract, chainId }));
    const rel = await relSvc.doRelease({ player: relp, contract, chainId, signature: relSig });
    eq("release signs a net=0 settlement for the locked principal", rel.netWei === "0" && BigInt(rel.lockedWei) === lockedWei);
    const relRec = ethers.verifyMessage(ethers.getBytes(settlementHash(relp, 0n, BigInt(rel.nonce), chainId, contract)), rel.signature);
    eq("release settlement recovers to the house signer", relRec === house.address);
    let relNone = 0; try { const s0 = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => 0n }); const sig0 = await relw.signMessage(tokenAuthMessage("release", { player: relp, contract, chainId })); await s0.doRelease({ player: relp, contract, chainId, signature: sig0 }); } catch (e) { relNone = 1; }
    eq("release rejects when nothing is locked", relNone === 1);
    let relBadSig = 0; try { await relSvc.doRelease({ player: relp, contract, chainId, signature: "0x" + "0".repeat(130) }); } catch (e) { relBadSig = 1; }
    eq("release rejects a bad signature", relBadSig === 1);

    // RECOVER WHILE A SESSION IS OPEN: doRelease now SETTLES the live session (returns its net),
    // instead of refusing — so a confused client can always recover the full on-chain lock.
    const recSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }) });
    const rw = ethers.Wallet.createRandom(); const rp = rw.address;
    const rcSign = (intent, o) => rw.signMessage(tokenAuthMessage(intent, o));
    const rcStartBody = { player: rp, contract, chainId, txHash: "0x" + "2".repeat(64), buyInWei: lockedWei.toString() };
    rcStartBody.signature = await rcSign("start", { player: rp, contract, chainId, buyInWei: lockedWei.toString() });
    const rcStarted = await recSvc.doStart(rcStartBody);
    const rcRelSig = await rcSign("release", { player: rp, contract, chainId });
    const rcRel = await recSvc.doRelease({ player: rp, contract, chainId, signature: rcRelSig });
    eq("recover with an OPEN session settles it (mode:session, reveals seed)", rcRel.mode === "session" && !!rcRel.serverSeedReveal && typeof rcRel.netWei === "string");
    let rcFreed = 0; try { const b2 = { player: rp, contract, chainId, txHash: "0x" + "3".repeat(64), buyInWei: lockedWei.toString() }; b2.signature = await rcSign("start", { player: rp, contract, chainId, buyInWei: lockedWei.toString() }); await recSvc.doStart(b2); } catch (e) { rcFreed = 1; }
    eq("recover frees the open-session slot (can buy in again)", rcFreed === 0);

    // ── LOSS-ESCAPE GUARD (the v12.34 audit finding) ──────────────────────────────────────────
    // A losing player settles their session off-chain (gets a signed NEGATIVE net), withholds it, then
    // calls recover AGAIN hoping for a fresh net=0. The server must RE-ISSUE the same losing settlement
    // (same nonce/net), never net=0 — so the player can only ever claim their real (losing) result.
    // readBjLocked stays full because the loss settlement was never broadcast on-chain.
    const lossSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei });
    const lw = ethers.Wallet.createRandom(); const lp = lw.address;
    const lSign = (intent, o) => lw.signMessage(tokenAuthMessage(intent, o));
    const lStart = { player: lp, contract, chainId, txHash: "0x" + "5".repeat(64), buyInWei: lockedWei.toString() };
    lStart.signature = await lSign("start", { player: lp, contract, chainId, buyInWei: lockedWei.toString() });
    const lStarted = await lossSvc.doStart(lStart);
    // deterministically drive the session into a loss (tokens below the $1000 buy-in) — directly
    // (real play would be random; we only need a settled NEGATIVE net to test the guard).
    lossSvc._bridge.session(lStarted.sessionId).tokens = 800; // a $200 loss
    const lostTokens = lossSvc._bridge.session(lStarted.sessionId).tokens;
    const lRelSig1 = await lSign("release", { player: lp, contract, chainId });
    const lRel1 = await lossSvc.doRelease({ player: lp, contract, chainId, signature: lRelSig1 }); // settles the loss (withheld)
    const lRelSig2 = await lSign("release", { player: lp, contract, chainId });
    const lRel2 = await lossSvc.doRelease({ player: lp, contract, chainId, signature: lRelSig2 }); // must RE-ISSUE, not net=0
    eq("loss-escape guard: a withheld losing settlement re-issues (never a fresh net=0)",
       lostTokens < 1000 && BigInt(lRel1.netWei) < 0n && lRel2.mode === "obligation" && lRel2.netWei === lRel1.netWei && lRel2.nonce === lRel1.nonce);

    // A TRULY orphaned lock (no session, no obligation) still gets a clean net=0 — and re-issues the SAME
    // net=0 (same nonce) on a repeat call, so it can't mint a second distinct claimable settlement.
    const orphSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei });
    const ow = ethers.Wallet.createRandom(); const op = ow.address;
    const oRel1 = await orphSvc.doRelease({ player: op, contract, chainId, signature: await ow.signMessage(tokenAuthMessage("release", { player: op, contract, chainId })) });
    const oRel2 = await orphSvc.doRelease({ player: op, contract, chainId, signature: await ow.signMessage(tokenAuthMessage("release", { player: op, contract, chainId })) });
    eq("orphan release is net=0 and idempotent (same nonce on repeat)", oRel1.mode === "orphan" && oRel1.netWei === "0" && oRel2.netWei === "0" && oRel2.nonce === oRel1.nonce);

    // CONTRACT/CHAINID BYPASS (the v12.34 re-audit finding): after settling a loss on the REAL contract,
    // calling release for a DIFFERENT contract/chainId must NOT clear/overwrite the obligation or mint a
    // fresh net=0 on the real contract. The guard ignores request params and re-issues the stored loss.
    const C2 = "0x000000000000000000000000000000000000c2c2";
    const bypSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readNonceUsed: async () => false });
    const bw = ethers.Wallet.createRandom(); const bp = bw.address;
    const bStart = { player: bp, contract, chainId, txHash: "0x" + "6".repeat(64), buyInWei: lockedWei.toString() };
    bStart.signature = await bw.signMessage(tokenAuthMessage("start", { player: bp, contract, chainId, buyInWei: lockedWei.toString() }));
    const bStarted = await bypSvc.doStart(bStart);
    bypSvc._bridge.session(bStarted.sessionId).tokens = 750; // a $250 loss
    const bLoss = await bypSvc.doRelease({ player: bp, contract, chainId, signature: await bw.signMessage(tokenAuthMessage("release", { player: bp, contract, chainId })) });
    // attacker pivots to a DIFFERENT contract C2 (and chainId) trying to poison/clear the obligation
    const byp1 = await bypSvc.doRelease({ player: bp, contract: C2, chainId, signature: await bw.signMessage(tokenAuthMessage("release", { player: bp, contract: C2, chainId })) });
    const byp2 = await bypSvc.doRelease({ player: bp, contract, chainId, signature: await bw.signMessage(tokenAuthMessage("release", { player: bp, contract, chainId })) });
    eq("bypass guard: release on a different contract can't mint a fresh net=0 on the real one",
       BigInt(bLoss.netWei) < 0n && byp1.netWei === bLoss.netWei && byp2.netWei === bLoss.netWei && byp1.nonce === bLoss.nonce && byp2.nonce === bLoss.nonce);

    // CONCURRENCY: N simultaneous recovers on ONE open losing session must yield exactly ONE settlement
    // (one nonce), never several distinct net=0 — the per-player mutex serializes the check-then-record.
    const conSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readNonceUsed: async () => false });
    const cw = ethers.Wallet.createRandom(); const cp = cw.address;
    const cStart = { player: cp, contract, chainId, txHash: "0x" + "8".repeat(64), buyInWei: lockedWei.toString() };
    cStart.signature = await cw.signMessage(tokenAuthMessage("start", { player: cp, contract, chainId, buyInWei: lockedWei.toString() }));
    const cStarted = await conSvc.doStart(cStart);
    conSvc._bridge.session(cStarted.sessionId).tokens = 600; // a $400 loss
    const cSig = await cw.signMessage(tokenAuthMessage("release", { player: cp, contract, chainId }));
    const conResults = await Promise.all(Array.from({ length: 8 }, () => conSvc.doRelease({ player: cp, contract, chainId, signature: cSig }).catch((e) => ({ err: e.message }))));
    const conNonces = new Set(conResults.filter((r) => r && r.nonce != null).map((r) => String(r.nonce)));
    const anyNet0 = conResults.some((r) => r && r.netWei === "0");
    eq("concurrency: 8 simultaneous recovers yield exactly ONE settlement, no net=0", conNonces.size === 1 && !anyNet0);

    // LIVENESS: once the nonce is consumed on-chain, the obligation clears (no spent-nonce trap).
    const livSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => 0n, readNonceUsed: async () => true });
    const vw = ethers.Wallet.createRandom(); const vp = vw.address;
    const vStart = { player: vp, contract, chainId, txHash: "0x" + "a".repeat(63) + "1", buyInWei: lockedWei.toString() };
    vStart.signature = await vw.signMessage(tokenAuthMessage("start", { player: vp, contract, chainId, buyInWei: lockedWei.toString() }));
    const vStarted = await livSvc.doStart(vStart);
    livSvc._bridge.session(vStarted.sessionId).tokens = 900;
    await livSvc.doRelease({ player: vp, contract, chainId, signature: await vw.signMessage(tokenAuthMessage("release", { player: vp, contract, chainId })) }); // settles + records
    let livCleared = 0; try { await livSvc.doRelease({ player: vp, contract, chainId, signature: await vw.signMessage(tokenAuthMessage("release", { player: vp, contract, chainId })) }); } catch (e) { if (/no locked funds/.test(e.message)) livCleared = 1; }
    eq("liveness: a consumed obligation is cleared (no spent-nonce trap)", livCleared === 1);

    // ── ADMIN RELEASE (house recovers a STRANDED player's funds back to that player) ──────────
    const ownerW = ethers.Wallet.createRandom();          // the on-chain owner/treasury
    const admSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readOwner: async () => ({ owner: ownerW.address, treasury: ownerW.address }) });
    const tgt = ethers.Wallet.createRandom().address;     // a stranded player (no open session)
    const admSig = await ownerW.signMessage(tokenAuthMessage("admin-release", { player: ownerW.address, contract, chainId, target: tgt }));
    const adm = await admSvc.doAdminRelease({ owner: ownerW.address, contract, chainId, player: tgt, signature: admSig });
    eq("admin-release: owner releases a stranded player's net=0 lock", adm.netWei === "0" && BigInt(adm.lockedWei) === lockedWei && adm.player.toLowerCase() === tgt.toLowerCase());
    const admRec = ethers.verifyMessage(ethers.getBytes(settlementHash(tgt, 0n, BigInt(adm.nonce), chainId, contract)), adm.signature);
    eq("admin-release: settlement recovers to the house signer (funds → player)", admRec === house.address);
    // a NON-owner is rejected
    const notOwner = ethers.Wallet.createRandom();
    let admDeny = 0; try { const s = await notOwner.signMessage(tokenAuthMessage("admin-release", { player: notOwner.address, contract, chainId, target: tgt })); await admSvc.doAdminRelease({ owner: notOwner.address, contract, chainId, player: tgt, signature: s }); } catch (e) { admDeny = 1; }
    eq("admin-release: rejects a non-owner signer", admDeny === 1);
    // a player WITH an active session can't be force-released by the owner
    const admSvc2 = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readOwner: async () => ({ owner: ownerW.address, treasury: ownerW.address }) });
    const activeW = ethers.Wallet.createRandom(); const activeP = activeW.address;
    const aBody = { player: activeP, contract, chainId, txHash: "0x" + "4".repeat(64), buyInWei: lockedWei.toString() };
    aBody.signature = await activeW.signMessage(tokenAuthMessage("start", { player: activeP, contract, chainId, buyInWei: lockedWei.toString() }));
    await admSvc2.doStart(aBody);
    let admActive = 0; try { const s = await ownerW.signMessage(tokenAuthMessage("admin-release", { player: ownerW.address, contract, chainId, target: activeP })); await admSvc2.doAdminRelease({ owner: ownerW.address, contract, chainId, player: activeP, signature: s }); } catch (e) { admActive = 1; }
    eq("admin-release: refuses a player with an ACTIVE session", admActive === 1);
    // admin-player diagnostics: sees the live session + its net
    const apSig = await ownerW.signMessage(tokenAuthMessage("admin-player", { player: ownerW.address, contract, chainId, target: activeP }));
    const ap = await admSvc2.doAdminPlayer({ owner: ownerW.address, contract, chainId, player: activeP, signature: apSig });
    eq("admin-player: reports the player's open session + locked funds", ap.hasOpenSession === true && ap.session && ap.session.buyInUnits === 1000 && BigInt(ap.lockedWei) === lockedWei);

    // ── TOKEN-FUNDED BLACKJACK: hand bets/wins move the SAME token session; cash-out refused mid-hand ──
    let _liveHand = false;
    const bjSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), hasLiveExternal: () => _liveHand });
    const bjw = ethers.Wallet.createRandom(); const bjp = bjw.address;
    const bjSign = (intent, o) => bjw.signMessage(tokenAuthMessage(intent, o));
    const bjStart = { player: bjp, contract, chainId, txHash: "0x" + "bb".repeat(32), buyInWei: lockedWei.toString() };
    bjStart.signature = await bjSign("start", { player: bjp, contract, chainId, buyInWei: lockedWei.toString() });
    const bjStarted = await bjSvc.doStart(bjStart);
    const bjTok0 = bjStarted.tokens; // $1000
    eq("token-funded bj: tokensOf reads the live balance", bjSvc.tokensOf(bjStarted.sessionId) === bjTok0);
    // a blackjack hand: bet 100 (debit), then win pays 200 (credit) → net +100
    const afterBet = bjSvc.applyBlackjackNet(bjp, bjStarted.sessionId, 100, 0, "hand1:bet");
    eq("token-funded bj: a bet debits tokens", afterBet === Math.round((bjTok0 - 100) * 100) / 100);
    const afterWin = bjSvc.applyBlackjackNet(bjp, bjStarted.sessionId, 0, 200, "hand1:win");
    eq("token-funded bj: a win credits tokens", afterWin === Math.round((bjTok0 - 100 + 200) * 100) / 100);
    let bjWrong = 0; try { bjSvc.applyBlackjackNet("0x000000000000000000000000000000000000dEaD", bjStarted.sessionId, 10, 0); } catch (e) { bjWrong = 1; }
    eq("token-funded bj: rejects a net for the wrong player", bjWrong === 1);
    let bjOver = 0; try { bjSvc.applyBlackjackNet(bjp, bjStarted.sessionId, 1e9, 0); } catch (e) { bjOver = 1; }
    eq("token-funded bj: rejects a bet over the token balance", bjOver === 1);
    // cash-out / recover are REFUSED while a hand is live (else the settle locks in a debited stake)
    _liveHand = true;
    let bjSettleBlocked = 0; try { await bjSvc.doSettle({ player: bjp, sessionId: bjStarted.sessionId, signature: await bjSign("settle", { player: bjp, contract, chainId, sessionId: bjStarted.sessionId }) }); } catch (e) { if (/finish your blackjack hand/.test(e.message)) bjSettleBlocked = 1; }
    eq("token-funded bj: cash-out refused while a hand is live", bjSettleBlocked === 1);
    let bjRelBlocked = 0; try { await bjSvc.doRelease({ player: bjp, contract, chainId, signature: await bjSign("release", { player: bjp, contract, chainId }) }); } catch (e) { if (/finish your blackjack hand/.test(e.message)) bjRelBlocked = 1; }
    eq("token-funded bj: recover refused while a hand is live", bjRelBlocked === 1);
    _liveHand = false; // hand finished → cash-out now works, net reflects the blackjack P&L
    const bjStl = await bjSvc.doSettle({ player: bjp, sessionId: bjStarted.sessionId, signature: await bjSign("settle", { player: bjp, contract, chainId, sessionId: bjStarted.sessionId }) });
    eq("token-funded bj: settles after the hand, net = blackjack P&L (+$100)", Math.round(bjStl.netUnits) === 100);

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

    // RATE LIMIT (isolated tiny-bucket service): a rapid /play flood is throttled after the burst.
    const rlSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), playBurst: 3, playRatePerSec: 1 });
    const rlw = ethers.Wallet.createRandom(); const rlp = rlw.address;
    const rlBody = { player: rlp, contract, chainId, txHash: "0x" + "7".repeat(64), buyInWei: lockedWei.toString() };
    rlBody.signature = await rlw.signMessage(tokenAuthMessage("start", { player: rlp, contract, chainId, buyInWei: lockedWei.toString() }));
    const rlStart = await rlSvc.doStart(rlBody);
    let rlOk2 = 0, rlThrottled = false;
    for (let i = 0; i < 10; i++) { try { rlSvc.doPlay({ sessionId: rlStart.sessionId, sessionToken: rlStart.sessionToken, game: "coinflip", betUnits: 1, params: { side: 0 }, clientSeed: "f" + i }); rlOk2++; } catch (e) { if (/too many bets/.test(e.message)) { rlThrottled = true; break; } } }
    eq("per-session rate limit: burst allowed then throttled", rlOk2 === 3 && rlThrottled === true);

    console.log(ok ? "\nSELF-TEST OK — token HTTP service: verified buy-in → token-gated play → wallet-authed signed settle (+ persisted replay guard)." : "\nSELF-TEST FAILED");
    process.exit(ok ? 0 : 1);
  })().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
}
