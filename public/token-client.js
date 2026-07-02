/* ============================================================
   token-client.js — browser client for the server-side TOKEN bridge.

   Turns "one MetaMask popup per bet" into: ONE buy-in (lock ETH) → play every game
   instantly off-chain (no popups) → ONE cash-out. Talks to /api/token/* and signs
   the buy-in / cash-out authorizations with the player's wallet. NO Chainlink VRF —
   the server commits a seed before each session and reveals it at cash-out so every
   bet is verifiable.

   window.TokenBridgeClient  /  module.exports (for the auth-parity self-test)
   ============================================================ */
(function (root) {
  "use strict";

  // The EXACT message the server (server/token-http.js :: tokenAuthMessage) verifies.
  // Kept byte-identical here so wallet auth never silently mismatches. `getAddress`
  // is ethers.getAddress (checksums the addresses just like the server).
  function tokenAuthMessage(intent, o, getAddress) {
    const lines = [
      "Crypto TV Token Bridge",
      "Action: " + String(intent || ""),
      "Player: " + getAddress(o.player),
      "Contract: " + getAddress(o.contract),
      "Chain ID: " + Number(o.chainId),
    ];
    if (intent === "start") lines.push("Buy-in wei: " + String(o.buyInWei || "0"));
    else if (intent === "settle") lines.push("Session: " + String(o.sessionId || ""));
    else if (intent === "topup") { lines.push("Session: " + String(o.sessionId || "")); lines.push("Buy-in wei: " + String(o.buyInWei || "0")); }
    else if (intent === "release") { if (o.expiry != null && o.expiry !== "") lines.push("Expiry: " + String(o.expiry)); } // #10 anti-replay
    else if (intent === "admin-release" || intent === "admin-player") { lines.push("Target: " + getAddress(o.target)); if (o.expiry != null && o.expiry !== "") lines.push("Expiry: " + String(o.expiry)); } // v6 #19 anti-replay (byte-mirror of server)
    else if (intent === "house-state") lines.push("Expiry: " + String(o.expiry || "0")); // #20 owner-authed house-state
    return lines.join("\n");
  }

  // W2: a stuck/dropped on-chain tx must never leave the token bar frozen forever. tx.wait() with no
  // timeout can hang indefinitely (mempool drop, wallet never broadcasts) → the caller's `busy` flag
  // latches → every token button reads "…" until reload. Bound EVERY wait at 180s; on timeout the caller's
  // catch fires (surfaces Recover) without clearing session state. ethers v6: wait(confirms, timeoutMs)
  // rejects on timeout; some replaced-tx paths resolve null → treat that as a timeout too.
  async function waitTx(tx) {
    const r = await tx.wait(1, 180000);
    if (!r) throw new Error("tx-wait-timeout");
    return r;
  }

  // deps: { ethers, signer, contract, account, chainId, contractAddr, fetch?, apiBase? }
  //   signer   = ethers wallet signer (signMessage + the tx sender)
  //   contract = ethers Contract bound to the signer (blackjackBuyIn / settleBlackjack)
  function TokenBridgeClient(deps) {
    this.d = deps || {};
    this.session = null;   // { sessionId, sessionToken, commit, tokens, buyInUnits }
    this.tokens = 0;
  }

  TokenBridgeClient.prototype._post = async function (path, body, timeoutMs) {
    const f = this.d.fetch || root.fetch.bind(root);
    const opts = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) };
    // A hung request must NOT freeze the game forever (a per-shot bet that never resolves
    // leaves the balance stuck). Bound every call with a timeout so the caller's catch fires.
    // A per-call override (timeoutMs) lets a multi-RPC endpoint like /start (buy-in verification does
    // getNetwork + getTransactionReceipt + a live bjLocked read, each server-bounded ~12s) use a longer
    // bound so a healthy verification never aborts mid-flight ("fetch aborted") and re-locks funds.
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs || 12000); } catch (e) {}
    const res = await f((this.d.apiBase || "") + path, opts);
    const j = await res.json().catch(() => ({}));
    // Surface the HTTP status in the message so a server 500 / HTML error page is diagnosable
    // (was a bare "request failed").
    if (!res.ok || j.ok === false) throw new Error(j.error || ("request failed: " + path + " (" + res.status + ")"));
    return j;
  };
  TokenBridgeClient.prototype.status = async function () {
    const f = this.d.fetch || root.fetch.bind(root);
    const opts = {};
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(10000); } catch (e) {}
    return (await f((this.d.apiBase || "") + "/api/token/status", opts)).json();
  };

  // PRE-FLIGHT before ANY on-chain lock (buy-in / top-up). The stranding bug: the lock fires before
  // the server credits, so if the server then rejects the credit the funds are locked with nothing
  // backing them. This checks the rejection conditions BEFORE locking: price must be synced, and (for
  // a top-up) the session must still be alive on the server. If the check can't be confirmed, we
  // ABORT rather than risk a lock the server would refuse.
  TokenBridgeClient.prototype._preflight = async function (needSession) {
    // W10: fire status() and the session-liveness check CONCURRENTLY (top-up path) instead of serially —
    // halves preflight latency before the on-chain lock. Error precedence is preserved: a dead server
    // reports "can't reach the server" FIRST (never masquerades as "invalid session").
    const stP = this.status().then((s) => ({ s: s })).catch(() => ({ err: true }));
    const aliveP = needSession ? this._sessionAlive() : Promise.resolve(true);
    const st = await stP;
    if (st.err) return { ok: false, error: "Can't reach the server right now — try again in a moment." };
    if (st.s && st.s.enabled && st.s.priceReady === false) return { ok: false, error: "Price is still syncing — try again in a few seconds." };
    if (needSession && !(await aliveP)) return { ok: false, error: "invalid session token" };
    return { ok: true };
  };
  TokenBridgeClient.prototype._sessionAlive = async function () {
    if (!this.session) return false;
    const f = this.d.fetch || root.fetch.bind(root);
    const opts = {};
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(10000); } catch (e) {}
    try {
      // #21: POST the bearer in the body (never a query string proxies log / browsers cache).
      const res = await f((this.d.apiBase || "") + "/api/token/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: this.session.sessionId, sessionToken: this.session.sessionToken }), signal: opts.signal });
      const j = await res.json().catch(() => null);
      return !!(j && j.ok);
    } catch (e) { return false; }
  };

  // RESUME: after a page refresh the in-memory session is gone, but the SERVER may still have it.
  // Verify a saved (sessionId, bearer) and reconnect to it (returns true) instead of orphaning the
  // funded session. Returns false if the server no longer has it (caller clears the stale local copy).
  TokenBridgeClient.prototype.resume = async function (saved) {
    if (!saved || !saved.sessionId || !saved.sessionToken) return false;
    const f = this.d.fetch || root.fetch.bind(root);
    const opts = {};
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(10000); } catch (e) {}
    let j = null;
    try {
      // #21: POST the bearer in the body, not a query string.
      const res = await f((this.d.apiBase || "") + "/api/token/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: saved.sessionId, sessionToken: saved.sessionToken }), signal: opts.signal });
      j = await res.json().catch(() => null);
    } catch (e) { return false; } // #19: couldn't reach the server → TRANSIENT, keep the session (don't wipe a live one on a blip)
    if (j && j.ok) {
      this.session = { sessionId: saved.sessionId, sessionToken: saved.sessionToken, commit: j.commit, tokens: j.tokens, buyInUnits: j.buyInUnits };
      this.tokens = j.tokens;
      return true;
    }
    // #19: the server RESPONDED that the session is not ok → it's genuinely gone (settled / unknown).
    // Distinguish this from a transient failure so the caller clears only on a confirmed-gone, never on a blip.
    if (j && j.ok === false) return "gone";
    return false; // unparseable response → treat as transient
  };

  // BUY IN: lock `amountWei` on-chain (ONE popup) → open a server token session.
  TokenBridgeClient.prototype.buyIn = async function (amountWei) {
    const d = this.d;
    const player = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    const buyInWei = (typeof amountWei === "bigint" ? amountWei : BigInt(amountWei)).toString();
    // PRE-FLIGHT: price ready. A PRIOR on-chain lock NO LONGER blocks the buy-in — the server now AUTO-CLAIMS a
    // stranded lock (orphaned principal, no withheld loss) into this session, so a buy-in over your own stranded
    // funds just reclaims them instead of stranding the new lock on top (the $710→$1420 compounding trap). If a
    // withheld LOSS is on record the server still rejects with "tap Recover first" and the Recover button shows.
    const pre = await this._preflight(false);
    if (!pre.ok) throw new Error(pre.error);
    // 1) player authorizes the buy-in (off-chain signature — no gas)
    const signature = await d.signer.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei }, d.ethers.getAddress));
    // 2) lock the funds on-chain (the ONE popup) and wait for it to confirm
    const tx = await d.contract.blackjackBuyIn(buyInWei, { gasLimit: 200000n });
    const receipt = await waitTx(tx);
    // 3) hand the server the confirmed txHash + the signature → it verifies + grants tokens
    const r = await this._post("/api/token/start", { player, contract, chainId, txHash: receipt.hash, buyInWei, signature }, 45000); // 45s: /start does multiple sequential on-chain reads — must not abort mid-verify (was 12s → "fetch aborted" → re-lock)
    this.session = r; this.tokens = r.tokens;
    return r;
  };

  // PLAY: one instant off-chain bet (no popup). `game` is a token-enabled key.
  TokenBridgeClient.prototype.play = async function (game, betUnits, params, clientSeed) {
    if (!this.session) throw new Error("buy in first");
    var seq = (this._playSeq = (this._playSeq || 0) + 1); // issue order
    const r = await this._post("/api/token/play", {
      sessionId: this.session.sessionId, sessionToken: this.session.sessionToken,
      game: game, betUnits: betUnits, params: params || {}, clientSeed: clientSeed || "",
    });
    // #13: only the LATEST-issued play may update the cached balance. The server settles bets in nonce
    // order, so a higher seq's r.tokens is always the most recent truth; a slow earlier response arriving
    // after a newer one must NOT roll the displayed tokens backward (rapid fish/reef fire).
    if (seq > (this._playSeqApplied || 0)) { this._playSeqApplied = seq; this.tokens = r.tokens; }
    return r; // { win, multiplier, payoutUnits, outcome, detail, tokens }
  };

  // TOP UP: lock MORE into the OPEN session (ONE popup) without cashing out. blackjackBuyIn
  // ACCUMULATES bjLocked, so the server just adds the new value to the live session's tokens.
  TokenBridgeClient.prototype.topUp = async function (amountWei) {
    if (!this.session) throw new Error("no open session");
    // PRE-FLIGHT (prevents fund-stranding): confirm the session is ALIVE on the server + price ready
    // BEFORE locking on-chain — a top-up into a dead session locks funds the server then refuses.
    const pre = await this._preflight(true);
    if (!pre.ok) throw new Error(pre.error);
    const d = this.d, player = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    const sessionId = this.session.sessionId;
    const addWei = (typeof amountWei === "bigint" ? amountWei : BigInt(amountWei)).toString();
    const signature = await d.signer.signMessage(tokenAuthMessage("topup", { player, contract, chainId, sessionId, buyInWei: addWei }, d.ethers.getAddress));
    const tx = await d.contract.blackjackBuyIn(addWei, { gasLimit: 200000n });
    const receipt = await waitTx(tx);
    const r = await this._post("/api/token/topup", { player, sessionId, sessionToken: this.session.sessionToken, txHash: receipt.hash, buyInWei: addWei, signature }, 45000); // 45s: /topup does the same multiple sequential on-chain reads as /start — must not abort mid-verify (was 12s → "add more tokens" hung and never registered)
    this.tokens = r.tokens; this._playSeqApplied = (this._playSeq || 0); // v13 #3: a top-up establishes a NEWER authoritative balance — advance the play-seq watermark so a slow in-flight play() (issued before this top-up) can't roll the displayed tokens backward. A play issued AFTER gets a higher seq and still applies.
    if (this.session) this.session.tokens = r.tokens;
    return r;
  };

  // CASH OUT: server signs the net → submit settleBlackjack on-chain (ONE popup).
  TokenBridgeClient.prototype.cashOut = async function () {
    if (!this.session) throw new Error("no open session");
    const d = this.d, player = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    const sessionId = this.session.sessionId;
    const signature = await d.signer.signMessage(tokenAuthMessage("settle", { player, contract, chainId, sessionId }, d.ethers.getAddress));
    const s = await this._post("/api/token/settle", { player, sessionId, signature });
    // s = { netWei, nonce, signature (house), serverSeedReveal, commit, ... }
    const tx = await d.contract.settleBlackjack(player, BigInt(s.netWei), BigInt(s.nonce), s.signature, { gasLimit: 200000n });
    const receipt = await waitTx(tx);
    const settled = { ...s, claimTx: receipt.hash };
    this.session = null; this.tokens = 0;
    return settled;
  };

  // RECOVER everything locked on-chain. The server returns EITHER a net=0 orphan settlement OR — if it
  // still holds a live session for this wallet — a full cash-out of that session (mode:"session"). Both
  // arrive as { netWei, nonce, signature }; we submit settleBlackjack, which zeros the whole bjLocked
  // and returns (locked + net). So this always recovers the full on-chain lock, even when the local
  // session view has desynced from the server's. Clears any local session afterward.
  TokenBridgeClient.prototype.releaseStuck = async function () {
    const d = this.d, player = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    // #10: bind the release to a short Expiry so a captured signature can't be replayed indefinitely.
    const expiry = Math.floor(Date.now() / 1000) + 300; // 5-min window; the server enforces freshness
    const signature = await d.signer.signMessage(tokenAuthMessage("release", { player, contract, chainId, expiry }, d.ethers.getAddress));
    const r = await this._post("/api/token/release", { player, contract, chainId, expiry, signature }, 45000); // W3: /release does 2-4 sequential on-chain reads server-side — 45s so a slow-RPC Recover doesn't abort at 12s (v12.98 "fetch aborted" class)
    const tx = await d.contract.settleBlackjack(player, BigInt(r.netWei), BigInt(r.nonce), r.signature, { gasLimit: 200000n });
    const receipt = await waitTx(tx);
    this.session = null; this.tokens = 0; // the server settled/freed it — drop any stale local session
    return { ...r, claimTx: receipt.hash };
  };

  // HOUSE TOOL — the owner releases a STRANDED player's locked funds back to THAT player. The owner
  // signs (the server checks they're the on-chain owner/treasury); the server signs a net=0 settle for
  // the player; the owner submits it (pays gas; funds go to the player, never the owner).
  TokenBridgeClient.prototype.adminRelease = async function (targetPlayer) {
    const d = this.d, owner = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    const player = d.ethers.getAddress(targetPlayer);
    const expiry = Math.floor(Date.now() / 1000) + 600; // v6 #19: 10-min anti-replay window on the owner admin signature
    const signature = await d.signer.signMessage(tokenAuthMessage("admin-release", { player: owner, contract, chainId, target: player, expiry }, d.ethers.getAddress));
    const r = await this._post("/api/token/admin-release", { owner, contract, chainId, player, signature, expiry }, 45000); // W3: same multi-read latency as /release
    const tx = await d.contract.settleBlackjack(player, BigInt(r.netWei), BigInt(r.nonce), r.signature, { gasLimit: 200000n });
    const receipt = await waitTx(tx);
    return { ...r, claimTx: receipt.hash };
  };

  // HOUSE TOOL — owner-authed aggregate exposure (#20). Signs ONCE (bound by an Expiry) and reuses that
  // payload across panel polls so the owner isn't prompted on every auto-refresh. No tx.
  TokenBridgeClient.prototype.houseState = async function () {
    const d = this.d, owner = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    const nowSec = Math.floor(Date.now() / 1000);
    let c = this._houseAuth;
    if (!c || c.owner !== owner || c.contract !== contract || c.chainId !== chainId || c.expiry <= nowSec + 30) {
      const expiry = nowSec + 1800; // 30-min window (server caps at 1h) → ~one prompt per half hour
      const signature = await d.signer.signMessage(tokenAuthMessage("house-state", { player: owner, contract, chainId, expiry }, d.ethers.getAddress));
      c = this._houseAuth = { owner, contract, chainId, expiry, signature };
    }
    return await this._post("/api/token/house-state", { owner, contract, chainId, expiry: c.expiry, signature: c.signature });
  };

  // HOUSE TOOL — owner-authed per-player diagnostics (locked principal + open-session state). No tx.
  TokenBridgeClient.prototype.adminPlayerInfo = async function (targetPlayer) {
    const d = this.d, owner = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    const player = d.ethers.getAddress(targetPlayer);
    const expiry = Math.floor(Date.now() / 1000) + 600; // v6 #19: 10-min anti-replay window on the owner admin signature
    const signature = await d.signer.signMessage(tokenAuthMessage("admin-player", { player: owner, contract, chainId, target: player, expiry }, d.ethers.getAddress));
    return await this._post("/api/token/admin-player", { owner, contract, chainId, player, signature, expiry }, 45000); // W3: multiple sequential on-chain diagnostics reads
  };

  const API = { TokenBridgeClient: TokenBridgeClient, tokenAuthMessage: tokenAuthMessage };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.TokenBridgeClient = TokenBridgeClient;
  root.TokenClientAPI = API;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* ---------------- auth-parity self-test: node public/token-client.js ---------------- */
if (typeof require !== "undefined" && require.main === module) {
  const { ethers } = require("ethers");
  const client = require("./token-client.js");
  const server = require("../server/token-http.js");
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };
  const player = "0x2f4bef94550c29c497b999b86b758f9771f7ab39"; // lower-case on purpose → must checksum to match
  const contract = "0xd7e584c341bdbf20848cfa162f65efb406aa0cbc";
  const startO = { player, contract, chainId: 11155111, buyInWei: "250000000000000000" };
  const settleO = { player, contract, chainId: 11155111, sessionId: "abc123" };
  eq("start message matches server byte-for-byte", client.tokenAuthMessage("start", startO, ethers.getAddress) === server.tokenAuthMessage("start", startO));
  eq("settle message matches server byte-for-byte", client.tokenAuthMessage("settle", settleO, ethers.getAddress) === server.tokenAuthMessage("settle", settleO));
  const topupO = { player, contract, chainId: 11155111, sessionId: "abc123", buyInWei: "250000000000000000" };
  eq("topup message matches server byte-for-byte", client.tokenAuthMessage("topup", topupO, ethers.getAddress) === server.tokenAuthMessage("topup", topupO));
  const admO = { player, contract, chainId: 11155111, target: player };
  eq("admin-release message matches server byte-for-byte", client.tokenAuthMessage("admin-release", admO, ethers.getAddress) === server.tokenAuthMessage("admin-release", admO));
  const admExpO = { player, contract, chainId: 11155111, target: player, expiry: 1782000000 }; // v6 #19: admin sig with an Expiry must byte-match too
  eq("admin-release message (with expiry) matches server byte-for-byte", client.tokenAuthMessage("admin-release", admExpO, ethers.getAddress) === server.tokenAuthMessage("admin-release", admExpO));
  eq("admin-player message (with expiry) matches server byte-for-byte", client.tokenAuthMessage("admin-player", admExpO, ethers.getAddress) === server.tokenAuthMessage("admin-player", admExpO));
  const relO = { player, contract, chainId: 11155111, expiry: 1782000000 };
  eq("release message (with expiry) matches server byte-for-byte", client.tokenAuthMessage("release", relO, ethers.getAddress) === server.tokenAuthMessage("release", relO));
  eq("release message (no expiry, legacy) matches server byte-for-byte", client.tokenAuthMessage("release", { player, contract, chainId: 11155111 }, ethers.getAddress) === server.tokenAuthMessage("release", { player, contract, chainId: 11155111 }));
  const hsO = { player, contract, chainId: 11155111, expiry: 1782000000 };
  eq("house-state message matches server byte-for-byte", client.tokenAuthMessage("house-state", hsO, ethers.getAddress) === server.tokenAuthMessage("house-state", hsO));
  // a signature made client-side recovers to the player on the server's message (round-trip)
  (async () => {
    const w = ethers.Wallet.createRandom();
    const o = { player: w.address, contract, chainId: 11155111, buyInWei: "1000" };
    const sig = await w.signMessage(client.tokenAuthMessage("start", o, ethers.getAddress));
    let threw = false; try { server.verifyWalletSignature("start", { signature: sig }, o); } catch (e) { threw = true; }
    eq("client signature verifies on the server", !threw);
    console.log(ok ? "\nSELF-TEST OK — client auth is byte-identical to the server." : "\nSELF-TEST FAILED");
    process.exit(ok ? 0 : 1);
  })();
}
