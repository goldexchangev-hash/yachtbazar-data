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
  var _maxWin = 0;     // M4: per-session max-win (profit) cap in USD, from /status (0 = uncapped) — disclosed at buy-in
  var resumePending = false; // v12 #2: a saved session is mid-resume (client.resume in flight) — suppress the Recover
                             // banner until it resolves, so a tap can't force-settle a session that's coming back.
  // Remember the amount the player slid to, so a background re-render (a balance poll calls render())
  // can't snap the slider + its label back to the default while they're choosing a buy-in / top-up.
  var amt = { buyin: null, topup: null };

  function $(id) { return document.getElementById(id); }
  function note(msg, kind) { try { deps && deps.toast ? deps.toast(msg, kind || "ok") : console.log(msg); } catch (e) {} }
  // force=true marks a USER money event (buy-in / top-up / cash-out) that must update the canvas HUD
  // immediately — even inside the fish reveal-window hold (#19). A bare changed() (poll / resume) respects it.
  function changed(force) { try { deps && deps.onChange && deps.onChange(!!force); } catch (e) {} render(); }

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
      if (client) client.status().then(function (s) { enabled = !!(s && s.enabled); _maxWin = (s && typeof s.maxWinUnits === "number" && s.maxWinUnits > 0) ? s.maxWinUnits : 0; render(); }).catch(function () { enabled = false; render(); });
      // Reconnect to a session that survived a page refresh (the server still has it) — or clear it
      // cleanly if the server lost it (so we never show ghost tokens after a refresh).
      try {
        var saved = _loadSession();
        var sameCtx = saved && saved.account && d.account
          && String(saved.account).toLowerCase() === String(d.account).toLowerCase()
          && Number(saved.chainId) === Number(d.chainId)
          && String(saved.contract || "").toLowerCase() === String(d.contractAddr || "").toLowerCase();
        if (client && sameCtx) {
          resumePending = true; try { render(); } catch (e) {} // v12 #2: mark the resume in-flight → Recover stays hidden until it lands
          client.resume(saved).then(function (okk) { if (okk === true) changed(); else if (okk === "gone") _clearSession(); /* #19: keep a saved session on a transient failure (don't wipe on a load-time blip) */ }).catch(function () {}).then(function () { resumePending = false; try { render(); } catch (e) {} try { root.dispatchEvent && root.dispatchEvent(new Event("ctf:resume-done")); } catch (e) {} });
        } else if (saved) { _clearSession(); }
      } catch (e) {}
    },

    available: function () { return !!client && enabled !== false; },
    active: function () { return !!(client && client.session); },
    resumePending: function () { return resumePending; }, // v12 #2: true while a saved session is mid-resume
    pendingBuyIn: function () { return busy; }, // true while a buy-in/top-up/recover is mid-flight — checkStrandedLock uses this to avoid flashing Recover before the session opens
    hasSavedSession: function () { try { return !!_loadSession(); } catch (e) { return false; } },
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
        note("Bought in — " + fmt(r.tokens) + " tokens. Play any game, no more popups 🪙" + (_maxWin > 0 ? " · Max win this session: " + fmt(_maxWin) + " over your buy-in" : ""), "ok"); // M4: disclose the session max-win cap up front
        changed(true); // #19: force HUD update now (bypass any fish reveal-window hold)
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
    syncBalance: function () { _barHoldVal = null; changed(); }, // reveal finished → drop any top-bar hold + show the real balance

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
    // Owner-authed aggregate house exposure (#20). Returns null (not a throw) when no wallet client is
    // available so the panel just hides the token row instead of erroring.
    houseState: function () { if (!client) return Promise.resolve(null); return client.houseState().catch(function () { return null; }); },
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
        changed(true); // #19: force HUD update now even if a fish reveal-window is holding
      } catch (e) {
        note(friendly(e), "err");
        // mega-hunt MEDIUM: a top-up POST can fail TRANSIENTLY *after* the on-chain lock already succeeded (a
        // redeploy window / durable-bearer rehydrate), and clearing the session on the bare error text then
        // ORPHANS the just-locked funds. Mirror _betError: CONFIRM via resume and clear ONLY on a confirmed
        // "gone". Either way changed() re-checks bjLocked so any stranded lock surfaces the "Recover" button.
        var m = (e && (e.shortMessage || e.message)) || "";
        if (/invalid session token|no open session|no such session|session is closed/i.test(m) && client && client.session && client.resume) {
          client.resume(client.session).then(function (okk) {
            if (okk === "gone") { try { if (client) { client.session = null; client.tokens = 0; } } catch (e2) {} _clearSession(); }
            try { changed(); } catch (e2) {}
          }).catch(function () { try { changed(); } catch (e2) {} });
        } else { try { changed(); } catch (e2) {} }
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
        changed(true); // #19: force HUD update now (cash-out zeroes the in-game balance)
        _clearSession();
      } catch (e) {
        note(friendly(e), "err");
      } finally { busy = false; render(); }
    },

    // LIGHT live-sync for fast games (fish shooter): update JUST the token-balance number in the bar from
    // the authoritative client.tokens — no full re-render (won't disturb a slider) and no heavy onChange
    // (no fetch / on-chain read per shot). Lets the top bar track the in-game balance in real time.
    paintTokens: function () { try { var m = $("token-mount"); var el = m && m.querySelector(".token-bal strong"); if (el) el.textContent = fmt(barBal()); } catch (e) {} },
    // Freeze the top-bar balance at its current value through a reveal; the game clears it via syncBalance().
    holdBar: function () { try { if (TokenMode.active()) _barHoldVal = TokenMode.tokens(); } catch (e) {} },
    // HOLD the top bar at a SPECIFIC value — used to show an OPTIMISTIC per-spin debit the instant you tap (before
    // the server settles), so the displayed balance drops right away. Cleared by syncBalance()/releaseBar() at settle.
    holdBarAt: function (v) { try { if (TokenMode.active()) { var n = +v; if (isFinite(n) && n >= 0) { _barHoldVal = Math.round(n * 100) / 100; TokenMode.paintTokens(); } } } catch (e) {} },
    releaseBar: function () { _barHoldVal = null; try { TokenMode.paintTokens(); } catch (e) {} },
    // The DISPLAYED token balance (held value during a reveal/optimistic debit, else the live client.tokens). The
    // TV balance overlay reads this so it always matches the top bar.
    displayTokens: function () { return barBal(); },

    // Token-funded BLACKJACK drives the token session from the felt (server-side), so client.tokens would
    // otherwise stay stale until cash-out — the top bar wouldn't show a hand's win/loss live. The felt
    // reports its authoritative server balance here so the bar (and the next discrete game) stay in sync.
    // The on-chain settle is unaffected (it reads the server session, never this display value).
    syncTokensFromFelt: function (usd) {
      if (!client || !client.session) return;
      var v = +usd; if (!isFinite(v) || v < 0) return;
      v = Math.round(v * 100) / 100;
      if (client.tokens === v) return;
      client.tokens = v; try { client.session.tokens = v; } catch (e) {}
      TokenMode.paintTokens();
    },
    // Authoritative refresh from the server session (used on leaving blackjack) so client.tokens can't drift.
    refreshTokens: function () {
      try {
        if (client && client.session && client.resume) {
          return client.resume(client.session).then(function (okk) {
            // #19: only drop the session when the server CONFIRMS it's gone ("gone") — a transient failure
            // (network blip) keeps the session and just repaints, so a redeploy can't strand a live balance
            // as a phantom while a blip can't wipe a real one.
            if (okk === "gone") { try { client.session = null; client.tokens = 0; } catch (e) {} _clearSession(); changed(); }
            else { try { changed(); } catch (e) {} } // v13 #2: changed() runs onChange→syncTokenGameBalances (updates the CANVAS HUD) then render() (top bar) — was paintTokens() alone, which left the destination canvas showing the pre-resume balance
          }).catch(function () {});
        }
      } catch (e) {}
    },

    _render: render,
  };

  // Throttled bet-error surfacing: a fast-fire burst (fish shooter) can fail many bets at once;
  // show at most one toast every few seconds so the user is told WHY without 30 stacked toasts.
  var _lastBetErrAt = 0, _lastSessCheckAt = 0;
  function _betError(e) {
    var msg = (e && (e.shortMessage || e.message)) || "";
    var lost = /invalid session token|no such session|session is closed/i.test(msg);
    if (lost && client && client.session && client.resume) {
      // v5 #16: DON'T wipe the session on the bare error text. A transient failure — a redeploy window while
      // the durable bearer rehydrates, or one bad response mid fish-burst — can carry these phrases while the
      // session is still valid on the server; clearing it then strands a live session. CONFIRM via resume and
      // clear ONLY on a confirmed "gone" (mirrors refreshTokens). Throttle so a burst can't herd resume checks.
      var nowc = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
      if (nowc - _lastSessCheckAt < 3000) return; // already verifying — let the in-flight check decide
      _lastSessCheckAt = nowc;
      client.resume(client.session).then(function (okk) {
        if (okk === "gone") {
          try { client.session = null; client.tokens = 0; } catch (e2) {}
          _clearSession(); changed();
          var n2 = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
          if (n2 - _lastBetErrAt > 2500) { _lastBetErrAt = n2; note("Your token session ended — buy in again to keep playing. Any locked funds stay on-chain.", "err"); }
        } else if (okk === true) { changed(); } // still alive → resync; that failed bet was transient
      }).catch(function () {});
      try { console.warn("[TokenMode] bet failed (verifying session):", msg); } catch (_) {}
      return; // the resume callback owns the messaging for this class of error
    }
    var now = (typeof Date !== "undefined" && Date.now) ? Date.now() : 0;
    if (now - _lastBetErrAt > 2500) {
      _lastBetErrAt = now;
      if (/timed out|timeout|aborted|failed to fetch|network/i.test(msg)) note("Connection hiccup — that bet didn't go through. Try again.", "err");
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

  // v5 #18: a balance poll calls render() which rebuilds #token-mount wholesale (innerHTML) — doing that
  // mid-drag on the buy-in / top-up slider yanks the element out from under the user's finger and aborts the
  // drag (the v12.58 one-tap mobile UX). Track an active drag and SKIP the rebuild until the pointer releases,
  // then render once to pick up the latest balance. Capture-phase window listeners catch a release anywhere.
  var _sliderDragging = false;
  if (typeof window !== "undefined" && window.addEventListener) {
    var _endDrag = function () { if (_sliderDragging) { _sliderDragging = false; try { render(); } catch (e) {} } };
    window.addEventListener("pointerup", _endDrag, true);
    window.addEventListener("touchend", _endDrag, true);
    window.addEventListener("pointercancel", _endDrag, true);
    window.addEventListener("touchcancel", _endDrag, true);
  }

  // The top token-bar balance is HELD at its pre-bet value during a game's win/loss reveal so it can't spoil
  // the animation (the "I hear the beep and look at my balance before the coin lands" report). holdBar()
  // captures the current tokens; the game clears it via syncBalance() when its reveal finishes (or unlockReveal
  // does on a safety timeout). While held, both paintTokens() and render() show the held value, not the live one.
  var _barHoldVal = null;
  function barBal() { return _barHoldVal != null ? _barHoldVal : TokenMode.tokens(); }

  // ── UI: a compact panel that lives in #token-mount (added to index.html). ──
  function render() {
    var mount = $("token-mount"); if (!mount) return;
    if (!client) { mount.hidden = true; mount.innerHTML = ""; return; }
    if (enabled === false) { mount.hidden = true; return; } // server flag off → hide entirely
    mount.hidden = false;
    if (_sliderDragging) return; // a slider is being dragged — don't rebuild the bar under the user's finger (#18)
    if (TokenMode.active()) {
      // Top-up is a SLIDER capped to remaining in-game credits (no typing). Hidden if no credits left.
      var maxTop = Math.floor(_gameBal());
      var topDflt = amt.topup != null ? Math.min(maxTop, Math.max(1, Math.round(amt.topup))) : Math.min(50, Math.max(1, maxTop));
      mount.innerHTML =
        '<div class="token-bar">' +
        '<span class="token-bal">🪙 <strong>' + fmt(barBal()) + '</strong> tokens</span>' +
        (maxTop >= 1
          ? '<input id="token-topup-slider" class="token-slider" type="range" min="1" max="' + maxTop + '" step="1" value="' + topDflt + '" aria-label="Top-up amount in dollars" />' +
            '<button id="token-topup-btn" class="btn btn-primary token-btn"' + (busy ? " disabled" : "") + '>' + (busy ? "…" : '+ Add <span id="token-topup-val">' + fmt(topDflt) + '</span>') + '</button>'
          : '<span class="token-hint">play any game — no popups</span>') +
        '<button id="token-cashout" class="btn btn-ghost token-btn"' + (busy ? " disabled" : "") + '>Cash out</button>' +
        '</div>';
      var tsl = $("token-topup-slider"), tlbl = $("token-topup-val");
      if (tsl && tlbl) tsl.oninput = function () { _sliderDragging = true; amt.topup = parseFloat(tsl.value) || 1; tlbl.textContent = fmt(tsl.value); }; // #18: mark drag so a balance poll won't rebuild the bar mid-slide
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
        var dflt = amt.buyin != null ? Math.min(maxBal, Math.max(1, Math.round(amt.buyin))) : Math.min(50, maxBal);
        mount.innerHTML =
          '<div class="token-bar">' +
          '<span class="token-bal">🪙 Buy in <strong id="token-buyin-val">' + fmt(dflt) + '</strong></span>' +
          '<input id="token-buyin-slider" class="token-slider" type="range" min="1" max="' + maxBal + '" step="1" value="' + dflt + '" aria-label="Buy-in amount in dollars" />' +
          '<button id="token-buyin-max" class="btn btn-ghost token-btn" type="button">Max</button>' +
          '<button id="token-buyin-btn" class="btn btn-primary token-btn"' + (busy ? " disabled" : "") + '>' + (busy ? "…" : "Buy in") + '</button>' +
          '</div>';
        var sl = $("token-buyin-slider"), lbl = $("token-buyin-val");
        if (sl && lbl) sl.oninput = function () { _sliderDragging = true; amt.buyin = parseFloat(sl.value) || 1; lbl.textContent = fmt(sl.value); }; // #18: mark drag (see render guard)
        var mx = $("token-buyin-max"); if (mx) mx.onclick = function () { if (sl) { sl.value = maxBal; amt.buyin = maxBal; if (lbl) lbl.textContent = fmt(maxBal); } };
        var b = $("token-buyin-btn"); if (b) b.onclick = function () { TokenMode.buyIn(parseFloat((sl && sl.value) || dflt)); };
      }
    }
  }

  root.TokenMode = TokenMode;
})(typeof window !== "undefined" ? window : this);
