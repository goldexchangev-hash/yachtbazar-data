/* ============================================================
   crash-rounds-client.js — CLIENT seam for live token crash rounds (cr:* protocol).

   This is the ONE place a crash-family channel (crash / plane / swoop / pressure) talks
   to the server-paced round-runner. It does NOT draw anything — each channel keeps its
   own visuals and just supplies an onTick(multiplier) callback. The module:
     • sends cr:start / cr:cashout over the shared ws (via an injected send()),
     • animates the rising multiplier LOCALLY from the server's startedAt + k
       (reusing window.CrashEngine — identical curve to the server), and
     • resolves the round when the server pushes cr:result (the reveal).

   ── MANUAL IS THE DEFAULT ───────────────────────────────────────────────────
   start({ ... }) with NO autoTarget ⇒ the round climbs until the player taps cashOut()
   (or it busts). Pass autoTarget>1.01 to opt IN to auto-cash-out. This matches the owner's
   rule: "load with auto cash-out OFF until they turn it on."

   ── WHY THE LOCAL CLOCK IS SAFE ─────────────────────────────────────────────
   We start the local animation clock when cr:started arrives (≈ server start + latency),
   so the displayed multiplier can only LAG the server, never lead it. Settlement is always
   the SERVER's number (the player can't claim a stale-low value, can't out-run the bust).
   If it busts, the server timer pushes cr:result and we snap the visual to crashPoint.

   USAGE (per channel):
     var CR = window.CrashRoundsClient.make({ send: wsSend });   // once
     // feed every incoming cr:* message:  CR.handle(msg)
     CR.start({ sessionId, sessionToken, game:"swoop", betUnits:10,
                autoTarget:0,                 // 0/absent = MANUAL (default)
                onTick:function(m){ HUD.show(m); drawCurve(m); } })
       .then(function(res){ res.busted ? boom(res.crashPoint) : win(res.cashOutAt, res.payoutUnits); })
       .catch(function(e){ ...auth/owner error... });
     // tap handler:  CR.cashOut();

   ── EDIT MAP ────────────────────────────────────────────────────────────────
   • make({ send, engine?, raf?, now? })  — inject transport / curve / clock (tests do).
   • onTick(mult, elapsedMs, result?)     — the only hook a channel needs to animate.
   • start()/cashOut()/active()           — the channel-facing API.
   ============================================================ */
(function (root) {
  "use strict";

  function make(opts) {
    opts = opts || {};
    var send = typeof opts.send === "function" ? opts.send : function () {};
    var CE = opts.engine || root.CrashEngine;          // window.CrashEngine (same curve as server)
    var nowMs = typeof opts.now === "function" ? opts.now
      : function () { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); };
    var raf = opts.raf || (root.requestAnimationFrame ? root.requestAnimationFrame.bind(root)
      : function (f) { return setTimeout(function () { f(nowMs()); }, 16); });
    var caf = opts.caf || (root.cancelAnimationFrame ? root.cancelAnimationFrame.bind(root)
      : function (h) { clearTimeout(h); });
    // Watchdog clock: a dropped socket / server crash mid-round must NOT hang the promise
    // forever (that strands the channel — revealLock stuck, balance frozen). Bound the wait
    // for the start-ack and for the result; on timeout we reject so the channel's .catch
    // refunds + unlocks. Injectable for the deterministic self-test.
    var setTo = opts.setTimeout || (root.setTimeout ? root.setTimeout.bind(root) : setTimeout);
    var clearTo = opts.clearTimeout || (root.clearTimeout ? root.clearTimeout.bind(root) : clearTimeout);
    var ackMs = opts.ackTimeoutMs || 12000;     // server must ack cr:start within this
    var roundMs = opts.roundTimeoutMs || 120000; // a round must resolve within this (it always busts well before)
    function arm(ms, fn) { var h = setTo(fn, ms); if (h && h.unref) h.unref(); return h; }
    function clearTimers(l) { if (!l) return; if (l.ackT) clearTo(l.ackT); if (l.resT) clearTo(l.resT); l.ackT = 0; l.resT = 0; }
    var live = null; // the in-flight round, or null

    // Route an incoming cr:* message. A channel pipes every cr:* frame here.
    function handle(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === "cr:started") onStarted(msg);
      else if (msg.type === "cr:result") onResult(msg);
      else if (msg.type === "cr:error") onError(msg);
      // cr:pong etc. — ignored
    }

    // Begin a round. Returns a promise that resolves to the cr:result (busted or win).
    // o: { sessionId, sessionToken, game, betUnits, autoTarget?, clientSeed?, onTick? }
    function start(o) {
      if (live) return Promise.reject(new Error("a round is already live"));
      o = o || {};
      var pending = {
        game: o.game || "crash",
        onTick: typeof o.onTick === "function" ? o.onTick : function () {},
        roundId: null, startedAt: 0, k: 0, localBase: 0, rafH: 0, ackT: 0, resT: 0,
        resolve: null, reject: null,
      };
      var p = new Promise(function (res, rej) { pending.resolve = res; pending.reject = rej; });
      live = pending;
      var sent = send({
        type: "cr:start",
        sessionId: o.sessionId, sessionToken: o.sessionToken,
        gameKey: pending.game, betUnits: o.betUnits,
        autoTarget: o.autoTarget || 0,            // 0/absent ⇒ MANUAL (default)
        clientSeed: o.clientSeed || randSeed(),
      });
      // send() returns false ONLY when the socket is closed and the frame was dropped. Fail fast with a
      // clear message + (the host's send wrapper) reconnect, instead of the misleading 12s ack hang (#86).
      // (undefined ⇒ a legacy transport that doesn't report ⇒ treat as sent and rely on the ack timeout.)
      if (sent === false) { failRound("Couldn't reach the table — connection lost. Reconnecting… tap LAUNCH again in a moment. (Your stake was not taken.)"); return p; }
      pending.ackT = arm(ackMs, function () { failRound("Round didn't start — connection lost. Your stake was not taken."); });
      return p;
    }

    // Reject + tear down a stuck round (timeout). Mirrors onError's cleanup.
    function failRound(message) {
      if (!live) return;
      var l = live; live = null;
      if (l.rafH) caf(l.rafH);
      clearTimers(l);
      l.reject(new Error(message));
    }

    function onStarted(msg) {
      if (!live || live.roundId) return;          // ignore a stray/duplicate start
      if (live.ackT) { clearTo(live.ackT); live.ackT = 0; }
      live.resT = arm(roundMs, function () { failRound("CR_ROUND_TIMEOUT"); }); // #108: sentinel — the UI reconciles from the ledger (the round DID start; stake was taken)
      live.roundId = msg.roundId;
      live.startedAt = msg.startedAt;
      live.k = msg.k;
      live.localBase = nowMs();                   // treat receipt as t≈0 (safe lag, never lead)
      tick();
    }

    function tick() {
      if (!live || !live.roundId) return;
      var elapsed = nowMs() - live.localBase;
      var m = Math.floor(CE.multiplierAtMs(elapsed, live.k) * 100) / 100;
      try { live.onTick(m, elapsed, null); } catch (e) {}
      live.rafH = raf(tick);
    }

    // Manual tap. We only REQUEST the cash-out; the server settles at its own multiplier.
    // v6 #24: latch so a fast double-tap sends only ONE cr:cashout frame. The latch lives on `live`, which
    // onResult nulls when the round settles (bust or cash) — so it always resets for the next round, and even a
    // lost frame clears when the server timer resolves the round. (Duplicates are already a harmless server
    // no-op — crash-rounds.js refuses a settled round — so this is just network hygiene.)
    function cashOut() { if (live && live.roundId && !live.cashoutRequested) { live.cashoutRequested = true; send({ type: "cr:cashout", roundId: live.roundId }); } }

    function onResult(msg) {
      if (!live) return;
      var l = live; live = null;
      if (l.rafH) caf(l.rafH);
      clearTimers(l);
      // Snap the visual to the revealed crash point so the explosion/cash-out lands exactly.
      try { l.onTick(msg.crashPoint, null, msg); } catch (e) {}
      l.resolve(msg);
    }

    function onError(msg) {
      if (!live) return;
      var l = live; live = null;
      if (l.rafH) caf(l.rafH);
      clearTimers(l);
      l.reject(new Error((msg && msg.message) || "round error"));
    }

    function randSeed() { var s = ""; for (var i = 0; i < 8; i++) s += (Math.random() * 16 | 0).toString(16); return s; }

    // Tear down the current round locally (timers + promise) without touching the ledger. Called on a
    // crash-family channel LEAVE so a stuck/in-flight round on one channel can't wedge the shared
    // singleton for the next channel (#22). The server cash-out is requested by the channel first; the
    // authoritative balance is reconciled by the host. No-op if nothing is live.
    function cancel(reason) {
      if (!live) return;
      var l = live; live = null;
      if (l.rafH) caf(l.rafH);
      clearTimers(l);
      try { l.reject(new Error(reason || "round cancelled — left the channel")); } catch (e) {}
    }
    return { handle: handle, start: start, cashOut: cashOut, cancel: cancel, active: function () { return !!live; } };
  }

  root.CrashRoundsClient = { make: make };

  /* ---------------- node self-test: node public/crash-rounds-client.js ---------------- */
  if (typeof module !== "undefined" && module.exports && require.main === module) {
    var CE = require("./crash-engine.js");
    var ok = true;
    var eq = function (label, cond) { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

    // controllable clock + synchronous "raf" so we can step the animation deterministically
    var clock = 0;
    var now = function () { return clock; };
    var rafQ = [];
    var raf = function (f) { var h = { f: f, dead: false }; rafQ.push(h); return h; };
    var caf = function (h) { if (h) h.dead = true; };
    var pump = function () { var q = rafQ.slice(); rafQ.length = 0; for (var i = 0; i < q.length; i++) if (!q[i].dead) q[i].f(now()); };

    var outbox = [];
    var CR = make({ send: function (o) { outbox.push(o); }, engine: CE, now: now, raf: raf, caf: caf });

    // start → emits cr:start with MANUAL default (autoTarget 0)
    var ticks = [];
    var done = null;
    clock = 0; outbox.length = 0;
    var pr = CR.start({ sessionId: "s1", sessionToken: "t", game: "swoop", betUnits: 10, onTick: function (m) { ticks.push(m); } });
    pr.then(function (r) { done = r; });
    eq("start sends cr:start with manual default (autoTarget 0)", outbox[0] && outbox[0].type === "cr:start" && outbox[0].autoTarget === 0 && outbox[0].gameKey === "swoop");
    eq("round is active after start", CR.active() === true);

    // server acknowledges → animation begins from t≈0
    CR.handle({ type: "cr:started", roundId: "cr1", startedAt: 999999, k: CE.DEFAULT_K });
    clock = 5000; pump(); // ~1.64x
    var expM = Math.floor(CE.multiplierAtMs(5000, CE.DEFAULT_K) * 100) / 100;
    eq("onTick animates the curve from the server k (" + expM + "x)", ticks.indexOf(expM) !== -1 || Math.abs(ticks[ticks.length - 1] - expM) < 0.02);

    // manual cash-out request
    outbox.length = 0;
    CR.cashOut();
    eq("cashOut sends cr:cashout with the roundId", outbox[0] && outbox[0].type === "cr:cashout" && outbox[0].roundId === "cr1");

    // server result (win) resolves the promise + snaps the visual to crashPoint
    CR.handle({ type: "cr:result", roundId: "cr1", busted: false, win: true, cashOutAt: expM, crashPoint: 4.0, payoutUnits: 10 * expM, tokens: 1040 });
    setTimeout(function () {
      eq("cr:result resolves the round (win)", done && done.win && done.crashPoint === 4.0);
      eq("round is no longer active after result", CR.active() === false);
      eq("final onTick snapped to the crash point", ticks[ticks.length - 1] === 4.0);

      // a busted round rejects nothing — it RESOLVES with busted:true
      var done2 = null, err2 = null;
      CR.start({ sessionId: "s1", sessionToken: "t", betUnits: 5, onTick: function () {} }).then(function (r) { done2 = r; }, function (e) { err2 = e; });
      CR.handle({ type: "cr:started", roundId: "cr2", startedAt: 0, k: CE.DEFAULT_K });
      CR.handle({ type: "cr:result", roundId: "cr2", busted: true, win: false, cashOutAt: null, crashPoint: 1.5, payoutUnits: 0, tokens: 1035 });
      setTimeout(function () {
        eq("a bust resolves with busted:true (not a rejection)", done2 && done2.busted && !err2);

        // an auth error rejects the start promise
        var err3 = null;
        CR.start({ sessionId: "bad", sessionToken: "x", betUnits: 5, onTick: function () {} }).then(null, function (e) { err3 = e; });
        CR.handle({ type: "cr:error", code: "auth", message: "buy in with tokens first" });
        setTimeout(function () {
          eq("cr:error rejects the start promise", err3 && /buy in/.test(err3.message));
          console.log(ok ? "\nSELF-TEST OK — crash rounds client: manual-default, curve animation, cash-out, bust, auth error."
                         : "\nSELF-TEST FAILED");
          process.exit(ok ? 0 : 1);
        }, 0);
      }, 0);
    }, 0);
  }
})(typeof window !== "undefined" ? window : globalThis);
