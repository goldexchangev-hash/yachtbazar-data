/* ============================================================
   chiptune.js — chilled background music + retro SFX (Web Audio API).

   Music: a ~55-second, 16-bar lo-fi loop (A/B sections so it doesn't feel
   repetitive) with a soft hi-hat groove — all synthesized, no copyrighted
   audio. Drop your own track at public/music.mp3 to use that instead.

   window.Chiptune: .toggle() .start() .stop() .isOn()  .blip() .coin() .win() .lose()
   ============================================================ */
(function () {
  "use strict";

  const NOTES = {};
  (function () {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    for (let oct = 1; oct <= 6; oct++)
      for (let i = 0; i < 12; i++) {
        const n = 12 * (oct + 1) + i;
        NOTES[names[i] + oct] = 440 * Math.pow(2, (n - 69) / 12);
      }
  })();

  const TEMPO = 72;
  const BEAT = 60 / TEMPO;
  const BAR = 4 * BEAT;

  // 16-bar lo-fi progression. Each bar: chord (pad) + a sparse melody on 4 beats
  // ("-" = rest). Section A (1-8) and a varied Section B (9-16) keep it fresh.
  const PROG = [
    // ---- A ----
    { chord: ["A2", "C4", "E4", "G4"], mel: ["E5", "-", "C5", "-"] },
    { chord: ["D2", "F3", "A3", "C4"], mel: ["D5", "-", "A4", "F5"] },
    { chord: ["G2", "B3", "D4", "F4"], mel: ["G4", "-", "B4", "-"] },
    { chord: ["C3", "E4", "G4", "B4"], mel: ["C5", "E5", "-", "G5"] },
    { chord: ["F2", "A3", "C4", "E4"], mel: ["A4", "-", "F5", "-"] },
    { chord: ["E2", "G3", "B3", "D4"], mel: ["B4", "-", "G4", "B4"] },
    { chord: ["D2", "F3", "A3", "C4"], mel: ["F5", "-", "D5", "-"] },
    { chord: ["E2", "G#3", "B3", "D4"], mel: ["E5", "D5", "-", "B4"] },
    // ---- B (lifts an octave, more movement) ----
    { chord: ["A2", "C4", "E4", "G4"], mel: ["A5", "-", "E5", "C5"] },
    { chord: ["F2", "A3", "C4", "E4"], mel: ["C6", "-", "A5", "-"] },
    { chord: ["C3", "E4", "G4", "B4"], mel: ["G5", "E5", "-", "C5"] },
    { chord: ["G2", "B3", "D4", "F4"], mel: ["D5", "-", "B4", "D5"] },
    { chord: ["D2", "F3", "A3", "C4"], mel: ["F5", "A5", "-", "D5"] },
    { chord: ["E2", "G3", "B3", "D4"], mel: ["G5", "-", "B5", "-"] },
    { chord: ["F2", "A3", "C4", "E4"], mel: ["A5", "G5", "-", "F5"] },
    { chord: ["E2", "G#3", "B3", "D4"], mel: ["E5", "-", "D5", "B4"] },
  ];

  let ctx = null, master = null, musicGain = null, noiseBuf = null;
  let on = false, barIdx = 0, nextBarTime = 0, schedulerTimer = null;

  let audioEl = null, customReady = false;
  (function probeCustom() {
    try {
      audioEl = new Audio("music.mp3");
      audioEl.loop = true;
      audioEl.volume = 0.6;
      audioEl.preload = "auto";
      audioEl.addEventListener("canplaythrough", () => (customReady = true), { once: true });
      audioEl.addEventListener("error", () => (customReady = false));
    } catch { audioEl = null; }
  })();

  function ensureCtx() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.34; // clearly audible but still background
    musicGain.connect(master);
    // small noise buffer for the hi-hat
    const len = Math.floor(ctx.sampleRate * 0.2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  function voice(freq, start, dur, type, gainTarget, peak, attack, release) {
    if (!freq) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const a = attack == null ? 0.01 : attack;
    const r = release == null ? Math.min(0.1, dur * 0.4) : release;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + a);
    g.gain.setValueAtTime(peak, Math.max(start + a, start + dur - r));
    g.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(g);
    g.connect(gainTarget || master);
    osc.start(start);
    osc.stop(start + dur + 0.03);
  }

  function hat(start, peak) {
    if (!noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.05);
    src.connect(hp); hp.connect(g); g.connect(master);
    src.start(start); src.stop(start + 0.06);
  }

  function scheduleBar(t) {
    const bar = PROG[barIdx % PROG.length];
    for (const n of bar.chord) {
      voice(NOTES[n], t, BAR * 0.98, "sine", musicGain, 0.3, 0.4, 0.6); // soft pad
    }
    bar.mel.forEach((n, i) => {
      if (n && n !== "-") {
        voice(NOTES[n], t + i * BEAT, BEAT * 1.5, "triangle", musicGain, 0.22, 0.03, 0.25);
        voice(NOTES[n] * 2, t + i * BEAT, BEAT * 0.6, "sine", musicGain, 0.05, 0.02, 0.2); // shimmer
      }
    });
    // lo-fi hat groove: soft tick on each beat, accent on the offbeats
    for (let b = 0; b < 4; b++) {
      hat(t + b * BEAT, 0.05);
      hat(t + b * BEAT + BEAT * 0.5, 0.085);
    }
    barIdx++;
  }

  function scheduler() {
    if (!on || !ctx) return;
    while (nextBarTime < ctx.currentTime + 0.7) {
      scheduleBar(nextBarTime);
      nextBarTime += BAR;
    }
    schedulerTimer = setTimeout(scheduler, 130);
  }

  const Chiptune = {
    isOn: () => on,
    start() {
      ensureCtx();
      if (!ctx) {
        if (customReady && audioEl) { on = true; audioEl.currentTime = 0; audioEl.play().catch(() => {}); }
        return on;
      }
      if (on) return true;
      on = true;
      // iOS/Safari unlock: play a 1-sample silent buffer + resume, all inside the gesture.
      try {
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, 22050);
        b.connect(ctx.destination);
        b.start(0);
      } catch {}
      try { ctx.resume(); } catch {}
      if (customReady && audioEl) { audioEl.currentTime = 0; audioEl.play().catch(() => {}); return true; }
      // Schedule SYNCHRONOUSLY (not in a promise) so the first notes play on the very
      // first tap; the 0.35s head-start covers the context's wake-up time.
      barIdx = 0;
      nextBarTime = ctx.currentTime + 0.35;
      scheduler();
      return true;
    },
    stop() {
      on = false;
      if (schedulerTimer) clearTimeout(schedulerTimer);
      schedulerTimer = null;
      if (audioEl) { try { audioEl.pause(); } catch {} }
    },
    toggle() { return on ? (this.stop(), false) : this.start(); },

    _sfx() {
      ensureCtx();
      if (!ctx) return false;
      if (ctx.state === "suspended") ctx.resume();
      return true;
    },
    blip() { if (this._sfx()) voice(NOTES["A5"], ctx.currentTime, 0.08, "square", master, 0.28); },
    coin() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      voice(NOTES["B5"], t, 0.07, "square", master, 0.26);
      voice(NOTES["E6"], t + 0.07, 0.18, "square", master, 0.26);
    },
    win() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      ["C5", "E5", "G5", "C6", "E6"].forEach((n, i) => voice(NOTES[n], t + i * 0.1, 0.16, "square", master, 0.3));
    },
    lose() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      ["G4", "F#4", "F4", "E4"].forEach((n, i) => voice(NOTES[n], t + i * 0.14, 0.22, "triangle", master, 0.34));
    },
  };

  window.Chiptune = Chiptune;
})();
