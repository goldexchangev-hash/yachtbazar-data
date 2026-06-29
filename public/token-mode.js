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

    // Lock `amountUsd` worth of ETH on-chain (ONE popup) → open a token session.
    buyIn: async function (amountUsd) {
      if (busy) return;
      if (!client) return note("Connect your wallet first", "err");
      if (enabled === false) return note("Token games aren't enabled on the server yet", "err");
      var usd = Math.round((+amountUsd || 0) * 100) / 100;
      if (!(usd > 0)) return note("Enter how much to buy in", "err");
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
    bet: async function (game, stakeUnits, params, clientSeed) {
      if (!this.active()) throw new Error("buy in with tokens first");
      var r = await client.play(game, stakeUnits, params || {}, clientSeed || randSeed());
      changed();
      return r;
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
        '<button id="token-cashout" class="btn btn-ghost token-btn"' + (busy ? " disabled" : "") + '>Cash out</button>' +
        '</div>';
      var co = $("token-cashout"); if (co) co.onclick = function () { TokenMode.cashOut(); };
    } else {
      mount.innerHTML =
        '<div class="token-bar">' +
        '<span class="token-bal">🎟️ Play with tokens</span>' +
        '<span class="token-hint">lock ETH once → no per-bet popups</span>' +
        '<input id="token-buyin" class="token-input" type="number" min="1" step="1" value="50" aria-label="Buy-in amount in dollars" />' +
        '<button id="token-buyin-btn" class="btn btn-primary token-btn"' + (busy ? " disabled" : "") + '>' + (busy ? "…" : "Buy in") + '</button>' +
        '</div>';
      var b = $("token-buyin-btn"); if (b) b.onclick = function () { var v = parseFloat(($("token-buyin") || {}).value); TokenMode.buyIn(v); };
    }
  }

  root.TokenMode = TokenMode;
})(typeof window !== "undefined" ? window : this);
