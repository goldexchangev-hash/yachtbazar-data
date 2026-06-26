/* ============================================================
   blackjack-ui.js — the client controller. Renders the live lobby and the felt
   table from server snapshots, sends intents, runs a skew-free countdown, and
   verifies the provably-fair shoe in-browser. Server is authoritative; this
   file never decides an outcome — it only displays state and forwards intents.
   ============================================================ */
(function (root) {
  "use strict";
  var SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };
  var RED = { H: 1, D: 1 };
  var ETH_USD = 3400;
  var PHASE_TOTAL = { betting: 15000, turns: 20000 }; // for the ring fraction

  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function rankLabel(r) { return r === "T" ? "10" : r; }
  function money(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function eth(n) { return "Ξ" + (n / ETH_USD).toFixed(4); }
  function shortHash(h) { return h ? h.slice(0, 10) + "…" : "—"; }

  function BlackjackClient(opts) {
    this.E = opts.els;
    this.wallet = opts.wallet || null;
    this.net = opts.net || new root.BJNet({ wallet: this.wallet });
    this.view = "lobby";
    this.you = null;        // { roomId, seat } when seated
    this.spectating = null; // roomId when watching
    this.room = null;       // last snapshot
    this.legal = [];        // legal actions during my turn
    this.balance = null;
    this.bet = 10;
    this.skew = 0;          // serverNow - clientNow
    this.deadline = 0;
    this.phaseTotal = 0;
    this.seen = {};         // animation keys (cards already on felt)
    this.holeShown = false;
    this.handNo = -1;
    this.reveal = null;
    this._bindNet();
    this._wireStatic();
    this.net.send({ type: "bj:lobby:subscribe" });
    var self = this;
    this._timer = setInterval(function () { self._tick(); }, 200);
  }

  /* ---------------- net ---------------- */
  BlackjackClient.prototype._bindNet = function () {
    var self = this;
    this.net.on("bj:lobby:list", function (m) { self.renderLobby(m.rooms); });
    this.net.on("bj:wallet", function (m) { self.balance = m.balance; self._renderBalance(); });
    this.net.on("bj:room:snapshot", function (m) {
      if (m.you) { self.you = { roomId: m.you.roomId, seat: m.you.seat }; self.spectating = null; if (m.you.balance != null) { self.balance = m.you.balance; self._renderBalance(); } }
      self._onSnapshot(m);
    });
    this.net.on("bj:turn", function (m) { if (self.you && m.seat === self.you.seat) { self.legal = m.legalActions || []; } self._renderDock(); });
    this.net.on("bj:settle", function (m) { self._onSettle(m); });
    this.net.on("bj:reveal", function (m) { self.reveal = m; self._renderPF(); });
    this.net.on("bj:event", function (m) {
      if (m.kind === "roomClosing" && self.room && m.id === self.room.roomId) { self.toast("Table closed (" + (m.reason || "idle") + ")"); self.showLobby(); }
      if (m.kind === "bust" && self.room) self._flashBust(m.seat);
    });
    this.net.on("bj:error", function (m) { self.toast(m.msg || "Error", true); self._renderDock(); });
  };

  /* ---------------- static wiring ---------------- */
  // Delegated clicks on STABLE parents. The lobby/seats re-render on every server
  // push, so per-node onclick handlers race with re-renders (a click can land on a
  // node that was just replaced). Delegation binds once and survives re-renders.
  BlackjackClient.prototype._wireStatic = function () {
    var self = this, E = this.E;
    if (E.back) E.back.onclick = function () { self.leaveTable(); };
    if (E.pfVerify) E.pfVerify.onclick = function () { self._verify(); };
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
    this.view = "lobby"; this.you = null; this.spectating = null; this.room = null; this.legal = [];
    this.E.lobby.classList.remove("hidden"); this.E.table.classList.add("hidden");
    this.net.send({ type: "bj:lobby:subscribe" });
  };
  BlackjackClient.prototype.showTable = function () {
    this.view = "table"; this.E.lobby.classList.add("hidden"); this.E.table.classList.remove("hidden");
  };
  BlackjackClient.prototype.renderLobby = function (rooms) {
    if (this.view !== "lobby") return;
    var grid = this.E.tables, self = this; grid.innerHTML = "";
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
  BlackjackClient.prototype.joinRoom = function (roomId) { this._resetRoundVis(); this.showTable(); this.E.dockMsg.textContent = "Taking a seat…"; this.net.send({ type: "bj:room:join", roomId: roomId }); };
  BlackjackClient.prototype.takeSeat = function (seat) { this.net.send({ type: "bj:room:join", roomId: this.room ? this.room.roomId : undefined, seatPref: seat }); };
  BlackjackClient.prototype.watchRoom = function (roomId) { this._resetRoundVis(); this.spectating = roomId; this.showTable(); this.E.dockMsg.textContent = "Joining as spectator…"; this.net.send({ type: "bj:room:watch", roomId: roomId }); };
  BlackjackClient.prototype.leaveTable = function () { if (this.you || this.spectating) this.net.send({ type: "bj:room:leave" }); this.showLobby(); };
  BlackjackClient.prototype.placeBet = function () {
    var amt = Math.max(10, Math.round((+this.bet || 0)));
    var seed = (this.E.pfClient && this.E.pfClient.value.trim()) || "";
    this.net.send({ type: "bj:bet:place", amountUsd: amt, clientSeed: seed || undefined });
  };
  BlackjackClient.prototype.act = function (action) { this.net.send({ type: "bj:action", action: action }); this.legal = []; this._renderDock(); };

  /* ---------------- snapshot render ---------------- */
  BlackjackClient.prototype._resetRoundVis = function () { this.seen = {}; this.holeShown = false; };
  BlackjackClient.prototype._onSnapshot = function (m) {
    if (this.view !== "table") this.showTable();
    if (m.handNumber !== this.handNo) { this.handNo = m.handNumber; this._resetRoundVis(); this.reveal = null; }
    this.room = m; this.skew = (m.serverNow || Date.now()) - Date.now(); this.deadline = m.deadline || 0;
    this.phaseTotal = PHASE_TOTAL[m.phase] || 0;
    this._renderDealer(m); this._renderSeats(m); this._renderBanner(m); this._renderDock(); this._renderPF();
  };

  BlackjackClient.prototype._cardEl = function (c, key, sm, faceDownFlip) {
    if (!c || c === "back") { var b = el("div", "card back" + (sm ? " sm" : "")); return b; }
    var d = el("div", "card " + (RED[c.suit] ? "red" : "black") + (sm ? " sm" : ""));
    var s = SUIT[c.suit], r = rankLabel(c.rank);
    d.innerHTML = '<span class="corner"><span class="r">' + r + '</span><span class="s">' + s + '</span></span>' +
      '<span class="pip">' + s + '</span>' +
      '<span class="corner br"><span class="r">' + r + '</span><span class="s">' + s + '</span></span>';
    if (key && !this.seen[key]) { this.seen[key] = 1; d.classList.add(faceDownFlip ? "flip" : "dealing"); }
    return d;
  };
  BlackjackClient.prototype._totalPill = function (hv) {
    if (!hv || hv.total == null) return null;
    var cls = "total-pill", txt = String(hv.total);
    if (hv.blackjack) { cls += " bj"; txt = "BJ"; }
    else if (hv.bust) { cls += " bust"; }
    else if (hv.soft) { cls += " soft"; }
    return el("span", cls, txt);
  };
  BlackjackClient.prototype._renderDealer = function (m) {
    var host = this.E.dealerHand; host.innerHTML = "";
    var d = m.dealer || { cards: [] };
    var stack = el("div", "stack");
    var holeNowShown = !(d.holeHidden);
    for (var i = 0; i < d.cards.length; i++) {
      var flip = (i === 1 && holeNowShown && !this.holeShown);
      stack.appendChild(this._cardEl(d.cards[i], "d:" + i, false, flip));
    }
    if (d.holeHidden) stack.appendChild(this._cardEl("back", null, false));
    host.appendChild(stack);
    if (holeNowShown && d.cards.length > 1) this.holeShown = true;
    // dealer total
    this.E.dealerTotal.innerHTML = "";
    if (d.total != null) { var p = el("span", "total-pill" + (d.total > 21 ? " bust" : ""), String(d.total)); this.E.dealerTotal.appendChild(p); }
    // shoe / commit
    this.E.shoe.innerHTML = "Hand <code>#" + (m.handNumber || 0) + "</code><br>commit <code>" + shortHash(m.commit) + "</code>";
  };
  BlackjackClient.prototype._renderSeats = function (m) {
    var host = this.E.seats, self = this; host.innerHTML = "";
    for (var i = 0; i < 4; i++) {
      var s = m.seats[i];
      var seat = el("div", "seat");
      var mine = this.you && this.you.seat === i;
      if (mine) seat.classList.add("you");
      if (m.phase === "turns" && m.turnIdx === i) seat.classList.add("turn");
      if (!s) {
        seat.classList.add("empty");
        if (this.you == null) {
          var take = el("button", "take", "SIT HERE");
          take.setAttribute("data-take", i);
          seat.appendChild(take);
        } else { seat.appendChild(el("div", "seatno", "Seat " + (i + 1))); }
        host.appendChild(seat); continue;
      }
      // hand
      var hand = el("div", "hand"); var stack = el("div", "stack");
      var cards = s.cards || [];
      for (var c = 0; c < cards.length; c++) stack.appendChild(this._cardEl(cards[c], "p" + i + ":" + c, true));
      hand.appendChild(stack); seat.appendChild(hand);
      // total pill
      var pill = this._totalPill({ total: s.total, soft: s.soft, bust: s.bust, blackjack: s.blackjack });
      if (pill) seat.appendChild(pill);
      // result badge or bet chip
      if (s.result) {
        var oc = s.result.outcome; var b = el("div", "result-badge " + oc);
        var label = oc === "blackjack" ? "BLACKJACK" : oc.toUpperCase();
        var delta = s.result.delta > 0 ? "+" + money(s.result.delta) : (s.result.delta < 0 ? "-" + money(-s.result.delta) : "±0");
        b.innerHTML = label + ' <span class="d">' + delta + "</span>";
        seat.appendChild(b);
        if (oc === "win" || oc === "blackjack") seat.classList.add("win");
      } else if (s.bet > 0) {
        seat.appendChild(el("div", "bet-chip", money(s.bet)));
      }
      // nameplate
      var name = mine ? '<span class="me">YOU</span>' : this._name(s.wallet);
      seat.appendChild(el("div", "nameplate", name));
      host.appendChild(seat);
    }
  };
  BlackjackClient.prototype._name = function (w) {
    if (!w) return "Player";
    if (/^0x[0-9a-fA-F]{6,}/.test(w)) return w.slice(0, 6) + "…" + w.slice(-4);
    if (w.indexOf("guest:") === 0) return "Guest " + w.slice(6);
    return w.length > 12 ? w.slice(0, 12) + "…" : w;
  };

  /* ---------------- phase banner + countdown ---------------- */
  BlackjackClient.prototype._renderBanner = function (m) {
    var main = "", sub = "";
    switch (m.phase) {
      case "idle": main = "WAITING"; sub = "Place a bet to start the hand"; break;
      case "betting": main = "PLACE YOUR BETS"; sub = ""; break;
      case "dealing": main = "DEALING"; sub = ""; break;
      case "turns": main = ""; sub = ""; break;
      case "dealer": main = "DEALER PLAYS"; sub = ""; break;
      case "settle": main = "ROUND OVER"; sub = "Next hand shortly…"; break;
    }
    this.E.phaseMain.textContent = main;
    this.E.phaseSub.textContent = sub;
    this.E.phaseBanner.style.display = (m.phase === "turns") ? "none" : "block";
  };
  BlackjackClient.prototype._tick = function () {
    var ring = this.E.ring, m = this.room;
    if (!m || !this.phaseTotal || (m.phase !== "betting" && m.phase !== "turns")) { ring.style.display = "none"; return; }
    ring.style.display = "grid";
    var remaining = Math.max(0, this.deadline - (Date.now() + this.skew));
    var sec = Math.ceil(remaining / 1000);
    var pct = Math.max(0, Math.min(100, (remaining / this.phaseTotal) * 100));
    ring.style.setProperty("--p", pct.toFixed(1));
    ring.setAttribute("data-sec", sec);
    ring.className = "ring" + (sec <= 3 ? " crit" : (sec <= 6 ? " warn" : ""));
  };

  /* ---------------- control dock ---------------- */
  BlackjackClient.prototype._renderDock = function () {
    var m = this.room, E = this.E, self = this; if (!m) return;
    var seated = !!this.you, mySeat = seated ? m.seats[this.you.seat] : null;
    var isMyTurn = seated && m.phase === "turns" && m.turnIdx === this.you.seat;
    var iBet = !!(mySeat && mySeat.bet > 0);

    // message is always refreshed (cheap); the control ROW only rebuilds when its
    // layout signature changes, so frequent snapshots don't detach live buttons or
    // wipe a half-typed bet amount.
    var msg = "";
    if (!seated) msg = "Spectating · click an open seat to play";
    else if (m.phase === "betting") msg = iBet ? ("Bet placed <b>" + money(mySeat.bet) + "</b> · waiting for the deal…") : "Place your bet to be dealt in";
    else if (m.phase === "turns") msg = isMyTurn ? "<b>Your move</b>" : ("Seat " + (m.turnIdx + 1) + " is deciding…");
    else if (m.phase === "dealing" || m.phase === "dealer") msg = "Dealer is playing…";
    else if (m.phase === "settle") {
      if (mySeat && mySeat.result) {
        var oc = mySeat.result.outcome, d = mySeat.result.delta;
        msg = (oc === "blackjack" ? "🃏 Blackjack! " : (oc === "win" ? "✅ You win " : (oc === "push" ? "➡ Push " : "❌ "))) +
          (d > 0 ? "<b>+" + money(d) + "</b>" : (d < 0 ? "<b>-" + money(-d) + "</b>" : ""));
      } else msg = "Round over";
    } else msg = "Waiting for the next hand…";
    E.dockMsg.innerHTML = msg;

    var sig = (seated ? "S" : "X") + "|" + m.phase + "|" + (isMyTurn ? 1 : 0) + "|" + (iBet ? 1 : 0);
    if (sig === this._dockSig) {
      if (isMyTurn) { var hh = E.dockRow.querySelector(".btn.hit"), ss = E.dockRow.querySelector(".btn.stand");
        if (hh) hh.disabled = this.legal.indexOf("hit") < 0; if (ss) ss.disabled = this.legal.indexOf("stand") < 0; }
      return;
    }
    this._dockSig = sig;

    var row = E.dockRow; row.innerHTML = "";
    if (!seated) { var back = el("button", "btn ghost", "BACK TO LOBBY"); back.onclick = function () { self.leaveTable(); }; row.appendChild(back); return; }
    if (m.phase === "betting" && !iBet) { this._betUI(row); }
    else if (isMyTurn) {
      var hit = el("button", "btn hit", "HIT"); hit.disabled = this.legal.indexOf("hit") < 0; hit.onclick = function () { self.act("hit"); };
      var stand = el("button", "btn stand", "STAND"); stand.disabled = this.legal.indexOf("stand") < 0; stand.onclick = function () { self.act("stand"); };
      row.appendChild(hit); row.appendChild(stand);
    }
    var leave = el("button", "btn danger", "LEAVE"); leave.onclick = function () { self.leaveTable(); }; row.appendChild(leave);
  };
  BlackjackClient.prototype._betUI = function (row) {
    var self = this; row.innerHTML = "";
    var stepper = el("div", "bet-stepper");
    var minus = el("button", null, "−"), plus = el("button", null, "+");
    var input = document.createElement("input"); input.type = "number"; input.min = "10"; input.step = "10"; input.value = String(this.bet);
    var ethSpan = el("span", "bet-eth", eth(this.bet));
    function sync() { self.bet = Math.max(10, Math.round(+input.value || 10)); input.value = self.bet; ethSpan.textContent = eth(self.bet); }
    minus.onclick = function () { self.bet = Math.max(10, self.bet - 10); input.value = self.bet; sync(); };
    plus.onclick = function () { self.bet = self.bet + 10; input.value = self.bet; sync(); };
    input.oninput = sync;
    stepper.appendChild(minus); stepper.appendChild(input); stepper.appendChild(plus);
    row.appendChild(stepper); row.appendChild(ethSpan);
    var chips = el("div", "qchips");
    [["MIN", function () { return 10; }], ["+50", function () { return self.bet + 50; }], ["2×", function () { return self.bet * 2; }],
      ["MAX", function () { return Math.max(10, Math.floor(self.balance || 0)); }]].forEach(function (c) {
      var b = el("button", "chip", c[0]); b.onclick = function () { self.bet = Math.max(10, Math.round(c[1]())); input.value = self.bet; sync(); }; chips.appendChild(b);
    });
    row.appendChild(chips);
    var place = el("button", "btn primary", "PLACE BET"); place.onclick = function () { sync(); self.placeBet(); }; row.appendChild(place);
  };

  /* ---------------- settle / fx ---------------- */
  BlackjackClient.prototype._onSettle = function (m) {
    if (!this.you) return;
    var seat = this.you.seat, ps = null, list = m.perSeat || [];
    for (var i = 0; i < list.length; i++) if (list[i].seat === seat) ps = list[i];
    if (ps && root.BlackjackFX && (ps.outcome === "win" || ps.outcome === "blackjack")) root.BlackjackFX.celebrate(ps.outcome, ps.delta);
  };
  BlackjackClient.prototype._flashBust = function (seatIdx) {
    var node = this.E.seats.children[seatIdx]; if (node) { node.animate ? node.animate([{ filter: "brightness(2)" }, { filter: "brightness(1)" }], { duration: 380 }) : 0; }
  };

  /* ---------------- balance ---------------- */
  BlackjackClient.prototype._renderBalance = function () {
    if (this.balance == null) return;
    if (this.E.balUsd) this.E.balUsd.textContent = money(this.balance);
    if (this.E.balEth) this.E.balEth.textContent = eth(this.balance);
  };

  /* ---------------- provably fair ---------------- */
  BlackjackClient.prototype._renderPF = function () {
    var E = this.E;
    if (E.pfCommit) E.pfCommit.textContent = (this.room && this.room.commit) ? this.room.commit : "—";
    if (E.pfReveal) E.pfReveal.textContent = this.reveal ? ("serverSeed " + this.reveal.serverSeed) : "";
  };
  BlackjackClient.prototype._verify = function () {
    var out = this.E.pfOut, S = root.BlackjackShuffle;
    if (!this.reveal || !S) { if (out) out.textContent = "Play a hand first, then verify the revealed seed."; return; }
    var rv = this.reveal;
    var res = S.verify(rv.serverSeed, rv.commit, rv.clientSeeds || [], rv.shoeId, rv.decks || 6);
    var ok = res.hashOk;
    var first = res.shoe.slice(0, 6).map(function (c) { return rankLabel(c.rank) + SUIT[c.suit]; }).join(" ");
    out.innerHTML = (ok ? "✅ commit verified — SHA256(serverSeed) matches." : "⚠ hash mismatch!") +
      '<br><span class="pf-reveal">shoe order (first 6 dealt): ' + first + "</span>";
  };

  /* ---------------- toast ---------------- */
  BlackjackClient.prototype.toast = function (text, isErr) {
    var t = this.E.toast; if (!t) return; t.textContent = text; t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(this._toastT); var self = this; this._toastT = setTimeout(function () { t.className = "toast"; }, 2600);
  };

  root.BlackjackClient = BlackjackClient;
})(typeof window !== "undefined" ? window : this);
