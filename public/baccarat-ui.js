/* ============================================================
   baccarat-ui.js — the baccarat client controller (BlackjackClient pattern).
   Renders the live lobby and the 720×540 felt from server snapshots, sends
   intents, runs a skew-free countdown, and verifies the provably-fair shoe
   in-browser by REPLAYING the exact tableau (BaccaratRules.runTableau over
   Shuffle.verify(...).shoe). Server is authoritative; this file never
   decides an outcome — it displays state and forwards intents.

   Controls (spec §5, "perfect and simple"): chip-denomination tray
   ($10/$25/$100/$500, sticky via localStorage "bacChip") + tap-a-zone adds
   the selected chip; UNDO pops LIFO, CLEAR wipes, REBET / REBET ×2 restore
   the last completed bet map with printed amounts. No confirm button —
   chips on the felt at window close ARE the bet.

   Embed contract (?tv=1): all controls render in the PARENT dock; this felt
   posts `bac:dock` state on every render and executes `bac:cmd` intents.
   The felt zones remain a second, equivalent tap surface (chip selection is
   shared through the same-origin localStorage key).
   ============================================================ */
(function (root) {
  "use strict";
  var SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };
  var RED = { H: 1, D: 1 };
  var ETH_USD = 3400;
  var PHASE_TOTAL = { betting: 15000 };
  var ZONES = ["player", "banker", "tie"];
  var ZONE_LABEL = { player: "Player", banker: "Banker", tie: "Tie" };
  var DEFAULT_ZONE_MAX = { player: 2000, banker: 2000, tie: 250 }; // server ships the real caps; these mirror spec §5.4
  // chip STACK renderer palette (blackjack-ui.js CHIP_DENOMS verbatim — $1000 kept for display only)
  var CHIP_DENOMS = [[1000, "#eaf2ff"], [500, "#ffd23f"], [100, "#ff4d9d"], [25, "#45f0a6"], [10, "#39e7ff"]];
  // chip TRAY (spec §5.1): $10 cyan · $25 green · $100 magenta · $500 gold
  var TRAY = [[10, "#39e7ff"], [25, "#45f0a6"], [100, "#ff4d9d"], [500, "#ffd23f"]];

  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function rankLabel(r) { return r === "T" ? "10" : r; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function money(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function eth(n) { return "≈ Ξ" + (n / ETH_USD).toFixed(4); }
  function isWallet(w) { return /^0x[0-9a-fA-F]{6,}/.test(w || ""); }
  function shortHash(h) { return h ? h.slice(0, 10) + "…" : "—"; }
  function escHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function cardsOf(hand) { return (hand && hand.cards) || hand || []; }

  function BaccaratClient(opts) {
    this.E = opts.els;
    this.embed = !!opts.embed; // TV-channel mode: no lobby, auto-join one table, controls in the parent dock
    this.joinTable = opts.joinTable || null;
    this._seedBalance = (opts.seedBalance != null && isFinite(opts.seedBalance)) ? opts.seedBalance : null;
    this.wallet = opts.wallet || null;
    this.bjToken = opts.bjToken || "";
    this.bjSession = opts.bjSession || ""; // token-bridge session id ⇒ chips ARE the player's tokens (hello frame identical to BJ)
    this.showEth = isWallet(this.wallet);
    this.net = opts.net || new root.BacNet({ wallet: this.wallet, bjToken: this.bjToken, bjSession: this.bjSession });
    this.view = this.embed ? "table" : "lobby";
    this.you = null; this.spectating = null;
    this.room = null; this.balance = null;
    this.skew = 0; this.deadline = 0; this.phaseTotal = 0;
    this.seen = {}; this.handNo = -1; this.reveal = null;
    this.staked = { player: 0, banker: 0, tie: 0 };
    this.zoneMax = DEFAULT_ZONE_MAX;
    this._lastBetsLocal = null; // client mirror of the last completed bet map (server value preferred when shipped)
    this._connectedOnce = false; this._reconnectRoom = null; this._stagger = 0; this._sfxReady = false;
    this._dockSig = null; this._fsSig = null; this._fsPortrait = null; this._mySettle = null; this._lastChance = false;
    var chip = 25;
    try { var saved = parseInt(localStorage.getItem("bacChip"), 10); if ([10, 25, 100, 500].indexOf(saved) >= 0) chip = saved; } catch (e) {}
    this.chip = chip; // sticky denomination (spec §5.1) — shared with the parent dock via localStorage
    // chip selection is parent-local UI state in embed mode (spec §5.5): the parent's
    // localStorage write fires a `storage` event in this (separate) browsing context.
    var self0 = this;
    try {
      root.addEventListener("storage", function (e) {
        if (!e || e.key !== "bacChip") return;
        var v = parseInt(e.newValue, 10);
        // any $5-step amount ≥ $10 — the parent dock dials EXACT amounts (chips add onto a slider)
        if (isFinite(v) && v >= 10 && v !== self0.chip) { self0.chip = Math.round(v / 5) * 5; self0._dockSig = null; self0._fsSig = null; self0._renderDock(); }
      });
    } catch (e) {}
    this._bindNet(); this._wireStatic();
    if (this.embed) { if (this.net._open) { this._connectedOnce = true; this._autoJoin(); } }
    else this.net.send({ type: "bac:lobby:subscribe" });
    var self = this;
    this._timer = setInterval(function () { self._tick(); }, 200);
    this._fit = this._fit.bind(this);
    root.addEventListener("resize", this._fit); this._fit(); setTimeout(this._fit, 100);
  }

  BaccaratClient.prototype._autoJoin = function () {
    this._resetRoundVis(); this._sfxReady = false;
    // seed our demo table balance BEFORE taking a seat so zone headroom is right from the start
    if (this._seedBalance != null) { this.net.send({ type: "bac:seed", balance: this._seedBalance }); }
    var room = this.joinTable; this.joinTable = null;
    this.net.send({ type: "bac:room:join", roomId: room || undefined });
  };
  BaccaratClient.prototype.topUp = function (amount) { this.net.send({ type: "bac:topup", amount: Math.max(0, +amount || 0) }); };
  // live ETH/USD from the parent (piggybacked on bac:active) — cosmetic ≈Ξ labels ONLY, never settle math
  BaccaratClient.prototype.setRate = function (u) { u = +u; if (u > 0 && isFinite(u)) ETH_USD = u; };
  // Mobile resume: socket alive + fresh snapshot so a frozen-while-backgrounded state can't block betting.
  BaccaratClient.prototype.resume = function () {
    if (!this.net) return;
    this.net.ensureConnected();
    if (this.embed && this.net._open) { if (this.you) this.net.send({ type: "bac:room:join", roomId: this.you.roomId }); else this._autoJoin(); }
  };

  /* ---------------- net ---------------- */
  BaccaratClient.prototype._bindNet = function () {
    var self = this;
    this.net.on("bac:net", function (m) {
      if (m.state === "open") { self._setNetBanner(false); if (self._connectedOnce) self._onReconnect(); else if (self.embed) self._autoJoin(); self._connectedOnce = true; }
      else if (m.state === "closed") { self._setNetBanner(true); }
    });
    this.net.on("bac:lobby:list", function (m) { self.renderLobby(m.rooms); });
    this.net.on("bac:wallet", function (m) { self.balance = m.balance; self._renderBalance(); self._renderDock(); });
    this.net.on("bac:room:snapshot", function (m) {
      if (m.you) { self.you = { roomId: m.you.roomId, seat: m.you.seat }; self.spectating = null; if (m.you.balance != null) { self.balance = m.you.balance; self._renderBalance(); } }
      self._onSnapshot(m);
    });
    this.net.on("bac:settle", function (m) { self._onSettle(m); });
    this.net.on("bac:reveal", function (m) { self.reveal = m; self._renderPF(); });
    this.net.on("bac:event", function (m) {
      if (m.kind === "roomClosing" && self.room && m.id === self.room.roomId) { self.toast("Table closed (" + (m.reason || "idle") + ")"); self.showLobby(); }
      if (m.kind === "kindMismatch") { self.toast("That table is for " + (m.tableKind === "real" ? "real-money (token)" : "demo") + " players — showing tables you can join"); self.showLobby(); }
    });
    this.net.on("bac:error", function (m) {
      self._clearActWatch();
      if (self._reconnectRoom && (m.intent === "join" || m.code === "table_full" || m.code === "no_room" || m.code === "lobby_full")) { self._reconnectRoom = null; self.toast("Reconnected — pick a table to jump back in"); self.showLobby(); return; }
      if (self.embed && m.code === "auth_required") self._emitDockError(m.msg || m.message || "Lock tokens before joining baccarat");
      self.toast(m.msg || "Error", true); self._dockSig = null; self._fsSig = null; self._renderDock();
    });
  };

  BaccaratClient.prototype._setNetBanner = function (show) {
    var elx = document.getElementById("bac-net-banner");
    if (show) {
      if (!elx) {
        elx = document.createElement("div");
        elx.id = "bac-net-banner";
        elx.style.cssText = "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483646;background:rgba(10,16,28,.94);color:#ffd23f;border:1px solid rgba(255,210,63,.55);border-radius:12px;padding:9px 18px;font:800 14px system-ui,-apple-system,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.55);white-space:nowrap;pointer-events:none";
        elx.textContent = "📡 Reconnecting to the table…";
        (document.body || document.documentElement).appendChild(elx);
      }
      elx.style.display = "block";
    } else if (elx) { elx.style.display = "none"; }
  };

  BaccaratClient.prototype._wireStatic = function () {
    var self = this, E = this.E;
    if (E.balEth && !this.showEth) E.balEth.style.display = "none";
    if (E.back) E.back.onclick = function () { self.leaveTable(); };
    if (E.pfVerify) E.pfVerify.onclick = function () { self._verify(); };
    if (E.soundBtn) E.soundBtn.onclick = function () {
      var sfx = root.BlackjackSFX; if (!sfx) return;
      sfx.muted = !sfx.muted; E.soundBtn.textContent = sfx.muted ? "🔇" : "🔊";
      if (!sfx.muted) sfx.card(0);
    };
    if (E.tables) E.tables.addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]"); if (!b) return;
      var act = b.getAttribute("data-act"), room = b.getAttribute("data-room");
      if (act === "join") self.joinRoom(room); else if (act === "watch") self.watchRoom(room);
    });
    // the three felt zones — tap = add the selected chip (spec §5.2)
    ZONES.forEach(function (z) {
      var zn = self._zoneEl(z); if (!zn) return;
      zn.addEventListener("click", function () { self.addChip(z); });
    });
    if (E.rail) E.rail.addEventListener("click", function (e) {
      var b = e.target.closest("[data-take]"); if (!b) return;
      self.net.send({ type: "bac:room:join", roomId: self.room ? self.room.roomId : undefined, seatPref: +b.getAttribute("data-take") });
    });
    if (E.fsBtn) E.fsBtn.onclick = function () { self.toggleFullscreen(); };
    if (E.fsExit) E.fsExit.onclick = function () { self.toggleFullscreen(); };
    this._wireFsSync();
  };
  BaccaratClient.prototype._zoneEl = function (z) { return z === "player" ? this.E.zonePlayer : z === "banker" ? this.E.zoneBanker : this.E.zoneTie; };

  /* ---------------- lobby ---------------- */
  BaccaratClient.prototype.showLobby = function () {
    if (this.embed) { this.you = null; this.spectating = null; this.room = null; this._autoJoin(); return; }
    this.view = "lobby"; this.you = null; this.spectating = null; this.room = null;
    this.E.lobby.classList.remove("hidden"); this.E.table.classList.add("hidden");
    this.net.send({ type: "bac:lobby:subscribe" });
  };
  BaccaratClient.prototype.showTable = function () { this.view = "table"; if (!this.embed) { this.E.lobby.classList.add("hidden"); this.E.table.classList.remove("hidden"); this._fit(); } };
  BaccaratClient.prototype.renderLobby = function (rooms) {
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
  BaccaratClient.prototype.joinRoom = function (roomId) { this._resetRoundVis(); this._sfxReady = false; this.showTable(); this.E.dockMsg.textContent = "Taking a seat…"; this.net.send({ type: "bac:room:join", roomId: roomId }); };
  BaccaratClient.prototype.watchRoom = function (roomId) { this._resetRoundVis(); this._sfxReady = false; this.spectating = roomId; this.showTable(); this.E.dockMsg.textContent = "Joining as spectator…"; this.net.send({ type: "bac:room:watch", roomId: roomId }); };
  BaccaratClient.prototype.leaveTable = function () { if (this.you || this.spectating) this.net.send({ type: "bac:room:leave" }); this.showLobby(); };
  BaccaratClient.prototype._onReconnect = function () {
    this._sfxReady = false;
    if (this.embed) { this._autoJoin(); return; }
    this.net.send({ type: "bac:lobby:subscribe" });
    if (this.you) { this._reconnectRoom = this.you.roomId; this.toast("Reconnecting…"); this.net.send({ type: "bac:room:join", roomId: this._reconnectRoom }); }
    else if (this.spectating) { this.net.send({ type: "bac:room:watch", roomId: this.spectating }); }
  };

  // felt-surface taps re-read the shared key so a parent-side selection made a
  // moment ago is honored even if the storage event hasn't been processed yet
  BaccaratClient.prototype._currentChip = function () {
    try {
      var v = parseInt(localStorage.getItem("bacChip"), 10);
      if (isFinite(v) && v >= 10) this.chip = Math.round(v / 5) * 5; // parent dial: any $5-step amount
    } catch (e) {}
    return this.chip;
  };
  BaccaratClient.prototype.selectChip = function (v) {
    if ([10, 25, 100, 500].indexOf(v) < 0) return;
    this.chip = v;
    try { localStorage.setItem("bacChip", String(v)); } catch (e) {}
    this._dockSig = null; this._fsSig = null; this._renderDock();
  };

  // Tap-a-zone: add the selected chip (or an explicit amount from the parent dock).
  // Partial fill to the legal max when ≥$10, else a short toast (spec §5.2).
  BaccaratClient.prototype.addChip = function (zone, amount) {
    if (ZONES.indexOf(zone) < 0) return;
    var m = this.room;
    if (!this.you) { if (this.spectating || (m && !m.openSeats)) this.toast("Spectating — a seat opens when someone leaves"); return; }
    if (!m || (m.phase !== "betting" && m.phase !== "idle")) { this._bounceZone(zone); return; } // late taps bounce, no toast (spec §3 LOCK); idle passes — a seated chip WAKES a parked table (server re-arms)
    if (zone === "player" && this.staked.banker > 0) { this.toast("Pick a side — Player and Banker can't both be backed", true); return; }
    if (zone === "banker" && this.staked.player > 0) { this.toast("Pick a side — Player and Banker can't both be backed", true); return; }
    var chip = Math.max(0, Math.round(+amount || this._currentChip()));
    var bal = (this.balance != null && isFinite(this.balance)) ? this.balance : 0;
    var headroom = Math.min(bal, (this.zoneMax[zone] || 0) - (this.staked[zone] || 0));
    var use = Math.min(chip, Math.floor(headroom));
    if (use < 10) {
      if ((this.zoneMax[zone] || 0) - (this.staked[zone] || 0) < 10) this.toast(ZONE_LABEL[zone] + " max " + money(this.zoneMax[zone]));
      else this.toast("Not enough balance");
      return;
    }
    var seed = (this.E.pfClient && this.E.pfClient.value.trim()) || "";
    this.net.send({ type: "bac:bet:add", zone: zone, amountUsd: use, clientSeed: seed || undefined });
    if (root.BlackjackSFX) root.BlackjackSFX.unlock();
  };
  BaccaratClient.prototype._bounceZone = function (zone) {
    var zn = this._zoneEl(zone);
    if (zn && zn.animate) zn.animate([{ transform: "translateY(0)" }, { transform: "translateY(3px)" }, { transform: "translateY(0)" }], { duration: 180 });
  };

  // UNDO / CLEAR / REBET use the BJ act() discipline: disable-on-send, 7s watchdog resume,
  // controls restored by the next snapshot or bac:error (dock-sig reset).
  BaccaratClient.prototype._act = function (msg) {
    this.net.send(msg);
    var hosts = [this.E.dockRow, this.E.fsbar], i, j;
    for (i = 0; i < hosts.length; i++) {
      if (!hosts[i]) continue;
      var btns = hosts[i].querySelectorAll(".ctl");
      for (j = 0; j < btns.length; j++) btns[j].disabled = true;
    }
    var self = this; clearTimeout(this._actWatch);
    this._actWatch = setTimeout(function () { try { self.resume(); } catch (e) {} }, 7000);
  };
  BaccaratClient.prototype._clearActWatch = function () { if (this._actWatch) { clearTimeout(this._actWatch); this._actWatch = null; } };
  BaccaratClient.prototype.undoBet = function () { if (this._totalStaked() <= 0) return; this._act({ type: "bac:bet:undo" }); };
  BaccaratClient.prototype.clearBets = function () { if (this._totalStaked() <= 0) return; this._act({ type: "bac:bet:clear" }); };
  BaccaratClient.prototype.rebet = function (mult) {
    mult = mult === 2 ? 2 : 1;
    var rb = this._rebetState();
    if (!rb) return;
    var ok = mult === 2 ? rb.ok2 : rb.ok, total = mult === 2 ? rb.total2 : rb.total;
    if (!ok) { this.toast("Not enough balance for " + money(total)); return; }
    this._act({ type: "bac:bet:rebet", mult: mult });
  };
  BaccaratClient.prototype._totalStaked = function () { return r2((this.staked.player || 0) + (this.staked.banker || 0) + (this.staked.tie || 0)); };
  BaccaratClient.prototype._lastBets = function () {
    var m = this.room, s = (this.you && m && m.seats) ? m.seats[this.you.seat] : null;
    var lb = (s && s.lastBets) || this._lastBetsLocal;
    if (!lb) return null;
    var t = r2((lb.player || 0) + (lb.banker || 0) + (lb.tie || 0));
    return t > 0 ? lb : null;
  };
  // rebet affordability + caps (whole map atomic; ×2 checks the doubled amounts) — spec §5.3
  BaccaratClient.prototype._rebetState = function () {
    var lb = this._lastBets(); if (!lb) return null;
    var total = r2((lb.player || 0) + (lb.banker || 0) + (lb.tie || 0));
    var bal = (this.balance != null && isFinite(this.balance)) ? this.balance : 0;
    var okZones = function (mul, zm) { var ok = true; ZONES.forEach(function (z) { if ((lb[z] || 0) * mul > (zm[z] || 0)) ok = false; }); return ok; };
    return {
      total: total, total2: r2(total * 2),
      ok: total <= bal && okZones(1, this.zoneMax),
      ok2: r2(total * 2) <= bal && okZones(2, this.zoneMax),
    };
  };

  /* ---------------- snapshot render ---------------- */
  BaccaratClient.prototype._resetRoundVis = function () {
    this.seen = {}; this._mySettle = null; this._lastChance = false;
    this._natFlashed = {}; this._pTotalTxt = null; this._bTotalTxt = null;
    clearTimeout(this._capT); this._capT = null; this._capHold = null;
    clearTimeout(this._tickerT); if (this.E.ticker) this.E.ticker.textContent = "";
    var self = this;
    ZONES.forEach(function (z) { var zn = self._zoneEl(z); if (zn) zn.classList.remove("win-glow", "dimmed"); });
    if (this.E.pStage) this.E.pStage.classList.remove("won", "lost");
    if (this.E.bStage) this.E.bStage.classList.remove("won", "lost");
  };
  BaccaratClient.prototype._onSnapshot = function (m) {
    this._clearActWatch();
    if (this.view !== "table") this.showTable();
    this._reconnectRoom = null;
    if (m.handNumber !== this.handNo) { this.handNo = m.handNumber; this._resetRoundVis(); this.reveal = null; }
    this.room = m;
    var rawSkew = (m.serverNow || Date.now()) - Date.now();
    this.skew = this._skewSet ? Math.round(this.skew * 0.8 + rawSkew * 0.2) : rawSkew; this._skewSet = true;
    if (m.deadline !== this.deadline) this._lastChance = false;
    this.deadline = m.deadline || 0;
    this.phaseTotal = PHASE_TOTAL[m.phase] || 0;
    if (m.zoneMax && m.zoneMax.player) this.zoneMax = m.zoneMax;
    var mySeat = (this.you && m.seats) ? m.seats[this.you.seat] : null;
    this.staked = (mySeat && mySeat.bets) ? { player: mySeat.bets.player || 0, banker: mySeat.bets.banker || 0, tie: mySeat.bets.tie || 0 } : { player: 0, banker: 0, tie: 0 };
    this._stagger = 0;
    if (this.E.stage) {
      this.E.stage.classList.toggle("phase-betting", m.phase === "betting");
      this.E.stage.classList.toggle("locked", m.phase === "dealing" || m.phase === "reveal" || m.phase === "settle");
    }
    this._renderStages(m); this._renderRoad(m); this._renderZones(m); this._renderRail(m);
    this._renderCaption(m); this._renderDock(); this._renderPF();
    this._sfxReady = true; // first (sync) snapshot silent; real deals make sound after
  };

  BaccaratClient.prototype._cardEl = function (c, key, isThird) {
    var d = el("div", "card " + (RED[c.suit] ? "red" : "black"));
    var s = SUIT[c.suit], r = rankLabel(c.rank);
    d.innerHTML = '<span class="corner"><span class="r">' + r + '</span><span class="s">' + s + '</span></span>' +
      '<span class="pip">' + s + '</span><span class="corner br"><span class="r">' + r + '</span><span class="s">' + s + '</span></span>';
    if (key && !this.seen[key]) {
      this.seen[key] = 1;
      // deciding-card choreography (spec R4): the third card arrives ALONE — slower
      // 650ms flip + gold rim flash; initial four cards use the 400ms slide-deal.
      d.classList.add(isThird ? "flip-slow" : "dealing");
      var delay = (this._stagger || 0) * 150; if (delay) d.style.animationDelay = delay + "ms";
      this._stagger = (this._stagger || 0) + 1;
      if (this._sfxReady && root.BlackjackSFX) root.BlackjackSFX.card(delay);
    }
    return d;
  };

  BaccaratClient.prototype._renderHand = function (host, cards, side) {
    // three PRE-RESERVED slots — zero reflow, cards never overlap (spec §4.1)
    if (!host._slots) {
      host.innerHTML = ""; host._slots = [];
      for (var i = 0; i < 3; i++) { var sl = el("div", "slot s" + (i + 1)); host.appendChild(sl); host._slots.push(sl); }
    }
    for (var j = 0; j < 3; j++) {
      var slot = host._slots[j];
      slot.innerHTML = "";
      if (cards[j]) slot.appendChild(this._cardEl(cards[j], side + ":" + j, j === 2));
    }
  };
  BaccaratClient.prototype._renderStages = function (m) {
    var P = cardsOf(m.player), B = cardsOf(m.banker);
    this._renderHand(this.E.pHand, P, "P");
    this._renderHand(this.E.bHand, B, "B");
    var Rules = root.BaccaratRules;
    var pt = P.length ? Rules.handTotal(P) : null, bt = B.length ? Rules.handTotal(B) : null;
    this._paintTotal(this.E.pTotal, pt, "_pTotalTxt");
    this._paintTotal(this.E.bTotal, bt, "_bTotalTxt");
    // NATURAL gold pill flash — its own beat (spec §3)
    if (P.length === 2 && B.length === 2 && m.phase !== "betting" && m.phase !== "idle" && m.phase !== "dealing") {
      if (Rules.isNatural(P) && !this._natFlashed.P) { this._natFlashed.P = 1; this.E.pTotal.classList.add("natural"); }
      if (Rules.isNatural(B) && !this._natFlashed.B) { this._natFlashed.B = 1; this.E.bTotal.classList.add("natural"); }
    }
    // settle: winner cards edged gold, losing hand sits dimmer (never red); winner pill goes gold
    var oc = m.outcome;
    if (m.phase === "settle" && oc) {
      this.E.pStage.classList.toggle("won", oc.winner === "player");
      this.E.pStage.classList.toggle("lost", oc.winner === "banker");
      this.E.bStage.classList.toggle("won", oc.winner === "banker");
      this.E.bStage.classList.toggle("lost", oc.winner === "player");
      this.E.pTotal.classList.toggle("winner", oc.winner === "player" || oc.winner === "tie");
      this.E.bTotal.classList.toggle("winner", oc.winner === "banker" || oc.winner === "tie");
    } else {
      this.E.pTotal.classList.remove("winner"); this.E.bTotal.classList.remove("winner");
    }
  };
  BaccaratClient.prototype._paintTotal = function (pill, total, memo) {
    var txt = total == null ? "" : String(total);
    if (this[memo] === txt) return;
    this[memo] = txt;
    pill.textContent = txt;
    if (txt !== "") { pill.classList.remove("tick"); void pill.offsetWidth; pill.classList.add("tick"); } // 120ms pulse per update
    else pill.classList.remove("tick", "natural", "winner");
  };

  /* ---------------- Big Road (6×16, spec R5) ---------------- */
  function roadCells(hist) {
    var cells = [], occ = {}, counts = { B: 0, P: 0, T: 0 };
    var last = null, prevWinner = null, streakStartCol = 0, lastCol = 0, lastRow = 0;
    for (var i = 0; i < hist.length; i++) {
      var w = hist[i];
      if (w !== "B" && w !== "P" && w !== "T") continue;
      counts[w]++;
      if (w === "T") { // ties never take a cell — slash the last ring (phantom at origin if first)
        if (last) last.ties++;
        else { last = { col: 0, row: 0, w: null, ties: 1 }; cells.push(last); }
        continue;
      }
      if (last && last.w === null) { // leading-tie phantom: the first real result takes its cell
        last.w = w; occ["0:0"] = 1; prevWinner = w; streakStartCol = 0; lastCol = 0; lastRow = 0; continue;
      }
      if (w !== prevWinner) { // winner flip → new column at row 0 (skip columns blocked by a dragon tail)
        var c = (prevWinner === null) ? 0 : streakStartCol + 1;
        while (occ[c + ":0"]) c++;
        streakStartCol = c; lastCol = c; lastRow = 0;
      } else { // same winner stacks downward; 7th+ turns right along row 6 (dragon tail; extends right on collision)
        var nr = lastRow + 1, nc = lastCol;
        if (nr > 5 || occ[nc + ":" + nr]) { nc = lastCol + 1; nr = lastRow; while (occ[nc + ":" + nr]) nc++; }
        lastCol = nc; lastRow = nr;
      }
      last = { col: lastCol, row: lastRow, w: w, ties: 0 };
      cells.push(last); occ[lastCol + ":" + lastRow] = 1;
      prevWinner = w;
    }
    return { cells: cells, counts: counts };
  }
  BaccaratClient.prototype._renderRoad = function (m) {
    var host = this.E.road, hist = m.history || [];
    if (!host) return;
    var rd = roadCells(hist);
    var maxCol = 0;
    rd.cells.forEach(function (c) { if (c.col > maxCol) maxCol = c.col; });
    var off = Math.max(0, maxCol - 15); // window slides left past 16 columns (newest 16)
    host.innerHTML = "";
    var grew = hist.length > (this._roadLen || 0);
    this._roadLen = hist.length;
    for (var i = 0; i < rd.cells.length; i++) {
      var c = rd.cells[i], col = c.col - off;
      if (col < 0 || col > 15) continue;
      var dot = el("i", (c.w || "") + (c.ties > 0 ? " t" : "") + (c.w === null ? " phantom" : ""));
      if (c.ties > 0) dot.setAttribute("data-ties", String(c.ties));
      dot.style.left = (col * 11) + "px"; dot.style.top = (c.row * 11) + "px";
      if (grew && i === rd.cells.length - 1 && m.phase === "settle") dot.classList.add("new"); // 150ms pop at result
      host.appendChild(dot);
    }
    if (this.E.roadCounts) {
      var html = '<span class="cpill b">B ' + rd.counts.B + '</span><span class="cpill p">P ' + rd.counts.P + '</span><span class="cpill t">T ' + rd.counts.T + "</span>";
      if (this.E.roadCounts.innerHTML !== html) this.E.roadCounts.innerHTML = html;
    }
  };

  /* ---------------- zones + chips ---------------- */
  BaccaratClient.prototype._chipStack = function (value) {
    var stack = el("div", "chipstack"); var chips = []; var v = Math.round(value);
    for (var d = 0; d < CHIP_DENOMS.length; d++) while (v >= CHIP_DENOMS[d][0]) { chips.push(CHIP_DENOMS[d]); v -= CHIP_DENOMS[d][0]; }
    var show = chips.slice(0, 5);
    for (var i = 0; i < show.length; i++) { var c = el("div", "chip3d", '<span class="v">' + show[i][0] + "</span>"); c.style.setProperty("--cc", show[i][1]); c.style.bottom = (i * 4) + "px"; stack.appendChild(c); }
    if (chips.length > 5) stack.appendChild(el("div", "chip-pill", "×" + chips.length));
    return stack;
  };
  BaccaratClient.prototype._renderZones = function (m) {
    var self = this;
    ZONES.forEach(function (z) {
      var zn = self._zoneEl(z); if (!zn) return;
      var mine = self.staked[z] || 0, others = 0, bettors = 0;
      for (var i = 0; i < (m.seats || []).length; i++) {
        var s = m.seats[i]; if (!s || !s.bets) continue;
        if (self.you && i === self.you.seat) continue;
        var b = s.bets[z] || 0;
        if (b > 0) { others = r2(others + b); bettors++; }
      }
      // aggregate, never N piles (spec §6): one dim table stack behind + YOUR gold stack front
      var agg = document.getElementById("agg-" + z), mineEl = document.getElementById("mine-" + z), pill = document.getElementById("stake-" + z);
      if (agg) {
        agg.innerHTML = "";
        if (others > 0) {
          agg.appendChild(self._chipStack(others));
          agg.appendChild(el("div", "agg-label", money(others) + " · " + bettors));
        }
      }
      if (mineEl) { mineEl.innerHTML = ""; if (mine > 0) mineEl.appendChild(self._chipStack(mine)); }
      if (pill) {
        var html = mine > 0 ? money(mine) + (self.showEth ? ' <span class="e">' + eth(mine) + "</span>" : "") : "";
        if (pill.innerHTML !== html) pill.innerHTML = html;
      }
      zn.classList.toggle("has-bet", mine > 0 || others > 0);
      zn.setAttribute("aria-label", "Add " + money(self.chip) + " to " + ZONE_LABEL[z] + ". Your " + ZONE_LABEL[z] + " bet is " + money(mine) + ".");
    });
  };

  /* ---------------- puck rail (4 seats, spec §6) ---------------- */
  BaccaratClient.prototype._renderRail = function (m) {
    var host = this.E.rail; if (!host) return;
    host.innerHTML = "";
    for (var i = 0; i < 4; i++) {
      var s = (m.seats || [])[i];
      var p = el("div", "puck");
      p.setAttribute("data-seat", String(i));
      if (!s) {
        p.classList.add("empty");
        if (this.you == null) { var take = el("button", "take-seat", "SEAT"); take.setAttribute("data-take", i); p.appendChild(take); }
        else p.appendChild(el("span", "take-seat", "SEAT"));
        host.appendChild(p); continue;
      }
      var mine = this.you && this.you.seat === i;
      if (mine) p.classList.add("you");
      if (s.away || s.disconnected) p.classList.add("away");
      p.appendChild(el("span", "dot"));
      p.appendChild(el("span", "pname", mine ? '<span class="me">YOU</span>' : this._name(s.wallet)));
      var stake = s.bets ? r2((s.bets.player || 0) + (s.bets.banker || 0) + (s.bets.tie || 0)) : 0;
      if (stake > 0 && m.phase !== "settle") p.appendChild(el("span", "pbet", money(stake)));
      host.appendChild(p);
    }
  };
  BaccaratClient.prototype._name = function (w) {
    if (!w) return "Player";
    if (/^0x[0-9a-fA-F]{6,}$/.test(w)) return w.slice(0, 6) + "…" + w.slice(-4);
    if (w.indexOf("guest:") === 0) return "Guest " + escHtml(w.slice(6));
    return escHtml(w.length > 12 ? w.slice(0, 12) + "…" : w);
  };

  /* ---------------- caption — the tableau narrator (spec §3) ---------------- */
  BaccaratClient.prototype._cap = function (text, cls) {
    var c = this.E.caption; if (!c) return;
    if (c.textContent !== text) c.textContent = text;
    c.className = "caption" + (cls ? " " + cls : "");
  };
  BaccaratClient.prototype._renderCaption = function (m) {
    clearTimeout(this._capT); this._capT = null;
    var Rules = root.BaccaratRules, self = this;
    var P = cardsOf(m.player), B = cardsOf(m.banker);
    this._revealMsg = "";
    if (m.phase === "betting" || m.phase === "idle") { this._cap("", ""); return; }
    if (m.phase === "dealing") {
      this._cap(P.length + B.length >= 4 ? "" : (P.length + B.length === 0 ? "NO MORE BETS" : ""), "gold");
      this._revealMsg = "Dealing…";
      return;
    }
    if (m.phase === "reveal") {
      var pt = Rules.handTotal(P), bt = Rules.handTotal(B);
      if (P.length === 2 && B.length === 2) {
        if (Rules.isNatural(P) || Rules.isNatural(B)) { this._cap("NATURAL " + Math.max(pt, bt), "gold"); this._revealMsg = "Natural " + Math.max(pt, bt) + "!"; }
        else if (Rules.playerDraws(pt)) { this._cap("PLAYER DRAWS…", "player"); this._revealMsg = "Player draws…"; }
        else {
          this._cap("PLAYER STANDS ON " + pt, "player"); this._revealMsg = "Player stands on " + pt + ".";
          this._capT = setTimeout(function () { // 400ms caption beat, then the banker's move (spec §3)
            if (!self.room || self.room.phase !== "reveal") return;
            if (Rules.bankerDraws(bt, null)) { self._cap("BANKER DRAWS…", "banker"); self._revealMsg = "Banker draws…"; }
            else { self._cap("BANKER STANDS ON " + bt, "banker"); self._revealMsg = "Banker stands on " + bt + "."; }
            self._renderDock();
          }, 400);
        }
      } else if (P.length === 3 && B.length === 2) {
        var b2 = Rules.handTotal(B), p3v = Rules.cardValue(P[2].rank);
        if (Rules.bankerDraws(b2, p3v)) { this._cap("BANKER DRAWS…", "banker"); this._revealMsg = "Banker draws…"; }
        else { this._cap("BANKER STANDS ON " + b2, "banker"); this._revealMsg = "Banker stands on " + b2 + "."; }
      } else { this._cap("", ""); this._revealMsg = "Revealing…"; }
      return;
    }
    if (m.phase === "settle" && m.outcome) {
      var oc = m.outcome, hi = Math.max(oc.playerTotal, oc.bankerTotal), lo = Math.min(oc.playerTotal, oc.bankerTotal);
      if (oc.winner === "tie") this._cap("TIE " + oc.playerTotal + "–" + oc.bankerTotal, "tie");
      else this._cap(oc.winner.toUpperCase() + " WINS " + hi + "–" + lo, oc.winner);
      return;
    }
    this._cap("", "");
  };

  /* ---------------- dock (msg + controls + parent emit) ---------------- */
  BaccaratClient.prototype._outcomePhrase = function (oc) {
    if (!oc) return "";
    if (oc.winner === "tie") return "Tie, " + oc.playerTotal + "–" + oc.bankerTotal + ".";
    var hi = Math.max(oc.playerTotal, oc.bankerTotal), lo = Math.min(oc.playerTotal, oc.bankerTotal);
    return (oc.winner === "player" ? "Player" : "Banker") + " wins, " + hi + "–" + lo + ".";
  };
  BaccaratClient.prototype._settleMsg = function (m) {
    var oc = m.outcome, phrase = this._outcomePhrase(oc);
    var ps = this._mySettle;
    if (!ps || ps.net == null) return phrase || "Round over";
    var net = ps.net;
    if (net > 0) return "✅ " + phrase + " You win <b>+" + money(net) + "</b>";
    if (net < 0) return phrase + " −" + money(-net); // QUIET: the neutral fact + a plain minus amount, nothing else
    var hadSide = ps.zones && ((ps.zones.player && ps.zones.player.bet > 0) || (ps.zones.banker && ps.zones.banker.bet > 0));
    if (oc && oc.winner === "tie" && (hadSide || this.staked.player > 0 || this.staked.banker > 0))
      return "🤝 TIE — Player & Banker bets push"; // players who don't know the rule will think they lost — say it
    return phrase || "Round over";
  };
  BaccaratClient.prototype._mode = function (m) {
    if (!m) return "waiting";
    var seated = !!this.you;
    if (!seated) return "spectating";
    if (m.phase === "betting" || m.phase === "idle") { // idle: a SEATED player's chip wakes the parked table (server re-arms on bac:bet:add/rebet) — keep the tray usable, no dead end
      var balReady = (this.balance != null && isFinite(this.balance));
      return balReady ? "betting" : "waiting"; // v5 #20 guard: no bet UI off a fabricated balance
    }
    if (m.phase === "dealing") return "dealing";
    if (m.phase === "reveal") return "reveal";
    if (m.phase === "settle") return "settle";
    return "waiting";
  };
  BaccaratClient.prototype._msg = function (m, mode) {
    var total = this._totalStaked();
    if (mode === "spectating") return this.embed ? "Table full — spectating. A seat opens when someone leaves." : "Spectating · tap SEAT on the rail to play";
    if (mode === "waiting") return (m && m.phase === "idle") ? "Waiting for the next round…" : "Connecting to the table…";
    if (mode === "betting") {
      var remaining = this.deadline ? Math.max(0, this.deadline - (Date.now() + this.skew)) : 0;
      if (remaining > 0 && remaining <= 3000) return "Last chance to bet…";
      return total > 0 ? ("<b>" + money(total) + "</b> on the felt · tap a zone to add " + money(this.chip))
        : "Place your bets — Player, Banker or Tie";
    }
    if (mode === "dealing") return "Bets closed — dealing…";
    if (mode === "reveal") return this._revealMsg || "Revealing…";
    if (mode === "settle") return this._settleMsg(m);
    return "Waiting for the next round…";
  };
  BaccaratClient.prototype._renderDock = function () {
    var m = this.room, E = this.E;
    var mode = this._mode(m);
    var msg = this._msg(m, mode);
    if (E.dockMsg && E.dockMsg.innerHTML !== msg) E.dockMsg.innerHTML = msg; // idempotent: aria-live must not re-announce identical text
    if (this.embed) this._emitDock(m, mode, msg);
    if (!this.embed) this._renderLocalControls(m, mode);
    this._renderFsBar(m, mode);
  };

  // one control surface, three hosts: parent dock (embed), the in-page dock
  // (standalone) and the fullscreen bet bar. Tray + UNDO/CLEAR (+ REBET row).
  BaccaratClient.prototype._buildControls = function (host, m, mode, compact) {
    var self = this;
    host.innerHTML = "";
    if (mode !== "betting") return; // controls VANISH (not just disable) outside the window (spec §5.3)
    var total = this._totalStaked();
    var bal = (this.balance != null && isFinite(this.balance)) ? this.balance : 0;
    var maxHeadroom = 0;
    ZONES.forEach(function (z) { var h = (self.zoneMax[z] || 0) - (self.staked[z] || 0); if (h > maxHeadroom) maxHeadroom = h; });
    if (compact) { var cnt = el("span", "fs-count", ""); host.appendChild(cnt); }
    var tray = el("div", "tray");
    tray.setAttribute("role", "group"); tray.setAttribute("aria-label", "Chip value");
    TRAY.forEach(function (cd) {
      var v = cd[0], b = el("button", "chipbtn" + (self.chip === v ? " active" : ""), "$" + v);
      b.type = "button";
      b.style.setProperty("--cc", cd[1]);
      b.setAttribute("aria-pressed", self.chip === v ? "true" : "false");
      b.setAttribute("aria-label", "$" + v + " chip");
      var dead = v > Math.min(bal, maxHeadroom);
      if (dead) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
      b.onclick = function () { self.selectChip(v); };
      tray.appendChild(b);
    });
    var undo = el("button", "ctl", "↩ UNDO"); undo.type = "button";
    undo.disabled = total <= 0; if (undo.disabled) undo.setAttribute("aria-disabled", "true");
    undo.onclick = function () { self.undoBet(); };
    var clear = el("button", "ctl clear", "✕ CLEAR"); clear.type = "button";
    clear.disabled = total <= 0; if (clear.disabled) clear.setAttribute("aria-disabled", "true");
    clear.onclick = function () { self.clearBets(); };
    tray.appendChild(undo); tray.appendChild(clear);
    host.appendChild(tray);
    // REBET row — only while the current bets are empty, amounts PRINTED (spec §5.3/R12)
    var rb = total <= 0 ? this._rebetState() : null;
    if (rb) {
      var row = el("div", "rebet-row");
      [["⟳ REBET " + money(rb.total), 1, rb.ok, rb.total], ["⟳⟳ REBET ×2 " + money(rb.total2), 2, rb.ok2, rb.total2]].forEach(function (def) {
        var b = el("button", "ctl rebet", def[0]); b.type = "button";
        if (!def[2]) { b.setAttribute("aria-disabled", "true"); b.style.filter = "grayscale(.55) brightness(.62)"; }
        b.onclick = function () { if (!def[2]) { self.toast("Not enough balance for " + money(def[3])); return; } self.rebet(def[1]); };
        row.appendChild(b);
      });
      if (compact) { row.style.display = "contents"; } // fullscreen bar: rebet pills inline
      host.appendChild(row);
    }
  };
  BaccaratClient.prototype._renderLocalControls = function (m, mode) {
    var E = this.E;
    var rb = this._totalStaked() <= 0 ? this._rebetState() : null;
    var sig = mode + "|" + this.chip + "|" + this._totalStaked() + "|" + Math.floor((this.balance || 0) / 5) + "|" +
      (rb ? rb.total + ":" + (rb.ok ? 1 : 0) + (rb.ok2 ? 1 : 0) : "-") + "|" + (this.you ? this.you.seat : "x");
    if (E.countStrip) E.countStrip.classList.toggle("on", mode === "betting" && !!this.deadline);
    if (sig === this._dockSig) return;
    this._dockSig = sig;
    this._buildControls(E.dockRow, m, mode, false);
  };
  BaccaratClient.prototype._renderFsBar = function (m, mode) {
    var E = this.E;
    if (!E.fsbar || !document.body.classList.contains("fs-embed")) { if (E.fsbar && E.fsbar._built) { E.fsbar.innerHTML = ""; E.fsbar._built = false; this._fsSig = null; } return; }
    var rb = this._totalStaked() <= 0 ? this._rebetState() : null;
    var sig = mode + "|" + this.chip + "|" + this._totalStaked() + "|" + Math.floor((this.balance || 0) / 5) + "|" +
      (rb ? rb.total + ":" + (rb.ok ? 1 : 0) + (rb.ok2 ? 1 : 0) : "-");
    if (sig === this._fsSig) return;
    this._fsSig = sig;
    E.fsbar._built = true;
    if (mode === "betting") this._buildControls(E.fsbar, m, mode, true);
    else { E.fsbar.innerHTML = ""; E.fsbar.appendChild(el("span", "fs-count", "")); E.fsbar.appendChild(el("span", "", '<span style="color:var(--muted);font-size:13px;font-weight:600">' + this._msg(m, mode).replace(/<[^>]*>/g, "") + "</span>")); }
  };

  // EMBED (TV channel): controls live in the parent page's dock under the TV.
  // Push the spec §5.5 dock-state on every render; the parent builds matching
  // controls and posts intents back (bac:cmd). One source of truth (this client).
  BaccaratClient.prototype._emitDock = function (m, mode, msg) {
    var total = this._totalStaked();
    var countMsLeft = (this.deadline && m && m.phase === "betting") ? Math.max(0, this.deadline - (Date.now() + this.skew)) : null;
    var rb = (mode === "betting" && total <= 0) ? this._rebetState() : null;
    var state = {
      type: "bac:dock", mode: mode, msg: msg,
      balance: this.balance, showEth: this.showEth,
      staked: { player: this.staked.player || 0, banker: this.staked.banker || 0, tie: this.staked.tie || 0 },
      totalStaked: total,
      canUndo: mode === "betting" && total > 0,
      canClear: mode === "betting" && total > 0,
      rebet: rb ? { total: rb.total, total2: rb.total2, ok: rb.ok, ok2: rb.ok2 } : null,
      betMin: 10, zoneMax: this.zoneMax,
      countMsLeft: countMsLeft,
      roomId: this.you ? this.you.roomId : (this.spectating || (m ? m.roomId : null)),
      phase: m ? m.phase : null,
      history: (m && m.history) || [],
      outcome: (m && m.phase === "settle") ? (m.outcome || null) : null,
      net: this._mySettle ? this._mySettle.net : null,
      fs: document.body.classList.contains("fs-embed"), // the parent heals fs-state drift (Safari rotate can strand the felt in fs-embed with the overlay off)
    };
    try { if (root.parent && root.parent !== root) root.parent.postMessage(state, root.location.origin); } catch (e) {} // same-origin target only
  };
  BaccaratClient.prototype._emitDockError = function (msg) {
    var state = { type: "bac:dock", mode: "waiting", msg: msg, balance: this.balance || 0, showEth: this.showEth, fs: document.body.classList.contains("fs-embed"),
      staked: { player: 0, banker: 0, tie: 0 }, totalStaked: 0, canUndo: false, canClear: false, rebet: null,
      betMin: 10, zoneMax: this.zoneMax, countMsLeft: null, roomId: null, phase: null, history: [], outcome: null, net: null };
    try { if (root.parent && root.parent !== root) root.parent.postMessage(state, root.location.origin); } catch (e) {}
  };

  /* ---------------- countdown tick ---------------- */
  BaccaratClient.prototype._tick = function () {
    var m = this.room, E = this.E;
    var betting = m && m.phase === "betting" && this.deadline;
    var remaining = betting ? Math.max(0, this.deadline - (Date.now() + this.skew)) : 0;
    var sec = Math.ceil(remaining / 1000);
    // "Last chance to bet…" swap at 3s — one re-render, both surfaces (spec §5.3)
    if (betting && remaining > 0 && remaining <= 3000 && !this._lastChance) { this._lastChance = true; this._renderDock(); }
    // non-embed dock: drain bar + seconds (the TV-channel countdown lives in the PARENT dock)
    if (!this.embed && E.countStrip) {
      if (betting) {
        var pct = Math.max(0, Math.min(100, (remaining / (this.phaseTotal || PHASE_TOTAL.betting)) * 100));
        if (E.countBar) E.countBar.style.width = pct.toFixed(1) + "%";
        if (E.countSec) E.countSec.textContent = "⏱ " + sec + " sec";
        E.countStrip.className = "count-strip on" + (sec <= 3 ? " crit" : (sec <= 5 ? " warn" : ""));
      } else if (E.countStrip.classList.contains("on")) E.countStrip.className = "count-strip";
    }
    // fullscreen bet bar countdown (the one exception to no-countdown-on-TV: in fullscreen the TV IS the screen)
    if (E.fsbar && document.body.classList.contains("fs-embed")) {
      var cnt = E.fsbar.querySelector(".fs-count");
      if (cnt) {
        cnt.textContent = betting ? ("⏱ " + sec + "s") : "";
        cnt.className = "fs-count" + (betting ? (sec <= 3 ? " crit" : (sec <= 5 ? " warn" : "")) : "");
      }
    }
  };

  /* ---------------- settle FX (spec §7 — wins loud, losses QUIET) ---------------- */
  BaccaratClient.prototype._onSettle = function (m) {
    this._clearActWatch();
    var oc = m.outcome; if (!oc) return;
    var FX = root.BaccaratFX, E = this.E, self = this;
    var winEl = this._zoneEl(oc.winner === "tie" ? "tie" : oc.winner);
    // (1) winning zone rim ignites gold, ×2 pulse — everyone sees it
    if (FX) FX.winZone(winEl);
    // losing zones dim 40% for 800ms; on a tie P/B are PUSHES, not losses — no dim
    if (oc.winner !== "tie" && FX) {
      ZONES.forEach(function (z) { if (z !== oc.winner) { var zn = self._zoneEl(z); if (zn) { zn.classList.remove("dimmed"); void zn.offsetWidth; zn.classList.add("dimmed"); } } });
    }
    // remember the completed map for REBET before the next snapshot wipes it
    if (this.you && this._totalStaked() > 0) this._lastBetsLocal = { player: this.staked.player, banker: this.staked.banker, tie: this.staked.tie };
    // my result
    var ps = null, list = m.perSeat || [];
    for (var i = 0; i < list.length; i++) if (this.you && list[i].seat === this.you.seat) ps = list[i];
    this._mySettle = ps || null;
    var myPuck = E.rail ? E.rail.querySelector(".puck.you") : null;
    if (ps && ps.net > 0 && FX) {
      var net = ps.net;
      var target = myPuck || E.balUsd || E.stage;
      setTimeout(function () { FX.chipFly(winEl, target, net >= 250 ? 5 : 4); }, 250);
      setTimeout(function () {
        FX.winPill(E.stage, net);
        if (myPuck) FX.floatUp(myPuck, "+" + money(net));
        // balance count-up on the standalone top-bar readout (parent dock animates its own via `net`)
        if (!self.embed && self.balance != null && E.balUsd) {
          FX.countUp(self.balance - net, self.balance, function (v) { E.balUsd.textContent = money(v); });
        }
      }, 400);
      if (root.BlackjackSFX) root.BlackjackSFX.win(net >= 250 ? "big" : "win"); // one muted chime; SILENCE on loss
      if (ps.zones && ps.zones.tie && ps.zones.tie.delta > 0) FX.confetti(E.stage); // tie win: ONE felt-confined burst
    } else if (ps && FX) {
      // LOSS = QUIET: my chips fade to 30% + drift 12px; pushes slide home. No sound, no shake, no red.
      ZONES.forEach(function (z) {
        var zbet = ps.zones && ps.zones[z]; if (!zbet || !(zbet.bet > 0)) return;
        var mineEl = document.getElementById("mine-" + z); if (!mineEl || !mineEl.firstChild) return;
        if (oc.winner === "tie" && z !== "tie") { FX.pushReturn(mineEl.firstChild); FX.floatUp(self._zoneEl(z), "returned", "#9aa7c7"); }
        else if (z !== oc.winner) FX.quietLoss(mineEl.firstChild);
      });
    }
    // losing TABLE stacks sweep to the shoe just before the road pops (round moves on)
    if (FX) setTimeout(function () {
      if (!self.room || self.room.phase !== "settle") return;
      ZONES.forEach(function (z) {
        if (z === oc.winner || (oc.winner === "tie" && z !== "tie")) return;
        var agg = document.getElementById("agg-" + z);
        if (agg && agg.firstChild) FX.sweep(agg.firstChild);
      });
    }, 2600);
    // winners ticker — one quiet line, 2s; absent when nobody (else) won (spec §6)
    if (E.ticker) {
      var names = [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].net > 0 && !(this.you && list[j].seat === this.you.seat)) names.push(this._name(list[j].wallet) + " <b>+" + money(list[j].net) + "</b>");
      }
      if (names.length) {
        E.ticker.innerHTML = names.join(" · ");
        clearTimeout(this._tickerT);
        this._tickerT = setTimeout(function () { if (E.ticker) E.ticker.textContent = ""; }, 2000);
      }
    }
    this._dockSig = null; this._fsSig = null; this._renderDock();
  };

  /* ---------------- balance / wallet ---------------- */
  BaccaratClient.prototype._renderBalance = function () {
    if (this.balance == null) return;
    if (this.E.balUsd) this.E.balUsd.textContent = money(this.balance);
    if (this.E.balEth) { if (this.showEth) { this.E.balEth.style.display = ""; this.E.balEth.textContent = eth(this.balance); } else this.E.balEth.style.display = "none"; }
  };
  BaccaratClient.prototype.setWallet = function (addr) {
    this.wallet = addr || null; this.showEth = isWallet(this.wallet);
    if (this.net) this.net.wallet = this.wallet;
    this._renderBalance(); this._dockSig = null; this._fsSig = null; this._renderDock();
  };

  /* ---------------- provably fair — replay the EXACT tableau ---------------- */
  BaccaratClient.prototype._renderPF = function () {
    var E = this.E, m = this.room;
    if (E.pfCommit) E.pfCommit.textContent = (m && m.commit) ? m.commit : "—";
    if (E.pfReveal) E.pfReveal.textContent = this.reveal ? ("serverSeed " + this.reveal.serverSeed) : "";
    if (E.pfChip) {
      var html = "round <code>#" + ((m && m.handNumber) || 0) + "</code><br>commit <code>" + shortHash(m && m.commit) + "</code>";
      if (E.pfChip.innerHTML !== html) E.pfChip.innerHTML = html;
    }
  };
  BaccaratClient.prototype._verify = function () {
    var out = this.E.pfOut, S = root.BlackjackShuffle, Rules = root.BaccaratRules;
    if (!this.reveal || !S || !Rules) { if (out) out.textContent = "Play a round first, then verify the revealed seed."; return; }
    var rv = this.reveal;
    var res = S.verify(rv.serverSeed, rv.commit, rv.clientSeeds || [], rv.shoeId, rv.decks || 8);
    var tab = Rules.runTableau(res.shoe);
    var fmt = function (cards) { return cards.map(function (c) { return rankLabel(c.rank) + SUIT[c.suit]; }).join(" "); };
    var verdict = tab.winner === "tie" ? "TIE " + tab.playerTotal + "–" + tab.bankerTotal
      : tab.winner.toUpperCase() + " WINS " + Math.max(tab.playerTotal, tab.bankerTotal) + "–" + Math.min(tab.playerTotal, tab.bankerTotal);
    out.innerHTML = (res.hashOk ? "✅ commit verified — SHA256(serverSeed) matches." : "⚠ hash mismatch!") +
      '<div class="pf-cards">PLAYER ' + fmt(tab.player) + " = " + tab.playerTotal +
      " · BANKER " + fmt(tab.banker) + " = " + tab.bankerTotal + " → " + verdict + "</div>" +
      '<span class="pf-reveal">replayed with BaccaratRules.runTableau over the verified shoe — compare with the round you watched</span>';
  };

  /* ---------------- fullscreen (spec §5.6 — proven rr-fs reparent pattern) ---------------- */
  BaccaratClient.prototype.isFullscreen = function () {
    var t = this.E.stageWrap;
    return !!(document.fullscreenElement || document.webkitFullscreenElement || (t && t.classList.contains("rr-fs")) || document.body.classList.contains("fs-embed"));
  };
  BaccaratClient.prototype.toggleFullscreen = function () {
    if (this.embed) {
      // the PARENT owns the layer: it reparents #layer-baccarat to <body> (rr-fs) and
      // answers with bac:active {fs:true|false}; the felt just asks.
      try { if (root.parent && root.parent !== root) root.parent.postMessage({ type: "bac:fs", on: !document.body.classList.contains("fs-embed") }, root.location.origin); } catch (e) {}
      return;
    }
    var target = this.E.stageWrap; if (!target) return;
    if (!target.classList.contains("rr-fs")) this._enterFs(target, false);
    else this._exitFs(target);
  };
  BaccaratClient.prototype._enterFs = function (target, skipNative) {
    if (!this._fsHome) this._fsHome = { parent: target.parentNode, next: target.nextSibling };
    if (target.parentNode !== document.body) document.body.appendChild(target); // escape the page stacking context (fishtable.js pattern)
    target.classList.add("rr-fs");
    document.documentElement.classList.add("rr-fs-on");
    document.body.classList.add("rr-fs-on");
    this.setFsEmbed(true);
    // FsUtil: native fullscreen (URL bar gone) where supported + tilt re-assertion + the
    // iOS/MetaMask fake-mode chrome-collapse. NO orientation lock — the felt has dedicated
    // portrait AND landscape fullscreen layouts (fs-portrait/fs-landscape).
    if (root.FsUtil) { try { root.FsUtil.enterFs(target, { skipNative: !!skipNative, lockOrientation: null }); } catch (e) {} }
    else if (!skipNative) {
      try { var req = target.requestFullscreen || target.webkitRequestFullscreen || target.webkitRequestFullScreen || target.msRequestFullscreen; if (req) req.call(target); } catch (e) {}
    }
  };
  BaccaratClient.prototype._exitFs = function (target) {
    target = target || this.E.stageWrap; if (!target || !target.classList.contains("rr-fs")) return;
    target.classList.remove("rr-fs");
    document.documentElement.classList.remove("rr-fs-on");
    document.body.classList.remove("rr-fs-on");
    if (this._fsHome && this._fsHome.parent) { try { this._fsHome.parent.insertBefore(target, this._fsHome.next || null); } catch (e) {} this._fsHome = null; }
    if (root.FsUtil) { try { root.FsUtil.exitFs(); } catch (e) {} } // exits native + stops re-assertion
    else { try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen(); } catch (e) {} }
    this.setFsEmbed(false);
  };
  // Android can drop native fullscreen while rotating — keep the CSS shell alive (fishtable sync pattern).
  BaccaratClient.prototype._wireFsSync = function () {
    var self = this;
    var sync = function () {
      var real = !!(document.fullscreenElement || document.webkitFullscreenElement);
      var t = self.E.stageWrap;
      if (!real && t && t.classList.contains("rr-fs") && self._fsWasReal) self._enterFs(t, true);
      self._fsWasReal = real;
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
  };
  // both paths land here: parent-driven (embed, via bac:active {fs, portrait}) or local (standalone).
  // `portrait` is the PARENT page's orientation (fs-landscape bug fix): at fs-enter the iframe's
  // own last-laid-out size is the 4:3 TV box — landscape-shaped even on a portrait phone — so
  // self-measuring picked body.fs-landscape on a portrait viewport. The parent's viewport is the
  // truth in embed mode; the parent re-posts it on every rotation/resize while fullscreen.
  BaccaratClient.prototype.setFsEmbed = function (on, portrait) {
    document.body.classList.toggle("fs-embed", !!on);
    if (portrait != null) { this._fsPortrait = !!portrait; this._fsPortraitAt = Date.now(); }
    if (!on) this._fsPortrait = null;
    this._fsSig = null;
    this._fit(); this._renderDock();
    // re-fit once the iframe has ACTUALLY grown to the promoted layer (the bac:active message
    // can land before the parent's relayout resizes this frame)
    var self = this;
    if (on && root.requestAnimationFrame) root.requestAnimationFrame(function () { root.requestAnimationFrame(function () { self._fit(); }); });
  };

  /* one fit() for every mode: TV scale / lobby width-scale / fullscreen portrait
     (fluid CSS column) / fullscreen landscape (scale above the bet bar). */
  BaccaratClient.prototype._fit = function () {
    var E = this.E, b = document.body;
    if (!E.stage) return;
    var w = root.innerWidth, h = root.innerHeight;
    if (b.classList.contains("fs-embed")) {
      // embed: trust the PARENT's orientation while the hint is FRESH (bac:active {portrait};
      // the parent re-posts on rotation) — the iframe's own w×h can be a stale pre-promotion
      // layout at fs-enter (fs-landscape bug fix). Once promoted, the iframe tracks the parent
      // viewport, so after the hint ages out self-measurement is correct again (and instant on
      // later rotations, where the parent's re-post takes ~80ms to arrive).
      var hintFresh = this.embed && this._fsPortrait != null && (Date.now() - (this._fsPortraitAt || 0) < 1500);
      var portrait = hintFresh ? !!this._fsPortrait : (h >= w);
      b.classList.toggle("fs-portrait", portrait);
      b.classList.toggle("fs-landscape", !portrait);
      if (portrait) { E.stage.style.transform = ""; if (E.stageWrap) E.stageWrap.style.height = ""; return; }
      var bar = (E.fsbar && E.fsbar.offsetHeight) || 84;
      var s = Math.min(w / 720, (h - bar - 8) / 540);
      E.stage.style.transform = "translate(-50%,-50%) scale(" + s + ")";
      if (E.stageWrap) E.stageWrap.style.height = "";
      return;
    }
    b.classList.remove("fs-portrait", "fs-landscape");
    if (this.embed) {
      var s2 = Math.min(w / 720, h / 540);
      E.stage.style.transform = "translate(-50%,-50%) scale(" + s2 + ")";
      if (E.stageWrap) E.stageWrap.style.height = "";
    } else {
      var ww = (E.stageWrap && E.stageWrap.clientWidth) || w;
      var s3 = Math.min(1, ww / 720);
      E.stage.style.transform = "translateX(-50%) scale(" + s3 + ")";
      if (E.stageWrap) E.stageWrap.style.height = Math.round(540 * s3) + "px";
    }
  };

  /* ---------------- toast ---------------- */
  BaccaratClient.prototype.toast = function (text, isErr) {
    var t = this.E.toast; if (!t) return; t.textContent = text; t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(this._toastT); this._toastT = setTimeout(function () { t.className = "toast"; }, 2600);
  };

  root.BaccaratClient = BaccaratClient;
})(typeof window !== "undefined" ? window : this);
