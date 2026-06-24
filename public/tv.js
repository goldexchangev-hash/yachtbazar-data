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
      this.coin = $("coin");
      this.countNum = $("count-num");
      this.resultEmoji = $("result-emoji");
      this.resultHeadline = $("result-headline");
      this.resultMoney = $("result-money");
      this.resultSub = $("result-sub");
      this.resultCoin = $("result-coin");
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
      const w = this.staticCanvas.width;
      const h = this.staticCanvas.height;
      const PIX = 2; // pixel block size
      const cols = Math.ceil(w / PIX);
      const rows = Math.ceil(h / PIX);
      const FRAME_MS = 45; // ~22fps — plenty for a noisy CRT, far cheaper than 60
      let last = 0;
      const tick = (t) => {
        this._staticRAF = requestAnimationFrame(tick);
        if (t - last < FRAME_MS) return;
        last = t;
        const intensity = this._staticIntensity;
        if (intensity <= 0.02) {
          ctx.clearRect(0, 0, w, h);
          return;
        }
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const v = (Math.random() * 255) | 0;
            const tint = Math.random();
            if (tint > 0.985) ctx.fillStyle = `rgba(57,231,255,${intensity})`;
            else if (tint < 0.015) ctx.fillStyle = `rgba(255,77,157,${intensity})`;
            else ctx.fillStyle = `rgba(${v},${v},${v},${intensity})`;
            ctx.fillRect(x * PIX, y * PIX, PIX, PIX);
          }
        }
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
    _setScoreboard(p1, p2) {
      this.scoreboard.classList.toggle("hidden", !(p1 || p2));
      if (p1) this.sbP1.textContent = SHORT(p1);
      this.sbP2.textContent = p2 ? SHORT(p2) : "WAITING…";
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
      this._setScoreboard(opts.p1, opts.p2 || null);
      if (opts.sub) $("waiting-sub").textContent = opts.sub;
      this._show("waiting");
    },

    async startFlip(opts = {}) {
      const seq = ++this._seq;
      this._pendingReveal = null;
      this._clearConfetti();
      this._setScoreboard(opts.p1, opts.p2);
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

      // Result screen (per-viewer).
      const layer = this.layers.result;
      layer.classList.remove("win", "lose");
      this._setStatic(0.04);

      if (res.role === "spectator" || res.youWon === undefined) {
        layer.classList.add("win");
        this.resultEmoji.textContent = res.side === "HEADS" ? "🪙" : "⭐";
        this.resultHeadline.textContent = res.side + " WINS";
        this.resultSub.textContent = res.sub || "";
      } else if (res.youWon) {
        layer.classList.add("win");
        this.resultEmoji.textContent = "😄";
        this.resultHeadline.textContent = "YOU WIN!";
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

      if (layer.classList.contains("win")) {
        this._burstConfetti();
        if (window.Chiptune) window.Chiptune.win();
      } else if (window.Chiptune) {
        window.Chiptune.lose();
      }
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
    _burstConfetti() {
      this._sizeCanvases();
      const ctx = this.cctx;
      const W = this.confetti.width;
      const H = this.confetti.height;
      const colors = ["#39e7ff", "#ff4d9d", "#ffd23f", "#45f0a6", "#ffffff"];
      const N = 90;
      const parts = [];
      for (let i = 0; i < N; i++) {
        parts.push({
          x: W / 2 + (Math.random() - 0.5) * 40,
          y: H / 2,
          vx: (Math.random() - 0.5) * 9,
          vy: -Math.random() * 9 - 3,
          s: 4 + Math.floor(Math.random() * 5), // chunky pixel squares
          c: colors[(Math.random() * colors.length) | 0],
          life: 70 + Math.floor(Math.random() * 40),
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
          p.vy += 0.35; // gravity
          p.x += p.vx;
          p.y += p.vy;
          p.life--;
          ctx.fillStyle = p.c;
          ctx.fillRect(p.x | 0, p.y | 0, p.s, p.s);
        }
        if (alive) this._confettiRAF = requestAnimationFrame(step);
        else ctx.clearRect(0, 0, W, H);
      };
      step();
    },
  };

  window.TV = TV;
})();
