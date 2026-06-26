/* ============================================================
   blackjack-sfx.js — tiny self-contained card sound (WebAudio, no assets).
   Each card dealt/flipped gets a short "swoosh + snap". Lazily creates/resumes
   the AudioContext (browsers require a user gesture first — joining/betting counts).
     BlackjackSFX.card(delayMs)   // schedule a card sound delayMs from now
     BlackjackSFX.muted = true/false
   ============================================================ */
(function (root) {
  "use strict";
  var SFX = { muted: false, _ctx: null };

  SFX._ensure = function () {
    if (!this._ctx) { try { this._ctx = new (root.AudioContext || root.webkitAudioContext)(); } catch (e) { return null; } }
    if (this._ctx && this._ctx.state === "suspended") { try { this._ctx.resume(); } catch (e) {} }
    return this._ctx;
  };
  // resume on the first user gesture so audio is unlocked before the first deal
  SFX.unlock = function () { SFX._ensure(); };

  SFX.card = function (delayMs) {
    if (this.muted) return;
    var ctx = this._ensure(); if (!ctx) return;
    var t0 = ctx.currentTime + Math.max(0, (delayMs || 0) / 1000);

    // 1) the swoosh — a short noise burst through a bandpass that sweeps down
    var dur = 0.13;
    var buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 1.4);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(3400, t0); bp.frequency.exponentialRampToValueAtTime(850, t0 + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.42, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start(t0); src.stop(t0 + dur);

    // 2) the snap — a quick low triangle blip as the card lands
    var o = ctx.createOscillator(); o.type = "triangle";
    o.frequency.setValueAtTime(440, t0 + 0.02); o.frequency.exponentialRampToValueAtTime(150, t0 + 0.09);
    var og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0 + 0.02);
    og.gain.exponentialRampToValueAtTime(0.16, t0 + 0.032);
    og.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.1);
    o.connect(og); og.connect(ctx.destination);
    o.start(t0 + 0.02); o.stop(t0 + 0.12);
  };

  // unlock audio on the first pointer/key interaction anywhere
  if (root.addEventListener) {
    var unlock = function () { SFX.unlock(); root.removeEventListener("pointerdown", unlock); root.removeEventListener("keydown", unlock); };
    root.addEventListener("pointerdown", unlock); root.addEventListener("keydown", unlock);
  }

  root.BlackjackSFX = SFX;
})(typeof window !== "undefined" ? window : this);
