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

  function $(id) { return document.getElementById(id); }
  function note(msg, kind) { try { deps && deps.toast ? deps.toast(msg, kind || "ok") : console.log(msg); } catch (e) {} }
  function changed() { try { deps && deps.onChange && deps.onChange(); } catch (e) {} render(); }

  var TokenMode = {
    // Called by app.js right after a successful wallet connect (and on disconnect with null).
    init: function (d) {
      if (!d) { client = null; deps = null; render(); return; }
      deps = d;
      try { client = new root.TokenBridgeClient(d); } catch (e) { client = null; }
      render();
      // Probe the server flag once so the UI knows whether to offer token play.
      if (client) client.status().then(function (s) { enabled = !!(s && s.enabled); render(); }).catch(function () { enabled = false; render(); });
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
        note("Bought in — " + fmt(r.tokens) + " tokens. Play any game, no more popups 🎟️", "ok");
        changed();
      } catch (e) {
        note(friendly(e), "err");
      } finally { busy = false; render(); }
    },

    // ONE bet → authoritative server outcome (no popup). Games call this.
    // Surfaces failures (was SILENT in the fish games — a failed per-shot bet just left the
    // balance frozen with no toast, no log, so a lost session looked like a hung game).
    bet: async function (game, stakeUnits, params, clientSeed) {
      if (!this.active()) throw new Error("buy in with tokens first");
      try {
        var r = await client.play(game, stakeUnits, params || {}, clientSeed || randSeed());
        changed();
        return r;
      } catch (e) {
        _betError(e);
        throw e; // callers still handle their own UI (re-sync balance, unlock reveal, etc.)
      }
    },

    // Let games push a one-off message through the same toast pipe.
    notify: function (msg, kind) { note(msg, kind); },

    // Top up an OPEN session: lock MORE game credits → more tokens, without cashing out. For when
    // you run dry mid-game (e.g. $2 tokens but $14/shot) and want to keep playing immediately.
    topUp: async function (amountUsd) {
      if (busy) return;
      if (!client) return note("Connect your wallet first", "err");
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
        note("Topped up — now " + fmt(r.tokens) + " tokens. Keep playing 🎟️", "ok");
        changed();
      } catch (e) {
        note(friendly(e), "err");
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
    var now = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
    if (now - _lastBetErrAt > 2500) {
      _lastBetErrAt = now;
      if (lost) note("Your token session ended (the server restarted). Reload the page to keep playing — your locked funds are safe on-chain.", "err");
      else if (/timed out|timeout|aborted|failed to fetch|network/i.test(msg)) note("Connection hiccup — that bet didn't go through. Try again.", "err");
      else note("Bet didn't settle: " + msg, "err");
    }
    try { console.warn("[TokenMode] bet failed:", msg); } catch (_) {}
  }

  function fmt(n) { return "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString(); }
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
      mount.innerHTML =
        '<div class="token-bar">' +
        '<span class="token-bal">🎟️ <strong>' + fmt(TokenMode.tokens()) + '</strong> tokens</span>' +
        '<span class="token-hint">play any game — no popups</span>' +
        '<input id="token-topup" class="token-input" type="number" min="1" step="1" value="50" aria-label="Top-up amount in dollars" title="Add more tokens from your game credits" />' +
        '<button id="token-topup-btn" class="btn btn-primary token-btn"' + (busy ? " disabled" : "") + '>' + (busy ? "…" : "+ Add") + '</button>' +
        '<button id="token-cashout" class="btn btn-ghost token-btn"' + (busy ? " disabled" : "") + '>Cash out</button>' +
        '</div>';
      var tu = $("token-topup-btn"); if (tu) tu.onclick = function () { var v = parseFloat(($("token-topup") || {}).value); TokenMode.topUp(v); };
      var co = $("token-cashout"); if (co) co.onclick = function () { TokenMode.cashOut(); };
    } else {
      mount.innerHTML =
        '<div class="token-bar">' +
        '<span class="token-bal">🎟️ Play with tokens</span>' +
        '<span class="token-hint">lock game credits once → no per-bet popups</span>' +
        '<input id="token-buyin" class="token-input" type="number" min="1" step="1" value="50" aria-label="Buy-in amount in dollars" />' +
        '<button id="token-buyin-btn" class="btn btn-primary token-btn"' + (busy ? " disabled" : "") + '>' + (busy ? "…" : "Buy in") + '</button>' +
        '</div>';
      var b = $("token-buyin-btn"); if (b) b.onclick = function () { var v = parseFloat(($("token-buyin") || {}).value); TokenMode.buyIn(v); };
    }
  }

  root.TokenMode = TokenMode;
})(typeof window !== "undefined" ? window : this);
