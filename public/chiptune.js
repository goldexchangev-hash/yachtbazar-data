/* ============================================================
   chiptune.js — chilled background music + retro SFX (Web Audio API).

   Music: a soft, slow lo-fi pad loop (original, synthesized — no copyrighted
   audio). If you drop your own track at  public/music.mp3  it plays that
   instead, looped, so you can use whatever relaxing tune you like.

   Everything can be silenced with the Music button.

   window.Chiptune:
     .toggle() / .start() / .stop() / .isOn()
     .blip()  .coin()  .win()  .lose()
   ============================================================ */
(function () {
  "use strict";

  // Note-name -> frequency (Hz), A4 = 440.
  const NOTES = {};
  (function () {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    for (let oct = 1; oct <= 6; oct++)
      for (let i = 0; i < 12; i++) {
        const n = 12 * (oct + 1) + i;
        NOTES[names[i] + oct] = 440 * Math.pow(2, (n - 69) / 12);
      }
  })();

  // A gentle, slow lo-fi chord progression with a sparse sine melody.
  const TEMPO = 66;
  const BEAT = 60 / TEMPO;
  const BAR = 4 * BEAT;
  const PROG = [
    { chord: ["A2", "E3", "A3", "C4"], mel: ["E5", null, "C5", null] },
    { chord: ["F2", "C3", "F3", "A3"], mel: ["D5", null, "A4", null] },
    { chord: ["C3", "G3", "C4", "E4"], mel: ["G4", null, "E5", null] },
    { chord: ["G2", "D3", "G3", "B3"], mel: ["B4", null, "D5", null] },
  ];

  let ctx = null, master = null, musicGain = null;
  let on = false, barIdx = 0, nextBarTime = 0, schedulerTimer = null;

  // Optional user-supplied track (public/music.mp3).
  let audioEl = null, customReady = false;
  (function probeCustom() {
    try {
      audioEl = new Audio("music.mp3");
      audioEl.loop = true;
      audioEl.volume = 0.5;
      audioEl.preload = "auto";
      audioEl.addEventListener("canplaythrough", () => (customReady = true), { once: true });
      audioEl.addEventListener("error", () => (customReady = false));
    } catch {
      audioEl = null;
    }
  })();

  function ensureCtx() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.16; // gentle
    musicGain.connect(master);
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

  function scheduleBar(t) {
    const bar = PROG[barIdx % PROG.length];
    // soft sustained pad (sine), whole bar
    for (const n of bar.chord) {
      voice(NOTES[n], t, BAR * 0.98, "sine", musicGain, 0.34, 0.35, 0.6);
    }
    // sparse triangle melody on beats 1 & 3
    bar.mel.forEach((n, i) => {
      if (n) voice(NOTES[n], t + i * BEAT, BEAT * 1.4, "triangle", musicGain, 0.16, 0.04, 0.25);
    });
    barIdx++;
  }

  function scheduler() {
    if (!on || !ctx) return;
    while (nextBarTime < ctx.currentTime + 0.6) {
      scheduleBar(nextBarTime);
      nextBarTime += BAR;
    }
    schedulerTimer = setTimeout(scheduler, 120);
  }

  const Chiptune = {
    isOn: () => on,
    usingCustomTrack: () => on && customReady,
    start() {
      ensureCtx();
      if (ctx && ctx.state === "suspended") ctx.resume();
      if (on) return true;
      on = true;
      // Prefer a user-supplied relaxing track if present.
      if (customReady && audioEl) {
        audioEl.currentTime = 0;
        audioEl.play().catch(() => {});
        return true;
      }
      if (!ctx) { on = false; return false; }
      barIdx = 0;
      nextBarTime = ctx.currentTime + 0.15;
      scheduler();
      return true;
    },
    stop() {
      on = false;
      if (schedulerTimer) clearTimeout(schedulerTimer);
      schedulerTimer = null;
      if (audioEl) { try { audioEl.pause(); } catch {} }
    },
    toggle() {
      return on ? (this.stop(), false) : this.start();
    },

    /* ---- SFX (independent of music; need an audio context) ---- */
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
