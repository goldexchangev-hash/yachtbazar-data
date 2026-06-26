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
    // Octaves 1–7 cover every note the SFX and the multi-track songbook need
    // (sub-bass roots up through bright sparkle leads). Also register flat
    // aliases (Db == C#, etc.) so tracks can spell chords either way.
    const flats = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };
    for (let oct = 1; oct <= 7; oct++)
      for (let i = 0; i < 12; i++) {
        const n = 12 * (oct + 1) + i;
        const f = 440 * Math.pow(2, (n - 69) / 12);
        NOTES[names[i] + oct] = f;
        if (flats[names[i]]) NOTES[flats[names[i]] + oct] = f;
      }
  })();

  // ── Tempo is now per-track. BEAT/BAR are recomputed from the active track's
  // bpm whenever playback starts or the selection changes (see syncTempo()).
  let BEAT = 60 / 96;
  let BAR = 4 * BEAT;

  // ============================================================
  //  SONGBOOK — original SNES-flavoured loops. None copy real melodies;
  //  they're freshly composed progressions evoking the bright bounce of
  //  Super Mario World and the swung, jazzy-melancholic DKC2 mood
  //  ("Stickerbush Symphony", "Forest Interlude").
  //
  //  Bar shape is unchanged: { ch: [chord notes], root, mel: [8 eighth slots] }.
  //  Each track: { id, name, bpm, prog: [bars] }, 8–16 bars, loops cleanly.
  // ============================================================
  const TRACKS = [
    // ── 0. Neon Overworld — bright, bouncy major-key SMW romp (C major). ──
    {
      id: "overworld", name: "Neon Overworld", bpm: 144,
      prog: [
        { root: "C2", ch: ["C4", "E4", "G4"], mel: ["G4", "-", "C5", "E5", "-", "G5", "E5", "C5"] },
        { root: "A2", ch: ["A3", "C4", "E4"], mel: ["A4", "-", "E5", "-", "C5", "A4", "-", "E5"] },
        { root: "F2", ch: ["F3", "A3", "C4"], mel: ["F5", "-", "A5", "F5", "-", "C5", "A4", "-"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["G5", "F5", "-", "D5", "B4", "-", "G4", "-"] },
        { root: "C2", ch: ["C4", "E4", "G4"], mel: ["E5", "-", "G5", "C6", "-", "G5", "E5", "-"] },
        { root: "E2", ch: ["E3", "G#3", "B3"], mel: ["E5", "-", "B4", "E5", "G#5", "-", "B5", "-"] },
        { root: "F2", ch: ["F3", "A3", "C4"], mel: ["A5", "-", "G5", "F5", "-", "A5", "C6", "-"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["D5", "G5", "-", "F5", "D5", "-", "G4", "-"] },
      ],
    },
    // ── 1. Stickerbush Nights — swung jazzy DKC2 mood (A minor, 7ths). ──
    {
      id: "stickerbush", name: "Stickerbush Nights", bpm: 100,
      prog: [
        { root: "A2", ch: ["A3", "C4", "E4", "G4"], mel: ["E4", "-", "A4", "-", "C5", "-", "B4", "-"] },
        { root: "D2", ch: ["D3", "F3", "A3", "C4"], mel: ["-", "D5", "-", "A4", "F4", "-", "A4", "-"] },
        { root: "F2", ch: ["F3", "A3", "C4", "E4"], mel: ["C5", "-", "A4", "C5", "-", "E5", "-", "D5"] },
        { root: "E2", ch: ["E3", "G3", "B3", "D4"], mel: ["B4", "-", "E5", "-", "D5", "B4", "-", "-"] },
        { root: "A2", ch: ["A3", "C4", "E4", "G4"], mel: ["A4", "-", "C5", "E5", "-", "A5", "-", "G5"] },
        { root: "C3", ch: ["C4", "E4", "G4", "B4"], mel: ["E5", "-", "G5", "-", "B4", "C5", "-", "E5"] },
        { root: "D2", ch: ["D3", "F3", "A3", "C4"], mel: ["F5", "-", "D5", "A4", "-", "C5", "-", "-"] },
        { root: "E2", ch: ["E3", "G#3", "B3", "D4"], mel: ["E5", "-", "D5", "B4", "-", "G#4", "-", "B4"] },
      ],
    },
    // ── 2. Jackpot Jungle — upbeat casino/bonus tune (D major, snappy). ──
    {
      id: "jackpot", name: "Jackpot Jungle", bpm: 138,
      prog: [
        { root: "D2", ch: ["D4", "F#4", "A4"], mel: ["D5", "-", "F#5", "A5", "-", "F#5", "D5", "-"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["B4", "-", "D5", "G5", "-", "D5", "B4", "-"] },
        { root: "A2", ch: ["A3", "C#4", "E4"], mel: ["A5", "-", "E5", "C#5", "-", "A4", "-", "E5"] },
        { root: "D2", ch: ["D4", "F#4", "A4"], mel: ["F#5", "A5", "-", "D6", "-", "A5", "F#5", "-"] },
        { root: "B2", ch: ["B3", "D4", "F#4"], mel: ["B4", "-", "F#5", "-", "D5", "B4", "-", "F#5"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["G5", "-", "B5", "D6", "-", "B5", "G5", "-"] },
        { root: "A2", ch: ["A3", "C#4", "E4"], mel: ["A5", "-", "C#6", "-", "E5", "A5", "-", "C#6"] },
        { root: "A2", ch: ["A3", "C#4", "E4", "G4"], mel: ["E6", "-", "C#6", "A5", "-", "E5", "-", "-"] },
      ],
    },
    // ── 3. Coral Cove — chill, dreamy underwater feel (G major, floaty). ──
    {
      id: "coral", name: "Coral Cove", bpm: 96,
      prog: [
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["D5", "-", "-", "G5", "-", "B5", "-", "-"] },
        { root: "E2", ch: ["E3", "G3", "B3", "D4"], mel: ["-", "B4", "-", "E5", "-", "G5", "-", "-"] },
        { root: "C3", ch: ["C4", "E4", "G4"], mel: ["G5", "-", "-", "E5", "-", "C5", "-", "G4"] },
        { root: "D2", ch: ["D4", "F#4", "A4"], mel: ["A4", "-", "D5", "-", "F#5", "-", "A5", "-"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["B5", "-", "-", "D6", "-", "B5", "G5", "-"] },
        { root: "C3", ch: ["C4", "E4", "G4", "B4"], mel: ["-", "E5", "-", "G5", "-", "C6", "-", "B5"] },
        { root: "A2", ch: ["A3", "C4", "E4"], mel: ["E5", "-", "-", "A5", "-", "C6", "-", "-"] },
        { root: "D2", ch: ["D4", "F#4", "A4", "C5"], mel: ["A5", "-", "F#5", "-", "D5", "-", "A4", "-"] },
      ],
    },
    // ── 4. Victory Lap — triumphant fanfare-style loop (C major, regal). ──
    {
      id: "victory", name: "Victory Lap", bpm: 120,
      prog: [
        { root: "C2", ch: ["C4", "E4", "G4"], mel: ["C5", "E5", "G5", "-", "C6", "-", "G5", "-"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["D5", "G5", "B5", "-", "D6", "-", "B5", "-"] },
        { root: "A2", ch: ["A3", "C4", "E4"], mel: ["A5", "-", "E5", "C5", "-", "A4", "C5", "E5"] },
        { root: "F2", ch: ["F3", "A3", "C4"], mel: ["F5", "A5", "C6", "-", "A5", "F5", "-", "-"] },
        { root: "C2", ch: ["C4", "E4", "G4"], mel: ["E5", "G5", "C6", "E6", "-", "C6", "G5", "-"] },
        { root: "F2", ch: ["F3", "A3", "C4"], mel: ["A5", "-", "C6", "-", "F6", "-", "C6", "A5"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["G5", "B5", "D6", "-", "G6", "-", "D6", "B5"] },
        { root: "C2", ch: ["C4", "E4", "G4"], mel: ["C6", "-", "G5", "E5", "-", "C5", "-", "-"] },
      ],
    },
    // ── 5. Funky Vault — funky syncopated bassline track (E minor, groove). ──
    {
      id: "funkyvault", name: "Funky Vault", bpm: 112,
      prog: [
        { root: "E2", ch: ["E3", "G3", "B3", "D4"], mel: ["E5", "-", "G5", "-", "E5", "D5", "-", "B4"] },
        { root: "E2", ch: ["E3", "G3", "B3", "D4"], mel: ["-", "G5", "B5", "-", "A5", "-", "G5", "E5"] },
        { root: "A2", ch: ["A3", "C4", "E4", "G4"], mel: ["A4", "-", "C5", "E5", "-", "G5", "E5", "-"] },
        { root: "C3", ch: ["C4", "E4", "G4"], mel: ["C5", "-", "G4", "C5", "E5", "-", "D5", "-"] },
        { root: "E2", ch: ["E3", "G3", "B3", "D4"], mel: ["B4", "-", "E5", "G5", "-", "B5", "-", "G5"] },
        { root: "D2", ch: ["D3", "F#3", "A3", "C4"], mel: ["D5", "-", "F#5", "-", "A5", "F#5", "-", "D5"] },
        { root: "A2", ch: ["A3", "C4", "E4", "G4"], mel: ["E5", "-", "G5", "A5", "-", "G5", "E5", "-"] },
        { root: "B2", ch: ["B3", "D4", "F#4", "A4"], mel: ["B4", "-", "D5", "F#5", "-", "A5", "-", "B5"] },
      ],
    },
    // ── 6. Crystal Caverns — mysterious, sparse cave track (B minor). ──
    {
      id: "caverns", name: "Crystal Caverns", bpm: 104,
      prog: [
        { root: "B2", ch: ["B3", "D4", "F#4"], mel: ["F#4", "-", "-", "B4", "-", "D5", "-", "-"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["-", "D5", "-", "-", "B4", "-", "G4", "-"] },
        { root: "A2", ch: ["A3", "C#4", "E4"], mel: ["E5", "-", "-", "C#5", "-", "A4", "-", "E5"] },
        { root: "F#2", ch: ["F#3", "A3", "C#4"], mel: ["F#5", "-", "-", "-", "C#5", "-", "A4", "-"] },
        { root: "B2", ch: ["B3", "D4", "F#4"], mel: ["B5", "-", "F#5", "-", "-", "D5", "-", "B4"] },
        { root: "E2", ch: ["E3", "G3", "B3"], mel: ["-", "B4", "-", "E5", "-", "-", "G5", "-"] },
        { root: "D2", ch: ["D3", "F#3", "A3"], mel: ["A4", "-", "-", "D5", "-", "F#5", "-", "-"] },
        { root: "F#2", ch: ["F#3", "A3", "C#4", "E4"], mel: ["C#5", "-", "A4", "-", "F#4", "-", "-", "-"] },
      ],
    },
    // ── 7. Turbo Run — fast, energetic chase track (A minor, driving). ──
    {
      id: "turbo", name: "Turbo Run", bpm: 150,
      prog: [
        { root: "A2", ch: ["A3", "C4", "E4"], mel: ["A4", "C5", "E5", "A5", "E5", "C5", "A4", "E5"] },
        { root: "A2", ch: ["A3", "C4", "E4"], mel: ["A4", "B4", "C5", "E5", "-", "C5", "B4", "A4"] },
        { root: "F2", ch: ["F3", "A3", "C4"], mel: ["C5", "F5", "A5", "F5", "C5", "A4", "F4", "-"] },
        { root: "G2", ch: ["G3", "B3", "D4"], mel: ["G4", "B4", "D5", "G5", "D5", "B4", "G4", "D5"] },
        { root: "A2", ch: ["A3", "C4", "E4"], mel: ["E5", "C5", "A4", "E5", "A5", "E5", "C5", "A4"] },
        { root: "D2", ch: ["D3", "F4", "A4"], mel: ["D5", "F5", "A5", "D6", "A5", "F5", "D5", "A4"] },
        { root: "E2", ch: ["E3", "G#3", "B3"], mel: ["E5", "G#5", "B5", "E6", "B5", "G#5", "E5", "B4"] },
        { root: "E2", ch: ["E3", "G#3", "B3"], mel: ["B5", "G#5", "E5", "B4", "-", "G#4", "-", "E4"] },
      ],
    },
    // ── 8. Forest Interlude — slow, wistful swung DKC2 ballad (D minor). ──
    {
      id: "forest", name: "Forest Interlude", bpm: 92,
      prog: [
        { root: "D2", ch: ["D3", "F3", "A3", "C4"], mel: ["A4", "-", "-", "D5", "-", "F5", "-", "E5"] },
        { root: "Bb2", ch: ["Bb3", "D4", "F4", "A4"], mel: ["D5", "-", "F5", "-", "A5", "-", "G5", "-"] },
        { root: "G2", ch: ["G3", "Bb3", "D4", "F4"], mel: ["-", "G5", "-", "D5", "Bb4", "-", "G4", "-"] },
        { root: "A2", ch: ["A3", "C#4", "E4", "G4"], mel: ["A4", "-", "C#5", "E5", "-", "G5", "-", "E5"] },
        { root: "D2", ch: ["D3", "F3", "A3", "C4"], mel: ["F5", "-", "A5", "-", "D6", "-", "A5", "F5"] },
        { root: "Bb2", ch: ["Bb3", "D4", "F4"], mel: ["Bb5", "-", "A5", "-", "F5", "D5", "-", "-"] },
        { root: "G2", ch: ["G3", "Bb3", "D4", "F4"], mel: ["-", "D5", "F5", "-", "Bb5", "-", "A5", "-"] },
        { root: "A2", ch: ["A3", "C#4", "E4", "G4"], mel: ["E5", "-", "C#5", "A4", "-", "E5", "-", "-"] },
      ],
    },
    // ── 9. Sunrise Skyway — warm, gentle major bounce (F major, breezy). ──
    {
      id: "skyway", name: "Sunrise Skyway", bpm: 126,
      prog: [
        { root: "F2", ch: ["F3", "A3", "C4"], mel: ["F4", "-", "A4", "C5", "-", "F5", "C5", "-"] },
        { root: "Bb2", ch: ["Bb3", "D4", "F4"], mel: ["D5", "-", "F5", "-", "Bb5", "F5", "-", "D5"] },
        { root: "C3", ch: ["C4", "E4", "G4"], mel: ["E5", "-", "G5", "C6", "-", "G5", "E5", "-"] },
        { root: "A2", ch: ["A3", "C4", "E4"], mel: ["A4", "C5", "E5", "-", "A5", "-", "E5", "C5"] },
        { root: "F2", ch: ["F3", "A3", "C4"], mel: ["C5", "F5", "A5", "-", "C6", "-", "A5", "F5"] },
        { root: "D2", ch: ["D3", "F3", "A3"], mel: ["D5", "-", "F5", "A5", "-", "D5", "F5", "-"] },
        { root: "Bb2", ch: ["Bb3", "D4", "F4"], mel: ["F5", "-", "Bb5", "-", "D6", "-", "Bb5", "F5"] },
        { root: "C3", ch: ["C4", "E4", "G4"], mel: ["G5", "E5", "C5", "-", "G4", "-", "C5", "-"] },
      ],
    },
  ];

  let curTrack = 0; // active track index; default 0 = Neon Overworld

  // Recompute BEAT/BAR from the active track's bpm. Called by start() and on
  // every track switch so the drum groove + grid follow the selected tempo.
  function syncTempo() {
    const bpm = (TRACKS[curTrack] && TRACKS[curTrack].bpm) || 96;
    BEAT = 60 / bpm;
    BAR = 4 * BEAT;
  }

  const MUSIC_GAIN = 0.42; // melodic content sits above the beat (single source of truth)
  let _duckN = 0; // depth counter: music only un-ducks when the last consumer releases
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
    musicGain.gain.value = MUSIC_GAIN; // melodic content sits above the beat
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
    const prog = TRACKS[curTrack].prog;
    const bar = prog[barIdx % prog.length];
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
    // True only if music is logically on AND the AudioContext is actually running.
    // After an iOS app-switch the context is SUSPENDED while `on` stays true, so
    // this returns false there — the cue the volume button uses to RESTORE sound.
    audible: () => on && !!ctx && ctx.state === "running",
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
      syncTempo();
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

    // ── Track selection ────────────────────────────────────────────────
    // List all songs for a UI menu: [{ id, name }].
    tracks() { return TRACKS.map((t) => ({ id: t.id, name: t.name })); },
    // The active song: { id, name, index }.
    current() {
      const t = TRACKS[curTrack];
      return { id: t.id, name: t.name, index: curTrack };
    },
    // Resolve an id (string) or index (number) to a valid track index, or -1.
    _trackIndex(idOrIndex) {
      if (typeof idOrIndex === "number")
        return idOrIndex >= 0 && idOrIndex < TRACKS.length ? idOrIndex : -1;
      return TRACKS.findIndex((t) => t.id === idOrIndex);
    },
    // Switch to a track. If music is currently playing on the synth, restart the
    // scheduler cleanly on the new track from bar 0 (no overlapping loops). If
    // not playing, just remember the selection for the next start(). The custom
    // music.mp3 override (when present) keeps playing regardless. Returns current().
    playTrack(idOrIndex) {
      const idx = this._trackIndex(idOrIndex);
      if (idx < 0) return this.current();
      curTrack = idx;
      syncTempo();
      // Only the synth needs re-scheduling; a custom mp3 isn't bar-based.
      if (on && ctx && !(customReady && audioEl)) {
        if (schedulerTimer) clearTimeout(schedulerTimer); // kill the pending loop
        schedulerTimer = null;
        barIdx = 0;
        nextBarTime = ctx.currentTime + 0.1;
        scheduler(); // one active loop, on the new track
      }
      return this.current();
    },
    // Cycle to the next/previous track (wrapping); behaves like playTrack.
    next() { return this.playTrack((curTrack + 1) % TRACKS.length); },
    prev() { return this.playTrack((curTrack - 1 + TRACKS.length) % TRACKS.length); },

    // Make sure the audio context exists and is running (call on a user gesture).
    wake() { ensureCtx(); try { if (ctx && ctx.state !== "running") ctx.resume(); } catch (e) {} },

    // Recover audio after the tab was backgrounded: browsers SUSPEND the context
    // and the music scheduler drifts. Resume the context and realign the synth
    // scheduler so music + SFX work again immediately on return.
    resync() {
      ensureCtx();
      if (!ctx) { if (on && customReady && audioEl) audioEl.play().catch(() => {}); return; }
      try { if (ctx.state !== "running") ctx.resume(); } catch (e) {}
      if (customReady && audioEl) { if (on) audioEl.play().catch(() => {}); return; }
      if (on) { // resynth: drop the stale (drifted) schedule and restart from "now"
        if (schedulerTimer) clearTimeout(schedulerTimer);
        schedulerTimer = null;
        nextBarTime = ctx.currentTime + 0.1;
        scheduler();
      }
    },

    // Route an HTML media element's audio through THIS shared context (iOS only
    // reliably allows one AudioContext, so reels must share it, not spawn their
    // own — a separate one drops out after a second). One-time per element.
    routeMedia(el) {
      ensureCtx();
      if (!ctx || !el || el.__routed) return !!(el && el.__routed);
      try {
        const src = ctx.createMediaElementSource(el);
        const g = ctx.createGain();
        g.gain.value = 1.0;
        src.connect(g);
        g.connect(master);
        el.__routed = true;
        return true;
      } catch (e) { return false; }
    },

    // Decode a fetched audio file (ArrayBuffer) into an AudioBuffer on the shared
    // context. Used to pre-load reel soundtracks so they play smoothly via Web
    // Audio, immune to the video element streaming/hesitating.
    decode(arrayBuffer) {
      ensureCtx();
      if (!ctx) return Promise.reject(new Error("no audio context"));
      return new Promise((resolve, reject) => {
        try { ctx.decodeAudioData(arrayBuffer, resolve, reject); } catch (e) { reject(e); }
      });
    },
    // Play a decoded AudioBuffer once, through the master bus. Returns a handle
    // with stop(); onended fires when it finishes.
    playClip(buffer, onended) {
      ensureCtx();
      if (!ctx || !buffer) return null;
      try {
        if (ctx.state !== "running") ctx.resume();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const g = ctx.createGain(); g.gain.value = 1.0;
        src.connect(g); g.connect(master);
        if (onended) src.onended = onended;
        src.start();
        return { stop() { try { src.onended = null; src.stop(); } catch (e) {} }, duration: buffer.duration };
      } catch (e) { return null; }
    },

    // Temporarily duck (or restore) the background music — used while a
    // full-motion reel plays so its own audio can be heard over the loop.
    duckMusic(down) {
      try {
        _duckN = Math.max(0, _duckN + (down ? 1 : -1));
        const ducked = _duckN > 0; // only un-duck once every overlapping reveal has released
        if (musicGain && ctx) musicGain.gain.setTargetAtTime(ducked ? 0.02 : MUSIC_GAIN, ctx.currentTime, 0.08);
        if (audioEl) audioEl.volume = ducked ? 0.05 : 0.6;
      } catch (e) {}
    },

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
    // Which win-scene theme is active, so the fanfare matches the visuals.
    _theme() { try { return (window.WinScenes && window.WinScenes.getTheme && window.WinScenes.getTheme()) || "neon"; } catch (e) { return "neon"; } },
    // Original melodic run: lead voice (+ optional lower-octave triangle harmony).
    _run(notes, t0, step, type, peak, harm) {
      notes.forEach((n, i) => {
        if (!n || n === "-") return;
        voice(NOTES[n], t0 + i * step, step * 1.35, type, master, peak, 0.01, step * 0.5);
        if (harm) voice(NOTES[n] * 0.5, t0 + i * step, step * 1.1, "triangle", master, peak * 0.42, 0.02, step * 0.5);
      });
    },
    _chord(notes, t0, dur, peak) { notes.forEach((n) => voice(NOTES[n], t0, dur, "triangle", master, peak, 0.03, dur * 0.6)); },

    // Standard win: a short bright flourish (theme-flavored, freshly composed).
    win() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      if (this._theme() === "world") {
        this._run(["A4", "D5", "F#5", "A5"], t, 0.12, "square", 0.28, true);
        bass(NOTES["D2"], t, 0.45); bass(NOTES["A2"], t + 0.48, 0.5);
      } else {
        this._run(["G5", "C6", "E6", "C6", "E6", "G6"], t, 0.1, "square", 0.3);
        bass(NOTES["C2"], t, 0.45); bass(NOTES["G2"], t + 0.5, 0.5);
      }
    },
    lose() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      ["G4", "F#4", "F4", "E4"].forEach((n, i) => voice(NOTES[n], t + i * 0.14, 0.22, "triangle", master, 0.34));
    },
    // Big win ($100+ net): a fuller rising fanfare + a resolving chord.
    bigwin() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      if (this._theme() === "world") {
        this._run(["D5", "F#5", "A5", "D6", "-", "C#6", "D6"], t, 0.12, "square", 0.3, true);
        bass(NOTES["D2"], t, 0.5); bass(NOTES["A2"], t + 0.55, 0.5); bass(NOTES["D2"], t + 1.1, 0.6);
        this._chord(["D5", "F#5", "A5", "D6"], t + 0.95, 0.7, 0.18);
      } else {
        this._run(["C5", "E5", "G5", "C6", "E6", "G6"], t, 0.08, "square", 0.32);
        bass(NOTES["C2"], t, 0.5); bass(NOTES["G2"], t + 0.5, 0.6);
        voice(NOTES["C6"], t + 0.55, 0.35, "triangle", master, 0.24, 0.02, 0.25);
      }
    },
    // Jackpot / LEGENDARY ($300+ net): a full heroic finale fanfare.
    jackpot() {
      if (!this._sfx()) return;
      const t = ctx.currentTime;
      if (this._theme() === "world") {
        this._run(["A4", "D5", "F#5", "A5", "D6", "-", "C#6", "D6"], t, 0.12, "square", 0.32, true);
        bass(NOTES["D2"], t, 0.5); bass(NOTES["A2"], t + 0.5, 0.5); bass(NOTES["G2"], t + 1.0, 0.5); bass(NOTES["A2"], t + 1.5, 0.55);
        this._chord(["D5", "F#5", "A5", "D6"], t + 1.05, 1.0, 0.2);
        [0, 0.24, 0.48].forEach((d) => voice(NOTES["F#6"], t + 1.2 + d, 0.13, "triangle", master, 0.2));
      } else {
        this._run(["C5", "E5", "G5", "A5", "C6", "D6", "E6", "G6"], t, 0.07, "square", 0.32);
        bass(NOTES["C2"], t, 0.5); bass(NOTES["G2"], t + 0.5, 0.5); bass(NOTES["C2"], t + 1.0, 0.6);
        [0, 0.22, 0.44].forEach((d) => {
          voice(NOTES["E6"], t + 0.66 + d, 0.12, "triangle", master, 0.22);
          voice(NOTES["G6"], t + 0.72 + d, 0.16, "square", master, 0.24);
        });
      }
    },
  };

  window.Chiptune = Chiptune;

  // ── Recover audio after backgrounding ──────────────────────────────────────
  // Browsers suspend the AudioContext when the tab is hidden/app-switched; on
  // return, music + SFX go silent until the context is resumed. Re-sync whenever
  // the page becomes visible/focused, and resume on the next tap (iOS only allows
  // a resume inside a user gesture).
  try {
    // Debounce: focus + visibilitychange + pageshow can all fire within a few ms
    // of returning to the tab; collapse them into a single resync so the scheduler
    // is torn down and rebuilt exactly once.
    let _recoverT = 0;
    const recover = () => { clearTimeout(_recoverT); _recoverT = setTimeout(() => { try { Chiptune.resync(); } catch (e) {} }, 50); };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recover(); });
    window.addEventListener("focus", recover);
    window.addEventListener("pageshow", recover);
    // cheap belt-and-suspenders: any tap resumes a suspended context (iOS)
    ["pointerdown", "touchend", "click", "keydown"].forEach((ev) =>
      window.addEventListener(ev, () => {
        try {
          if (ctx && ctx.state !== "running") { ctx.resume(); recover(); } // re-arm the scheduler too, not just the ctx
        } catch (e) {}
      }, { passive: true, capture: true }));
  } catch (e) {}
})();
