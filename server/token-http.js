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
  // release: bind an Expiry (unix seconds) so a CAPTURED release signature can't be replayed
  // indefinitely (#10). Backward-compatible: the line is only added when an expiry is supplied, so an
  // old client that omits it still produces the legacy message — and a captured *expiry-bearing*
  // signature can't be downgraded to the no-expiry message (the signature wouldn't verify).
  else if (intent === "release") { if (o.expiry != null && o.expiry !== "") lines.push("Expiry: " + String(o.expiry)); }
  // admin-release / admin-player: the OWNER signs (Player: = the owner's own address) and names a
  // TARGET player whose stranded lock to release / inspect. The server re-checks Player == on-chain owner.
  // v6 #19: bind an Expiry (like release/house-state) so a CAPTURED owner admin signature can't be replayed
  // indefinitely. Backward-compatible byte-mirror: the line is only added when an expiry is supplied.
  else if (intent === "admin-release" || intent === "admin-player") { lines.push("Target: " + address(o.target, "target")); if (o.expiry != null && o.expiry !== "") lines.push("Expiry: " + String(o.expiry)); }
  // house-state: the OWNER signs to read the aggregate house exposure. Bound by an Expiry so the client
  // can sign ONCE and reuse the payload across polls (no per-poll wallet prompt) without it being valid forever (#20).
  else if (intent === "house-state") lines.push("Expiry: " + String(o.expiry || "0"));
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
    if (minConfirmations > 1) {
      // The tx is MINED (status 1 above), but the client POSTs /start right after its own tx.wait() — which
      // resolves at just 1 confirmation. A ONE-SHOT check here therefore rejected EVERY buy-in with "needs more
      // confirmations" the instant it was mined (conf=1 < minConfirmations). WAIT (bounded) for the tx to reach
      // the required depth instead of rejecting outright — waitForTransaction resolves with the receipt once it
      // hits minConfirmations, or null on timeout, and only THEN do we reject. This never ACCEPTS an under-confirmed
      // tx (strictly safer than before), it just gives a freshly-mined buy-in the extra blocks it needs. The 40s
      // bound keeps the request from hanging (the FetchRequest per-call timeout still applies to each poll).
      let conf = await receipt.confirmations();
      if (conf < minConfirmations) {
        const deeper = await provider.waitForTransaction(o.txHash, minConfirmations, 40000).catch(() => null);
        if (!deeper || deeper.status !== 1) throw new Error("buy-in needs more confirmations — try again in a moment");
      }
    }
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
  // BATCHED WRITE: doStart/doTopUp mutate TWO slices (bridge sessions + http txHash/bearer/openByPlayer)
  // that must hit disk together. Persisting them in two separate writeJsonAtomic calls leaves a crash window
  // (kill -9 between them) where a session is durable but its txHash guard is NOT → restart lets the same
  // chain tx fund a SECOND session (#139). _batchDepth>0 defers the physical write; the op flushes ONCE at
  // the end so the bridge + http slices commit atomically (one rename).
  let _batchDepth = 0, _batchDirty = false;
  function _write() {
    if (_batchDepth > 0) { _batchDirty = true; return; }
    if (rawPersist && rawPersist.save) { try { rawPersist.save(_read()); } catch (e) {} }
  }
  function batchWrite(fn) {
    _batchDepth++;
    try { return fn(); }
    finally {
      _batchDepth--;
      if (_batchDepth === 0 && _batchDirty) { _batchDirty = false; if (rawPersist && rawPersist.save) { try { rawPersist.save(_read()); } catch (e) {} } }
    }
  }
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
  // IN-FLIGHT txHash RESERVATION (process-local; not persisted). doStart/doTopUp reserve the txHash here
  // SYNCHRONOUSLY before the `await verifyBuyIn` RPC and release it in a finally. Without it two concurrent
  // requests with the SAME txHash both pass `usedBuyIns.has` before either reaches `usedBuyIns.add` (TOCTOU)
  // → one chain tx funds two sessions / double-credits a top-up (adversarial-suite #4/#5). The reservation
  // makes the check-then-add atomic across the await.
  const pendingBuyIns = new Set();
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
  // NOTE (v5 #2 deferred): keyed by player ALONE. A composite (player|chainId|contract) key was prototyped to
  // stop a multi-chain config's chain-B settlement from overwriting a withheld chain-A loss, but production is
  // single-chain/single-contract (so the overwrite can't occur) and the composite key relaxes the cross-contract
  // bypass guard's behavior — the loss-escape guard must not be touched without a dedicated, exhaustively-proven
  // change. Branch (2b) findSettledSessionForPlayer already backstops the cross-chain loss case here.
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

  // Find a CLOSED + SETTLED bridge session for this player against this contract whose settlement we
  // must re-issue rather than minting a net=0 orphan. Used as a defense-in-depth net for the crash
  // window where bridge.settle() persisted the closed session but the HTTP-layer obligation record
  // (pendingSettle + openByPlayer) was lost before saveHttp ran (#140/#145). Picks the most recently
  // created match so a stale gc-survivor never shadows the live one. Contract-scoped so a request for a
  // different contract can't surface (and clear) an unrelated lock's settlement.
  function findSettledSessionForPlayer(player, contract) {
    const p = String(player).toLowerCase();
    const c = String(contract || "").toLowerCase();
    let best = null;
    try {
      for (const s of bridge._sessions.values()) {
        if (!s || !s.closed || !s.settlement) continue;
        if (String(s.player || "").toLowerCase() !== p) continue;
        if (c && s.contract && String(s.contract).toLowerCase() !== c) continue;
        if (!best || (Number(s.createdAt) || 0) > (Number(best.createdAt) || 0)) best = s;
      }
    } catch (e) {}
    return best;
  }

  const bridge = makeTokenBridge({ signer: opts.signer || null, persist: nsPersist("bridge"), maxWinUnits: opts.maxWinUnits }); // v6 #14: per-session max-win cap (USD; protects a finite house from a stuck settle)
  // v4 #5: finalize any crash reservation orphaned by an unclean (SIGKILL) restart — see drainOrphanReservations.
  // Runs once at service init, after the bridge rehydrates from disk. Best-effort; a no-op when there are none.
  try { const n = bridge.drainOrphanReservations(); if (n) { try { console.warn("[token] drained " + n + " orphaned crash reservation(s) on boot"); } catch (e) {} } } catch (e) {}

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
    // SERIALIZE per-player so the openByPlayer single-session check + the txHash reservation are atomic
    // against the `await verifyBuyIn` RPC below. Two concurrent doStart for one wallet (same OR different
    // txHash) can no longer both pass their checks and mint two sessions (#4 / #16 DUAL-SESSION). Shares
    // the settle/release per-player chain, so a buy-in can't race a settlement for the same wallet either.
    return withPlayerLock(player, async () => {
    // Validate the buy-in tx FIRST (format + replay) so a REUSED or malformed txHash still rejects cleanly and
    // NEVER mutates an existing session; only a genuinely-NEW, well-formed buy-in may settle/sweep the open slot.
    const contract = address(body && body.contract, "contract");
    const chainId = Number(body && body.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
    const txHash = String((body && body.txHash) || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("buy-in transaction hash is invalid");
    const txKey = txHash.toLowerCase();
    if (usedBuyIns.has(txKey) || pendingBuyIns.has(txKey)) throw new Error("buy-in transaction was already used");
    // A GENUINELY-OPEN session normally blocks a second buy-in (single-session rule). But a GHOST/DEAD slot — a
    // prior session that closed/settled or was GC-pruned yet whose openByPlayer entry was never swept (a net=0
    // limbo gcClosed removed from bridge.sessions without touching this map, or a crash between close and saveHttp)
    // — would otherwise reject EVERY future buy-in forever and strand each on-chain lock (v7 #11 / the tail of the
    // v12.66 trap). Sweep a dead slot here; a live one is handled after verifyBuyIn (v12.94 stale-zombie reclaim).
    let _openZombieSid = null; // v12.94: an OPEN slot we keep for the post-verify stacked-lock check (see below)
    if (openByPlayer.has(player)) {
      const _sid = openByPlayer.get(player);
      const _s = bridge.session(_sid);
      if (_s && !_s.closed) _openZombieSid = _sid; // still-open → decide AFTER we know the on-chain lock (stacked ⇒ abandoned)
      else openByPlayer.delete(player);            // dead/ghost slot → clear it; the batchWrite commit (or next attempt) persists
    }
    // RESERVE the txHash NOW, before the await — a second concurrent request (even a different player)
    // sees it pending and is rejected. Released in finally if we never commit it.
    pendingBuyIns.add(txKey);
    try {
    const buyInWei = positiveWei(body && body.buyInWei, "buy-in");
    // Don't grant tokens at a guessed price: if the live ETH/USD hasn't synced yet (cold start),
    // the wei→token valuation would use the stale fallback and inflate the grant (~2x). Make the
    // player retry a moment later instead of crediting the wrong amount.
    if (opts.ethUsdReady && !opts.ethUsdReady()) throw new Error("price is still syncing — try the buy-in again in a few seconds");
    verifyWalletSignature("start", body, { player, contract, chainId, buyInWei: buyInWei.toString() });
    const proof = await verifyBuyIn({ txHash, player, contract, chainId, buyInWei });
    const lockedWei = BigInt(proof.lockedWei);
    // v12.94 STALE-ZOMBIE RECLAIM. An open slot survived the top-of-doStart check. Decide now that we know the
    // on-chain lock. Two cases:
    //   • the on-chain bjLocked did NOT grow past this session's own recorded lock (proof.eventLocked <= _s.lockedWei):
    //     no NEW money was staked, so this is a legit second buy-in against a session the client still holds — keep
    //     the single-session block (a plain "finish your open session" is correct here; nothing is stranded).
    //   • the on-chain bjLocked STACKED above this session's lock (proof.eventLocked > _s.lockedWei): the ONLY way
    //     that happens is the player's PRIOR buy-in confirmed on-chain but its /start response was lost (the client
    //     never got a bearer) and they re-locked to try again. That prior session is a BEARER-LESS ZOMBIE the player
    //     can never touch except through us — the recurring "$X locked in a past session / every buy-in locks the
    //     funds / can't play" strand, which the pre-v12.94 sweep (CLOSED/GONE only) never freed. Settle it IN PLACE
    //     (exactly what recover branch (1) does) so its lock is freed and its REAL net is recorded, then fall through
    //     to the loss-safe auto-claim below. Loss-escape-safe: bridge.settle signs the ACTUAL net (a losing session
    //     settles at its loss, floored at -lockedWei) and recordObligation pins it, so the auto-claim then FORCES
    //     Recover for a withheld loss — a loss can never be reclaimed as fresh principal. We refuse to settle under a
    //     LIVE crash round / blackjack hand (that state is genuinely in play); those throw and the round/hand finishes.
    if (_openZombieSid) {
      const _s = bridge.session(_openZombieSid);
      const stacked = _s && proof.eventLocked != null && _s.lockedWei != null && (BigInt(proof.eventLocked) - BigInt(_s.lockedWei)) > 0n;
      if (!stacked) throw new Error("finish your open token session before buying in again"); // no new stake ⇒ single-session block stands
      if (liveCrashSession(_openZombieSid) || liveExternal(player)) throw new Error("finish your live round before buying in again"); // in-play ⇒ can't settle under it
      const staleSettle = await bridge.settle({ sessionId: _openZombieSid }); // closes + signs the actual net (loss stays a loss)
      recordObligation(player, (_s && _s.contract) || contract, (_s && _s.chainId) || chainId, staleSettle);
      openByPlayer.delete(player);
      tokenForSession.delete(_openZombieSid);
      playBuckets.delete(_openZombieSid);
      saveHttp(); // durably free the slot + record the obligation before continuing (the auto-claim reads pendingSettle)
    }
    // CROSS-SESSION-DRAIN GUARD + STRANDED-LOCK AUTO-CLAIM. bjLocked is ONE per-player accumulator. openByPlayer
    // (any still-open slot was just settled+freed by the v12.94 stale-zombie reclaim above), so any PRIOR lock
    // (eventLocked > this buy-in's lockedWei) is one of two things:
    //   (a) the player's OWN STRANDED principal — a previous buy-in whose doStart failed AFTER the on-chain lock
    //       (price-sync/RPC blip, or this very guard rejecting). Harmless to reclaim.
    //   (b) the lock behind a WITHHELD LOSS — a settlement the server already signed (recorded in pendingSettle,
    //       or a closed+settled losing bridge session) that the player never broadcast. Reclaiming THAT would let
    //       them escape the loss → must NOT auto-claim; force Recover (which re-issues the loss settlement).
    // So: prior lock + a LIVE loss obligation → REJECT. Prior lock + NO live loss → AUTO-CLAIM the FULL on-chain
    // lock into this session (the stranded principal funds it) instead of stranding the new buy-in too — the trap
    // that compounded $710 → $1420 → … . Checked inside withPlayerLock, so the loss-record read can't race a settle.
    let claimWei = lockedWei;
    if (proof.eventLocked != null && (BigInt(proof.eventLocked) - lockedWei) > 0n) {
      const ob = pendingSettle.get(String(player).toLowerCase());
      let lossLive = !!(ob && !(await obligationConsumed(ob)));
      if (!lossLive) {
        try {
          const settled = findSettledSessionForPlayer(player, contract);
          if (settled && settled.settlement && settled.settlement.nonce != null)
            lossLive = !(await obligationConsumed({ netWei: settled.settlement.netWei, nonce: settled.settlement.nonce, signature: settled.settlement.signature, chainId: settled.chainId || chainId, contract: settled.contract || contract }));
        } catch (e) { lossLive = true; } // can't VERIFY the settled-loss state (e.g. RPC error) → FAIL CLOSED: never auto-claim over a loss we couldn't rule out; force Recover instead
      }
      // DEFENSE-IN-DEPTH: only auto-claim when the LEGACY on-chain blackjack bridge is OFF. If it were enabled,
      // a prior bjLocked could be a LIVE on-chain blackjack hand (NOT tracked by openByPlayer), and reclaiming
      // it into a token session would let both claim the lock. The owner runs ENABLE_EXPERIMENTAL_BRIDGE=0, so
      // it's moot, but the gate means enabling that bridge later can never open a drain via auto-claim.
      const expOn = !!(opts.experimentalBridgeOn && opts.experimentalBridgeOn());
      if (lossLive || expOn) throw new Error("you have funds locked in another session — tap Recover first, then buy in");
      claimWei = BigInt(proof.eventLocked); // safe: orphaned principal, no withheld loss, no legacy bridge → reclaim the full lock
    }
    const buyInUnits = weiToUsd(claimWei, ethUsdFn());
    if (!(buyInUnits > 0)) throw new Error("buy-in USD value is invalid");

    // ATOMIC COMMIT: bridge.start persists the session AND saveHttp persists the txHash/bearer/open-slot
    // in ONE physical write (batchWrite) — no kill-9 window where a durable session lacks its replay guard (#139).
    return batchWrite(() => {
    const started = bridge.start({ player, chainId, contract, buyInUnits, lockedWei: claimWei.toString(), now: (opts.now && opts.now()) || 0 });
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
    });
    } finally { pendingBuyIns.delete(txKey); } // committed → already in usedBuyIns; failed → freed for retry
    });
  }

  function doPlay(body) {
    const sessionId = String((body && body.sessionId) || "");
    const token = String((body && body.sessionToken) || "");
    if (!token || tokenForSession.get(sessionId) !== token) throw new Error("invalid session token");
    // A server-paced crash round on THIS session has reserved/pinned its nonce; an instant HTTP /play here
    // would burn a fresh nonce + spend an unreserved stake mid-round → refuse until the round resolves (#15).
    if (liveCrashSession(sessionId)) throw new Error("finish your live round before placing another bet");
    // #10: refuse a token bet while this player has a LIVE blackjack hand funded by this same session —
    // the hand's frozen funding pool needs those tokens; a concurrent bet would drain them and desync
    // the hand's debit/credit. (Mirrors the cash-out/recover liveExternal guard.)
    { const _s = bridge.session(sessionId); if (_s && liveExternal(_s.player)) throw new Error("finish your blackjack hand before placing another bet"); }
    if (!rateOk(sessionId)) throw new Error("too many bets too fast — slow down a moment");
    // v11 #5: cap the client seed BEFORE bridge.play — an unbounded seed is HMAC'd synchronously (provablyfair),
    // so a multi-MB seed is a CPU/event-loop DoS per request. A legit seed is well under 256. (Mirrors the WS cr:start cap;
    // bridge.play/reserve also guard as defense-in-depth.)
    if (body.clientSeed != null && String(body.clientSeed).length > 256) throw new Error("client seed is too long");
    // v11 #3: on the direct HTTP path an EXPLICIT sub-1.20x Balloon Pop (pressure) target hits the engine's VOID
    // branch and REFUNDS the stake (net 0) instead of losing — a free "peek"/re-roll (edge-erosion). The round-runner
    // already floors targets to 1.20x so it never hits this; only a hand-crafted direct /play can. An ABSENT target
    // uses the engine's valid DEFAULT_TARGET (≥1.20) and is unaffected — reject only an explicit below-floor target.
    if (body.game === "pressure") { const _co = body.params && body.params.cashOutAt; if (_co != null && Number(_co) < 1.20) throw new Error("hold longer — Balloon Pop banks from 1.20x"); }
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
    const player = address(body && body.player, "player");
    // SERIALIZE per-player so the txHash reservation + the await are atomic — two concurrent top-ups with
    // one chain tx can no longer both credit (#5 TXHASH-TOPUP-RACE, 1000→3000).
    return withPlayerLock(player, async () => {
    const sessionId = String((body && body.sessionId) || "");
    const token = String((body && body.sessionToken) || "");
    if (!token || tokenForSession.get(sessionId) !== token) throw new Error("invalid session token");
    const s = bridge.session(sessionId);
    if (!s || s.closed) throw new Error("no open session to top up");
    if (s.player.toLowerCase() !== player.toLowerCase()) throw new Error("session does not belong to player");
    // #10: don't change the funding pool mid-blackjack-hand — topping up would alter the affordance of a
    // double/split already in progress. Mirror the cash-out/recover liveExternal guard. (Crash too, for symmetry.)
    if (liveExternalDealt(player)) throw new Error("finish your blackjack hand before topping up");
    if (liveCrashSession(sessionId)) throw new Error("finish your live round before topping up");
    const contract = address(s.contract, "contract");
    const chainId = Number(s.chainId);
    const txHash = String((body && body.txHash) || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("top-up transaction hash is invalid");
    const txKey = txHash.toLowerCase();
    if (usedBuyIns.has(txKey) || pendingBuyIns.has(txKey)) throw new Error("top-up transaction was already used");
    pendingBuyIns.add(txKey); // reserve before the await (same TOCTOU guard as doStart)
    try {
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
    // v5 #8: RE-CHECK liveness AFTER the RPC. The pre-await guard (above) can't see a crash round that a WS
    // cr:start reserved (or a BJ hand that started) during the ~verifyBuyIn window — applying the top-up then
    // would change the funding pool mid-round. Throwing here just defers the credit: the txHash isn't marked
    // used (we're before usedBuyIns.add), so the player re-tops-up once the round ends. (recover still covers it.)
    if (liveExternalDealt(player)) throw new Error("finish your blackjack hand before topping up");
    if (liveCrashSession(sessionId)) throw new Error("finish your live round before topping up");
    return batchWrite(() => { // bridge.topUp save + saveHttp commit atomically (one write, no crash split)
    const r = bridge.topUp({ sessionId, addUnits, addLockedWei: addLockedWei.toString() });
    usedBuyIns.add(txKey);
    saveHttp(); // durably record the spent top-up txHash
    return { ok: true, ...r };
    });
    } finally { pendingBuyIns.delete(txKey); }
    });
  }

  function doSettle(body) {
    const player = address(body && body.player, "player");
    const s = bridge.session(body && body.sessionId);
    // #12: verify the wallet signature BEFORE branching on session existence/ownership, and return a
    // UNIFORM error for "no session", "bad signature", and "not your session" — so an attacker can't
    // enumerate sessionIds (which are unguessable random tokens anyway) by error differentiation. The
    // settle message binds to the session's own contract/chainId/id, so we must look the session up to
    // rebuild it, but we never reveal which check failed.
    const bad = () => new Error("settle request could not be verified");
    if (!s) throw bad();
    try { verifyWalletSignature("settle", body, { player, contract: s.contract, chainId: s.chainId, sessionId: s.id }); }
    catch (e) { throw bad(); }
    if (s.player.toLowerCase() !== player.toLowerCase()) throw bad();
    // Serialize per player so a concurrent recover can't interleave with this cash-out (race-minted net=0).
    return withPlayerLock(player, async () => {
      if (liveExternal(player)) throw new Error("finish your blackjack hand before cashing out");
      if (liveCrashSession(s.id)) throw new Error("finish your live round before cashing out"); // #3: don't close the session under a live crash round
      const settlement = await bridge.settle({ sessionId: s.id }); // persists the closed+settled session FIRST (durable obligation record)
      // v5 #3: commit the http-layer state change ATOMICALLY (one coalesced write) so the freed slot and the
      // recorded obligation can NEVER persist apart — openByPlayer.delete without recordObligation would be the
      // loss-escape window. (The async settle above is already durable on its own: if the process dies before
      // THIS commit, persisted openByPlayer still points at the now-closed+settled session → recover branch (1)
      // re-issues the exact settlement, and gcClosed prunes net=0 limbo only, so a loss is never forgiven.)
      return batchWrite(() => {
        openByPlayer.delete(player);
        tokenForSession.delete(s.id);
        playBuckets.delete(s.id);
        // Record the obligation BEFORE freeing the slot: until the chain consumes this lock, a later
        // recover must re-issue THIS settlement (same nonce/net), never a fresh net=0 (loss-escape guard).
        recordObligation(player, s.contract, s.chainId, settlement);
        saveHttp(); // the session is no longer open — persist the freed slot + dropped bearer (txHash stays spent)
        return settlement; // includes netWei, signature, serverSeedReveal (now safe), commit
      });
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
    // #10: anti-replay. When the client supplies an Expiry (current clients always do), the signature is
    // bound to it and must be fresh (signed within a short window) — a captured release signature can't be
    // replayed indefinitely. Backward-compatible: a request with no expiry verifies the legacy message
    // (a captured expiry-bearing signature still can't be downgraded — it wouldn't verify without the line).
    const expiry = body && body.expiry;
    if (expiry != null && expiry !== "") {
      const e = Number(expiry);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(e) || e <= 0) throw new Error("release authorization is invalid");
      if (e < nowSec - 60) throw new Error("release authorization expired — tap Recover again");
      if (e > nowSec + 900) throw new Error("release authorization is not valid yet");
      verifyWalletSignature("release", body, { player, contract, chainId, expiry: String(e) });
    } else {
      verifyWalletSignature("release", body, { player, contract, chainId });
    }
    if (!opts.signer || !opts.signer.sign) throw new Error("signer not configured");
    const key = player.toLowerCase();
    // Serialize per player so the branch decision + obligation record can't interleave (no race-minted net=0).
    return withPlayerLock(player, async () => {
      finalizeStaleCrashForPlayer(player); // self-heal a stale timer-bust orphan so a dead round can't strand Recover FOREVER
      if (liveExternal(player)) throw new Error("finish your blackjack hand before recovering");
      if (liveCrashPlayer(player)) throw new Error("finish your live round before recovering"); // #3
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
        // The slot pointed at an ALREADY-CLOSED session. This is the crash-window case (#209/#215,
        // #140/#145): bridge.settle() ran + persisted the closed session, but the process died before
        // recordObligation()+saveHttp() recorded the obligation — so on restart openByPlayer is still
        // set, the session is closed WITH a real (possibly losing) settlement, and pendingSettle is
        // empty. We must RE-ISSUE that exact bridge settlement, NEVER fall through to a net=0 orphan
        // (which would forgive a withheld loss). bridge.settle is idempotent, so this just re-reads it.
        if (s && s.closed && s.settlement) {
          const settlement = await bridge.settle({ sessionId: sid }); // idempotent → returns the stored settlement
          openByPlayer.delete(player);
          tokenForSession.delete(sid);
          playBuckets.delete(sid);
          recordObligation(player, s.contract || contract, s.chainId || chainId, settlement); // pin the recorded loss/net
          saveHttp();
          return { ok: true, mode: "session", ...settlement };
        }
        // (1b) #13 LIMBO: closed but NO settlement recorded — bridge.settle() set s.closed=true at the top,
        // then `await signer.sign(...)` threw before s.settlement was written (signer outage mid-settle).
        // tokens are frozen, so re-running bridge.settle recomputes the SAME net at the SAME pinned nonce and
        // signs it — recovering the real (possibly LOSING) settlement. We must NOT fall through to the net=0
        // orphan here: that would forgive a loss the signer outage merely delayed (loss-escape). If the signer
        // is still down, bridge.settle throws and we propagate — openByPlayer stays set so the obligation persists.
        if (s && s.closed && !s.settlement) {
          const settlement = await bridge.settle({ sessionId: sid });
          openByPlayer.delete(player);
          tokenForSession.delete(sid);
          playBuckets.delete(sid);
          recordObligation(player, s.contract || contract, s.chainId || chainId, settlement);
          saveHttp();
          return { ok: true, mode: "session", ...settlement };
        }
        // The map pointed at a TRULY vanished session (gc'd, never settled) — clear the stale slot, fall through.
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

      // (2b) DEFENSE IN DEPTH — no pendingSettle obligation on record, but the bridge still holds a
      //      closed+SETTLED session for this player+contract. That is a real recorded settlement (the
      //      crash window where bridge.settle() persisted but pendingSettle+openByPlayer were lost before
      //      saveHttp — #140/#145). Re-issue THAT settlement (recording the obligation), never a net=0
      //      orphan that would forgive a withheld loss — UNLESS its nonce is already consumed on-chain
      //      (then it's truly done → fall through to a fresh net=0 on whatever remains locked).
      {
        const settled = findSettledSessionForPlayer(player, contract);
        if (settled && settled.settlement && settled.settlement.nonce != null) {
          const stOb = { netWei: settled.settlement.netWei, nonce: settled.settlement.nonce, signature: settled.settlement.signature, chainId: settled.chainId || chainId, contract: settled.contract || contract };
          if (!(await obligationConsumed(stOb))) {
            recordObligation(player, stOb.contract, stOb.chainId, stOb);
            saveHttp();
            let lw = "0"; try { lw = (await readBjLocked(stOb.contract, stOb.chainId, player)).toString(); } catch (e) {}
            return { ok: true, mode: "obligation", netWei: String(stOb.netWei), nonce: String(stOb.nonce), signature: stOb.signature, lockedWei: lw };
          }
        }
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
    // v5 #11 (defense-in-depth): the `contract` is caller-supplied, so a clone-contract whose owner is the
    // attacker would pass the on-chain owner check below. That's already incidentally safe — every settlement
    // the house signs binds (chainId, contract), so a clone-owner can only ever obtain a net=0 signature valid
    // on their worthless clone. If the operator pins TOKEN_ALLOWED_CONTRACTS, we reject unknown contracts
    // outright and close even that. OFF by default (empty list) → behavior unchanged.
    if (Array.isArray(opts.allowedContracts) && opts.allowedContracts.length &&
        opts.allowedContracts.indexOf(String(contract).toLowerCase()) < 0)
      throw new Error("unknown house contract");
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
  // v6 #19: validate a fresh Expiry on an owner ADMIN signature (mirrors doRelease's anti-replay) and return the
  // extra sig field so a CAPTURED admin-release/admin-player signature can't be replayed past its short window.
  // Backward-compatible: a request with no expiry verifies the legacy message (a captured expiry-bearing signature
  // still can't be downgraded — it wouldn't verify without the Expiry line).
  function adminExpiryFields(body, label) {
    const x = body && body.expiry;
    if (x == null || x === "") return {};
    const e = Number(x), nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(e) || e <= 0) throw new Error(label + " authorization is invalid");
    if (e < nowSec - 60) throw new Error(label + " authorization expired — retry");
    if (e > nowSec + 900) throw new Error(label + " authorization is not valid yet");
    return { expiry: String(e) };
  }
  function doAdminRelease(body) {
    const owner = address(body && body.owner, "owner");
    const contract = address(body && body.contract, "contract");
    const chainId = Number(body && body.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
    const player = address(body && body.player, "player");
    verifyWalletSignature("admin-release", body, { player: owner, contract, chainId, target: player, ...adminExpiryFields(body, "admin-release") });
    if (!opts.signer || !opts.signer.sign) throw new Error("signer not configured");
    const key = player.toLowerCase();
    return withPlayerLock(player, async () => {
      await requireOwner(owner, contract, chainId);
      finalizeStaleCrashForPlayer(player); // self-heal a stale timer-bust orphan (mirror doRelease) so admin-release can't be stranded either
      // (#210/#216) NEVER force-release while a blackjack hand is in flight against this player's token
      // session — settling mid-hand would lock in a debited stake before the hand resolves. Same guard
      // doSettle/doRelease enforce; admin-release was missing it.
      if (liveExternal(player)) throw new Error("that player has a live blackjack hand — wait for it to finish");
      if (liveCrashPlayer(player)) throw new Error("that player has a live round in progress — wait for it to finish"); // #3
      // (#217) An open-slot pointing at a GENUINELY open session is theirs to cash out — refuse. But a
      // STALE slot (the session is closed/gone) must NOT block recovery: clear it (re-issuing its
      // settlement, never a net=0 orphan) exactly like doRelease branch (1), then proceed.
      const sid = openByPlayer.get(player);
      if (sid) {
        const s = bridge.session(sid);
        if (s && !s.closed) throw new Error("that player has an active session — they cash out themselves");
        if (s && s.closed && s.settlement) {
          const settlement = await bridge.settle({ sessionId: sid }); // idempotent → the recorded loss/net
          openByPlayer.delete(player);
          tokenForSession.delete(sid);
          playBuckets.delete(sid);
          recordObligation(player, s.contract || contract, s.chainId || chainId, settlement);
          saveHttp();
          return { ok: true, player, ...settlement };
        }
        // #13 LIMBO (same as doRelease 1b): closed but settlement not recorded (signer threw mid-settle) →
        // re-run bridge.settle to recover the real loss/net rather than falling through to a net=0 orphan.
        if (s && s.closed && !s.settlement) {
          const settlement = await bridge.settle({ sessionId: sid });
          openByPlayer.delete(player);
          tokenForSession.delete(sid);
          playBuckets.delete(sid);
          recordObligation(player, s.contract || contract, s.chainId || chainId, settlement);
          saveHttp();
          return { ok: true, player, ...settlement };
        }
        openByPlayer.delete(player); saveHttp(); // truly vanished slot — clear and continue
      }
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
      // Defense in depth (mirrors doRelease 2b): a closed+settled bridge session whose obligation was
      // lost in the crash window is still a recorded settlement — re-issue it (recording the obligation),
      // never a net=0 orphan, UNLESS its nonce is already consumed on-chain (then fall through to net=0).
      {
        const settled = findSettledSessionForPlayer(player, contract);
        if (settled && settled.settlement && settled.settlement.nonce != null) {
          const stOb = { netWei: settled.settlement.netWei, nonce: settled.settlement.nonce, signature: settled.settlement.signature, chainId: settled.chainId || chainId, contract: settled.contract || contract };
          if (!(await obligationConsumed(stOb))) {
            recordObligation(player, stOb.contract, stOb.chainId, stOb);
            saveHttp();
            let lw = "0"; try { lw = (await readBjLocked(stOb.contract, stOb.chainId, player)).toString(); } catch (e) {}
            return { ok: true, player, netWei: String(stOb.netWei), nonce: String(stOb.nonce), signature: stOb.signature, lockedWei: lw };
          }
        }
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
    verifyWalletSignature("admin-player", body, { player: owner, contract, chainId, target: player, ...adminExpiryFields(body, "admin-player") });
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

  function status() {
    // v6 #30: /api/token/status is PUBLIC + unauthenticated. Keep the durability booleans (custom/writable/durable)
    // but STRIP the raw absolute state-file `path` — an internal filesystem detail that shouldn't be disclosed.
    let store = (opts.storeInfo ? opts.storeInfo() : null);
    if (store && typeof store === "object") { store = Object.assign({}, store); delete store.path; delete store.file; delete store.dir; }
    return { ok: true, enabled: true, signerAddress: (opts.signerAddress ? opts.signerAddress() : null), ethUsd: (opts.ethUsd ? opts.ethUsd() : null), priceReady: (opts.ethUsdReady ? !!opts.ethUsdReady() : true), store: store, games: bridge.games(), model: "server commit-reveal token bridge (no VRF)" }; }

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

  // OWNER-AUTHENTICATED house-state read (#20). The aggregate exposure is competitively sensitive, so the
  // raw houseState() is no longer exposed unauthenticated. The owner signs ONCE (bound by an Expiry up to an
  // hour out) and the client reuses that payload across panel polls — so this re-verifies the owner
  // signature + on-chain ownership + a fresh expiry window each call, then returns the same aggregate (still
  // NO player PII). Stateless: no server-side view-token store to leak or expire.
  async function doHouseState(body) {
    const owner = address(body && body.owner, "owner");
    const contract = address(body && body.contract, "contract");
    const chainId = Number(body && body.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
    const expiry = Number(body && body.expiry);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(expiry) || expiry <= 0) throw new Error("house-state authorization is invalid");
    if (expiry < nowSec - 60) throw new Error("house-state authorization expired");
    if (expiry > nowSec + 3600) throw new Error("house-state authorization is not valid yet");
    verifyWalletSignature("house-state", body, { player: owner, contract, chainId, expiry: String(expiry) });
    await requireOwner(owner, contract, chainId);
    return houseState();
  }

  // Validate a (sessionId, bearer-token) pair WITHOUT mutating anything — the ws crash
  // round-runner uses this to authorize cr:start over the socket, reusing the exact same
  // per-session bearer the HTTP /play path checks (no second auth scheme). Returns the
  // live bridge session on match, else null. EDIT: this is the single auth gate for ws play.
  function verifySession(sessionId, token) {
    const sid = String(sessionId || "");
    if (!sid || tokenForSession.get(sid) !== String(token || "")) return null;
    // #48: a CLOSED session (settled / recovered) must not authorize a fresh cr:start — mirror tokensOf's
    // !closed filter so the WS crash round-runner can't open a round on a dead session (opaque cr:error).
    const s = bridge.session(sid);
    return (s && !s.closed) ? s : null;
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
  // STRICTER guard for TOP-UP only: a DEALT, in-play blackjack hand (not merely a bet placed in the betting
  // phase). A top-up between hands / during betting is additive — it can't disturb a double/split affordance
  // that doesn't exist yet — so it should credit; only a top-up MID-dealt-hand stays refused. Falls back to
  // liveExternal if the host didn't inject the stricter predicate (so behavior is never LESS strict by accident).
  function liveExternalDealt(player) { try { return opts.hasDealtExternal ? !!opts.hasDealtExternal(player) : liveExternal(player); } catch (e) { return liveExternal(player); } }

  // CRASH-ROUND LIVENESS — late-bound predicate(sessionId)->bool injected by the ws crash round-runner
  // (server.js wires it after both are built). A server-paced crash/plane/swoop/pressure round has PINNED
  // (reserve) its bet nonce + debited its stake; while it is live we must REFUSE settle/recover/release
  // (a settle would close the session out from under the pending resolveReserved → "session is closed"
  // throw in the timer) AND refuse a fresh HTTP /play on the SAME session (would burn a fresh nonce while
  // the round is mid-flight). No-op when no checker is injected (tests / bridge disabled) → behaviour is
  // byte-identical to today, so this can never weaken the loss-escape machinery below.
  let _hasActiveCrashRound = null;
  let _finalizeStaleCrashRound = null;
  function setActiveCrashCheck(fn, finalizeStaleFn) {
    _hasActiveCrashRound = (typeof fn === "function") ? fn : null;
    if (arguments.length > 1) _finalizeStaleCrashRound = (typeof finalizeStaleFn === "function") ? finalizeStaleFn : null;
  }
  function liveCrashSession(sessionId) { try { return !!(_hasActiveCrashRound && _hasActiveCrashRound(String(sessionId || ""))); } catch (e) { return false; } }
  function liveCrashPlayer(player) { const sid = openByPlayer.get(String(player)); return sid ? liveCrashSession(sid) : false; }
  // RECOVER SELF-HEAL: before the liveCrash* guard refuses a settle/recover, retire any RAM crash round
  // for this session that can no longer be genuinely live — i.e. whose bridge session is closed/gone OR
  // whose reserved ledger record is already finalized (b.open === false). A timer-bust that threw
  // (session closed mid-round) leaves the RAM round live with NO retry and NO prune sweep, so hasActive()
  // would block Recover FOREVER. This clears exactly those dead orphans and NEVER a genuinely-live round
  // (the isLive probe below returns true only while the ledger record is still open on an open session),
  // so a lock with no genuinely-live round can ALWAYS be recovered. No-op when no finalizer is injected.
  function finalizeStaleCrashForSession(sessionId) {
    if (!_finalizeStaleCrashRound) return;
    try {
      _finalizeStaleCrashRound(String(sessionId || ""), (round) => {
        try {
          const s = bridge.session(String(sessionId || ""));
          if (!s || s.closed) return false; // session gone/closed → the round can't be live (resolveReserved would throw)
          // genuinely live ⇔ the reserved crashRound record is still OPEN on this (open) session
          const rec = (s.bets || []).find((b) => b && b.kind === "crashRound" && Number(b.nonce) === Number(round.nonce));
          return !!(rec && rec.open);
        } catch (e) { return false; }
      });
    } catch (e) {}
  }
  function finalizeStaleCrashForPlayer(player) { const sid = openByPlayer.get(String(player)); if (sid) finalizeStaleCrashForSession(sid); }

  // SHUTDOWN/CRASH FLUSH (audit #143/#144): force the current HTTP-guard state (usedBuyIns,
  // openByPlayer, bearers, pendingSettle) to disk. Every mutating op already saveHttp()'s synchronously,
  // and the bridge save()'s on every ledger change — so this is a belt-and-suspenders final write the
  // SIGTERM/SIGINT/unhandledRejection handlers call so the very last state survives a deploy/spin-down.
  // Synchronous + swallow-on-fail (we're on the way down; never throw out of a signal handler).
  function flushPersist() { try { saveHttp(); } catch (e) {} }

  return { doStart, doPlay, doTopUp, doSettle, doSession, doRelease, doAdminRelease, doAdminPlayer, doHouseState, status, houseState, verifySession, tokensOf, applyBlackjackNet, liveExternal, setActiveCrashCheck, liveCrashSession, liveCrashPlayer, flushPersist, _bridge: bridge };
}

// Wire the service onto an Express app, behind a flag. Live demo is untouched.
function attachTokenBridge(app, opts) {
  opts = opts || {};
  const enabled = () => !!(opts.enabled && opts.enabled());
  const svc = makeTokenService(opts);
  const guard = (res) => { if (!enabled()) { res.status(503).json({ ok: false, error: "token bridge is not enabled" }); return false; } return true; };
  const fail = (res, e) => res.status(400).json({ ok: false, error: (e && e.message) || "request failed" });

  // #11: per-IP token-bucket on the RPC-heavy endpoints (each awaits a chain call) so a single source
  // can't pin the single-instance event loop with a flood of valid-looking buy-ins/releases. Per-session
  // /play already has its own limiter; this guards the un-sessioned, chain-touching routes. In-memory.
  const IP_RATE = Number(opts.ipRatePerSec) || 5;     // sustained req/sec/IP on RPC-heavy routes
  const IP_BURST = Number(opts.ipBurst) || 15;        // bucket capacity (brief bursts ok)
  const ipBuckets = new Map();
  function clientIp(req) {
    // v5 #7: prefer Express's req.ip — with app.set("trust proxy", 1) it resolves to the entry the trusted
    // Render proxy appended (the REAL client), NOT the spoofable leading X-Forwarded-For token. Fall back to
    // the LAST XFF hop (closest to us = least attacker-influenced), then the raw socket.
    if (req && req.ip) return String(req.ip);
    const xff = req && req.headers && req.headers["x-forwarded-for"];
    if (xff) { const parts = String(xff).split(","); return parts[parts.length - 1].trim(); }
    return (req && req.socket && req.socket.remoteAddress) || "unknown";
  }
  function ipRateOk(req) {
    const ip = clientIp(req);
    const now = Date.now();
    let b = ipBuckets.get(ip);
    if (!b) { b = { tokens: IP_BURST, ts: now }; ipBuckets.set(ip, b); }
    b.tokens = Math.min(IP_BURST, b.tokens + ((now - b.ts) / 1000) * IP_RATE);
    b.ts = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  // occasionally evict idle buckets so the Map can't grow unbounded across many client IPs
  function sweepIpBuckets() { if (ipBuckets.size < 5000) return; const cutoff = Date.now() - 60000; for (const [ip, b] of ipBuckets) if (b.ts < cutoff) ipBuckets.delete(ip); }
  const ipGuard = (req, res) => { sweepIpBuckets(); if (!ipRateOk(req)) { res.status(429).json({ ok: false, error: "too many requests — slow down a moment" }); return false; } return true; };

  app.get("/api/token/status", (req, res) => res.json(enabled() ? svc.status() : {
    ok: true, enabled: false,
    // diagnostics so a stuck setup is self-explaining: which half is missing?
    flagSet: (opts.flag ? !!opts.flag() : (process.env.ENABLE_TOKEN_BRIDGE === "1")),
    signerAddress: (function () { try { return opts.signerAddress ? opts.signerAddress() : null; } catch (e) { return null; } })(),
  }));
  // #20: house-state is now OWNER-AUTHENTICATED (POST, signed) — aggregate exposure is no longer open.
  app.post("/api/token/house-state", async (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(await svc.doHouseState(req.body || {})); } catch (e) { fail(res, e); } });
  // #21: session resume is POST (bearer in the body, never a query string that proxies log / browsers cache).
  app.post("/api/token/session", (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(svc.doSession(req.body || {})); } catch (e) { fail(res, e); } }); // v6 #16: per-IP guard like every other route — an invalid-token flood throws at the bearer check BEFORE the per-session limiter, so without this a single source can flood the event loop
  app.post("/api/token/start", async (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(await svc.doStart(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/play", (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(svc.doPlay(req.body || {})); } catch (e) { fail(res, e); } }); // v6 #16: per-IP guard (doPlay is sync; the sessionId-keyed rateOk runs only AFTER the bearer check, so a bad-token flood bypassed it)
  app.post("/api/token/topup", async (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(await svc.doTopUp(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/settle", async (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(await svc.doSettle(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/release", async (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(await svc.doRelease(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/admin-release", async (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(await svc.doAdminRelease(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/token/admin-player", async (req, res) => { if (!guard(res) || !ipGuard(req, res)) return; try { res.json(await svc.doAdminPlayer(req.body || {})); } catch (e) { fail(res, e); } });
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

    // STRANDED-LOCK AUTO-CLAIM: a buy-in landing on a player with a PRIOR on-chain lock (eventLocked > this
    // buy-in) but NO open session, NO obligation and NO settled loss is the ORPHANED-PRINCIPAL case (a previous
    // buy-in whose doStart failed after the lock). doStart now AUTO-CLAIMS the FULL lock into the new session —
    // reclaiming the stranded funds — instead of rejecting + stranding the new lock too (the compounding trap).
    const svcG = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei, eventLocked: (BigInt(o.buyInWei) * 2n).toString() }) });
    const gw = ethers.Wallet.createRandom(); const gp = gw.address;
    const gBody = { player: gp, contract, chainId, txHash: "0x" + "9".repeat(64), buyInWei: lockedWei.toString() };
    gBody.signature = await gw.signMessage(tokenAuthMessage("start", { player: gp, contract, chainId, buyInWei: lockedWei.toString() }));
    const gStarted = await svcG.doStart(gBody); // no loss on record → reclaim the orphaned lock
    eq("stranded auto-claim: a buy-in over an orphaned lock opens a session for the FULL lock (2× = $2000)", gStarted.tokens === 2000);

    // DEFENSE-IN-DEPTH: with the legacy on-chain blackjack bridge ON, a prior lock could be a live on-chain hand,
    // so auto-claim is DISABLED and the stacked buy-in is rejected (the player must Recover) — no drain.
    const svcGx = makeTokenService({ signer, ethUsd: () => 4000, experimentalBridgeOn: () => true, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei, eventLocked: (BigInt(o.buyInWei) * 2n).toString() }) });
    const gx = ethers.Wallet.createRandom(); const gxp = gx.address;
    const gxBody = { player: gxp, contract, chainId, txHash: "0x" + "a".repeat(64), buyInWei: lockedWei.toString() };
    gxBody.signature = await gx.signMessage(tokenAuthMessage("start", { player: gxp, contract, chainId, buyInWei: lockedWei.toString() }));
    let drainGuard = 0; try { await svcGx.doStart(gxBody); } catch (e) { drainGuard = 1; }
    eq("cross-session guard: rejects a stacked buy-in when the legacy bridge is on (no auto-claim)", drainGuard === 1);

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

    // ── CRASH-WINDOW LOSS-ESCAPE (#209/#215 + #140/#145) ──────────────────────────────────────────
    // The exact reproduction: bridge.settle() ran + persisted the CLOSED, LOSING session, but the
    // process died BEFORE recordObligation()+saveHttp() — so on the next process there's a closed+settled
    // bridge session, openByPlayer STILL points at it (stale, from the last good saveHttp), and
    // pendingSettle is EMPTY. doRelease must re-issue THAT recorded loss (mode:"session"), NEVER fall
    // through to a net=0 orphan that would forgive the loss.
    const cwSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readNonceUsed: async () => false });
    const cww = ethers.Wallet.createRandom(); const cwp = cww.address;
    const cwStart = { player: cwp, contract, chainId, txHash: "0x" + "cd".repeat(32), buyInWei: lockedWei.toString() };
    cwStart.signature = await cww.signMessage(tokenAuthMessage("start", { player: cwp, contract, chainId, buyInWei: lockedWei.toString() }));
    const cwStarted = await cwSvc.doStart(cwStart);
    cwSvc._bridge.session(cwStarted.sessionId).tokens = 700; // a $300 loss
    // Settle DIRECTLY on the bridge (simulating the crash: bridge persisted the loss, HTTP layer didn't).
    const cwBridgeStl = await cwSvc._bridge.settle({ sessionId: cwStarted.sessionId });
    const cwRel = await cwSvc.doRelease({ player: cwp, contract, chainId, signature: await cww.signMessage(tokenAuthMessage("release", { player: cwp, contract, chainId })) });
    eq("crash-window: closed+settled session re-issues the recorded LOSS (never net=0 orphan)",
       BigInt(cwBridgeStl.netWei) < 0n && cwRel.mode === "session" && cwRel.netWei === cwBridgeStl.netWei && cwRel.nonce === cwBridgeStl.nonce);
    // and a repeat call still re-issues the SAME losing settlement (now via the recorded obligation), no net=0
    const cwRel2 = await cwSvc.doRelease({ player: cwp, contract, chainId, signature: await cww.signMessage(tokenAuthMessage("release", { player: cwp, contract, chainId })) });
    eq("crash-window: a repeat recover still re-issues the SAME loss (no fresh net=0)",
       cwRel2.netWei === cwRel.netWei && cwRel2.nonce === cwRel.nonce && BigInt(cwRel2.netWei) < 0n);

    // CRASH-WINDOW where the http open-slot was ALSO lost (only the bridge settlement survives) — exercises
    // branch (2b): with NO openByPlayer and NO pendingSettle, doRelease must SCAN the bridge, find the
    // closed+settled losing session, and re-issue THAT settlement (mode:"obligation"), never a net=0 orphan.
    // We model "only the bridge survived a redeploy" by sharing ONE persist store: settle on a first
    // service (whose bridge sessions persist) then construct a SECOND service from the same store but
    // strip the http blob (openByPlayer/pendingSettle) the crash never wrote.
    const cwStore = { _state: null, load() { return this._state; }, save(s) { this._state = JSON.parse(JSON.stringify(s)); } };
    const cwA = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readNonceUsed: async () => false, persist: cwStore });
    const cw2w = ethers.Wallet.createRandom(); const cw2p = cw2w.address;
    const cw2Start = { player: cw2p, contract, chainId, txHash: "0x" + "ce".repeat(32), buyInWei: lockedWei.toString() };
    cw2Start.signature = await cw2w.signMessage(tokenAuthMessage("start", { player: cw2p, contract, chainId, buyInWei: lockedWei.toString() }));
    const cw2Started = await cwA.doStart(cw2Start);
    cwA._bridge.session(cw2Started.sessionId).tokens = 650; // a $350 loss
    const cw2BridgeStl = await cwA._bridge.settle({ sessionId: cw2Started.sessionId }); // bridge persists the closed loss
    if (cwStore._state) cwStore._state.http = null; // simulate the crash: the http blob (open-slot + obligation) was never written
    const cwB = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readNonceUsed: async () => false, persist: cwStore });
    const cw2Rel = await cwB.doRelease({ player: cw2p, contract, chainId, signature: await cw2w.signMessage(tokenAuthMessage("release", { player: cw2p, contract, chainId })) });
    eq("crash-window (open-slot+obligation lost): bridge-scan re-issues the recorded loss, never net=0",
       BigInt(cw2BridgeStl.netWei) < 0n && cw2Rel.mode === "obligation" && cw2Rel.netWei === cw2BridgeStl.netWei && cw2Rel.nonce === cw2BridgeStl.nonce);

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

    // (#210/#216) admin-release must REFUSE while the target has a LIVE blackjack hand (else it force-settles
    // a debited stake mid-hand). Target has no open token session (openByPlayer empty) but hasLiveExternal=true.
    let _admLive = true;
    const admLiveSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readOwner: async () => ({ owner: ownerW.address, treasury: ownerW.address }), hasLiveExternal: () => _admLive });
    const admLiveTgt = ethers.Wallet.createRandom().address;
    let admLiveBlocked = 0;
    try { await admLiveSvc.doAdminRelease({ owner: ownerW.address, contract, chainId, player: admLiveTgt, signature: await ownerW.signMessage(tokenAuthMessage("admin-release", { player: ownerW.address, contract, chainId, target: admLiveTgt })) }); }
    catch (e) { if (/live blackjack hand/.test(e.message)) admLiveBlocked = 1; }
    eq("admin-release: refuses a player with a LIVE blackjack hand", admLiveBlocked === 1);

    // (#217) a STALE open-slot (closed+settled session) must NOT permanently block admin-release: it re-issues
    // the recorded settlement (here a LOSS) rather than throwing "active session" or minting a net=0 orphan.
    const admStaleStore = { _state: null, load() { return this._state; }, save(s) { this._state = JSON.parse(JSON.stringify(s)); } };
    const admStaleA = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readNonceUsed: async () => false, readOwner: async () => ({ owner: ownerW.address, treasury: ownerW.address }), persist: admStaleStore });
    const asw = ethers.Wallet.createRandom(); const asp = asw.address;
    const asStart = { player: asp, contract, chainId, txHash: "0x" + "ef".repeat(32), buyInWei: lockedWei.toString() };
    asStart.signature = await asw.signMessage(tokenAuthMessage("start", { player: asp, contract, chainId, buyInWei: lockedWei.toString() }));
    const asStarted = await admStaleA.doStart(asStart);
    admStaleA._bridge.session(asStarted.sessionId).tokens = 700; // a $300 loss
    const asBridgeStl = await admStaleA._bridge.settle({ sessionId: asStarted.sessionId }); // crash: bridge persisted, http didn't update
    const admStaleB = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), readBjLocked: async () => lockedWei, readNonceUsed: async () => false, readOwner: async () => ({ owner: ownerW.address, treasury: ownerW.address }), persist: admStaleStore });
    const admStaleRel = await admStaleB.doAdminRelease({ owner: ownerW.address, contract, chainId, player: asp, signature: await ownerW.signMessage(tokenAuthMessage("admin-release", { player: ownerW.address, contract, chainId, target: asp })) });
    eq("admin-release: stale closed-session re-issues the recorded LOSS (no orphan net=0)",
       BigInt(asBridgeStl.netWei) < 0n && admStaleRel.netWei === asBridgeStl.netWei && admStaleRel.nonce === asBridgeStl.nonce);

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

    // ── GHOST openByPlayer SLOT (the live "every buy-in locks the funds / $X stuck in a past session" trap) ──
    // A prior session that was GC-pruned / closed but whose openByPlayer entry was never swept must NOT block a
    // new buy-in forever (that stranded every on-chain lock). doStart now sweeps a dead slot; a GENUINELY-OPEN one
    // still blocks; and a WITHHELD LOSS still forces Recover (the sweep is not a loss-escape).
    // (1) a VANISHED session (GC-pruned) no longer strands the next buy-in:
    const ghSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }) });
    const ghW = ethers.Wallet.createRandom(); const ghP = ghW.address; const ghSg = (i, o) => ghW.signMessage(tokenAuthMessage(i, o));
    const ghB1 = { player: ghP, contract, chainId, txHash: "0x" + "a1".repeat(32), buyInWei: lockedWei.toString() };
    ghB1.signature = await ghSg("start", { player: ghP, contract, chainId, buyInWei: lockedWei.toString() });
    const ghStarted = await ghSvc.doStart(ghB1);
    ghSvc._bridge._sessions.delete(ghStarted.sessionId); // GC-prune / vanished session WITHOUT clearing openByPlayer → GHOST
    let ghostStranded = 0, ghB2res = null;
    const ghB2 = { player: ghP, contract, chainId, txHash: "0x" + "a2".repeat(32), buyInWei: lockedWei.toString() };
    ghB2.signature = await ghSg("start", { player: ghP, contract, chainId, buyInWei: lockedWei.toString() });
    try { ghB2res = await ghSvc.doStart(ghB2); } catch (e) { ghostStranded = 1; }
    eq("GHOST slot no longer strands a buy-in (fixes: every buy-in locks the funds)", ghostStranded === 0 && !!ghB2res && ghB2res.tokens === 1000);
    // (2) MONEY-SAFETY: a CLOSED session with a WITHHELD LOSS (+ a prior on-chain lock) must STILL force Recover:
    const lsSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei, eventLocked: (2n * lockedWei).toString() }), readBjLocked: async () => 2n * lockedWei, readNonceUsed: async () => false });
    const lsW = ethers.Wallet.createRandom(); const lsP = lsW.address; const lsSg = (i, o) => lsW.signMessage(tokenAuthMessage(i, o));
    const lsB1 = { player: lsP, contract, chainId, txHash: "0x" + "b1".repeat(32), buyInWei: lockedWei.toString() };
    lsB1.signature = await lsSg("start", { player: lsP, contract, chainId, buyInWei: lockedWei.toString() });
    const lsStarted = await lsSvc.doStart(lsB1);
    lsSvc._bridge.session(lsStarted.sessionId).tokens = 500;                // a $500 loss
    await lsSvc._bridge.settle({ sessionId: lsStarted.sessionId });         // close + record the losing settlement (openByPlayer still points at it → ghost)
    let lossForced = 0;
    const lsB2 = { player: lsP, contract, chainId, txHash: "0x" + "b2".repeat(32), buyInWei: lockedWei.toString() };
    lsB2.signature = await lsSg("start", { player: lsP, contract, chainId, buyInWei: lockedWei.toString() });
    try { await lsSvc.doStart(lsB2); } catch (e) { if (/Recover|locked in another session/i.test(e.message)) lossForced = 1; }
    eq("ghost-sweep is loss-safe: a withheld loss still forces Recover (never auto-claims over it)", lossForced === 1);
    // (3) a GENUINELY-OPEN session still blocks a second buy-in (single-session rule intact):
    const oaSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }) });
    const oaW = ethers.Wallet.createRandom(); const oaP = oaW.address; const oaSg = (i, o) => oaW.signMessage(tokenAuthMessage(i, o));
    const oaB1 = { player: oaP, contract, chainId, txHash: "0x" + "c1".repeat(32), buyInWei: lockedWei.toString() };
    oaB1.signature = await oaSg("start", { player: oaP, contract, chainId, buyInWei: lockedWei.toString() });
    await oaSvc.doStart(oaB1);
    let openBlocks = 0;
    const oaB2 = { player: oaP, contract, chainId, txHash: "0x" + "c2".repeat(32), buyInWei: lockedWei.toString() };
    oaB2.signature = await oaSg("start", { player: oaP, contract, chainId, buyInWei: lockedWei.toString() });
    try { await oaSvc.doStart(oaB2); } catch (e) { if (/finish your open/i.test(e.message)) openBlocks = 1; }
    eq("a genuinely-open session still blocks a second buy-in (single-session rule intact)", openBlocks === 1);

    // (4) v12.94 STALE-ZOMBIE RECLAIM: a prior buy-in confirmed ON-CHAIN but its /start response was lost, so the
    // server holds an OPEN session the CLIENT never got a bearer for (active()===false client-side, UI shows only
    // "Recover", $0 balance). The next buy-in STACKS the on-chain lock (eventLocked > the open session's lock). The
    // OLD code threw "finish your open session" forever here and never reached the auto-claim = a PERMANENT strand
    // ("every buy-in locks the funds"). Now doStart settles the stale zombie in place and the loss-safe auto-claim runs.
    // (4a) BREAK-EVEN zombie (no plays): buy#1 opens session A; the client loses its bearer. buy#2 stacks the lock.
    let zLocked = lockedWei; // the on-chain accumulator: each blackjackBuyIn ADDS to bjLocked
    const zSvc = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei, eventLocked: zLocked.toString() }), readBjLocked: async () => zLocked });
    const zW = ethers.Wallet.createRandom(); const zP = zW.address; const zSg = (i, o) => zW.signMessage(tokenAuthMessage(i, o));
    const zB1 = { player: zP, contract, chainId, txHash: "0x" + "41".repeat(32), buyInWei: lockedWei.toString() };
    zB1.signature = await zSg("start", { player: zP, contract, chainId, buyInWei: lockedWei.toString() });
    const zStarted = await zSvc.doStart(zB1); // opens session A (client then "loses" this bearer)
    zLocked = lockedWei * 2n; // the player re-locks on-chain to try again → bjLocked stacks
    const zB2 = { player: zP, contract, chainId, txHash: "0x" + "42".repeat(32), buyInWei: lockedWei.toString() };
    zB2.signature = await zSg("start", { player: zP, contract, chainId, buyInWei: lockedWei.toString() });
    let zForced = 0; try { await zSvc.doStart(zB2); } catch (e) { if (/Recover|locked in another session/i.test(e.message)) zForced = 1; }
    eq("v12.94: a stacked buy-in over a bearer-less zombie settles it + forces Recover (no permanent strand)", zForced === 1);
    // the stale open session A is now CLOSED (freed) — the strand is gone, not thrown-forever
    eq("v12.94: the bearer-less zombie session is settled/closed (slot freed)", zSvc._bridge.session(zStarted.sessionId).closed === true);
    // and Recover returns the FULL stacked lock back
    const zRelBody = { player: zP, contract, chainId, expiry: Math.floor(Date.now() / 1000) + 300 };
    zRelBody.signature = await zSg("release", { player: zP, contract, chainId, expiry: String(zRelBody.expiry) });
    const zRel = await zSvc.doRelease(zRelBody);
    eq("v12.94: Recover returns the full stacked on-chain lock (2x)", BigInt(zRel.lockedWei) === lockedWei * 2n);
    // after the on-chain settle consumes the lock, a fresh buy-in works again (recovery is not one-shot-broken)
    zLocked = lockedWei; // settleBlackjack zeroed bjLocked, then a NEW lock for the next buy-in
    const zB3 = { player: zP, contract, chainId, txHash: "0x" + "43".repeat(32), buyInWei: lockedWei.toString() };
    zB3.signature = await zSg("start", { player: zP, contract, chainId, buyInWei: lockedWei.toString() });
    let zAgainOk = false; try { const r = await zSvc.doStart(zB3); zAgainOk = r.tokens === 1000; } catch (e) {}
    eq("v12.94: after Recover + on-chain consume, a fresh buy-in opens a normal session", zAgainOk === true);
    // (4b) LOSING zombie: the stale session lost money → settling it in place must PRESERVE the loss (never net=0).
    let zL2 = lockedWei;
    const zSvc2 = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei, eventLocked: zL2.toString() }), readBjLocked: async () => zL2 });
    const zW2 = ethers.Wallet.createRandom(); const zP2 = zW2.address; const zSg2 = (i, o) => zW2.signMessage(tokenAuthMessage(i, o));
    const zLB1 = { player: zP2, contract, chainId, txHash: "0x" + "44".repeat(32), buyInWei: lockedWei.toString() };
    zLB1.signature = await zSg2("start", { player: zP2, contract, chainId, buyInWei: lockedWei.toString() });
    const zLStarted = await zSvc2.doStart(zLB1);
    zSvc2._bridge.session(zLStarted.sessionId).tokens = 500; // DETERMINISTIC $500 loss (don't rely on random coinflip outcomes)
    const zLbal = zSvc2._bridge.session(zLStarted.sessionId).tokens;
    zL2 = lockedWei * 2n; // re-lock stacks
    const zLB2 = { player: zP2, contract, chainId, txHash: "0x" + "45".repeat(32), buyInWei: lockedWei.toString() };
    zLB2.signature = await zSg2("start", { player: zP2, contract, chainId, buyInWei: lockedWei.toString() });
    let zLForced = 0; try { await zSvc2.doStart(zLB2); } catch (e) { if (/Recover|locked in another session/i.test(e.message)) zLForced = 1; }
    eq("v12.94: a LOSING zombie forces Recover (never auto-claims over the loss)", zLForced === 1 && zLbal < 1000);
    const zLrel = { player: zP2, contract, chainId, expiry: Math.floor(Date.now() / 1000) + 300 };
    zLrel.signature = await zSg2("release", { player: zP2, contract, chainId, expiry: String(zLrel.expiry) });
    const zLR = await zSvc2.doRelease(zLrel);
    eq("v12.94: Recover re-issues the stale zombie's LOSING settlement (netWei < 0, loss preserved)", BigInt(zLR.netWei) < 0n);
    // (4c) LIVE guard: an OPEN session with a live crash round must STILL block (never settle under live play).
    let zL3 = lockedWei;
    const liveMap = new Set();
    const zSvc3 = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei, eventLocked: zL3.toString() }), readBjLocked: async () => zL3 });
    zSvc3.setActiveCrashCheck((sid) => liveMap.has(sid));
    const zW3 = ethers.Wallet.createRandom(); const zP3 = zW3.address; const zSg3 = (i, o) => zW3.signMessage(tokenAuthMessage(i, o));
    const zLV1 = { player: zP3, contract, chainId, txHash: "0x" + "46".repeat(32), buyInWei: lockedWei.toString() };
    zLV1.signature = await zSg3("start", { player: zP3, contract, chainId, buyInWei: lockedWei.toString() });
    const zLVs = await zSvc3.doStart(zLV1);
    liveMap.add(zLVs.sessionId); // a server-paced round is mid-flight on this session
    zL3 = lockedWei * 2n;
    const zLV2 = { player: zP3, contract, chainId, txHash: "0x" + "47".repeat(32), buyInWei: lockedWei.toString() };
    zLV2.signature = await zSg3("start", { player: zP3, contract, chainId, buyInWei: lockedWei.toString() });
    let zLiveBlocked = 0; try { await zSvc3.doStart(zLV2); } catch (e) { if (/live round|finish your/i.test(e.message)) zLiveBlocked = 1; }
    eq("v12.94: a stacked buy-in during a LIVE crash round is refused (never settles under live play)", zLiveBlocked === 1);
    eq("v12.94: the live session is NOT closed by the refused buy-in", zSvc3._bridge.session(zLVs.sessionId).closed === false);

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
