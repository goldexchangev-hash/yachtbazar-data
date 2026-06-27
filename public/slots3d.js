/* ============================================================
   ⚠️ NOTE FOR CHATGPT / NEXT DEV (2026-06-27, build v11.36):
   This file was REPLACED with a brand-new premium renderer and the game was
   RENAMED "Gem Vault" → "ROYAL RICHES" (player-facing only). Channel stays 15
   and the internal key stays "slots3d" (GAME_CHANNEL / els / CSS unchanged), so
   no wiring moved. The provably-fair MATH (slots3d-engine.js) and the
   host-bridge API are byte-for-byte unchanged — only the visuals + the displayed
   name changed. Player-facing strings live in index.html + app.js (search
   "Royal Riches"); internal comments/keys may still say "Gem Vault"/"slots3d".
   ============================================================ */
/* ============================================================
   slots3d.js — "ROYAL RICHES" (internal key: slots3d): a premium Vegas-style
   Three.js (WebGL) slot that renders into the TV. Faceted-gem symbol art with
   baked highlights, an ornate env-mapped GOLD cabinet, velvet backdrop +
   drifting bokeh, a glowing ROYAL RICHES marquee, an eased left-to-right reel
   stop with anticipation teases, glowing win rings + a coin/gem storm.

   Money + odds live in Slots3DEngine (provably fair, frame-rate independent);
   this file is presentation + a host bridge that mirrors PressureGame/PlaneGame:
     new Slots3D({ mount, els, width, height, ethUsd, initialBalance,
                   onBalance, onWin })
   ============================================================ */
(function (root) {
  "use strict";
  const THREE = root.THREE, E = root.Slots3DEngine;
  const REELS = 5, ROWS = 3, MIN_BET = 10;
  const PANY = 0.55; // shift the reels UP in frame, leaving a black shelf at the bottom for the win/bonus banners

  /* ============================================================
     PALETTE — jewel tones + 3-stop metallic gold (shared)
     ============================================================ */
  const P = {
    goldDark: "#6e4a12", goldMid: "#c9962e", goldBright: "#f4d36b", goldHot: "#fff6d6", goldRim: "#3a2606",
    rim: "#03060d", glint: "#ffffff",
    ruby:  { d: "#6e0410", m: "#c20d2a", l: "#ff5d72", g: "#ff2b46" },
    sapp:  { d: "#08184f", m: "#1d52c9", l: "#6fa8ff", g: "#3d86ff" },
    emer:  { d: "#033524", m: "#0f9d63", l: "#5cf0b0", g: "#18e08c" },
    amth:  { d: "#2b0b54", m: "#7b2fd6", l: "#c79bff", g: "#a25cff" },
    topaz: { d: "#7a3d00", m: "#ffae1f", l: "#ffe08a", g: "#ffc24d" },
    dia:   { d: "#5a74b0", m: "#cfe2ff", l: "#ffffff", g: "#bfe0ff" },
  };

  /* per-symbol theme (0..7). glow color used by the reel face emissive tint. */
  const SYM = [
    { c: "#ff5d72", c2: "#6e0410", glyph: "cherry" },  // 0 cherry  (ruby)
    { c: "#ffd23f", c2: "#7a3d00", glyph: "bell"   },  // 1 bell    (topaz-gold)
    { c: "#5cf0b0", c2: "#033524", glyph: "grapes" },  // 2 low fruit (emerald)
    { c: "#c79bff", c2: "#2b0b54", glyph: "seven"  },  // 3 lucky 7 (gold + ruby)
    { c: "#ffd23f", c2: "#7a3d00", glyph: "bar"    },  // 4 gold bar
    { c: "#bfe0ff", c2: "#5a74b0", glyph: "diamond"},  // 5 diamond
    { c: "#a25cff", c2: "#2b0b54", glyph: "wild"   },  // 6 wild    (amethyst)
    { c: "#ff4d9d", c2: "#5e0b39", glyph: "vault"  },  // 7 scatter (gold vault)
  ];

  /* ---------------- canvas helpers ---------------- */
  function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")"; }
  function lighten(hex, amt) { amt = amt || 70; const n = parseInt(hex.slice(1), 16); const r = Math.min(255, (n >> 16 & 255) + amt), g = Math.min(255, (n >> 8 & 255) + amt), b = Math.min(255, (n & 255) + amt); return "rgb(" + r + "," + g + "," + b + ")"; }

  // A 4-point lens-flare sparkle (additive cross + bright core).
  function sparkleStar(x, cx, cy, size) {
    x.save(); x.globalCompositeOperation = "lighter";
    for (const [dx, dy, len] of [[1, 0, size], [0, 1, size]]) {
      const g = x.createLinearGradient(cx - dx * len, cy - dy * len, cx + dx * len, cy + dy * len);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,.95)"); g.addColorStop(1, "rgba(255,255,255,0)");
      x.strokeStyle = g; x.lineWidth = Math.max(2, size * 0.13); x.lineCap = "round";
      x.beginPath(); x.moveTo(cx - dx * len, cy - dy * len); x.lineTo(cx + dx * len, cy + dy * len); x.stroke();
    }
    const rg = x.createRadialGradient(cx, cy, 0, cx, cy, size * 0.34);
    rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = rg; x.beginPath(); x.arc(cx, cy, size * 0.34, 0, 7); x.fill();
    x.restore();
  }

  // Stroke a closed path 4× outer→inner to fake a beveled, 3-stop metallic gold bezel.
  function goldBezel(x, pathFn, width, glow, bbox) {
    x.lineJoin = "round"; x.lineCap = "round";
    if (glow) { x.save(); x.shadowColor = P.goldBright; x.shadowBlur = 18; x.strokeStyle = P.goldMid; x.lineWidth = width; pathFn(); x.stroke(); x.restore(); }
    // 1. dark contact shadow
    x.strokeStyle = P.goldRim; x.lineWidth = width + 6; pathFn(); x.stroke();
    // 2. metallic body (vertical 3-stop)
    const g = x.createLinearGradient(0, bbox[0], 0, bbox[1]);
    g.addColorStop(0, P.goldDark); g.addColorStop(0.35, P.goldMid); g.addColorStop(0.5, P.goldBright); g.addColorStop(0.65, P.goldMid); g.addColorStop(1, P.goldDark);
    x.strokeStyle = g; x.lineWidth = width; pathFn(); x.stroke();
    // 3. hot top-left sheen
    x.save(); x.globalAlpha = 0.8; x.strokeStyle = P.goldHot; x.lineWidth = width * 0.4; pathFn(); x.stroke(); x.restore();
    // 4. inner seat
    x.strokeStyle = P.rim; x.lineWidth = 1.5; pathFn(); x.stroke();
  }

  // A small ornate gold scroll/fleur stamped at cardinal points of premium frames.
  function goldScroll(x, cx, cy, scale, ang) {
    x.save(); x.translate(cx, cy); x.rotate(ang); x.scale(scale, scale);
    x.strokeStyle = P.goldBright; x.lineWidth = 5; x.lineCap = "round";
    x.beginPath(); x.moveTo(0, 0); x.bezierCurveTo(-14, -6, -18, -20, -8, -26);
    x.moveTo(0, 0); x.bezierCurveTo(14, -6, 18, -20, 8, -26); x.stroke();
    x.fillStyle = P.goldHot; x.beginPath(); x.arc(0, 2, 4, 0, 7); x.fill();
    x.restore();
  }

  // A radial gold sphere (knob / clapper / rivet / grape).
  function goldSphere(x, cx, cy, r, pal) {
    pal = pal || P;
    const g = x.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    g.addColorStop(0, P.goldHot); g.addColorStop(0.45, P.goldBright); g.addColorStop(0.75, P.goldMid); g.addColorStop(1, P.goldRim);
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();
    x.strokeStyle = "rgba(0,0,0,.4)"; x.lineWidth = 1.5; x.stroke();
  }

  // A faceted brilliant-cut gemstone — hard speculars, top-left glint, inner caustic
  // glow, dark girdle rim. shape: 'round' (octagon) | 'marquise' (pointed oval).
  function facetedGem(x, o) {
    const cx = o.cx, cy = o.cy, R = o.R, deep = o.deep, mid = o.mid, lit = o.lit, glow = o.glow;
    const N = 8, rot = Math.PI / 8, tableR = 0.46 * R;
    function vert(rad, i, sx) { const a = rot + i * (2 * Math.PI / N); return [cx + Math.cos(a) * rad * (sx || 1), cy + Math.sin(a) * rad]; }
    const marq = o.shape === "marquise";
    const SX = marq ? 0.62 : 1; // squeeze X for a pointed oval

    // drop shadow
    x.save(); x.shadowColor = "rgba(0,0,0,.55)"; x.shadowBlur = 16; x.shadowOffsetY = 8;
    x.fillStyle = deep; x.beginPath();
    for (let i = 0; i < N; i++) { const v = vert(R, i, SX); x[i ? "lineTo" : "moveTo"](v[0], v[1]); } x.closePath(); x.fill();
    x.restore();

    // inner caustic glow
    const cg = x.createRadialGradient(cx, cy + R * 0.1, 0, cx, cy + R * 0.1, R * 0.85);
    cg.addColorStop(0, hexA(glow, 0.55)); cg.addColorStop(1, hexA(glow, 0));
    x.fillStyle = cg; x.beginPath(); x.arc(cx, cy + R * 0.1, R * 0.85, 0, 7); x.fill();

    // crown facets (light from top-left ~315°)
    function lerpCol(b) { // b in [-1,1] → deep..mid..lit
      const t = (b + 1) / 2; const a = t < 0.5 ? deep : mid, c = t < 0.5 ? mid : lit, k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const pa = parseInt(a.slice(1), 16), pc = parseInt(c.slice(1), 16);
      const r = ((pa >> 16 & 255) + ((pc >> 16 & 255) - (pa >> 16 & 255)) * k) | 0;
      const gg = ((pa >> 8 & 255) + ((pc >> 8 & 255) - (pa >> 8 & 255)) * k) | 0;
      const bb = ((pa & 255) + ((pc & 255) - (pa & 255)) * k) | 0;
      return "rgb(" + r + "," + gg + "," + bb + ")";
    }
    for (let i = 0; i < N; i++) {
      const Vi = vert(R, i, SX), Vi1 = vert(R, (i + 1) % N, SX), Ti = vert(tableR, i, SX), Ti1 = vert(tableR, (i + 1) % N, SX);
      const faceAng = rot + (i + 0.5) * (2 * Math.PI / N);
      const b = Math.max(-1, Math.min(1, Math.cos(faceAng - (-Math.PI * 0.75)))); // light dir 315°
      const inMid = [(Ti[0] + Ti1[0]) / 2, (Ti[1] + Ti1[1]) / 2], outMid = [(Vi[0] + Vi1[0]) / 2, (Vi[1] + Vi1[1]) / 2];
      const g = x.createLinearGradient(inMid[0], inMid[1], outMid[0], outMid[1]);
      g.addColorStop(0, lerpCol(b)); g.addColorStop(1, deep);
      x.fillStyle = g; x.beginPath(); x.moveTo(Vi[0], Vi[1]); x.lineTo(Vi1[0], Vi1[1]); x.lineTo(Ti1[0], Ti1[1]); x.lineTo(Ti[0], Ti[1]); x.closePath(); x.fill();
      x.strokeStyle = "rgba(0,0,0,.25)"; x.lineWidth = 1; x.stroke();
    }
    // table (top flat)
    const tg = x.createRadialGradient(cx - R * 0.12, cy - R * 0.12, 0, cx, cy, tableR * 1.05);
    tg.addColorStop(0, lit); tg.addColorStop(0.6, mid); tg.addColorStop(1, deep);
    x.fillStyle = tg; x.beginPath();
    for (let i = 0; i < N; i++) { const v = vert(tableR, i, SX); x[i ? "lineTo" : "moveTo"](v[0], v[1]); } x.closePath(); x.fill();
    x.strokeStyle = "rgba(255,255,255,.18)"; x.lineWidth = 1; x.stroke();

    // dark girdle rim
    x.strokeStyle = P.rim; x.lineWidth = 3; x.beginPath();
    for (let i = 0; i < N; i++) { const v = vert(R, i, SX); x[i ? "lineTo" : "moveTo"](v[0], v[1]); } x.closePath(); x.stroke();

    // hard glints
    sparkleStar(x, cx - R * 0.26, cy - R * 0.3, R * 0.5);
    x.save(); x.globalCompositeOperation = "lighter"; x.fillStyle = "rgba(255,255,255,.7)";
    x.beginPath(); x.arc(cx + R * 0.2, cy + R * 0.06, R * 0.05, 0, 7); x.fill(); x.restore();
  }

  /* ---- shared tile background ---- */
  function drawTileBackground(x, S) {
    x.fillStyle = "#0b0f18"; x.fillRect(0, 0, S, S);
    const g = x.createRadialGradient(S / 2, S * 0.46, S * 0.08, S / 2, S / 2, S * 0.6);
    g.addColorStop(0, "#1c2230"); g.addColorStop(0.6, "#10141f"); g.addColorStop(1, "#070a12");
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    x.strokeStyle = "rgba(255,255,255,.05)"; x.lineWidth = 4; rr(x, S * 0.035, S * 0.035, S * 0.93, S * 0.93, S * 0.07); x.stroke();
    const v = x.createRadialGradient(S / 2, S / 2, S * 0.39, S / 2, S / 2, S * 0.5);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.5)");
    x.fillStyle = v; x.fillRect(0, 0, S, S);
  }

  /* ---- procedural premium symbol textures (512px, baked once) ---- */
  function symTexture(id) {
    const S = 512, cv = document.createElement("canvas"); cv.width = cv.height = S;
    const x = cv.getContext("2d");
    drawTileBackground(x, S);
    const c = S / 256; // scale factor: design spec authored in 512 space already → c=2 px-per-unit base. We map 512 coords directly.
    const sym = SYM[id];

    if (sym.glyph === "cherry") {
      // ruby gem-cherries on a gold stem
      x.save(); x.lineCap = "round"; x.strokeStyle = P.goldMid; x.lineWidth = 16;
      x.shadowColor = P.goldRim; x.shadowBlur = 6;
      x.beginPath(); x.moveTo(256, 120); x.quadraticCurveTo(220, 230, 204, 300); x.moveTo(256, 120); x.quadraticCurveTo(300, 230, 312, 288); x.stroke();
      x.shadowBlur = 0; x.strokeStyle = P.goldHot; x.lineWidth = 5;
      x.beginPath(); x.moveTo(256, 120); x.quadraticCurveTo(220, 230, 204, 300); x.stroke(); x.restore();
      // leaf
      x.fillStyle = P.goldMid; x.beginPath(); x.moveTo(256, 112); x.quadraticCurveTo(312, 78, 290, 132); x.quadraticCurveTo(272, 120, 256, 112); x.fill();
      facetedGem(x, { cx: 312, cy: 332, R: 70, shape: "round", deep: P.ruby.d, mid: P.ruby.m, lit: P.ruby.l, glow: P.ruby.g });
      facetedGem(x, { cx: 204, cy: 344, R: 80, shape: "round", deep: P.ruby.d, mid: P.ruby.m, lit: P.ruby.l, glow: P.ruby.g });
    }
    else if (sym.glyph === "grapes") {
      // emerald grape cluster (low) — cheap gem spheres, one gold leaf
      x.save(); x.strokeStyle = P.goldMid; x.lineWidth = 12; x.lineCap = "round";
      x.beginPath(); x.moveTo(256, 130); x.lineTo(256, 180); x.stroke(); x.restore();
      x.fillStyle = P.goldMid; x.beginPath(); x.moveTo(256, 128); x.quadraticCurveTo(316, 96, 300, 150); x.quadraticCurveTo(280, 138, 256, 128); x.fill();
      const grapes = [[256, 320, 60], [206, 252, 54], [306, 252, 54], [238, 196, 48], [298, 200, 48]];
      for (const [gx, gy, gr] of grapes) {
        const g = x.createRadialGradient(gx - gr * 0.35, gy - gr * 0.4, gr * 0.1, gx, gy, gr);
        g.addColorStop(0, P.emer.l); g.addColorStop(0.5, P.emer.m); g.addColorStop(1, P.emer.d);
        x.fillStyle = g; x.beginPath(); x.arc(gx, gy, gr, 0, 7); x.fill();
        x.strokeStyle = P.rim; x.lineWidth = 2.5; x.stroke();
        x.fillStyle = "rgba(255,255,255,.85)"; x.beginPath(); x.arc(gx - gr * 0.32, gy - gr * 0.36, gr * 0.16, 0, 7); x.fill();
      }
    }
    else if (sym.glyph === "bell") {
      const bell = () => { x.beginPath(); x.moveTo(256, 150); x.bezierCurveTo(360, 160, 348, 300, 360, 330); x.lineTo(152, 330); x.bezierCurveTo(164, 300, 152, 160, 256, 150); x.closePath(); };
      x.save(); const g = x.createLinearGradient(0, 140, 0, 340);
      g.addColorStop(0, P.goldDark); g.addColorStop(0.3, P.goldMid); g.addColorStop(0.5, P.goldBright); g.addColorStop(0.62, P.goldMid); g.addColorStop(1, P.topaz.d);
      x.fillStyle = g; x.shadowColor = "rgba(0,0,0,.5)"; x.shadowBlur = 18; x.shadowOffsetY = 10; bell(); x.fill(); x.restore();
      goldBezel(x, bell, 8, true, [150, 340]);
      // sheen + clapper + button + rim band
      x.save(); x.globalAlpha = 0.6; x.fillStyle = P.goldHot; x.beginPath(); x.ellipse(224, 230, 14, 70, 0, 0, 7); x.fill(); x.restore();
      x.fillStyle = P.goldMid; x.fillRect(152, 326, 208, 14); x.fillStyle = P.goldHot; x.fillRect(152, 326, 208, 3);
      goldSphere(x, 256, 132, 18);
      goldSphere(x, 256, 356, 24);
      x.save(); x.globalCompositeOperation = "lighter"; x.fillStyle = "rgba(255,255,255,.8)"; x.beginPath(); x.arc(272, 188, 10, 0, 7); x.fill(); x.restore();
    }
    else if (sym.glyph === "seven") {
      const seven = () => { x.beginPath(); x.moveTo(150, 150); x.lineTo(372, 150); x.lineTo(372, 196); x.lineTo(286, 372); x.lineTo(214, 372); x.lineTo(312, 196); x.lineTo(150, 196); x.closePath(); };
      x.save(); const g = x.createLinearGradient(0, 150, 0, 372);
      g.addColorStop(0, P.goldRim); g.addColorStop(0.2, P.goldMid); g.addColorStop(0.42, P.goldHot); g.addColorStop(0.5, P.goldBright); g.addColorStop(0.66, P.goldMid); g.addColorStop(0.85, "#1c1303"); g.addColorStop(1, P.goldMid);
      x.fillStyle = g; x.shadowColor = "rgba(0,0,0,.5)"; x.shadowBlur = 20; x.shadowOffsetY = 12; seven(); x.fill(); x.restore();
      goldBezel(x, seven, 8, true, [150, 372]);
      // ruby inlay (inset 7)
      x.save(); x.translate(268, 250); x.scale(0.82, 0.82); x.translate(-268, -250);
      const rg = x.createLinearGradient(0, 150, 0, 372); rg.addColorStop(0, P.ruby.d); rg.addColorStop(0.5, P.ruby.l); rg.addColorStop(1, P.ruby.d);
      x.fillStyle = rg; seven(); x.fill(); x.strokeStyle = P.rim; x.lineWidth = 3; x.stroke(); x.restore();
      sparkleStar(x, 188, 172, 46);
    }
    else if (sym.glyph === "bar") {
      // gold ingot: front + top face
      x.save(); x.shadowColor = "rgba(0,0,0,.55)"; x.shadowBlur = 22; x.shadowOffsetY = 14;
      const fg = x.createLinearGradient(0, 210, 0, 330); fg.addColorStop(0, P.goldDark); fg.addColorStop(0.4, P.goldMid); fg.addColorStop(0.55, P.goldBright); fg.addColorStop(0.7, P.goldMid); fg.addColorStop(1, P.goldRim);
      x.fillStyle = fg; x.beginPath(); x.moveTo(150, 210); x.lineTo(362, 210); x.lineTo(386, 332); x.lineTo(126, 332); x.closePath(); x.fill(); x.restore();
      const tg = x.createLinearGradient(0, 168, 0, 210); tg.addColorStop(0, P.goldBright); tg.addColorStop(0.5, P.goldHot); tg.addColorStop(1, P.goldBright);
      x.fillStyle = tg; x.beginPath(); x.moveTo(150, 210); x.lineTo(362, 210); x.lineTo(338, 168); x.lineTo(174, 168); x.closePath(); x.fill();
      x.strokeStyle = P.goldHot; x.lineWidth = 4; x.beginPath(); x.moveTo(150, 210); x.lineTo(362, 210); x.stroke();
      x.strokeStyle = P.goldRim; x.lineWidth = 3; x.beginPath(); x.moveTo(126, 332); x.lineTo(386, 332); x.stroke();
      // engraved BAR
      x.font = "900 64px 'Bungee',Arial"; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillStyle = "rgba(0,0,0,.35)"; x.fillText("BAR", 256, 282);
      x.fillStyle = hexA(P.ruby.d, 0.95); x.fillText("BAR", 256, 279);
      // sheen sweep
      x.save(); x.globalCompositeOperation = "lighter"; x.globalAlpha = 0.22; x.fillStyle = P.goldHot;
      x.beginPath(); x.moveTo(190, 210); x.lineTo(250, 210); x.lineTo(214, 332); x.lineTo(154, 332); x.closePath(); x.fill(); x.restore();
    }
    else if (sym.glyph === "diamond") {
      const oct = () => { const N = 8, rot = Math.PI / 8, R = 200; x.beginPath(); for (let i = 0; i < N; i++) { const a = rot + i * (2 * Math.PI / N); x[i ? "lineTo" : "moveTo"](256 + Math.cos(a) * R, 256 + Math.sin(a) * R); } x.closePath(); };
      goldBezel(x, oct, 16, true, [56, 456]);
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; goldScroll(x, 256 + Math.cos(a) * 200, 256 + Math.sin(a) * 200, 1.4, a + Math.PI / 2); }
      facetedGem(x, { cx: 256, cy: 256, R: 150, shape: "round", deep: P.dia.d, mid: P.dia.m, lit: P.dia.l, glow: P.dia.g });
      // dispersion caustic
      x.save(); x.globalCompositeOperation = "lighter"; x.globalAlpha = 0.12;
      for (const [dx, dy, col] of [[-20, -10, "#ff5d72"], [20, 0, "#5cf0b0"], [0, 20, "#6fa8ff"]]) { x.fillStyle = col; x.beginPath(); x.arc(256 + dx, 256 + dy, 60, 0, 7); x.fill(); } x.restore();
      sparkleStar(x, 200, 196, 64); sparkleStar(x, 320, 320, 34);
    }
    else if (sym.glyph === "wild") {
      const shield = () => { x.beginPath(); x.moveTo(120, 150); x.lineTo(392, 150); x.quadraticCurveTo(404, 280, 256, 408); x.quadraticCurveTo(108, 280, 120, 150); x.closePath(); };
      x.save(); x.fillStyle = "#1a1030"; shield(); x.fill(); x.restore();
      goldBezel(x, shield, 16, true, [150, 408]);
      goldScroll(x, 138, 168, 1.2, -0.5); goldScroll(x, 374, 168, 1.2, 0.5);
      facetedGem(x, { cx: 256, cy: 236, R: 150, shape: "marquise", deep: P.amth.d, mid: P.amth.m, lit: P.amth.l, glow: P.amth.g });
      // banner
      x.save(); const bg = x.createLinearGradient(0, 300, 0, 360); bg.addColorStop(0, P.ruby.m); bg.addColorStop(1, P.ruby.d);
      x.fillStyle = bg; x.beginPath(); x.moveTo(110, 304); x.lineTo(402, 304); x.lineTo(380, 358); x.lineTo(132, 358); x.closePath(); x.fill();
      x.strokeStyle = P.goldMid; x.lineWidth = 5; x.stroke(); x.restore();
      x.font = "900 56px 'Bungee',Arial"; x.textAlign = "center"; x.textBaseline = "middle";
      x.lineWidth = 6; x.strokeStyle = P.goldRim; x.strokeText("WILD", 256, 332);
      x.fillStyle = P.goldHot; x.fillText("WILD", 256, 330);
      sparkleStar(x, 200, 190, 56);
    }
    else if (sym.glyph === "vault") {
      const plate = () => rr(x, 60, 60, 392, 392, 40);
      x.save(); const pg = x.createRadialGradient(256, 256, 30, 256, 256, 280); pg.addColorStop(0, P.goldMid); pg.addColorStop(1, P.goldDark);
      x.fillStyle = pg; plate(); x.fill(); x.restore();
      // amethyst special glow behind
      x.save(); x.globalCompositeOperation = "lighter"; x.globalAlpha = 0.25; const ag = x.createRadialGradient(256, 256, 40, 256, 256, 240); ag.addColorStop(0, P.amth.g); ag.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = ag; x.beginPath(); x.arc(256, 256, 240, 0, 7); x.fill(); x.restore();
      goldBezel(x, plate, 14, true, [60, 452]);
      // dial rings + spokes + ticks
      x.strokeStyle = P.goldBright; for (const rad of [150, 110, 70]) { x.lineWidth = 8; x.beginPath(); x.arc(256, 256, rad, 0, 7); x.stroke(); x.strokeStyle = P.goldRim; x.lineWidth = 2; x.beginPath(); x.arc(256, 256, rad + 4, 0, 7); x.stroke(); x.strokeStyle = P.goldBright; }
      x.lineWidth = 8; for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; x.beginPath(); x.moveTo(256 + Math.cos(a) * 70, 256 + Math.sin(a) * 70); x.lineTo(256 + Math.cos(a) * 110, 256 + Math.sin(a) * 110); x.stroke(); }
      x.strokeStyle = P.goldHot; x.lineWidth = 4; for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; x.beginPath(); x.moveTo(256 + Math.cos(a) * 150, 256 + Math.sin(a) * 150); x.lineTo(256 + Math.cos(a) * 164, 256 + Math.sin(a) * 164); x.stroke(); }
      goldSphere(x, 256, 256, 54);
      facetedGem(x, { cx: 256, cy: 256, R: 26, shape: "round", deep: P.ruby.d, mid: P.ruby.m, lit: P.ruby.l, glow: P.ruby.g });
      for (const [bx, by] of [[100, 100], [412, 100], [100, 412], [412, 412]]) goldSphere(x, bx, by, 16);
    }

    const t = new THREE.CanvasTexture(cv); t.anisotropy = 8; if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding; return t;
  }

  function coinTexture() {
    const S = 64, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S * 0.4, S * 0.35, 4, S / 2, S / 2, S / 2);
    g.addColorStop(0, "#fff7cf"); g.addColorStop(0.5, "#ffd23f"); g.addColorStop(1, "#b8860b");
    x.fillStyle = g; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 2, 0, 7); x.fill();
    x.strokeStyle = "rgba(255,255,255,.6)"; x.lineWidth = 2; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 6, 0, 7); x.stroke();
    return new THREE.CanvasTexture(cv);
  }
  function gemTexture(c, c2) {
    const S = 96, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    x.clearRect(0, 0, S, S);
    facetedGem(x, { cx: S / 2, cy: S / 2, R: S * 0.4, shape: "round", deep: c2, mid: c, lit: lighten(c, 90), glow: c });
    return new THREE.CanvasTexture(cv);
  }
  // soft additive disc (bokeh, win rings, chase, under-glow)
  function discTexture(soft) {
    const S = 128, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(soft ? 0.25 : 0.5, "rgba(255,255,255,.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, S, S); return new THREE.CanvasTexture(cv);
  }
  function ringTexture() {
    const S = 128, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    x.strokeStyle = "rgba(255,255,255,1)"; x.lineWidth = 9; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 12, 0, 7); x.stroke();
    x.strokeStyle = "rgba(255,255,255,.4)"; x.lineWidth = 20; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 16, 0, 7); x.stroke();
    return new THREE.CanvasTexture(cv);
  }

  /* ---- procedural ENV MAP: makes the gold cabinet catch cyan/magenta/warm light ---- */
  function makeEnvCanvas() {
    const c = document.createElement("canvas"); c.width = 1024; c.height = 512; const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, "#101018"); g.addColorStop(0.45, "#1a1622"); g.addColorStop(1, "#050507");
    x.fillStyle = g; x.fillRect(0, 0, 1024, 512);
    const bands = [[0.12, 150, "#39e7ff", 0.55], [0.4, 120, "#ffffff", 0.65], [0.63, 170, "#ff4d9d", 0.5], [0.86, 130, "#ffd23f", 0.45]];
    for (const [cx, w, col, a] of bands) { const bx = cx * 1024; const lg = x.createLinearGradient(bx - w, 0, bx + w, 0); lg.addColorStop(0, "rgba(0,0,0,0)"); lg.addColorStop(0.5, col); lg.addColorStop(1, "rgba(0,0,0,0)"); x.globalAlpha = a; x.fillStyle = lg; x.fillRect(bx - w, 60, w * 2, 392); }
    x.globalAlpha = 1;
    for (const [px, py, r, col] of [[0.3, 0.3, 90, "#ffffff"], [0.7, 0.35, 70, "#39e7ff"], [0.9, 0.55, 60, "#ffd23f"]]) { const rg = x.createRadialGradient(px * 1024, py * 512, 0, px * 1024, py * 512, r); rg.addColorStop(0, col); rg.addColorStop(1, "rgba(0,0,0,0)"); x.globalAlpha = 0.6; x.fillStyle = rg; x.fillRect(px * 1024 - r, py * 512 - r, r * 2, r * 2); }
    x.globalAlpha = 1; return c;
  }

  // rounded-rect path on a THREE.Shape/Path
  function roundRectShape(shape, x, y, w, h, r) { shape.moveTo(x + r, y); shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r); shape.lineTo(x + w, y + h - r); shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h); shape.lineTo(x + r, y + h); shape.quadraticCurveTo(x, y + h, x, y + h - r); shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y); }

  /* ============================ the game ============================ */
  function Slots3D(opts) {
    this.els = opts.els || {};
    this.mount = opts.mount;
    this.W = opts.width || 800; this.H = opts.height || 600;
    this.ethUsd = opts.ethUsd || 3400;
    this.onBalance = opts.onBalance || null;
    this.onWin = opts.onWin || null;
    this.balance = opts.initialBalance != null ? opts.initialBalance : 5000;
    this.bet = MIN_BET;
    this._active = false; this._enabled = true; this._spinning = false; this._raf = 0;
    this._bonus = null; this._bonusT = 0; // free-spins round state + timer
    this.state = "idle"; // idle | spinning | win
    this.serverSeed = E.randomSeed(24); this.commitHash = E.commit(this.serverSeed);
    this.clientSeed = (this.els.pfClient && this.els.pfClient.value) || E.randomSeed(8);
    this.nonce = 0;

    this._texCache = []; for (let i = 0; i < 8; i++) this._texCache[i] = symTexture(i);
    this._coinTex = coinTexture();
    this._gemTex = [["#39e7ff", "#0b4a63"], ["#ff4d9d", "#5e0b39"], ["#ffd23f", "#7a5400"], ["#45f0a6", "#0b5e3c"], ["#b14dff", "#3a1063"], ["#ff5d7a", "#7a1030"]].map((g) => gemTexture(g[0], g[1]));
    this._discTex = discTexture(true); this._ringTex = ringTexture();
    this._coins = []; this._gems = []; this._pulses = []; this._rings = []; this._t = 0; this._winFx = null;

    this._initScene();
    this._buildOverlay();
    this._buildWinBanner();
    this._wire();
    this._syncBet(); this._renderHud();
    this._loop = this._loop.bind(this);
  }

  Slots3D.prototype._initScene = function () {
    const W = this.W, H = this.H;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(1.75, root.devicePixelRatio || 1));
    renderer.setSize(W, H, false);
    if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12; }
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%"; renderer.domElement.style.display = "block";
    this.renderer = renderer; if (this.mount) this.mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x05060f);
    scene.fog = new THREE.Fog(0x070512, 11, 20); this.scene = scene;
    const cam = new THREE.PerspectiveCamera(42, W / H, 0.1, 100); cam.position.set(0, -PANY, 8.2); cam.lookAt(0, -PANY, 0); this.cam = cam;

    // ── procedural env map (PMREM) ──
    let ENV = null;
    try {
      const envTex = new THREE.CanvasTexture(makeEnvCanvas());
      envTex.mapping = THREE.EquirectangularReflectionMapping; if (THREE.sRGBEncoding) envTex.encoding = THREE.sRGBEncoding;
      const pmrem = new THREE.PMREMGenerator(renderer); pmrem.compileEquirectangularShader();
      ENV = pmrem.fromEquirectangular(envTex).texture; scene.environment = ENV;
      pmrem.dispose(); envTex.dispose();
    } catch (e) { ENV = null; }
    this._env = ENV;

    // shared gold materials
    const matGold = new THREE.MeshStandardMaterial({ color: 0xb8862b, metalness: 1, roughness: 0.28, envMap: ENV, envMapIntensity: 1.6 });
    const matGoldBright = new THREE.MeshStandardMaterial({ color: 0xffcf5a, metalness: 1, roughness: 0.16, envMap: ENV, envMapIntensity: 2.2 });
    this._matGold = matGold;

    // lighting — cool ambient + cyan key / magenta rim / warm top + under-pool
    scene.add(new THREE.AmbientLight(0x4a5a8a, 0.7));
    const key = new THREE.DirectionalLight(0x9fd0ff, 1.0); key.position.set(-8, 6, 10); scene.add(key);
    const rim = new THREE.DirectionalLight(0xff4d9d, 0.7); rim.position.set(9, -3, 6); scene.add(rim);
    const warm = new THREE.PointLight(0xffd23f, 1.2, 40, 2); warm.position.set(0, 5, 7); scene.add(warm);
    const cyan = new THREE.PointLight(0x39e7ff, 0.7, 30); cyan.position.set(-7, 2, 6); scene.add(cyan);

    // ── velvet backdrop + godrays + sparkle ──
    const bgTex = (function () {
      const S = 1024, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
      const rg = x.createRadialGradient(S / 2, S * 0.43, 60, S / 2, S / 2, S * 0.72);
      rg.addColorStop(0, "#3a1d5e"); rg.addColorStop(0.45, "#1c0e34"); rg.addColorStop(1, "#040208");
      x.fillStyle = rg; x.fillRect(0, 0, S, S);
      x.globalCompositeOperation = "lighter";
      for (let i = 0; i < 7; i++) { x.save(); x.translate(S / 2, S * 0.16); x.rotate((i - 3) * 0.16); const lg = x.createLinearGradient(0, 0, 0, S * 0.9); lg.addColorStop(0, "rgba(120,80,200,.10)"); lg.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = lg; x.fillRect(-34, 0, 68, S * 0.9); x.restore(); }
      for (let i = 0; i < 160; i++) { const px = Math.random() * S, py = Math.random() * S, r = Math.random() * 2 + 0.4; x.globalAlpha = Math.random() * 0.5 + 0.1; x.fillStyle = "#cfe8ff"; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill(); }
      x.globalAlpha = 1; x.globalCompositeOperation = "source-over"; return new THREE.CanvasTexture(cv);
    })();
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(44, 30), new THREE.MeshBasicMaterial({ map: bgTex })); bg.position.z = -6.5; scene.add(bg);

    // drifting bokeh motes
    this._bokeh = [];
    const bokehCols = [0x39e7ff, 0xff4d9d, 0xffd23f, 0xc79bff];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.SpriteMaterial({ map: this._discTex, color: bokehCols[i % bokehCols.length], transparent: true, opacity: 0.18 + Math.random() * 0.18, blending: THREE.AdditiveBlending, depthWrite: false });
      const sp = new THREE.Sprite(m); const sc = 0.7 + Math.random() * 1.6; sp.scale.set(sc, sc, 1);
      sp.position.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 12, -4 - Math.random() * 1.5);
      scene.add(sp); this._bokeh.push({ s: sp, vy: 0.15 + Math.random() * 0.25, phase: Math.random() * 6.28, amp: 0.4 + Math.random() * 0.6 });
    }

    // ── reel bank ──
    this.TILE = 1.5; this.REELW = 1.66;
    const bank = new THREE.Group(); scene.add(bank); this.bank = bank;
    const faceGeo = new THREE.PlaneGeometry(1.5, 1.5);
    const bodyGeo = new THREE.BoxGeometry(1.66, 1.6, 0.36);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0c1422, metalness: 0.6, roughness: 0.45, envMap: ENV, envMapIntensity: 0.5 });
    this.reels = [];
    for (let r = 0; r < REELS; r++) {
      const reel = { x: (r - 2) * this.REELW, pos: r * 7.3, strip: [], tiles: [], mode: "stopped", t: 0, dur: 1, start: 0, land: 0, easePow: 3, holdSpeed: 12, glow: 0, glowTarget: 0, cells: [0, 0, 0] };
      for (let i = 0; i < 64; i++) reel.strip.push((Math.random() * 8) | 0);
      for (let s = 0; s < 5; s++) {
        const grp = new THREE.Group(); grp.position.x = reel.x;
        const body = new THREE.Mesh(bodyGeo, bodyMat); grp.add(body);
        // faces are largely self-lit (baked art) so symbols stay crisp under any lighting
        const faceMat = new THREE.MeshStandardMaterial({ map: this._texCache[0], emissive: 0xffffff, emissiveMap: this._texCache[0], emissiveIntensity: 0.92, metalness: 0.1, roughness: 0.7, transparent: true });
        const face = new THREE.Mesh(faceGeo, faceMat); face.position.z = 0.2; grp.add(face);
        grp.userData = { face: face, mat: faceMat, sym: 0 };
        bank.add(grp); reel.tiles.push(grp);
      }
      this.reels.push(reel);
    }

    // Per-reel ANTICIPATION glow column
    this._anticGlows = [];
    for (let r = 0; r < REELS; r++) {
      const gMat = new THREE.MeshBasicMaterial({ color: 0xffcf3a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(this.REELW * 1.04, ROWS * this.TILE + 0.34), gMat);
      gl.position.set((r - 2) * this.REELW, 0, 0.78); scene.add(gl); this._anticGlows.push(gl);
    }

    const winH = ROWS * this.TILE; const bankW = REELS * this.REELW + 0.5;

    // dark occlusion masks (hide buffer tiles above/below the window) — sit behind the gold frame
    const maskMat = new THREE.MeshStandardMaterial({ color: 0x060810, metalness: 0.4, roughness: 0.6 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(bankW + 2.4, 4, 1.2), maskMat); top.position.set(0, winH / 2 + 2 + 0.02, 0.5); scene.add(top);
    const bot = top.clone(); bot.position.y = -(winH / 2 + 2 + 0.02); scene.add(bot);
    const lmask = new THREE.Mesh(new THREE.BoxGeometry(2.2, winH + 4.2, 1.2), maskMat); lmask.position.set(-(bankW / 2 + 1.0), 0, 0.5); scene.add(lmask);
    const rmask = lmask.clone(); rmask.position.x = bankW / 2 + 1.0; scene.add(rmask);

    // ── ornate GOLD frame (extruded, beveled, env-mapped) ──
    const fr = 0.62, outerW = bankW + fr * 1.4, outerH = winH + fr * 1.4;
    const shape = new THREE.Shape(); roundRectShape(shape, -outerW / 2, -outerH / 2, outerW, outerH, 0.5);
    const hole = new THREE.Path(); roundRectShape(hole, -bankW / 2 + 0.05, -winH / 2 + 0.05, bankW - 0.1, winH - 0.1, 0.3); shape.holes.push(hole);
    const frameGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: true, bevelThickness: 0.16, bevelSize: 0.16, bevelSegments: 3, steps: 1 });
    const frame = new THREE.Mesh(frameGeo, matGold); frame.position.z = 0.55; scene.add(frame); this._frame = frame;
    // bright inner lip
    const lipShape = new THREE.Shape(); roundRectShape(lipShape, -bankW / 2 - 0.02, -winH / 2 - 0.02, bankW + 0.04, winH + 0.04, 0.3);
    const lipHole = new THREE.Path(); roundRectShape(lipHole, -bankW / 2 + 0.18, -winH / 2 + 0.18, bankW - 0.36, winH - 0.36, 0.26); lipShape.holes.push(lipHole);
    const lip = new THREE.Mesh(new THREE.ExtrudeGeometry(lipShape, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 2, steps: 1 }), matGoldBright); lip.position.z = 0.92; scene.add(lip);

    // corner cabochon gems (faceted, alternating cyan/magenta)
    const cabGeo = new THREE.IcosahedronGeometry(0.2, 0);
    const corners = [[-bankW / 2, winH / 2], [bankW / 2, winH / 2], [-bankW / 2, -winH / 2], [bankW / 2, -winH / 2]];
    corners.forEach((c, i) => {
      const col = i % 2 ? 0xff4d9d : 0x39e7ff;
      const m = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, metalness: 0.2, roughness: 0.2, envMap: ENV, envMapIntensity: 1.4, flatShading: true });
      const cab = new THREE.Mesh(cabGeo, m); cab.position.set(c[0], c[1], 1.0); scene.add(cab);
    });

    // emissive neon trim ribbon (rides the inner edge — chase light glides on this)
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x39e7ff, emissive: 0x39e7ff, emissiveIntensity: 1.3, roughness: 0.4 });
    const tb = new THREE.Mesh(new THREE.BoxGeometry(bankW - 0.1, 0.08, 0.16), trimMat); tb.position.set(0, winH / 2 - 0.02, 0.95); scene.add(tb); this._trimTop = tb;
    const bb = tb.clone(); bb.position.y = -(winH / 2 - 0.02); scene.add(bb); this._trimBot = bb;
    const lpst = new THREE.Mesh(new THREE.BoxGeometry(0.08, winH - 0.1, 0.16), trimMat.clone()); lpst.position.set(-bankW / 2 + 0.05, 0, 0.95); scene.add(lpst);
    const rpst = lpst.clone(); rpst.position.x = bankW / 2 - 0.05; scene.add(rpst);
    this._trims = [tb, bb, lpst, rpst];

    // reel dividers (thin gold emissive strips between the 5 columns)
    const divMat = new THREE.MeshStandardMaterial({ color: 0x2a1f0a, metalness: 1, roughness: 0.3, emissive: 0xffd23f, emissiveIntensity: 0.7, envMap: ENV, envMapIntensity: 1.2 });
    for (let d = 1; d < REELS; d++) { const dv = new THREE.Mesh(new THREE.BoxGeometry(0.05, winH, 0.08), divMat); dv.position.set((d - 2.5) * this.REELW, 0, 0.5); scene.add(dv); }

    // ── perimeter chase light (anticipation/win) ──
    this._buildChase(bankW - 0.1, winH - 0.1);

    // ── GEM VAULT marquee ──
    this._buildMarquee(outerH, matGold);

    // glassy sheen overlay
    const sheen = new THREE.Mesh(new THREE.PlaneGeometry(bankW, winH), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false }));
    sheen.position.z = 1.05; scene.add(sheen);

    // under-glow pool
    const pool = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture(false), color: 0x39e7ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    pool.scale.set(bankW * 1.3, 2.6, 1); pool.position.set(0, -winH / 2 - 1.5, 0.2); scene.add(pool);

    // fx layers
    this.fx = new THREE.Group(); scene.add(this.fx);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(44, 30), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })); this.flash.position.z = 2; scene.add(this.flash);

    this._fitCamera();
    this._paintReels(true);
    this.renderer.render(this.scene, this.cam);
  };

  Slots3D.prototype._buildChase = function (w, h) {
    // sample a rounded-rect perimeter
    const r = 0.3, pts = [];
    const seg = [
      [-w / 2 + r, -h / 2, w / 2 - r, -h / 2], [w / 2, -h / 2 + r, w / 2, h / 2 - r],
      [w / 2 - r, h / 2, -w / 2 + r, h / 2], [-w / 2, h / 2 - r, -w / 2, -h / 2 + r],
    ];
    seg.forEach((s) => { const n = 30; for (let i = 0; i < n; i++) { const t = i / n; pts.push([s[0] + (s[2] - s[0]) * t, s[1] + (s[3] - s[1]) * t]); } });
    this._perim = pts; this._chaseT = 0; this._chaseActive = false; this._chaseSpeed = 0; this._chaseColor = 0x39e7ff;
    const mat = new THREE.SpriteMaterial({ map: this._discTex, color: this._chaseColor, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this._chase = new THREE.Sprite(mat); this._chase.scale.set(0.7, 0.7, 1); this._chase.position.z = 1.0; this.scene.add(this._chase);
    this._chaseTrail = [];
    for (let k = 0; k < 5; k++) { const s = new THREE.Sprite(mat.clone()); s.scale.set(0.55 - k * 0.06, 0.55 - k * 0.06, 1); s.position.z = 1.0; this.scene.add(s); this._chaseTrail.push(s); }
  };
  Slots3D.prototype._setChase = function (active, speed, color) {
    this._chaseActive = active; this._chaseSpeed = speed || 0;
    if (color != null) { this._chaseColor = color; this._chase.material.color.setHex(color); this._chaseTrail.forEach((s) => s.material.color.setHex(color)); }
  };

  Slots3D.prototype._buildMarquee = function (outerH, matGold) {
    const S = 1024, cv = document.createElement("canvas"); cv.width = S; cv.height = 300; const x = cv.getContext("2d");
    const grad = x.createLinearGradient(0, 40, 0, 240); grad.addColorStop(0, "#fff3c4"); grad.addColorStop(0.5, "#ffd23f"); grad.addColorStop(1, "#b8862b");
    x.font = "900 118px 'Bungee',Georgia,serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.shadowColor = "#39e7ff"; x.shadowBlur = 44; x.fillStyle = grad; x.fillText("ROYAL RICHES", S / 2, 150);
    x.shadowBlur = 0; x.lineWidth = 4; x.strokeStyle = "#5a3d0a"; x.strokeText("ROYAL RICHES", S / 2, 150);
    const tex = new THREE.CanvasTexture(cv);
    const y = outerH / 2 + 1.05;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 2.05), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    plate.position.set(0, y, 0.4); this.scene.add(plate); this._marquee = plate;
    // central jewel
    const jm = new THREE.MeshStandardMaterial({ color: 0xff4d9d, emissive: 0xff4d9d, emissiveIntensity: 0.6, metalness: 0.2, roughness: 0.15, envMap: this._env, envMapIntensity: 1.4, flatShading: true });
    const jewel = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), jm); jewel.position.set(0, y, 0.7); this.scene.add(jewel); this._marqueeJewel = jewel;
  };

  Slots3D.prototype._fitCamera = function () {
    const aspect = this.W / this.H, halfH = Math.tan((this.cam.fov * Math.PI / 180) / 2);
    const bankW = REELS * this.REELW + 1.6;   // reels + frame + air
    const winH = ROWS * this.TILE + 2.4;       // window + marquee headroom
    const zForW = (bankW / 0.94) / (2 * halfH * aspect);
    const zForH = (winH / 0.86) / (2 * halfH);
    this.cam.position.set(0, -PANY, Math.max(zForW, zForH));
    this.cam.lookAt(0, -PANY, 0); this.cam.updateProjectionMatrix();
  };

  Slots3D.prototype._paintReels = function () {
    const TILE = this.TILE;
    for (let r = 0; r < REELS; r++) {
      const reel = this.reels[r], L = reel.strip.length, i0 = Math.floor(reel.pos), f = reel.pos - i0;
      for (let s = -1; s <= 3; s++) {
        const tile = reel.tiles[s + 1];
        const sym = reel.strip[(((i0 + s) % L) + L) % L];
        tile.position.y = (1 - s + f) * TILE;
        if (tile.userData.sym !== sym) { tile.userData.sym = sym; const t = this._texCache[sym]; tile.userData.mat.map = t; tile.userData.mat.emissiveMap = t; tile.userData.mat.needsUpdate = true; }
      }
    }
  };

  /* ---------- spin ---------- */
  Slots3D.prototype._spin = function () {
    if (!this._active || this._spinning || this._bonus) return;
    if (!this._enabled) { this._msg("Connect a wallet to play for real", ""); return; }
    if (this.balance < this.bet) { this._msg("Not enough balance — add funds 👇", "lose"); return; }
    const bet = this.bet;
    this.balance = Math.round((this.balance - bet) * 100) / 100; this._save(); this._renderHud();
    this._clearWinFx();
    this._hideOverlay();
    this.nonce += 1;
    const grid = E.deriveGrid(this.serverSeed, this.clientSeed, this.nonce);
    this._result = E.evaluate(grid, bet);
    this._betThisSpin = bet; this._landedGrid = grid;
    this.state = "spinning"; this._spinning = true;
    this._setChase(true, 0.6, 0x39e7ff);
    this._msg("Spinning…", "");
    if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {}
    this._launchReels(grid, false);
    this._renderSpinBtn();
  };
  Slots3D.prototype._writeLand = function (reel, cells, turns) {
    const L = reel.strip.length;
    const land = Math.floor(reel.pos) + Math.max(3, turns | 0);
    reel.strip[((land % L) + L) % L] = cells[0];
    reel.strip[(((land + 1) % L) + L) % L] = cells[1];
    reel.strip[(((land + 2) % L) + L) % L] = cells[2];
    for (let k = 1; k <= 3; k++) reel.strip[((((land - k) % L) + L) % L)] = (Math.random() * 6) | 0;
    reel.start = reel.pos; reel.land = land; reel.t = 0;
  };
  Slots3D.prototype._launchReels = function (grid, fast) {
    let anticStart = REELS, sc = 0;
    if (!fast) {
      for (let r = 0; r < REELS; r++) {
        for (let row = 0; row < ROWS; row++) if (grid[r][row] === E.SCATTER) sc++;
        if (sc >= 2 && r + 1 < REELS) { anticStart = r + 1; break; }
      }
    }
    this._anticStart = anticStart;
    for (let r = 0; r < REELS; r++) {
      const reel = this.reels[r];
      reel.cells = grid[r]; reel.glowTarget = 0;
      if (r < anticStart) {
        this._writeLand(reel, grid[r], (fast ? 8 : 14) + r * (fast ? 2 : 3) + ((Math.random() * 3) | 0));
        reel.mode = "ease"; reel.easePow = 3; reel.dur = (fast ? 0.6 : 1.15) + r * (fast ? 0.14 : 0.32);
      } else {
        reel.mode = "hold"; reel.holdSpeed = 11 + Math.random() * 2; reel.t = 0;
      }
    }
  };

  Slots3D.prototype._onReelStopped = function (r) {
    if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {}
    this._punch(0.08); // per-reel thunk
    if (this._anticStart < REELS && r >= this._anticStart) {
      if (this._landedGrid[r].indexOf(E.SCATTER) >= 0) this._anticHit(r); else this._anticMiss(r);
    }
    if (r + 1 < REELS && this.reels[r + 1].mode === "hold") this._releaseAntic(r + 1);
  };
  Slots3D.prototype._releaseAntic = function (r) {
    const reel = this.reels[r];
    this._writeLand(reel, reel.cells, 5 + ((Math.random() * 2) | 0));
    reel.mode = "antic"; reel.easePow = 5; reel.dur = 2.3; reel.glowTarget = 1;
    this._setChase(true, 1.4, 0xffd23f); // tension: chase speeds up + goes gold
    if (root.Chiptune && root.Chiptune.swoosh) try { root.Chiptune.swoosh(2100); } catch (e) {}
  };
  Slots3D.prototype._anticHit = function (r) {
    this.reels[r].glowTarget = 1.7;
    this.flash.material.color.set(0xffd23f); this.flash.material.opacity = Math.max(this.flash.material.opacity, 0.24);
    this._punch(0.2);
    const C = root.Chiptune; if (C && C.coin) try { C.coin(); } catch (e) {}
  };
  Slots3D.prototype._anticMiss = function (r) { this.reels[r].glowTarget = 0; };

  Slots3D.prototype._settle = function () {
    this._spinning = false; this.state = "win";
    for (const rr of this.reels) rr.glowTarget = 0;
    const res = this._result, bet = this._betThisSpin;
    if (res.winUsd > 0) {
      this.balance = Math.round((this.balance + res.winUsd) * 100) / 100; this._save();
      this._showWinFx(res, bet);
    } else if (!this._bonus) {
      this._showWinBanner("", "miss"); if (this._wbAmt) this._wbAmt.textContent = "No win — spin again";
      this._msg("", "");
      this._setChase(false, 0);
      const C = root.Chiptune; if (C && C.lose) try { C.lose(); } catch (e) {}
    }
    this.lastRound = { nonce: this.nonce, win: res.winUsd };
    this._updatePf(); this._renderHud();

    if (this._bonus) { this._afterBonusSpin(res); return; }

    if (res.winUsd > 0 && this.onWin) { const profit = res.winUsd - bet; if (profit > 0) try { this.onWin({ profitUsd: profit, mult: res.winUsd / bet }); } catch (e) {} }
    if (res.scatter && res.scatter.count >= 3 && E.freeSpinsFor(res.scatter.count) > 0) { this._beginBonus(res.scatter.count); return; }
    clearTimeout(this._idleT); this._idleT = setTimeout(() => { if (!this._spinning && !this._bonus) { this.state = "idle"; this._msg("Tap SPIN", ""); this._renderSpinBtn(); } }, 1600);
    this._renderSpinBtn();
  };

  Slots3D.prototype._showWinFx = function (res, bet) {
    const mark = {};
    res.lines.forEach((ln) => ln.rows.forEach((row, r) => { mark[r + ":" + row] = 1; }));
    if (res.scatter) res.scatter.cells.forEach((c) => { mark[c[0] + ":" + c[1]] = 1; });
    this._pulseCells(mark);
    this._ringCells(mark); // ring burst on every winning cell
    const big = res.winUsd >= bet * 10, mega = res.winUsd >= bet * 40;
    // chase celebrates: gold + fast laps; faster the bigger
    this._setChase(true, mega ? 2.0 : big ? 1.6 : 1.1, 0xffd23f);
    if (this._bonus) this._punch(mega ? 0.5 : 0.34); else if (mega) this._punch(0.42); else if (big) this._punch(0.24);
    this.flash.material.opacity = mega ? 0.5 : big ? 0.34 : (this._bonus ? 0.28 : 0.2); this.flash.material.color.set(mega ? 0xffd23f : (this._bonus ? 0xff4d9d : 0x45f0a6));
    this._winFx = { t: 0, total: res.winUsd, shown: 0, dur: this._bonus ? 0.7 : (mega ? 1.9 : big ? 1.5 : 1.0), big: big, mega: mega, lastCoin: -1 };
    const n = mega ? 46 : big ? 28 : 14; for (let i = 0; i < n; i++) this._spawnCoin();
    const gemN = this._bonus ? (mega ? 34 : big ? 26 : 18) : (mega ? 30 : big ? 16 : 0);
    if (gemN) this._burstGems(gemN, mega ? 7.5 : 6);
    if (!this._bonus) { this._showWinBanner("💎 WIN", mega ? "mega" : big ? "big" : ""); this._msg(res.scatter ? "VAULT BONUS!" : "", "win"); }
    const C = root.Chiptune; if (C) try { if (mega && C.jackpot) C.jackpot(); else if (big && C.bigwin) C.bigwin(); else if (C.win) C.win(); } catch (e) {}
  };

  /* ---------- FREE SPINS bonus round ---------- */
  Slots3D.prototype._beginBonus = function (scatterCount) {
    const plan = E.deriveBonus(this.serverSeed, this.clientSeed, this.nonce, this._betThisSpin, scatterCount);
    if (!plan.spins) { clearTimeout(this._idleT); this._idleT = setTimeout(() => { this.state = "idle"; this._msg("Tap SPIN", ""); this._renderSpinBtn(); }, 1600); return; }
    this._bonus = { plan: plan, i: 0, total: 0, count: scatterCount };
    this._renderSpinBtn();
    this._punch(0.6); this.flash.material.color.set(0xffd23f); this.flash.material.opacity = 0.65;
    this._setChase(true, 2.2, 0xffd23f);
    for (let i = 0; i < 42; i++) this._spawnCoin();
    if (this._result && this._result.scatter) this._result.scatter.cells.forEach((c) => { this.reels[c[0]].glowTarget = 1.5; });
    this._showOverlay("🔓 VAULT BONUS!", plan.spins + " FREE SPINS", "every win pays ×" + plan.mult, "intro");
    const C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
    clearTimeout(this._bonusT); this._bonusT = setTimeout(() => this._bonusSpin(), 2100);
  };
  Slots3D.prototype._bonusSpin = function () {
    const b = this._bonus; if (!b) return;
    const spin = b.plan.results[b.i];
    this._clearWinFx();
    this._result = { winUsd: spin.winUsd, lines: spin.lines, scatter: spin.scatter };
    this.state = "spinning"; this._spinning = true;
    this._updateOverlay("FREE SPIN " + (b.i + 1) + " / " + b.plan.spins, "BONUS  " + this._usd(b.total), "×" + b.plan.mult);
    if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {}
    this._launchReels(spin.grid, true);
    this._renderSpinBtn();
  };
  Slots3D.prototype._afterBonusSpin = function (res) {
    const b = this._bonus; if (!b) return;
    b.total = Math.round((b.total + res.winUsd) * 100) / 100;
    this._updateOverlay("FREE SPIN " + (b.i + 1) + " / " + b.plan.spins, "BONUS  " + this._usd(b.total), res.winUsd > 0 ? "+" + this._usd(res.winUsd) + "  💎" : "— no win");
    if (res.winUsd > 0 && this._ov) { this._ov.classList.remove("pop"); void this._ov.offsetWidth; this._ov.classList.add("pop"); }
    b.i += 1;
    clearTimeout(this._bonusT);
    if (b.i < b.plan.spins) this._bonusT = setTimeout(() => this._bonusSpin(), res.winUsd > 0 ? 1050 : 650);
    else this._bonusT = setTimeout(() => this._endBonus(), 1100);
  };
  Slots3D.prototype._endBonus = function () {
    const b = this._bonus; if (!b) return;
    const total = b.total, spins = b.plan.spins, mult = b.plan.mult;
    this._bonus = null; this._spinning = false;
    this._setChase(false, 0);
    this._showOverlay("🏆 BONUS COMPLETE", "+" + this._usd(total), spins + " free spins · ×" + mult, "end");
    const C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
    if (this.onWin && total > 0) try { this.onWin({ profitUsd: total, mult: mult, bonus: true }); } catch (e) {}
    this._renderHud();
    clearTimeout(this._bonusT); this._bonusT = setTimeout(() => { this.state = "idle"; this._msg("🏆 Bonus banked — tap SPIN", "win"); this._renderSpinBtn(); }, 1400);
    this._renderSpinBtn();
  };
  Slots3D.prototype._finishBonusNow = function () {
    const b = this._bonus; if (!b) return;
    clearTimeout(this._bonusT); this._bonusT = 0;
    for (let i = b.i; i < b.plan.results.length; i++) {
      const w = b.plan.results[i].winUsd;
      if (w > 0) { this.balance = Math.round((this.balance + w) * 100) / 100; b.total = Math.round((b.total + w) * 100) / 100; }
    }
    this._save();
    if (this.onWin && b.total > 0) try { this.onWin({ profitUsd: b.total, mult: b.plan.mult, bonus: true }); } catch (e) {}
    this._bonus = null; this._spinning = false; this.state = "idle";
    this._hideOverlay(); this._renderHud(); this._renderSpinBtn();
  };

  /* ---------- bonus overlay (DOM over the canvas) ---------- */
  Slots3D.prototype._buildOverlay = function () {
    if (this._ov || !this.mount) return;
    const ov = document.createElement("div"); ov.className = "s3d-bonus hidden";
    ov.innerHTML = '<div class="s3d-bonus-title"></div><div class="s3d-bonus-big"></div><div class="s3d-bonus-sub"></div>';
    this.mount.appendChild(ov);
    this._ov = ov;
    this._ovEls = { title: ov.querySelector(".s3d-bonus-title"), big: ov.querySelector(".s3d-bonus-big"), sub: ov.querySelector(".s3d-bonus-sub") };
  };
  Slots3D.prototype._showOverlay = function (title, big, sub, mode) {
    this._buildOverlay(); if (!this._ov) return;
    this._ovEls.title.textContent = title || ""; this._ovEls.big.textContent = big || ""; this._ovEls.sub.textContent = sub || "";
    this._ov.className = "s3d-bonus " + (mode || "spin");
    void this._ov.offsetWidth; this._ov.classList.add("pop");
  };
  Slots3D.prototype._updateOverlay = function (title, big, sub) {
    this._buildOverlay(); if (!this._ov) return;
    this._ovEls.title.textContent = title || ""; this._ovEls.big.textContent = big || ""; this._ovEls.sub.textContent = sub || "";
    if (this._ov.classList.contains("hidden") || !this._ov.classList.contains("spin")) this._ov.className = "s3d-bonus spin";
  };
  Slots3D.prototype._hideOverlay = function () { if (this._ov) this._ov.className = "s3d-bonus hidden"; };

  Slots3D.prototype._pulseCells = function (mark) {
    this._pulses = [];
    for (let r = 0; r < REELS; r++) for (let row = 0; row < ROWS; row++) {
      if (!mark[r + ":" + row]) continue;
      const tile = this.reels[r].tiles[row + 1];
      this._pulses.push({ tile: tile, t: 0 });
    }
  };
  // additive ring burst at each winning cell
  Slots3D.prototype._ringCells = function (mark) {
    for (let r = 0; r < REELS; r++) for (let row = 0; row < ROWS; row++) {
      if (!mark[r + ":" + row]) continue;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._ringTex, color: 0xffe08a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.position.set((r - 2) * this.REELW, (1 - row) * this.TILE, 1.1); sp.scale.set(0.3, 0.3, 1); this.fx.add(sp);
      this._rings.push({ s: sp, t: 0, dur: 0.5, delay: r * 0.05 });
    }
  };

  Slots3D.prototype._spawnCoin = function () {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._coinTex, transparent: true }));
    const sc = 0.4 + Math.random() * 0.4; sp.scale.set(sc, sc, sc);
    sp.position.set((Math.random() - 0.5) * 6, -3.4, 2.4); this.fx.add(sp);
    this._coins.push({ s: sp, vx: (Math.random() - 0.5) * 3.5, vy: 5.5 + Math.random() * 4, vr: 0, life: 1.1 + Math.random() * 0.7, t: 0 });
  };
  Slots3D.prototype._spawnGem = function (power) {
    const tex = this._gemTex[(Math.random() * this._gemTex.length) | 0];
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    const sc = 0.5 + Math.random() * 0.6; sp.scale.set(sc, sc, sc);
    sp.material.rotation = Math.random() * 6.28;
    sp.position.set((Math.random() - 0.5) * 1.6, 0.3 + (Math.random() - 0.5) * 1.2, 2.6); this.fx.add(sp);
    const a = Math.random() * Math.PI * 2, spd = (0.55 + Math.random()) * power;
    this._gems.push({ s: sp, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd * 0.7 + power * 0.7, vr: (Math.random() - 0.5) * 9, life: 1.3 + Math.random() * 0.9, t: 0 });
  };
  Slots3D.prototype._burstGems = function (n, power) { for (let i = 0; i < n; i++) this._spawnGem(power); };

  /* ---------- on-TV win banner ---------- */
  Slots3D.prototype._buildWinBanner = function () {
    if (this._wb || !this.mount) return;
    const d = document.createElement("div"); d.className = "s3d-winbanner hidden";
    d.innerHTML = '<span class="s3d-wb-label">WIN</span><span class="s3d-wb-amt"></span>';
    this.mount.appendChild(d); this._wb = d; this._wbAmt = d.querySelector(".s3d-wb-amt");
  };
  Slots3D.prototype._showWinBanner = function (label, kind) {
    this._buildWinBanner(); if (!this._wb) return;
    this._wb.querySelector(".s3d-wb-label").textContent = (label == null) ? "WIN" : label;
    this._wb.className = "s3d-winbanner " + (kind || "");
    void this._wb.offsetWidth; this._wb.classList.add("pop");
  };
  Slots3D.prototype._hideWinBanner = function () { if (this._wb) this._wb.className = "s3d-winbanner hidden"; };

  /* ---------- per-frame ---------- */
  Slots3D.prototype._loop = function () {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now; this._t += dt;

    if (this._spinning) {
      for (let r = 0; r < REELS; r++) {
        const reel = this.reels[r];
        if (reel.mode === "stopped") continue;
        if (reel.mode === "hold") { reel.pos += reel.holdSpeed * dt; continue; }
        reel.t += dt; const k = Math.min(1, reel.t / reel.dur);
        const e = 1 - Math.pow(1 - k, reel.easePow || 3);
        reel.pos = reel.start + (reel.land - reel.start) * e;
        if (k >= 1) { reel.pos = reel.land; reel.mode = "stopped"; this._onReelStopped(r); }
      }
      this._paintReels();
      if (this.reels.every((rr) => rr.mode === "stopped")) { this._paintReels(); this._settle(); }
    } else { this._paintReels(); }

    // trim neon pulse
    const tp = 1.0 + 0.35 * Math.sin(this._t * 3);
    this._trimTop.material.emissiveIntensity = tp; this._trimBot.material.emissiveIntensity = tp;

    // marquee jewel spin + breathe
    if (this._marqueeJewel) { this._marqueeJewel.rotation.y += dt * 1.1; this._marqueeJewel.rotation.z = Math.sin(this._t * 0.8) * 0.2; this._marqueeJewel.material.emissiveIntensity = 0.5 + 0.25 * Math.abs(Math.sin(this._t * 1.6)); }

    // drifting bokeh
    if (this._bokeh) for (const b of this._bokeh) { b.s.position.y += b.vy * dt; b.s.position.x += Math.sin(this._t * 0.5 + b.phase) * b.amp * dt; if (b.s.position.y > 8) b.s.position.y = -8; }

    // perimeter chase light (+ trail)
    if (this._chase) {
      const want = this._chaseActive ? 1 : 0;
      this._chaseOpac = (this._chaseOpac || 0) + (want - (this._chaseOpac || 0)) * Math.min(1, dt * 6);
      if (this._chaseActive) this._chaseT = (this._chaseT + this._chaseSpeed * dt) % 1;
      const N = this._perim.length;
      const place = (spr, t, a) => { const i = (((Math.floor(((t % 1) + 1) % 1 * N)) % N) + N) % N; const p = this._perim[i]; spr.position.x = p[0]; spr.position.y = p[1]; spr.material.opacity = Math.max(0, a) * this._chaseOpac; };
      place(this._chase, this._chaseT, 1.0);
      this._chaseTrail.forEach((s, k) => place(s, this._chaseT - (k + 1) * 0.013, 0.6 - k * 0.11));
    }

    // win count-up
    if (this._winFx) { const w = this._winFx; w.t += dt; const kk = Math.min(1, w.t / w.dur); w.shown = w.total * (1 - Math.pow(1 - kk, 3));
      if (this.els.win) this.els.win.textContent = this._usd(w.shown);
      if (this._wbAmt && !this._bonus) this._wbAmt.textContent = this._usd(w.shown);
      if (kk < 1 && this._t - w.lastCoin > 0.06) { w.lastCoin = this._t; if (root.Chiptune && root.Chiptune.coin) try { root.Chiptune.coin(); } catch (e) {} }
      if (kk >= 1) { this._winFx = null; if (!this._bonus) this._setChase(false, 0); } }

    // win rings — expand + fade
    for (let i = this._rings.length - 1; i >= 0; i--) {
      const rg = this._rings[i]; if (rg.delay > 0) { rg.delay -= dt; continue; }
      rg.t += dt; const k = Math.min(1, rg.t / rg.dur); const sc = 0.3 + (1 - Math.pow(1 - k, 5)) * 2.2;
      rg.s.scale.set(sc, sc, 1); rg.s.material.opacity = 0.95 * (1 - k);
      if (k >= 1) { this.fx.remove(rg.s); rg.s.material.dispose(); this._rings.splice(i, 1); }
    }

    // gems
    for (let i = this._gems.length - 1; i >= 0; i--) {
      const gm = this._gems[i]; gm.t += dt; gm.vy -= 8.5 * dt;
      gm.s.position.x += gm.vx * dt; gm.s.position.y += gm.vy * dt; gm.s.material.rotation += gm.vr * dt;
      const k = gm.t / gm.life; gm.s.material.opacity = k < 0.7 ? 1 : Math.max(0, 1 - (k - 0.7) / 0.3);
      if (gm.t >= gm.life || gm.s.position.y < -4.6) { this.fx.remove(gm.s); gm.s.material.dispose(); this._gems.splice(i, 1); }
    }

    // pulse winning tiles
    for (const p of this._pulses) { p.t += dt; const s = 1 + 0.12 * Math.abs(Math.sin(p.t * 7)); p.tile.scale.set(s, s, 1); p.tile.userData.mat.emissiveIntensity = 0.92 + 0.7 * Math.abs(Math.sin(p.t * 7)); }

    // per-reel anticipation glow
    if (this._anticGlows) for (let r = 0; r < REELS; r++) {
      const reel = this.reels[r], gl = this._anticGlows[r];
      reel.glow += (reel.glowTarget - reel.glow) * Math.min(1, dt * 7);
      const pulse = reel.mode === "antic" ? (0.62 + 0.38 * Math.abs(Math.sin(this._t * 9))) : 1;
      gl.material.opacity = Math.max(0, reel.glow * 0.42 * pulse);
    }

    // idle attract: gentle symbol shimmer when nothing is happening
    if (!this._spinning && !this._winFx && this._pulses.length === 0) {
      for (let r = 0; r < REELS; r++) for (let s = 1; s <= 3; s++) {
        const m = this.reels[r].tiles[s].userData.mat;
        m.emissiveIntensity = 0.86 + 0.1 * Math.sin(this._t * 1.8 + r * 0.6 + s * 0.9);
      }
    }

    // coins
    for (let i = this._coins.length - 1; i >= 0; i--) { const c = this._coins[i]; c.t += dt; c.vy -= 9 * dt; c.s.position.x += c.vx * dt; c.s.position.y += c.vy * dt; c.s.material.opacity = Math.max(0, 1 - c.t / c.life);
      if (c.t >= c.life || c.s.position.y < -4) { this.fx.remove(c.s); c.s.material.dispose(); this._coins.splice(i, 1); } }

    // flash decay
    if (this.flash.material.opacity > 0.01) this.flash.material.opacity *= 0.9; else this.flash.material.opacity = 0;

    // gentle camera parallax + decaying impact shake
    this._shake = (this._shake || 0) * 0.86; if (this._shake < 0.003) this._shake = 0;
    const sx = (Math.random() - 0.5) * this._shake, sy = (Math.random() - 0.5) * this._shake;
    this.cam.position.x = Math.sin(this._t * 0.4) * 0.18 + sx; this.cam.position.y = -PANY + sy; this.cam.position.z = this._camZ + Math.sin(this._t * 0.6) * 0.04; this.cam.lookAt(0, -PANY, 0);

    this.renderer.render(this.scene, this.cam);
  };
  Slots3D.prototype._punch = function (amt) { this._shake = Math.max(this._shake || 0, amt); };

  Slots3D.prototype._clearWinFx = function () {
    for (const p of this._pulses) { p.tile.scale.set(1, 1, 1); p.tile.userData.mat.emissiveIntensity = 0.92; }
    this._pulses = []; this._winFx = null; if (this.els.win) this.els.win.textContent = this._usd(0);
    for (const c of this._coins) { this.fx.remove(c.s); }
    this._coins = [];
    for (const g of this._gems) { this.fx.remove(g.s); g.s.material.dispose(); }
    this._gems = [];
    for (const rg of this._rings) { this.fx.remove(rg.s); rg.s.material.dispose(); }
    this._rings = [];
    this._hideWinBanner();
  };

  /* ---------- HUD / wiring ---------- */
  Slots3D.prototype._usd = function (n) { return "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  Slots3D.prototype._eth = function (n) { return "Ξ" + ((+n || 0) / (this.ethUsd || 3400)).toFixed(4); };
  Slots3D.prototype._msg = function (t, cls) { if (this.els.message) { this.els.message.textContent = t; this.els.message.className = "s3d-msg " + (cls || ""); } };
  Slots3D.prototype._renderHud = function () { const e = this.els;
    if (e.balance) e.balance.textContent = this._usd(this.balance);
    if (e.betVal) e.betVal.textContent = this._usd(this.bet);
    if (e.betEth) e.betEth.textContent = "≈ " + this._eth(this.bet);
    if (e.pfHash) e.pfHash.textContent = this.commitHash.slice(0, 16) + "…";
    if (e.pfNonce) e.pfNonce.textContent = String(this.nonce);
  };
  Slots3D.prototype._renderSpinBtn = function () {
    const b = this.els.spinBtn; if (!b) return;
    if (this._bonus) { b.textContent = "🎁 FREE SPINS…"; b.dataset.kind = "wait"; b.disabled = true; }
    else if (this._spinning) { b.textContent = "SPINNING…"; b.dataset.kind = "wait"; b.disabled = true; }
    else if (!this._enabled) { b.textContent = "CONNECT TO PLAY"; b.dataset.kind = "wait"; b.disabled = true; }
    else { b.textContent = "🎰 SPIN  " + this._usd(this.bet); b.dataset.kind = "spin"; b.disabled = this.balance < this.bet; }
  };
  Slots3D.prototype._syncBet = function () { const e = this.els;
    if (e.betSlider) e.betSlider.value = this.bet;
    this._renderHud(); this._renderSpinBtn();
  };
  Slots3D.prototype._setBet = function (v) { this.bet = Math.max(MIN_BET, Math.round((+v || MIN_BET) * 100) / 100); this._syncBet(); };
  Slots3D.prototype._updatePf = function () { if (this.els.pfNonce) this.els.pfNonce.textContent = String(this.nonce); if (this.els.pfLast && this.lastRound) this.els.pfLast.textContent = "round #" + this.lastRound.nonce + " · win " + this._usd(this.lastRound.win); };
  Slots3D.prototype._verifyLast = function () {
    if (!this.lastRound) { this._msg("Spin once, then verify", ""); return; }
    const v = E.verify(this.serverSeed, this.commitHash, this.clientSeed, this.lastRound.nonce, this._betThisSpin || this.bet);
    const ok = v.hashOk;
    if (this.els.pfReveal) this.els.pfReveal.textContent = "serverSeed " + this.serverSeed.slice(0, 12) + "… → hash " + (ok ? "MATCHES ✓" : "✗") + " · win " + this._usd(v.result.winUsd);
    this._msg(ok ? "✅ Round #" + this.lastRound.nonce + " verified" : "⚠️ mismatch", ok ? "win" : "lose");
  };
  Slots3D.prototype._save = function () { if (this.onBalance) try { this.onBalance(this.balance); } catch (e) {} };

  Slots3D.prototype._wire = function () {
    const e = this.els;
    if (e.spinBtn) e.spinBtn.addEventListener("click", () => this._spin());
    if (e.betSlider) e.betSlider.addEventListener("input", () => this._setBet(parseFloat(e.betSlider.value) || MIN_BET));
    if (e.betHalf) e.betHalf.addEventListener("click", () => this._setBet(this.bet / 2));
    if (e.betDouble) e.betDouble.addEventListener("click", () => this._setBet(this.bet * 2));
    if (e.betMax) e.betMax.addEventListener("click", () => this._setBet(this.balance));
    if (e.pfClient) e.pfClient.addEventListener("change", () => { this.clientSeed = e.pfClient.value || E.randomSeed(8); });
    if (e.pfVerify) e.pfVerify.addEventListener("click", () => this._verifyLast());
    window.addEventListener("keydown", (ev) => {
      if (ev.code !== "Space" || !this._active) return;
      const tag = (ev.target && ev.target.tagName) || ""; if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (document.querySelector(".modal:not(.hidden)")) return;
      ev.preventDefault(); this._spin();
    });
  };

  /* ---------- host bridge API (mirrors PressureGame) ---------- */
  Slots3D.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this._camZ = this.cam.position.z; this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
    else {
      if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0;
      if (this._bonus) this._finishBonusNow();
    }
  };
  Slots3D.prototype.setEnabled = function (on) { this._enabled = !!on; this._renderSpinBtn(); };
  Slots3D.prototype.setBalance = function (usd) { this.balance = Math.max(0, Math.round((+usd || 0) * 100) / 100); this._renderHud(); this._renderSpinBtn(); };
  Slots3D.prototype.setEthUsd = function (n) { if (n > 0) { this.ethUsd = n; this._renderHud(); } };
  Slots3D.prototype.setMode = function () { /* demo-only for now; kept for API symmetry */ };

  root.Slots3D = Slots3D;
})(typeof globalThis !== "undefined" ? globalThis : this);
