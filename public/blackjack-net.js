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
    this.url = opts.url || ((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    this.handlers = {};      // type -> [fn]
    this.anyHandlers = [];    // fn(msg) for every message
    this.queue = [];          // outbound intents buffered while not OPEN
    this._open = false;
    this._closedByUs = false;
    this._backoff = 600;
    this._lastRx = 0; this._hb = null; // heartbeat: detect a half-open (silently dead) socket
    this.connect();
  }

  BJNet.prototype.connect = function () {
    var self = this;
    try { this.ws = new WebSocket(this.url); } catch (e) { this._scheduleReconnect(); return; }
    this.ws.onopen = function () {
      self._open = true; self._backoff = 600; self._lastRx = Date.now(); self._startHeartbeat();
      // identify to the hub so the live "players" count includes us (best-effort).
      if (self.wallet) { try { self.ws.send(JSON.stringify({ type: "hello", address: self.wallet, bjToken: self.bjToken || undefined })); } catch (e) {} }
      var q = self.queue; self.queue = [];
      for (var i = 0; i < q.length; i++) self._raw(q[i]);
      self._emit({ type: "bj:net", state: "open" });
    };
    this.ws.onmessage = function (ev) {
      self._lastRx = Date.now(); // any inbound traffic (incl. bj:pong) means the socket is alive
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && typeof m.type === "string") { if (m.type === "bj:pong") return; self._emit(m); }
    };
    this.ws.onclose = function () {
      self._open = false; self._stopHeartbeat();
      self._emit({ type: "bj:net", state: "closed" });
      if (!self._closedByUs) self._scheduleReconnect();
    };
    this.ws.onerror = function () { try { self.ws.close(); } catch (e) {} };
  };

  // Force an immediate reconnect if the socket is dead/closing (e.g. the OS froze it
  // while the tab was backgrounded on mobile). No-op if open or already connecting.
  BJNet.prototype.ensureConnected = function () {
    if (this._closedByUs) return;
    var rs = this.ws ? this.ws.readyState : 3;
    if (rs === 1 || rs === 0) return; // OPEN or CONNECTING → leave it
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
    this._backoff = Math.min(this._backoff * 1.6, 8000);
    setTimeout(function () { if (!self._closedByUs) self.connect(); }, this._backoff);
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
