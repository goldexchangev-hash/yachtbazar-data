/* ============================================================
   plane-render.js — "PLANE v3 (JETLINE)": premium PixiJS visualization.
   All original, procedural art (no external assets):
   - REAL additive bloom: bright "glow" layer rendered to a half-res
     RenderTexture, blurred once, composited additively over the scene.
   - 3-layer glowing equity curve (wide halo + mid bloom + crisp core).
   - Neon delta plane drawing its curve up a sky that climbs into space.
   - A 5-TIER cash-out celebration (CLIP/CASH/BIG/HUGE/JACKPOT): flash,
     light rays, shockwaves, a giant elastic win number, coin/confetti storm.
   The renderer never sees the crash point until it happens; visual slow-mo
   never touches the UI's money clock.
   globalThis.PlaneRenderer
   ============================================================ */
(function (root) {
  "use strict";
  const PIXI = root.PIXI;
  const ADD = PIXI.BLEND_MODES.ADD;
  const C = {
    cyan: 0x39e7ff, magenta: 0xff4d9d, gold: 0xffd23f, green: 0x45f0a6, red: 0xff2a4a, white: 0xffffff,
    coreCyan: 0xcfffff, ink: 0xeaf2ff, muted: 0x9aa7c7, hull: 0x1b2240, hullHi: 0x3a4f80, hullLo: 0x0e1430,
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function mix(c1, c2, t) {
    const r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255, r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;
    return (Math.round(lerp(r1, r2, t)) << 16) | (Math.round(lerp(g1, g2, t)) << 8) | Math.round(lerp(b1, b2, t));
  }
  const easeOutBack = (t) => { const c = 2.2; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  function canvasTex(w, h, draw) { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; draw(cv.getContext("2d"), w, h); return PIXI.Texture.from(cv); }
  function radialTex(size, stops) { return canvasTex(size, size, (ctx) => { const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2); for (const s of stops) g.addColorStop(s[0], s[1]); ctx.fillStyle = g; ctx.fillRect(0, 0, size, size); }); }
  function vgradTex(w, h, stops) { return canvasTex(w, h, (ctx) => { const g = ctx.createLinearGradient(0, 0, 0, h); for (const s of stops) g.addColorStop(s[0], s[1]); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }); }

  function PlaneRenderer(opts) {
    const W = this.W = opts.width || 660, H = this.H = opts.height || 412;
    this.onTick = opts.onTick || function () {};
    this.ox = 56; this.oy = H - 44; this.mx = W * 0.66; this.my = H * 0.26;
    this._mult = 1; this._state = "betting"; this._t = 0; this._kick = 0;
    this._shake = 0; this._flash = 0; this._flashCol = C.green; this._scroll = 0; this._lastInt = 1;
    this._crashing = 0; this._instant = false; this._planeOff = 0;
    this._trail = []; this._rings = []; this._cd = 0; this._cdTotal = 5; this._targets = [];
    this._intensity = 0; this._winT = 0; this._winTier = 0; this._rayLife = 0;
    const lowq = (root.devicePixelRatio || 1) > 2.2 || /Mobi|Android/i.test(navigator.userAgent || "");
    this.lowq = lowq;

    const app = new PIXI.Application({ width: W, height: H, backgroundColor: 0x05060f, antialias: true,
      resolution: Math.min(lowq ? 1.5 : 2, root.devicePixelRatio || 1), autoDensity: true });
    this.app = app; this.view = app.view; if (opts.mount) opts.mount.appendChild(app.view);

    // ---- baked sprite library ----
    this.tex = {
      glow: radialTex(128, [[0, "rgba(255,255,255,1)"], [0.4, "rgba(255,255,255,0.5)"], [1, "rgba(255,255,255,0)"]]),
      coin: radialTex(28, [[0, "rgba(255,248,200,1)"], [0.45, "rgba(255,205,60,1)"], [0.85, "rgba(220,150,20,0.9)"], [1, "rgba(220,150,20,0)"]]),
      spark: radialTex(20, [[0, "rgba(255,255,255,1)"], [0.5, "rgba(180,240,255,0.7)"], [1, "rgba(180,240,255,0)"]]),
      shard: canvasTex(10, 6, (ctx) => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 10, 6); }),
      ray: vgradTex(26, 320, [[0, "rgba(255,255,255,0)"], [0.5, "rgba(255,255,255,0.9)"], [1, "rgba(255,255,255,0)"]]),
    };

    // ---- sky (dusk -> deep space cross-fade) ----
    this.skyDusk = new PIXI.Sprite(vgradTex(8, H, [["0", "#241a52"], ["0.5", "#3a1f63"], ["1", "#15294e"]]));
    this.skySpace = new PIXI.Sprite(vgradTex(8, H, [["0", "#05030f"], ["0.45", "#160a30"], ["1", "#2a0b3a"]]));
    this.skyDusk.width = this.skySpace.width = W; this.skyDusk.height = this.skySpace.height = H; this.skySpace.alpha = 0;
    app.stage.addChild(this.skyDusk, this.skySpace);

    this.clouds = new PIXI.Container(); app.stage.addChild(this.clouds);
    for (let i = 0; i < 4; i++) { const cl = new PIXI.Graphics(); cl.beginFill(0xffffff, 0.05).drawEllipse(0, 0, 80, 22).drawEllipse(46, 8, 54, 18).drawEllipse(-46, 6, 50, 16).endFill();
      cl.x = Math.random() * W; cl.y = 40 + Math.random() * H * 0.5; cl.spd = 7 + Math.random() * 12; this.clouds.addChild(cl); }
    this.grid = new PIXI.Graphics(); this.grid.alpha = 0.42; app.stage.addChild(this.grid);

    // ---- GLOW layer (all additive; rendered to bloom RT too) ----
    this.glow = new PIXI.Container(); this.glow.blendMode = ADD; app.stage.addChild(this.glow);
    this.sun = new PIXI.Sprite(this.tex.glow); this.sun.anchor.set(0.5); this.sun.tint = 0xff7a3d; this.sun.width = this.sun.height = W * 0.9; this.sun.position.set(W * 0.8, H * 0.8); this.sun.alpha = 0.5; this.glow.addChild(this.sun);
    this.stars = new PIXI.Container(); this.stars.alpha = 0; this.glow.addChild(this.stars);
    for (let i = 0; i < 64; i++) { const s = new PIXI.Sprite(this.tex.spark); s.anchor.set(0.5); s.scale.set(0.18 + Math.random() * 0.22); s.x = Math.random() * W; s.y = Math.random() * H * 0.92; s.tw = Math.random() * 6.28; s.base = 0.4 + Math.random() * 0.6; this.stars.addChild(s); }
    this.curveGlowA = new PIXI.Graphics(); this.curveGlowB = new PIXI.Graphics(); this.glow.addChild(this.curveGlowA, this.curveGlowB);
    this.planeGlow = new PIXI.Sprite(this.tex.glow); this.planeGlow.anchor.set(0.5); this.planeGlow.width = this.planeGlow.height = 90; this.planeGlow.tint = C.cyan; this.planeGlow.alpha = 0.5; this.glow.addChild(this.planeGlow);
    this.thruster = new PIXI.Sprite(this.tex.glow); this.thruster.anchor.set(0.9, 0.5); this.thruster.tint = C.gold; this.thruster.alpha = 0.9; this.glow.addChild(this.thruster);
    this.rays = new PIXI.Container(); this.rays.position.set(W / 2, H * 0.42); this.rays.alpha = 0; this.glow.addChild(this.rays);
    for (let i = 0; i < 16; i++) { const ry = new PIXI.Sprite(this.tex.ray); ry.anchor.set(0.5, 0.5); ry.rotation = (i / 16) * Math.PI * 2; ry.scale.set(0.5, 1.4); this.rays.addChild(ry); }
    this.parts = new PIXI.Container(); this.parts.blendMode = ADD; this.glow.addChild(this.parts);
    this._pool = [];
    for (let i = 0; i < (lowq ? 120 : 240); i++) { const s = new PIXI.Sprite(this.tex.coin); s.anchor.set(0.5); s.visible = false; this.parts.addChild(s); this._pool.push({ s, alive: false, vx: 0, vy: 0, life: 0, max: 1, spin: 0 }); }

    // ---- bloom: render glow -> half-res RT, blur, composite additively ----
    this.bloomRT = PIXI.RenderTexture.create({ width: Math.ceil(W / 2), height: Math.ceil(H / 2), resolution: 1 });
    this._bloomM = new PIXI.Matrix(); this._bloomM.scale(0.5, 0.5);
    this.bloomSprite = new PIXI.Sprite(this.bloomRT); this.bloomSprite.scale.set(2); this.bloomSprite.blendMode = ADD; this.bloomSprite.alpha = lowq ? 0.45 : 0.6;
    this.bloomSprite.filters = [new PIXI.BlurFilter(lowq ? 5 : 8, 2)]; app.stage.addChild(this.bloomSprite);

    // ---- crisp world (above the bloom so plane/curve stay sharp) ----
    const world = new PIXI.Container(); app.stage.addChild(world); this.world = world;
    this.curveCore = new PIXI.Graphics(); world.addChild(this.curveCore);
    this.targetG = new PIXI.Graphics(); world.addChild(this.targetG);
    this.plane = new PIXI.Container(); const body = new PIXI.Graphics();
    body.beginFill(C.hullLo).drawPolygon([-20, 2, 16, -5, 24, 1, 16, 9]).endFill();         // AO underside
    body.beginFill(C.hull).drawPolygon([-20, 0, 16, -7, 24, 0, 16, 7]).endFill();           // fuselage
    body.beginFill(C.hullHi).drawPolygon([-6, -2, 12, -22, 18, -19, 2, -2]).endFill();      // top wing (lit)
    body.beginFill(C.magenta, 0.9).drawPolygon([-6, 2, 10, 18, 16, 15, 2, 2]).endFill();    // under wing
    body.lineStyle(2, C.cyan, 1).moveTo(-18, -1).lineTo(20, -4);                             // cyan leading edge
    body.lineStyle(0).beginFill(C.coreCyan).drawCircle(12, -2, 2.6).endFill();              // canopy
    this.plane.addChild(body); world.addChild(this.plane);

    // ---- HUD ----
    this.multWrap = new PIXI.Container(); this.multWrap.position.set(W / 2, H * 0.34); app.stage.addChild(this.multWrap);
    this.multText = new PIXI.Text("1.00x", { fontFamily: '"Press Start 2P","Bungee",monospace', fontSize: 56, fill: C.white,
      dropShadow: true, dropShadowColor: C.cyan, dropShadowBlur: 18, dropShadowDistance: 0, dropShadowAlpha: 1 });
    this.multText.anchor.set(0.5); this.multWrap.addChild(this.multText);
    this.label = new PIXI.Text("", { fontFamily: '"Press Start 2P",monospace', fontSize: 12, fill: C.gold, dropShadow: true, dropShadowColor: 0, dropShadowBlur: 4, dropShadowDistance: 0 });
    this.label.anchor.set(0.5); this.label.position.set(W / 2, H * 0.34 - 46); this.label.alpha = 0; app.stage.addChild(this.label);
    this.subText = new PIXI.Text("", { fontFamily: '"Press Start 2P",monospace', fontSize: 12, fill: C.muted, align: "center" });
    this.subText.anchor.set(0.5); this.subText.position.set(W / 2, H * 0.34 + 92); app.stage.addChild(this.subText); // below the 70px countdown ring, so "place your bet" never overlaps the timer
    this.ring = new PIXI.Graphics(); this.ring.position.set(W / 2, H * 0.34); app.stage.addChild(this.ring);

    this.banner = new PIXI.Text("", { fontFamily: '"Bungee",monospace', fontSize: 34, fill: C.gold, align: "center", dropShadow: true, dropShadowColor: C.magenta, dropShadowBlur: 10, dropShadowDistance: 0, dropShadowAlpha: 1 });
    this.banner.anchor.set(0.5); this.banner.position.set(W / 2, H * 0.20); this.banner.alpha = 0; app.stage.addChild(this.banner);
    this.winGlow = new PIXI.Text("", { fontFamily: '"Bungee",monospace', fontSize: 40, fill: C.gold, align: "center" });
    this.winGlow.anchor.set(0.5); this.winGlow.position.set(W / 2, H * 0.52); this.winGlow.alpha = 0; this.winGlow.blendMode = ADD; app.stage.addChild(this.winGlow);
    this.winNum = new PIXI.Text("", { fontFamily: '"Bungee",monospace', fontSize: 40, fill: C.green, align: "center", dropShadow: true, dropShadowColor: 0x065c2c, dropShadowBlur: 8, dropShadowDistance: 0, dropShadowAlpha: 1 });
    this.winNum.anchor.set(0.5); this.winNum.position.set(W / 2, H * 0.52); this.winNum.alpha = 0; app.stage.addChild(this.winNum);

    this.vig = new PIXI.Sprite(radialTex(256, [[0, "rgba(255,40,60,0)"], [0.55, "rgba(255,30,50,0)"], [1, "rgba(255,30,60,0.9)"]]));
    this.vig.width = W; this.vig.height = H; this.vig.alpha = 0; app.stage.addChild(this.vig);
    this.flash = new PIXI.Graphics(); this.flash.beginFill(0xffffff).drawRect(0, 0, W, H).endFill(); this.flash.alpha = 0; this.flash.blendMode = ADD; app.stage.addChild(this.flash);

    this._placePlane(1); this._drawGrid();
    app.ticker.add(() => this._frame(app.ticker.deltaMS / 1000));
  }

  PlaneRenderer.prototype._pos = function (mult) { const p = clamp(Math.log(Math.max(1, mult)) / Math.log(12), 0, 1), e = 1 - (1 - p) * (1 - p); return { x: lerp(this.ox, this.mx, e), y: lerp(this.oy, this.my, e), p }; };
  PlaneRenderer.prototype._placePlane = function (m) { const q = this._pos(m); this._px = q.x; this._py = q.y; };
  PlaneRenderer.prototype._drawGrid = function () { const g = this.grid; g.clear(); g.lineStyle(1, 0x39507e, 0.16); const off = this._scroll % 46; for (let x = -off; x < this.W; x += 46) g.moveTo(x, 0).lineTo(x, this.H); for (let y = this.H - off; y > 0; y -= 46) g.moveTo(0, y).lineTo(this.W, y); };

  PlaneRenderer.prototype.winTier = function (mult) { const m = mult || this._mult; return m < 1.5 ? 1 : m < 3 ? 2 : m < 8 ? 3 : m < 25 ? 4 : 5; };

  /* ---------------- per-frame ---------------- */
  PlaneRenderer.prototype._frame = function (dt) {
    this._t += dt; this.onTick(dt);
    const m = this._mult, flying = this._state === "flying";
    const alt = clamp(Math.log(Math.max(1, m)) / Math.log(1000), 0, 1);
    this._intensity = clamp(Math.log(Math.max(1, m)) / Math.log(60), 0, 1);

    // sky / stars / clouds
    this.skySpace.alpha = clamp(alt * 1.6, 0, 1);
    this.stars.alpha = clamp((alt - 0.04) * 2.2, 0, 1);
    this.sun.alpha = clamp(0.5 - alt, 0, 0.5);
    for (const s of this.stars.children) s.alpha = (0.3 + 0.7 * Math.abs(Math.sin(this._t * 1.6 + s.tw))) * s.base;
    this.clouds.alpha = clamp(1 - Math.log(Math.max(1, m)) / Math.log(8), 0, 1);
    for (const cl of this.clouds.children) { cl.x -= cl.spd * (flying ? 3 : 1) * dt; if (cl.x < -140) cl.x = this.W + 140; }
    if (flying) { this._scroll += (30 + m * 14) * dt; this._drawGrid(); }

    // plane follow / crash
    let tx, ty, rot = 0;
    if (this._crashing > 0) {
      this._crashing -= dt; this._planeOff += dt;
      if (this._instant) { tx = this._px; ty = this._py + this._planeOff * 480; rot = 1.3; }
      else { tx = this._px + this._planeOff * 620; ty = this._py - this._planeOff * 430; rot = -0.6; }
      this.plane.alpha = clamp(this._crashing / 0.45, 0, 1);
    } else {
      const q = this._pos(m), bob = Math.sin(this._t * 4.5) * (this._state === "betting" ? 3 : 2 + q.p * 3), vib = q.p > 0.95 ? (Math.random() - 0.5) * (m > 20 ? 5 : 2) : 0;
      this._px = lerp(this._px, q.x, 0.3); this._py = lerp(this._py, q.y, 0.3);
      tx = this._px + vib; ty = this._py + bob + vib;
      const ahead = this._pos(m * 1.18); rot = clamp(Math.atan2(ahead.y - q.y, ahead.x - q.x), -0.9, 0.05); this.plane.alpha = 1;
    }
    this.plane.position.set(tx, ty); this.plane.rotation = rot;
    this.planeGlow.position.set(tx, ty); this.planeGlow.tint = m < 5 ? C.cyan : m < 20 ? C.gold : C.magenta; this.planeGlow.alpha = flying ? 0.55 : 0.35;
    // thruster glow behind nose
    const tl = 24 + clamp(Math.log(m) * 10, 0, 60); this.thruster.width = tl; this.thruster.height = 18;
    this.thruster.position.set(tx - Math.cos(rot) * 18, ty - Math.sin(rot) * 18); this.thruster.rotation = rot; this.thruster.alpha = (flying ? 0.9 : 0.5) * (0.8 + 0.2 * Math.random());

    if (flying && this._crashing <= 0) { this._trail.push({ x: tx, y: ty }); if (this._trail.length > 60) this._trail.shift(); }
    this._drawCurve(m);
    this._drawTargets();

    // multiplier text
    if (flying) {
      const tier = m < 2 ? C.cyan : m < 5 ? C.white : m < 20 ? C.gold : C.magenta;
      this.multText.style.fill = m > 100 ? C.white : tier; this.multText.style.dropShadowColor = tier;
      const base = 1 + clamp(Math.log(m) * 0.05, 0, 0.7), beat = 1 + 0.02 * Math.sin(this._t * 6) * this._intensity;
      this.multWrap.scale.set((base + this._kick) * beat);
      this.multWrap.position.set(this.W / 2 + (Math.random() - 0.5) * this._intensity * 4, this.H * 0.34 + (Math.random() - 0.5) * this._intensity * 4);
      this.vig.alpha = clamp(this._intensity * 0.5, 0, 0.5) * (0.7 + 0.3 * Math.sin(this._t * 8));
    } else if (this._state !== "crashed") { this.vig.alpha = lerp(this.vig.alpha, 0, 0.2); this.multWrap.position.set(this.W / 2, this.H * 0.34); }
    if (this._kick > 0.001) this._kick *= 0.82; else this._kick = 0;

    // countdown ring
    this.ring.clear();
    if (this._state === "betting" && this._cd > 0) { const frac = clamp(this._cd / this._cdTotal, 0, 1), col = this._cd < 1 ? C.red : this._cd < 1.6 ? C.gold : C.cyan;
      this.ring.lineStyle(5, 0x223455, 0.6).drawCircle(0, 0, 70); this.ring.lineStyle(5, col, 0.95).arc(0, 0, 70, -Math.PI / 2, -Math.PI / 2 + frac * 6.283); }

    // win FX, particles, rays, rings
    this._stepWin(dt); this._stepParts(dt); this._stepRays(dt); this._stepRings(dt);

    // shake (whole stage)
    const sh = this._shake + this._intensity * (this._intensity > 0.8 ? 1.5 : 0);
    if (sh > 0.3) { this.app.stage.position.set((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh); this._shake *= 0.86; }
    else if (this.app.stage.position.x || this.app.stage.position.y) { this.app.stage.position.set(0, 0); this._shake = 0; }

    if (this._flash > 0.01) { this.flash.tint = this._flashCol; this.flash.alpha = this._flash * 0.5; this._flash *= 0.86; } else this.flash.alpha = 0;

    // ---- bloom: render the glow layer to the half-res RT (blurred via bloomSprite) ----
    if (!this.lowq || (this._frameN = (this._frameN | 0) + 1) % 2 === 0) {
      this.app.renderer.render(this.glow, { renderTexture: this.bloomRT, transform: this._bloomM, clear: true });
    }
  };

  PlaneRenderer.prototype._drawCurve = function (m) {
    const E = root.PlaneEngine, gA = this.curveGlowA, gB = this.curveGlowB, gc = this.curveCore;
    gA.clear(); gB.clear(); gc.clear();
    if (this._state === "betting") return;
    const px = this._px, py = this._py, crashed = (this._state === "crashed" || this._crashing > 0);
    const col = crashed ? C.red : mix(C.cyan, m < 8 ? C.gold : C.magenta, clamp((m - 1.5) / 8, 0, 1));
    const N = 34, pts = []; const tEnd = E ? E.timeForMultiplier(Math.max(1, m)) : 1;
    for (let i = 0; i <= N; i++) { const mm = E ? E.multiplierAtTime((i / N) * tEnd) : 1 + (i / N) * (m - 1); pts.push(this._pos(mm)); }
    pts[pts.length - 1] = { x: px, y: py };
    // crisp core + under-fill
    gc.beginFill(col, 0.12); gc.moveTo(this.ox, this.oy); for (const q of pts) gc.lineTo(q.x, q.y); gc.lineTo(px, this.oy); gc.closePath(); gc.endFill();
    gc.lineStyle(2.6, crashed ? C.red : C.coreCyan, 1); gc.moveTo(this.ox, this.oy); for (const q of pts) gc.lineTo(q.x, q.y);
    gc.beginFill(C.white).drawCircle(px, py, 3.5).endFill();
    // additive glow stack (these bloom)
    gA.lineStyle({ width: 16, color: col, alpha: 0.10, cap: "round", join: "round" }); gA.moveTo(this.ox, this.oy); for (const q of pts) gA.lineTo(q.x, q.y);
    gB.lineStyle({ width: 6, color: col, alpha: 0.34, cap: "round", join: "round" }); gB.moveTo(this.ox, this.oy); for (const q of pts) gB.lineTo(q.x, q.y);
  };

  PlaneRenderer.prototype._drawTargets = function () {
    const g = this.targetG; g.clear();
    for (const t of this._targets) { const q = this._pos(t.mult), near = clamp(1 - Math.abs(t.mult - this._mult) / Math.max(0.5, t.mult * 0.4), 0, 1);
      g.lineStyle(2, t.color, 0.3 + 0.6 * near); for (let x = this.ox; x < this.W; x += 14) g.moveTo(x, q.y).lineTo(x + 7, q.y); }
  };

  /* ---------------- particles (pooled) ---------------- */
  PlaneRenderer.prototype._spawn = function (x, y, vx, vy, tex, tint, life, sc) {
    for (const p of this._pool) if (!p.alive) { p.alive = true; p.vx = vx; p.vy = vy; p.life = life; p.max = life; p.spin = (Math.random() - 0.5) * 12;
      p.s.texture = tex; p.s.tint = tint; p.s.visible = true; p.s.position.set(x, y); p.s.scale.set(sc); p.s.rotation = Math.random() * 6.28; return; }
  };
  PlaneRenderer.prototype._stepParts = function (dt) {
    for (const p of this._pool) { if (!p.alive) continue; p.vy += 880 * dt; p.vx *= 0.99; p.s.x += p.vx * dt; p.s.y += p.vy * dt; p.s.rotation += p.spin * dt; p.life -= dt;
      p.s.alpha = clamp(p.life / (p.max * 0.5), 0, 1); if (p.life <= 0 || p.s.y > this.H + 50) { p.alive = false; p.s.visible = false; } }
  };
  PlaneRenderer.prototype._stepRings = function (dt) {
    for (let i = this._rings.length - 1; i >= 0; i--) { const r = this._rings[i]; r.rad += r.spd * dt; r.life -= dt; r.g.clear(); r.g.lineStyle(clamp(r.life * 9, 1, 8), r.col, clamp(r.life, 0, 1)).drawCircle(r.x, r.y, r.rad);
      if (r.life <= 0) { this.glow.removeChild(r.g); r.g.destroy(); this._rings.splice(i, 1); } }
  };
  PlaneRenderer.prototype._stepRays = function (dt) {
    if (this._rayLife > 0) { this._rayLife -= dt; this.rays.rotation += dt * 0.5; const t = this._rayLife; this.rays.alpha = clamp(t, 0, 1) * 0.6; this.rays.scale.set(1 + (1 - clamp(t / 1.2, 0, 1)) * 0.8); }
    else this.rays.alpha = 0;
  };
  PlaneRenderer.prototype._ring = function (x, y, col, spd, life) { const g = new PIXI.Graphics(); this.glow.addChild(g); this._rings.push({ g, x, y, rad: 14, spd: spd || 600, life: life || 0.6, col }); };

  /* ---------------- win celebration ---------------- */
  PlaneRenderer.prototype._stepWin = function (dt) {
    if (this._winT <= 0) return; this._winT -= dt;
    const T = this._winT, age = this._winDur - T;
    // win number elastic in, hold, drift+fade
    const inK = clamp(age / 0.34, 0, 1), e = easeOutBack(inK);
    const sc = (0.6 + 0.4 * e) * (this._winTier >= 4 ? 1.5 : this._winTier >= 3 ? 1.2 : 1);
    const a = T < 0.5 ? clamp(T / 0.5, 0, 1) : 1, rise = clamp(age - (this._winDur - 0.6), 0, 0.6) * 40;
    this.winNum.scale.set(sc); this.winNum.alpha = a; this.winNum.y = this.H * 0.52 - rise;
    this.winGlow.scale.set(sc * 1.06); this.winGlow.alpha = a * 0.7; this.winGlow.y = this.winNum.y;
    if (this.banner.alpha > 0 || age < 0.4) { const bk = clamp(age / 0.3, 0, 1); this.banner.scale.set(0.6 + 0.4 * easeOutBack(bk)); this.banner.alpha = clamp(T / 0.4, 0, 1) * clamp(bk * 3, 0, 1); }
    if (this._winT <= 0) { this.winNum.alpha = 0; this.winGlow.alpha = 0; this.banner.alpha = 0; this.label.alpha = 0; }
  };

  PlaneRenderer.prototype.cashOut = function (profit, mult, stake) {
    const tier = this.winTier(mult); this._winTier = tier;
    const m = mult || this._mult;
    this._flash = 1; this._flashCol = tier <= 1 ? C.green : tier <= 2 ? C.gold : C.white;
    this._shake = tier >= 4 ? 16 : tier >= 3 ? 9 : 4;
    this._ring(this._px, this._py, tier >= 3 ? C.gold : C.green, 560, 0.6);
    if (tier >= 3) this._ring(this._px, this._py, C.cyan, 760, 0.7);
    if (tier >= 4) setTimeout(() => this._ring(this.W / 2, this.H * 0.42, C.magenta, 900, 0.8), 120);
    // rays for big+
    if (tier >= 3) { this._rayLife = tier >= 5 ? 1.6 : tier >= 4 ? 1.3 : 1.0; this.rays.alpha = 0.6; for (const ry of this.rays.children) ry.tint = tier >= 4 ? C.gold : C.cyan; }
    this.subText.text = ""; // clear "CASH OUT before…" so it doesn't sit under the win number
    // win number + banner
    const fmt = "+$" + (Math.round(profit * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const txt = fmt + "   " + m.toFixed(2) + "x"; this.winNum.text = txt; this.winGlow.text = txt;
    this.winGlow.style.fill = tier >= 4 ? C.gold : C.green;
    this._winDur = tier >= 5 ? 3.0 : tier >= 4 ? 2.4 : tier >= 3 ? 1.7 : tier >= 2 ? 1.1 : 0.7; this._winT = this._winDur;
    const banners = ["", "", "CASHED OUT", "BIG WIN", "HUGE WIN", "JACKPOT!"];
    if (tier >= 2) { this.banner.text = banners[tier]; this.banner.style.fill = tier >= 4 ? C.gold : C.cyan; this.banner.alpha = 0.01; }
    else this.banner.alpha = 0;
    // coin / confetti storm
    const counts = [0, 12, 26, 50, 80, 140], n = (this.lowq ? 0.5 : 1) * counts[tier];
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, spd = 160 + Math.random() * (260 + tier * 90);
      const conf = tier >= 3 && Math.random() < 0.45;
      this._spawn(this._px, this._py, Math.cos(ang) * spd, Math.sin(ang) * spd - 140,
        conf ? this.tex.shard : this.tex.coin, conf ? [C.cyan, C.magenta, C.gold, C.green][i % 4] : C.gold,
        0.9 + Math.random() * (0.6 + tier * 0.2), conf ? (1 + Math.random()) : (0.5 + Math.random() * 0.5));
    }
    this.multText.style.fill = C.green; this.subText.text = "";
  };

  /* ---------------- API ---------------- */
  PlaneRenderer.prototype.setState = function (s) { this._state = s; if (s === "flying") { this._crashing = 0; this._planeOff = 0; this.plane.alpha = 1; } };
  PlaneRenderer.prototype.setLive = function (mult) { this._mult = mult; this.multText.text = mult.toFixed(2) + "x"; const fl = Math.floor(mult); if (fl > this._lastInt) { this._lastInt = fl; this._kick = 0.16; } };
  PlaneRenderer.prototype.getRenderedMultiplier = function () { return this._mult; };
  PlaneRenderer.prototype.setTargets = function (l) { this._targets = l || []; };
  PlaneRenderer.prototype.setCountdown = function (secs, total) { this._state = "betting"; this._cd = secs; this._cdTotal = total || this._cdTotal; this._mult = 1; this._placePlane(1);
    // clear any leftover win number/banner so it never lingers under "place your bet"
    this._winT = 0; this.winNum.alpha = 0; this.winGlow.alpha = 0; this.banner.alpha = 0;
    this.multText.text = secs.toFixed(1); this.multWrap.scale.set(0.62); this.multText.style.fill = C.cyan; this.multText.style.dropShadowColor = C.cyan; this.subText.text = "place your bet"; this.subText.style.fill = C.muted; this.label.alpha = 0; this.vig.alpha = 0; };
  PlaneRenderer.prototype.takeoff = function () { this._state = "takeoff"; this.multText.text = "TAKING OFF"; this.multWrap.scale.set(0.5); this.multText.style.fill = C.gold; this.subText.text = ""; this.ring.clear(); this._shake = 4; };
  PlaneRenderer.prototype.flying = function () { this.setState("flying"); this._trail = []; this.subText.text = "CASH OUT before it flies away!"; this.subText.style.fill = C.gold; this.multWrap.scale.set(1); this._kick = 0.2; this._lastInt = 1; };
  PlaneRenderer.prototype.milestone = function (n) { this._kick = 0.3; this._flash = 0.5; this._flashCol = n >= 50 ? C.magenta : C.gold; this.label.text = n >= 100 ? "STRATOSPHERE" : n >= 50 ? "SOARING" : "FLYING"; this.label.alpha = 1; this.label.style.fill = n >= 50 ? C.magenta : C.gold; this._ring(this.W / 2, this.H * 0.34, n >= 50 ? C.magenta : C.gold, 500, 0.5); };
  PlaneRenderer.prototype.nearMiss = function (a, b) { this._flash = 1; this._flashCol = C.white; this._shake = 14; this.subText.text = "SO CLOSE — cashed " + a.toFixed(2) + "x, flew @ " + b.toFixed(2) + "x"; this.subText.style.fill = C.gold; };
  PlaneRenderer.prototype.crash = function (crashMult, instant) {
    this._mult = crashMult; this.setState("crashed"); this._crashing = 0.5; this._planeOff = 0; this._instant = !!instant;
    this.multText.text = crashMult.toFixed(2) + "x"; this.multText.style.fill = C.red; this.multText.style.dropShadowColor = C.red; this.multWrap.scale.set(1.5);
    this.subText.text = instant ? "NOPE." : "FLEW AWAY!"; this.subText.style.fill = C.red; this.label.alpha = 0; this._winT = 0; this.winNum.alpha = 0; this.winGlow.alpha = 0; this.banner.alpha = 0;
    this._flash = 1; this._flashCol = instant ? C.red : C.white; this._shake = instant ? 10 : 22; this.vig.alpha = 0.55;
    if (!instant) this._ring(this._px, this._py, C.red, 700, 0.6);
  };
  PlaneRenderer.prototype.reset = function () { this._mult = 1; this._crashing = 0; this._planeOff = 0; this._instant = false; this.plane.alpha = 1; this._trail = []; this._lastInt = 1; this._winT = 0; this._rayLife = 0;
    this._placePlane(1); this.multWrap.scale.set(1); this.multText.style.fill = C.white; this.multText.style.dropShadowColor = C.cyan; this.vig.alpha = 0; this.label.alpha = 0; this.winNum.alpha = 0; this.winGlow.alpha = 0; this.banner.alpha = 0; };
  PlaneRenderer.prototype.setQuality = function (q) { this.lowq = q === "low"; };
  // Pause/resume the Pixi ticker so an off-channel Plane burns no CPU (the ticker
  // clamps elapsed time, so resuming after a long pause won't jump the flight).
  PlaneRenderer.prototype.pause = function () { try { this.app.ticker.stop(); } catch (e) {} };
  PlaneRenderer.prototype.resume = function () { try { this.app.ticker.start(); } catch (e) {} };

  root.PlaneRenderer = PlaneRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
