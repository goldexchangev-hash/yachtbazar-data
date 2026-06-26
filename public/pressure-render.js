/* ============================================================
   pressure-render.js — PRESSURE: PixiJS visualization ONLY (v2, juicier).

   Receives a multiplier + hold-progress each tick and draws. NEVER given the
   burst point B during inflation, so it cannot leak the seed — all "dread"
   cues (glow, cracks, jitter, wobble, danger vignette) are pure functions of
   hold-progress vs a fixed public curve.

   getRenderedMultiplier() lets the UI snap payout to the on-screen frame.
   globalThis.PressureRenderer
   ============================================================ */
(function (root) {
  "use strict";
  const PIXI = root.PIXI;

  const C = {
    bg: 0x0a0717,
    balloon: 0xff4d7d, balloonHi: 0xffe2ea, balloonLo: 0x8f1338, hot: 0xff2a2a,
    cyan: 0x39e7ff, magenta: 0xff4d9d, gold: 0xffd23f, green: 0x45f0a6, red: 0xff5b5b, white: 0xffffff,
    brass: 0xffd23f, ink: 0xeef1ff, muted: 0x9aa3c7,
  };
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mixColor(c1, c2, t) {
    const r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255;
    const r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;
    return (Math.round(lerp(r1, r2, t)) << 16) | (Math.round(lerp(g1, g2, t)) << 8) | Math.round(lerp(b1, b2, t));
  }
  // Build a soft radial-gradient texture (high-quality glow/spotlight/vignette).
  function radialTexture(size, stops) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const s of stops) g.addColorStop(s[0], s[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    return PIXI.Texture.from(cv);
  }

  function PressureRenderer(opts) {
    const W = opts.width || 480, H = opts.height || 640;
    this.W = W; this.H = H;
    this.onTick = opts.onTick || function () {};
    this.cx = W / 2; this.cy = H * 0.46;
    this.baseR = Math.min(W, H) * 0.155;
    this._mult = 1; this._progress = 0; this._state = "idle";
    this._t = 0; this._breath = 0; this._shake = 0;
    this._cracks = []; this._rings = []; this._particles = []; this._coins = [];
    this._shock = []; this._floats = []; this._sparks = [];

    const app = new PIXI.Application({
      width: W, height: H, backgroundColor: C.bg, antialias: true,
      resolution: Math.min(2, root.devicePixelRatio || 1), autoDensity: true,
    });
    this.app = app; this.view = app.view;
    if (opts.mount) opts.mount.appendChild(app.view);

    // textures
    this.texGlow = radialTexture(256, [[0, "rgba(255,255,255,1)"], [0.45, "rgba(255,255,255,0.55)"], [1, "rgba(255,255,255,0)"]]);
    this.texVignette = radialTexture(512, [[0, "rgba(255,40,40,0)"], [0.55, "rgba(255,30,30,0)"], [1, "rgba(255,40,40,0.95)"]]);

    // ---- background ----
    const bg = new PIXI.Graphics();
    bg.beginFill(C.bg).drawRect(0, 0, W, H).endFill();
    // gradient-ish floor
    for (let i = 0; i < 6; i++) bg.beginFill(0x140a26, 0.10).drawRect(0, H * (0.55 + i * 0.07), W, H).endFill();
    app.stage.addChild(bg);

    const spot = new PIXI.Sprite(this.texGlow);
    spot.anchor.set(0.5); spot.tint = 0x6b4bd8; spot.alpha = 0.5;
    spot.width = W * 1.9; spot.height = H * 1.5; spot.position.set(this.cx, this.cy);
    app.stage.addChild(spot); this.spot = spot;

    this.bgFx = new PIXI.Container(); app.stage.addChild(this.bgFx);
    this._initSparks();

    const world = new PIXI.Container(); app.stage.addChild(world); this.world = world;

    // ---- balloon ----
    const balloonLayer = new PIXI.Container();
    balloonLayer.position.set(this.cx, this.cy);
    world.addChild(balloonLayer); this.balloonLayer = balloonLayer;

    this.glow = new PIXI.Sprite(this.texGlow);
    this.glow.anchor.set(0.5); this.glow.blendMode = PIXI.BLEND_MODES.ADD; this.glow.tint = C.balloon; this.glow.alpha = 0.5;
    balloonLayer.addChild(this.glow);
    this.body = new PIXI.Graphics(); balloonLayer.addChild(this.body);
    this.sheen = new PIXI.Graphics(); balloonLayer.addChild(this.sheen);
    this.crackG = new PIXI.Graphics(); this.crackG.blendMode = PIXI.BLEND_MODES.ADD; balloonLayer.addChild(this.crackG);
    this.ringG = new PIXI.Graphics(); balloonLayer.addChild(this.ringG);

    // ---- gauge / text ----
    this.multText = new PIXI.Text("1.00x", {
      fontFamily: '"Bungee","Press Start 2P",monospace', fontSize: 46, fill: C.white, align: "center",
      dropShadow: true, dropShadowColor: C.cyan, dropShadowBlur: 14, dropShadowDistance: 0, dropShadowAlpha: 0.9,
    });
    this.multText.anchor.set(0.5); this.multText.position.set(this.cx, H * 0.135); world.addChild(this.multText);

    this.lockedText = new PIXI.Text("", { fontFamily: '"Press Start 2P",monospace', fontSize: 11, fill: C.gold });
    this.lockedText.anchor.set(0.5, 0); this.lockedText.position.set(this.cx, H * 0.205); world.addChild(this.lockedText);

    this.barX = W - 28; this.barTop = H * 0.20; this.barBot = H * 0.82;
    this.barG = new PIXI.Graphics(); world.addChild(this.barG); this._autoMult = 2.0; this._minMult = 0;

    this.hint = new PIXI.Text("HOLD", {
      fontFamily: '"Press Start 2P",monospace', fontSize: 15, fill: C.cyan,
      dropShadow: true, dropShadowColor: 0x0a3a44, dropShadowBlur: 6, dropShadowDistance: 0,
    });
    this.hint.anchor.set(0.5); this.hint.position.set(this.cx, this.cy + this.baseR + 78); world.addChild(this.hint);

    this.receipt = new PIXI.Text("", { fontFamily: '"Press Start 2P",monospace', fontSize: 11, fill: C.muted, align: "center" });
    this.receipt.anchor.set(0.5); this.receipt.position.set(this.cx, H * 0.30); this.receipt.alpha = 0; world.addChild(this.receipt);

    // ---- fx / overlays ----
    this.fx = new PIXI.Container(); world.addChild(this.fx);
    this.fxAdd = new PIXI.Container(); this.fxAdd.blendMode = PIXI.BLEND_MODES.ADD; world.addChild(this.fxAdd);

    // BIG win readouts (on top of the coin shower)
    this.winBanner = new PIXI.Text("", {
      fontFamily: '"Bungee","Press Start 2P",monospace', fontSize: 46, fill: 0xffd23f, align: "center",
      dropShadow: true, dropShadowColor: 0xff4d9d, dropShadowBlur: 16, dropShadowDistance: 0, dropShadowAlpha: 1,
    });
    this.winBanner.anchor.set(0.5); this.winBanner.position.set(this.cx, H * 0.30); this.winBanner.alpha = 0; this.winBanner.visible = false; world.addChild(this.winBanner);

    this.winAmt = new PIXI.Text("", {
      fontFamily: '"Bungee","Press Start 2P",monospace', fontSize: 70, fill: 0x7cffb2, align: "center",
      dropShadow: true, dropShadowColor: 0x00863a, dropShadowBlur: 14, dropShadowDistance: 0, dropShadowAlpha: 1,
    });
    this.winAmt.anchor.set(0.5); this.winAmt.position.set(this.cx, H * 0.52); this.winAmt.alpha = 0; this.winAmt.visible = false; world.addChild(this.winAmt);

    this.danger = new PIXI.Sprite(this.texVignette);
    this.danger.width = W; this.danger.height = H; this.danger.alpha = 0; app.stage.addChild(this.danger);

    this.flash = new PIXI.Graphics(); this.flash.beginFill(C.white).drawRect(0, 0, W, H).endFill();
    this.flash.alpha = 0; app.stage.addChild(this.flash);

    this._genCracks(); this._drawBalloon();
    app.ticker.add(() => this._frame(app.ticker.deltaMS / 1000));
  }

  PressureRenderer.prototype._initSparks = function () {
    for (let i = 0; i < 16; i++) {
      const g = new PIXI.Graphics();
      const col = [C.cyan, C.magenta, C.gold][i % 3];
      g.beginFill(col, 1).drawCircle(0, 0, 1.6 + Math.random() * 1.8).endFill();
      g.blendMode = PIXI.BLEND_MODES.ADD;
      g.x = Math.random() * this.W; g.y = Math.random() * this.H;
      g.alpha = 0.15 + Math.random() * 0.3;
      this.bgFx.addChild(g);
      this._sparks.push({ g, vy: -(6 + Math.random() * 16), ph: Math.random() * 6.28, amp: 8 + Math.random() * 16 });
    }
  };

  PressureRenderer.prototype._genCracks = function () {
    this._cracks = [];
    const n = 10;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, segs = 3 + (Math.random() * 3 | 0);
      const pts = []; let r = this.baseR * (0.12 + Math.random() * 0.35), a = ang;
      for (let s = 0; s <= segs; s++) {
        pts.push([Math.cos(a) * r, Math.sin(a) * r * 1.12]);
        r += this.baseR * (0.16 + Math.random() * 0.16); a += (Math.random() - 0.5) * 0.95;
      }
      this._cracks.push({ pts, at: 0.42 + (i / n) * 0.5 });
    }
  };

  PressureRenderer.prototype._balloonScale = function (mult) { return clamp(0.5 + 0.15 * Math.log2(mult + 1), 0.5, 1.95); };

  PressureRenderer.prototype._drawBalloon = function () {
    const sc = this._balloonScale(this._mult) * (1 + this._breath);
    const rx = this.baseR * sc, ry = this.baseR * 1.14 * sc;
    const strain = clamp(this._progress, 0, 1);
    const edge = mixColor(C.balloonLo, C.hot, strain * 0.6);
    const mid = mixColor(C.balloon, C.hot, strain * 0.6);
    const hi = mixColor(C.balloonHi, 0xffffff, strain * 0.3);

    // glow behind
    this.glow.tint = mixColor(C.balloon, C.hot, strain);
    this.glow.alpha = 0.35 + 0.4 * strain + 0.06 * Math.sin(this._t * 8);
    const gs = (rx * 2.6); this.glow.width = gs; this.glow.height = gs * 1.05;

    const g = this.body; g.clear();
    // knot + string first (behind body bottom)
    g.beginFill(edge, 1).moveTo(-rx * 0.13, ry * 0.95).lineTo(rx * 0.13, ry * 0.95).lineTo(0, ry * 1.14).closePath().endFill();
    g.lineStyle(2, 0x6b7bb5, 0.55).moveTo(0, ry * 1.14).bezierCurveTo(rx * 0.22, ry * 1.45, -rx * 0.22, ry * 1.75, rx * 0.05, ry * 2.05);
    g.lineStyle(0);
    // layered gradient sphere (edge -> mid -> highlight), offset up-left = light source
    const layers = 7;
    for (let i = 0; i < layers; i++) {
      const t = i / (layers - 1);
      const col = t < 0.5 ? mixColor(edge, mid, t / 0.5) : mixColor(mid, hi, (t - 0.5) / 0.5);
      const rr = rx * (1 - t * 0.6), ryy = ry * (1 - t * 0.6);
      const ox = -rx * 0.13 * t, oy = -ry * 0.15 * t;
      g.beginFill(col, 1).drawEllipse(ox, oy, rr, ryy).endFill();
    }
    // rim definition
    g.lineStyle(2, mixColor(edge, 0x000000, 0.3), 0.5).drawEllipse(0, 0, rx, ry); g.lineStyle(0);

    // sheen / specular
    const s = this.sheen; s.clear();
    s.beginFill(C.white, 0.35).drawEllipse(-rx * 0.33, -ry * 0.36, rx * 0.27, ry * 0.36).endFill();
    s.beginFill(C.white, 0.85).drawEllipse(-rx * 0.38, -ry * 0.44, rx * 0.10, ry * 0.17).endFill();
    s.beginFill(C.cyan, 0.18).drawEllipse(rx * 0.34, ry * 0.30, rx * 0.18, ry * 0.26).endFill(); // cool rim light

    // cracks
    const cg = this.crackG; cg.clear();
    if (strain > 0.4) {
      for (const cr of this._cracks) {
        if (strain < cr.at) continue;
        const a = clamp((strain - cr.at) / 0.16, 0, 1) * (0.45 + 0.55 * strain);
        cg.lineStyle(clamp(1 + strain * 2.8, 1, 3.8), mixColor(C.cyan, C.white, strain), a);
        cg.moveTo(cr.pts[0][0] * sc, cr.pts[0][1] * sc);
        for (let i = 1; i < cr.pts.length; i++) cg.lineTo(cr.pts[i][0] * sc, cr.pts[i][1] * sc);
      }
    }

    // valve rings
    const rg = this.ringG; rg.clear();
    for (const ring of this._rings) {
      const rr = this.baseR * this._balloonScale(ring.mult) * 1.03 + 5;
      rg.lineStyle(5, C.brass, 0.9).drawEllipse(0, 0, rr, rr * 1.12);
      rg.lineStyle(2, C.white, 0.5).drawEllipse(0, 0, rr - 3, (rr - 3) * 1.12);
    }
  };

  PressureRenderer.prototype._drawBar = function () {
    const g = this.barG; g.clear();
    const x = this.barX, top = this.barTop, bot = this.barBot, h = bot - top;
    g.beginFill(0x000000, 0.4).drawRoundedRect(x - 10, top - 8, 20, h + 16, 10).endFill();
    g.lineStyle(1, 0xffffff, 0.08).drawRoundedRect(x - 10, top - 8, 20, h + 16, 10); g.lineStyle(0);
    const fill = clamp(Math.log2(this._mult + 1) / Math.log2(11), 0, 1);
    const fy = bot - fill * h;
    const col = mixColor(C.cyan, C.red, clamp(this._progress, 0, 1));
    g.beginFill(col, 0.95).drawRoundedRect(x - 6, fy, 12, bot - fy, 6).endFill();
    g.beginFill(C.white, 0.5).drawRoundedRect(x - 6, fy, 12, 3, 3).endFill();
    // minimum cash-out threshold (faint white tick)
    if (this._minMult) {
      const mf = clamp(Math.log2(this._minMult + 1) / Math.log2(11), 0, 1);
      const my = bot - mf * h;
      g.lineStyle(2, C.white, 0.22).moveTo(x - 13, my).lineTo(x + 7, my);
    }
    const af = clamp(Math.log2(this._autoMult + 1) / Math.log2(11), 0, 1);
    const ay = bot - af * h;
    g.lineStyle(2, C.gold, 0.95).moveTo(x - 15, ay).lineTo(x + 9, ay);
    g.beginFill(C.gold).drawPolygon([x + 9, ay - 6, x + 18, ay, x + 9, ay + 6]).endFill();
  };

  PressureRenderer.prototype._frame = function (dt) {
    this._t += dt;
    this.onTick(dt);

    if (this._state === "idle" || this._state === "armed") this._breath = Math.sin(this._t * 3.0) * 0.03;
    else this._breath = lerp(this._breath, 0, 0.3);

    const p = clamp(this._progress, 0, 1);

    // wobble (squash/stretch jelly), grows with strain
    const wob = Math.sin(this._t * 9) * (0.012 + p * 0.05);
    this.balloonLayer.scale.set(1 + wob, 1 - wob);

    // jitter (B-independent)
    if (this._state === "inflating") {
      const amp = p * p * 8;
      this.balloonLayer.position.set(this.cx + (Math.random() - 0.5) * amp, this.cy + (Math.random() - 0.5) * amp);
    } else this.balloonLayer.position.set(this.cx, this.cy);

    // danger vignette
    const dTarget = this._state === "inflating" ? p * p * (0.55 + 0.2 * Math.sin(this._t * 12)) : 0;
    this.danger.alpha = lerp(this.danger.alpha, Math.max(0, dTarget), 0.2);

    // spotlight breathe
    this.spot.alpha = 0.45 + 0.06 * Math.sin(this._t * 2) + p * 0.12;
    this.spot.tint = mixColor(0x6b4bd8, 0x8f1338, p * 0.5);

    // sparks drift
    for (const sp of this._sparks) {
      sp.g.y += sp.vy * dt;
      sp.g.x += Math.sin(this._t + sp.ph) * sp.amp * dt;
      if (sp.g.y < -6) { sp.g.y = this.H + 6; sp.g.x = Math.random() * this.W; }
    }

    // shake
    if (this._shake > 0.2) { this.world.position.set((Math.random() - 0.5) * this._shake, (Math.random() - 0.5) * this._shake); this._shake *= 0.87; }
    else if (this.world.position.x || this.world.position.y) { this.world.position.set(0, 0); this._shake = 0; }

    if (this.flash.alpha > 0.01) this.flash.alpha *= 0.84; else this.flash.alpha = 0;
    if (this.receipt.alpha > 0 && this._state !== "inflating") this.receipt.alpha = Math.max(0, this.receipt.alpha - dt * 0.5);

    // multiplier text glow + pulse
    const pulse = 1 + (this._state === "inflating" ? 0.03 * Math.sin(this._t * 10) + p * 0.05 : 0);
    this.multText.scale.set(pulse);
    this.multText.style.dropShadowColor = p > 0.7 ? C.red : (p > 0.45 ? C.gold : C.cyan);

    // shockwaves
    for (let i = this._shock.length - 1; i >= 0; i--) {
      const s = this._shock[i]; s.r += s.spd * dt; s.life -= dt;
      s.g.clear(); s.g.lineStyle(clamp(s.life * 8, 1, 7), s.col, clamp(s.life, 0, 1)).drawCircle(this.cx, this.cy, s.r);
      if (s.life <= 0) { this.fxAdd.removeChild(s.g); s.g.destroy(); this._shock.splice(i, 1); }
    }
    // particles
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const q = this._particles[i]; q.vy += 980 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt;
      q.g.position.set(q.x, q.y); q.g.rotation += q.vr * dt; q.g.alpha = clamp(q.life / 0.45, 0, 1);
      if (q.life <= 0 || q.y > this.H + 40) { q.g.parent.removeChild(q.g); q.g.destroy(); this._particles.splice(i, 1); }
    }
    // coins
    for (let i = this._coins.length - 1; i >= 0; i--) {
      const q = this._coins[i]; q.t += dt / q.dur; const tt = clamp(q.t, 0, 1), e = 1 - (1 - tt) * (1 - tt);
      q.g.position.set(lerp(q.x0, q.x1, e), lerp(q.y0, q.y1, e) - Math.sin(tt * Math.PI) * 70);
      q.g.scale.set(lerp(1, 0.4, tt));
      if (tt >= 1) { this.fxAdd.removeChild(q.g); q.g.destroy(); this._coins.splice(i, 1); }
    }
    // floating texts
    for (let i = this._floats.length - 1; i >= 0; i--) {
      const f = this._floats[i]; f.life -= dt; f.g.y -= 40 * dt; f.g.alpha = clamp(f.life / 0.5, 0, 1);
      if (f.life <= 0) { this.fx.removeChild(f.g); f.g.destroy(); this._floats.splice(i, 1); }
    }

    // BIG win count-up — the amount races up (gold→green), pops, with a sustained
    // coin shower + "cha-ching" ticks climbing alongside it.
    if (this._winFx) {
      const w = this._winFx;
      w.t += dt;
      const k = clamp(w.t / w.dur, 0, 1);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      w.displayed = w.total * e;
      const baseScale = w.mega ? 1.55 : w.big ? 1.28 : 1;
      const pop = clamp(w.t / 0.3, 0, 1);
      const popS = 0.4 + 0.6 * (1 - (1 - pop) * (1 - pop));
      const pulse = k < 1 ? (1 + 0.07 * Math.sin(this._t * 24)) : 1;
      this.winAmt.text = "+$" + (Math.round(w.displayed * 100) / 100).toFixed(2);
      this.winAmt.scale.set(baseScale * popS * pulse);
      this.winAmt.alpha = clamp(w.t / 0.18, 0, 1);
      this.winAmt.style.fill = k < 1 ? 0xffe27a : 0x7cffb2; // gold while counting → green when banked
      this.winBanner.alpha = clamp(w.t / 0.22, 0, 1);
      this.winBanner.scale.set((w.mega ? 1.15 : 1) * (1 + 0.06 * Math.sin(this._t * 9)));
      this.winBanner.rotation = Math.sin(this._t * 5.5) * 0.035;
      if (k < 1) {
        if (this._t - w.lastCoin > 0.05) { w.lastCoin = this._t; const n = w.mega ? 3 : w.big ? 2 : 1; for (let i = 0; i < n; i++) this._spawnCoin(); }
        if (this._t - w.lastTick > 0.065) { w.lastTick = this._t; try { root.Chiptune && root.Chiptune.coin && root.Chiptune.coin(); } catch (e) {} }
      } else {
        if (!w.done) { w.done = true; w.holdT = this._t; this.winAmt.text = "+$" + (Math.round(w.total * 100) / 100).toFixed(2); }
        if (this._t - w.holdT > 1.5) {
          const fade = dt * 1.3;
          this.winAmt.alpha = Math.max(0, this.winAmt.alpha - fade);
          this.winBanner.alpha = Math.max(0, this.winBanner.alpha - fade);
          if (this.winAmt.alpha <= 0.02) { this.winAmt.visible = false; this.winBanner.visible = false; this._winFx = null; }
        }
      }
    }

    this._drawBalloon(); this._drawBar();
  };

  // ---------- API ----------
  PressureRenderer.prototype.setState = function (st) {
    this._state = st;
    this.hint.visible = (st === "armed" || st === "idle");
  };
  PressureRenderer.prototype.setLive = function (mult, progress) {
    this._mult = mult; this._progress = progress;
    this.multText.text = mult.toFixed(2) + "x";
    this.multText.style.fill = progress > 0.75 ? C.red : (progress > 0.5 ? C.gold : C.white);
  };
  PressureRenderer.prototype.getRenderedMultiplier = function () { return this._mult; };
  PressureRenderer.prototype.setAutoLine = function (mult) { this._autoMult = mult; };
  PressureRenderer.prototype.setMinLine = function (mult) { this._minMult = mult; };
  PressureRenderer.prototype.refund = function () {
    // neutral "too early" deflate — no win/pop theater
    this._mult = 1; this.multText.text = "1.00x"; this.multText.style.fill = C.muted;
    this.flash.tint = C.cyan; this.flash.alpha = 0.12; this.danger.alpha = 0;
    this.showReceipt("too early — bet refunded", false);
  };
  PressureRenderer.prototype.setLockedText = function (amount) { this.lockedText.text = amount > 0 ? ("LOCKED " + amount.toFixed(2)) : ""; };
  PressureRenderer.prototype.addValveRing = function (mult) { this._rings.push({ mult }); };
  PressureRenderer.prototype.clearValveRings = function () { this._rings = []; };

  PressureRenderer.prototype._shockwave = function (col, spd) {
    const g = new PIXI.Graphics(); this.fxAdd.addChild(g);
    this._shock.push({ g, r: this.baseR, spd: spd || 700, life: 0.6, col: col || C.white });
  };
  PressureRenderer.prototype.win = function (info) {
    this._mult = info.finalMult; this.multText.style.fill = C.green;
    const payout = Math.max(0, info.payout || 0);
    const profit = Math.max(0, info.profit != null ? info.profit : payout);
    const mult = info.finalMult || 1;
    const big = mult >= 3 || profit >= 100;
    const mega = mult >= 8 || profit >= 500;
    // count-up state — slower, satisfying climb to the full amount
    this._winFx = { t: 0, dur: mega ? 2.0 : big ? 1.7 : 1.35, total: payout, displayed: 0, profit, mult, big, mega, lastCoin: -1, lastTick: -1, done: false, holdT: 0 };
    // banner + big amount
    this.winBanner.text = mega ? "MEGA WIN!" : big ? "BIG WIN!" : "BANKED!";
    this.winBanner.style.fill = mega ? 0xff4d9d : 0xffd23f;
    this.winBanner.alpha = 0; this.winBanner.visible = true; this.winBanner.scale.set(1);
    this.winAmt.text = "+$0.00"; this.winAmt.style.fill = 0xffe27a; this.winAmt.alpha = 0; this.winAmt.visible = true;
    // big juice — flash, shake, layered shockwaves, and an instant coin burst
    this.danger.alpha = 0;
    this.flash.tint = C.green; this.flash.alpha = mega ? 0.5 : big ? 0.38 : 0.26;
    this._shake = mega ? 28 : big ? 17 : 10;
    this._shockwave(C.green, 560); if (big) this._shockwave(C.gold, 760); if (mega) this._shockwave(C.magenta, 1000);
    const burst = mega ? 40 : big ? 26 : 16;
    for (let i = 0; i < burst; i++) this._spawnCoin();
  };
  PressureRenderer.prototype.pop = function () {
    this.flash.tint = C.white; this.flash.alpha = 1.0; this._shake = 30;
    this.danger.alpha = 0.8;
    this._shockwave(C.white, 900); this._shockwave(C.red, 620);
    const n = 150;
    for (let i = 0; i < n; i++) {
      const g = new PIXI.Graphics();
      const col = [C.gold, C.cyan, C.magenta, C.red, C.white, C.balloon][i % 6];
      const sz = 3 + (Math.random() * 6 | 0);
      g.beginFill(col).drawRect(-sz / 2, -sz / 2, sz, sz).endFill();
      g.position.set(this.cx, this.cy); this.fx.addChild(g);
      const ang = Math.random() * Math.PI * 2, spd = 140 + Math.random() * 560;
      this._particles.push({ g, x: this.cx, y: this.cy, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 140, vr: (Math.random() - 0.5) * 18, life: 0.9 + Math.random() * 0.8 });
    }
  };
  PressureRenderer.prototype._spawnCoin = function () {
    const g = new PIXI.Graphics();
    const r = 12 + Math.random() * 4;
    g.beginFill(C.gold).drawCircle(0, 0, r).endFill();
    g.beginFill(0xffec9e).drawCircle(-r * 0.25, -r * 0.3, r * 0.42).endFill();
    g.blendMode = PIXI.BLEND_MODES.ADD; this.fxAdd.addChild(g);
    // fly up from a wide spread toward the score, with a little arc
    this._coins.push({ g, x0: this.cx + (Math.random() - 0.5) * this.W * 0.7, y0: this.H * (0.55 + Math.random() * 0.4), x1: this.cx + (Math.random() - 0.5) * 60, y1: this.H * 0.135, t: 0, dur: 0.55 + Math.random() * 0.5 });
  };
  PressureRenderer.prototype._floatText = function (txt, col) {
    const t = new PIXI.Text(txt, { fontFamily: '"Bungee",monospace', fontSize: 26, fill: col, dropShadow: true, dropShadowColor: 0x000000, dropShadowBlur: 6, dropShadowDistance: 0 });
    t.anchor.set(0.5); t.position.set(this.cx, this.cy); this.fx.addChild(t);
    this._floats.push({ g: t, life: 1.1 });
  };
  PressureRenderer.prototype.showReceipt = function (text, nearMiss) { this.receipt.text = text; this.receipt.style.fill = nearMiss ? C.gold : C.muted; this.receipt.alpha = 1; };
  PressureRenderer.prototype.reset = function () {
    this._mult = 1; this._progress = 0; this._rings = []; this.setLockedText(0);
    this.multText.text = "1.00x"; this.multText.style.fill = C.white; this.multText.scale.set(1);
    this.flash.alpha = 0; this._shake = 0; this.danger.alpha = 0;
    this._winFx = null;
    if (this.winAmt) { this.winAmt.visible = false; this.winAmt.alpha = 0; this.winAmt.scale.set(1); }
    if (this.winBanner) { this.winBanner.visible = false; this.winBanner.alpha = 0; this.winBanner.scale.set(1); this.winBanner.rotation = 0; }
    this._genCracks(); this.setState("armed");
  };

  root.PressureRenderer = PressureRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
