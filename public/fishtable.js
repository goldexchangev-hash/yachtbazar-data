/* ============================================================
   fishtable.js — "REEF RAIDERS": an arcade fish-shooter (Fu-Fish / Ocean King
   style) rendered with PixiJS v7 into the TV. Aim the cannon, shoot fish, catch
   them for coins. Procedural art only (no external assets): fish/turtle/shark/
   coin/turret are drawn with Pixi Graphics + Canvas gradients and baked to
   textures once. Money + odds live in FishTableEngine (RTP, provably-fair-ready).

   Host bridge mirrors PressureGame/Slots3D:
     new FishTable({ mount, els, width, height, ethUsd, initialBalance,
                     onBalance, onWin })
   Public: setActive, setEnabled, setBalance, setEthUsd, setMode,
           setBet, setPower, toggleAuto, toggleLock
   ============================================================ */
(function (root) {
  "use strict";
  const PIXI = root.PIXI, E = root.FishTableEngine;
  const MIN_BET = 1, MAX_POWER = 7;

  /* ---------- small helpers ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  function hex(n) { return "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6); }
  function lightenHex(n, amt) { const r = Math.min(255, (n >> 16 & 255) + amt), g = Math.min(255, (n >> 8 & 255) + amt), b = Math.min(255, (n & 255) + amt); return (r << 16) | (g << 8) | b; }
  function darkenHex(n, amt) { const r = Math.max(0, (n >> 16 & 255) - amt), g = Math.max(0, (n >> 8 & 255) - amt), b = Math.max(0, (n & 255) - amt); return (r << 16) | (g << 8) | b; }

  /* ---------- procedural texture factory (baked once) ---------- */
  function TexFactory(app) { this.app = app; this.cache = {}; }
  TexFactory.prototype._bake = function (key, w, h, draw) {
    if (this.cache[key]) return this.cache[key];
    const g = new PIXI.Graphics(); draw(g);
    const tex = this.app.renderer.generateTexture(g, { resolution: 2, region: new PIXI.Rectangle(0, 0, w, h) });
    g.destroy(); this.cache[key] = tex; return tex;
  };
  // a fish drawn into a w×h box, swimming to the RIGHT (we flip via scale.x for left-movers)
  TexFactory.prototype.fish = function (f) {
    const R = f.r, W = R * 3.2, H = R * 2.2, cx = W * 0.46, cy = H / 2;
    return this._bake("fish_" + f.key, W, H, (g) => {
      const body = f.color, dark = darkenHex(body, 70), lite = lightenHex(body, 70);
      // ── bonus-trigger creatures get distinctive, instantly-readable shapes ──
      if (f.key === "crab") { // GOLD CRAB → Fortune Wheel
        g.beginFill(0x7a4a00); for (const s of [-1, 1]) for (let i = 0; i < 4; i++) { const lx = cx + s * R * (0.5 + i * 0.28), ly = cy + R * 0.3; g.lineStyle(R * 0.12, 0xffd23f); g.moveTo(cx + s * R * 0.5, cy); g.lineTo(lx, ly); g.lineTo(lx + s * R * 0.18, ly + R * 0.4); } g.lineStyle(0);
        // claws
        for (const s of [-1, 1]) { g.beginFill(0xffd23f); g.drawEllipse(cx + s * R * 1.15, cy - R * 0.2, R * 0.42, R * 0.3); g.endFill(); g.beginFill(0x7a4a00); g.drawEllipse(cx + s * R * 1.25, cy - R * 0.28, R * 0.18, R * 0.12); g.endFill(); }
        // carapace
        g.lineStyle(0); g.beginFill(0xffd23f); g.drawEllipse(cx, cy, R * 1.05, R * 0.78); g.endFill();
        g.beginFill(lightenHex(0xffd23f, 50), 0.6); g.drawEllipse(cx, cy - R * 0.2, R * 0.7, R * 0.34); g.endFill();
        g.lineStyle(R * 0.08, 0x7a4a00, 0.7); g.moveTo(cx - R * 0.7, cy); g.lineTo(cx + R * 0.7, cy); g.lineStyle(0);
        for (const s of [-1, 1]) { g.beginFill(0x10202c); g.drawCircle(cx + s * R * 0.32, cy - R * 0.42, R * 0.12); g.endFill(); g.beginFill(0xffffff); g.drawCircle(cx + s * R * 0.34, cy - R * 0.46, R * 0.04); g.endFill(); }
        return;
      }
      if (f.key === "clam") { // TREASURE CLAM → Feeding Frenzy
        // bottom shell
        g.beginFill(0xff8ad0); g.moveTo(cx - R * 1.05, cy + R * 0.1); g.quadraticCurveTo(cx, cy + R * 0.95, cx + R * 1.05, cy + R * 0.1); g.lineTo(cx - R * 1.05, cy + R * 0.1); g.endFill();
        g.lineStyle(R * 0.06, 0x6e1f56, 0.6); for (let i = -2; i <= 2; i++) { g.moveTo(cx, cy + R * 0.1); g.lineTo(cx + i * R * 0.42, cy + R * 0.8); } g.lineStyle(0);
        // pearl
        g.beginFill(0xffffff); g.drawCircle(cx, cy + R * 0.12, R * 0.34); g.endFill();
        g.beginFill(0xbfe0ff, 0.8); g.drawCircle(cx - R * 0.1, cy + R * 0.02, R * 0.12); g.endFill();
        // top shell (open)
        g.beginFill(lightenHex(0xff8ad0, 40)); g.moveTo(cx - R * 1.05, cy + R * 0.1); g.quadraticCurveTo(cx, cy - R * 0.95, cx + R * 1.05, cy + R * 0.1); g.lineTo(cx - R * 1.05, cy + R * 0.1); g.endFill();
        g.lineStyle(R * 0.06, 0x6e1f56, 0.6); for (let i = -2; i <= 2; i++) { g.moveTo(cx, cy + R * 0.1); g.lineTo(cx + i * R * 0.42, cy - R * 0.7); } g.lineStyle(0);
        g.beginFill(0xfff3c0, 0.9); g.drawCircle(cx - R * 0.2, cy - R * 0.3, R * 0.05); g.drawCircle(cx + R * 0.3, cy - R * 0.45, R * 0.04); g.endFill();
        return;
      }
      const eye = (ex, ey, er) => { g.lineStyle(0); g.beginFill(0xffffff); g.drawCircle(ex, ey, er); g.endFill(); g.beginFill(0x101018); g.drawCircle(ex + er * 0.25, ey, er * 0.5); g.endFill(); g.beginFill(0xffffff, 0.9); g.drawCircle(ex - er * 0.2, ey - er * 0.3, er * 0.22); g.endFill(); };
      if (f.key === "shark" || f.key === "kraken") {
        // ── SHARK / boss: torpedo body, tall dorsal, crescent tail, teeth ──
        g.beginFill(dark); g.moveTo(cx - R * 0.95, cy); g.lineTo(cx - R * 1.85, cy - R * 0.95); g.quadraticCurveTo(cx - R * 1.2, cy, cx - R * 1.85, cy + R * 0.95); g.closePath(); g.endFill(); // crescent tail
        g.beginFill(dark, 0.95); g.moveTo(cx - R * 0.1, cy + R * 0.35); g.lineTo(cx + R * 0.15, cy + R * 1.2); g.lineTo(cx + R * 0.6, cy + R * 0.5); g.closePath(); g.endFill(); // pectoral
        g.beginFill(dark); g.moveTo(cx - R * 0.35, cy - R * 0.5); g.lineTo(cx + R * 0.1, cy - R * 1.45); g.lineTo(cx + R * 0.5, cy - R * 0.45); g.closePath(); g.endFill(); // dorsal
        g.beginFill(body); g.moveTo(cx - R * 0.9, cy - R * 0.5); g.quadraticCurveTo(cx + R * 1.0, cy - R * 0.62, cx + R * 1.45, cy); g.quadraticCurveTo(cx + R * 1.0, cy + R * 0.62, cx - R * 0.9, cy + R * 0.5); g.quadraticCurveTo(cx - R * 1.12, cy, cx - R * 0.9, cy - R * 0.5); g.endFill();
        g.beginFill(lite, 0.5); g.moveTo(cx - R * 0.8, cy + R * 0.12); g.quadraticCurveTo(cx + R * 0.9, cy + R * 0.5, cx + R * 1.3, cy + R * 0.12); g.quadraticCurveTo(cx + R * 0.4, cy + R * 0.62, cx - R * 0.8, cy + R * 0.4); g.closePath(); g.endFill();
        g.lineStyle(R * 0.05, dark, 0.5); for (let i = 0; i < 3; i++) { g.moveTo(cx + R * (0.45 - i * 0.16), cy - R * 0.28); g.lineTo(cx + R * (0.5 - i * 0.16), cy + R * 0.28); } g.lineStyle(0);
        g.lineStyle(R * 0.06, 0x10202c, 0.85); g.moveTo(cx + R * 0.65, cy + R * 0.3); g.lineTo(cx + R * 1.32, cy + R * 0.18); g.lineStyle(0);
        g.beginFill(0xffffff); for (let i = 0; i < 4; i++) { const tx = cx + R * (0.78 + i * 0.13); g.moveTo(tx, cy + R * 0.27); g.lineTo(tx + R * 0.06, cy + R * 0.42); g.lineTo(tx + R * 0.12, cy + R * 0.27); g.closePath(); } g.endFill();
        eye(cx + R * 0.85, cy - R * 0.16, R * 0.15); g.beginFill(0xe23b3b, 0.45); g.drawCircle(cx + R * 0.85, cy - R * 0.16, R * 0.16); g.endFill();
        return;
      }
      if (f.key === "turtle") {
        // ── TURTLE: domed hex shell + four flippers + head ──
        g.beginFill(darkenHex(body, 40)); for (const s of [[-0.75, 0.45], [0.75, 0.45], [-0.55, -0.45], [0.85, -0.3]]) g.drawEllipse(cx + s[0] * R, cy + s[1] * R, R * 0.42, R * 0.26); g.endFill();
        g.beginFill(lightenHex(body, 20)); g.drawEllipse(cx + R * 1.12, cy, R * 0.34, R * 0.28); g.endFill();
        g.beginFill(0x10202c); g.drawCircle(cx + R * 1.22, cy - R * 0.05, R * 0.07); g.endFill();
        g.beginFill(darkenHex(body, 35)); g.drawEllipse(cx, cy, R * 1.06, R * 0.86); g.endFill();
        g.beginFill(body); g.drawEllipse(cx, cy - R * 0.04, R * 0.92, R * 0.72); g.endFill();
        g.lineStyle(R * 0.05, darkenHex(body, 65), 0.7); g.drawCircle(cx, cy, R * 0.32); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; g.drawCircle(cx + Math.cos(a) * R * 0.58, cy + Math.sin(a) * R * 0.46, R * 0.2); } g.lineStyle(0);
        g.beginFill(lite, 0.4); g.drawEllipse(cx - R * 0.22, cy - R * 0.3, R * 0.4, R * 0.2); g.endFill();
        return;
      }
      // ── GENERIC FISH: tail + dorsal/pelvic fins + three-zone body ──
      g.beginFill(dark); g.moveTo(cx - R * 1.0, cy); g.lineTo(cx - R * 1.7, cy - R * 0.72); g.quadraticCurveTo(cx - R * 1.28, cy, cx - R * 1.7, cy + R * 0.72); g.closePath(); g.endFill();
      g.beginFill(dark, 0.95); g.moveTo(cx - R * 0.2, cy - R * 0.72); g.lineTo(cx + R * 0.45, cy - R * 1.2); g.lineTo(cx + R * 0.55, cy - R * 0.55); g.closePath(); g.endFill();
      g.beginFill(dark, 0.9); g.moveTo(cx - R * 0.1, cy + R * 0.68); g.lineTo(cx + R * 0.35, cy + R * 1.1); g.lineTo(cx + R * 0.5, cy + R * 0.52); g.closePath(); g.endFill();
      g.beginFill(body); g.drawEllipse(cx, cy, R * 1.18, R * 0.84); g.endFill();
      g.beginFill(lite, 0.55); g.drawEllipse(cx + R * 0.2, cy - R * 0.3, R * 0.85, R * 0.36); g.endFill();
      g.beginFill(dark, 0.35); g.drawEllipse(cx, cy + R * 0.4, R * 0.98, R * 0.3); g.endFill();
      g.lineStyle(Math.max(2, R * 0.13), f.accent, 0.8); for (const o of [-0.35, 0, 0.35]) { g.moveTo(cx + o * R - R * 0.1, cy - R * 0.52); g.quadraticCurveTo(cx + o * R + R * 0.14, cy, cx + o * R - R * 0.1, cy + R * 0.52); } g.lineStyle(0);
      eye(cx + R * 0.74, cy - R * 0.12, R * 0.2);
    });
  };
  TexFactory.prototype.glow = function (key, color, size) {
    return this._bake("glow_" + key, size, size, (g) => {
      const steps = 6, c = size / 2;
      for (let i = steps; i >= 1; i--) { g.beginFill(color, 0.12); g.drawCircle(c, c, (c) * (i / steps)); g.endFill(); }
    });
  };
  TexFactory.prototype.bullet = function (color) {
    return this._bake("bullet_" + color, 22, 22, (g) => {
      g.beginFill(color, 0.35); g.drawCircle(11, 11, 11); g.endFill();
      g.beginFill(lightenHex(color, 90)); g.drawCircle(11, 11, 5.5); g.endFill();
      g.beginFill(0xffffff, 0.95); g.drawCircle(9, 9, 2.4); g.endFill();
    });
  };
  TexFactory.prototype.coin = function () {
    return this._bake("coin", 26, 26, (g) => {
      g.beginFill(0xb8860b); g.drawCircle(13, 13, 12); g.endFill();
      g.beginFill(0xffd23f); g.drawCircle(13, 13, 10); g.endFill();
      g.beginFill(0xfff3c4); g.drawCircle(10, 10, 4); g.endFill();
      g.lineStyle(1.5, 0xfff3c4, 0.8); g.drawCircle(13, 13, 7);
    });
  };
  TexFactory.prototype.bubble = function () {
    return this._bake("bubble", 20, 20, (g) => {
      g.lineStyle(1.5, 0xbfe0ff, 0.6); g.drawCircle(10, 10, 8);
      g.beginFill(0xffffff, 0.5); g.drawCircle(7, 7, 2.2); g.endFill();
    });
  };
  TexFactory.prototype.ring = function () {
    return this._bake("ring", 64, 64, (g) => { g.lineStyle(6, 0xffffff, 1); g.drawCircle(32, 32, 26); });
  };
  // rotating god-ray burst for the jackpot takeover
  TexFactory.prototype.rays = function () {
    return this._bake("rays", 600, 600, (g) => {
      const c = 300, N = 18;
      for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; g.beginFill(0xffe89a, i % 2 ? 0.2 : 0.1); g.moveTo(c, c); g.lineTo(c + Math.cos(a - 0.05) * 300, c + Math.sin(a - 0.05) * 300); g.lineTo(c + Math.cos(a + 0.05) * 300, c + Math.sin(a + 0.05) * 300); g.closePath(); g.endFill(); }
    });
  };
  // an actual catch-net: radial spokes crossed by concentric arcs
  TexFactory.prototype.net = function () {
    return this._bake("net", 100, 100, (g) => {
      const c = 50; g.lineStyle(2.4, 0xffffff, 0.9);
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; g.moveTo(c, c); g.lineTo(c + Math.cos(a) * 44, c + Math.sin(a) * 44); }
      for (const r of [16, 28, 40]) g.drawCircle(c, c, r);
    });
  };

  /* ============================ the game ============================ */
  function FishTable(opts) {
    this.els = opts.els || {};
    this.mount = opts.mount;
    this.W = opts.width || 900; this.H = opts.height || 600;
    this.ethUsd = opts.ethUsd || 3400;
    this.onBalance = opts.onBalance || null;
    this.onWin = opts.onWin || null;
    this.balance = opts.initialBalance != null ? opts.initialBalance : 5000;
    this.unitBet = MIN_BET; this.power = 1;
    this._active = false; this._enabled = true;
    this.auto = false; this.lock = false;
    this.engine = E.create();
    this.serverSeed = this.engine.serverSeed; this.commitHash = this.engine.commitHash;

    this.fish = []; this.bullets = []; this.coins = []; this.bubbles = []; this.fx = [];
    this._spawnT = 0; this._fireCd = 0; this._t = 0; this._shake = 0; this._jackpot = 0; this._won = 0; this._combo = 0; this._comboT = 0;
    this._sesSpent = 0; this._sesWon = 0; this._sesBuyIn = 0; // session money-flow tracker (so the credits flow is visible)
    this._frenzy = 0; this._frenzyMax = 0; this._frenzyWon = 0; this._chest = null; this._jpFx = null;
    this._jackpotPool = 0; // progressive jackpot: 5% of every paid shot accrues here and is paid out when the meter pops (self-budgeting)
    this._aim = -Math.PI / 2; this._barrelAng = -Math.PI / 2;

    this._initPixi();
    this._buildScene();
    this._wire();
    this._renderHud();
  }

  FishTable.prototype._initPixi = function () {
    const app = new PIXI.Application({
      width: this.W, height: this.H, backgroundColor: 0x041326, antialias: true,
      resolution: Math.min(1.75, root.devicePixelRatio || 1), autoDensity: true,
    });
    this.app = app; this.view = app.view;
    app.view.style.width = "100%"; app.view.style.height = "100%"; app.view.style.display = "block"; app.view.style.touchAction = "none";
    if (this.mount) this.mount.appendChild(app.view);
    this.tex = new TexFactory(app);
    app.ticker.autoStart = false; app.ticker.stop();
    this._tick = (() => this._frame(Math.min(0.05, app.ticker.deltaMS / 1000))); app.ticker.add(this._tick);
  };

  FishTable.prototype._buildScene = function () {
    const app = this.app, W = this.W, H = this.H;
    // ── background: deep water gradient + caustic rays + floor ──
    const bgC = document.createElement("canvas"); bgC.width = W; bgC.height = H; const bx = bgC.getContext("2d");
    const grad = bx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#0a3a63"); grad.addColorStop(0.45, "#072b4d"); grad.addColorStop(0.8, "#04162c"); grad.addColorStop(1, "#020b18");
    bx.fillStyle = grad; bx.fillRect(0, 0, W, H);
    // surface shimmer
    bx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 7; i++) { bx.save(); bx.translate(W * (0.1 + i * 0.13), -40); bx.rotate(0.22); const lg = bx.createLinearGradient(0, 0, 0, H * 1.1); lg.addColorStop(0, "rgba(120,210,255,0.10)"); lg.addColorStop(1, "rgba(0,0,0,0)"); bx.fillStyle = lg; bx.fillRect(-30, 0, 60, H * 1.1); bx.restore(); }
    bx.globalCompositeOperation = "source-over";
    const bg = new PIXI.Sprite(PIXI.Texture.from(bgC)); app.stage.addChild(bg);

    // moving caustic overlay (additive, slow drift)
    this.causticLayer = new PIXI.Container(); this.causticLayer.blendMode = PIXI.BLEND_MODES.ADD; app.stage.addChild(this.causticLayer);
    const cg = this.tex.glow("caustic", 0x6fd2ff, 220);
    for (let i = 0; i < 5; i++) { const s = new PIXI.Sprite(cg); s.anchor.set(0.5); s.alpha = 0.10; s.x = rand(0, W); s.y = rand(0, H * 0.6); s.scale.set(rand(1.4, 2.6)); s._vx = rand(-6, 6); this.causticLayer.addChild(s); }

    // ── seabed: coral + seaweed silhouettes ──
    const floor = new PIXI.Graphics(); floor.beginFill(0x05223a, 0.9); floor.drawRect(0, H - 46, W, 46); floor.endFill();
    floor.beginFill(0x07304f, 0.8); for (let i = 0; i < 9; i++) { const x = i * (W / 8), r = rand(26, 60); floor.drawEllipse(x, H - 40, r, r * 0.5); } app.stage.addChild(floor);
    this.weeds = new PIXI.Container(); app.stage.addChild(this.weeds);
    for (let i = 0; i < 7; i++) { const wd = new PIXI.Graphics(); const col = [0x0f7a52, 0x0c6e6e, 0x12603a][i % 3]; wd.beginFill(col, 0.85); const bx2 = rand(20, W - 20), bh = rand(60, 130); wd.drawEllipse(0, 0, 9, bh / 2); wd.endFill(); wd.x = bx2; wd.y = H - 40 - bh / 2; wd._phase = rand(0, 6.28); wd._amp = rand(0.04, 0.1); this.weeds.addChild(wd); }

    // ── layers ──
    this.bubbleLayer = new PIXI.ParticleContainer(220, { position: true, scale: true, alpha: true }); app.stage.addChild(this.bubbleLayer);
    this.fishLayer = new PIXI.Container(); app.stage.addChild(this.fishLayer);
    this.bulletLayer = new PIXI.Container(); app.stage.addChild(this.bulletLayer);
    this.fxLayer = new PIXI.Container(); app.stage.addChild(this.fxLayer);
    // full-screen flash overlay for impactful moments (catches/jackpot/chest)
    this._flash = new PIXI.Sprite(PIXI.Texture.WHITE); this._flash.width = W; this._flash.height = H; this._flash.alpha = 0; this._flash.blendMode = PIXI.BLEND_MODES.ADD; app.stage.addChild(this._flash);

    // ── cannon / turret at bottom center ──
    this.cannon = new PIXI.Container(); this.cannon.x = W / 2; this.cannon.y = H - 24; app.stage.addChild(this.cannon);
    const base = new PIXI.Graphics();
    base.beginFill(0x123a5c); base.drawCircle(0, 14, 46); base.endFill();
    base.beginFill(0x1d5a86); base.drawCircle(0, 8, 34); base.endFill();
    base.lineStyle(3, 0x39e7ff, 0.8); base.drawCircle(0, 8, 34); base.lineStyle(0);
    base.beginFill(0x0c2840); base.drawCircle(0, 6, 22); base.endFill();
    this.cannon.addChild(base);
    this.barrel = new PIXI.Graphics();
    this.barrel.beginFill(0x2a6f9e); this.barrel.drawRoundedRect(-12, -54, 24, 60, 8); this.barrel.endFill();
    this.barrel.beginFill(0x3f93c9); this.barrel.drawRoundedRect(-8, -54, 16, 50, 6); this.barrel.endFill();
    this.barrel.beginFill(0xffd23f); this.barrel.drawCircle(0, -52, 7); this.barrel.endFill();
    this.barrel.lineStyle(2, 0x9be8ff, 0.8); this.barrel.drawCircle(0, -52, 7);
    this.cannon.addChild(this.barrel);
    const hub = new PIXI.Graphics(); hub.beginFill(0x1d5a86); hub.drawCircle(0, 6, 14); hub.endFill(); hub.beginFill(0xffd23f); hub.drawCircle(0, 6, 5); hub.endFill(); this.cannon.addChild(hub);

    // reticle
    this.reticle = new PIXI.Graphics(); this.reticle.lineStyle(2, 0xff5d72, 0.85); this.reticle.drawCircle(0, 0, 16); this.reticle.moveTo(-22, 0); this.reticle.lineTo(-8, 0); this.reticle.moveTo(8, 0); this.reticle.lineTo(22, 0); this.reticle.moveTo(0, -22); this.reticle.lineTo(0, -8); this.reticle.moveTo(0, 8); this.reticle.lineTo(0, 22); this.reticle.visible = false; this.fxLayer.addChild(this.reticle);

    // ── in-canvas HUD ──
    // depth vignette — darken the edges so the tank feels deep (center stays clear)
    const vC = document.createElement("canvas"); vC.width = W; vC.height = H; const vx = vC.getContext("2d");
    const vg = vx.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.max(W, H) * 0.7);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(0.7, "rgba(2,8,18,0.18)"); vg.addColorStop(1, "rgba(1,5,12,0.62)");
    vx.fillStyle = vg; vx.fillRect(0, 0, W, H);
    const vign = new PIXI.Sprite(PIXI.Texture.from(vC)); app.stage.addChild(vign);

    this._buildHud();
    // initial bubbles
    for (let i = 0; i < 26; i++) { this._spawnBubble(true); }
    app.renderer.render(app.stage);
  };

  FishTable.prototype._buildHud = function () {
    const W = this.W, H = this.H;
    this.hud = new PIXI.Container(); this.app.stage.addChild(this.hud);
    const mk = (size, fill, weight) => new PIXI.Text("", { fontFamily: "Bungee, Arial", fontSize: size, fontWeight: weight || "700", fill: fill, stroke: 0x041326, strokeThickness: size * 0.14 });
    // jackpot meter (top center)
    this.jpBar = new PIXI.Graphics(); this.hud.addChild(this.jpBar);
    this.jpText = mk(16, 0xffd23f); this.jpText.anchor.set(0.5, 0); this.jpText.x = W / 2; this.jpText.y = 30; this.hud.addChild(this.jpText);
    // session money-flow readout (top, own line above the meter): makes the credits flow visible
    this.sesText = mk(12, 0xbfe0ff); this.sesText.anchor.set(0.5, 0); this.sesText.x = W / 2; this.sesText.y = 9; this.hud.addChild(this.sesText);
    // balance (bottom-left) + win (bottom-right)
    this.balText = mk(20, 0x9be8ff); this.balText.x = 14; this.balText.y = H - 30; this.hud.addChild(this.balText);
    this.winText = mk(20, 0x45f0a6); this.winText.anchor.set(1, 0); this.winText.x = W - 14; this.winText.y = H - 30; this.hud.addChild(this.winText);
    // power + cost (above cannon)
    this.powText = mk(15, 0xffe08a); this.powText.anchor.set(0.5, 1); this.powText.x = W / 2; this.powText.y = H - 70; this.hud.addChild(this.powText);
    // big-catch banner (center)
    this.banner = mk(46, 0xffd23f); this.banner.anchor.set(0.5); this.banner.x = W / 2; this.banner.y = H * 0.4; this.banner.alpha = 0; this.hud.addChild(this.banner);
    this.bannerSub = mk(24, 0xffffff); this.bannerSub.anchor.set(0.5); this.bannerSub.x = W / 2; this.bannerSub.y = H * 0.4 + 38; this.bannerSub.alpha = 0; this.hud.addChild(this.bannerSub);
    // mode pills (autofire / lock) bottom area
    this.modeText = mk(13, 0x9be8ff); this.modeText.anchor.set(0.5, 1); this.modeText.x = W / 2; this.modeText.y = H - 90; this.hud.addChild(this.modeText);
  };

  /* ---------- spawning ---------- */
  FishTable.prototype._spawnBubble = function (anywhere) {
    const s = new PIXI.Sprite(this.tex.bubble()); s.anchor.set(0.5);
    s.x = rand(0, this.W); s.y = anywhere ? rand(0, this.H) : this.H + 10;
    const sc = rand(0.3, 1); s.scale.set(sc); s.alpha = rand(0.3, 0.7);
    this.bubbleLayer.addChild(s); this.bubbles.push({ s, vy: rand(18, 46), wob: rand(0.5, 1.4), ph: rand(0, 6.28) });
  };
  FishTable.prototype._spawnFish = function (forceType) {
    if (this.fish.length > 18) return;
    const def = forceType || this.engine.pickFish();
    const slow = def.tier === "boss" ? 0.55 : 1;
    // Choose an entry edge. Most fish swim horizontally but now span the FULL height
    // (right down to the very bottom) so even flat/low shots meet a target. ~22% enter
    // from the top or bottom edge and swim vertically across the field, so shots fired
    // straight up — or skimming the floor — always have something to hit.
    const c = new PIXI.Container();
    const sp = new PIXI.Sprite(this.tex.fish(def)); sp.anchor.set(0.46, 0.5); c.addChild(sp);
    if (def.special) { const gl = new PIXI.Sprite(this.tex.glow(def.key, def.color, def.r * 5)); gl.anchor.set(0.5); gl.alpha = 0.5; gl.blendMode = PIXI.BLEND_MODES.ADD; c.addChildAt(gl, 0); }
    const lbl = new PIXI.Text("x" + def.mult, { fontFamily: "Bungee, Arial", fontSize: Math.max(12, def.r * 0.6), fontWeight: "700", fill: 0xffffff, stroke: 0x041326, strokeThickness: 3 });
    lbl.anchor.set(0.5); lbl.y = def.r * 1.05; lbl.alpha = 0.85; c.addChild(lbl);

    const roll = Math.random();
    let f;
    if (roll < 0.78) {
      // horizontal swimmer — full vertical span, including the very bottom band
      const fromLeft = Math.random() < 0.5, dir = fromLeft ? 1 : -1;
      const y = rand(30, this.H - 40);
      sp.scale.x = dir;
      c.x = fromLeft ? -def.r * 2 : this.W + def.r * 2; c.y = y;
      f = { def, c, sp, mode: "h", dir, vx: dir * rand(40, 90) * slow, vy: 0, baseY: y, bobAmp: rand(6, 20), bobSpd: rand(0.6, 1.6), ph: rand(0, 6.28), r: def.r, alive: true, flinch: 0 };
    } else {
      // vertical swimmer — enters from the top or bottom edge, drifts sideways slightly
      const fromTop = Math.random() < 0.5, vdir = fromTop ? 1 : -1;
      const x = rand(48, this.W - 48);
      sp.scale.x = 1;
      c.x = x; c.y = fromTop ? -def.r * 2 : this.H + def.r * 2;
      const drift = rand(-28, 28);
      f = { def, c, sp, mode: "v", dir: drift >= 0 ? 1 : -1, vx: drift, vy: vdir * rand(45, 80) * slow, baseX: x, bobAmp: rand(6, 18), bobSpd: rand(0.6, 1.5), ph: rand(0, 6.28), r: def.r, alive: true, flinch: 0 };
    }
    this.fishLayer.addChild(c);
    this.fish.push(f);
  };

  /* ---------- firing ---------- */
  FishTable.prototype.cost = function () { return Math.round(this.unitBet * this.power * 100) / 100; };
  FishTable.prototype._fire = function () {
    if (!this._active || !this._enabled) return;
    // Feeding Frenzy = FREE shots (it's a bonus reward) — never charge during it.
    const free = this._frenzy > 0;
    const cost = free ? 0 : this.cost();
    if (!free && this.balance < cost) { this._flashBanner("INSUFFICIENT", "add funds 👇", 0xff5d72); return; }
    if (cost > 0) { this.balance = Math.round((this.balance - cost) * 100) / 100; this._sesSpent = Math.round((this._sesSpent + cost) * 100) / 100; this._jackpotPool = Math.round((this._jackpotPool + cost * 0.05) * 100) / 100; this._save(); this._renderHud(); }
    const ang = this._aim;
    const tipX = this.cannon.x + Math.cos(ang) * 54, tipY = this.cannon.y + Math.sin(ang) * 54;
    const col = this.power >= 5 ? 0xff4d9d : this.power >= 3 ? 0xffd23f : 0x39e7ff;
    const sp = new PIXI.Sprite(this.tex.bullet(col)); sp.anchor.set(0.5); sp.x = tipX; sp.y = tipY; sp.rotation = ang + Math.PI / 2;
    const sc = 0.8 + this.power * 0.12; sp.scale.set(sc, sc * 1.7); // streak along travel
    this.bulletLayer.addChild(sp);
    const speed = 620 + this.power * 30;
    // cap live bullets so the now-long-lived ricochets can't pile up
    while (this.bullets.length > 38) { const old = this.bullets.shift(); this.bulletLayer.removeChild(old.s); old.s.destroy(); }
    this.bullets.push({ s: sp, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, r: 7 * sc, col, hit: false, bounces: 0, life: 0 });
    // recoil + muzzle flash
    this._recoil = 8; this._muzzle(tipX, tipY, col);
    if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {}
    this._fireCd = this.auto ? (0.16 - this.power * 0.008) : 0.09;
  };
  FishTable.prototype._muzzle = function (x, y, col) {
    const s = new PIXI.Sprite(this.tex.glow("muzzle", col, 80)); s.anchor.set(0.5); s.x = x; s.y = y; s.blendMode = PIXI.BLEND_MODES.ADD; s.scale.set(0.5); this.fxLayer.addChild(s);
    this.fx.push({ s, t: 0, dur: 0.18, kind: "flash" });
  };

  /* ---------- hit resolution ---------- */
  FishTable.prototype._resolveBulletFish = function (b, fish) {
    b.hit = true;
    const res = this.engine.resolveHit(fish.def.mult, this.power);
    // net splash where it hit
    this._net(b.s.x, b.s.y, fish.def.color);
    if (res.dead) { this._catchFish(fish, this.power); }
    else { fish.flinch = 0.18; fish.sp.tint = 0xff8888; }
  };
  FishTable.prototype._catchFish = function (fish, power, isSplash) {
    if (!fish.alive) return; fish.alive = false;
    const payout = Math.round(fish.def.mult * this.unitBet * 100) / 100;
    this.balance = Math.round((this.balance + payout) * 100) / 100; this._won = payout; this._sesWon = Math.round((this._sesWon + payout) * 100) / 100; this._save(); this._renderHud();
    if (this._frenzy > 0) this._frenzyWon = Math.round((this._frenzyWon + payout) * 100) / 100;
    // combo
    this._combo++; this._comboT = 1.2;
    // FX: net catch ring + coin burst toward balance HUD + floating payout
    this._net(fish.c.x, fish.c.y, fish.def.color, true);
    const coins = clamp(Math.round(fish.def.mult * 1.1) + 5, 6, 64);
    for (let i = 0; i < coins; i++) this._spawnCoin(fish.c.x, fish.c.y);
    this._floatText("+$" + payout.toFixed(2), fish.c.x, fish.c.y - fish.r, fish.def.tier === "boss" ? 0xffd23f : 0x45f0a6);
    // shake scaled to value
    this._shake = Math.max(this._shake, clamp(fish.def.mult / 30, 0.08, 1.2) * 10);
    // tier banners
    if (fish.def.special === "boss") this._flashBanner(fish.def.name.toUpperCase() + "!", "+$" + payout.toFixed(2), 0xffd23f);
    else if (fish.def.mult >= 25) this._flashBanner("BIG CATCH", fish.def.name + "  +$" + payout.toFixed(2), 0xffe08a);
    else if (this._combo >= 4) this._flashBanner("COMBO ×" + this._combo, "", 0x39e7ff);
    // sound
    const C = root.Chiptune; if (C) try { if (fish.def.special === "boss" && C.jackpot) C.jackpot(); else if (fish.def.mult >= 20 && C.bigwin) C.bigwin(); else if (C.coin) C.coin(); } catch (e) {}
    // onWin (profit) callback for big catches
    if (this.onWin && payout >= this.cost() * 8) { try { this.onWin({ profitUsd: payout - this.cost(), mult: fish.def.mult }); } catch (e) {} }
    // JACKPOT METER — fills as you catch (faster at higher power); when it FILLS,
    // the jackpot fires. (Plus a rare surprise roll on any catch.)
    if (!this._jpFx && !this._chest) {
      this._jackpot = clamp(this._jackpot + 0.0022 * power, 0, 1); // slow build → the pool grows big before it pops
      if (this._jackpot >= 1) this._awardJackpot(); // meter full → pay the accumulated progressive pool
    }
    // specials AoE
    if (!isSplash) {
      if (fish.def.special === "bomb") this._bombSplash(fish);
      else if (fish.def.special === "chain") this._eelChain(fish);
    }
    // ── BONUS ROUNDS: catching the right creature triggers a feature ──
    if (!isSplash && fish.def.bonus && !this._chest && this._frenzy <= 0) {
      if (fish.def.bonus === "chest") this._treasureChest();
      else if (fish.def.bonus === "frenzy") this._startFrenzy(6); // trimmed 9s→6s of free fire to keep the house edge
    }
    // death anim
    fish.death = 0;
  };
  FishTable.prototype._bombSplash = function (src) {
    this._explosion(src.c.x, src.c.y, 150, 0xff7a3d);
    this._shake = Math.max(this._shake, 14);
    for (const o of this.fish) {
      if (!o.alive || o === src) continue;
      const d = Math.hypot(o.c.x - src.c.x, o.c.y - src.c.y);
      if (d < 150 + o.r) { const res = this.engine.resolveSplash(o.def.mult, this.power); if (res.dead) this._catchFish(o, this.power, true); else { o.flinch = 0.18; o.sp.tint = 0xffaa66; } }
    }
  };
  FishTable.prototype._eelChain = function (src) {
    const targets = this.fish.filter((o) => o.alive && o !== src).map((o) => ({ o, d: Math.hypot(o.c.x - src.c.x, o.c.y - src.c.y) })).sort((a, b) => a.d - b.d).slice(0, 3);
    let px = src.c.x, py = src.c.y;
    for (const t of targets) { this._lightning(px, py, t.o.c.x, t.o.c.y); px = t.o.c.x; py = t.o.c.y; const res = this.engine.resolveSplash(t.o.def.mult, this.power); if (res.dead) this._catchFish(t.o, this.power, true); else { t.o.flinch = 0.18; t.o.sp.tint = 0xfff15a; } }
  };
  // Pay the PROGRESSIVE jackpot: the pool (5% of every paid shot since the last pop).
  // This is what keeps the jackpot self-budgeting — it returns exactly what it raked.
  FishTable.prototype._awardJackpot = function () {
    const amt = Math.round(this._jackpotPool * 100) / 100;
    this._jackpot = 0;
    if (amt < this.unitBet) return; // nothing meaningful pooled yet — don't fire a $0 spectacle
    this._jackpotPool = 0;
    this.balance = Math.round((this.balance + amt) * 100) / 100; this._won = amt; this._sesWon = Math.round((this._sesWon + amt) * 100) / 100; this._save(); this._renderHud();
    this._startJackpotShow(amt);
    if (this.onWin) try { this.onWin({ profitUsd: amt, bonus: true }); } catch (e) {}
  };
  // ── BIG JACKPOT SPECTACLE: a multi-second screen takeover — rotating god-rays,
  //    a full-screen coin downpour, slam-in banner, count-up, flashes + shakes. ──
  FishTable.prototype._startJackpotShow = function (amt) {
    if (this._jpFx) return;
    const W = this.W, H = this.H;
    const cont = new PIXI.Container(); this.hud.addChild(cont);
    const dim = new PIXI.Graphics(); dim.beginFill(0x06122a, 0.5); dim.drawRect(0, 0, W, H); dim.endFill(); cont.addChild(dim);
    const rays = new PIXI.Sprite(this.tex.rays()); rays.anchor.set(0.5); rays.x = W / 2; rays.y = H * 0.4; rays.blendMode = PIXI.BLEND_MODES.ADD; rays.alpha = 0; cont.addChild(rays);
    const rays2 = new PIXI.Sprite(this.tex.rays()); rays2.anchor.set(0.5); rays2.x = W / 2; rays2.y = H * 0.4; rays2.blendMode = PIXI.BLEND_MODES.ADD; rays2.alpha = 0; rays2.scale.set(1.5); cont.addChild(rays2);
    const halo = new PIXI.Sprite(this.tex.glow("jp", 0xffe89a, 520)); halo.anchor.set(0.5); halo.x = W / 2; halo.y = H * 0.4; halo.blendMode = PIXI.BLEND_MODES.ADD; halo.alpha = 0; cont.addChild(halo);
    const big = new PIXI.Text("💰 JACKPOT! 💰", { fontFamily: "Bungee, Arial", fontSize: Math.min(56, W * 0.07), fontWeight: "700", fill: 0xffd23f, stroke: 0x5e3d12, strokeThickness: 9 }); big.anchor.set(0.5); big.x = W / 2; big.y = H * 0.34; big.alpha = 0; cont.addChild(big);
    const amtT = new PIXI.Text("$0.00", { fontFamily: "Bungee, Arial", fontSize: Math.min(50, W * 0.06), fontWeight: "700", fill: 0xfff3c0, stroke: 0x7a4a00, strokeThickness: 8 }); amtT.anchor.set(0.5); amtT.x = W / 2; amtT.y = H * 0.5; cont.addChild(amtT);
    this._jpFx = { cont, rays, rays2, halo, big, amtT, t: 0, dur: 6.5, amt, shown: 0, coinT: 0, flashAcc: 0 };
    const C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
  };
  FishTable.prototype._updateJackpotShow = function (dt) {
    const j = this._jpFx; if (!j) return; j.t += dt;
    const inK = Math.min(1, j.t / 0.5), outK = j.t > j.dur - 0.9 ? Math.max(0, (j.dur - j.t) / 0.9) : 1;
    j.rays.rotation += dt * 0.5; j.rays2.rotation -= dt * 0.36;
    j.rays.alpha = 0.55 * inK * outK * (0.7 + 0.3 * Math.sin(j.t * 6));
    j.rays2.alpha = 0.34 * inK * outK * (0.7 + 0.3 * Math.cos(j.t * 5));
    j.halo.alpha = 0.5 * inK * outK; j.halo.scale.set(1 + 0.15 * Math.sin(j.t * 3));
    // banner slam-in (easeOutBack) + color cycle + gentle bob
    const sk = Math.min(1, j.t / 0.34), eb = 1 + 2.70158 * Math.pow(sk - 1, 3) + 1.70158 * Math.pow(sk - 1, 2);
    j.big.scale.set(2.5 + (1 - 2.5) * eb);
    j.big.alpha = inK * outK; j.big.y = this.H * 0.34 + Math.sin(j.t * 2.5) * 6;
    j.big.style.fill = (Math.sin(j.t * 9) > 0) ? 0xfff3c0 : 0xffd23f;
    j.amtT.alpha = outK;
    // count up the amount, then keep it punchy
    const ck = Math.min(1, j.t / 2.6); j.shown = j.amt * (1 - Math.pow(1 - ck, 3)); j.amtT.text = this._usd(j.shown);
    j.amtT.scale.set(1 + 0.09 * Math.abs(Math.sin(j.t * 9)));
    // full-screen coin downpour for most of the show
    if (j.t < j.dur - 1.0) { j.coinT -= dt; if (j.coinT <= 0) { j.coinT = 0.028; const n = 2 + (Math.random() * 3 | 0); for (let i = 0; i < n; i++) this._rainCoin(); } }
    // repeated flashes + shake kicks ~3/s
    j.flashAcc += dt; if (j.flashAcc >= 0.33) { j.flashAcc = 0; this._screenFlash(0xffe89a, 0.28); this._shake = Math.max(this._shake || 0, 11); const C = root.Chiptune; if (C && C.coin) try { C.coin(); } catch (e) {} }
    j.cont.alpha = outK;
    if (j.t >= j.dur) { this.hud.removeChild(j.cont); j.cont.destroy({ children: true }); this._jpFx = null; }
  };
  // a coin that pours from the top of the screen and falls (the jackpot downpour)
  FishTable.prototype._rainCoin = function () {
    const s = new PIXI.Sprite(this.tex.coin()); s.anchor.set(0.5); s.x = rand(0, this.W); s.y = -20; const sc = rand(0.6, 1.3); s.scale.set(sc); this.fxLayer.addChild(s);
    this.coins.push({ s, vx: rand(-30, 30), vy: rand(150, 340), t: 0, life: rand(1.7, 2.8), rain: true, sc });
  };

  /* ---------- BONUS ROUND 1: TREASURE CHEST (Gold Crab) ----------
     The chest drops in, rattles, bursts open, then a string of random prizes
     pop out one-by-one — each adds to your balance with a floating +$ amount,
     totalling up to a grand "TREASURE" payout. */
  FishTable.prototype._treasureChest = function () {
    const cx = this.W / 2, cy = this.H * 0.46, S = Math.min(this.W, this.H) * 0.34;
    const cont = new PIXI.Container(); cont.x = cx; cont.y = cy;
    const dim = new PIXI.Graphics(); dim.beginFill(0x02060f, 0.66); dim.drawRect(-cx, -cy, this.W, this.H); dim.endFill(); cont.addChild(dim);
    // glow behind the chest
    const glow = new PIXI.Sprite(this.tex.glow("chest", 0xffd23f, 420)); glow.anchor.set(0.5); glow.blendMode = PIXI.BLEND_MODES.ADD; glow.alpha = 0; glow.y = -S * 0.1; cont.addChild(glow);
    // chest group (built around its own origin; lid hinges at the back-top)
    const chest = new PIXI.Container(); chest.y = S * 0.1; cont.addChild(chest);
    const W = S, H = S * 0.62;
    const box = new PIXI.Graphics();
    box.beginFill(0x3a2606); box.drawRoundedRect(-W / 2, -H * 0.2, W, H * 0.8, 12); box.endFill();
    box.beginFill(0x6e4a18); box.drawRoundedRect(-W / 2 + 6, -H * 0.2 + 6, W - 12, H * 0.8 - 12, 8); box.endFill();
    for (const bx of [-W * 0.32, W * 0.32]) { box.beginFill(0xffd23f); box.drawRect(bx - 7, -H * 0.2, 14, H * 0.8); box.endFill(); box.beginFill(0xb8860b); box.drawRect(bx - 7, -H * 0.2, 4, H * 0.8); box.endFill(); }
    box.beginFill(0xffd23f); box.drawRoundedRect(-18, H * 0.12, 36, 34, 6); box.endFill(); box.beginFill(0x3a2606); box.drawCircle(0, H * 0.24, 7); box.endFill(); box.drawRect(-3, H * 0.24, 6, 14);
    chest.addChild(box);
    const lid = new PIXI.Graphics();
    lid.beginFill(0x3a2606); lid.moveTo(-W / 2, 0); lid.quadraticCurveTo(0, -H * 0.62, W / 2, 0); lid.lineTo(-W / 2, 0); lid.endFill();
    lid.beginFill(0x6e4a18); lid.moveTo(-W / 2 + 6, -2); lid.quadraticCurveTo(0, -H * 0.55, W / 2 - 6, -2); lid.lineTo(-W / 2 + 6, -2); lid.endFill();
    // gold rim along the lid's front edge (reads cleanly whether closed or open)
    lid.beginFill(0xffd23f); lid.drawRect(-W / 2 + 4, -12, W - 8, 9); lid.endFill();
    lid.beginFill(0xfff3c0, 0.7); lid.drawRect(-W / 2 + 4, -12, W - 8, 3); lid.endFill();
    lid.y = -H * 0.2; lid.pivot.y = 0; chest.addChild(lid); // hinge at lid.y
    const title = new PIXI.Text("🪙 TREASURE CHEST", { fontFamily: "Bungee, Arial", fontSize: 26, fontWeight: "700", fill: 0xffd23f, stroke: 0x041326, strokeThickness: 5 }); title.anchor.set(0.5); title.y = -S * 0.62; cont.addChild(title);
    const totalText = new PIXI.Text("", { fontFamily: "Bungee, Arial", fontSize: 34, fontWeight: "700", fill: 0xfff3c0, stroke: 0x5e3d12, strokeThickness: 6 }); totalText.anchor.set(0.5); totalText.y = S * 0.92; cont.addChild(totalText);
    this.hud.addChild(cont);
    // roll the prize list (weighted small; bigger = rarer)
    const pool = [1, 1, 2, 2, 3, 3, 5, 5, 8, 10, 15]; // trimmed (dropped 25/50) so the chest bonus doesn't blow the house edge
    const n = 4 + (this.engine.next() * 3 | 0); const prizes = [];
    for (let i = 0; i < n; i++) prizes.push(pool[(this.engine.next() * pool.length) | 0]);
    this._chest = { cont, chest, lid, glow, title, totalText, prizes, idx: 0, total: 0, phase: "intro", t: 0, popT: 0 };
    const C = root.Chiptune; if (C && C.swoosh) try { C.swoosh(900); } catch (e) {}
  };
  FishTable.prototype._updateChest = function (dt) {
    const w = this._chest; if (!w) return; w.t += dt;
    if (w.phase === "intro") { // drop + rattle
      const k = Math.min(1, w.t / 0.9); w.cont.alpha = Math.min(1, k * 2);
      w.chest.y = lerp(-this.H * 0.4, this.H * 0.1, 1 - Math.pow(1 - k, 3));
      if (k > 0.6) { w.chest.x = Math.sin(w.t * 50) * 5 * (1 - k) * 6; } // rattle as it settles
      if (k >= 1) { w.chest.x = 0; w.phase = "open"; w.t = 0; this._shake = Math.max(this._shake, 14); const C = root.Chiptune; if (C && C.coin) try { C.coin(); } catch (e) {} }
    } else if (w.phase === "open") { // lid flips up + light burst
      const k = Math.min(1, w.t / 0.45), e = 1 - Math.pow(1 - k, 3);
      w.lid.rotation = -2.2 * e; w.glow.alpha = e * 0.9; w.glow.scale.set(0.5 + e * 0.8);
      if (k >= 1) { w.phase = "pop"; w.t = 0; w.popT = 0; }
    } else if (w.phase === "pop") { // prizes pop out one by one
      w.glow.alpha = 0.6 + 0.2 * Math.sin(w.t * 8);
      w.popT -= dt;
      if (w.popT <= 0 && w.idx < w.prizes.length) {
        w.popT = 0.34;
        const mult = w.prizes[w.idx++]; const amt = Math.round(mult * this.unitBet * 100) / 100;
        w.total = Math.round((w.total + amt) * 100) / 100;
        this.balance = Math.round((this.balance + amt) * 100) / 100; this._won = w.total; this._sesWon = Math.round((this._sesWon + amt) * 100) / 100; this._save(); this._renderHud();
        w.totalText.text = "+$" + w.total.toFixed(2);
        // a coin/gem leaps out of the chest with a floating value
        const px = this.W / 2 + rand(-30, 30), py = this.H * 0.46 - 10;
        for (let c = 0; c < clamp(mult, 3, 18); c++) this._spawnCoin(px, py);
        this._floatText("+$" + amt.toFixed(2), px + rand(-40, 40), py - 30, mult >= 25 ? 0xffd23f : 0x45f0a6);
        this._shake = Math.max(this._shake, clamp(mult / 5, 4, 14));
        const C = root.Chiptune; if (C && C.coin) try { C.coin(); } catch (e) {}
      }
      if (w.idx >= w.prizes.length) { w.phase = "hold"; w.t = 0; w.title.text = "💰 TREASURE  +$" + w.total.toFixed(2);
        this._shake = Math.max(this._shake, 18);
        const C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
        if (this.onWin && w.total > this.cost() * 4) try { this.onWin({ profitUsd: w.total, mult: w.total / Math.max(0.01, this.unitBet), bonus: true }); } catch (e) {}
      }
    } else if (w.phase === "hold") {
      w.glow.alpha = Math.max(0, 0.8 - w.t * 0.5);
      if (w.t > 1.8) { this.hud.removeChild(w.cont); w.cont.destroy({ children: true }); this._chest = null; }
    }
  };

  /* ---------- BONUS ROUND 2: FEEDING FRENZY (Treasure Clam) ---------- */
  FishTable.prototype._startFrenzy = function (dur) {
    if (this._frenzy > 0) return; // never re-arm an active frenzy (would chain free shots)
    this._frenzy = dur; this._frenzyMax = dur; this._frenzyWon = 0;
    this._flashBanner("🌊 FEEDING FRENZY!", "FREE SHOTS — catch everything!", 0x45f0a6);
    // flood the tank with a formation of catchable fish
    const small = E.FISH.filter((f) => f.tier !== "boss" && !f.bonus);
    for (let i = 0; i < 10; i++) setTimeout(() => { if (this._active && this._frenzy > 0) this._spawnFish(small[(Math.random() * small.length) | 0]); }, i * 120);
    const C = root.Chiptune; if (C && C.bigwin) try { C.bigwin(); } catch (e) {}
  };
  FishTable.prototype._updateFrenzy = function (dt) {
    if (this._frenzy <= 0) return;
    this._frenzy -= dt;
    // Cap the free-shot winnings so the frenzy can't blow the house edge: it's a
    // bonus reward, not an open tap. Once it's paid out ~25x the base bet, END it.
    // NB: must set EXACTLY 0 (not a tiny positive) — a positive value pins _frenzy
    // every frame and the "<= 0" end-check below never fires → frenzy stuck ON
    // forever = free shots that never deduct (the auto-fire-stuck / not-charging bug).
    if (this._frenzyWon >= this.unitBet * 25) { this._frenzy = 0; }
    // dense spawns of mostly small/medium fish
    if (Math.random() < dt * 6 && this.fish.length < 26) { const small = E.FISH.filter((f) => f.tier !== "boss" && !f.bonus); this._spawnFish(small[(Math.random() * small.length) | 0]); }
    // frenzy meter bar (reuse jackpot meter area, green)
    if (this._frenzy <= 0) {
      this._frenzy = 0;
      this._flashBanner("FRENZY OVER", this._frenzyWon > 0 ? "+$" + this._frenzyWon.toFixed(2) + " caught!" : "", 0xffd23f);
    }
  };

  /* ---------- FX primitives ---------- */
  FishTable.prototype._net = function (x, y, color, big) {
    const s = new PIXI.Sprite(big ? this.tex.net() : this.tex.ring()); s.anchor.set(0.5); s.x = x; s.y = y; s.tint = big ? 0xffffff : color; s.blendMode = PIXI.BLEND_MODES.ADD; s.scale.set(0.2); this.fxLayer.addChild(s);
    this.fx.push({ s, t: 0, dur: big ? 0.5 : 0.32, kind: "ring", to: big ? 2.6 : 1.4 });
  };
  FishTable.prototype._explosion = function (x, y, radius, color) {
    const s = new PIXI.Sprite(this.tex.glow("boom", color, 200)); s.anchor.set(0.5); s.x = x; s.y = y; s.blendMode = PIXI.BLEND_MODES.ADD; s.scale.set(0.2); this.fxLayer.addChild(s);
    this.fx.push({ s, t: 0, dur: 0.45, kind: "ring", to: radius / 80 });
  };
  FishTable.prototype._lightning = function (x1, y1, x2, y2) {
    const g = new PIXI.Graphics(); g.lineStyle(3, 0xfff15a, 0.95);
    const segs = 6; g.moveTo(x1, y1); for (let i = 1; i < segs; i++) { const t = i / segs; g.lineTo(lerp(x1, x2, t) + rand(-12, 12), lerp(y1, y2, t) + rand(-12, 12)); } g.lineTo(x2, y2);
    g.blendMode = PIXI.BLEND_MODES.ADD; this.fxLayer.addChild(g); this.fx.push({ s: g, t: 0, dur: 0.22, kind: "fade" });
  };
  FishTable.prototype._spawnCoin = function (x, y) {
    const s = new PIXI.Sprite(this.tex.coin()); s.anchor.set(0.5); s.x = x; s.y = y; const sc = rand(0.5, 1); s.scale.set(sc); this.fxLayer.addChild(s);
    const ang = rand(-Math.PI, 0), spd = rand(120, 320);
    this.coins.push({ s, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 80, t: 0, life: rand(0.7, 1.2), targetX: 30, targetY: this.H - 22 });
  };
  FishTable.prototype._floatText = function (txt, x, y, color) {
    const t = new PIXI.Text(txt, { fontFamily: "Bungee, Arial", fontSize: 22, fontWeight: "700", fill: color, stroke: 0x041326, strokeThickness: 4 });
    t.anchor.set(0.5); t.x = x; t.y = y; this.fxLayer.addChild(t); this.fx.push({ s: t, t: 0, dur: 0.9, kind: "float" });
  };
  FishTable.prototype._flashBanner = function (txt, sub, color) {
    this.banner.text = txt; this.banner.style.fill = color; this.banner.alpha = 1; this.banner.scale.set(2.3); // slam in big, settles via easeOutBack
    this.bannerSub.text = sub || ""; this.bannerSub.alpha = sub ? 1 : 0;
    this._bannerT = 0; this._screenFlash(color, 0.18);
  };
  // brief full-screen color flash for impactful moments
  FishTable.prototype._screenFlash = function (color, a) {
    if (!this._flash) return; this._flash.tint = color; this._flash.alpha = Math.max(this._flash.alpha, a);
  };

  /* ---------- per-frame ---------- */
  FishTable.prototype._frame = function (dt) {
    if (!this._active) return;
    this._t += dt;
    // bonus rounds take over
    if (this._chest) this._updateChest(dt);
    if (this._jpFx) this._updateJackpotShow(dt);
    if (this._frenzy > 0) this._updateFrenzy(dt);

    // spawn cadence (suspended during the treasure chest / jackpot show)
    if (!this._chest && !this._jpFx) {
      this._spawnT -= dt;
      if (this._spawnT <= 0) {
        this._spawnT = this._frenzy > 0 ? rand(0.15, 0.4) : rand(0.5, 1.3);
        if (Math.random() < 0.32) { const def = this.engine.pickFish(); const n = 2 + (Math.random() * 4 | 0); for (let i = 0; i < n; i++) setTimeout(() => this._active && this._spawnFish(def), i * 180); }
        else this._spawnFish();
      }
      if (this.fish.length < 5 && Math.random() < 0.4) this._spawnFish();
    }

    // autofire / lock (frenzy auto-fires for non-stop action; wheel pauses firing)
    this._fireCd -= dt;
    if (this.lock) this._autoAim();
    if (!this._chest && !this._jpFx && (this.auto || this._holding || this._frenzy > 0) && this._fireCd <= 0) this._fire();

    // barrel aim easing + recoil
    let da = this._aim - this._barrelAng; da = Math.atan2(Math.sin(da), Math.cos(da));
    this._barrelAng += da * Math.min(1, dt * 14);
    this.barrel.rotation = this._barrelAng + Math.PI / 2;
    this._recoil = (this._recoil || 0) * 0.8; this.barrel.y = this._recoil * 0.0; this.barrel.pivot.y = -this._recoil;

    // fish
    for (let i = this.fish.length - 1; i >= 0; i--) {
      const f = this.fish[i];
      if (!f.alive) {
        f.death += dt; const k = f.death / 0.25; f.c.scale.set(1 + k * 0.4); f.c.alpha = 1 - k; f.c.rotation += dt * 6 * f.dir;
        if (k >= 1) { this.fishLayer.removeChild(f.c); f.c.destroy({ children: true }); this.fish.splice(i, 1); }
        continue;
      }
      if (f.mode === "v") {
        // vertical swimmer: travel up/down, drift sideways with a gentle bob around its lane
        f.c.y += f.vy * dt;
        f.baseX += f.vx * dt;
        f.c.x = f.baseX + Math.sin(this._t * f.bobSpd + f.ph) * f.bobAmp;
      } else {
        f.c.x += f.vx * dt;
        f.c.y = f.baseY + Math.sin(this._t * f.bobSpd + f.ph) * f.bobAmp;
      }
      // swim wiggle (body squash + tail sway via rotation)
      f.sp.scale.y = 1 + Math.sin(this._t * 9 + f.ph) * 0.06;
      f.sp.rotation = Math.sin(this._t * 6 + f.ph) * 0.06 * f.dir;
      if (f.flinch > 0) { f.flinch -= dt; if (f.flinch <= 0) f.sp.tint = 0xffffff; }
      // despawn once fully off the far edge (horizontal: left/right; vertical: top/bottom)
      const off = f.mode === "v"
        ? (f.vy > 0 ? f.c.y > this.H + f.r * 2 : f.c.y < -f.r * 2)
        : (f.dir > 0 ? f.c.x > this.W + f.r * 2 : f.c.x < -f.r * 2);
      if (off) { this.fishLayer.removeChild(f.c); f.c.destroy({ children: true }); this.fish.splice(i, 1); }
    }

    // bullets — RICOCHET off the walls so shots rarely go to waste
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i]; b.life += dt; b.s.x += b.vx * dt; b.s.y += b.vy * dt;
      // bounce off left / right / top / bottom edges (reflect the velocity component)
      let bounced = false;
      if (b.s.x < b.r) { b.s.x = b.r; b.vx = Math.abs(b.vx); bounced = true; }
      else if (b.s.x > this.W - b.r) { b.s.x = this.W - b.r; b.vx = -Math.abs(b.vx); bounced = true; }
      if (b.s.y < b.r) { b.s.y = b.r; b.vy = Math.abs(b.vy); bounced = true; }
      else if (b.s.y > this.H - b.r) { b.s.y = this.H - b.r; b.vy = -Math.abs(b.vy); bounced = true; }
      if (bounced) { b.bounces++; b.s.rotation = Math.atan2(b.vy, b.vx) + Math.PI / 2; } // keep ricocheting until it catches a fish
      let hitFish = null;
      for (const f of this.fish) { if (!f.alive) continue; const d = Math.hypot(b.s.x - f.c.x, b.s.y - f.c.y); if (d < f.r + b.r) { hitFish = f; break; } }
      if (hitFish) { this._resolveBulletFish(b, hitFish); }
      // A shot NEVER expires on its own — it ricochets forever until it catches a fish,
      // so the player never feels a paid shot was wasted. (Memory stays bounded by the
      // 38-bullet FIFO cap in _fire(); fish now fill the whole field so hits come fast.)
      if (b.hit) { this.bulletLayer.removeChild(b.s); b.s.destroy(); this.bullets.splice(i, 1); }
    }

    // coins fly to balance HUD
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i]; c.t += dt; const k = c.t / c.life;
      if (c.rain) { // jackpot downpour — fall + spin + fade, no wallet magnet
        c.vy += 240 * dt; c.s.x += c.vx * dt; c.s.y += c.vy * dt; c.s.rotation += dt * 9;
        c.s.scale.x = c.sc * Math.max(0.18, Math.abs(Math.cos(c.t * 11))); // edge-on flip
        if (k > 0.8) c.s.alpha = (1 - k) / 0.2;
        if (k >= 1 || c.s.y > this.H + 40) { this.fxLayer.removeChild(c.s); c.s.destroy(); this.coins.splice(i, 1); }
        continue;
      }
      if (k < 0.4) { c.vy += 520 * dt; c.s.x += c.vx * dt; c.s.y += c.vy * dt; }
      else { const kk = (k - 0.4) / 0.6; c.s.x = lerp(c.s.x, c.targetX, kk * 0.3); c.s.y = lerp(c.s.y, c.targetY, kk * 0.3); c.s.alpha = 1 - kk; c.s.scale.set(c.s.scale.x * (1 - dt)); }
      c.s.rotation += dt * 8;
      if (k >= 1) { this.fxLayer.removeChild(c.s); c.s.destroy(); this.coins.splice(i, 1); }
    }

    // bubbles
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const bb = this.bubbles[i]; bb.s.y -= bb.vy * dt; bb.s.x += Math.sin(this._t * bb.wob + bb.ph) * 8 * dt;
      if (bb.s.y < -10) { this.bubbleLayer.removeChild(bb.s); bb.s.destroy(); this.bubbles.splice(i, 1); }
    }
    if (this.bubbles.length < 26 && Math.random() < 0.25) this._spawnBubble();

    // fx
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const e = this.fx[i]; e.t += dt; const k = Math.min(1, e.t / e.dur);
      if (e.kind === "ring") { const sc = lerp(0.2, e.to, 1 - Math.pow(1 - k, 3)); e.s.scale.set(sc); e.s.alpha = 1 - k; }
      else if (e.kind === "flash") { e.s.alpha = 1 - k; e.s.scale.set(0.5 + k * 0.8); }
      else if (e.kind === "fade") { e.s.alpha = 1 - k; }
      else if (e.kind === "float") { e.s.y -= 40 * dt; e.s.alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3; }
      if (k >= 1) { this.fxLayer.removeChild(e.s); e.s.destroy(); this.fx.splice(i, 1); }
    }

    // caustics + weeds drift
    for (const s of this.causticLayer.children) { s.x += s._vx * dt; if (s.x < -100) s.x = this.W + 100; if (s.x > this.W + 100) s.x = -100; s.alpha = 0.08 + 0.04 * Math.sin(this._t + s.x); }
    for (const w of this.weeds.children) { w.rotation = Math.sin(this._t * 0.8 + w._phase) * w._amp; }

    // banner anim — slam in (easeOutBack overshoot) then hold then fade
    if (this.banner.alpha > 0) {
      this._bannerT += dt; const k = Math.min(1, this._bannerT / 0.32);
      const eb = 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2);
      this.banner.scale.set(2.3 + (1 - 2.3) * eb);
      if (this._bannerT > 1.2) { this.banner.alpha = Math.max(0, this.banner.alpha - dt * 1.6); this.bannerSub.alpha = this.banner.alpha; }
    }
    // screen flash decay
    if (this._flash) { if (this._flash.alpha > 0.01) this._flash.alpha *= 0.86; else this._flash.alpha = 0; }

    // combo decay
    if (this._comboT > 0) { this._comboT -= dt; if (this._comboT <= 0) this._combo = 0; }

    // jackpot meter draw
    this._drawJackpotMeter();

    // screen shake
    this._shake *= 0.85; if (this._shake < 0.2) this._shake = 0;
    this.app.stage.x = (Math.random() - 0.5) * this._shake; this.app.stage.y = (Math.random() - 0.5) * this._shake;

    // reticle follow
    if (this.reticle.visible) { this.reticle.rotation += dt * 1.5; }
  };

  FishTable.prototype._drawJackpotMeter = function () {
    const g = this.jpBar, W = this.W; g.clear();
    const bw = 220, bh = 12, x = W / 2 - bw / 2, y = 52;
    const frenzy = this._frenzy > 0;
    g.beginFill(0x041326, 0.7); g.drawRoundedRect(x - 3, y - 3, bw + 6, bh + 6, 6); g.endFill();
    g.beginFill(0x0c2840); g.drawRoundedRect(x, y, bw, bh, 5); g.endFill();
    const frac = frenzy ? (this._frenzy / this._frenzyMax) : this._jackpot;
    g.beginFill(frenzy ? 0x45f0a6 : 0xffd23f); g.drawRoundedRect(x, y, bw * frac, bh, 5); g.endFill();
    this.jpText.text = frenzy ? ("🌊 FREE-FIRE FRENZY  " + this._frenzy.toFixed(1) + "s  +$" + this._frenzyWon.toFixed(0)) : ("★ JACKPOT $" + this._usd(this._jackpotPool) + "  ·  " + Math.floor(this._jackpot * 100) + "% ★");
  };

  /* ---------- aim / input ---------- */
  FishTable.prototype._autoAim = function () {
    // lock onto the highest-value fish on screen
    let best = null, bestScore = -1;
    for (const f of this.fish) { if (!f.alive) continue; const score = f.def.mult - Math.hypot(f.c.x - this.cannon.x, f.c.y - this.cannon.y) * 0.02; if (score > bestScore) { bestScore = score; best = f; } }
    if (best) { this._aim = Math.atan2(best.c.y - this.cannon.y, best.c.x - this.cannon.x); this.reticle.visible = true; this.reticle.x = best.c.x; this.reticle.y = best.c.y; }
    else this.reticle.visible = false;
  };
  FishTable.prototype._pointAt = function (gx, gy) {
    const r = this.app.view.getBoundingClientRect();
    const x = (gx - r.left) / r.width * this.W, y = (gy - r.top) / r.height * this.H;
    if (this.lock) return;
    let dx = x - this.cannon.x, dy = y - this.cannon.y;
    if (dy > -40) dy = -40;                                   // never aim flat or downward — always up into the field
    let a = Math.atan2(dy, dx);                               // dy<0 ⇒ a in (-π, 0) = upper hemisphere
    a = Math.max(-(Math.PI - 0.12), Math.min(-0.12, a));      // keep it ~7° off perfectly horizontal (no stuck shots)
    this._aim = a;
  };

  FishTable.prototype._wire = function () {
    const v = this.app.view;
    const onMove = (e) => { const p = e.touches ? e.touches[0] : e; if (p) this._pointAt(p.clientX, p.clientY); };
    const onDown = (e) => { if (!this._active) return; e.preventDefault(); const p = e.touches ? e.touches[0] : e; if (p) this._pointAt(p.clientX, p.clientY); this._holding = true; if (!this.auto) this._fire(); };
    const onUp = () => { this._holding = false; };
    v.addEventListener("mousemove", onMove); v.addEventListener("touchmove", onMove, { passive: false });
    v.addEventListener("mousedown", onDown); v.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("mouseup", onUp); window.addEventListener("touchend", onUp);
    // CRITICAL: also clear "holding" on touch/pointer CANCEL + blur + tab-hide. Without
    // these, a cancelled touch (a system gesture on mobile interrupts touchend) leaves
    // _holding stuck true → the cannon fires forever and the Auto button can't stop it.
    window.addEventListener("touchcancel", onUp); window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    document.addEventListener("visibilitychange", () => { if (document.hidden) this._holding = false; });
    const e = this.els;
    if (e.betSlider) e.betSlider.addEventListener("input", () => this.setBet(parseFloat(e.betSlider.value) || MIN_BET));
    if (e.powerUp) e.powerUp.addEventListener("click", () => this.setPower(this.power + 1));
    if (e.powerDown) e.powerDown.addEventListener("click", () => this.setPower(this.power - 1));
    if (e.autoBtn) e.autoBtn.addEventListener("click", () => this.toggleAuto());
    if (e.lockBtn) e.lockBtn.addEventListener("click", () => this.toggleLock());
    window.addEventListener("keydown", (ev) => {
      if (!this._active) return; const tag = (ev.target && ev.target.tagName) || ""; if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (ev.code === "Space") { ev.preventDefault(); this.toggleAuto(); }
      else if (ev.code === "KeyL") this.toggleLock();
      else if (ev.code === "ArrowUp") this.setPower(this.power + 1);
      else if (ev.code === "ArrowDown") this.setPower(this.power - 1);
    });
  };

  /* ---------- HUD / money ---------- */
  FishTable.prototype._usd = function (n) { return "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  FishTable.prototype._renderHud = function () {
    if (this.balText) this.balText.text = "💰 " + this._usd(this.balance);
    if (this.winText) this.winText.text = this._won > 0 ? "WIN " + this._usd(this._won) : "";
    if (this.powText) this.powText.text = "PWR " + this.power + "  ·  $" + this.cost().toFixed(2) + "/shot";
    if (this.modeText) this.modeText.text = (this.auto ? "🔥AUTO " : "") + (this.lock ? "🎯LOCK" : "") || "tap to shoot";
    if (this.sesText) { const net = Math.round((this._sesWon - this._sesSpent) * 100) / 100; this.sesText.text = "SESSION   shots −$" + this._sesSpent.toFixed(2) + "   ·   caught +$" + this._sesWon.toFixed(2) + "   ·   net " + (net >= 0 ? "+" : "−") + "$" + Math.abs(net).toFixed(2); this.sesText.style.fill = net >= 0 ? 0x9be8ff : 0xffb4c0; }
    const e = this.els;
    if (e.balance) e.balance.textContent = this._usd(this.balance);
    if (e.betVal) e.betVal.textContent = this._usd(this.unitBet);
    if (e.power) e.power.textContent = "Power " + this.power;
    if (e.cost) e.cost.textContent = this._usd(this.cost()) + "/shot";
    if (e.win) e.win.textContent = this._usd(this._won);
    if (e.sesSpent) e.sesSpent.textContent = this._usd(this._sesSpent);
    if (e.sesWon) e.sesWon.textContent = this._usd(this._sesWon);
    if (e.sesNet) { const n = Math.round((this._sesWon - this._sesSpent) * 100) / 100; e.sesNet.textContent = (n >= 0 ? "+" : "−") + this._usd(Math.abs(n)); e.sesNet.classList.toggle("up", n >= 0); e.sesNet.classList.toggle("down", n < 0); }
  };
  // Start a fresh money-flow session (called on buy-in / entering the channel).
  FishTable.prototype.newSession = function (buyIn) { this._sesSpent = 0; this._sesWon = 0; this._sesBuyIn = +buyIn || 0; this._renderHud(); };
  FishTable.prototype._save = function () { if (this.onBalance) try { this.onBalance(this.balance); } catch (e) {} };

  // Tear down any in-flight bonus round + free-fire so leaving the channel can't strand
  // the game in a state where `_chest`/`_jpFx` stay set (firing is gated on them being
  // null) or `_frenzy` stays >0 (free shots). Jackpot money is credited BEFORE its show,
  // so dropping the show loses no payout.
  FishTable.prototype._forceEndBonuses = function () {
    this._frenzy = 0; this._holding = false;
    try { if (this._chest && this._chest.cont) { this.hud.removeChild(this._chest.cont); this._chest.cont.destroy({ children: true }); } } catch (e) {}
    this._chest = null;
    try { if (this._jpFx && this._jpFx.cont) { this.hud.removeChild(this._jpFx.cont); this._jpFx.cont.destroy({ children: true }); } } catch (e) {}
    this._jpFx = null;
  };

  /* ---------- host bridge ---------- */
  FishTable.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this.app.ticker.start(); } else { this.app.ticker.stop(); this._forceEndBonuses(); try { this._fsExit(this._fsTarget); } catch (e) {} }
  };
  FishTable.prototype.setEnabled = function (on) { this._enabled = !!on; this._renderHud(); };
  FishTable.prototype.setBalance = function (usd) { this.balance = Math.max(0, Math.round((+usd || 0) * 100) / 100); this._renderHud(); };
  FishTable.prototype.setEthUsd = function (n) { if (n > 0) { this.ethUsd = n; this._renderHud(); } };
  FishTable.prototype.setMode = function () { /* demo-only for now; kept for API symmetry */ };
  FishTable.prototype.setBet = function (v) { this.unitBet = Math.max(MIN_BET, Math.round((+v || MIN_BET) * 100) / 100); this._renderHud(); };
  FishTable.prototype.setPower = function (p) { this.power = clamp(p | 0, 1, MAX_POWER); this._renderHud(); };
  FishTable.prototype.toggleAuto = function () { this.auto = !this.auto; this._holding = false; /* always clear a (possibly stuck) hold so the Auto button is a reliable stop */ if (this.els.autoBtn) this.els.autoBtn.classList.toggle("on", this.auto); this._renderHud(); };
  FishTable.prototype.toggleLock = function () { this.lock = !this.lock; if (!this.lock) this.reticle.visible = false; if (this.els.lockBtn) this.els.lockBtn.classList.toggle("on", this.lock); this._renderHud(); };
  // Fullscreen (immersive arcade mode). The real Fullscreen API does NOT work on
  // iPhone Safari for non-video elements, so we ALWAYS toggle a CSS class that
  // pins the layer to the whole viewport (works everywhere), AND additionally
  // request the real API where supported (desktop/Android) for browser-chrome hiding.
  FishTable.prototype.isFullscreen = function () { const t = this._fsTarget || this.mount; return !!(document.fullscreenElement || document.webkitFullscreenElement || (t && t.classList && t.classList.contains("rr-fs"))); };
  FishTable.prototype.toggleFullscreen = function (el) {
    const target = el || this._fsTarget || this.mount || this.app.view;
    const turningOn = !(target.classList && target.classList.contains("rr-fs"));
    if (turningOn) {
      // REPARENT the game layer to <body> so it escapes the TV's stacking context.
      // Then a single CSS rule (`body.rr-fs-on > *:not(#layer-fish){display:none}`)
      // hides EVERYTHING else — top bar, bottom nav, the landscape side menu, the ETH
      // ticker, the Share-win button — regardless of layout or orientation. Whitelisting
      // elements one by one kept missing things; this covers them all.
      if (!this._fsHome) this._fsHome = { parent: target.parentNode, next: target.nextSibling };
      document.body.appendChild(target);
      target.classList.add("rr-fs");
      document.body.classList.add("rr-fs-on");
      try { const req = target.requestFullscreen || target.webkitRequestFullscreen || target.webkitRequestFullScreen || target.msRequestFullscreen; if (req) req.call(target); } catch (e) {}
      if (this.els.fsBtn) this.els.fsBtn.classList.add("on");
    } else {
      this._fsExit(target);
    }
  };
  FishTable.prototype._fsExit = function (target) {
    target = target || this._fsTarget || this.mount; if (!target) return;
    if (!target.classList || !target.classList.contains("rr-fs")) return; // not in fullscreen
    target.classList.remove("rr-fs");
    document.body.classList.remove("rr-fs-on");
    if (this._fsHome && this._fsHome.parent) { try { this._fsHome.parent.insertBefore(target, this._fsHome.next || null); } catch (e) {} this._fsHome = null; }
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen(); } catch (e) {}
    if (this.els.fsBtn) this.els.fsBtn.classList.remove("on");
  };
  FishTable.prototype.setFullscreenTarget = function (el) {
    this._fsTarget = el;
    // keep state in sync if the user exits real fullscreen via Esc/swipe
    const sync = () => { const real = !!(document.fullscreenElement || document.webkitFullscreenElement); if (!real && el.classList.contains("rr-fs") && this._fsWasReal) { this._fsExit(el); this._fsWasReal = false; } this._fsWasReal = real; };
    document.addEventListener("fullscreenchange", sync); document.addEventListener("webkitfullscreenchange", sync);
  };

  root.FishTable = FishTable;
})(typeof globalThis !== "undefined" ? globalThis : this);
