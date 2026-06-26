/* ============================================================
   tv.js — the TV screen as a self-contained 16-bit "broadcast".
   Owns every on-screen animation so it can be polished in isolation.

   Public API (window.TV):
     TV.init()
     TV.setChannel(n)
     TV.idle(subtext)
     TV.waiting({ p1, p2, sub })      // static + STANDBY (waiting for a player)
     TV.startFlip({ p1, p2 })         // BETS IN -> tuning -> 3·2·1·FLIP -> spin
     TV.revealResult({ side, youWon, role, sub })  // stop on HEADS/TAILS, WIN/LOSE
     TV.reset()
   Phases: idle | waiting | tuning | countdown | flip | result
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => (window.performance ? performance.now() : Date.now());

  const SHORT = (a) =>
    !a ? "—" : /^0x/i.test(a) && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a;

  const TV = {
    _phase: "idle",
    _seq: 0, // bumps on every transition to cancel stale async sequences
    _spinReadyAt: 0, // earliest time a result may be revealed (min spin)
    _pendingReveal: null,
    _staticRAF: null,
    _staticIntensity: 0.55,

    init() {
      this.screen = $("tv-screen");
      this.layers = {
        idle: $("layer-idle"),
        waiting: $("layer-waiting"),
        tuning: $("layer-tuning"),
        countdown: $("layer-countdown"),
        flip: $("layer-flip"),
        result: $("layer-result"),
        dice: $("layer-dice"),
        twodice: $("layer-twodice"),
        crash: $("layer-crash"),
        slots: $("layer-slots"),
        pressure: $("layer-pressure"),
        plane: $("layer-plane"),
        slots3d: $("layer-slots3d"),
      };
      this._activeChannel = 8; // 8 = Flip, 9 = Dice — so idle() advertises the active game
      this.scoreboard = $("scoreboard");
      this.sbP1 = $("sb-p1");
      this.sbP2 = $("sb-p2");
      this.sbP1Who = $("sb-p1-who");
      this.sbP2Who = $("sb-p2-who");
      this.coin = $("coin");
      this.coinToss = $("coin-toss");     // vertical-arc wrapper (the toss)
      this.coinShower = $("coin-shower"); // raining-gold win FX layer
      this.layerFlip = $("layer-flip");
      this.countNum = $("count-num");
      this.resultEmoji = $("result-emoji");
      this.resultHeadline = $("result-headline");
      this.resultMoney = $("result-money");
      this.resultSub = $("result-sub");
      this.resultCoin = $("result-coin");
      this.winBanner = $("win-banner");
      this.screenEl = $("tv-screen");
      this.channelNum = $("tv-channel-num");

      this.staticCanvas = $("static-canvas");
      this.sctx = this.staticCanvas.getContext("2d", { willReadFrequently: true });
      this.confetti = $("confetti-canvas");
      this.cctx = this.confetti.getContext("2d");

      this._sizeCanvases();
      window.addEventListener("resize", () => this._sizeCanvases());
      this._startStatic();
      this.idle();
      return this;
    },

    _sizeCanvases() {
      // Fine-grained analog "snow": per-pixel noise at 256x192 (was a chunky
      // 50x38 grid). Upscaled crisply to the screen for detailed static.
      this.staticCanvas.width = 256;
      this.staticCanvas.height = 192;
      const r = this.confetti.getBoundingClientRect();
      this.confetti.width = Math.max(2, Math.floor(r.width));
      this.confetti.height = Math.max(2, Math.floor(r.height));
    },

    /* ---------------- static / noise (realistic analog snow) ----------------
       Per-pixel RF-noise replication: a mid-gray-biased luminance LUT, faint
       horizontal scanline correlation, a slow vertically-drifting hum bar,
       sparkle highlights + rare neon speckle, a drifting warm/cool tint and the
       occasional AGC brightness flicker. Rendered at the canvas's full 256x192
       (was a chunky 50x38) via one 32-bit write per pixel; CSS upscales it. */
    _startStatic() {
      const ctx = this.sctx;
      ctx.imageSmoothingEnabled = false;
      const W = this.staticCanvas.width, H = this.staticCanvas.height; // 256x192
      const img = ctx.createImageData(W, H);
      const buf32 = new Uint32Array(img.data.buffer); // 0xAABBGGRR (little-endian)
      // mid-gray-biased luminance LUT (few pure blacks/whites — the realistic part)
      const LUT = new Uint8Array(256);
      for (let i = 0; i < 256; i++) { const u = i / 255, s = u * u * (3 - 2 * u); LUT[i] = (38 + (0.35 * u + 0.65 * s) * 178) | 0; }
      let rng = (Date.now() ^ 0x9e3779b9) >>> 0;
      const xr = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return rng >>> 0; };
      const HCORR = 0.32, SPARK = 14 /*~1.3% of 1024*/, HUM_AMP = 20, HUM_K = (1.6 * Math.PI * 2) / H;
      let barPhase = 0;
      const paint = (t) => {
        barPhase += 0.05;                                 // slow vertical hum roll
        const tintR = (Math.sin(t * 0.0007) * 9) | 0, tintB = (-tintR * 0.8) | 0;
        const flicker = ((xr() & 0xffff) < 2600) ? ((xr() % 46) - 14) | 0 : 0; // ~4% AGC pump
        let idx = 0;
        for (let y = 0; y < H; y++) {
          const rowBias = ((Math.sin(barPhase + y * HUM_K) * HUM_AMP) | 0) + flicker;
          let prev = 128;
          for (let x = 0; x < W; x++) {
            const r = xr();
            let l = LUT[r & 0xff];
            l = (l + (prev - l) * HCORR) | 0; prev = l;   // horizontal scanline smear
            l += rowBias;
            let cr = l + tintR, cg = l, cb = l + tintB;
            if (((r >>> 8) & 0x3ff) < SPARK) {            // sparkle / rare neon speckle
              const k = (r >>> 18) & 7;
              if (k === 0) { cr = 70; cg = 235; cb = 255; }      // cyan fleck
              else if (k === 1) { cr = 255; cg = 90; cb = 170; } // magenta fleck
              else { cr = cg = cb = 235 + ((r >>> 20) & 0x1f); } // white sparkle
            }
            cr = cr < 0 ? 0 : cr > 255 ? 255 : cr;
            cg = cg < 0 ? 0 : cg > 255 ? 255 : cg;
            cb = cb < 0 ? 0 : cb > 255 ? 255 : cb;
            buf32[idx++] = 0xff000000 | (cb << 16) | (cg << 8) | cr;
          }
        }
        ctx.putImageData(img, 0, 0);
        this.staticCanvas.style.opacity = String(this._staticIntensity); // intensity via element opacity
      };
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) { this._staticIntensity = Math.min(this._staticIntensity, 0.25); paint(0); return; }
      const FRAME_MS = 1000 / 30; // 30fps reads as analog snow and halves cost
      const GRAIN = 0.12;          // ≤ this = a static game-preview grain (paint ONCE, don't loop)
      let last = 0;
      const tick = (t) => {
        this._staticRAF = requestAnimationFrame(tick);
        if (document.hidden) return;          // don't burn cycles in a background tab
        if (!this.staticCanvas.offsetParent) return; // TV is display:none (e.g. poker view) — skip
        if (window.__winSceneActive) return;  // a win scene covers the TV — don't paint static
        if (this._staticIntensity <= 0.02) { if (!this._grainDone) { ctx.clearRect(0, 0, W, H); this.staticCanvas.style.opacity = "0"; this._grainDone = true; } return; }
        // Subtle preview grain: paint a single frame and HOLD — the per-pixel loop
        // was running 30×/s forever during normal play (the main idle-CPU cost).
        if (this._staticIntensity <= GRAIN) { if (!this._grainDone) { paint(t); this._grainDone = true; } return; }
        // Loud static (tuning / SIGNAL LOST): animate at 30fps.
        if (t - last < FRAME_MS) return;
        last = t;
        paint(t);
      };
      this._staticRAF = requestAnimationFrame(tick);
    },
    _setStatic(i) {
      this._staticIntensity = i;
      this._grainDone = false; // re-paint one frame for the new level
      this.staticCanvas.style.opacity = i > 0 ? String(i) : "0";
    },

    /* ---------------- layer helpers ---------------- */
    _show(name) {
      for (const k of Object.keys(this.layers)) {
        this.layers[k].classList.toggle("hidden", k !== name);
      }
      this._phase = name;
      // The HEADS/TAILS scoreboard belongs ONLY to the coin-flip match screens —
      // hide it on every other game (dice, crash, slots, balloon pop, idle…).
      if (this.scoreboard) {
        const flipScreen = name === "flip" || name === "result" || name === "countdown" || name === "tuning" || name === "waiting";
        if (!flipScreen) this.scoreboard.classList.add("hidden");
      }
    },
    setChannel(n) {
      if (this.channelNum) this.channelNum.textContent = String(n).padStart(2, "0");
    },
    _setScoreboard(p1, p2, p1Heads) {
      this.scoreboard.classList.toggle("hidden", !(p1 || p2));
      if (p1) this.sbP1.textContent = SHORT(p1);
      this.sbP2.textContent = p2 ? SHORT(p2) : "WAITING…";
      // Label each side from P1's pick; P2 always holds the opposite.
      if (p1Heads !== undefined && this.sbP1Who && this.sbP2Who) {
        this.sbP1Who.textContent = "P1 " + (p1Heads ? "▲ HEADS" : "▼ TAILS");
        this.sbP2Who.textContent = (p1Heads ? "TAILS ▼" : "HEADS ▲") + " P2";
      }
    },

    /* ---------------- public states ---------------- */
    idle(subtext) {
      this._seq++;
      this.scoreboard.classList.add("hidden");
      this._clearConfetti();
      this.setChannel(this._activeChannel || 8); // keep showing the active game's channel
      if (!this._connected) return this._staticIdle();          // disconnected → static on every channel
      if (this._activeChannel === 11) return this._crashIdle();  // rocket room
      if (this._activeChannel === 12) return this._slotsIdle();  // reels room
      if (this._activeChannel === 13) return this._pressureIdle(); // balloon room
      if (this._activeChannel === 14) return this._planeIdle();  // plane room
      if (this._activeChannel === 15) return this._slots3dIdle(); // gem vault 3d
      this._readyRoom(subtext);                                  // flip / 0-100 / dice #2 ready room
    },

    // Called by app.js on connect/disconnect. Refreshes the resting screen so the
    // TV shows static when signed out and the game room once a wallet connects.
    setConnected(c) {
      c = !!c;
      if (c === this._connected) return;
      this._connected = c;
      const p = this._phase;
      if (p === "idle" || p === "crash" || p === "slots" || p === "pressure") this.idle(); // only refresh a resting screen
    },

    // app.js sets the channel's title here; the TV shows it in the ready room
    // (and overrides it with SIGNAL LOST whenever no wallet is connected).
    setChannelTitle(t) {
      this._channelTitle = t || this._channelTitle || "CRYPTO TV";
      if (this._connected && this._phase === "idle") { const el = $("idle-title"); if (el) el.textContent = this._channelTitle; }
    },

    // Disconnected: TV "snow" + a tune-in prompt, identical on every channel.
    _staticIdle() {
      this._setStatic(0.55);
      const title = $("idle-title"); if (title) { title.textContent = "SIGNAL LOST"; title.classList.add("signal-lost"); title.classList.remove("channel-found"); }
      const sub = $("idle-sub"); if (sub) { sub.textContent = "Connect your wallet to tune in"; sub.classList.remove("ready"); }
      const L = this.layers.crash, S = this.layers.slots;
      if (L) L.classList.remove("win", "lose");
      if (S) S.classList.remove("win", "lose");
      if (window.CryptoReels) { try { window.CryptoReels.setActive(false); } catch (e) {} } // pause the slot engine
      this._show("idle");
    },

    // Connected & a non-canvas game is selected: show that game's pieces sitting
    // ready (coin / number-line / two dice), all saying "place your bet below" —
    // so flip / 0-100 / dice #2 look like real game screens, not a fuzzy idle.
    _readyRoom() {
      const ch = this._activeChannel;
      if (ch === 9) return this._dicePreview();
      if (ch === 10) return this._twodicePreview();
      return this._flipPreview(); // ch 8 (default)
    },
    _flipPreview() {
      const L = this.layers.flip;
      if (L) { L.classList.remove("win", "lose", "tier-big", "tier-mega"); L.classList.remove("airborne", "betting"); }
      if (this.coinToss) this.coinToss.classList.remove("up", "land"); // coin resting on the table
      if (this.coin) { this.coin.classList.remove("spin", "show-tails"); this.coin.classList.add("show-heads"); }
      if (this._coin3d) try { this._coin3d.reset("HEADS"); } catch (e) {} // 3D coin rests heads-up
      const cap = L && L.querySelector(".flip-caption"); if (cap) cap.textContent = "PLACE YOUR BET BELOW";
      if (this.scoreboard) this.scoreboard.classList.add("hidden");
      this._setStatic(0.05);
      this._show("flip");
    },
    _dicePreview() {
      const L = this.layers.dice;
      if (L) L.classList.remove("win", "lose", "tier-big", "tier-mega", "nearmiss");
      const set = (id, t) => { const e = $(id); if (e) e.textContent = t; };
      set("dice-tv-target", "PLACE YOUR BET BELOW");
      set("dice-tv-num", "00.00"); set("dice-tv-verdict", ""); set("dice-tv-payout", "");
      const win = $("dl-win"), lose = $("dl-lose"), mark = $("dl-targetmark"), marker = $("dl-marker");
      if (win) win.style.cssText = "left:0;width:50%";
      if (lose) lose.style.cssText = "left:50%;width:50%";
      if (mark) mark.style.left = "50%";
      if (marker) marker.style.left = "0%";
      this._setStatic(0.05);
      this._show("dice");
    },
    _twodicePreview() {
      const L = this.layers.twodice;
      if (L) L.classList.remove("win", "lose", "tier-big", "tier-mega");
      this._setDieFace($("td-die1"), 5);
      this._setDieFace($("td-die2"), 2);
      const set = (id, t) => { const e = $(id); if (e) e.textContent = t; };
      set("td-tv-target", "PLACE YOUR BET BELOW");
      set("td-tv-sum", ""); set("td-tv-verdict", ""); set("td-tv-payout", "");
      this._setStatic(0.05);
      this._show("twodice");
    },

    /* ---------------- promo intro reel ----------------
       Plays ONCE on first site load (muted autoplay), then fades to black and
       hands off to the live game screen so they can bet immediately. The only
       control is a Replay button under the TV (which plays it back WITH sound,
       since that's a user gesture). It never replays on channel switches. */
    _initPromo() {
      if (this._promoEl !== undefined) return this._promoEl;
      const v = $("promo-video");
      this._promoEl = v || null;
      if (v) v.addEventListener("ended", () => this._endPromo());
      return this._promoEl;
    },
    // Always TRY to play with sound. A Replay tap is a gesture so it just works;
    // on cold load browsers block unmuted autoplay, so we fall back to muted
    // playback and unmute the moment the user first touches the page.
    playPromo() {
      const v = this._initPromo(); if (!v) return;
      clearTimeout(this._promoFadeT); // don't let a pending fade re-hide a fresh play
      this._promoPlaying = true;
      this._setStatic(0.02);
      v.classList.remove("hidden", "promo-fade");
      try { v.currentTime = 0; } catch (e) {}
      v.muted = false; v.volume = 1;
      // Arm the unmute up-front: on mobile the muted-autoplay path may not reject,
      // so this guarantees the first tap brings sound regardless.
      this._armUnmute();
      const p = v.play();
      if (p && p.catch) p.catch(() => { // unmuted refused → play muted (unmute waits for a tap)
        v.muted = true;
        const p2 = v.play(); if (p2 && p2.catch) p2.catch(() => this._endPromo());
      });
    },
    // One-shot: the first real user gesture unmutes the still-playing promo.
    _armUnmute() {
      if (this._unmuteArmed) return;
      this._unmuteArmed = true;
      const evs = ["pointerdown", "touchstart", "touchend", "click", "keydown"];
      const un = () => {
        this._unmuteArmed = false;
        evs.forEach((e) => window.removeEventListener(e, un, true));
        const v = this._promoEl;
        if (v && this._promoPlaying) { v.muted = false; v.volume = 1; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      };
      this._unmuteFn = un;
      evs.forEach((e) => window.addEventListener(e, un, true));
    },
    _disarmUnmute() {
      if (!this._unmuteArmed) return;
      this._unmuteArmed = false;
      ["pointerdown", "touchstart", "touchend", "click", "keydown"].forEach((e) => window.removeEventListener(e, this._unmuteFn, true));
    },
    _endPromo() {
      const v = this._promoEl;
      this._disarmUnmute();
      if (!v || !this._promoPlaying) { if (v) v.classList.add("hidden"); return; }
      this._promoPlaying = false;
      // first run is over → let the app kick off a random background track
      try { window.__onPromoEnded && window.__onPromoEnded(); } catch (e) {}
      // fade the reel to black, then reveal the resting game screen underneath
      try { v.pause(); } catch (e) {}
      v.classList.add("promo-fade");
      clearTimeout(this._promoFadeT);
      this._promoFadeT = setTimeout(() => {
        v.classList.add("hidden"); v.classList.remove("promo-fade");
        this.idle(); // game preview (or static when signed out) — ready to bet
      }, 560);
    },
    // Instant skip (no fade): when the player hits a bet button mid-intro, kill
    // the promo right away so the game underneath is live to bet on immediately.
    skipPromo() {
      const v = this._promoEl;
      if (!this._promoPlaying && (!v || v.classList.contains("hidden"))) return;
      this._disarmUnmute();
      clearTimeout(this._promoFadeT);
      this._promoPlaying = false;
      if (v) { try { v.pause(); } catch (e) {} v.classList.remove("promo-fade"); v.classList.add("hidden"); }
      // Reveal the resting game screen underneath — WITHOUT this the TV is left on
      // a black screen until/unless the bet action happens to drive a layer itself.
      try { this.idle(); } catch (e) {}
    },

    /* ---------------- crash (CH 11) ---------------- */
    // Lazily attach the rocket renderer to the TV canvas (its rAF loop is then
    // self-perpetuating). Safe to call repeatedly — only inits once.
    _ensureCrash() {
      if (this._crashReady || !window.CrashRender) return this._crashReady || false;
      const cv = $("crash-canvas");
      if (!cv) return false;
      try { window.CrashRender.init(cv); this._crashReady = true; } catch (e) { this._crashReady = false; }
      return this._crashReady;
    },
    // Show the rocket idling on the pad, multiplier reset to 1.00×.
    _crashIdle() {
      if (!this._connected) return this._staticIdle(); // signed out → static, no rocket
      const L = this.layers.crash;
      if (L) L.classList.remove("win", "lose");
      const mult = $("crash-mult"), sub = $("crash-sub");
      if (mult) { mult.classList.remove("win", "bust"); mult.textContent = "1.00×"; }
      if (sub) sub.textContent = "PLACE YOUR BET BELOW";
      this._setStatic(0.06);
      this._show("crash"); // visible first so the renderer measures a real size
      if (this._ensureCrash() && window.CrashRender) { window.CrashRender.reset(); }
    },

    /* ---------------- slots (CH 12) ---------------- */
    // The PixiJS slot engine (slots.js) is lazily injected by app.js; here we
    // just show its layer and wake its ticker. Shows a loading note until ready.
    _slotsIdle() {
      if (!this._connected) return this._staticIdle(); // signed out → static, no reels
      this._setStatic(0.04);
      this._show("slots");
      const L = this.layers.slots; if (L) L.classList.remove("win", "lose");
      const msg = $("slots-msg");
      if (window.CryptoReels && window.CryptoReels.isChannel) {
        window.CryptoReels.setActive(true);
        // The in-canvas Pixi text owns the bottom message (it counts up wins);
        // keep the DOM overlay empty so the two never collide.
        if (window.CryptoReels.setMessage) window.CryptoReels.setMessage("PLACE YOUR BET BELOW");
        if (msg) msg.textContent = "";
      } else if (msg) {
        msg.textContent = "LOADING REELS…";
      }
    },

    /* ---------------- Balloon Pop (CH 13) ---------------- */
    // The hold-to-pump engine (pressure-*.js) renders itself; app.js lazy-builds
    // it and drives activation. Here we just reveal its layer.
    _pressureIdle() {
      if (!this._connected) return this._staticIdle(); // signed out → static, no balloon
      // Engine not mounted yet (lazy-loading) → show the ready room, not a black layer.
      const stage = $("pressure-stage");
      if (!stage || !stage.querySelector("canvas")) return this._readyRoom();
      this._setStatic(0.03);
      this._show("pressure");
    },

    /* ---------------- Plane (CH 14) ---------------- */
    // The Aviator-style climb renders itself (plane-*.js); app.js lazy-builds it
    // and drives activation. Here we just reveal its layer (demo or real).
    _planeIdle() {
      if (!this._connected) return this._staticIdle();
      // Engine not mounted yet (lazy-loading) → show the ready room, not a black layer.
      const stage = $("plane-stage");
      if (!stage || !stage.querySelector("canvas")) return this._readyRoom();
      this._setStatic(0.03);
      this._show("plane");
    },

    /* ---------------- Gem Vault 3D (CH 15) ---------------- */
    // The Three.js slot renders itself (slots3d.js); app.js lazy-builds it.
    _slots3dIdle() {
      if (!this._connected) return this._staticIdle();
      const stage = $("slots3d-stage");
      if (!stage || !stage.querySelector("canvas")) return this._readyRoom();
      this._setStatic(0.03);
      this._show("slots3d");
    },

    // Turn the dial between Coin Flip (08) and Dice (09) with a CRT "tune" effect.
    async changeChannel(num) {
      const seq = ++this._seq;
      // Commit the channel identity SYNCHRONOUSLY, before any await. The visual
      // CRT transition below is seq-guarded (a rapid re-switch supersedes it), but
      // _activeChannel must NOT depend on that race: a lazy-loaded game's
      // ensureReady()→TV.idle() bumps _seq within the 210ms window and would
      // otherwise cancel this assignment, leaving _activeChannel stuck on the
      // previous channel (the "crash loads on every game" desync).
      this._activeChannel = num; this.setChannel(num);
      this._setStatic(0.95);
      if (window.Chiptune) window.Chiptune.blip();
      this.screenEl.classList.remove("ch-switch"); void this.screenEl.offsetWidth; this.screenEl.classList.add("ch-switch");
      const badge = $("tv-channel"); if (badge) { badge.classList.remove("changing"); void badge.offsetWidth; badge.classList.add("changing"); }
      await sleep(210); if (seq !== this._seq) return;
      if (!this._connected) this._staticIdle();
      else if (num === 11) this._crashIdle();
      else if (num === 12) this._slotsIdle();
      else if (num === 13) this._pressureIdle();
      else if (num === 14) this._planeIdle();
      else if (num === 15) this._slots3dIdle();
      else this._readyRoom();
      await sleep(160); if (seq !== this._seq) return;
      this.screenEl.classList.remove("ch-switch");
      if (window.Chiptune) window.Chiptune.coin();
      // NB: the promo intro plays only ONCE on first load — never on channel switch.
    },

    // Dice roll reveal: marker races 0→roll on a number line, verdict + escalation.
    // res = { roll, target, mode, youWon, mult, amountUsd, tier }  (roll/target are 0–100 floats)
    async revealDice(res) {
      const seq = ++this._seq;
      const L = this.layers.dice, tp = Math.max(0, Math.min(100, res.target));
      L.classList.remove("win", "lose", "tier-big", "tier-mega", "nearmiss");
      this._clearCelebration(); this._clearConfetti();
      this.setChannel(9); this._activeChannel = 9;
      $("dice-tv-target").textContent = (res.mode === "under" ? "UNDER " : "OVER ") + tp.toFixed(2);
      $("dl-targetmark").style.left = tp + "%";
      if (res.mode === "under") { $("dl-win").style.cssText = `left:0;width:${tp}%`; $("dl-lose").style.cssText = `left:${tp}%;width:${100 - tp}%`; }
      else { $("dl-lose").style.cssText = `left:0;width:${tp}%`; $("dl-win").style.cssText = `left:${tp}%;width:${100 - tp}%`; }
      if (this._rail3d) try { this._rail3d.reset(); this._rail3d.setup(tp, res.mode); } catch (e) {} // 3D neon rail: green/red zones
      const marker = $("dl-marker"), numEl = $("dice-tv-num");
      marker.style.left = "0%"; numEl.textContent = "00.00";
      $("dice-tv-verdict").textContent = ""; $("dice-tv-payout").textContent = "";
      this._setStatic(0.06); this._show("dice");
      // 1) race the marker 0 -> roll, ease-out, number ticking
      const dur = 1400, start = now(), end = Math.max(0, Math.min(100, res.roll));
      await new Promise((resolve) => {
        const tick = () => {
          if (seq !== this._seq) return resolve();
          const t = Math.min(1, (now() - start) / dur), e = 1 - Math.pow(1 - t, 3), v = end * e;
          marker.style.left = v + "%"; numEl.textContent = v.toFixed(2);
          if (this._rail3d) this._rail3d.setPuck(v); // race the 3D puck
          if (window.Chiptune && Math.random() < 0.15) window.Chiptune.blip();
          if (t < 1) requestAnimationFrame(tick); else { numEl.textContent = end.toFixed(2); resolve(); }
        };
        requestAnimationFrame(tick);
      });
      if (seq !== this._seq) { try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {} return; }
      await sleep(140);
      // 2) verdict
      const tier = res.youWon ? (res.tier || "normal") : "normal";
      L.classList.add(res.youWon ? "win" : "lose");
      if (this._rail3d) try { this._rail3d.setPuck(res.roll); this._rail3d.land(res.youWon); } catch (e) {} // 3D puck locks + burst
      $("dice-tv-verdict").textContent = res.youWon ? (tier === "mega" ? "JACKPOT!" : tier === "big" ? "BIG WIN!" : "WIN!") : "MISS";
      $("dice-tv-payout").textContent = res.youWon
        ? "+$" + Math.abs(res.amountUsd).toFixed(2) + " · " + res.mult.toFixed(2) + "×"
        : "−$" + Math.abs(res.amountUsd).toFixed(2);
      if (!res.youWon && Math.abs(res.roll - res.target) < 0.5) L.classList.add("nearmiss");
      // 3) release balance + escalate, reusing the flip celebration ladder
      if (!window.__cineActive) {
        try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {}
        if (res.youWon) this._celebrate(L, tier);
        else if (window.Chiptune) window.Chiptune.lose();
      }
    },

    _setDieFace(el, n) { if (el) el.dataset.face = String(Math.max(1, Math.min(6, n | 0))); },

    // Dice #2 reveal: two d6 tumble, settle on their faces, then sum + verdict.
    // res = { d1, d2, target, mode, youWon, mult, amountUsd, tier }
    async revealTwoDice(res) {
      const seq = ++this._seq;
      const L = this.layers.twodice;
      const d1El = $("td-die1"), d2El = $("td-die2");
      L.classList.remove("win", "lose", "tier-big", "tier-mega");
      this._clearCelebration(); this._clearConfetti();
      this.setChannel(10); this._activeChannel = 10;
      $("td-tv-target").textContent = (res.mode === "under" ? "UNDER " : "OVER ") + res.target;
      $("td-tv-sum").textContent = "ROLLING…";
      $("td-tv-verdict").textContent = ""; $("td-tv-payout").textContent = "";
      d1El.classList.add("rolling"); d2El.classList.add("rolling");
      this._setStatic(0.06); this._show("twodice");
      // 1) tumble for ~1.1s, flashing random faces, then lock to the real result
      const dur = 1100, start = now();
      await new Promise((resolve) => {
        const tick = () => {
          if (seq !== this._seq) return resolve();
          const t = (now() - start) / dur;
          this._setDieFace(d1El, 1 + Math.floor(Math.random() * 6));
          this._setDieFace(d2El, 1 + Math.floor(Math.random() * 6));
          if (window.Chiptune && Math.random() < 0.2) window.Chiptune.blip();
          if (t < 1) setTimeout(() => requestAnimationFrame(tick), 70); else resolve();
        };
        requestAnimationFrame(tick);
      });
      if (seq !== this._seq) { try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {} return; }
      d1El.classList.remove("rolling"); d2El.classList.remove("rolling");
      this._setDieFace(d1El, res.d1); this._setDieFace(d2El, res.d2);
      const sum = (res.d1 | 0) + (res.d2 | 0);
      $("td-tv-sum").textContent = "SUM " + sum + "  (" + res.d1 + " + " + res.d2 + ")";
      await sleep(160);
      // 2) verdict
      const tier = res.youWon ? (res.tier || "normal") : "normal";
      L.classList.add(res.youWon ? "win" : "lose");
      $("td-tv-verdict").textContent = res.youWon ? (tier === "mega" ? "JACKPOT!" : tier === "big" ? "BIG WIN!" : "WIN!") : "MISS";
      $("td-tv-payout").textContent = res.youWon
        ? "+$" + Math.abs(res.amountUsd).toFixed(2) + " · " + res.mult.toFixed(2) + "×"
        : "−$" + Math.abs(res.amountUsd).toFixed(2);
      // 3) release balance + escalate, reusing the flip celebration ladder
      if (!window.__cineActive) {
        try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {}
        if (res.youWon) this._celebrate(L, tier);
        else if (window.Chiptune) window.Chiptune.lose();
      }
    },

    // Crash reveal: the rocket climbs live, auto-cashes-out at the target on a
    // win, or busts (explodes) at the secret crash point on a loss.
    // res = { crashX, targetX, won, amountUsd, mult, tier }
    async revealCrash(res) {
      const seq = ++this._seq;
      const L = this.layers.crash;
      const multEl = $("crash-mult"), subEl = $("crash-sub");
      L.classList.remove("win", "lose");
      if (multEl) multEl.classList.remove("win", "bust");
      this._clearCelebration(); this._clearConfetti();
      this.setChannel(11); this._activeChannel = 11;
      this._setStatic(0.05);
      // show first so the canvas has a real size when the renderer measures it
      if (multEl) multEl.textContent = "1.00×";
      if (subEl) subEl.textContent = "🚀 IN FLIGHT…";
      this._show("crash");
      this._ensureCrash();
      const R = window.CrashRender, Eng = window.CrashEngine;
      const endpoint = Math.max(1.01, res.won ? res.targetX : res.crashX);
      const lx = Math.log(endpoint);
      const revealMs = Math.max(1600, Math.min(6000, 1600 + 1200 * lx));
      const k = lx / revealMs;
      if (R) { R.reset(); R.setState("flying"); R.setMult(1); }
      // 1) climb the multiplier to the endpoint over revealMs
      const start = now();
      await new Promise((resolve) => {
        const tick = () => {
          if (seq !== this._seq) return resolve();
          const el = now() - start;
          if (el >= revealMs) { if (multEl) multEl.textContent = endpoint.toFixed(2) + "×"; if (R) R.setMult(endpoint); return resolve(); }
          const m = Eng ? Eng.multiplierAtMs(el, k) : Math.exp(k * el);
          const shown = Math.min(endpoint, m);
          if (multEl) { multEl.textContent = shown.toFixed(2) + "×"; const d = Math.max(0, Math.min(1, (shown - 2) / 23)); const c = d < 0.33 ? "#39e7ff" : d < 0.66 ? "#ff4d9d" : d < 0.85 ? "#ffd23f" : "#ff3b22"; multEl.style.color = c; multEl.style.textShadow = "0 0 16px " + c; } // climb color escalates cyan→red
          if (R) R.setMult(shown);
          if (window.Chiptune && Math.random() < 0.1) window.Chiptune.blip();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      // If the player tuned away mid-flight, abandon the reveal but still release
      // the frozen balance now instead of waiting on the 20s safety timer.
      if (seq !== this._seq) { try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {} return; }
      // 2) settle: cash out (win) or bust (loss)
      const tier = res.won ? (res.tier || "normal") : "normal";
      if (multEl) { multEl.style.color = ""; multEl.style.textShadow = ""; } // hand color back to the win/bust CSS class
      if (res.won) {
        L.classList.add("win");
        if (multEl) { multEl.classList.add("win"); multEl.textContent = res.targetX.toFixed(2) + "×"; }
        if (subEl) subEl.textContent = "CASHED OUT  +$" + Math.abs(res.amountUsd).toFixed(2);
        if (R) { R.cashout(); R.setState("cashed"); }
      } else {
        L.classList.add("lose");
        if (multEl) { multEl.classList.add("bust"); multEl.textContent = res.crashX.toFixed(2) + "× 💥"; }
        if (subEl) subEl.textContent = "BUSTED  −$" + Math.abs(res.amountUsd).toFixed(2);
        if (R) { R.explode(); R.setState("crashed"); }
      }
      // 3) release balance + escalate, reusing the flip celebration ladder
      if (!window.__cineActive) {
        try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {}
        if (res.won) this._celebrate(L, tier);
        else if (window.Chiptune) window.Chiptune.lose();
      }
    },

    // Crypto Reels reveal: spin the Pixi reels to the contract's grid and count
    // up the dollar payout. res = { grid:[5][3], winUsd, betUsd, won }
    async revealSlots(res) {
      const seq = ++this._seq;
      const L = this.layers.slots;
      L.classList.remove("win", "lose");
      this._clearCelebration(); this._clearConfetti();
      this.setChannel(12); this._activeChannel = 12;
      this._setStatic(0.04);
      this._show("slots");
      const msg = $("slots-msg");
      const release = () => { try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {} };
      if (!(window.CryptoReels && window.CryptoReels.isChannel)) { release(); return; }
      window.CryptoReels.setActive(true);
      if (msg) msg.textContent = ""; // Pixi shows GOOD LUCK → YOU WON $X → NO WIN (no DOM overlap)
      const ok = window.CryptoReels.channelSpin(res.grid, res.winUsd, res.betUsd, (r) => {
        if (seq !== this._seq) { release(); return; } // tuned away mid-spin
        L.classList.toggle("win", !!r.won);
        L.classList.toggle("lose", !r.won);
        if (msg) msg.textContent = ""; // the count-up amount is rendered in-canvas
        release();
        if (!window.__cineActive) {
          if (r.won) this._celebrate(L, r.big ? "mega" : "normal");
          else if (window.Chiptune) window.Chiptune.lose();
        }
      });
      if (!ok) release(); // a spin was already running — don't strand the balance
    },

    waiting(opts = {}) {
      this._seq++;
      this._setStatic(0.85); // loud static while we wait for a challenger
      this.setChannel(1);
      this._setScoreboard(opts.p1, opts.p2 || null, opts.p1Heads);
      if (opts.sub) $("waiting-sub").textContent = opts.sub;
      this._show("waiting");
    },

    async startFlip(opts = {}) {
      const seq = ++this._seq;
      this._pendingReveal = null;
      this._clearConfetti();
      this._setScoreboard(opts.p1, opts.p2, opts.p1Heads);
      this.setChannel(8);

      // Straight into the flip — no tuning static / "BETS ARE IN" / countdown.
      // The coin's own anticipation crouch is the wind-up; on a real round it
      // spins airborne and waits there for the on-chain result.
      if (window.Chiptune) window.Chiptune.coin();

      // TOSS: the coin launches up, spins airborne, and waits there for the
      //    result. The wrapper does the vertical arc; the coin does the flip-spin.
      this._setStatic(0.06);
      this._show("flip");
      if (this.coinToss) { this.coinToss.classList.remove("land"); void this.coinToss.offsetWidth; this.coinToss.classList.add("up"); }
      if (this.layerFlip) this.layerFlip.classList.add("airborne", "betting"); // shrink the ground shadow + hide the bet prompt
      this.coin.classList.remove("show-heads", "show-tails");
      this.coin.classList.add("spin");
      if (this._coin3d) try { this._coin3d.toss(); } catch (e) {} // 3D coin: anticipation → launch → air hang
      if (window.Chiptune) window.Chiptune.coin(); // the "toss" chime
      if (window.Chiptune && window.Chiptune.swoosh) window.Chiptune.swoosh(2300); // airborne whoosh for the spin
      this._spinReadyAt = now() + 2300; // a satisfying airborne spin before it lands

      // If the result already arrived during the countdown, reveal it now.
      if (this._pendingReveal) {
        const r = this._pendingReveal;
        this._pendingReveal = null;
        this._doReveal(seq, r);
      }
    },

    revealResult(res) {
      // Called when the chain settles. If we're still counting down, queue it.
      if (this._phase === "flip") {
        this._doReveal(this._seq, res);
      } else {
        this._pendingReveal = res;
      }
    },

    async _doReveal(seq, res) {
      const wait = Math.max(0, this._spinReadyAt - now());
      await sleep(wait);
      if (seq !== this._seq) { try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {} return; }

      // DROP + LAND: the coin falls out of the air, decelerating onto the winning
      // face with a bounce. The wrapper plays the vertical drop (coinDrop), the
      // coin decelerates its flip-spin onto show-heads/show-tails simultaneously.
      if (this.layerFlip) this.layerFlip.classList.remove("airborne"); // shadow grows back
      if (this.coinToss) { this.coinToss.classList.remove("up"); void this.coinToss.offsetWidth; this.coinToss.classList.add("land"); }
      this.coin.classList.remove("spin");
      void this.coin.offsetWidth; // force reflow to commit the base rotation
      this.coin.classList.add(res.side === "HEADS" ? "show-heads" : "show-tails");
      if (this._coin3d) { const t3 = res.youWon ? (res.tier === "mega" ? "mega" : res.tier === "big" ? "big" : "normal") : "normal"; try { this._coin3d.land(res.side, t3); if (res.youWon === true) this._coin3d.celebrate(t3); else if (res.youWon === false) this._coin3d.lose(); } catch (e) {} } // 3D coin drops + lands + reacts
      if (window.Chiptune) window.Chiptune.coin(); // the "catch" clink as it lands
      await sleep(900); // matches the coinDrop arc
      if (seq !== this._seq) { try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {} return; }

      // Result screen (per-viewer). Clear any prior celebration state.
      const layer = this.layers.result;
      layer.classList.remove("win", "lose", "tier-big", "tier-mega");
      this._clearCelebration();
      this._setStatic(0.04);

      // Excitement tier escalates with total pot size (only on a win you're in).
      const tier = res.youWon ? (res.tier === "mega" ? "mega" : res.tier === "big" ? "big" : "normal") : "normal";

      if (res.role === "spectator" || res.youWon === undefined) {
        layer.classList.add("win");
        this.resultEmoji.textContent = res.side === "HEADS" ? "🪙" : "⭐";
        this.resultHeadline.textContent = res.side + " WINS";
        this.resultSub.textContent = res.sub || "";
      } else if (res.youWon) {
        layer.classList.add("win");
        this.resultEmoji.textContent = tier === "mega" ? "🤑" : tier === "big" ? "🥳" : "😄";
        this.resultHeadline.textContent = tier === "mega" ? "JACKPOT!" : tier === "big" ? "BIG WIN!" : "YOU WIN!";
        this.resultSub.textContent = res.sub || "Pot is yours";
      } else {
        layer.classList.add("lose");
        this.resultEmoji.textContent = "😢";
        this.resultHeadline.textContent = "YOU LOSE";
        this.resultSub.textContent = res.sub || "Better luck next flip";
      }
      this.resultCoin.textContent = "RESULT: " + res.side;
      this._animateMoney(res);
      this._show("result");
      // While a full-motion cinematic reel is playing, hold the outcome cues
      // (balance unlock + win/loss sound) until the reel hits its climax — the
      // cinematic engine fires them itself. Otherwise release them now.
      if (!window.__cineActive) {
        try { window.__onTvReveal && window.__onTvReveal(res); } catch (e) {}
        if (layer.classList.contains("win")) this._celebrate(layer, tier);
        else if (window.Chiptune) window.Chiptune.lose();
      }
    },

    // Escalating win celebration: normal → big ($100+ pot) → mega ($500+ pot).
    _celebrate(layer, tier) {
      // Banner
      if (this.winBanner) {
        if (tier === "normal") {
          this.winBanner.className = "win-banner";
          this.winBanner.textContent = "";
        } else {
          this.winBanner.textContent = tier === "mega" ? "🎰 JACKPOT 🎰" : "💰 BIG WIN 💰";
          this.winBanner.className = "win-banner show " + tier;
          this.winBanner.style.animation = "none"; void this.winBanner.offsetWidth; this.winBanner.style.animation = "";
        }
      }
      // Strobe / glow background on the result layer
      if (tier === "big") layer.classList.add("tier-big");
      if (tier === "mega") layer.classList.add("tier-mega");
      // Screen shake
      if (this.screenEl) {
        this.screenEl.classList.remove("quake", "quake-hard");
        void this.screenEl.offsetWidth;
        if (tier === "big") this.screenEl.classList.add("quake");
        if (tier === "mega") this.screenEl.classList.add("quake-hard");
      }
      // Confetti + raining gold coins + sound, scaled to the tier
      this._burstConfetti(tier);
      this._coinShower(tier);
      const C = window.Chiptune;
      if (C) {
        if (tier === "mega" && C.jackpot) C.jackpot();
        else if (tier === "big" && C.bigwin) C.bigwin();
        else C.win();
      }
    },

    // Rain gold coins down the result screen with a stream of coin clinks. The
    // amount + duration scale with the win tier (normal → big → mega).
    _coinShower(tier) {
      const host = this.coinShower; if (!host) return;
      host.innerHTML = "";
      const n = tier === "mega" ? 64 : tier === "big" ? 34 : 16;
      const rect = host.getBoundingClientRect();
      const fall = (rect.height || 460) + 70;
      for (let i = 0; i < n; i++) {
        const c = document.createElement("span");
        c.className = "scoin";
        c.textContent = (i % 6 === 0) ? "💰" : "🪙";
        c.style.left = (Math.random() * 98) + "%";
        c.style.setProperty("--fall", fall + "px");
        c.style.setProperty("--s", (0.7 + Math.random() * 0.85).toFixed(2));
        c.style.setProperty("--spin", ((Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 540)).toFixed(0) + "deg");
        c.style.setProperty("--dur", (1.1 + Math.random() * 1.2).toFixed(2) + "s");
        c.style.animationDelay = (Math.random() * (tier === "mega" ? 1.3 : tier === "big" ? 0.8 : 0.45)).toFixed(2) + "s";
        host.appendChild(c);
      }
      // a stream of coin clinks raining alongside the shower
      const C = window.Chiptune, seq = this._seq;
      if (C && C.coin) {
        const ticks = tier === "mega" ? 11 : tier === "big" ? 7 : 4;
        for (let i = 0; i < ticks; i++) setTimeout(() => { if (seq === this._seq) try { C.coin(); } catch (e) {} }, 160 + i * 150);
      }
      // auto-clear so coins don't linger if the player stays on the screen
      clearTimeout(this._coinShowerT);
      this._coinShowerT = setTimeout(() => { if (host) host.innerHTML = ""; }, 4200);
    },

    _clearCelebration() {
      if (this.winBanner) { this.winBanner.className = "win-banner"; this.winBanner.textContent = ""; }
      if (this.screenEl) this.screenEl.classList.remove("quake", "quake-hard");
      if (this.layers && this.layers.result) this.layers.result.classList.remove("tier-big", "tier-mega");
      if (this.coinShower) this.coinShower.innerHTML = "";
      clearTimeout(this._coinShowerT);
    },

    // Casino-style count-up: rises from $0 to the amount won (green +) or lost
    // (red −). `res.amountUsd` is the net change to your balance for this game.
    _animateMoney(res) {
      const el = this.resultMoney;
      if (!el) return;
      el.className = "result-money";
      if (res.role === "spectator" || res.youWon === undefined || res.amountUsd == null || isNaN(res.amountUsd)) {
        el.textContent = "";
        return;
      }
      const won = !!res.youWon;
      const target = Math.max(0, Number(res.amountUsd));
      el.classList.add(won ? "win" : "lose");
      const sign = won ? "+" : "−";
      const fmt = (v) => sign + "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      // restart the pop animation
      el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
      const dur = 1000, start = now(), seq = this._seq;
      el.textContent = fmt(0);
      const tick = () => {
        if (seq !== this._seq) return;
        const t = Math.min(1, (now() - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        el.textContent = fmt(target * eased);
        if (t < 1) requestAnimationFrame(tick);
        else el.textContent = fmt(target);
      };
      requestAnimationFrame(tick);
    },

    // ── Universal WIN/LOSE result screen for the non-flip betting games ──
    // Reuses the rich coin-flip result layer as a DIMMING OVERLAY on top of the
    // live game (the game shows faintly behind), and KEEPS it up until the next
    // bet clears it (clearOutcome). o = { won, amountUsd, tier, sub }.
    showOutcome(o) {
      o = o || {};
      const layer = this.layers.result; if (!layer) return;
      this._clearConfetti(); this._clearCelebration();
      layer.classList.remove("win", "lose", "tier-big", "tier-mega");
      const tier = o.won ? (o.tier === "mega" ? "mega" : o.tier === "big" ? "big" : "normal") : "normal";
      if (o.won) {
        layer.classList.add("win");
        this.resultEmoji.textContent = tier === "mega" ? "🤑" : tier === "big" ? "🥳" : "😄";
        this.resultHeadline.textContent = tier === "mega" ? "JACKPOT!" : tier === "big" ? "BIG WIN!" : "YOU WIN!";
        this.resultSub.textContent = o.sub || "";
      } else {
        layer.classList.add("lose");
        this.resultEmoji.textContent = "😢";
        this.resultHeadline.textContent = "YOU LOSE";
        this.resultSub.textContent = o.sub || "Better luck next bet";
      }
      this.resultCoin.textContent = "";
      this._animateMoney({ youWon: !!o.won, amountUsd: Math.abs(+o.amountUsd || 0) });
      layer.classList.add("as-overlay"); // overlay + dim, WITHOUT hiding the game
      layer.classList.remove("hidden");
      this._outcomeShown = true;
      if (o.won) this._celebrate(layer, tier);
      else if (window.Chiptune) window.Chiptune.lose();
    },
    clearOutcome() {
      if (!this._outcomeShown) return;
      this._outcomeShown = false;
      const layer = this.layers.result; if (!layer) return;
      layer.classList.remove("as-overlay", "win", "lose", "tier-big", "tier-mega");
      this._clearCelebration(); this._clearConfetti();
      if (this._phase !== "result") layer.classList.add("hidden"); // flip owns the layer natively
    },

    reset() {
      this._seq++;
      this._pendingReveal = null;
      this.coin.classList.remove("spin", "show-heads", "show-tails");
      if (this.coinToss) this.coinToss.classList.remove("up", "land");
      if (this.layerFlip) this.layerFlip.classList.remove("airborne");
      if (this.coinShower) this.coinShower.innerHTML = "";
      if (this.resultMoney) { this.resultMoney.textContent = ""; this.resultMoney.className = "result-money"; }
      this._clearConfetti();
    },

    _countPop(text, isFlip) {
      const el = this.countNum;
      el.textContent = text;
      el.classList.toggle("flip-word", isFlip);
      // restart the pop animation
      el.style.animation = "none";
      void el.offsetWidth;
      el.style.animation = "";
    },

    /* ---------------- pixel confetti ---------------- */
    _clearConfetti() {
      if (this._confettiRAF) cancelAnimationFrame(this._confettiRAF);
      this._confettiRAF = null;
      if (this.cctx) this.cctx.clearRect(0, 0, this.confetti.width, this.confetti.height);
    },
    _burstConfetti(tier) {
      // A win scene already rains its own coins/confetti on top — skip this layer.
      if (window.__winSceneActive) return;
      this._sizeCanvases();
      const ctx = this.cctx;
      const W = this.confetti.width;
      const H = this.confetti.height;
      const palettes = {
        normal: ["#39e7ff", "#ff4d9d", "#ffd23f", "#45f0a6", "#ffffff"],
        big: ["#ffd23f", "#ffae00", "#fff2b0", "#ffffff", "#45f0a6"],
        mega: ["#ff4d9d", "#39e7ff", "#ffd23f", "#45f0a6", "#b14dff", "#ff7a3d", "#ffffff"],
      };
      const colors = palettes[tier] || palettes.normal;
      const N = tier === "mega" ? 320 : tier === "big" ? 180 : 90;
      const spread = tier === "mega" ? 15 : tier === "big" ? 11 : 9;
      const parts = [];
      for (let i = 0; i < N; i++) {
        parts.push({
          x: W / 2 + (Math.random() - 0.5) * 50,
          y: H / 2,
          vx: (Math.random() - 0.5) * spread,
          vy: -Math.random() * 10 - 3,
          s: 4 + Math.floor(Math.random() * 5), // chunky pixel squares
          c: colors[(Math.random() * colors.length) | 0],
          life: 80 + Math.floor(Math.random() * 50),
          coin: false,
        });
      }
      // Falling gold coins rain down from the top for big/mega wins.
      const coins = tier === "mega" ? 30 : tier === "big" ? 12 : 0;
      for (let i = 0; i < coins; i++) {
        parts.push({
          x: Math.random() * W,
          y: -20 - Math.random() * H,
          vx: (Math.random() - 0.5) * 1.5,
          vy: 2 + Math.random() * 3,
          s: 16 + Math.floor(Math.random() * 12),
          coin: true,
          life: 220,
        });
      }
      const seq = this._seq;
      const step = () => {
        if (seq !== this._seq) return;
        ctx.clearRect(0, 0, W, H);
        let alive = false;
        for (const p of parts) {
          if (p.life <= 0) continue;
          alive = true;
          p.vy += p.coin ? 0.08 : 0.35; // coins drift, confetti falls faster
          p.x += p.vx;
          p.y += p.vy;
          p.life--;
          if (p.coin) {
            ctx.font = p.s + "px serif";
            ctx.fillText("🪙", p.x | 0, p.y | 0);
            if (p.y > H + 24) p.life = 0;
          } else {
            ctx.fillStyle = p.c;
            ctx.fillRect(p.x | 0, p.y | 0, p.s, p.s);
          }
        }
        if (alive) this._confettiRAF = requestAnimationFrame(step);
        else ctx.clearRect(0, 0, W, H);
      };
      step();
    },
  };

  window.TV = TV;
})();
