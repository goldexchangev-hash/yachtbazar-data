/* ============================================================
   chiptune.js — slow, calm background music + retro SFX (Web Audio API).

   Music: a slow (~50 BPM) ~2-minute, 24-bar ambient lo-fi loop in 3 sections
   (A/B/C so it doesn't feel repetitive). Soft swelling sine pads, a sparse
   gentle melody, and just a faint pulse instead of a busy hi-hat — all
   synthesized, no copyrighted audio. Drop your own track at public/music.mp3
   to use that instead.

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

  const TEMPO = 50; // slow & calm; BAR ≈ 4.8s, so 24 bars ≈ 1m55s before it loops
  const BEAT = 60 / TEMPO;
  const BAR = 4 * BEAT;

  // 24-bar slow ambient progression in A-minor. Each bar: a soft pad chord plus
  // a very sparse melody on 4 beats ("-" = rest, lots of space = calm). Three
  // 8-bar sections (A/B/C) keep the long loop from feeling repetitive. The
  // melody stays in a low register (oct 4-5) for a mellow, unhurried feel.
  const PROG = [
    // ---- A: settle in ----
    { chord: ["A2", "E3", "A3", "C4"], mel: ["-", "E4", "-", "-"] },
    { chord: ["F2", "C3", "F3", "A3"], mel: ["-", "-", "A4", "-"] },
    { chord: ["C3", "G3", "C4", "E4"], mel: ["G4", "-", "-", "E4"] },
    { chord: ["G2", "D3", "G3", "B3"], mel: ["-", "D4", "-", "-"] },
    { chord: ["D3", "A3", "D4", "F4"], mel: ["-", "F4", "-", "A4"] },
    { chord: ["A2", "E3", "A3", "C4"], mel: ["E4", "-", "C4", "-"] },
    { chord: ["E3", "B3", "E4", "G4"], mel: ["-", "-", "B4", "-"] },
    { chord: ["E3", "B3", "E4", "G4"], mel: ["G4", "-", "-", "-"] },
    // ---- B: gentle drift ----
    { chord: ["F2", "C3", "F3", "A3"], mel: ["-", "A4", "-", "C5"] },
    { chord: ["C3", "G3", "C4", "E4"], mel: ["-", "-", "E5", "-"] },
    { chord: ["D3", "A3", "D4", "F4"], mel: ["D5", "-", "-", "A4"] },
    { chord: ["A2", "E3", "A3", "C4"], mel: ["-", "C5", "-", "-"] },
    { chord: ["G2", "D3", "G3", "B3"], mel: ["-", "B4", "-", "D5"] },
    { chord: ["E3", "B3", "E4", "G4"], mel: ["E5", "-", "-", "-"] },
    { chord: ["F2", "C3", "F3", "A3"], mel: ["-", "-", "A4", "-"] },
    { chord: ["G2", "D3", "G3", "B3"], mel: ["G4", "-", "D4", "-"] },
    // ---- C: come home ----
    { chord: ["A2", "E3", "A3", "C4"], mel: ["-", "E4", "-", "A4"] },
    { chord: ["F2", "C3", "F3", "A3"], mel: ["-", "-", "C5", "-"] },
    { chord: ["C3", "G3", "C4", "E4"], mel: ["E5", "-", "-", "G4"] },
    { chord: ["E3", "B3", "E4", "G4"], mel: ["-", "B4", "-", "-"] },
    { chord: ["D3", "A3", "D4", "F4"], mel: ["-", "-", "F4", "-"] },
    { chord: ["A2", "E3", "A3", "C4"], mel: ["A4", "-", "E4", "-"] },
    { chord: ["E3", "B3", "E4", "G4"], mel: ["-", "G4", "-", "-"] },
    { chord: ["A2", "E3", "A3", "C4"], mel: ["-", "-", "A3", "-"] },
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

  function hat(start, peak, cutoff) {
    if (!noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = cutoff == null ? 7000 : cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.08);
    src.connect(hp); hp.connect(g); g.connect(master);
    src.start(start); src.stop(start + 0.1);
  }

  function scheduleBar(t) {
    const bar = PROG[barIdx % PROG.length];
    // Soft pads that swell in slowly and fade out — long attack/release = calm.
    for (const n of bar.chord) {
      voice(NOTES[n], t, BAR * 0.99, "sine", musicGain, 0.22, 1.2, 1.6);
    }
    // Sparse, gently ringing melody (single soft triangle voice, no bright shimmer).
    bar.mel.forEach((n, i) => {
      if (n && n !== "-") {
        voice(NOTES[n], t + i * BEAT, BEAT * 1.8, "triangle", musicGain, 0.15, 0.06, 0.8);
      }
    });
    // Just a faint, soft pulse on beats 1 & 3 — keeps a slow heartbeat, not a groove.
    hat(t, 0.02, 3200);
    hat(t + 2 * BEAT, 0.02, 3200);
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
      // Always unlock + resume (safe to repeat). iOS only honors this on a
      // *completed* gesture (touchend/click), so callers fire it on those.
      try {
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, 22050);
        b.connect(ctx.destination);
        b.start(0);
      } catch {}
      try { ctx.resume(); } catch {}
      if (on) return true;
      on = true;
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
    // Big win ($100+ pot): a brighter rising arpeggio.
    bigwin() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      ["C5", "E5", "G5", "C6", "E6", "G6"].forEach((n, i) => voice(NOTES[n], t + i * 0.08, 0.2, "square", master, 0.32));
      voice(NOTES["C6"], t + 0.55, 0.3, "triangle", master, 0.24);
    },
    // Jackpot ($500+ pot): a long rising run + a triple sparkle on top.
    jackpot() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      const run = ["C5", "E5", "G5", "A5", "C6", "D6", "E6", "G6"];
      run.forEach((n, i) => voice(NOTES[n], t + i * 0.07, 0.18, "square", master, 0.32));
      [0, 0.22, 0.44].forEach((d) => {
        voice(NOTES["E6"], t + 0.62 + d, 0.12, "triangle", master, 0.22);
        voice(NOTES["G6"], t + 0.68 + d, 0.16, "square", master, 0.24);
      });
    },
  };

  window.Chiptune = Chiptune;
})();
