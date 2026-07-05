/* ============================================================================
 * crash-render.js — COSMIC crash scene renderer (Canvas 2D, no deps)
 *
 * The rocket flies a real journey as the multiplier climbs: blue daytime sky →
 * dusk → upper atmosphere → space → past the MOON → Mars → Jupiter → Saturn's
 * rings → the outer planets → and out of the solar system into interstellar
 * deep space on huge wins. A detailed pixel rocket with a layered flame, a
 * multi-stage explosion on bust, an altitude-themed cash-out burst, and a
 * universe-themed win-message helper.
 *
 * API (window.CrashRender) — UNCHANGED:
 *   init(canvasEl) · onFrame(fn) · setMult(m) · getMult() · setState(s)
 *   explode() · cashout() · reset() · rocketPos() · state()
 *   winMessage(mult)  -> { text, color, emoji }   (pure helper for the HUD)
 * ==========================================================================*/
(function (root) {
  "use strict";

  const PAL = {
    cyan: "#00eaff", cyanDim: "#0a7d99", magenta: "#ff3c78", magenta2: "#ff5d8f",
    gold: "#ffe34d", green: "#39ff9e", white: "#ffffff", ink: "#0b0c1a",
    steelHi: "#eaf6ff", steel: "#b6d2e2", steelMid: "#7fa9c4", steelLo: "#3d5a86", steelDk: "#22344f",
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
  const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
  const rgb = (c) => "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")";
  const lerpRGB = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  let canvas = null, ctx = null, VW = 0, VH = 0, DPR = 1, running = false, last = 0;
  let onFrameCb = null;
  const scene = { mult: 1, state: "idle" };
  const rocket = { x: 0, y: 0, angle: -Math.PI / 4, scale: 4, spin: 0, fall: 0, fade: 1 };
  const fx = [];
  const trail = [];
  let STARS = [], gridScroll = 0, altSmooth = 0, launchT = -1;
  let shakeMag = 0, lastTier = 1, plume = [];
  // a16: honor prefers-reduced-motion for the whole-screen camera shake + high-altitude sway (vestibular safety).
  // Read the live MediaQueryList each frame (zero cost) so a mid-session OS toggle is respected.
  const _rmq = (typeof window !== "undefined" && window.matchMedia) ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const REDUCE_MOTION = () => !!(_rmq && _rmq.matches);
  const flame = new (FlameEmitterCtor())();

  // ── cosmic altitude: 0 at 1x → 1.0 at 1000x (log so liftoff feels big) ──
  const ALT_TOP = 1000;
  const altOf = (m) => clamp(Math.log(Math.max(1, m)) / Math.log(ALT_TOP), 0, 1.15);

  // sky zones (top→bottom RGB) keyed by altitude anchor; the renderer LERPs between
  // the two bracketing zones every frame so the sky morphs with no hard pops.
  const ZONES = [
    { alt: 0.00, top: [74, 166, 255], bot: [191, 230, 255], star: 0.00, grid: 0.0 }, // daytime blue
    { alt: 0.07, top: [42, 92, 168], bot: [255, 140, 90], star: 0.05, grid: 0.35 },  // dusk
    { alt: 0.16, top: [26, 42, 85], bot: [122, 45, 107], star: 0.32, grid: 0.55 },   // upper atmosphere
    { alt: 0.23, top: [10, 17, 48], bot: [26, 20, 66], star: 0.66, grid: 0.0 },      // edge of space
    { alt: 0.36, top: [5, 7, 15], bot: [10, 10, 28], star: 0.92, grid: 0.0 },        // low orbit (moon)
    { alt: 0.49, top: [6, 5, 13], bot: [16, 7, 16], star: 1.0, grid: 0.0 },          // inner planets (mars)
    { alt: 0.61, top: [4, 4, 11], bot: [10, 5, 15], star: 1.0, grid: 0.0 },          // gas giants
    { alt: 0.77, top: [2, 3, 10], bot: [6, 3, 16], star: 1.0, grid: 0.0 },           // outer planets
    { alt: 0.92, top: [2, 1, 12], bot: [5, 2, 16], star: 1.0, grid: 0.0 },           // interstellar
  ];
  function zoneAt(alt) {
    for (let i = 0; i < ZONES.length - 1; i++) {
      if (alt <= ZONES[i + 1].alt) {
        const t = (alt - ZONES[i].alt) / (ZONES[i + 1].alt - ZONES[i].alt);
        return { a: ZONES[i], b: ZONES[i + 1], t: clamp(t, 0, 1) };
      }
    }
    const L = ZONES[ZONES.length - 1];
    return { a: L, b: L, t: 0 };
  }

  // danger color by tier: cyan → magenta → gold → red (drives shake/tint)
  function dangerColor(d) {
    if (d < 0.33) return [57, 231, 255];
    if (d < 0.66) { const k = (d - 0.33) / 0.33; return [lerp(57, 255, k) | 0, lerp(231, 77, k) | 0, lerp(255, 157, k) | 0]; }
    const k = (d - 0.66) / 0.34; return [255, lerp(77, 40, k) | 0, lerp(157, 30, k) | 0];
  }

  // ---- canvas sizing ---------------------------------------------------------
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
    bakeBodies();
  }

  /* ===================== CELESTIAL BODIES (baked offscreen) ================= */
  // Each body is pre-rendered ONCE to a small canvas, then blitted (drawImage)
  // each frame — no per-frame gradients, so even on mobile it's a couple blits.
  const BODY_DEFS = [
    { type: "moon", enter: 15, exit: 46, x: 0.72, r: 48, drift: 30, yi: -0.12, yo: 0.98 },
    { type: "mars", enter: 35, exit: 98, x: 0.23, r: 30, drift: -26, yi: -0.12, yo: 1.06 },
    { type: "jupiter", enter: 90, exit: 240, x: 0.68, r: 74, drift: 22, yi: -0.18, yo: 1.12 },
    { type: "saturn", enter: 150, exit: 360, x: 0.30, r: 50, drift: -18, yi: -0.12, yo: 1.12 },
    { type: "neptune", enter: 320, exit: 800, x: 0.70, r: 40, drift: 16, yi: -0.12, yo: 1.1 },
  ];
  let bodyCache = {};

  function bakeBodies() {
    bodyCache = {};
    const sc = clamp(VH / 720, 0.62, 1.5);
    for (const d of BODY_DEFS) bodyCache[d.type] = bakeBody(d.type, Math.round(d.r * sc));
  }
  function newCanvas(w, h) { const c = document.createElement("canvas"); c.width = Math.max(2, w | 0); c.height = Math.max(2, h | 0); return c; }
  function radial(cx, x, y, r, stops) { const g = cx.createRadialGradient(x[0], x[1], 0, y[0], y[1], r); for (const s of stops) g.addColorStop(s[0], s[1]); return g; }

  function bakeBody(type, r) {
    if (type === "saturn") return bakeSaturn(r);
    const pad = Math.ceil(r * 0.45), S = (r + pad) * 2, c = newCanvas(S, S), x = c.getContext("2d");
    const cx = S / 2, cy = S / 2;
    if (type === "moon") {
      x.fillStyle = radial(x, [cx - r * 0.32, cy - r * 0.32], [cx, cy], r, [[0, "#f6f3e8"], [0.6, "#cac7be"], [1, "#8a877f"]]);
      x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
      // craters
      for (let i = 0; i < 13; i++) {
        const a = rand(0, TAU), rr = Math.sqrt(Math.random()) * r * 0.82, px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr, cs = rand(r * 0.05, r * 0.16);
        x.fillStyle = "rgba(80,78,72,0.35)"; x.beginPath(); x.arc(px, py, cs, 0, TAU); x.fill();
        x.fillStyle = "rgba(255,255,255,0.16)"; x.beginPath(); x.arc(px - cs * 0.25, py - cs * 0.25, cs * 0.7, 0, TAU); x.fill();
      }
      // terminator shadow (lit phase)
      x.globalCompositeOperation = "source-atop";
      x.fillStyle = radial(x, [cx + r * 0.5, cy + r * 0.5], [cx + r * 0.2, cy + r * 0.2], r * 1.5, [[0, "rgba(6,6,16,0)"], [0.6, "rgba(6,6,16,0.0)"], [1, "rgba(6,6,16,0.6)"]]);
      x.fillRect(0, 0, S, S);
      x.globalCompositeOperation = "source-over";
      ringGlow(x, cx, cy, r, "rgba(255,253,240,0.5)");
    } else if (type === "mars") {
      x.fillStyle = radial(x, [cx - r * 0.3, cy - r * 0.3], [cx, cy], r, [[0, "#f0855f"], [0.55, "#c24a30"], [1, "#742017"]]);
      x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.clip();
      for (let i = 0; i < 4; i++) { x.fillStyle = "rgba(110,40,28,0.4)"; x.beginPath(); x.arc(cx + rand(-r * 0.5, r * 0.5), cy + rand(-r * 0.4, r * 0.5), rand(r * 0.2, r * 0.42), 0, TAU); x.fill(); }
      x.fillStyle = "rgba(246,239,230,0.85)"; x.beginPath(); x.arc(cx, cy - r * 0.82, r * 0.32, 0, TAU); x.fill(); // polar cap
      x.restore();
      ringGlow(x, cx, cy, r, "rgba(255,150,110,0.45)");
    } else if (type === "jupiter") {
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.clip();
      const bands = ["#e7cba0", "#bd8d5e", "#e3c79c", "#a87544", "#d9b98a", "#9c7048", "#e7cba0", "#b98a5e", "#d6b384"];
      const bh = (r * 2) / bands.length;
      for (let i = 0; i < bands.length; i++) { x.fillStyle = bands[i]; x.fillRect(cx - r, cy - r + i * bh, r * 2, bh + 1); }
      // great red spot
      x.fillStyle = radial(x, [cx + r * 0.18, cy + r * 0.16], [cx + r * 0.2, cy + r * 0.18], r * 0.4, [[0, "#c4502f"], [1, "#7c2a1c"]]);
      x.beginPath(); x.ellipse(cx + r * 0.2, cy + r * 0.18, r * 0.34, r * 0.22, 0, 0, TAU); x.fill();
      // limb darkening
      x.fillStyle = radial(x, [cx, cy], [cx, cy], r, [[0.55, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.45)"]]);
      x.fillRect(cx - r, cy - r, r * 2, r * 2);
      x.restore();
      ringGlow(x, cx, cy, r, "rgba(230,200,150,0.3)");
    } else if (type === "neptune") {
      x.fillStyle = radial(x, [cx - r * 0.3, cy - r * 0.3], [cx, cy], r, [[0, "#5b8fe0"], [0.55, "#2f6fc4"], [1, "#173f86"]]);
      x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.clip();
      x.strokeStyle = "rgba(220,240,255,0.4)"; x.lineWidth = r * 0.06;
      for (let i = -1; i <= 1; i++) { x.beginPath(); x.ellipse(cx, cy + i * r * 0.4, r * 0.95, r * 0.16, 0, 0, Math.PI); x.stroke(); }
      x.restore();
      ringGlow(x, cx, cy, r, "rgba(159,216,255,0.4)");
    }
    return c;
  }
  function ringGlow(x, cx, cy, r, col) { x.save(); x.globalCompositeOperation = "lighter"; x.strokeStyle = col; x.lineWidth = Math.max(1, r * 0.06); x.beginPath(); x.arc(cx, cy, r * 0.98, 0, TAU); x.stroke(); x.restore(); }

  function bakeSaturn(r) {
    const ringR = r * 2.15, W = Math.ceil(ringR * 2 + 8), H = Math.ceil(ringR * 0.9 + r + 8), c = newCanvas(W, H), x = c.getContext("2d");
    const cx = W / 2, cy = H / 2;
    x.translate(cx, cy); x.rotate(-0.34); x.scale(1, 0.34);
    // back rings (top half)
    drawRingArc(x, r, Math.PI, TAU);
    x.setTransform(1, 0, 0, 1, 0, 0);
    // body
    x.save(); x.translate(cx, cy);
    x.fillStyle = radial(x, [-r * 0.3, -r * 0.3], [0, 0], r, [[0, "#ead9b0"], [0.55, "#c9b07e"], [1, "#8c6f44"]]);
    x.beginPath(); x.arc(0, 0, r, 0, TAU); x.fill();
    x.save(); x.beginPath(); x.arc(0, 0, r, 0, TAU); x.clip();
    const bands = ["#ead9b0", "#cdb582", "#e0cb9a", "#b99f6e", "#dcc78f"]; const bh = (r * 2) / bands.length;
    for (let i = 0; i < bands.length; i++) { x.fillStyle = bands[i]; x.fillRect(-r, -r + i * bh, r * 2, bh + 1); }
    x.fillStyle = radial(x, [0, 0], [0, 0], r, [[0.55, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.4)"]]); x.fillRect(-r, -r, r * 2, r * 2);
    x.restore(); x.restore();
    // front rings (bottom half)
    x.save(); x.translate(cx, cy); x.rotate(-0.34); x.scale(1, 0.34);
    drawRingArc(x, r, 0, Math.PI);
    x.restore();
    return c;
  }
  function drawRingArc(x, r, a0, a1) {
    const rings = [[1.35, 1.55, "rgba(216,199,160,0.9)"], [1.58, 1.78, "rgba(184,159,116,0.85)"], [1.82, 2.12, "rgba(143,122,82,0.8)"]];
    for (const rg of rings) { x.strokeStyle = rg[2]; x.lineWidth = r * (rg[1] - rg[0]); x.beginPath(); x.arc(0, 0, r * (rg[0] + rg[1]) / 2, a0, a1); x.stroke(); }
    x.strokeStyle = "rgba(8,6,4,0.7)"; x.lineWidth = r * 0.05; x.beginPath(); x.arc(0, 0, r * 1.79, a0, a1); x.stroke(); // Cassini gap
  }

  function drawBodies(altS, t, speed) {
    for (const d of BODY_DEFS) {
      const a0 = altOf(d.enter), a1 = altOf(d.exit), bp = (altS - a0) / (a1 - a0);
      if (bp <= 0 || bp >= 1) continue;
      const img = bodyCache[d.type]; if (!img) continue;
      const fade = clamp(Math.min(bp / 0.16, (1 - bp) / 0.16, 1), 0, 1);
      const sx = lerp(0.85, 1.22, bp), y = lerp(d.yi, d.yo, easeInOutSine(bp)) * VH;
      const px = d.x * VW + Math.sin(bp * Math.PI) * d.drift;
      const w = img.width * sx, h = img.height * sx;
      ctx.save(); ctx.globalAlpha = fade;
      ctx.drawImage(img, Math.round(px - w / 2), Math.round(y - h / 2), Math.round(w), Math.round(h));
      ctx.restore();
    }
    // interstellar galaxies (cheap additive gradients, far parallax)
    if (altS > 0.84) {
      const ga = clamp((altS - 0.84) / 0.1, 0, 1);
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      galaxy(VW * 0.26, VH * 0.30, VH * 0.32, t * 0.02, ga * 0.7, "#b46cff", "#6cf0ff");
      galaxy(VW * 0.80, VH * 0.62, VH * 0.26, -t * 0.015, ga * 0.6, "#ff6cd6", "#ffd86c");
      ctx.restore();
    }
  }
  function galaxy(x, y, r, rot, a, c1, c2) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    let g = ctx.createRadialGradient(0, 0, 0, 0, 0, r); g.addColorStop(0, hexA(c1, 0.5 * a)); g.addColorStop(0.5, hexA(c1, 0.12 * a)); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.save(); ctx.scale(1, 0.42); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.restore();
    ctx.rotate(0.6); g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.8); g.addColorStop(0, hexA(c2, 0.3 * a)); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.save(); ctx.scale(1, 0.42); ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, TAU); ctx.fill(); ctx.restore();
    ctx.fillStyle = hexA("#ffffff", 0.8 * a); ctx.beginPath(); ctx.arc(0, 0, Math.max(1.5, r * 0.04), 0, TAU); ctx.fill();
    ctx.restore();
  }
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")"; }

  /* ===================== ROCKET (detailed pixel sprite) ==================== */
  function drawRocket(x, y, angle, scale, t) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 2);
    const wob = Math.sin(t * 2.2) * 0.025 + Math.sin(t * 5.7) * 0.012 + Math.sin(t * 0.8) * 0.03;
    ctx.rotate(wob + rocket.spin);
    ctx.globalAlpha = rocket.fade;
    ctx.scale(scale, scale);
    const px = (gx, gy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(gx, gy, w, h); };
    // body silhouette
    ctx.fillStyle = PAL.ink; ctx.beginPath(); hull(); ctx.fill();
    const bt = -10, bb = 11;
    // cylinder shading (left shadow → bright column → right mid)
    px(-5, bt, 10, bb - bt, PAL.steel);
    px(-5, bt, 2, bb - bt, PAL.steelLo);
    px(-3, bt, 1, bb - bt, PAL.steelMid);
    px(0, bt, 1, bb - bt, PAL.steelHi);
    px(-1, bt, 1, bb - bt, PAL.steel);
    px(4, bt, 1, bb - bt, PAL.steelMid);
    // panel seams
    px(-5, -4, 10, 1, PAL.steelDk); px(-5, 4, 10, 1, PAL.steelDk);
    // nose cone (magenta) + white spec + gold collar
    const nose = [{ y: -15, x: -1, w: 2 }, { y: -14, x: -2, w: 4 }, { y: -13, x: -3, w: 6 }, { y: -12, x: -4, w: 8 }, { y: -11, x: -5, w: 10 }];
    for (const r of nose) px(r.x, r.y, r.w, 1, PAL.magenta);
    px(-3, -12, 2, 1, PAL.magenta2); px(-1, -14, 1, 2, PAL.white); px(2, -12, 2, 1, "#c01f53");
    px(-5, -10, 10, 1, PAL.gold); px(-5, -10, 3, 1, "#b89a14");
    // red beacon on the nose (slow blink)
    px(-1, -13, 1, 1, Math.sin(t * 3) > 0.3 ? "#ff3b4e" : "#5e1320");
    // cockpit dome
    const wy = -6;
    px(-3, wy - 2, 6, 5, "#16243f"); px(-3, wy - 2, 6, 1, "#27406b");
    px(-2, wy - 1, 4, 3, PAL.cyan); px(-2, wy - 1, 4, 1, "#a8fbff"); px(1, wy, 1, 2, PAL.cyanDim);
    const glint = Math.sin(t * 1.7) * 0.5 + 0.5, gx = Math.round(lerp(-2, 1, glint));
    px(gx, wy - 1, 1, 1, PAL.white); px(gx, wy, 1, 1, "#dffbff");
    // engine skirt + nozzle
    px(-4, 8, 8, 1, PAL.steelLo); px(-3, 9, 6, 2, PAL.steelDk); px(-2, 11, 4, 1, "#11151f");
    // side fins (swept-back, magenta w/ gold tips + nav light)
    ctx.fillStyle = PAL.ink; ctx.fillRect(-9, 3, 1, 9);
    px(-8, 3, 3, 1, PAL.magenta2); px(-8, 4, 3, 7, PAL.magenta); px(-8, 4, 1, 7, PAL.magenta2); px(-8, 11, 3, 1, PAL.gold);
    px(-8, 6, 1, 1, Math.sin(t * 6) > 0.2 ? PAL.green : "#0d4d33");
    ctx.fillStyle = PAL.ink; ctx.fillRect(8, 3, 1, 9);
    px(5, 3, 3, 1, "#c01f53"); px(5, 4, 3, 7, PAL.magenta); px(7, 4, 1, 7, "#a81848"); px(5, 11, 3, 1, PAL.gold);
    px(7, 6, 1, 1, Math.sin(t * 6 + 1.5) > 0.2 ? PAL.cyan : "#0a4a55");
    // accent stripe + rivets + warning chevron
    px(-3, 1, 6, 1, PAL.steelLo); px(-2, -2, 1, 1, PAL.cyan); px(1, -2, 1, 1, PAL.cyan); px(-1, 6, 2, 1, PAL.gold);
    // hull rim-light that warms toward red with danger
    const d = clamp((scene.mult - 2) / 23, 0, 1); if (d > 0.05) { const c = dangerColor(d); px(-5, bt, 1, bb - bt, "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.5)"); }
    ctx.restore();
    return tailAnchor(x, y, angle, scale, wob + rocket.spin);
  }
  function hull() {
    const p = [[-2, -16], [2, -16], [5, -10], [5, 3], [9, 5], [9, 12], [5, 12], [4, 13], [-4, 13], [-5, 12], [-9, 12], [-9, 5], [-5, 3], [-5, -10]];
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.closePath();
  }
  function tailAnchor(x, y, angle, scale, wob) {
    const a = angle + Math.PI / 2 + wob, sin = Math.sin(a), cos = Math.cos(a), tl = 12.5 * scale;
    return { x: x - sin * tl, y: y + cos * tl, dirX: -Math.cos(angle), dirY: -Math.sin(angle), a: angle };
  }

  // ---- flame emitter (unchanged proven code) --------------------------------
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
      constructor() { this.parts = []; this.MAX = 220; this.spawnAcc = 0; this.anchor = null; this.thrust = 0; this.vac = 0; }
      update(anchor, thrust, dt, vac) {
        this.anchor = anchor; this.thrust = thrust; this.vac = vac || 0;
        const rate = 140 * clamp(thrust, 0, 1.4); this.spawnAcc += rate * dt;
        let n = this.spawnAcc | 0; this.spawnAcc -= n;
        const ax = anchor.x, ay = anchor.y, dx = anchor.dirX, dy = anchor.dirY, pxn = -dy, pyn = dx;
        const base = lerp(60, 240, clamp(thrust, 0, 1.4) / 1.4);
        const smokeP = 0.18 * (1 - this.vac); // no smoke in vacuum
        while (n-- > 0 && this.parts.length < this.MAX) {
          const smoke = Math.random() < smokeP, spread = rand(-1, 1) * (1 - this.vac * 0.5), spd = base * rand(0.6, 1.15), off = rand(-3, 3);
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
        const wMul = lerp(1, 0.7, this.vac), lMul = lerp(1, 1.25, this.vac);
        const len = lerp(14, 46, thrust / 1.4) * flick * lMul, wid = lerp(7, 13, thrust / 1.4) * wMul;
        ctx.globalCompositeOperation = "lighter";
        const glow = ctx.createRadialGradient(len * 0.35, 0, 2, len * 0.35, 0, len * 1.2);
        glow.addColorStop(0, "rgba(255,210,120,0.55)"); glow.addColorStop(0.4, "rgba(255,120,60,0.25)"); glow.addColorStop(1, "rgba(255,60,120,0)");
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(len * 0.35, 0, len * 1.2, 0, TAU); ctx.fill();
        const layers = [[PAL.flameDeep, 1.05, 1.15], [PAL.flameR, 0.92, 1.0], [PAL.flameO, 0.74, 0.8], [PAL.flameY, 0.52, 0.6], [PAL.flameWhite, 0.32, 0.42], [PAL.flameCore, 0.18, 0.28]];
        for (const L of layers) tongue(L[0], len * L[1], wid * L[2], t);
        // vacuum Mach diamonds
        if (this.vac > 0.4 && thrust > 0.8) { ctx.fillStyle = "rgba(180,240,255,0.7)"; for (let i = 1; i <= 3; i++) { const dx = len * 0.18 * i; ctx.beginPath(); ctx.arc(dx, 0, wid * 0.12, 0, TAU); ctx.fill(); } }
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

  // ---- background: stars + sky ----------------------------------------------
  function buildStars() {
    STARS = [];
    const layers = [
      { n: Math.round(VW * VH / 9000), spd: 0.10, size: 1, col: "#8fa0d8" },
      { n: Math.round(VW * VH / 14000), spd: 0.28, size: 1, col: "#cdd9ff" },
      { n: Math.round(VW * VH / 22000), spd: 0.6, size: 2, col: "#ffffff" },
    ];
    for (const L of layers) { const arr = []; for (let i = 0; i < L.n; i++) arr.push({ x: Math.random() * VW, y: Math.random() * VH, tw: Math.random() * TAU }); STARS.push(Object.assign({ arr }, L)); }
  }
  function nebula(x, y, r, col, phase) {
    const pr = r * (0.9 + Math.sin(phase) * 0.08), g = ctx.createRadialGradient(x, y, 0, x, y, pr);
    g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, pr, 0, TAU); ctx.fill();
  }
  function drawBackground(t, speed, altS) {
    const z = zoneAt(altS);
    const top = lerpRGB(z.a.top, z.b.top, z.t), bot = lerpRGB(z.a.bot, z.b.bot, z.t);
    const starA = lerp(z.a.star, z.b.star, z.t), gridA = lerp(z.a.grid, z.b.grid, z.t);
    const g = ctx.createLinearGradient(0, 0, 0, VH);
    g.addColorStop(0, rgb(top)); g.addColorStop(1, rgb(bot));
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);

    // daytime sun that lowers + fades as you climb (zones A–C)
    if (altS < 0.2) {
      const sa = clamp(1 - altS / 0.2, 0, 1), sunY = lerp(VH * 0.2, VH * 1.15, altS / 0.2);
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      const sg = ctx.createRadialGradient(VW * 0.78, sunY, 4, VW * 0.78, sunY, VH * 0.4);
      sg.addColorStop(0, "rgba(255,243,200," + (0.9 * sa) + ")"); sg.addColorStop(0.4, "rgba(255,160,80," + (0.4 * sa) + ")"); sg.addColorStop(1, "rgba(255,120,60,0)");
      ctx.fillStyle = sg; ctx.fillRect(0, 0, VW, VH); ctx.restore();
    }
    // clouds (zones A–B)
    if (altS < 0.18) drawClouds(t, speed, clamp(1 - altS / 0.18, 0, 1));

    // nebula tints — colour shifts with zone
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    if (starA > 0.05) {
      const neb = altS < 0.55 ? ["rgba(0,234,255,", "rgba(255,60,120,"] : altS < 0.75 ? ["rgba(255,150,80,", "rgba(255,60,120,"] : ["rgba(140,108,255,", "rgba(108,240,255,"];
      nebula(VW * 0.25, VH * 0.3, VH * 0.5, neb[0] + (0.10 * starA) + ")", t * 0.3);
      nebula(VW * 0.78, VH * 0.55, VH * 0.6, neb[1] + (0.09 * starA) + ")", t * 0.21 + 2);
    }
    ctx.restore();

    // stars (alpha ramps in with altitude; streak with speed in vacuum)
    if (starA > 0.02) {
      const streak = clamp(speed / 2.2, 0, 1) * (0.3 + altS * 0.7);
      for (const L of STARS) {
        ctx.fillStyle = L.col;
        const dx = -L.spd * (40 + speed * 120), dy = L.spd * (26 + speed * 90);
        for (const s of L.arr) {
          s.x += dx * 0.016; s.y += dy * 0.016;
          if (s.x < 0) s.x += VW; if (s.x > VW) s.x -= VW; if (s.y > VH) s.y -= VH; if (s.y < 0) s.y += VH;
          ctx.globalAlpha = starA * (L.size === 2 ? 0.6 + Math.sin(t * 3 + s.tw) * 0.4 : 0.85);
          ctx.fillRect(s.x | 0, s.y | 0, L.size, L.size);
        }
        ctx.globalAlpha = 1;
        if (L.size === 2 && streak > 0.25) {
          ctx.strokeStyle = "rgba(255,255,255," + (0.18 * starA) + ")"; ctx.lineWidth = 1; ctx.beginPath();
          for (const s of L.arr) { ctx.moveTo(s.x | 0, s.y | 0); ctx.lineTo((s.x - dx * 0.05 * (1 + streak * 3)) | 0, (s.y - dy * 0.05 * (1 + streak * 3)) | 0); }
          ctx.stroke();
        }
      }
    }

    // synthwave ground grid — only near the ground, fades out as you leave
    if (gridA > 0.02) {
      const horizon = VH * 0.74, bottom = VH;
      gridScroll = (gridScroll + (0.6 + speed * 2.2) * 0.016) % 1;
      ctx.save(); ctx.globalAlpha = gridA;
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
  }
  let cloudPuff = null;
  function drawClouds(t, speed, a) {
    if (!cloudPuff) { cloudPuff = newCanvas(96, 56); const cx = cloudPuff.getContext("2d"); const g = cx.createRadialGradient(48, 30, 4, 48, 30, 46); g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(1, "rgba(255,255,255,0)"); cx.fillStyle = g; cx.fillRect(0, 0, 96, 56); }
    ctx.save(); ctx.globalAlpha = a * 0.8;
    const CL = [[0.18, 0.30, 1.6], [0.62, 0.22, 2.1], [0.4, 0.52, 1.3], [0.82, 0.66, 1.8], [0.08, 0.7, 1.4]];
    for (let i = 0; i < CL.length; i++) { const c = CL[i]; const drift = (t * (10 + speed * 30) * 0.4 + i * 130) % (VW + 200) - 100; const x = (c[0] * VW + drift) % (VW + 200) - 100, y = c[1] * VH, w = 96 * c[2], h = 56 * c[2]; ctx.drawImage(cloudPuff, x, y, w, h); }
    ctx.restore();
  }

  // ---- FX: multi-stage explosion --------------------------------------------
  function ExplosionFX(x, y) {
    this.x = x; this.y = y; this.t = 0; this.dead = false; this.flash = 1; this.ring = 0; this.ring2 = 0; this.fire = 0; this.parts = [];
    const cols = [PAL.flameWhite, PAL.flameY, PAL.flameO, PAL.flameR, PAL.gold, PAL.magenta2];
    for (let i = 0; i < 80; i++) { const a = rand(0, TAU), sp = rand(60, 440) * (0.4 + Math.random()); this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, ttl: rand(0.4, 1.1), size: rand(2, 6), col: cols[randi(0, cols.length - 1)] }); }
    for (let i = 0; i < 12; i++) { const a = rand(0, TAU), sp = rand(80, 260); this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0, ttl: rand(0.9, 1.5), size: rand(3, 6), col: PAL.steelMid, debris: true, rot: rand(0, TAU), spin: rand(-8, 8) }); }
    for (let i = 0; i < 14; i++) { const a = rand(0, TAU), sp = rand(20, 90); this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, ttl: rand(1.0, 1.7), size: rand(4, 8), col: PAL.smoke, smoke: true }); }
    for (let i = 0; i < 20; i++) { const a = rand(0, TAU), sp = rand(20, 120); this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30, life: -rand(0, 0.5), ttl: rand(1.2, 2.0), size: rand(1, 2.4), col: Math.random() < 0.5 ? PAL.flameO : PAL.flameY, ember: true }); }
  }
  ExplosionFX.prototype.update = function (dt) {
    this.t += dt; this.flash = Math.max(0, this.flash - dt * 8);
    this.ring = easeOutQuint(clamp(this.t / 0.6, 0, 1)) * 300; this.ring2 = easeOutQuint(clamp((this.t - 0.06) / 0.6, 0, 1)) * 210;
    this.fire = this.t < 0.35 ? easeOutCubic(this.t / 0.35) : Math.max(0, 1 - (this.t - 0.35) / 0.5);
    let alive = false;
    for (const p of this.parts) { p.life += dt; if (p.life >= p.ttl) continue; alive = true; if (p.life < 0) continue; p.x += p.vx * dt; p.y += p.vy * dt; const d = Math.pow(p.smoke ? 0.96 : 0.92, dt * 60); p.vx *= d; p.vy = p.vy * d + (p.debris ? 380 : p.smoke ? -18 : p.ember ? -22 : 60) * dt; if (p.smoke) p.size += 10 * dt; if (p.rot != null) p.rot += p.spin * dt; }
    if (!alive && this.flash <= 0 && this.t > 1.0) this.dead = true;
  };
  ExplosionFX.prototype.render = function () {
    // fireball core
    if (this.fire > 0.01) { ctx.save(); ctx.globalCompositeOperation = "lighter"; const fr = lerp(8, 95, easeOutCubic(clamp(this.t / 0.35, 0, 1))); const g = ctx.createRadialGradient(this.x, this.y, 2, this.x, this.y, fr); g.addColorStop(0, `rgba(255,247,214,${this.fire})`); g.addColorStop(0.35, `rgba(255,210,77,${this.fire * 0.9})`); g.addColorStop(0.7, `rgba(255,90,40,${this.fire * 0.6})`); g.addColorStop(1, "rgba(255,60,120,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(this.x, this.y, fr, 0, TAU); ctx.fill(); ctx.restore(); }
    // shockwave rings
    if (this.t < 0.7) { ctx.save(); ctx.globalCompositeOperation = "lighter"; let a = 1 - this.t / 0.7; ctx.strokeStyle = `rgba(255,210,120,${a})`; ctx.lineWidth = lerp(9, 1, this.t / 0.7); ctx.beginPath(); ctx.arc(this.x, this.y, this.ring, 0, TAU); ctx.stroke(); ctx.strokeStyle = `rgba(255,60,120,${a * 0.7})`; ctx.lineWidth = lerp(6, 1, this.t / 0.7); ctx.beginPath(); ctx.arc(this.x, this.y, this.ring2, 0, TAU); ctx.stroke(); ctx.restore(); }
    ctx.save();
    for (const p of this.parts) {
      if (p.life < 0 || p.life >= p.ttl) continue; const age = p.life / p.ttl;
      if (p.debris) { ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1 - age; ctx.fillStyle = p.col; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); ctx.restore(); }
      else if (p.smoke) { ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = (1 - age) * 0.4; ctx.fillStyle = p.col; const s = p.size; ctx.fillRect((p.x - s / 2) | 0, (p.y - s / 2) | 0, Math.ceil(s), Math.ceil(s)); }
      else { ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 1 - age; ctx.fillStyle = p.col; const s = p.size * (1 - age * (p.ember ? 0.2 : 0.5)); ctx.fillRect((p.x - s / 2) | 0, (p.y - s / 2) | 0, Math.ceil(s), Math.ceil(s)); }
    }
    ctx.globalAlpha = 1; ctx.restore();
  };
  ExplosionFX.prototype.renderFlash = function () { if (this.flash <= 0) return; ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = `rgba(255,240,210,${this.flash * 0.7})`; ctx.fillRect(0, 0, VW, VH); ctx.restore(); };

  // ---- FX: cash-out (zone-themed) -------------------------------------------
  function CashOutFX(x, y, altS) {
    this.x = x; this.y = y; this.t = 0; this.dead = false; this.pop = 0; this.parts = [];
    const accent = altS < 0.36 ? PAL.green : altS < 0.61 ? "#cfe0ff" : altS < 0.85 ? PAL.gold : "#b46cff";
    this.core = altS < 0.36 ? [57, 255, 158] : altS < 0.85 ? [255, 227, 77] : [180, 108, 255];
    for (let i = 0; i < 50; i++) { const a = rand(-Math.PI, 0) + rand(-0.3, 0.3), sp = rand(120, 360), coin = Math.random() < 0.55; this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, life: 0, ttl: rand(0.7, 1.3), size: coin ? rand(4, 7) : rand(2, 4), coin, col: coin ? PAL.gold : accent, spin: rand(-12, 12), rot: rand(0, TAU), flip: rand(2, 6) }); }
    this.r = lerp(90, 160, altS);
  }
  CashOutFX.prototype.update = function (dt) {
    this.t += dt; this.pop = easeOutCubic(clamp(this.t / 0.35, 0, 1)); let alive = this.t < 0.5;
    for (const p of this.parts) { p.life += dt; if (p.life >= p.ttl) continue; alive = true; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.vx *= Math.pow(0.98, dt * 60); p.rot += p.spin * dt; }
    if (!alive) this.dead = true;
  };
  CashOutFX.prototype.render = function () {
    if (this.t < 0.5) { ctx.save(); ctx.globalCompositeOperation = "lighter"; const a = 1 - this.t / 0.5, r = this.pop * this.r; const C = this.core; const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r + 20); g.addColorStop(0, `rgba(${C[0]},${C[1]},${C[2]},${a * 0.5})`); g.addColorStop(0.6, `rgba(255,227,77,${a * 0.3})`); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(this.x, this.y, r + 20, 0, TAU); ctx.fill(); ctx.restore(); }
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

  // ---- universe-themed win messages (pure helper for the HUD) ---------------
  const WIN_MSGS = [
    [1.0, "LIFTOFF!", "#39ff9e", "🚀"], [1.5, "THROUGH THE CLOUDS!", "#bfe6ff", "☁️"],
    [3.0, "EDGE OF THE SKY!", "#ff8c5a", "🌅"], [6.0, "ZERO GRAVITY!", "#00eaff", "🛰️"],
    [12, "INTO ORBIT!", "#7ff6ff", "🌍"], [15, "TO THE MOON!", "#f4f1e6", "🌙"],
    [35, "PAST MARS!", "#e8745a", "🔴"], [70, "INTO DEEP SPACE!", "#9fb6ff", "✨"],
    [90, "JUPITER FLYBY!", "#e7cba0", "🪐"], [140, "RINGS OF SATURN!", "#ead9b0", "🪐"],
    [250, "OUTER PLANETS!", "#5b8fe0", "🔵"], [500, "ESCAPED THE SOLAR SYSTEM!", "#b46cff", "🌠"],
    [1000, "INTERSTELLAR!!", "#ffffff", "🌌"],
  ];

  // ---- trajectory + main loop -----------------------------------------------
  function rocketPath(progress) {
    const e = easeOutCubic(clamp(progress, 0, 1));
    return { x: lerp(VW * 0.20, VW * 0.78, e), y: lerp(VH * 0.60, VH * 0.15, easeInQuad(clamp(progress, 0, 1))) };
  }
  function drawTrajectory(danger) {
    trail.push({ x: rocket.x, y: rocket.y });
    if (trail.length > 80) trail.shift();
    if (scene.state === "crashed" && trail.length) trail.shift();
    if (trail.length < 2) return;
    const c = dangerColor(danger);
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(trail[0].x, trail[0].y);
    for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
    ctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.10)"; ctx.lineWidth = 11; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(trail[0].x, trail[0].y);
    for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
    ctx.strokeStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.34)"; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }
  function drawVignette() {
    const g = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.35, VW / 2, VH / 2, VH * 0.9);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
  }
  function drawDanger(d) {
    const c = dangerColor(d);
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(VW / 2, VH * 0.55, VH * 0.22, VW / 2, VH * 0.55, VH * 0.8);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(0.6, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (d * 0.06).toFixed(3) + ")"); g.addColorStop(1, "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (0.06 + d * 0.3).toFixed(3) + ")");
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
    ctx.restore();
  }
  function spawnPlume(ax, ay, dirX, dirY) {
    for (let i = 0; i < 36; i++) { const a = rand(0, TAU), sp = rand(30, 140); plume.push({ x: ax + rand(-6, 6), y: ay + rand(-2, 6), vx: Math.cos(a) * sp - dirX * 40, vy: Math.abs(Math.sin(a)) * sp * 0.5 + 30, life: 0, ttl: rand(0.6, 1.3), size: rand(4, 9) }); }
  }
  function updatePlume(dt) {
    for (let i = plume.length - 1; i >= 0; i--) { const p = plume[i]; p.life += dt; if (p.life >= p.ttl) { plume.splice(i, 1); continue; } p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= Math.pow(0.95, dt * 60); p.size += 14 * dt; }
  }
  function renderPlume() {
    if (!plume.length) return; ctx.save();
    for (const p of plume) { const age = p.life / p.ttl; ctx.globalAlpha = (1 - age) * 0.45; ctx.fillStyle = "#5a5570"; const s = p.size; ctx.fillRect((p.x - s / 2) | 0, (p.y - s / 2) | 0, Math.ceil(s), Math.ceil(s)); }
    ctx.globalAlpha = 1; ctx.restore();
  }

  function frame(now) {
    if (!running) return;
    if (document.hidden || !canvas || !canvas.offsetParent) { last = now; setTimeout(() => { if (running) requestAnimationFrame(frame); }, 200); return; }
    // L3: when the scene is idle (no live round, no fx/plume) cap the loop to ~30fps instead of 60 — the per-frame
    // work is a no-op at idle, so this halves the GPU/CPU spend while the crash channel sits open. Do NOT advance
    // `last` on a skip (dt must accumulate correctly for the next real frame).
    if (scene.state === "idle" && !fx.length && !plume.length && now - last < 33) { requestAnimationFrame(frame); return; }
    let dt = (now - last) / 1000; last = now; dt = Math.min(dt, 0.05);
    if (onFrameCb) try { onFrameCb(dt); } catch (e) { }
    // Guard the pure-visual render body: a stray draw throw (NaN into a transform, a null scene sub-object during a
    // fast channel switch mid-animation) otherwise skips the tail requestAnimationFrame and FREEZES the whole
    // crash/plane/swoop/pressure renderer until reload. The money callback (onFrameCb) is already guarded above, so
    // this touches no settlement path. A leaked ctx.save level self-heals on the next frame's clearRect + fresh save.
    try {
    const m = Math.max(1, scene.mult), t = now / 1000;
    const speed = clamp(Math.log(m) * 0.35, 0, 2.2);
    const progress = clamp(Math.log(m) / Math.log(25), 0, 1);
    const danger = clamp((m - 2) / 23, 0, 1);
    const altitude = altOf(m);
    altSmooth += (altitude - altSmooth) * Math.min(1, dt * 6);
    const flying = scene.state === "flying";

    // launch sequence timing
    if (flying && launchT < 0) { launchT = 0; const a0 = tailAnchor(rocketPath(0).x, rocketPath(0).y, -Math.PI * 0.2, 3, 0); spawnPlume(a0.x, a0.y, a0.dirX, a0.dirY); shakeMag = Math.max(shakeMag, 7); }
    else if (flying) launchT += dt;

    const tier = Math.floor(m); if (flying && tier > lastTier) { shakeMag = Math.max(shakeMag, 3.5); rocket.spin += 0; } lastTier = tier;
    shakeMag *= 0.86; if (shakeMag < 0.05) shakeMag = 0;
    const drift = (!REDUCE_MOTION() && altSmooth > 0.85) ? Math.sin(t * 0.6) * 1 : 0; // a16
    const sh = REDUCE_MOTION() ? 0 : Math.max(flying ? danger * 5.5 : 0, shakeMag);   // a16: no whole-screen shake under reduced-motion

    // rocket transform (with a launch leap for the first 0.6s)
    const pos = rocketPath(progress);
    rocket.x = pos.x; rocket.y = pos.y;
    if (flying && launchT >= 0 && launchT < 0.6) { const lk = easeInQuad(clamp(launchT / 0.6, 0, 1)); rocket.y = lerp(VH * 0.62, pos.y, lk); }
    rocket.angle = lerp(-Math.PI * 0.2, -Math.PI * 0.42, progress);
    rocket.scale = lerp(3.2, 4.8, progress) * (VH / 800);
    // crash tumble/fall
    if (scene.state === "crashed") { rocket.spin += dt * 7; rocket.fall += dt; rocket.fade = Math.max(0, rocket.fade - dt * 2.4); rocket.y += rocket.fall * 60 * dt; }
    const vac = clamp((altSmooth - 0.3) / 0.3, 0, 1);
    let thrust = flying ? clamp(0.7 + speed * 0.5, 0.4, 1.4) + Math.sin(t * 30) * 0.05 + danger * 0.4 : 0;
    if (flying && launchT >= 0 && launchT < 0.15) thrust = 1.6; // ignition overshoot

    ctx.clearRect(0, 0, VW, VH);
    ctx.save();
    if (sh > 0.1 || drift) ctx.translate((Math.random() - 0.5) * sh + drift, (Math.random() - 0.5) * sh);
    drawBackground(t, speed, altSmooth);
    drawBodies(altSmooth, t, speed);
    if (danger > 0.02) drawDanger(danger);
    updatePlume(dt); renderPlume();
    if (scene.state === "flying" || scene.state === "cashed") drawTrajectory(danger);
    if (scene.state !== "idle") {
      if (scene.state !== "crashed" || rocket.fade > 0.01) {
        const anchor = tailAnchor(rocket.x, rocket.y, rocket.angle, rocket.scale, Math.sin(t * 2.2) * 0.025 + rocket.spin);
        if (scene.state !== "crashed") { flame.update(anchor, thrust, dt, vac); flame.render(t); }
        drawRocket(rocket.x, rocket.y, rocket.angle, rocket.scale, t);
      }
    }
    for (let i = fx.length - 1; i >= 0; i--) { fx[i].update(dt); fx[i].render(); if (fx[i].dead) fx.splice(i, 1); }
    for (const f of fx) if (f.renderFlash) f.renderFlash();
    ctx.restore();
    drawVignette();
    } catch (e) { try { console.error("crash-render frame:", e); } catch (e2) {} }
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
    setState(s) { if (s === "flying" && scene.state !== "flying") launchT = -1; scene.state = s; },
    state() { return scene.state; },
    explode() { fx.push(new ExplosionFX(rocket.x, rocket.y)); shakeMag = 22; },
    cashout() { fx.push(new CashOutFX(rocket.x, rocket.y, altSmooth)); shakeMag = 6; },
    rocketPos() { return { x: rocket.x, y: rocket.y }; },
    winMessage(mult) { let r = WIN_MSGS[0]; for (const w of WIN_MSGS) { if (mult >= w[0]) r = w; } return { text: r[1], color: r[2], emoji: r[3] }; },
    reset() { fx.length = 0; trail.length = 0; plume.length = 0; flame.parts.length = 0; scene.mult = 1; scene.state = "idle"; shakeMag = 0; lastTier = 1; altSmooth = 0; launchT = -1; rocket.spin = 0; rocket.fall = 0; rocket.fade = 1; },
  };
})(typeof window !== "undefined" ? window : this);
