/* ============================================================================
 * crash-render.js — neon pixel-art crash scene renderer (Canvas 2D, no deps)
 *
 * Self-contained renderer: a starfield + neon-grid background, a chunky 64-bit
 * pixel-art rocket with a layered flame exhaust, a glowing trajectory trail,
 * and explosion / cash-out particle bursts. It owns a single rAF loop and draws
 * from a `scene` object the game controller updates each frame.
 *
 * API (window.CrashRender):
 *   init(canvasEl)          — attach + start the loop (sizes to the canvas box)
 *   onFrame(fn)             — fn(dtSeconds) called each frame BEFORE drawing
 *   setMult(m) / setState(s)— s: 'idle' | 'flying' | 'cashed' | 'crashed'
 *   explode() / cashout()   — trigger FX at the rocket's current position
 *   reset()                 — clear trail/flame/fx, mult→1, state→idle
 *   rocketPos()             — {x,y} of the rocket in CSS px (for HUD anchoring)
 * ==========================================================================*/
(function (root) {
  "use strict";

  const PAL = {
    cyan: "#00eaff", cyanDim: "#0a7d99", magenta: "#ff3c78", magenta2: "#ff5d8f",
    gold: "#ffe34d", green: "#39ff9e", white: "#ffffff", ink: "#0b0c1a",
    steelHi: "#e9f6ff", steel: "#aeccdb", steelMid: "#7fa9c4", steelLo: "#3d5a86",
    flameCore: "#ffffff", flameWhite: "#fff7d6", flameY: "#ffe34d",
    flameO: "#ff9a30", flameR: "#ff3c78", flameDeep: "#b3185a", smoke: "#3a3550",
  };
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => (a + Math.random() * (b - a + 1)) | 0;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
  const easeInQuad = (t) => t * t;

  let canvas = null, ctx = null, VW = 0, VH = 0, DPR = 1, running = false, last = 0;
  let onFrameCb = null;
  const scene = { mult: 1, state: "idle" };
  const rocket = { x: 0, y: 0, angle: -Math.PI / 4, scale: 4 };
  const fx = [];
  const trail = [];
  let STARS = [], gridScroll = 0;
  const flame = new (FlameEmitterCtor())();

  // ---- canvas sizing (to the element's CSS box, DPR-aware, crisp pixels) ----
  function resize() {
    const r = canvas.getBoundingClientRect();
    VW = Math.max(1, Math.round(r.width));
    VH = Math.max(1, Math.round(r.height));
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(VW * DPR);
    canvas.height = Math.floor(VH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = false;
    buildStars();
  }

  // ---- rocket sprite (pixel-art, returns tail anchor for the flame) ----------
  function drawRocket(x, y, angle, scale, t) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 2);
    const wob = Math.sin(t * 2.2) * 0.025 + Math.sin(t * 5.7) * 0.012;
    ctx.rotate(wob);
    ctx.scale(scale, scale);
    const px = (gx, gy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(gx, gy, w, h); };
    ctx.fillStyle = PAL.ink; ctx.beginPath(); hull(); ctx.fill();
    const bt = -9, bb = 10;
    px(-4, bt, 8, bb - bt, PAL.steel);
    px(-4, bt, 2, bb - bt, PAL.steelMid);
    px(-4, bt, 1, bb - bt, PAL.steelLo);
    px(3, bt, 1, bb - bt, PAL.steelMid);
    px(0, bt, 1, bb - bt, PAL.steelHi);
    px(-1, bt, 1, bb - bt, PAL.steel);
    const nose = [{ y: -13, x: -1, w: 2 }, { y: -12, x: -2, w: 4 }, { y: -11, x: -3, w: 6 }, { y: -10, x: -4, w: 8 }];
    for (const r of nose) px(r.x, r.y, r.w, 1, PAL.magenta);
    px(-3, -10, 2, 1, PAL.magenta2); px(-1, -12, 1, 2, PAL.white); px(2, -10, 2, 1, "#c01f53");
    px(-4, -9, 8, 1, PAL.gold); px(-4, -9, 2, 1, "#b89a14");
    const wy = -5;
    px(-3, wy - 2, 6, 5, "#1b2b4a"); px(-2, wy - 2, 4, 1, "#27406b");
    px(-2, wy - 1, 4, 3, PAL.cyan); px(-2, wy - 1, 4, 1, "#7ff6ff"); px(1, wy, 1, 2, PAL.cyanDim);
    const glint = Math.sin(t * 1.7) * 0.5 + 0.5, gx = Math.round(lerp(-2, 1, glint));
    px(gx, wy - 1, 1, 1, PAL.white); px(gx, wy, 1, 1, "#dffbff");
    ctx.fillStyle = PAL.ink; ctx.fillRect(-8, 4, 1, 7);
    px(-7, 4, 3, 1, PAL.magenta2); px(-7, 5, 3, 6, PAL.magenta); px(-7, 5, 1, 6, PAL.magenta2); px(-7, 10, 3, 1, PAL.gold);
    ctx.fillStyle = PAL.ink; ctx.fillRect(7, 4, 1, 7);
    px(4, 4, 3, 1, "#c01f53"); px(4, 5, 3, 6, PAL.magenta); px(6, 5, 1, 6, "#a81848"); px(4, 10, 3, 1, PAL.gold);
    px(-7, 6, 1, 1, Math.sin(t * 6) > 0.2 ? PAL.green : "#0d4d33");
    px(6, 6, 1, 1, Math.sin(t * 6 + 1.5) > 0.2 ? PAL.cyan : "#0a4a55");
    px(-3, 10, 6, 1, PAL.steelLo); px(-2, 11, 4, 1, "#23314f"); px(-1, 11, 2, 1, "#11151f");
    px(-3, 1, 6, 1, PAL.steelLo); px(-2, 3, 1, 1, PAL.cyan); px(1, 3, 1, 1, PAL.cyan); px(-1, 7, 2, 1, PAL.gold);
    ctx.restore();
    return tailAnchor(x, y, angle, scale, wob);
  }
  function hull() {
    const p = [[-2, -14], [2, -14], [5, -9], [5, 3], [8, 4], [8, 11], [5, 11], [4, 12], [-4, 12], [-5, 11], [-8, 11], [-8, 4], [-5, 3], [-5, -9]];
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.closePath();
  }
  function tailAnchor(x, y, angle, scale, wob) {
    const a = angle + Math.PI / 2 + wob, sin = Math.sin(a), cos = Math.cos(a), tl = 11.5 * scale;
    return { x: x - sin * tl, y: y + cos * tl, dirX: -Math.cos(angle), dirY: -Math.sin(angle), a: angle };
  }

  // ---- flame emitter (defined via factory so it can sit above in module init) -
  function FlameEmitterCtor() {
    function heat(a) {
      if (a < 0.18) return PAL.flameCore; if (a < 0.35) return PAL.flameWhite;
      if (a < 0.55) return PAL.flameY; if (a < 0.75) return PAL.flameO;
      if (a < 0.9) return PAL.flameR; return PAL.flameDeep;
    }
    function tongue(c, len, wid, t) {
      ctx.fillStyle = c; const segs = 7; ctx.beginPath(); ctx.moveTo(0, -wid * 0.5);
      for (let i = 1; i <= segs; i++) { const f = i / segs, x = len * f, fl = Math.sin(t * 30 + i * 1.7) * 0.18 + 1; ctx.lineTo(x, -wid * (1 - easeOutCubic(f)) * 0.5 * fl); }
      for (let i = segs; i >= 1; i--) { const f = i / segs, x = len * f, fl = Math.sin(t * 30 + i * 1.7 + 3.1) * 0.18 + 1; ctx.lineTo(x, wid * (1 - easeOutCubic(f)) * 0.5 * fl); }
      ctx.closePath(); ctx.fill();
    }
    return class FlameEmitter {
      constructor() { this.parts = []; this.MAX = 220; this.spawnAcc = 0; this.anchor = null; this.thrust = 0; }
      update(anchor, thrust, dt) {
        this.anchor = anchor; this.thrust = thrust;
        const rate = 140 * clamp(thrust, 0, 1.4); this.spawnAcc += rate * dt;
        let n = this.spawnAcc | 0; this.spawnAcc -= n;
        const ax = anchor.x, ay = anchor.y, dx = anchor.dirX, dy = anchor.dirY, pxn = -dy, pyn = dx;
        const base = lerp(60, 240, clamp(thrust, 0, 1.4) / 1.4);
        while (n-- > 0 && this.parts.length < this.MAX) {
          const smoke = Math.random() < 0.18, spread = rand(-1, 1), spd = base * rand(0.6, 1.15), off = rand(-3, 3);
          this.parts.push({ x: ax + pxn * off, y: ay + pyn * off, vx: dx * spd + pxn * spread * 60 + rand(-12, 12), vy: dy * spd + pyn * spread * 60 + rand(-12, 12), life: 0, ttl: smoke ? rand(0.5, 0.9) : rand(0.18, 0.4), size: smoke ? rand(3, 6) : rand(2, 4.5), smoke });
        }
        for (let i = this.parts.length - 1; i >= 0; i--) {
          const p = this.parts[i]; p.life += dt;
          if (p.life >= p.ttl) { this.parts.splice(i, 1); continue; }
          p.x += p.vx * dt; p.y += p.vy * dt;
          const d = Math.pow(0.9, dt * 60); p.vx *= d; p.vy *= d;
          if (p.smoke) { p.vy -= 8 * dt; p.size += 8 * dt; }
        }
      }
      render(t) {
        const a = this.anchor; if (!a) return; const thrust = clamp(this.thrust, 0, 1.4); if (thrust <= 0.01) return;
        ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(Math.atan2(a.dirY, a.dirX)); ctx.imageSmoothingEnabled = false;
        const flick = 0.85 + Math.sin(t * 40) * 0.08 + Math.sin(t * 23.3) * 0.05;
        const len = lerp(14, 46, thrust / 1.4) * flick, wid = lerp(7, 13, thrust / 1.4);
        ctx.globalCompositeOperation = "lighter";
        const glow = ctx.createRadialGradient(len * 0.35, 0, 2, len * 0.35, 0, len * 1.2);
        glow.addColorStop(0, "rgba(255,210,120,0.55)"); glow.addColorStop(0.4, "rgba(255,120,60,0.25)"); glow.addColorStop(1, "rgba(255,60,120,0)");
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(len * 0.35, 0, len * 1.2, 0, TAU); ctx.fill();
        const layers = [[PAL.flameDeep, 1.05, 1.15], [PAL.flameR, 0.92, 1.0], [PAL.flameO, 0.74, 0.8], [PAL.flameY, 0.52, 0.6], [PAL.flameWhite, 0.32, 0.42], [PAL.flameCore, 0.18, 0.28]];
        for (const L of layers) tongue(L[0], len * L[1], wid * L[2], t);
        ctx.restore();
        ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.imageSmoothingEnabled = false;
        for (const p of this.parts) {
          const age = p.life / p.ttl;
          if (p.smoke) { ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = `rgba(58,53,80,${(1 - age) * 0.35})`; const s = p.size; ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), Math.ceil(s), Math.ceil(s)); ctx.globalCompositeOperation = "lighter"; }
          else { ctx.fillStyle = heat(age); const s = p.size * (1 - age * 0.7); ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), Math.ceil(s), Math.ceil(s)); }
        }
        ctx.restore();
      }
    };
  }

  // ---- background -----------------------------------------------------------
  function buildStars() {
    STARS = [];
    const layers = [
      { n: Math.round(VW * VH / 9000), spd: 0.10, size: 1, col: "#5566aa" },
      { n: Math.round(VW * VH / 14000), spd: 0.28, size: 1, col: "#9fb6ff" },
      { n: Math.round(VW * VH / 22000), spd: 0.6, size: 2, col: "#ffffff" },
    ];
    for (const L of layers) { const arr = []; for (let i = 0; i < L.n; i++) arr.push({ x: Math.random() * VW, y: Math.random() * VH, tw: Math.random() * TAU }); STARS.push(Object.assign({ arr }, L)); }
  }
  function nebula(x, y, r, col, phase) {
    const pr = r * (0.9 + Math.sin(phase) * 0.08), g = ctx.createRadialGradient(x, y, 0, x, y, pr);
    g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, pr, 0, TAU); ctx.fill();
  }
  function drawBackground(t, speed) {
    const g = ctx.createLinearGradient(0, 0, 0, VH);
    g.addColorStop(0, "#03040e"); g.addColorStop(0.55, "#050615"); g.addColorStop(1, "#0a0820");
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    nebula(VW * 0.25, VH * 0.3, VH * 0.5, "rgba(0,234,255,0.10)", t * 0.3);
    nebula(VW * 0.78, VH * 0.55, VH * 0.6, "rgba(255,60,120,0.09)", t * 0.21 + 2);
    nebula(VW * 0.55, VH * 0.18, VH * 0.4, "rgba(57,255,158,0.05)", t * 0.17 + 4);
    ctx.restore();
    for (const L of STARS) {
      ctx.fillStyle = L.col;
      const dx = -L.spd * (40 + speed * 120), dy = L.spd * (26 + speed * 90);
      for (const s of L.arr) {
        s.x += dx * 0.016; s.y += dy * 0.016;
        if (s.x < 0) s.x += VW; if (s.x > VW) s.x -= VW; if (s.y > VH) s.y -= VH; if (s.y < 0) s.y += VH;
        if (L.size === 2) ctx.globalAlpha = 0.6 + Math.sin(t * 3 + s.tw) * 0.4;
        ctx.fillRect(s.x | 0, s.y | 0, L.size, L.size); ctx.globalAlpha = 1;
      }
      if (L.size === 2 && speed > 0.6) {
        ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1; ctx.beginPath();
        for (const s of L.arr) { ctx.moveTo(s.x | 0, s.y | 0); ctx.lineTo((s.x - dx * 0.05) | 0, (s.y - dy * 0.05) | 0); }
        ctx.stroke();
      }
    }
    const horizon = VH * 0.74, bottom = VH;
    gridScroll = (gridScroll + (0.6 + speed * 2.2) * 0.016) % 1;
    ctx.save();
    const fgr = ctx.createLinearGradient(0, horizon, 0, bottom);
    fgr.addColorStop(0, "rgba(255,60,120,0.0)"); fgr.addColorStop(1, "rgba(255,60,120,0.06)");
    ctx.fillStyle = fgr; ctx.fillRect(0, horizon, VW, bottom - horizon);
    ctx.strokeStyle = "rgba(0,234,255,0.35)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < 14; i++) { const f = (i + gridScroll) / 14, y = horizon + (bottom - horizon) * (f * f); ctx.moveTo(0, y); ctx.lineTo(VW, y); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,60,120,0.30)"; ctx.beginPath(); const vpx = VW * 0.5;
    for (let i = -10; i <= 10; i++) { const x = vpx + i * (VW / 16); ctx.moveTo(vpx + i * 6, horizon); ctx.lineTo(x, bottom); }
    ctx.stroke(); ctx.restore();
  }

  // ---- FX -------------------------------------------------------------------
  function ExplosionFX(x, y) {
    this.x = x; this.y = y; this.t = 0; this.dead = false; this.flash = 1; this.ring = 0; this.parts = [];
    const cols = [PAL.flameWhite, PAL.flameY, PAL.flameO, PAL.flameR, PAL.gold, PAL.magenta2];
    for (let i = 0; i < 90; i++) { const a = rand(0, TAU), sp = rand(60, 420) * (0.4 + Math.random()); this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, ttl: rand(0.4, 1.1), size: rand(2, 6), col: cols[randi(0, cols.length - 1)] }); }
    for (let i = 0; i < 10; i++) { const a = rand(0, TAU), sp = rand(80, 260); this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0, ttl: rand(0.8, 1.4), size: rand(3, 6), col: PAL.steelMid, debris: true, rot: rand(0, TAU), spin: rand(-8, 8) }); }
  }
  ExplosionFX.prototype.update = function (dt) {
    this.t += dt; this.flash = Math.max(0, this.flash - dt * 5); this.ring = easeOutQuint(clamp(this.t / 0.6, 0, 1)) * 260;
    let alive = false;
    for (const p of this.parts) { p.life += dt; if (p.life >= p.ttl) continue; alive = true; p.x += p.vx * dt; p.y += p.vy * dt; const d = Math.pow(0.92, dt * 60); p.vx *= d; p.vy = p.vy * d + (p.debris ? 380 : 60) * dt; if (p.rot != null) p.rot += p.spin * dt; }
    if (!alive && this.flash <= 0 && this.t > 0.7) this.dead = true;
  };
  ExplosionFX.prototype.render = function () {
    if (this.t < 0.6) { ctx.save(); ctx.globalCompositeOperation = "lighter"; const a = 1 - this.t / 0.6; ctx.strokeStyle = `rgba(255,210,120,${a})`; ctx.lineWidth = lerp(8, 1, this.t / 0.6); ctx.beginPath(); ctx.arc(this.x, this.y, this.ring, 0, TAU); ctx.stroke(); ctx.strokeStyle = `rgba(255,60,120,${a * 0.6})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(this.x, this.y, this.ring * 0.7, 0, TAU); ctx.stroke(); ctx.restore(); }
    ctx.save();
    for (const p of this.parts) { if (p.life >= p.ttl) continue; const age = p.life / p.ttl; if (p.debris) { ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1 - age; ctx.fillStyle = p.col; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); ctx.restore(); } else { ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 1 - age; ctx.fillStyle = p.col; const s = p.size * (1 - age * 0.5); ctx.fillRect((p.x - s / 2) | 0, (p.y - s / 2) | 0, Math.ceil(s), Math.ceil(s)); } }
    ctx.globalAlpha = 1; ctx.restore();
  };
  ExplosionFX.prototype.renderFlash = function () { if (this.flash <= 0) return; ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = `rgba(255,240,210,${this.flash * 0.6})`; ctx.fillRect(0, 0, VW, VH); ctx.restore(); };

  function CashOutFX(x, y) {
    this.x = x; this.y = y; this.t = 0; this.dead = false; this.pop = 0; this.parts = [];
    for (let i = 0; i < 46; i++) { const a = rand(-Math.PI, 0) + rand(-0.3, 0.3), sp = rand(120, 340), coin = Math.random() < 0.6; this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, life: 0, ttl: rand(0.7, 1.3), size: coin ? rand(4, 7) : rand(2, 4), coin, col: coin ? PAL.gold : (Math.random() < 0.5 ? PAL.green : PAL.white), spin: rand(-12, 12), rot: rand(0, TAU), flip: rand(2, 6) }); }
  }
  CashOutFX.prototype.update = function (dt) {
    this.t += dt; this.pop = easeOutCubic(clamp(this.t / 0.35, 0, 1)); let alive = this.t < 0.5;
    for (const p of this.parts) { p.life += dt; if (p.life >= p.ttl) continue; alive = true; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.vx *= Math.pow(0.98, dt * 60); p.rot += p.spin * dt; }
    if (!alive) this.dead = true;
  };
  CashOutFX.prototype.render = function () {
    if (this.t < 0.5) { ctx.save(); ctx.globalCompositeOperation = "lighter"; const a = 1 - this.t / 0.5, r = this.pop * 90; const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r + 20); g.addColorStop(0, `rgba(57,255,158,${a * 0.5})`); g.addColorStop(0.6, `rgba(255,227,77,${a * 0.3})`); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(this.x, this.y, r + 20, 0, TAU); ctx.fill(); ctx.restore(); }
    ctx.save();
    for (const p of this.parts) {
      if (p.life >= p.ttl) continue; const age = p.life / p.ttl; ctx.globalAlpha = 1 - easeInQuad(age); ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      if (p.coin) { const w = Math.abs(Math.cos(this.t * p.flip)) * p.size + 1; ctx.fillStyle = PAL.ink; ctx.fillRect(-w / 2 - 1, -p.size / 2 - 1, w + 2, p.size + 2); ctx.fillStyle = p.col; ctx.fillRect(-w / 2, -p.size / 2, w, p.size); ctx.fillStyle = "#fff6b0"; ctx.fillRect(-w / 2, -p.size / 2, Math.max(1, w * 0.4), p.size); }
      else { ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = p.col; const s = p.size * (1 - age); ctx.fillRect(-s / 2, -0.5, s, 1); ctx.fillRect(-0.5, -s / 2, 1, s); ctx.globalCompositeOperation = "source-over"; }
      ctx.restore();
    }
    ctx.globalAlpha = 1; ctx.restore();
  };
  CashOutFX.prototype.renderFlash = function () {};

  // ---- scene mapping + trajectory + main loop -------------------------------
  function rocketPath(progress) {
    // Start above the bottom bet panel so the launch is visible from 1.00x.
    const e = easeOutCubic(clamp(progress, 0, 1));
    return { x: lerp(VW * 0.20, VW * 0.78, e), y: lerp(VH * 0.60, VH * 0.15, easeInQuad(clamp(progress, 0, 1))) };
  }
  function drawTrajectory() {
    trail.push({ x: rocket.x, y: rocket.y });
    if (trail.length > 64) trail.shift();
    if (scene.state === "crashed" && trail.length) trail.shift();
    if (trail.length < 2) return;
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath(); ctx.moveTo(trail[0].x, trail[0].y);
      for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
      ctx.strokeStyle = pass === 0 ? "rgba(0,234,255,0.10)" : "rgba(0,234,255,0.32)";
      ctx.lineWidth = pass === 0 ? 11 : 3; ctx.stroke();
    }
    ctx.restore();
  }
  function drawVignette() {
    const g = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.35, VW / 2, VH / 2, VH * 0.9);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
  }
  function frame(now) {
    if (!running) return;
    // Keep the loop alive but skip all drawing when the canvas isn't on screen
    // (another channel is active, or the tab is hidden) so it never competes
    // with the other games for the main thread on mobile.
    if (document.hidden || !canvas || !canvas.offsetParent) { last = now; requestAnimationFrame(frame); return; }
    let dt = (now - last) / 1000; last = now; dt = Math.min(dt, 0.05);
    if (onFrameCb) try { onFrameCb(dt); } catch (e) { /* keep the loop alive */ }
    const m = Math.max(1, scene.mult), t = now / 1000;
    const speed = clamp(Math.log(m) * 0.35, 0, 2.2);
    const progress = clamp(Math.log(m) / Math.log(25), 0, 1);
    const pos = rocketPath(progress);
    rocket.x = pos.x; rocket.y = pos.y;
    rocket.angle = lerp(-Math.PI * 0.2, -Math.PI * 0.42, progress);
    rocket.scale = lerp(3.0, 4.4, progress) * (VH / 800);
    const thrust = scene.state === "flying" ? clamp(0.7 + speed * 0.5, 0.4, 1.4) + Math.sin(t * 30) * 0.05 : 0;

    ctx.clearRect(0, 0, VW, VH);
    drawBackground(t, speed);
    if (scene.state === "flying" || scene.state === "cashed") drawTrajectory();
    if (scene.state !== "crashed" && scene.state !== "idle") {
      const anchor = tailAnchor(rocket.x, rocket.y, rocket.angle, rocket.scale, Math.sin(t * 2.2) * 0.025 + Math.sin(t * 5.7) * 0.012);
      flame.update(anchor, thrust, dt); flame.render(t);
      drawRocket(rocket.x, rocket.y, rocket.angle, rocket.scale, t);
    }
    for (let i = fx.length - 1; i >= 0; i--) { fx[i].update(dt); fx[i].render(); if (fx[i].dead) fx.splice(i, 1); }
    for (const f of fx) if (f.renderFlash) f.renderFlash();
    drawVignette();
    requestAnimationFrame(frame);
  }

  root.CrashRender = {
    init(el) {
      canvas = el; ctx = canvas.getContext("2d");
      resize();
      if (root.ResizeObserver) { try { new ResizeObserver(() => resize()).observe(canvas); } catch (e) {} }
      window.addEventListener("resize", resize);
      if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    },
    onFrame(fn) { onFrameCb = fn; },
    setMult(m) { scene.mult = m; },
    getMult() { return scene.mult; },
    setState(s) { scene.state = s; },
    state() { return scene.state; },
    explode() { fx.push(new ExplosionFX(rocket.x, rocket.y)); },
    cashout() { fx.push(new CashOutFX(rocket.x, rocket.y)); },
    rocketPos() { return { x: rocket.x, y: rocket.y }; },
    reset() { fx.length = 0; trail.length = 0; flame.parts.length = 0; scene.mult = 1; scene.state = "idle"; },
  };
})(typeof window !== "undefined" ? window : this);
