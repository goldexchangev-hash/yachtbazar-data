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
      // tail
      g.beginFill(dark); g.moveTo(cx - R * 1.05, cy); g.lineTo(cx - R * 1.7, cy - R * 0.7); g.lineTo(cx - R * 1.55, cy); g.lineTo(cx - R * 1.7, cy + R * 0.7); g.closePath(); g.endFill();
      // top + bottom fins
      g.beginFill(dark, 0.95); g.moveTo(cx - R * 0.2, cy - R * 0.75); g.lineTo(cx + R * 0.4, cy - R * 1.25); g.lineTo(cx + R * 0.55, cy - R * 0.6); g.closePath(); g.endFill();
      g.beginFill(dark, 0.9); g.moveTo(cx - R * 0.1, cy + R * 0.7); g.lineTo(cx + R * 0.3, cy + R * 1.15); g.lineTo(cx + R * 0.5, cy + R * 0.55); g.closePath(); g.endFill();
      // body (rounded)
      g.lineStyle(0); g.beginFill(body); g.drawEllipse(cx, cy, R * 1.15, R * 0.82); g.endFill();
      // belly shade + top sheen
      g.beginFill(lite, 0.5); g.drawEllipse(cx + R * 0.15, cy - R * 0.28, R * 0.85, R * 0.4); g.endFill();
      g.beginFill(dark, 0.35); g.drawEllipse(cx, cy + R * 0.38, R * 0.95, R * 0.32); g.endFill();
      // accent stripe
      g.lineStyle(Math.max(2, R * 0.16), f.accent, 0.9); g.moveTo(cx - R * 0.2, cy - R * 0.5); g.quadraticCurveTo(cx + R * 0.1, cy, cx - R * 0.2, cy + R * 0.5); g.lineStyle(0);
      // eye
      g.beginFill(0xffffff); g.drawCircle(cx + R * 0.72, cy - R * 0.12, R * 0.2); g.endFill();
      g.beginFill(0x101018); g.drawCircle(cx + R * 0.78, cy - R * 0.12, R * 0.1); g.endFill();
      g.beginFill(0xffffff, 0.9); g.drawCircle(cx + R * 0.74, cy - R * 0.18, R * 0.04); g.endFill();
      // boss/special crown markers
      if (f.special === "boss") { g.lineStyle(R * 0.1, 0xffd23f, 0.9); g.drawEllipse(cx, cy, R * 1.25, R * 0.92); g.lineStyle(0); }
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
    this._frenzy = 0; this._frenzyMax = 0; this._frenzyWon = 0; this._wheel = null;
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
    this.jpText = mk(16, 0xffd23f); this.jpText.anchor.set(0.5, 0); this.jpText.x = W / 2; this.jpText.y = 8; this.hud.addChild(this.jpText);
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
    const fromLeft = Math.random() < 0.5, dir = fromLeft ? 1 : -1;
    const y = rand(60, this.H - 120);
    const c = new PIXI.Container();
    const sp = new PIXI.Sprite(this.tex.fish(def)); sp.anchor.set(0.46, 0.5); sp.scale.x = dir; c.addChild(sp);
    // soft glow for specials/boss
    if (def.special) { const gl = new PIXI.Sprite(this.tex.glow(def.key, def.color, def.r * 5)); gl.anchor.set(0.5); gl.alpha = 0.5; gl.blendMode = PIXI.BLEND_MODES.ADD; c.addChildAt(gl, 0); }
    // value label
    const lbl = new PIXI.Text("x" + def.mult, { fontFamily: "Bungee, Arial", fontSize: Math.max(12, def.r * 0.6), fontWeight: "700", fill: 0xffffff, stroke: 0x041326, strokeThickness: 3 });
    lbl.anchor.set(0.5); lbl.y = def.r * 1.05; lbl.alpha = 0.85; c.addChild(lbl);
    c.x = fromLeft ? -def.r * 2 : this.W + def.r * 2; c.y = y;
    this.fishLayer.addChild(c);
    const hp = def.tier === "boss" ? 1 : 1; // death is probabilistic, hp just gates flinch
    this.fish.push({ def, c, sp, dir, vx: dir * rand(40, 90) * (def.tier === "boss" ? 0.55 : 1), baseY: y, bobAmp: rand(6, 20), bobSpd: rand(0.6, 1.6), ph: rand(0, 6.28), r: def.r, alive: true, flinch: 0 });
  };

  /* ---------- firing ---------- */
  FishTable.prototype.cost = function () { return Math.round(this.unitBet * this.power * 100) / 100; };
  FishTable.prototype._fire = function () {
    if (!this._active || !this._enabled) return;
    const cost = this.cost();
    if (this.balance < cost) { this._flashBanner("INSUFFICIENT", "add funds 👇", 0xff5d72); return; }
    this.balance = Math.round((this.balance - cost) * 100) / 100; this._save(); this._renderHud();
    const ang = this._aim;
    const tipX = this.cannon.x + Math.cos(ang) * 54, tipY = this.cannon.y + Math.sin(ang) * 54;
    const col = this.power >= 5 ? 0xff4d9d : this.power >= 3 ? 0xffd23f : 0x39e7ff;
    const sp = new PIXI.Sprite(this.tex.bullet(col)); sp.anchor.set(0.5); sp.x = tipX; sp.y = tipY; sp.rotation = ang + Math.PI / 2;
    const sc = 0.8 + this.power * 0.12; sp.scale.set(sc);
    this.bulletLayer.addChild(sp);
    const speed = 620 + this.power * 30;
    this.bullets.push({ s: sp, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, r: 7 * sc, col, hit: false });
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
    this.balance = Math.round((this.balance + payout) * 100) / 100; this._won = payout; this._save(); this._renderHud();
    if (this._frenzy > 0) this._frenzyWon = Math.round((this._frenzyWon + payout) * 100) / 100;
    // combo
    this._combo++; this._comboT = 1.2;
    // FX: net catch ring + coin burst toward balance HUD + floating payout
    this._net(fish.c.x, fish.c.y, fish.def.color, true);
    const coins = clamp(Math.round(fish.def.mult * 0.8) + 4, 5, 40);
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
    // jackpot meter + roll
    this._jackpot = clamp(this._jackpot + 0.012 * power, 0, 1);
    const jp = this.engine.rollJackpot(power);
    if (jp > 0) this._awardJackpot(jp);
    // specials AoE
    if (!isSplash) {
      if (fish.def.special === "bomb") this._bombSplash(fish);
      else if (fish.def.special === "chain") this._eelChain(fish);
    }
    // ── BONUS ROUNDS: catching the right creature triggers a feature ──
    if (!isSplash && fish.def.bonus && !this._wheel && this._frenzy <= 0) {
      if (fish.def.bonus === "wheel") this._fortuneWheel();
      else if (fish.def.bonus === "frenzy") this._startFrenzy(9);
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
  FishTable.prototype._awardJackpot = function (jpMult) {
    const amt = Math.round(jpMult * this.unitBet * 100) / 100;
    this.balance = Math.round((this.balance + amt) * 100) / 100; this._save(); this._renderHud();
    this._jackpot = 0; this._shake = Math.max(this._shake, 22);
    this._flashBanner("💰 JACKPOT!", "+$" + amt.toFixed(2), 0xffd23f);
    for (let i = 0; i < 80; i++) this._spawnCoin(this.W / 2, this.H * 0.4);
    const C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
    if (this.onWin) try { this.onWin({ profitUsd: amt, mult: jpMult, bonus: true }); } catch (e) {}
  };

  /* ---------- BONUS ROUND 1: FORTUNE WHEEL (Gold Crab) ---------- */
  FishTable.prototype._fortuneWheel = function () {
    const segs = [2, 5, 10, 3, 25, 5, 50, 3, 15, 5, 100, 8]; // multiples of unitBet
    const N = segs.length, cx = this.W / 2, cy = this.H * 0.42, R = Math.min(this.W, this.H) * 0.3;
    const cont = new PIXI.Container(); cont.x = cx; cont.y = cy;
    // dim backdrop
    const dim = new PIXI.Graphics(); dim.beginFill(0x02060f, 0.66); dim.drawRect(-cx, -cy, this.W, this.H); dim.endFill(); cont.addChild(dim);
    const wheel = new PIXI.Container(); cont.addChild(wheel);
    const cols = [0x39e7ff, 0xffd23f, 0xff5d9e, 0x45f0a6, 0xb14dff, 0xff8a3d];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      const w = new PIXI.Graphics(); w.beginFill(cols[i % cols.length]); w.moveTo(0, 0); w.arc(0, 0, R, a0, a1); w.closePath(); w.endFill();
      w.lineStyle(3, 0x041326, 0.6); w.moveTo(0, 0); w.lineTo(Math.cos(a0) * R, Math.sin(a0) * R); wheel.addChild(w);
      const lt = new PIXI.Text("x" + segs[i], { fontFamily: "Bungee, Arial", fontSize: R * 0.13, fontWeight: "700", fill: 0x041326 }); lt.anchor.set(0.5);
      const am = (a0 + a1) / 2; lt.x = Math.cos(am) * R * 0.7; lt.y = Math.sin(am) * R * 0.7; lt.rotation = am + Math.PI / 2; wheel.addChild(lt);
    }
    const hub = new PIXI.Graphics(); hub.beginFill(0xffd23f); hub.drawCircle(0, 0, R * 0.16); hub.endFill(); hub.beginFill(0x7a4a00); hub.drawCircle(0, 0, R * 0.07); hub.endFill(); wheel.addChild(hub);
    // pointer (top)
    const ptr = new PIXI.Graphics(); ptr.beginFill(0xffffff); ptr.moveTo(0, -R - 6); ptr.lineTo(-14, -R - 26); ptr.lineTo(14, -R - 26); ptr.closePath(); ptr.endFill(); cont.addChild(ptr);
    const title = new PIXI.Text("🎡 FORTUNE WHEEL", { fontFamily: "Bungee, Arial", fontSize: 26, fontWeight: "700", fill: 0xffd23f, stroke: 0x041326, strokeThickness: 5 }); title.anchor.set(0.5); title.y = -R - 50; cont.addChild(title);
    this.hud.addChild(cont);
    // weighted target: bigger multiplier = rarer
    let tw = 0; const wts = segs.map((m) => 1 / m); wts.forEach((w) => tw += w);
    let rr = this.engine.next() * tw, idx = 0; for (let i = 0; i < N; i++) { rr -= wts[i]; if (rr <= 0) { idx = i; break; } }
    const segMid = (idx + 0.5) / N * Math.PI * 2;
    const targetRot = (Math.PI * 2 * 4) - segMid - Math.PI / 2; // land idx under the top pointer
    this._wheel = { cont, wheel, segs, idx, rot: 0, vel: 0, t: 0, target: targetRot, awarded: false, title };
    const C = root.Chiptune; if (C && C.swoosh) try { C.swoosh(1600); } catch (e) {}
  };
  FishTable.prototype._updateWheel = function (dt) {
    const w = this._wheel; if (!w) return; w.t += dt;
    const k = Math.min(1, w.t / 3.2), e = 1 - Math.pow(1 - k, 4);
    w.wheel.rotation = w.target * e;
    if (k >= 1 && !w.awarded) {
      w.awarded = true;
      const mult = w.segs[w.idx], amt = Math.round(mult * this.unitBet * 100) / 100;
      this.balance = Math.round((this.balance + amt) * 100) / 100; this._won = amt; this._save(); this._renderHud();
      w.title.text = "WON  x" + mult + "  +$" + amt.toFixed(2);
      for (let i = 0; i < clamp(mult, 8, 80); i++) this._spawnCoin(this.W / 2, this.H * 0.42);
      this._shake = Math.max(this._shake, clamp(mult / 4, 6, 20));
      const C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
      if (this.onWin && amt > this.cost() * 4) try { this.onWin({ profitUsd: amt, mult: mult, bonus: true }); } catch (e) {}
      w.holdT = 0;
    }
    if (w.awarded) { w.holdT += dt; if (w.holdT > 1.6) { this.hud.removeChild(w.cont); w.cont.destroy({ children: true }); this._wheel = null; } }
  };

  /* ---------- BONUS ROUND 2: FEEDING FRENZY (Treasure Clam) ---------- */
  FishTable.prototype._startFrenzy = function (dur) {
    this._frenzy = dur; this._frenzyMax = dur; this._frenzyWon = 0;
    this._flashBanner("🌊 FEEDING FRENZY!", "shoot everything! ×2 spawns", 0x45f0a6);
    // flood the tank with a formation of catchable fish
    const small = E.FISH.filter((f) => f.tier !== "boss" && !f.bonus);
    for (let i = 0; i < 10; i++) setTimeout(() => { if (this._active && this._frenzy > 0) this._spawnFish(small[(Math.random() * small.length) | 0]); }, i * 120);
    const C = root.Chiptune; if (C && C.bigwin) try { C.bigwin(); } catch (e) {}
  };
  FishTable.prototype._updateFrenzy = function (dt) {
    if (this._frenzy <= 0) return;
    this._frenzy -= dt;
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
    const s = new PIXI.Sprite(this.tex.ring()); s.anchor.set(0.5); s.x = x; s.y = y; s.tint = color; s.blendMode = PIXI.BLEND_MODES.ADD; s.scale.set(0.2); this.fxLayer.addChild(s);
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
    this.banner.text = txt; this.banner.style.fill = color; this.banner.alpha = 1; this.banner.scale.set(1.4);
    this.bannerSub.text = sub || ""; this.bannerSub.alpha = sub ? 1 : 0;
    this._bannerT = 0;
  };

  /* ---------- per-frame ---------- */
  FishTable.prototype._frame = function (dt) {
    if (!this._active) return;
    this._t += dt;
    // bonus rounds take over
    if (this._wheel) this._updateWheel(dt);
    if (this._frenzy > 0) this._updateFrenzy(dt);

    // spawn cadence (suspended during the fortune wheel)
    if (!this._wheel) {
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
    if (!this._wheel && (this.auto || this._holding || this._frenzy > 0) && this._fireCd <= 0) this._fire();

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
      f.c.x += f.vx * dt;
      f.c.y = f.baseY + Math.sin(this._t * f.bobSpd + f.ph) * f.bobAmp;
      // swim wiggle (body squash + tail sway via rotation)
      f.sp.scale.y = 1 + Math.sin(this._t * 9 + f.ph) * 0.06;
      f.sp.rotation = Math.sin(this._t * 6 + f.ph) * 0.06 * f.dir;
      if (f.flinch > 0) { f.flinch -= dt; if (f.flinch <= 0) f.sp.tint = 0xffffff; }
      // despawn off opposite edge
      if ((f.dir > 0 && f.c.x > this.W + f.r * 2) || (f.dir < 0 && f.c.x < -f.r * 2)) { this.fishLayer.removeChild(f.c); f.c.destroy({ children: true }); this.fish.splice(i, 1); }
    }

    // bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i]; b.s.x += b.vx * dt; b.s.y += b.vy * dt;
      let hitFish = null;
      for (const f of this.fish) { if (!f.alive) continue; const d = Math.hypot(b.s.x - f.c.x, b.s.y - f.c.y); if (d < f.r + b.r) { hitFish = f; break; } }
      if (hitFish) { this._resolveBulletFish(b, hitFish); }
      if (b.hit || b.s.y < -20 || b.s.x < -20 || b.s.x > this.W + 20) { this.bulletLayer.removeChild(b.s); b.s.destroy(); this.bullets.splice(i, 1); }
    }

    // coins fly to balance HUD
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i]; c.t += dt; const k = c.t / c.life;
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

    // banner anim
    if (this.banner.alpha > 0) { this._bannerT += dt; this.banner.scale.set(lerp(this.banner.scale.x, 1, Math.min(1, dt * 8))); if (this._bannerT > 1.1) { this.banner.alpha = Math.max(0, this.banner.alpha - dt * 1.6); this.bannerSub.alpha = this.banner.alpha; } }

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
    const bw = 220, bh = 12, x = W / 2 - bw / 2, y = 30;
    const frenzy = this._frenzy > 0;
    g.beginFill(0x041326, 0.7); g.drawRoundedRect(x - 3, y - 3, bw + 6, bh + 6, 6); g.endFill();
    g.beginFill(0x0c2840); g.drawRoundedRect(x, y, bw, bh, 5); g.endFill();
    const frac = frenzy ? (this._frenzy / this._frenzyMax) : this._jackpot;
    g.beginFill(frenzy ? 0x45f0a6 : 0xffd23f); g.drawRoundedRect(x, y, bw * frac, bh, 5); g.endFill();
    this.jpText.text = frenzy ? ("🌊 FRENZY  " + this._frenzy.toFixed(1) + "s  +$" + this._frenzyWon.toFixed(0)) : "★ JACKPOT METER ★";
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
    if (!this.lock) this._aim = Math.atan2(y - this.cannon.y, x - this.cannon.x);
  };

  FishTable.prototype._wire = function () {
    const v = this.app.view;
    const onMove = (e) => { const p = e.touches ? e.touches[0] : e; if (p) this._pointAt(p.clientX, p.clientY); };
    const onDown = (e) => { if (!this._active) return; e.preventDefault(); const p = e.touches ? e.touches[0] : e; if (p) this._pointAt(p.clientX, p.clientY); this._holding = true; if (!this.auto) this._fire(); };
    const onUp = () => { this._holding = false; };
    v.addEventListener("mousemove", onMove); v.addEventListener("touchmove", onMove, { passive: false });
    v.addEventListener("mousedown", onDown); v.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("mouseup", onUp); window.addEventListener("touchend", onUp);
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
    const e = this.els;
    if (e.balance) e.balance.textContent = this._usd(this.balance);
    if (e.betVal) e.betVal.textContent = this._usd(this.unitBet);
    if (e.power) e.power.textContent = "Power " + this.power;
    if (e.cost) e.cost.textContent = this._usd(this.cost()) + "/shot";
    if (e.win) e.win.textContent = this._usd(this._won);
  };
  FishTable.prototype._save = function () { if (this.onBalance) try { this.onBalance(this.balance); } catch (e) {} };

  /* ---------- host bridge ---------- */
  FishTable.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this.app.ticker.start(); } else { this.app.ticker.stop(); this._holding = false; }
  };
  FishTable.prototype.setEnabled = function (on) { this._enabled = !!on; this._renderHud(); };
  FishTable.prototype.setBalance = function (usd) { this.balance = Math.max(0, Math.round((+usd || 0) * 100) / 100); this._renderHud(); };
  FishTable.prototype.setEthUsd = function (n) { if (n > 0) { this.ethUsd = n; this._renderHud(); } };
  FishTable.prototype.setMode = function () { /* demo-only for now; kept for API symmetry */ };
  FishTable.prototype.setBet = function (v) { this.unitBet = Math.max(MIN_BET, Math.round((+v || MIN_BET) * 100) / 100); this._renderHud(); };
  FishTable.prototype.setPower = function (p) { this.power = clamp(p | 0, 1, MAX_POWER); this._renderHud(); };
  FishTable.prototype.toggleAuto = function () { this.auto = !this.auto; this._renderHud(); };
  FishTable.prototype.toggleLock = function () { this.lock = !this.lock; if (!this.lock) this.reticle.visible = false; this._renderHud(); };
  // Fullscreen the game's container (immersive arcade mode). Works on the mount
  // element so the whole TV/stage goes edge-to-edge; falls back to the canvas.
  FishTable.prototype.isFullscreen = function () { return !!(document.fullscreenElement || document.webkitFullscreenElement); };
  FishTable.prototype.toggleFullscreen = function (el) {
    const target = el || this._fsTarget || this.mount || this.app.view;
    try {
      if (this.isFullscreen()) {
        (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      } else {
        const req = target.requestFullscreen || target.webkitRequestFullscreen || target.webkitRequestFullScreen || target.msRequestFullscreen;
        if (req) req.call(target);
      }
    } catch (e) {}
  };
  FishTable.prototype.setFullscreenTarget = function (el) { this._fsTarget = el; };

  root.FishTable = FishTable;
})(typeof globalThis !== "undefined" ? globalThis : this);
