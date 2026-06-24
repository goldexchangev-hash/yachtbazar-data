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

  const TEMPO = 96; // upbeat groove (Donkey Kong Country-ish); BAR = 2.5s
  const BEAT = 60 / TEMPO;
  const BAR = 4 * BEAT;

  // 16-bar driving A-minor groove à la DKC: a bouncy bassline (built from each
  // bar's `root`), soft pads, and a syncopated lead on an 8-slot (eighth-note)
  // grid ("-" = rest). Two 8-bar sections (A grounded, B lifts an octave).
  const PROG = [
    // ---- A ----
    { root: "A2", ch: ["A3", "C4", "E4"], mel: ["E4", "-", "A4", "-", "C5", "-", "B4", "-"] },
    { root: "D2", ch: ["D3", "F3", "A3"], mel: ["-", "D5", "-", "A4", "F4", "-", "A4", "-"] },
    { root: "E2", ch: ["E3", "G3", "B3"], mel: ["E4", "-", "G4", "B4", "-", "E5", "-", "D5"] },
    { root: "A2", ch: ["A3", "C4", "E4"], mel: ["C5", "-", "A4", "-", "E4", "-", "-", "-"] },
    { root: "F2", ch: ["F3", "A3", "C4"], mel: ["-", "A4", "C5", "-", "A4", "-", "F4", "-"] },
    { root: "C3", ch: ["C4", "E4", "G4"], mel: ["G4", "-", "E4", "G4", "-", "C5", "-", "-"] },
    { root: "D2", ch: ["D3", "F3", "A3"], mel: ["D5", "-", "A4", "-", "F4", "A4", "-", "-"] },
    { root: "E2", ch: ["E3", "G#3", "B3"], mel: ["E5", "-", "D5", "B4", "-", "G#4", "-", "B4"] },
    // ---- B (lifts an octave, busier) ----
    { root: "A2", ch: ["A3", "C4", "E4"], mel: ["A5", "-", "E5", "C5", "-", "A4", "-", "C5"] },
    { root: "F2", ch: ["F3", "A3", "C4"], mel: ["-", "C5", "-", "A4", "C5", "-", "F5", "-"] },
    { root: "C3", ch: ["C4", "E4", "G4"], mel: ["G5", "-", "E5", "-", "C5", "E5", "-", "G4"] },
    { root: "G2", ch: ["G3", "B3", "D4"], mel: ["D5", "-", "B4", "D5", "-", "G4", "-", "B4"] },
    { root: "D2", ch: ["D3", "F3", "A3"], mel: ["F5", "-", "A5", "-", "D5", "-", "A4", "-"] },
    { root: "E2", ch: ["E3", "G3", "B3"], mel: ["-", "B4", "-", "E5", "G5", "-", "E5", "-"] },
    { root: "F2", ch: ["F3", "A3", "C4"], mel: ["A5", "-", "G5", "F5", "-", "C5", "-", "A4"] },
    { root: "E2", ch: ["E3", "G#3", "B3"], mel: ["E5", "-", "B4", "-", "G#4", "-", "B4", "-"] },
  ];

  let ctx = null, master = null, musicGain = null, noiseBuf = null;
  let on = false, barIdx = 0, nextBarTime = 0, schedulerTimer = null;

  // Optional custom soundtrack: drop a public/music.mp3 in to override the synth.
  // We DON'T probe at page load (that fired a 404 on every visit since no file is
  // shipped); instead we lazily check the first time the user enables music.
  let audioEl = null, customReady = false, customProbed = false;
  function probeCustom() {
    if (customProbed) return;
    customProbed = true;
    try {
      audioEl = new Audio("music.mp3");
      audioEl.loop = true;
      audioEl.volume = 0.6;
      audioEl.preload = "auto";
      audioEl.addEventListener("canplaythrough", () => (customReady = true), { once: true });
      audioEl.addEventListener("error", () => { customReady = false; audioEl = null; });
      audioEl.load();
    } catch { audioEl = null; }
  }

  function ensureCtx() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.42; // melodic content sits above the beat
    musicGain.connect(master);
    // noise buffer for hi-hats + snare
    const len = Math.floor(ctx.sampleRate * 0.3);
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

  // Punchy bass note (warm triangle with a quick decay) — the DKC bounce.
  function bass(freq, start, dur) {
    if (!freq) return;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(0.3, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, start + dur);
    osc.connect(g); g.connect(master);
    osc.start(start); osc.stop(start + dur + 0.02);
  }

  function kick(start) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(130, start);
    osc.frequency.exponentialRampToValueAtTime(45, start + 0.11);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(0.24, start + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
    osc.connect(g); g.connect(master);
    osc.start(start); osc.stop(start + 0.19);
  }

  function snare(start) {
    if (!noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1900; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(0.1, start + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(start); src.stop(start + 0.14);
  }

  function scheduleBar(t) {
    const bar = PROG[barIdx % PROG.length];
    const eighth = BEAT / 2;
    // Soft sustained pad under the groove.
    for (const n of bar.ch) voice(NOTES[n], t, BAR * 0.96, "sine", musicGain, 0.12, 0.04, 0.45);
    // Bouncing bassline built from the bar's root: root / octave-up / fifth-up,
    // syncopated across the eighth-note grid.
    const r = NOTES[bar.root];
    if (r) {
      const oct = r * 2, fifth = r * 1.4983;
      const pat = { 0: r, 2: oct, 3: fifth, 4: r, 5: oct, 7: fifth };
      for (const k in pat) bass(pat[k], t + k * eighth, eighth * 1.05);
    }
    // Syncopated lead on the eighth grid.
    bar.mel.forEach((n, i) => {
      if (n && n !== "-") {
        voice(NOTES[n], t + i * eighth, eighth * 1.4, "triangle", musicGain, 0.2, 0.01, 0.12);
        voice(NOTES[n] * 2, t + i * eighth, eighth * 0.5, "square", musicGain, 0.03, 0.01, 0.08); // soft sparkle
      }
    });
    // Drum groove: kick on 1 & 3, snare backbeat on 2 & 4, hats on every eighth.
    kick(t); kick(t + 2 * BEAT);
    snare(t + BEAT); snare(t + 3 * BEAT);
    for (let i = 0; i < 8; i++) hat(t + i * eighth, i % 2 ? 0.03 : 0.018, 9000);
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
      probeCustom();
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
