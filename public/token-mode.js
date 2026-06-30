/* ============================================================
   token-mode.js — client controller for TOKEN play (the 3rd mode).

   Demo = client play-money. On-chain = a tx per bet. TOKEN = lock ETH ONCE, then
   play every game instantly off-chain (no popups), cash out ONCE. This controller
   owns the session + the buy-in/cash-out/balance UI and exposes a tiny API the
   games call in their token branch:

     TokenMode.available()  -> wallet connected + bridge client ready
     TokenMode.active()     -> an open token session (tokens to spend)
     TokenMode.tokens()     -> current token balance
     await TokenMode.bet(gameKey, stakeUnits, params, clientSeed?) -> { win, multiplier, payoutUnits, outcome, detail, tokens }

   The outcome of every bet comes from the SERVER (server/games/<gameKey>.js) over a
   seed committed at buy-in and revealed at cash-out — provably fair, no VRF.
   ============================================================ */
(function (root) {
  "use strict";

  var deps = null;     // { ethers, signer, contract, account, chainId, contractAddr, usdToWei, toast, onChange }
  var client = null;   // TokenBridgeClient
  var enabled = null;  // cached /api/token/status.enabled (null = unknown)
  var busy = false;
  var stranded = 0;    // USD locked on-chain (bjLocked) with NO active session — set by app.js

  function $(id) { return document.getElementById(id); }
  function note(msg, kind) { try { deps && deps.toast ? deps.toast(msg, kind || "ok") : console.log(msg); } catch (e) {} }
  function changed() { try { deps && deps.onChange && deps.onChange(); } catch (e) {} render(); }

  // Remember the open session across a page REFRESH so we can reconnect to it (the server still has
  // it) instead of orphaning a funded session. Scoped to account + chainId + contract so we never
  // restore a session for a different wallet OR a different chain/contract (a session is chain-bound;
  // resuming a Sepolia session on another chain would be wrong). (Testnet-acceptable: the bearer in
  // localStorage is bounded by the lock.)
  var SKEY = "ctf_token_session";
  function _saveSession() { try { if (client && client.session) localStorage.setItem(SKEY, JSON.stringify({ sessionId: client.session.sessionId, sessionToken: client.session.sessionToken, account: (deps && deps.account) || "", chainId: (deps && deps.chainId) || null, contract: (deps && deps.contractAddr) || "" })); } catch (e) {} }
  function _clearSession() { try { localStorage.removeItem(SKEY); } catch (e) {} }
  function _loadSession() { try { return JSON.parse(localStorage.getItem(SKEY) || "null"); } catch (e) { return null; } }

  var TokenMode = {
    // Called by app.js right after a successful wallet connect (and on disconnect with null).
    init: function (d) {
      if (!d) { client = null; deps = null; render(); return; }
      deps = d;
      try { client = new root.TokenBridgeClient(d); } catch (e) { client = null; }
      render();
      // Probe the server flag once so the UI knows whether to offer token play.
      if (client) client.status().then(function (s) { enabled = !!(s && s.enabled); render(); }).catch(function () { enabled = false; render(); });
      // Reconnect to a session that survived a page refresh (the server still has it) — or clear it
      // cleanly if the server lost it (so we never show ghost tokens after a refresh).
      try {
        var saved = _loadSession();
        var sameCtx = saved && saved.account && d.account
          && String(saved.account).toLowerCase() === String(d.account).toLowerCase()
          && Number(saved.chainId) === Number(d.chainId)
          && String(saved.contract || "").toLowerCase() === String(d.contractAddr || "").toLowerCase();
        if (client && sameCtx) {
          client.resume(saved).then(function (okk) { if (okk) changed(); else _clearSession(); }).catch(function () {});
        } else if (saved) { _clearSession(); }
      } catch (e) {}
    },

    available: function () { return !!client && enabled !== false; },
    active: function () { return !!(client && client.session); },
    tokens: function () { return client ? Math.round((client.tokens || 0) * 100) / 100 : 0; },

    // The session handle the ws crash round-runner needs to authorize cr:start. Returns
    // only the two fields the wire needs (never the commit/seed). null if no open session.
    session: function () {
      return (client && client.session)
        ? { sessionId: client.session.sessionId, sessionToken: client.session.sessionToken }
        : null;
    },

    // Sync the local token balance after an OUT-OF-BAND settle — e.g. a live crash round
    // that settled over the ws (not via client.play), so client.tokens didn't auto-update.
    // The cr:result frame carries the authoritative new balance; pass it here to keep the
    // token bar + any balance readout correct.
    syncTokens: function (n) { if (client && typeof n === "number" && isFinite(n)) { client.tokens = n; changed(); } },

    // Lock `amountUsd` worth of ETH on-chain (ONE popup) → open a token session.
    buyIn: async function (amountUsd) {
      if (busy) return;
      if (!client) return note("Connect your wallet first", "err");
      if (enabled === false) return note("Token games aren't enabled on the server yet", "err");
      // The house wallet IS the bankroll/dealer — letting it buy in means betting against itself
      // (no real win/loss) and locks the house's OWN credits into a self-play session. Block it.
      if (deps.isHouseWallet && deps.isHouseWallet()) return note("You're the HOUSE wallet — switch to a player account in MetaMask to play with tokens (the house can't bet against itself).", "err");
      var usd = Math.round((+amountUsd || 0) * 100) / 100;
      if (!(usd > 0)) return note("Enter how much to buy in", "err");
      // blackjackBuyIn locks from your PRE-DEPOSITED game credits (not raw ETH), so make
      // sure they're funded first — otherwise the lock reverts InsufficientBalance.
      if (deps.gameBalanceUsd && usd > deps.gameBalanceUsd() + 0.001)
        return note("Deposit at least " + fmt(usd) + " into game credits first (the Deposit box), then buy in.", "err");
      busy = true; render();
      try {
        var amountWei = deps.usdToWei(usd);
        note("Confirm the buy-in in your wallet (one time)…", "ok");
        var r = await client.buyIn(amountWei);
        note("Bought in — " + fmt(r.tokens) + " tokens. Play any game, no more popups 🪙", "ok");
        changed();
        _saveSession(); // survive a page refresh
      } catch (e) {
        note(friendly(e), "err");
        try { changed(); } catch (e2) {} // re-check on-chain bjLocked → if a lock stranded, the "Recover" button appears immediately
      } finally { busy = false; render(); }
    },

    // ONE bet → authoritative server outcome (no popup). Games call this.
    // Surfaces failures (was SILENT in the fish games — a failed per-shot bet just left the
    // balance frozen with no toast, no log, so a lost session looked like a hung game).
    bet: async function (game, stakeUnits, params, clientSeed) {
      if (!this.active()) throw new Error("buy in with tokens first");
      try {
        var r = await client.play(game, stakeUnits, params || {}, clientSeed || randSeed());
        // Money is settled server-side, but DON'T refresh the balance display yet — that would
        // reveal the win/loss BEFORE the coin lands / fish bursts and spoil the animation. The game
        // calls TokenMode.syncBalance() AFTER its reveal so the number lands WITH the visual.
        return r;
      } catch (e) {
        _betError(e);
        throw e; // callers still handle their own UI (re-sync balance, unlock reveal, etc.)
      }
    },

    // Games call this AFTER their reveal/blow-up animation completes to update the balance display
    // (token bar + game HUDs) — so the number syncs with the visual instead of spoiling it.
    syncBalance: function () { changed(); },

    // Let games push a one-off message through the same toast pipe.
    notify: function (msg, kind) { note(msg, kind); },

    // app.js calls this after reading the connected wallet's on-chain bjLocked: the USD amount that
    // is locked with no active session (0 = nothing stranded). Drives the "Recover" token-bar state.
    setStranded: function (usd) { var v = Math.max(0, Math.round((+usd || 0) * 100) / 100); if (v !== stranded) { stranded = v; render(); } },

    // Recover a stranded on-chain lock (a session the server forgot) back to your game credits.
    releaseStuck: async function () {
      if (busy) return;
      if (!client) return note("Connect your wallet first", "err");
      busy = true; render();
      try {
        note("Recovering your locked funds…", "ok");
        var r = await client.releaseStuck();
        // mode:"session" = the server cashed out a live session it still held (the client had lost track
        // of it); mode:"orphan" = a net=0 release of a truly stranded lock. Either way the full on-chain
        // lock is back in game credits.
        if (r && (r.mode === "session" || r.mode === "obligation")) note("Recovered — your funds are back in your game credits ✅", "ok");
        else { var eth = Number(r && r.lockedWei) / 1e18; note((isFinite(eth) ? "Released " + eth.toFixed(4) + " ETH" : "Recovered your funds") + " back to your game credits ✅", "ok"); }
        stranded = 0; // recovered — clear the prompt (app.js re-checks bjLocked via onChange too)
        _clearSession();
        changed();
      } catch (e) {
        note(friendly(e), "err");
        try { changed(); } catch (e2) {} // re-check on-chain lock either way
      } finally { busy = false; render(); }
    },

    // HOUSE TOOLS (owner only) — read a player's on-chain token state, and release a stranded
    // player's locked funds back to them. Delegated to the bridge client; the server enforces that
    // the caller is the on-chain owner/treasury, so a non-owner call just fails server-side.
    adminPlayerInfo: function (addr) { if (!client) return Promise.reject(new Error("connect your wallet first")); return client.adminPlayerInfo(addr); },
    adminRelease: async function (addr) {
      if (busy) throw new Error("busy");
      if (!client) throw new Error("connect your wallet first");
      busy = true; render();
      try {
        note("Releasing the player's locked funds…", "ok");
        var r = await client.adminRelease(addr);
        var eth = Number(r && r.lockedWei) / 1e18;
        note("Released " + (isFinite(eth) ? eth.toFixed(4) + " ETH" : "funds") + " back to the player ✅", "ok");
        return r;
      } catch (e) { note(friendly(e), "err"); throw e; }
      finally { busy = false; render(); }
    },

    // Top up an OPEN session: lock MORE game credits → more tokens, without cashing out. For when
    // you run dry mid-game (e.g. $2 tokens but $14/shot) and want to keep playing immediately.
    topUp: async function (amountUsd) {
      if (busy) return;
      if (!client) return note("Connect your wallet first", "err");
      if (deps.isHouseWallet && deps.isHouseWallet()) return note("You're the HOUSE wallet — switch to a player account to play with tokens.", "err");
      if (!this.active()) return note("Buy in first, then you can top up", "err");
      var usd = Math.round((+amountUsd || 0) * 100) / 100;
      if (!(usd > 0)) return note("Enter how much to add", "err");
      // Locks from your pre-deposited game credits, same as the initial buy-in.
      if (deps.gameBalanceUsd && usd > deps.gameBalanceUsd() + 0.001)
        return note("You have " + fmt(deps.gameBalanceUsd()) + " in game credits to add. Deposit more first (the Deposit box).", "err");
      busy = true; render();
      try {
        var amountWei = deps.usdToWei(usd);
        note("Confirm the top-up in your wallet (one time)…", "ok");
        var r = await client.topUp(amountWei);
        note("Topped up — now " + fmt(r.tokens) + " tokens. Keep playing 🪙", "ok");
        changed();
      } catch (e) {
        note(friendly(e), "err");
        // If the pre-flight found the session dead, clear it (resets to Buy in). Either way re-check
        // bjLocked so any stranded lock surfaces the "Recover" button immediately.
        var m = (e && (e.shortMessage || e.message)) || "";
        if (/invalid session token|no open session|no such session|session is closed/i.test(m)) { try { if (client) { client.session = null; client.tokens = 0; } } catch (e2) {} _clearSession(); }
        try { changed(); } catch (e2) {}
      } finally { busy = false; render(); }
    },

    // Cash out: server signs the net → submit the claim on-chain (ONE popup).
    cashOut: async function () {
      if (busy) return;
      if (!this.active()) return;
      busy = true; render();
      try {
        note("Confirm the cash-out in your wallet (one time)…", "ok");
        var s = await client.cashOut();
        var netEth = Number(s.netWei) / 1e18;
        note("Cashed out. Net " + (netEth >= 0 ? "+" : "") + netEth.toFixed(4) + " ETH claimed ✅", "ok");
        changed();
        _clearSession();
      } catch (e) {
        note(friendly(e), "err");
      } finally { busy = false; render(); }
    },

    _render: render,
  };

  // Throttled bet-error surfacing: a fast-fire burst (fish shooter) can fail many bets at once;
  // show at most one toast every few seconds so the user is told WHY without 30 stacked toasts.
  var _lastBetErrAt = 0;
  function _betError(e) {
    var msg = (e && (e.shortMessage || e.message)) || "";
    var lost = /invalid session token|no such session|session is closed/i.test(msg);
    if (lost) {
      // The server lost this session (e.g. a restart on non-durable storage). Immediately clear the
      // dead client session so the UI resets to "Buy in" instead of showing a STALE balance and
      // erroring on every bet (the "$1,051 ghost tokens" problem). No reload needed.
      try { if (client) { client.session = null; client.tokens = 0; } } catch (e2) {}
      _clearSession();
      changed();
    }
    var now = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
    if (now - _lastBetErrAt > 2500) {
      _lastBetErrAt = now;
      if (lost) note("Your token session ended (the server restarted) — buy in again to keep playing. Any locked funds stay on-chain.", "err");
      else if (/timed out|timeout|aborted|failed to fetch|network/i.test(msg)) note("Connection hiccup — that bet didn't go through. Try again.", "err");
      else note("Bet didn't settle: " + msg, "err");
    }
    try { console.warn("[TokenMode] bet failed:", msg); } catch (_) {}
  }

  function fmt(n) { return "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString(); }
  function _gameBal() { try { return (deps && deps.gameBalanceUsd) ? (+deps.gameBalanceUsd() || 0) : 0; } catch (e) { return 0; } } // player's in-game credits in USD (the slider cap)
  function randSeed() { var s = ""; for (var i = 0; i < 8; i++) s += (Math.random() * 16 | 0).toString(16); return s; }
  function friendly(e) {
    var m = (e && (e.shortMessage || e.message)) || "Something went wrong";
    if (/user rejected|denied/i.test(m)) return "Cancelled in wallet";
    if (/insufficient/i.test(m)) return "Not enough balance for that buy-in";
    return m;
  }

  // ── UI: a compact panel that lives in #token-mount (added to index.html). ──
  function render() {
    var mount = $("token-mount"); if (!mount) return;
    if (!client) { mount.hidden = true; mount.innerHTML = ""; return; }
    if (enabled === false) { mount.hidden = true; return; } // server flag off → hide entirely
    mount.hidden = false;
    if (TokenMode.active()) {
      // Top-up is a SLIDER capped to remaining in-game credits (no typing). Hidden if no credits left.
      var maxTop = Math.floor(_gameBal());
      var topDflt = Math.min(50, Math.max(1, maxTop));
      mount.innerHTML =
        '<div class="token-bar">' +
        '<span class="token-bal">🪙 <strong>' + fmt(TokenMode.tokens()) + '</strong> tokens</span>' +
        (maxTop >= 1
          ? '<input id="token-topup-slider" class="token-slider" type="range" min="1" max="' + maxTop + '" step="1" value="' + topDflt + '" aria-label="Top-up amount in dollars" />' +
            '<button id="token-topup-btn" class="btn btn-primary token-btn"' + (busy ? " disabled" : "") + '>' + (busy ? "…" : '+ Add <span id="token-topup-val">' + fmt(topDflt) + '</span>') + '</button>'
          : '<span class="token-hint">play any game — no popups</span>') +
        '<button id="token-cashout" class="btn btn-ghost token-btn"' + (busy ? " disabled" : "") + '>Cash out</button>' +
        '</div>';
      var tsl = $("token-topup-slider"), tlbl = $("token-topup-val");
      if (tsl && tlbl) tsl.oninput = function () { tlbl.textContent = fmt(tsl.value); };
      var tu = $("token-topup-btn"); if (tu) tu.onclick = function () { TokenMode.topUp(parseFloat((tsl && tsl.value) || topDflt)); };
      var co = $("token-cashout"); if (co) co.onclick = function () { TokenMode.cashOut(); };
    } else if (deps && deps.isHouseWallet && deps.isHouseWallet()) {
      // House wallet = the bankroll/dealer. It must NOT play with tokens (betting against itself).
      mount.innerHTML =
        '<div class="token-bar">' +
        '<span class="token-bal">🏠 You\'re the house wallet</span>' +
        '<span class="token-hint">switch to a player account in MetaMask to play with tokens</span>' +
        '</div>';
    } else if (stranded > 0) {
      // Stranded-lock recovery for ANY player: bjLocked>0 on-chain with no session. The cross-session
      // guard blocks a new buy-in until this is cleared, so without this a stranded player could not
      // play at all — surface a one-tap recover back to their game credits.
      mount.innerHTML =
        '<div class="token-bar">' +
        '<span class="token-bal">🔓 <strong>' + fmt(stranded) + '</strong> locked in a past session</span>' +
        '<span class="token-hint">recover it back to your game credits</span>' +
        '<button id="token-recover-btn" class="btn btn-primary token-btn"' + (busy ? " disabled" : "") + '>' + (busy ? "…" : "Recover") + '</button>' +
        '</div>';
      var rcb = $("token-recover-btn"); if (rcb) rcb.onclick = function () { TokenMode.releaseStuck(); };
    } else {
      // Buy-in is a SLIDER capped to the player's in-game balance (no typing). Max = game credits.
      var maxBal = Math.floor(_gameBal());
      if (maxBal < 1) {
        mount.innerHTML =
          '<div class="token-bar">' +
          '<span class="token-bal">🪙 Play with tokens</span>' +
          '<span class="token-hint">deposit game credits first (the Deposit box), then buy in</span>' +
          '</div>';
      } else {
        var dflt = Math.min(50, maxBal);
        mount.innerHTML =
          '<div class="token-bar">' +
          '<span class="token-bal">🪙 Lock <strong id="token-buyin-val">' + fmt(dflt) + '</strong></span>' +
          '<input id="token-buyin-slider" class="token-slider" type="range" min="1" max="' + maxBal + '" step="1" value="' + dflt + '" aria-label="Buy-in amount in dollars" />' +
          '<button id="token-buyin-max" class="btn btn-ghost token-btn" type="button">Max</button>' +
          '<button id="token-buyin-btn" class="btn btn-primary token-btn"' + (busy ? " disabled" : "") + '>' + (busy ? "…" : "Buy in") + '</button>' +
          '</div>';
        var sl = $("token-buyin-slider"), lbl = $("token-buyin-val");
        if (sl && lbl) sl.oninput = function () { lbl.textContent = fmt(sl.value); };
        var mx = $("token-buyin-max"); if (mx) mx.onclick = function () { if (sl) { sl.value = maxBal; if (lbl) lbl.textContent = fmt(maxBal); } };
        var b = $("token-buyin-btn"); if (b) b.onclick = function () { TokenMode.buyIn(parseFloat((sl && sl.value) || dflt)); };
      }
    }
  }

  root.TokenMode = TokenMode;
})(typeof window !== "undefined" ? window : this);
