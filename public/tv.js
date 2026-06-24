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
      };
      this.scoreboard = $("scoreboard");
      this.sbP1 = $("sb-p1");
      this.sbP2 = $("sb-p2");
      this.sbP1Who = $("sb-p1-who");
      this.sbP2Who = $("sb-p2-who");
      this.coin = $("coin");
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
      // Render static at a low internal resolution for chunky 16-bit pixels.
      this.staticCanvas.width = 200;
      this.staticCanvas.height = 150;
      const r = this.confetti.getBoundingClientRect();
      this.confetti.width = Math.max(2, Math.floor(r.width));
      this.confetti.height = Math.max(2, Math.floor(r.height));
    },

    /* ---------------- static / noise ---------------- */
    _startStatic() {
      const ctx = this.sctx;
      ctx.imageSmoothingEnabled = false;
      const PIX = 4; // pixel block size (bigger = far less work)
      const cols = Math.max(1, Math.ceil(this.staticCanvas.width / PIX));
      const rows = Math.max(1, Math.ceil(this.staticCanvas.height / PIX));
      // Fill a tiny offscreen buffer and upscale it (nearest-neighbor) — ONE
      // drawImage per frame instead of thousands of fillRect calls.
      const buf = document.createElement("canvas");
      buf.width = cols; buf.height = rows;
      const bctx = buf.getContext("2d");
      const img = bctx.createImageData(cols, rows);
      const data = img.data;
      const paint = () => {
        const W = this.staticCanvas.width, H = this.staticCanvas.height;
        for (let i = 0; i < data.length; i += 4) {
          const r = Math.random();
          if (r > 0.985) { data[i] = 57; data[i + 1] = 231; data[i + 2] = 255; }
          else if (r < 0.015) { data[i] = 255; data[i + 1] = 77; data[i + 2] = 157; }
          else { const v = (Math.random() * 255) | 0; data[i] = data[i + 1] = data[i + 2] = v; }
          data[i + 3] = 255;
        }
        bctx.putImageData(img, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.globalAlpha = this._staticIntensity;
        ctx.drawImage(buf, 0, 0, W, H);
        ctx.globalAlpha = 1;
      };
      // Reduced-motion / save-data: paint a single calm frame, no animation loop.
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) { this._staticIntensity = Math.min(this._staticIntensity, 0.25); paint(); return; }
      const FRAME_MS = 70; // ~14fps — plenty for a noisy CRT
      let last = 0;
      const tick = (t) => {
        this._staticRAF = requestAnimationFrame(tick);
        if (document.hidden) return;          // don't burn cycles in a background tab
        if (window.__winSceneActive) return;  // a win scene covers the TV — don't paint static
        if (t - last < FRAME_MS) return;
        last = t;
        if (this._staticIntensity <= 0.02) { ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height); return; }
        paint();
      };
      this._staticRAF = requestAnimationFrame(tick);
    },
    _setStatic(i) {
      this._staticIntensity = i;
      this.staticCanvas.style.opacity = i > 0 ? "1" : "0";
    },

    /* ---------------- layer helpers ---------------- */
    _show(name) {
      for (const k of Object.keys(this.layers)) {
        this.layers[k].classList.toggle("hidden", k !== name);
      }
      this._phase = name;
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
      this._setStatic(0.5);
      this.scoreboard.classList.add("hidden");
      this._clearConfetti();
      this.setChannel(3);
      if (subtext) $("idle-sub").textContent = subtext;
      this._show("idle");
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
      this.setChannel(2);

      // 1) BETS ARE IN — tuning static
      this._setStatic(0.95);
      this._show("tuning");
      await sleep(1100);
      if (seq !== this._seq) return;

      // 2) Countdown 3 · 2 · 1 · FLIP!
      this.setChannel(8);
      this._setStatic(0.12);
      this._show("countdown");
      for (const step of ["3", "2", "1"]) {
        if (seq !== this._seq) return;
        this._countPop(step, false);
        if (window.Chiptune) window.Chiptune.blip();
        await sleep(820);
      }
      if (seq !== this._seq) return;
      this._countPop("FLIP!", true);
      if (window.Chiptune) window.Chiptune.coin();
      await sleep(620);
      if (seq !== this._seq) return;

      // 3) Coin spins until a result is revealed
      this._setStatic(0.06);
      this._show("flip");
      this.coin.classList.remove("show-heads", "show-tails");
      this.coin.classList.add("spin");
      this._spinReadyAt = now() + 1500; // guarantee at least 1.5s of spin

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
      if (seq !== this._seq) return;

      // Stop the coin on the winning side. Commit the base transform between
      // removing .spin and adding the land class so the 0.7s transition fires
      // smoothly (no one-frame snap) and decelerates onto the right face.
      this.coin.classList.remove("spin");
      void this.coin.offsetWidth; // force reflow to commit the base rotation
      this.coin.classList.add(res.side === "HEADS" ? "show-heads" : "show-tails");
      await sleep(720);
      if (seq !== this._seq) return;

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
      // Confetti + sound, scaled to the tier
      this._burstConfetti(tier);
      const C = window.Chiptune;
      if (C) {
        if (tier === "mega" && C.jackpot) C.jackpot();
        else if (tier === "big" && C.bigwin) C.bigwin();
        else C.win();
      }
    },

    _clearCelebration() {
      if (this.winBanner) { this.winBanner.className = "win-banner"; this.winBanner.textContent = ""; }
      if (this.screenEl) this.screenEl.classList.remove("quake", "quake-hard");
      if (this.layers && this.layers.result) this.layers.result.classList.remove("tier-big", "tier-mega");
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

    reset() {
      this._seq++;
      this._pendingReveal = null;
      this.coin.classList.remove("spin", "show-heads", "show-tails");
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
