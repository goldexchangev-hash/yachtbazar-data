/* ============================================================
   blackjack-net.js — thin WebSocket client for the blackjack sub-protocol.
   Connects to the same hub the rest of Crypto TV uses, auto-reconnects, and
   dispatches `bj:*` messages to typed listeners. Intents queue until OPEN.

     const net = new BJNet({ wallet: myAddress });   // wallet optional
     net.on("bj:lobby:list", (m) => render(m.rooms));
     net.send({ type: "bj:lobby:subscribe" });
   ============================================================ */
(function (root) {
  "use strict";

  function BJNet(opts) {
    opts = opts || {};
    this.wallet = opts.wallet || null;
    this.bjToken = opts.bjToken || "";
    this.bjSession = opts.bjSession || ""; // token-bridge session id (real-money table funded by tokens)
    this.url = opts.url || ((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    this.handlers = {};      // type -> [fn]
    this.anyHandlers = [];    // fn(msg) for every message
    this.queue = [];          // outbound intents buffered while not OPEN
    this._open = false;
    this._closedByUs = false;
    this._backoff = 600;
    this._lastRx = 0; this._hb = null; // heartbeat: detect a half-open (silently dead) socket
    // Network back after a flap → reconnect NOW instead of waiting out the backoff (ensureConnected
    // no-ops when healthy, and also drops a half-open socket past the 35s staleness bound).
    var self = this;
    try { if (root.addEventListener) root.addEventListener("online", function () { self.ensureConnected(); }); } catch (e) {}
    this.connect();
  }

  BJNet.prototype.connect = function () {
    var self = this;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return; // never stack a second live socket (ensureConnected — fired by visibilitychange AND pageshow — can race a pending _scheduleReconnect timer)
    var sock;
    this._connectingAt = Date.now(); // handshake start — ensureConnected aborts a CONNECTING socket stuck past 10s
    try { sock = this.ws = new WebSocket(this.url); } catch (e) { this._scheduleReconnect(); return; }
    // v13.18 pattern from app.js: scope every handler to the CAPTURED sock so an orphaned
    // socket's late events can never flip _open, kill the live heartbeat, or double-emit.
    sock.onopen = function () {
      if (self.ws !== sock) { try { sock.close(); } catch (e) {} return; } // orphaned by a newer connect
      self._open = true; self._backoff = 600; self._lastRx = Date.now(); self._startHeartbeat();
      // Identify to the hub UNCONDITIONALLY (was: only when a wallet was loaded). The server gates all bj:*
      // intents (room list / join) behind a seen `hello`, so a guest — or a player whose wallet/token hasn't
      // loaded yet when the felt's socket opens (common on a phone) — was silently blocked from SEEING or
      // JOINING any room. Sending hello with an empty address marks the socket identified; the server binds the
      // token session when bjToken/bjSession are present, else treats it as a guest (play-money). No guard weakened.
      try { sock.send(JSON.stringify({ type: "hello", address: self.wallet || "", bjToken: self.bjToken || undefined, bjSession: self.bjSession || undefined })); } catch (e) {}
      var q = self.queue; self.queue = [];
      for (var i = 0; i < q.length; i++) self._raw(q[i]);
      self._emit({ type: "bj:net", state: "open" });
    };
    sock.onmessage = function (ev) {
      if (self.ws !== sock) return; // orphaned socket must not double-emit
      self._lastRx = Date.now(); // any inbound traffic (incl. bj:pong) means the socket is alive
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && typeof m.type === "string") { if (m.type === "bj:pong") return; self._emit(m); }
    };
    sock.onclose = function () {
      if (self.ws !== sock) return; // a late close of an orphaned socket must not flip _open / kill the live heartbeat / schedule another reconnect
      self._open = false; self._stopHeartbeat();
      self._emit({ type: "bj:net", state: "closed" });
      if (!self._closedByUs) self._scheduleReconnect();
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} }; // close the SPECIFIC socket that errored
  };

  // Force an immediate reconnect if the socket is dead/closing (e.g. the OS froze it
  // while the tab was backgrounded on mobile). No-op if open or already connecting.
  BJNet.prototype.ensureConnected = function () {
    if (this._closedByUs) return;
    var rs = this.ws ? this.ws.readyState : 3;
    if (rs === 0) { if (this._connectingAt && Date.now() - this._connectingAt > 10000) { try { this.ws.close(); } catch (e) {} } return; } // CONNECTING → leave a fresh handshake alone, but abort one stuck >10s (healthy is <3s): close() fails the connection → onclose → _scheduleReconnect, so a wedged handshake can't starve reconnects
    if (rs === 1) {
      // OPEN — but possibly half-open after a background freeze: if we're already past the
      // heartbeat's own 35s staleness bound, drop it NOW (onclose reconnects and bj:net open
      // re-joins the table) instead of waiting up to 15s for the next heartbeat tick.
      if (this._lastRx && Date.now() - this._lastRx > 35000) { try { this.ws.close(); } catch (e) {} }
      return;
    }
    this._backoff = 600; this.connect();
  };

  // App-level heartbeat: ping every 15s; if no inbound traffic for 35s the socket is half-open
  // (mobile OS froze it / a proxy stopped forwarding without a FIN) → force-close so we reconnect
  // and pull a fresh snapshot, instead of sitting on a frozen felt forever.
  BJNet.prototype._startHeartbeat = function () {
    var self = this; this._stopHeartbeat();
    this._hb = setInterval(function () {
      if (!self.ws || self.ws.readyState !== 1) return;
      if (Date.now() - self._lastRx > 35000) { try { self.ws.close(); } catch (e) {} return; } // stale → drop → reconnect
      try { self.ws.send(JSON.stringify({ type: "bj:ping" })); } catch (e) {}
    }, 15000);
  };
  BJNet.prototype._stopHeartbeat = function () { if (this._hb) { clearInterval(this._hb); this._hb = null; } };

  BJNet.prototype._scheduleReconnect = function () {
    var self = this;
    var d = this._backoff; // schedule at the CURRENT rung (first retry = 600ms, matching app.js), THEN grow
    this._backoff = Math.min(this._backoff * 1.6, 8000);
    setTimeout(function () { if (!self._closedByUs) self.connect(); }, d);
  };

  BJNet.prototype._raw = function (obj) { try { this.ws.send(JSON.stringify(obj)); } catch (e) { this.queue.push(obj); } };

  BJNet.prototype.send = function (obj) {
    if (this.wallet && obj && obj.wallet == null) obj.wallet = this.wallet; // hint only; server overrides with trusted id
    if (this._open && this.ws && this.ws.readyState === 1) this._raw(obj);
    else this.queue.push(obj);
  };

  BJNet.prototype.on = function (type, fn) {
    if (type === "*") { this.anyHandlers.push(fn); return this; }
    (this.handlers[type] = this.handlers[type] || []).push(fn); return this;
  };

  BJNet.prototype._emit = function (m) {
    var hs = this.handlers[m.type];
    if (hs) for (var i = 0; i < hs.length; i++) { try { hs[i](m); } catch (e) { if (root.console) console.error(e); } }
    for (var j = 0; j < this.anyHandlers.length; j++) { try { this.anyHandlers[j](m); } catch (e) {} }
  };

  BJNet.prototype.close = function () { this._closedByUs = true; try { this.ws.close(); } catch (e) {} };

  root.BJNet = BJNet;
})(typeof window !== "undefined" ? window : this);
