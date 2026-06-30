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
    return lines.join("\n");
  }

  // deps: { ethers, signer, contract, account, chainId, contractAddr, fetch?, apiBase? }
  //   signer   = ethers wallet signer (signMessage + the tx sender)
  //   contract = ethers Contract bound to the signer (blackjackBuyIn / settleBlackjack)
  function TokenBridgeClient(deps) {
    this.d = deps || {};
    this.session = null;   // { sessionId, sessionToken, commit, tokens, buyInUnits }
    this.tokens = 0;
  }

  TokenBridgeClient.prototype._post = async function (path, body) {
    const f = this.d.fetch || root.fetch.bind(root);
    const opts = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) };
    // A hung request must NOT freeze the game forever (a per-shot bet that never resolves
    // leaves the balance stuck). Bound every call with a timeout so the caller's catch fires.
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(12000); } catch (e) {}
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
    let st = null;
    try { st = await this.status(); } catch (e) { return { ok: false, error: "Can't reach the server right now — try again in a moment." }; }
    if (st && st.enabled && st.priceReady === false) return { ok: false, error: "Price is still syncing — try again in a few seconds." };
    if (needSession && !(await this._sessionAlive())) return { ok: false, error: "invalid session token" };
    return { ok: true };
  };
  TokenBridgeClient.prototype._sessionAlive = async function () {
    if (!this.session) return false;
    const f = this.d.fetch || root.fetch.bind(root);
    const opts = {};
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(10000); } catch (e) {}
    try {
      const res = await f((this.d.apiBase || "") + "/api/token/session?sessionId=" + encodeURIComponent(this.session.sessionId) + "&sessionToken=" + encodeURIComponent(this.session.sessionToken), opts);
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
      const res = await f((this.d.apiBase || "") + "/api/token/session?sessionId=" + encodeURIComponent(saved.sessionId) + "&sessionToken=" + encodeURIComponent(saved.sessionToken), opts);
      j = await res.json().catch(() => null);
    } catch (e) { return false; }
    if (j && j.ok) {
      this.session = { sessionId: saved.sessionId, sessionToken: saved.sessionToken, commit: j.commit, tokens: j.tokens, buyInUnits: j.buyInUnits };
      this.tokens = j.tokens;
      return true;
    }
    return false;
  };

  // BUY IN: lock `amountWei` on-chain (ONE popup) → open a server token session.
  TokenBridgeClient.prototype.buyIn = async function (amountWei) {
    const d = this.d;
    const player = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    const buyInWei = (typeof amountWei === "bigint" ? amountWei : BigInt(amountWei)).toString();
    // PRE-FLIGHT (prevents fund-stranding): price ready, and NO prior on-chain lock — a buy-in on top
    // of a stranded/other lock is rejected by the server AFTER the lock, stranding the funds.
    const pre = await this._preflight(false);
    if (!pre.ok) throw new Error(pre.error);
    try { const prior = await d.contract.bjLocked(player); if (prior != null && BigInt(prior) > 0n) throw new Error("You have funds locked on-chain from a past session — tap Recover first, then buy in."); }
    catch (e) { if (/locked on-chain from a past/.test((e && e.message) || "")) throw e; /* read failed: the lock tx would fail too, so proceed */ }
    // 1) player authorizes the buy-in (off-chain signature — no gas)
    const signature = await d.signer.signMessage(tokenAuthMessage("start", { player, contract, chainId, buyInWei }, d.ethers.getAddress));
    // 2) lock the funds on-chain (the ONE popup) and wait for it to confirm
    const tx = await d.contract.blackjackBuyIn(buyInWei, { gasLimit: 200000n });
    const receipt = await tx.wait();
    // 3) hand the server the confirmed txHash + the signature → it verifies + grants tokens
    const r = await this._post("/api/token/start", { player, contract, chainId, txHash: receipt.hash, buyInWei, signature });
    this.session = r; this.tokens = r.tokens;
    return r;
  };

  // PLAY: one instant off-chain bet (no popup). `game` is a token-enabled key.
  TokenBridgeClient.prototype.play = async function (game, betUnits, params, clientSeed) {
    if (!this.session) throw new Error("buy in first");
    const r = await this._post("/api/token/play", {
      sessionId: this.session.sessionId, sessionToken: this.session.sessionToken,
      game: game, betUnits: betUnits, params: params || {}, clientSeed: clientSeed || "",
    });
    this.tokens = r.tokens;
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
    const receipt = await tx.wait();
    const r = await this._post("/api/token/topup", { player, sessionId, sessionToken: this.session.sessionToken, txHash: receipt.hash, buyInWei: addWei, signature });
    this.tokens = r.tokens;
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
    const receipt = await tx.wait();
    const settled = { ...s, claimTx: receipt.hash };
    this.session = null; this.tokens = 0;
    return settled;
  };

  // RECOVER a STRANDED lock: the server signs a net=0 settlement (returns the locked principal to
  // THIS wallet's balance); we submit settleBlackjack. The server refuses if an open session exists.
  TokenBridgeClient.prototype.releaseStuck = async function () {
    const d = this.d, player = d.account, contract = d.contractAddr, chainId = Number(d.chainId);
    const signature = await d.signer.signMessage(tokenAuthMessage("release", { player, contract, chainId }, d.ethers.getAddress));
    const r = await this._post("/api/token/release", { player, contract, chainId, signature });
    const tx = await d.contract.settleBlackjack(player, BigInt(r.netWei), BigInt(r.nonce), r.signature, { gasLimit: 200000n });
    const receipt = await tx.wait();
    return { ...r, claimTx: receipt.hash };
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
