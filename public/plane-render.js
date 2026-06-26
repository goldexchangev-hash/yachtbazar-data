/* ============================================================
   plane-render.js — "PLANE v2 (JETLINE)": PixiJS visualization. All original,
   procedural art (no external assets): a neon delta interceptor that draws its
   own glowing equity curve up a sky that climbs from neon dusk into deep space,
   with a contrail, particle bursts, screen shake, milestone tiers, near-miss
   stings and two crash variants. Never sees the crash point until it happens.

   One ticker drives everything; the UI registers onTick and calls the hooks.
   globalThis.PlaneRenderer
   ============================================================ */
(function (root) {
  "use strict";
  const PIXI = root.PIXI;
  const ADD = PIXI.BLEND_MODES.ADD;
  const C = {
    cyan: 0x39e7ff, magenta: 0xff4d9d, gold: 0xffd23f, green: 0x45f0a6, red: 0xff2a4a, white: 0xffffff,
    ink: 0xeaf2ff, muted: 0x9aa7c7, hull: 0x1b2240, hullHi: 0x39507e,
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function gradTex(w, h, stops) {
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d"); const g = ctx.createLinearGradient(0, 0, 0, h);
    for (const s of stops) g.addColorStop(s[0], s[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); return PIXI.Texture.from(cv);
  }

  function PlaneRenderer(opts) {
    const W = this.W = opts.width || 680, H = this.H = opts.height || 420;
    this.onTick = opts.onTick || function () {};
    this.ox = 56; this.oy = H - 52; this.mx = W * 0.66; this.my = H * 0.26;
    this._mult = 1; this._state = "betting"; this._t = 0;
    this._shake = 0; this._flash = 0; this._flashCol = C.green;
    this._crashing = 0; this._instant = false; this._planeOff = 0;
    this._trail = []; this._coins = []; this._rings = []; this._floats = [];
    this._targets = []; this._cd = 0; this._cdTotal = 5; this._scroll = 0; this._cashGlow = 0; this._kick = 0;

    const app = new PIXI.Application({ width: W, height: H, backgroundColor: 0x06091a, antialias: true,
      resolution: Math.min(2, root.devicePixelRatio || 1), autoDensity: true });
    this.app = app; this.view = app.view; if (opts.mount) opts.mount.appendChild(app.view);

    // ---- sky: cross-faded gradient sprites (dusk -> deep space) ----
    this.skyDusk = new PIXI.Sprite(gradTex(8, H, [[0, "#241a52"], [0.5, "#3a1f63"], [1, "#15294e"]]));
    this.skySpace = new PIXI.Sprite(gradTex(8, H, [[0, "#05030f"], [0.45, "#160a30"], [1, "#2a0b3a"]]));
    this.skyDusk.width = this.skySpace.width = W; this.skyDusk.height = this.skySpace.height = H;
    this.skySpace.alpha = 0; app.stage.addChild(this.skyDusk, this.skySpace);

    // sun/aurora glow (additive)
    this.sun = new PIXI.Graphics(); this.sun.blendMode = ADD;
    for (let i = 6; i >= 1; i--) this.sun.beginFill(0xff7a3d, 0.035).drawCircle(W * 0.8, H * 0.78, i * 24).endFill();
    app.stage.addChild(this.sun);

    // stars (fade in with altitude) + clouds (fade out)
    this.stars = new PIXI.Container(); this.stars.alpha = 0; app.stage.addChild(this.stars);
    for (let i = 0; i < 70; i++) { const s = new PIXI.Graphics(); s.beginFill(0xffffff).drawCircle(0, 0, Math.random() < 0.18 ? 1.7 : 1).endFill();
      s.x = Math.random() * W; s.y = Math.random() * H * 0.92; s.tw = Math.random() * 6.28; s.base = 0.4 + Math.random() * 0.6; this.stars.addChild(s); }
    this.clouds = new PIXI.Container(); app.stage.addChild(this.clouds);
    for (let i = 0; i < 4; i++) { const cl = new PIXI.Graphics(); cl.beginFill(0xffffff, 0.06).drawEllipse(0, 0, 80, 22).drawEllipse(46, 8, 54, 18).drawEllipse(-46, 6, 50, 16).endFill();
      cl.x = Math.random() * W; cl.y = 40 + Math.random() * H * 0.5; cl.spd = 7 + Math.random() * 12; this.clouds.addChild(cl); }

    // grid (faint, scrolls)
    this.grid = new PIXI.Graphics(); this.grid.alpha = 0.5; app.stage.addChild(this.grid);

    const world = new PIXI.Container(); app.stage.addChild(world); this.world = world;
    this.trailG = new PIXI.Graphics(); this.trailG.blendMode = ADD; world.addChild(this.trailG);
    this.curveG = new PIXI.Graphics(); world.addChild(this.curveG);
    this.targetG = new PIXI.Graphics(); world.addChild(this.targetG);

    // plane (layered neon delta interceptor)
    this.plane = new PIXI.Container();
    this.thruster = new PIXI.Graphics(); this.thruster.blendMode = ADD; this.plane.addChild(this.thruster);
    const body = new PIXI.Graphics();
    body.beginFill(C.hull).drawPolygon([-20, 0, 16, -7, 24, 0, 16, 7]).endFill();                 // fuselage
    body.beginFill(0x2a3358).drawPolygon([-6, -2, 12, -22, 18, -19, 2, -2]).endFill();             // top wing
    body.beginFill(C.magenta, 0.9).drawPolygon([-6, 2, 10, 18, 16, 15, 2, 2]).endFill();           // under wing (magenta)
    body.lineStyle(2, C.cyan, 0.95).moveTo(-18, -1).lineTo(20, -4);                                 // cyan leading edge
    body.lineStyle(0).beginFill(C.cyan).drawCircle(12, -2, 3).endFill();                            // canopy
    this.planeBody = body; this.plane.addChild(body);
    this.rim = new PIXI.Graphics(); this.rim.blendMode = ADD; this.rim.alpha = 0; this.plane.addChild(this.rim);
    this.rim.lineStyle(2, C.white, 0.9).drawPolygon([-20, 0, 16, -7, 24, 0, 16, 7]);
    world.addChild(this.plane);

    // fx additive layer
    this.fx = new PIXI.Container(); this.fx.blendMode = ADD; app.stage.addChild(this.fx);

    // HUD (not scrolled)
    this.multText = new PIXI.Text("1.00x", { fontFamily: '"Press Start 2P","Bungee",monospace', fontSize: 56, fill: C.white,
      dropShadow: true, dropShadowColor: C.cyan, dropShadowBlur: 18, dropShadowDistance: 0, dropShadowAlpha: 1 });
    this.multText.anchor.set(0.5); this.multText.position.set(W / 2, H * 0.34); app.stage.addChild(this.multText);
    this.label = new PIXI.Text("", { fontFamily: '"Press Start 2P",monospace', fontSize: 12, fill: C.gold, dropShadow: true, dropShadowColor: 0x000, dropShadowBlur: 4, dropShadowDistance: 0 });
    this.label.anchor.set(0.5); this.label.position.set(W / 2, H * 0.34 - 44); this.label.alpha = 0; app.stage.addChild(this.label);
    this.subText = new PIXI.Text("", { fontFamily: '"Press Start 2P",monospace', fontSize: 12, fill: C.muted, align: "center" });
    this.subText.anchor.set(0.5); this.subText.position.set(W / 2, H * 0.34 + 44); app.stage.addChild(this.subText);
    this.ring = new PIXI.Graphics(); this.ring.position.set(W / 2, H * 0.34); app.stage.addChild(this.ring);

    // vignette + flash
    this.vig = new PIXI.Graphics(); this.vig.beginFill(C.red, 1).drawRect(0, 0, W, H).endFill(); this.vig.alpha = 0;
    this.vig.tint = C.red; app.stage.addChild(this.vig);
    this.flash = new PIXI.Graphics(); this.flash.beginFill(0xffffff).drawRect(0, 0, W, H).endFill(); this.flash.alpha = 0; this.flash.blendMode = ADD; app.stage.addChild(this.flash);

    this._lastInt = 1; this._placePlane(1); this._drawGrid();
    app.ticker.add(() => this._frame(app.ticker.deltaMS / 1000));
  }

  /* ---------------- geometry ---------------- */
  PlaneRenderer.prototype._pos = function (mult) {
    const p = clamp(Math.log(Math.max(1, mult)) / Math.log(12), 0, 1);
    const e = 1 - (1 - p) * (1 - p);
    return { x: lerp(this.ox, this.mx, e), y: lerp(this.oy, this.my, e), p };
  };
  PlaneRenderer.prototype._placePlane = function (mult) { const q = this._pos(mult); this._px = q.x; this._py = q.y; };

  PlaneRenderer.prototype._drawGrid = function () {
    const g = this.grid; g.clear(); g.lineStyle(1, 0x39507e, 0.18);
    const off = (this._scroll % 48);
    for (let x = -off; x < this.W; x += 48) g.moveTo(x, 0).lineTo(x, this.H);
    for (let y = this.H - off; y > 0; y -= 48) g.moveTo(0, y).lineTo(this.W, y);
  };

  /* ---------------- per-frame ---------------- */
  PlaneRenderer.prototype._frame = function (dt) {
    this._t += dt; this.onTick(dt);
    const m = this._mult, alt = clamp(Math.log(Math.max(1, m)) / Math.log(1000), 0, 1);
    const flying = this._state === "flying";

    // sky cross-fade + stars/clouds by altitude
    this.skySpace.alpha = clamp(alt * 1.6, 0, 1);
    this.stars.alpha = clamp((alt - 0.05) * 2.2, 0, 1);
    this.sun.alpha = clamp(1 - alt * 2.2, 0, 1);
    for (const s of this.stars.children) s.alpha = (0.3 + 0.7 * Math.abs(Math.sin(this._t * 1.6 + s.tw))) * s.base;
    const cloudFade = clamp(1 - (Math.log(Math.max(1, m)) / Math.log(8)), 0, 1);
    this.clouds.alpha = cloudFade;
    const spd = flying ? (30 + m * 14) : 8;
    for (const cl of this.clouds.children) { cl.x -= cl.spd * (flying ? 3 : 1) * dt; if (cl.x < -140) cl.x = this.W + 140; }
    if (flying) { this._scroll += spd * dt; this._drawGrid(); }

    // plane follow + bob + bank + vibrate at apex
    let tx, ty, rot = 0;
    if (this._crashing > 0) {
      this._crashing -= dt; this._planeOff += dt;
      if (this._instant) { tx = this._px; ty = this._py + this._planeOff * 480; rot = 1.3; }
      else { tx = this._px + this._planeOff * 620; ty = this._py - this._planeOff * 430; rot = -0.6; }
      this.plane.alpha = clamp(this._crashing / 0.45, 0, 1);
    } else {
      const q = this._pos(m); const bob = Math.sin(this._t * 4.5) * (this._state === "betting" ? 3 : 2 + q.p * 3);
      const vib = q.p > 0.95 ? (Math.random() - 0.5) * (m > 20 ? 5 : 2) : 0;
      this._px = lerp(this._px, q.x, 0.3); this._py = lerp(this._py, q.y, 0.3);
      tx = this._px + vib; ty = this._py + bob + vib;
      const ahead = this._pos(m * 1.18); rot = clamp(Math.atan2(ahead.y - q.y, ahead.x - q.x), -0.9, 0.05);
      this.plane.alpha = 1;
    }
    this.plane.position.set(tx, ty); this.plane.rotation = rot;
    this.planeBody.rotation = Math.sin(this._t * 3) * 0.06; // wing bank wobble
    // thruster scales with mult
    const tl = 10 + clamp(Math.log(m) * 6, 0, 40);
    this.thruster.clear(); this.thruster.beginFill(C.gold, 0.5).drawPolygon([-20, 0, -20 - tl, -4 - Math.random() * 2, -20 - tl * 1.3, 0, -20 - tl, 4 + Math.random() * 2]).endFill();
    this.thruster.beginFill(C.white, 0.5).drawPolygon([-20, 0, -20 - tl * 0.5, -2, -20 - tl * 0.7, 0, -20 - tl * 0.5, 2]).endFill();
    this.rim.alpha = clamp((m - 15) / 30, 0, 0.9);

    // trail
    if (flying && this._crashing <= 0) { this._trail.push({ x: tx, y: ty }); if (this._trail.length > 64) this._trail.shift(); }
    this._drawTrail(m);
    this._drawCurve(m);
    this._drawTargets();

    // multiplier visuals
    if (flying) {
      const tier = m < 2 ? C.cyan : m < 5 ? C.white : m < 20 ? C.gold : C.magenta;
      this.multText.style.fill = m > 100 ? C.white : tier;
      this.multText.style.dropShadowColor = tier;
      const base = 1 + clamp(Math.log(m) * 0.05, 0, 0.7);
      const jit = m > 10 ? (Math.random() - 0.5) * 0.04 * (m / 20) : 0;
      this.multText.scale.set(base + this._kick + jit);
      // red danger vignette breathing with mult
      this.vig.tint = C.red; this.vig.alpha = clamp((Math.log(Math.max(1, m)) / Math.log(40)) * 0.5, 0, 0.5) * (0.7 + 0.3 * Math.sin(this._t * 8));
    } else if (this._state !== "crashed") { this.vig.alpha = lerp(this.vig.alpha, 0, 0.2); }
    if (this._kick > 0) this._kick *= 0.82;

    // countdown ring
    this.ring.clear();
    if (this._state === "betting" && this._cd > 0) {
      const frac = clamp(this._cd / this._cdTotal, 0, 1), col = this._cd < 1 ? C.red : this._cd < 1.6 ? C.gold : C.cyan;
      this.ring.lineStyle(5, 0x223455, 0.6).drawCircle(0, 0, 70);
      this.ring.lineStyle(5, col, 0.95).arc(0, 0, 70, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    }

    // particles
    this._stepParticles(dt);

    // shake
    if (this._shake > 0.3) { this.app.stage.position.set((Math.random() - 0.5) * this._shake, (Math.random() - 0.5) * this._shake); this._shake *= 0.86; }
    else if (this.app.stage.position.x || this.app.stage.position.y) { this.app.stage.position.set(0, 0); this._shake = 0; }

    if (this._flash > 0.01) { this.flash.tint = this._flashCol; this.flash.alpha = this._flash * 0.5; this._flash *= 0.86; } else this.flash.alpha = 0;
    if (this._cashGlow > 0) this._cashGlow *= 0.92;
  };

  PlaneRenderer.prototype._drawTrail = function (m) {
    const g = this.trailG; g.clear(); if (this._trail.length < 2) return;
    const col = m < 5 ? C.cyan : m < 20 ? C.gold : C.magenta;
    for (let pass = 0; pass < 2; pass++) {
      const wdt = pass === 0 ? 10 : 4, al = pass === 0 ? 0.10 : 0.5;
      for (let i = 1; i < this._trail.length; i++) {
        const a = al * (i / this._trail.length);
        g.lineStyle(wdt * (i / this._trail.length) + 1, pass === 0 ? col : C.white, a);
        g.moveTo(this._trail[i - 1].x, this._trail[i - 1].y).lineTo(this._trail[i].x, this._trail[i].y);
      }
    }
  };

  PlaneRenderer.prototype._drawCurve = function (m) {
    const g = this.curveG; g.clear();
    if (this._state === "betting") return;
    const E = root.PlaneEngine; const px = this._px, py = this._py;
    const col = (this._state === "crashed" || this._crashing > 0) ? C.red : C.magenta;
    // sample the real engine curve from origin to the plane
    const N = 36, pts = [];
    const tEnd = E ? E.timeForMultiplier(Math.max(1, m)) : 1;
    for (let i = 0; i <= N; i++) {
      const mm = E ? E.multiplierAtTime((i / N) * tEnd) : 1 + (i / N) * (m - 1);
      const q = this._pos(mm); pts.push(q);
    }
    pts[pts.length - 1] = { x: px, y: py };
    // fill under curve
    g.beginFill(col, 0.15); g.moveTo(this.ox, this.oy); for (const q of pts) g.lineTo(q.x, q.y); g.lineTo(px, this.oy); g.closePath(); g.endFill();
    // 3 stacked passes (faked neon)
    const passes = [[10, col, 0.12, ADD], [6, C.cyan, 0.22, ADD], [2.6, C.white, 1, PIXI.BLEND_MODES.NORMAL]];
    for (const [wdt, c, al, bl] of passes) {
      g.blendMode = bl; g.lineStyle(wdt, c, al); g.moveTo(this.ox, this.oy); for (const q of pts) g.lineTo(q.x, q.y);
    }
    g.blendMode = PIXI.BLEND_MODES.NORMAL;
    // leading dot welded to nose
    g.beginFill(C.white).drawCircle(px, py, 4).endFill();
  };

  PlaneRenderer.prototype._drawTargets = function () {
    const g = this.targetG; g.clear();
    for (const t of this._targets) {
      const q = this._pos(t.mult), near = clamp(1 - Math.abs(t.mult - this._mult) / Math.max(0.5, t.mult * 0.4), 0, 1);
      g.lineStyle(2, t.color, 0.3 + 0.6 * near);
      for (let x = this.ox; x < this.W; x += 14) g.moveTo(x, q.y).lineTo(x + 7, q.y);
    }
  };

  PlaneRenderer.prototype._stepParticles = function (dt) {
    for (let i = this._coins.length - 1; i >= 0; i--) { const p = this._coins[i]; p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; p.rot += p.vr * dt;
      p.g.position.set(p.x, p.y); p.g.rotation = p.rot; p.g.alpha = clamp(p.life / 0.4, 0, 1);
      if (p.life <= 0 || p.y > this.H + 40) { this.fx.removeChild(p.g); p.g.destroy(); this._coins.splice(i, 1); } }
    for (let i = this._rings.length - 1; i >= 0; i--) { const r = this._rings[i]; r.rad += r.spd * dt; r.life -= dt;
      r.g.clear(); r.g.lineStyle(clamp(r.life * 8, 1, 7), r.col, clamp(r.life, 0, 1)).drawCircle(r.x, r.y, r.rad);
      if (r.life <= 0) { this.fx.removeChild(r.g); r.g.destroy(); this._rings.splice(i, 1); } }
    for (let i = this._floats.length - 1; i >= 0; i--) { const f = this._floats[i]; f.life -= dt; f.g.y -= 46 * dt; f.g.alpha = clamp(f.life / 0.5, 0, 1);
      const k = clamp((0.9 - f.life) / 0.2, 0, 1); f.g.scale.set(0.6 + 0.6 * (1 - (1 - k) * (1 - k)));
      if (f.life <= 0) { this.fx.removeChild(f.g); f.g.destroy(); this._floats.splice(i, 1); } }
  };

  /* ---------------- API ---------------- */
  PlaneRenderer.prototype.setState = function (s) { this._state = s; if (s === "flying") { this._crashing = 0; this._planeOff = 0; this.plane.alpha = 1; } };
  PlaneRenderer.prototype.setCountdown = function (secs, total) { this._state = "betting"; this._cd = secs; this._cdTotal = total || this._cdTotal; this._mult = 1; this._placePlane(1);
    this.multText.text = secs.toFixed(1); this.multText.scale.set(0.62); this.multText.style.fill = C.cyan; this.multText.style.dropShadowColor = C.cyan;
    this.subText.text = "place your bet"; this.subText.style.fill = C.muted; this.label.alpha = 0; this.vig.alpha = 0; };
  PlaneRenderer.prototype.takeoff = function () { this._state = "takeoff"; this.multText.text = "TAKING OFF"; this.multText.scale.set(0.5); this.multText.style.fill = C.gold; this.subText.text = ""; this.ring.clear(); this._shake = 3; };
  PlaneRenderer.prototype.flying = function () { this.setState("flying"); this._trail = []; this.subText.text = "CASH OUT before it flies away!"; this.subText.style.fill = C.gold; this.multText.scale.set(1); this._kick = 0.2; };
  PlaneRenderer.prototype.setLive = function (mult) { this._mult = mult; this.multText.text = mult.toFixed(2) + "x";
    const fl = Math.floor(mult); if (fl > this._lastInt) { this._lastInt = fl; this._kick = 0.16; } };
  PlaneRenderer.prototype.getRenderedMultiplier = function () { return this._mult; };
  PlaneRenderer.prototype.setTargets = function (list) { this._targets = list || []; };

  PlaneRenderer.prototype.cashOut = function (profit) {
    this._flash = 1; this._flashCol = C.green; this._cashGlow = 1;
    this.subText.text = ""; this.multText.style.fill = C.green;
    this._ring2(this._px, this._py, C.green, 560);
    const n = clamp(12 + Math.round((profit || 0) * 0.5), 12, 40);
    for (let i = 0; i < n; i++) this._coin(this._px, this._py);
    if (profit != null) this._float("+$" + (Math.round(profit * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), C.green);
  };
  PlaneRenderer.prototype.milestone = function (n) {
    this._kick = 0.3; this._flash = 0.5; this._flashCol = n >= 50 ? C.magenta : C.gold;
    this.label.text = n >= 100 ? "STRATOSPHERE" : n >= 50 ? "SOARING" : "FLYING"; this.label.alpha = 1;
    this.label.style.fill = n >= 50 ? C.magenta : C.gold;
  };
  PlaneRenderer.prototype.nearMiss = function (cashedAt, crashAt) {
    this._flash = 1; this._flashCol = C.white; this._shake = 14;
    this.subText.text = "SO CLOSE — cashed " + cashedAt.toFixed(2) + "x, flew @ " + crashAt.toFixed(2) + "x"; this.subText.style.fill = C.gold;
  };
  PlaneRenderer.prototype.crash = function (crashMult, instant) {
    this._mult = crashMult; this.setState("crashed"); this._crashing = 0.5; this._planeOff = 0; this._instant = !!instant;
    this.multText.text = crashMult.toFixed(2) + "x"; this.multText.style.fill = C.red; this.multText.style.dropShadowColor = C.red; this.multText.scale.set(1.5);
    this.subText.text = instant ? "NOPE." : "FLEW AWAY!"; this.subText.style.fill = C.red; this.label.alpha = 0;
    this._flash = 1; this._flashCol = instant ? C.red : C.white; this._shake = instant ? 10 : 22; this.vig.alpha = 0.5;
    if (!instant) this._ring2(this._px, this._py, C.red, 680);
    // smoke puffs
    for (let i = 0; i < 10; i++) { const c = this._coin(this._px, this._py); }
  };
  PlaneRenderer.prototype.reset = function () { this._mult = 1; this._crashing = 0; this._planeOff = 0; this._instant = false; this.plane.alpha = 1;
    this._trail = []; this._lastInt = 1; this._placePlane(1); this.multText.scale.set(1); this.multText.style.fill = C.white; this.multText.style.dropShadowColor = C.cyan; this.vig.alpha = 0; this.label.alpha = 0; };

  PlaneRenderer.prototype._coin = function (x, y) {
    const g = new PIXI.Graphics(); g.beginFill(C.gold).drawCircle(0, 0, 6 + Math.random() * 3).endFill(); g.beginFill(0xfff3b0).drawCircle(-1, -1, 2.4).endFill();
    g.position.set(x, y); this.fx.addChild(g);
    const a = Math.random() * 6.28, s = 120 + Math.random() * 360;
    this._coins.push({ g, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, rot: 0, vr: (Math.random() - 0.5) * 12, life: 0.8 + Math.random() * 0.7 });
    return g;
  };
  PlaneRenderer.prototype._ring2 = function (x, y, col, spd) { const g = new PIXI.Graphics(); this.fx.addChild(g); this._rings.push({ g, x, y, rad: 12, spd: spd || 600, life: 0.6, col }); };
  PlaneRenderer.prototype._float = function (txt, col) {
    const t = new PIXI.Text(txt, { fontFamily: '"Bungee",monospace', fontSize: 30, fill: col, dropShadow: true, dropShadowColor: 0x000, dropShadowBlur: 6, dropShadowDistance: 0 });
    t.anchor.set(0.5); t.position.set(this.W / 2, this.H * 0.34); this.fx.addChild(t); this._floats.push({ g: t, life: 1.1 });
  };

  root.PlaneRenderer = PlaneRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
