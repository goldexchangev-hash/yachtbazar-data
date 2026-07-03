/* ============================================================
   blackjack-ui.js — the client controller. Renders the live lobby and the felt
   table from server snapshots, sends intents, runs a skew-free countdown, and
   verifies the provably-fair shoe in-browser. Server is authoritative; this file
   never decides an outcome — it displays state and forwards intents.

   Supports the full action set: a seat can hold 1..4 hands (splits); the dock
   shows HIT/STAND/DOUBLE/SPLIT/SURRENDER per the server's legal set, plus an
   INSURANCE prompt when the dealer shows an Ace.
   ============================================================ */
(function (root) {
  "use strict";
  var SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };
  var RED = { H: 1, D: 1 };
  var ETH_USD = 3400;
  var PHASE_TOTAL = { betting: 15000, turns: 20000, insurance: 12000 };
  var ACT_LABEL = { hit: "HIT", stand: "STAND", double: "DOUBLE", split: "SPLIT", surrender: "SURRENDER" };
  var ACT_CLASS = { hit: "hit", stand: "stand", double: "double", split: "split", surrender: "surrender" };

  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function rankLabel(r) { return r === "T" ? "10" : r; }
  function money(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function eth(n) { return "≈ Ξ" + (n / ETH_USD).toFixed(4); } // ETH equivalent of the USD amount (demo rate $3400/ETH)
  function isWallet(w) { return /^0x[0-9a-fA-F]{6,}/.test(w || ""); } // a real connected wallet (not a guest/demo id)
  function shortHash(h) { return h ? h.slice(0, 10) + "…" : "—"; }

  function BlackjackClient(opts) {
    this.E = opts.els;
    this.embed = !!opts.embed; // TV-channel mode: no lobby, auto-join one table, felt+dock pre-mounted
    this.joinTable = opts.joinTable || null; // a specific shared table to sit at (from a share link)
    this._seedBalance = (opts.seedBalance != null && isFinite(opts.seedBalance)) ? opts.seedBalance : null; // demo balance to sync the table to
    this.wallet = opts.wallet || null;
    this.bjToken = opts.bjToken || "";
    this.bjSession = opts.bjSession || ""; // token-bridge session id ⇒ chips ARE the player's tokens
    this.showEth = isWallet(this.wallet); // ETH amounts only matter once a real wallet is connected
    this.net = opts.net || new root.BJNet({ wallet: this.wallet, bjToken: this.bjToken, bjSession: this.bjSession });
    this.view = this.embed ? "table" : "lobby";
    this.you = null; this.spectating = null;
    this.room = null; this.legal = []; this.activeHand = -1;
    this.balance = null; this.bet = 10;
    this.skew = 0; this.deadline = 0; this.phaseTotal = 0;
    this.seen = {}; this.holeShown = false; this.handNo = -1;
    this.reveal = null; this._insuranceDone = false;
    this._connectedOnce = false; this._reconnectRoom = null; this._stagger = 0; this._sfxReady = false;
    this._bindNet(); this._wireStatic();
    if (this.embed) { if (this.net._open) { this._connectedOnce = true; this._autoJoin(); } } // auto-seat at a live table
    else this.net.send({ type: "bj:lobby:subscribe" });
    var self = this; this._timer = setInterval(function () { self._tick(); }, 200);
  }
  // embed: drop straight into an open table (or a fresh one) — no lobby to pick from.
  // If we arrived via a share link, sit at that SPECIFIC table the first time (so
  // friends land together); after that, fall back to any open table.
  BlackjackClient.prototype._autoJoin = function () {
    this._resetRoundVis(); this._sfxReady = false;
    // seed our demo table balance BEFORE taking a seat so betMax is right from the start
    if (this._seedBalance != null) { this.net.send({ type: "bj:seed", balance: this._seedBalance }); }
    var room = this.joinTable; this.joinTable = null;
    this.net.send({ type: "bj:room:join", roomId: room || undefined });
  };
  // Cancel a placed bet before the deal (refunds it to your balance).
  BlackjackClient.prototype.cancelBet = function () { this.net.send({ type: "bj:bet:cancel" }); };
  BlackjackClient.prototype.topUp = function (amount) { this.net.send({ type: "bj:topup", amount: Math.max(0, +amount || 0) }); };
  // v6 #29: the parent posts the LIVE ETH/USD (piggybacked on bj:active) so the felt's "≈ Ξ" labels aren't
  // stuck at the hardcoded $3400. Cosmetic only — ETH_USD is never used in any bet/settle/balance math.
  BlackjackClient.prototype.setRate = function (u) { u = +u; if (u > 0 && isFinite(u)) ETH_USD = u; };
  // Mobile resume: when the tab comes back, make sure the socket is alive and pull a
  // fresh table snapshot so a stale (frozen-while-backgrounded) state can't block betting.
  BlackjackClient.prototype.resume = function () {
    if (!this.net) return;
    this.net.ensureConnected();
    if (this.embed && this.net._open) { if (this.you) this.net.send({ type: "bj:room:join", roomId: this.you.roomId }); else this._autoJoin(); }
  };

  /* ---------------- net ---------------- */
  BlackjackClient.prototype._bindNet = function () {
    var self = this;
    // a transient drop reconnects on a fresh socket (the server gave our seat away),
    // so on reconnect re-subscribe + try to rejoin the table instead of stranding.
    this.net.on("bj:net", function (m) {
      if (m.state === "open") { self._setNetBanner(false); if (self._connectedOnce) self._onReconnect(); else if (self.embed) self._autoJoin(); self._connectedOnce = true; }
      else if (m.state === "closed") { self._setNetBanner(true); } // socket down (e.g. server restart) — show a clear status instead of a silent blank felt
    });
    this.net.on("bj:lobby:list", function (m) { self.renderLobby(m.rooms); });
    this.net.on("bj:wallet", function (m) { self.balance = m.balance; self._renderBalance(); self._renderDock(); }); // push the new balance to the dock immediately
    this.net.on("bj:room:snapshot", function (m) {
      if (m.you) { self.you = { roomId: m.you.roomId, seat: m.you.seat }; self.spectating = null; if (m.you.balance != null) { self.balance = m.you.balance; self._renderBalance(); } }
      self._onSnapshot(m);
    });
    this.net.on("bj:turn", function (m) { self._clearActWatch(); if (self.you && m.seat === self.you.seat) { self.legal = m.legalActions || []; self.needFunds = m.needFunds || []; self.handBet = m.bet || 0; self.activeHand = m.hand; self._dockSig = null; } self._renderDock(); });
    this.net.on("bj:insurance:offer", function () { self._insuranceDone = false; self._renderDock(); });
    this.net.on("bj:insurance:result", function (m) { self.toast(m.dealerBlackjack ? "Dealer had blackjack — insurance pays" : "No dealer blackjack — insurance off"); });
    this.net.on("bj:settle", function (m) { self._onSettle(m); });
    this.net.on("bj:reveal", function (m) { self.reveal = m; self._renderPF(); });
    this.net.on("bj:event", function (m) {
      if (m.kind === "roomClosing" && self.room && m.id === self.room.roomId) { self.toast("Table closed (" + (m.reason || "idle") + ")"); self.showLobby(); }
      if (m.kind === "bust" && self.room) self._flashSeat(m.seat);
      // v5 #21: the server bounced us off a table we don't match (e.g. a guest opening a real-money table
      // link) — it silently sent us to the lobby with no explanation. Surface it so the redirect makes sense.
      if (m.kind === "kindMismatch") { self.toast("That table is for " + (m.tableKind === "real" ? "real-money (token)" : "demo") + " players — showing tables you can join"); self.showLobby(); } // v6 #17: server sends "real"/"demo", never "token" — the old check was dead
    });
    this.net.on("bj:error", function (m) {
      self._clearActWatch();
      // a failed reconnect-rejoin (table full / gone) → fall back to the lobby cleanly
      if (self._reconnectRoom && (m.intent === "join" || m.code === "table_full" || m.code === "no_room" || m.code === "lobby_full")) { self._reconnectRoom = null; self.toast("Reconnected — pick a table to jump back in"); self.showLobby(); return; }
      if (self.embed && m.code === "auth_required") self._emitDockError(m.msg || m.message || "Lock credits before joining blackjack");
      // restore controls on rejection: force a dock rebuild from the still-intact legal set
      self.toast(m.msg || "Error", true); self._dockSig = null; self._renderDock();
    });
  };

  // Connection banner: shown while the socket is DOWN (e.g. a server restart/cold-start) so the
  // felt never just sits blank looking broken — it clearly says it's reconnecting. Auto-hidden the
  // moment the socket reopens (the reconnect logic above re-subscribes + rejoins the table).
  BlackjackClient.prototype._setNetBanner = function (show) {
    var el = document.getElementById("bj-net-banner");
    if (show) {
      if (!el) {
        el = document.createElement("div");
        el.id = "bj-net-banner";
        el.style.cssText = "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483646;background:rgba(10,16,28,.94);color:#ffd23f;border:1px solid rgba(255,210,63,.55);border-radius:12px;padding:9px 18px;font:800 14px system-ui,-apple-system,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.55);white-space:nowrap;pointer-events:none";
        el.textContent = "📡 Reconnecting to the table…";
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.display = "block";
    } else if (el) { el.style.display = "none"; }
  };

  BlackjackClient.prototype._wireStatic = function () {
    var self = this, E = this.E;
    if (E.balEth && !this.showEth) E.balEth.style.display = "none"; // demo: hide ETH until a wallet connects
    if (E.back) E.back.onclick = function () { self.leaveTable(); };
    if (E.pfVerify) E.pfVerify.onclick = function () { self._verify(); };
    if (E.soundBtn) E.soundBtn.onclick = function () {
      var sfx = root.BlackjackSFX; if (!sfx) return;
      sfx.muted = !sfx.muted; E.soundBtn.textContent = sfx.muted ? "🔇" : "🔊";
      if (!sfx.muted) sfx.card(0); // little confirmation blip when turning on
    };
    if (E.tables) E.tables.addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]"); if (!b) return;
      var act = b.getAttribute("data-act"), room = b.getAttribute("data-room");
      if (act === "join") self.joinRoom(room); else if (act === "watch") self.watchRoom(room);
    });
    if (E.seats) E.seats.addEventListener("click", function (e) {
      var b = e.target.closest("[data-take]"); if (!b) return; self.takeSeat(+b.getAttribute("data-take"));
    });
  };

  /* ---------------- lobby ---------------- */
  BlackjackClient.prototype.showLobby = function () {
    if (this.embed) { this.you = null; this.spectating = null; this.room = null; this.legal = []; this._autoJoin(); return; } // embed: no lobby — hop to another table
    this.view = "lobby"; this.you = null; this.spectating = null; this.room = null; this.legal = [];
    this.E.lobby.classList.remove("hidden"); this.E.table.classList.add("hidden");
    this.net.send({ type: "bj:lobby:subscribe" });
  };
  BlackjackClient.prototype.showTable = function () { this.view = "table"; if (!this.embed) { this.E.lobby.classList.add("hidden"); this.E.table.classList.remove("hidden"); } this._tryGL(); };
  // tier gate: light up the ambient WebGL layer once the table is visible (graceful fallback to CSS felt)
  BlackjackClient.prototype._tryGL = function () {
    if (this._glStarted || !root.BlackjackGL || !this.E.glCanvas) return;
    try { if (root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch (e) {}
    var self = this;
    setTimeout(function () { // let the table lay out so the canvas has a size
      if (self._glStarted) return;
      var ok = root.BlackjackGL.start(self.E.glCanvas);
      if (ok) { self._glStarted = true; self.E.glCanvas.classList.add("on"); if (root.BlackjackGL._resize) setTimeout(root.BlackjackGL._resize, 80); }
    }, 50);
  };
  BlackjackClient.prototype.renderLobby = function (rooms) {
    if (this.view !== "lobby") return;
    var grid = this.E.tables; grid.innerHTML = "";
    if (!rooms || !rooms.length) { grid.appendChild(el("div", "empty-note", "Spinning up the first table…")); return; }
    rooms.forEach(function (r) {
      var card = el("div", "tcard");
      var phase = r.inProgress ? "live" : (r.openSeats ? "open" : "idle");
      var badge = r.inProgress ? "IN PLAY" : (r.seated ? "WAITING" : "OPEN");
      card.appendChild(el("div", "tname", r.name));
      var trow = el("div", "trow");
      trow.appendChild(el("span", "badge " + phase, badge));
      trow.appendChild(el("span", "badge", r.seated + "/4 seated"));
      card.appendChild(trow);
      var dots = el("div", "seat-dots");
      for (var i = 0; i < 4; i++) { var taken = i < r.seated; dots.appendChild(el("i", taken ? "taken" : "open", taken ? "♠" : "+")); }
      card.appendChild(dots);
      var meta = el("div", "meta");
      meta.innerHTML = "<span>👥 <b>" + r.spectators + "</b> watching</span><span>💰 <b>" + money(r.tableBet) + "</b> on felt</span>";
      card.appendChild(meta);
      var cta = el("div", "cta");
      var join = el("button", "chip join", r.openSeats ? "JOIN" : "FULL");
      if (!r.openSeats) join.disabled = true; else { join.setAttribute("data-act", "join"); join.setAttribute("data-room", r.id); }
      var watch = el("button", "chip watch", "WATCH");
      watch.setAttribute("data-act", "watch"); watch.setAttribute("data-room", r.id);
      cta.appendChild(join); cta.appendChild(watch); card.appendChild(cta);
      grid.appendChild(card);
    });
  };

  /* ---------------- intents ---------------- */
  BlackjackClient.prototype.joinRoom = function (roomId) { this._resetRoundVis(); this._sfxReady = false; this.showTable(); this.E.dockMsg.textContent = "Taking a seat…"; this.net.send({ type: "bj:room:join", roomId: roomId }); };
  BlackjackClient.prototype.takeSeat = function (seat) { this._sfxReady = false; this.net.send({ type: "bj:room:join", roomId: this.room ? this.room.roomId : undefined, seatPref: seat }); };
  BlackjackClient.prototype.watchRoom = function (roomId) { this._resetRoundVis(); this._sfxReady = false; this.spectating = roomId; this.showTable(); this.E.dockMsg.textContent = "Joining as spectator…"; this.net.send({ type: "bj:room:watch", roomId: roomId }); };
  BlackjackClient.prototype.leaveTable = function () { if (this.you || this.spectating) this.net.send({ type: "bj:room:leave" }); this.showLobby(); };
  BlackjackClient.prototype.placeBet = function () {
    var amt = Math.max(10, Math.round(+this.bet || 0));
    var seed = (this.E.pfClient && this.E.pfClient.value.trim()) || "";
    this.net.send({ type: "bj:bet:place", amountUsd: amt, clientSeed: seed || undefined });
  };
  BlackjackClient.prototype._onReconnect = function () {
    this._sfxReady = false; // don't replay the whole hand's cards as sound on rejoin
    if (this.embed) { this._autoJoin(); return; } // embed: just hop back onto a table
    this.net.send({ type: "bj:lobby:subscribe" });
    if (this.you) { this._reconnectRoom = this.you.roomId; this.toast("Reconnecting…"); this.net.send({ type: "bj:room:join", roomId: this._reconnectRoom }); }
    else if (this.spectating) { this.net.send({ type: "bj:room:watch", roomId: this.spectating }); }
  };
  BlackjackClient.prototype.act = function (action) {
    this.net.send({ type: "bj:action", action: action });
    // disable buttons to prevent a double-send, but KEEP this.legal so a server
    // rejection (bj:error) can restore the same controls — no lockout until auto-stand.
    var btns = this.E.dockRow.querySelectorAll(".btn"); for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    // WATCHDOG: if NO server response (snapshot/turn/settle/error) arrives within 7s after our
    // action, the socket/server likely died mid-hand — pull a fresh snapshot so the felt + dock
    // recover instead of freezing forever. Cleared by _clearActWatch on any of those messages.
    var self = this; clearTimeout(this._actWatch);
    this._actWatch = setTimeout(function () { try { self.resume(); } catch (e) {} }, 7000);
  };
  BlackjackClient.prototype._clearActWatch = function () { if (this._actWatch) { clearTimeout(this._actWatch); this._actWatch = null; } };
  BlackjackClient.prototype.sendInsurance = function (take) { this._insuranceDone = true; this.net.send({ type: "bj:insurance", take: !!take }); this._renderDock(); };

  /* ---------------- snapshot render ---------------- */
  BlackjackClient.prototype._resetRoundVis = function () { this.seen = {}; this.holeShown = false; this._insuranceDone = false; this._mySettle = null; this.handBet = 0; this.legal = []; this.needFunds = []; }; // v7 #1: clear handBet/legal/needFunds between rounds — a stale handBet>0 pinned the parent's bjDockLive=true forever, blocking the token felt from re-binding a buy-in
  BlackjackClient.prototype._onSnapshot = function (m) {
    this._clearActWatch(); // a fresh server state arrived → our last action was processed
    if (this.view !== "table") this.showTable();
    this._reconnectRoom = null; // a snapshot means we're live again
    if (m.handNumber !== this.handNo) { this.handNo = m.handNumber; this._resetRoundVis(); this.reveal = null; }
    this.room = m;
    // EMA-smooth the client/server clock skew so the countdown can't jitter from
    // per-snapshot network noise (recomputing it raw every snapshot made it twitch).
    var rawSkew = (m.serverNow || Date.now()) - Date.now();
    this.skew = this._skewSet ? Math.round(this.skew * 0.8 + rawSkew * 0.2) : rawSkew; this._skewSet = true;
    this.deadline = m.deadline || 0;
    this.phaseTotal = PHASE_TOTAL[m.phase] || 0;
    this._stagger = 0; // stagger newly-dealt cards within THIS snapshot for a one-at-a-time reveal
    this._renderDealer(m); this._renderSeats(m); this._renderBanner(m); this._renderDock(); this._renderPF();
    this._sfxReady = true; // suppress sounds on the first (sync) snapshot; play on real deals after
  };
  BlackjackClient.prototype._cardEl = function (c, key, sm, faceDownFlip) {
    if (!c || c === "back") return el("div", "card back" + (sm ? " sm" : ""));
    var d = el("div", "card " + (RED[c.suit] ? "red" : "black") + (sm ? " sm" : ""));
    var s = SUIT[c.suit], r = rankLabel(c.rank);
    d.innerHTML = '<span class="corner"><span class="r">' + r + '</span><span class="s">' + s + '</span></span>' +
      '<span class="pip">' + s + '</span><span class="corner br"><span class="r">' + r + '</span><span class="s">' + s + '</span></span>';
    if (key && !this.seen[key]) {
      this.seen[key] = 1; d.classList.add(faceDownFlip ? "flip" : "dealing");
      var delay = (this._stagger || 0) * 150; if (delay) d.style.animationDelay = delay + "ms"; // cascade the deal
      this._stagger = (this._stagger || 0) + 1;
      if (this._sfxReady && root.BlackjackSFX) root.BlackjackSFX.card(delay); // swoosh + snap, in sync with the reveal
    }
    return d;
  };
  BlackjackClient.prototype._totalPill = function (h) {
    if (!h || h.total == null) return null;
    var cls = "total-pill", txt = String(h.total);
    if (h.blackjack) { cls += " bj"; txt = "BJ"; }
    else if (h.bust) { cls += " bust"; }
    else if (h.soft) { cls += " soft"; }
    return el("span", cls, txt);
  };
  BlackjackClient.prototype._renderDealer = function (m) {
    var host = this.E.dealerHand; host.innerHTML = "";
    var d = m.dealer || { cards: [] }, stack = el("div", "stack");
    var holeNow = !d.holeHidden;
    for (var i = 0; i < d.cards.length; i++) stack.appendChild(this._cardEl(d.cards[i], "d:" + i, false, i === 1 && holeNow && !this.holeShown));
    if (d.holeHidden) stack.appendChild(this._cardEl("back", null, false));
    host.appendChild(stack);
    if (holeNow && d.cards.length > 1) this.holeShown = true;
    this.E.dealerTotal.innerHTML = "";
    if (d.total != null) this.E.dealerTotal.appendChild(el("span", "total-pill dealer-total-pill" + (d.total > 21 ? " bust" : ""), "Dealer " + String(d.total)));
    else if (d.cards && d.cards.length) {
      var up = BlackjackRules.handValue([d.cards[0]]);
      this.E.dealerTotal.appendChild(el("span", "total-pill dealer-total-pill upcard", "Showing " + String(up.total)));
    }
    this.E.shoe.innerHTML = "Hand <code>#" + (m.handNumber || 0) + "</code><br>commit <code>" + shortHash(m.commit) + "</code>";
  };
  var CHIP_DENOMS = [[1000, "#eaf2ff"], [500, "#ffd23f"], [100, "#ff4d9d"], [25, "#45f0a6"], [10, "#39e7ff"]];
  BlackjackClient.prototype._chipStack = function (value) {
    var stack = el("div", "chipstack"); var chips = []; var v = Math.round(value);
    for (var d = 0; d < CHIP_DENOMS.length; d++) while (v >= CHIP_DENOMS[d][0]) { chips.push(CHIP_DENOMS[d]); v -= CHIP_DENOMS[d][0]; }
    var show = chips.slice(0, 5); // largest denoms at the bottom; cap visible
    for (var i = 0; i < show.length; i++) { var c = el("div", "chip3d", '<span class="v">' + show[i][0] + "</span>"); c.style.setProperty("--cc", show[i][1]); c.style.bottom = (i * 4) + "px"; stack.appendChild(c); }
    if (chips.length > 5) stack.appendChild(el("div", "chip-pill", "×" + chips.length));
    return stack;
  };
  BlackjackClient.prototype._betPill = function (value, doubled) {
    return el("div", "bet-pill", money(value) + (doubled ? " ²" : "") + (this.showEth ? ' <span class="e">' + eth(value) + "</span>" : ""));
  };
  BlackjackClient.prototype._renderSeats = function (m) {
    var host = this.E.seats; host.innerHTML = "";
    var occupied = 0;
    for (var oi = 0; oi < 4; oi++) if (m.seats[oi]) occupied++;
    host.className = "seats seat-count-" + occupied;
    for (var i = 0; i < 4; i++) {
      var s = m.seats[i], seat = el("div", "seat");
      var mine = this.you && this.you.seat === i;
      var seatTurn = m.phase === "turns" && m.turnIdx === i;
      seat.setAttribute("data-seat", String(i + 1));
      if (mine) seat.classList.add("you");
      if (s) seat.classList.add("occupied");
      if (seatTurn) {
        seat.classList.add("turn"); // spotlight the active seat (kept in the TV; the countdown is not)
        if (!this.embed) { // TV channel: the turn countdown lives UNDER the TV, not on the felt
          var stm = el("div", "seat-timer"); // countdown on whoever's turn it is (updated by _tick)
          stm.setAttribute("data-sec", Math.max(0, Math.ceil((this.deadline - (Date.now() + this.skew)) / 1000)));
          seat.appendChild(stm);
        }
      }
      if (!s) {
        seat.classList.add("empty");
        if (this.you == null) { var take = el("button", "take", "SIT HERE"); take.setAttribute("data-take", i); seat.appendChild(take); }
        else seat.appendChild(el("div", "seatno", "Seat " + (i + 1)));
        host.appendChild(seat); continue;
      }
      var hands = s.hands || [];
      if (hands.length === 0) {
        if (s.baseBet > 0) { seat.appendChild(this._chipStack(s.baseBet)); seat.appendChild(this._betPill(s.baseBet)); }
        else seat.appendChild(el("div", "seatno", "—"));
      } else {
        var wrap = el("div", "hands" + (hands.length > 1 ? " multi" : ""));
        for (var hi = 0; hi < hands.length; hi++) {
          var h = hands[hi], hb = el("div", "hand-box" + (seatTurn && s.active === hi ? " active" : "") + (h.result && (h.result.outcome === "win" || h.result.outcome === "blackjack") ? " won" : ""));
          var stack = el("div", "stack");
          for (var c = 0; c < (h.cards || []).length; c++) stack.appendChild(this._cardEl(h.cards[c], "p" + i + ":" + hi + ":" + c, false)); // full-size; splits shrink via .multi CSS
          hb.appendChild(stack);
          var pill = this._totalPill(h); if (pill) hb.appendChild(pill);
          if (h.result) {
            var oc = h.result.outcome, b = el("div", "result-badge " + oc);
            var dl = h.result.delta, dtxt = dl > 0 ? "+" + money(dl) : (dl < 0 ? "-" + money(-dl) : "±0");
            b.innerHTML = (oc === "blackjack" ? "BJ" : oc.toUpperCase()) + ' <span class="d">' + dtxt + "</span>";
            hb.appendChild(b);
          } else { hb.appendChild(this._betPill(h.bet, h.doubled)); }
          wrap.appendChild(hb);
        }
        seat.appendChild(wrap);
      }
      var name = mine ? '<span class="me">YOU</span>' : this._name(s.wallet);
      if (s.insurance > 0) name += ' <span class="ins-tag">INS ' + money(s.insurance) + "</span>";
      seat.appendChild(el("div", "nameplate", name));
      host.appendChild(seat);
    }
  };
  // v5 #1 (defense-in-depth): _name() output is concatenated into seat-nameplate HTML (innerHTML via el()).
  // The server now pins guest ids to /^guest:[a-z0-9]{1,32}$/, but we ALSO HTML-escape every user-controlled
  // branch here so a malformed wallet/guest string can never inject markup even if it slips past the server.
  function escHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  BlackjackClient.prototype._name = function (w) {
    if (!w) return "Player";
    if (/^0x[0-9a-fA-F]{6,}$/.test(w)) return w.slice(0, 6) + "…" + w.slice(-4); // hex only — inherently safe
    if (w.indexOf("guest:") === 0) return "Guest " + escHtml(w.slice(6));
    return escHtml(w.length > 12 ? w.slice(0, 12) + "…" : w);
  };

  /* ---------------- banner + countdown ---------------- */
  BlackjackClient.prototype._renderBanner = function (m) {
    if (this.embed) return; // TV channel: no in-screen banner — the status lives under the TV
    var main = "", sub = "";
    switch (m.phase) {
      case "idle": main = "WAITING"; sub = "Place a bet to start the hand"; break;
      case "betting": main = "PLACE YOUR BETS"; break;
      case "dealing": main = "DEALING"; break;
      case "insurance": main = "INSURANCE?"; sub = "Dealer shows an Ace"; break;
      case "turns": break;
      case "dealer": main = "DEALER PLAYS"; break;
      case "settle": main = "ROUND OVER"; sub = "Next hand shortly…"; break;
    }
    this.E.phaseMain.textContent = main; this.E.phaseSub.textContent = sub;
    // ONLY show the center banner during betting/idle (no dealer cards then, so it can't
    // overlap the dealer's total). Once cards are out, the dock message carries the status
    // ("Dealer is playing…", "✅ You win +$X") and the win FX carries the drama — no banner,
    // no overlap, ever.
    this.E.phaseBanner.style.display = (m.phase === "betting" || m.phase === "idle") ? "block" : "none";
    this.E.phaseBanner.style.top = "32%";
  };
  BlackjackClient.prototype._tick = function () {
    if (this.embed) return; // TV channel: countdowns render under the TV (parent), not in the felt
    var m = this.room, E = this.E;
    var remaining = m ? Math.max(0, this.deadline - (Date.now() + this.skew)) : 0;
    // center ring — betting only (it has room up top; later phases place text low instead)
    if (E.ring) {
      if (m && this.phaseTotal && m.phase === "betting") {
        E.ring.style.display = "grid";
        var sec = Math.ceil(remaining / 1000), pct = Math.max(0, Math.min(100, (remaining / this.phaseTotal) * 100));
        E.ring.style.setProperty("--p", pct.toFixed(1)); E.ring.setAttribute("data-sec", sec);
        E.ring.className = "ring" + (sec <= 3 ? " crit" : (sec <= 6 ? " warn" : ""));
      } else E.ring.style.display = "none";
    }
    // per-seat turn countdown — live-updates the ring on whoever's seat is active
    var seatTimer = E.seats ? E.seats.querySelector(".seat-timer") : null;
    if (seatTimer && m && m.phase === "turns") {
      var total = PHASE_TOTAL.turns || 20000;
      var s2 = Math.ceil(remaining / 1000), pct2 = Math.max(0, Math.min(100, (remaining / total) * 100));
      seatTimer.style.setProperty("--p", pct2.toFixed(1)); seatTimer.setAttribute("data-sec", s2);
      seatTimer.className = "seat-timer" + (s2 <= 3 ? " crit" : (s2 <= 6 ? " warn" : ""));
    }
  };

  /* ---------------- control dock ---------------- */
  BlackjackClient.prototype._renderDock = function () {
    var m = this.room, E = this.E, self = this; if (!m) return;
    var seated = !!this.you, mySeat = seated ? m.seats[this.you.seat] : null;
    var isMyTurn = seated && m.phase === "turns" && m.turnIdx === this.you.seat;
    var iBet = !!(mySeat && mySeat.baseBet > 0);
    var insurePhase = seated && m.phase === "insurance" && iBet && !this._insuranceDone;

    var msg = "";
    if (!seated) msg = "Spectating · click an open seat to play";
    else if (m.phase === "betting") msg = iBet ? ("Bet placed <b>" + money(mySeat.baseBet) + "</b> · waiting for the deal…") : "Place your bet to be dealt in";
    else if (m.phase === "insurance") msg = insurePhase ? "<b>Insurance?</b> costs half your bet, pays 2:1 if the dealer has blackjack" : "Waiting on insurance…";
    else if (m.phase === "turns") msg = isMyTurn ? ("<b>Your move</b>" + (mySeat.hands.length > 1 ? " · hand " + (this.activeHand + 1) + "/" + mySeat.hands.length : "")) : ("Seat " + (m.turnIdx + 1) + " is deciding…");
    else if (m.phase === "dealing" || m.phase === "dealer") msg = "Dealer is playing…";
    else if (m.phase === "settle") msg = this._settleMsg(mySeat);
    else msg = "Waiting for the next hand…";
    if (E.dockMsg.innerHTML !== msg) E.dockMsg.innerHTML = msg; // idempotent: dock-msg is aria-live — identical rewrites must not re-announce
    if (this.embed) this._emitDock(m, seated, mySeat, isMyTurn, iBet, insurePhase, msg); // TV channel: controls live in the parent dock

    var sig = (seated ? "S" : "X") + "|" + m.phase + "|" + (isMyTurn ? 1 : 0) + "|" + (iBet ? 1 : 0) + "|" + (insurePhase ? 1 : 0) + "|" + this.legal.join(",");
    if (sig === this._dockSig) {
      if (isMyTurn) for (var k in ACT_LABEL) { var bb = E.dockRow.querySelector(".btn." + (ACT_CLASS[k]) + "[data-a=" + k + "]"); if (bb) bb.disabled = this.legal.indexOf(k) < 0; }
      return;
    }
    this._dockSig = sig;
    var row = E.dockRow; row.innerHTML = "";
    if (!seated) { var back = el("button", "btn ghost", "BACK TO LOBBY"); back.onclick = function () { self.leaveTable(); }; row.appendChild(back); return; }
    if (insurePhase) {
      var yes = el("button", "btn primary", "INSURE ½"); yes.onclick = function () { self.sendInsurance(true); };
      var no = el("button", "btn ghost", "NO"); no.onclick = function () { self.sendInsurance(false); };
      row.appendChild(yes); row.appendChild(no); return;
    }
    if (m.phase === "betting" && !iBet) this._betUI(row);
    else if (isMyTurn) {
      ["hit", "stand", "double", "split", "surrender"].forEach(function (a) {
        if (self.legal.indexOf(a) < 0) return;
        var btn = el("button", "btn " + ACT_CLASS[a], ACT_LABEL[a]); btn.setAttribute("data-a", a);
        btn.onclick = function () { self.act(a); }; row.appendChild(btn);
      });
    }
    // LEAVE only while you can actually act on it — hidden during the dealer draw and
    // the win/lose result (use the top ↩ LOBBY button to step out there).
    if (!this.embed && (m.phase === "betting" || m.phase === "turns" || m.phase === "insurance" || m.phase === "idle")) {
      var leave = el("button", "btn danger", "LEAVE"); leave.onclick = function () { self.leaveTable(); }; row.appendChild(leave); // (no LEAVE in the TV channel — you switch channels)
    }
  };
  // EMBED (TV channel): the felt lives in the iframe, but the controls live in the
  // parent page's action-dock — native site buttons, docked under the TV. Push a
  // compact dock-state to the parent on every render; it builds the matching controls
  // and posts intents back (bj:cmd), which the page forwards to this same client.
  // One source of truth (the server-driven client) + controls that match the site.
  BlackjackClient.prototype._emitDock = function (m, seated, mySeat, isMyTurn, iBet, insurePhase, msg) {
    var self = this, mode = "waiting";
    if (!seated) mode = "spectating";
    else if (m.phase === "betting" && !iBet) mode = "betting";
    else if (m.phase === "betting" && iBet) mode = "betplaced"; // bet locked in — offer a Remove until the deal
    else if (insurePhase) mode = "insurance";
    else if (isMyTurn) mode = "turn";
    else if (m.phase === "dealing" || m.phase === "dealer") mode = "dealing";
    else if (m.phase === "settle") mode = "settle";
    // v5 #20: until the real balance arrives (first bj:wallet after seating), DON'T render a betting slider
    // built off a fabricated $1,000 — a $50 buy-in could then pick $200 and the server would reject the bet.
    // Hold in "waiting" (no bet UI) for that brief window; the slider appears once we know the true balance.
    var balReady = (this.balance != null && isFinite(this.balance));
    if (!balReady && mode === "betting") mode = "waiting";
    var rawBalance = balReady ? this.balance : 0;
    var maxBet = Math.max(0, Math.floor(rawBalance / 5) * 5); // floor to the $5 step so both ends agree
    this.bet = maxBet >= 10 ? Math.min(Math.max(10, Math.round(this.bet / 5) * 5), maxBet) : 10; // mirror _betUI normalization
    var legal = []; ["hit", "stand", "double", "split", "surrender"].forEach(function (a) { if (self.legal.indexOf(a) >= 0) legal.push(a); });
    // one countdown for the controls under the TV: the whole betting window (pre- AND post-bet), or YOUR turn
    var countMsLeft = (this.deadline && (m.phase === "betting" || mode === "turn")) ? Math.max(0, this.deadline - (Date.now() + this.skew)) : null;
    var roomId = this.you ? this.you.roomId : (this.spectating || (this.room ? this.room.roomId : null));
    var needFunds = (isMyTurn && this.needFunds) ? this.needFunds : [];
    // settle stats (display-only, for the parent's profile ledger): my authoritative per-seat net
    // (folds in insurance) + the round stake — only present in settle mode.
    var settleNet = null, settleStake = 0;
    if (mode === "settle" && mySeat && mySeat.hands && mySeat.hands.length) {
      settleNet = (this._mySettle && this._mySettle.net != null) ? this._mySettle.net
        : mySeat.hands.reduce(function (a, h) { return a + (h.result ? h.result.delta : 0); }, 0);
      settleStake = this.handBet || mySeat.baseBet || 0;
    }
    var state = { type: "bj:dock", mode: mode, msg: msg, balance: this.balance, showEth: this.showEth,
      bet: this.bet, betMin: 10, betMax: maxBet, betStep: 5, legal: legal, countMsLeft: countMsLeft, roomId: roomId,
      needFunds: needFunds, handBet: this.handBet || 0,
      net: settleNet, stake: settleStake,
      placed: (mySeat && mySeat.baseBet > 0) ? mySeat.baseBet : 0 };
    try { if (root.parent && root.parent !== root) root.parent.postMessage(state, root.location.origin); } catch (e) {} // #24: same-origin target only
  };
  BlackjackClient.prototype._emitDockError = function (msg) {
    var state = { type: "bj:dock", mode: "waiting", msg: msg, balance: this.balance || 0, showEth: this.showEth,
      bet: this.bet || 25, betMin: 10, betMax: 0, betStep: 5, legal: [], countMsLeft: null, roomId: null,
      needFunds: [], handBet: 0, placed: 0 };
    try { if (root.parent && root.parent !== root) root.parent.postMessage(state, root.location.origin); } catch (e) {} // #24: same-origin target only
  };
  BlackjackClient.prototype._settleMsg = function (mySeat) {
    if (!mySeat || !mySeat.hands || !mySeat.hands.length) return "Round over";
    var anyBJ = false; for (var i = 0; i < mySeat.hands.length; i++) if (mySeat.hands[i].result && mySeat.hands[i].result.outcome === "blackjack") anyBJ = true;
    // authoritative per-seat net (folds in insurance) — falls back to hand deltas if absent
    var net = (this._mySettle && this._mySettle.net != null) ? this._mySettle.net : mySeat.hands.reduce(function (a, h) { return a + (h.result ? h.result.delta : 0); }, 0);
    if (anyBJ && net > 0) return "🃏 Blackjack! <b>+" + money(net) + "</b>";
    if (net > 0) return "✅ You win <b>+" + money(net) + "</b>";
    if (net < 0) return "❌ <b>-" + money(-net) + "</b>";
    return "➡ Push";
  };
  BlackjackClient.prototype._betUI = function (row) {
    var self = this; row.innerHTML = "";
    var rawBalance = (self.balance != null && isFinite(self.balance)) ? self.balance : 1000;
    var maxBet = Math.max(0, Math.floor(rawBalance / 5) * 5);
    if (maxBet < 10) { row.appendChild(el("div", "empty-note", "Add chips before placing a bet.")); return; }
    self.bet = Math.min(Math.max(10, Math.round(self.bet / 5) * 5), maxBet);
    var wrap = el("div", "bet-ui");
    var val = el("div", "bet-val");
    function renderVal() { val.innerHTML = '<span class="bv">' + money(self.bet) + "</span>" + (self.showEth ? '<span class="bv-eth">' + eth(self.bet) + "</span>" : ""); }
    renderVal();
    var slider = document.createElement("input"); slider.type = "range"; slider.className = "bet-slider";
    slider.min = "10"; slider.max = String(maxBet); slider.step = "5"; slider.value = String(self.bet);
    function fill() { var pct = ((self.bet - 10) / Math.max(1, maxBet - 10)) * 100; slider.style.setProperty("--fill", pct.toFixed(1) + "%"); }
    slider.oninput = function () { self.bet = Math.max(10, Math.round(+slider.value / 5) * 5); renderVal(); fill(); };
    fill();
    var chips = el("div", "qchips");
    [["$10", 10], ["$25", 25], ["$50", 50], ["$100", 100], ["MAX", maxBet]].forEach(function (c) {
      var b = el("button", "chip", c[0]); b.onclick = function () { self.bet = Math.min(maxBet, Math.max(10, Math.round(c[1] / 5) * 5)); slider.value = self.bet; renderVal(); fill(); }; chips.appendChild(b);
    });
    var place = el("button", "btn place", "PLACE BET"); place.onclick = function () { self.placeBet(); };
    wrap.appendChild(val); wrap.appendChild(slider); wrap.appendChild(chips); wrap.appendChild(place);
    row.appendChild(wrap);
  };

  /* ---------------- settle / fx ---------------- */
  BlackjackClient.prototype._onSettle = function (m) {
    this._clearActWatch();
    if (!this.you) return;
    var ps = null, list = m.perSeat || []; for (var i = 0; i < list.length; i++) if (list[i].seat === this.you.seat) ps = list[i];
    this._mySettle = ps || null; // authoritative net (includes insurance) for the dock banner
    if (ps && root.BlackjackFX && ps.net > 0) {
      var bj = ps.hands && ps.hands.some(function (h) { return h.outcome === "blackjack"; });
      root.BlackjackFX.celebrate(bj ? "blackjack" : "win", ps.net);
    }
  };
  BlackjackClient.prototype._flashSeat = function (seatIdx) { var n = this.E.seats.children[seatIdx]; if (n && n.animate) n.animate([{ filter: "brightness(2)" }, { filter: "brightness(1)" }], { duration: 380 }); };

  /* ---------------- balance / pf / toast ---------------- */
  BlackjackClient.prototype._renderBalance = function () {
    if (this.balance == null) return;
    if (this.E.balUsd) this.E.balUsd.textContent = money(this.balance);
    if (this.E.balEth) { if (this.showEth) { this.E.balEth.style.display = ""; this.E.balEth.textContent = eth(this.balance); } else this.E.balEth.style.display = "none"; }
  };
  // call when a wallet connects/disconnects so the ETH amounts appear/hide live
  BlackjackClient.prototype.setWallet = function (addr) {
    this.wallet = addr || null; this.showEth = isWallet(this.wallet);
    if (this.net) this.net.wallet = this.wallet;
    this._renderBalance(); this._dockSig = null; this._renderDock();
  };
  BlackjackClient.prototype._renderPF = function () {
    var E = this.E;
    if (E.pfCommit) E.pfCommit.textContent = (this.room && this.room.commit) ? this.room.commit : "—";
    if (E.pfReveal) E.pfReveal.textContent = this.reveal ? ("serverSeed " + this.reveal.serverSeed) : "";
  };
  BlackjackClient.prototype._verify = function () {
    var out = this.E.pfOut, S = root.BlackjackShuffle;
    if (!this.reveal || !S) { if (out) out.textContent = "Play a hand first, then verify the revealed seed."; return; }
    var rv = this.reveal, res = S.verify(rv.serverSeed, rv.commit, rv.clientSeeds || [], rv.shoeId, rv.decks || 6);
    var first = res.shoe.slice(0, 8).map(function (c) { return rankLabel(c.rank) + SUIT[c.suit]; }).join(" ");
    out.innerHTML = (res.hashOk ? "✅ commit verified — SHA256(serverSeed) matches." : "⚠ hash mismatch!") +
      '<br><span class="pf-reveal">shoe order (first 8): ' + first + "</span>";
  };
  BlackjackClient.prototype.toast = function (text, isErr) {
    var t = this.E.toast; if (!t) return; t.textContent = text; t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(this._toastT); var self = this; this._toastT = setTimeout(function () { t.className = "toast"; }, 2600);
  };

  root.BlackjackClient = BlackjackClient;
})(typeof window !== "undefined" ? window : this);
