/* ============================================================================
   Crypto TV Flip — pixel "WIN SCENES" engine
   ----------------------------------------------------------------------------
   On a win, a little animated movie plays on the TV screen, escalating with the
   amount. Six scene archetypes span $20 → $500, and within each band every $20
   step bumps the spectacle (more coins / characters / effects). Everything is
   drawn with chunky fillRect "voxels" so it matches the 16-bit theme.

   Public API:
     WinScenes.init()                       // grab the canvas
     WinScenes.play({ amountUsd, side })     // play the scene for this win
     WinScenes.stop()
   ============================================================================ */
(function () {
  "use strict";

  let cv = null, g = null, raf = 0, startT = 0, dur = 0, playing = false, scene = null, P = null;
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function init() {
    cv = document.getElementById("scene-canvas");
    g = cv ? cv.getContext("2d") : null;
  }
  function size() {
    const tv = document.getElementById("tv-screen");
    if (!tv || !cv) return;
    const r = tv.getBoundingClientRect();
    cv.width = Math.max(2, Math.floor(r.width));
    cv.height = Math.max(2, Math.floor(r.height));
  }

  // ---- tiny drawing helpers (g is the active ctx) ----
  function rect(x, y, w, h, c) { g.fillStyle = c; g.fillRect(x | 0, y | 0, Math.ceil(w), Math.ceil(h)); }
  function rnd(seed) { // deterministic per-scene pseudo-random
    let s = (seed * 9301 + 49297) % 233280;
    return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  }
  function shake(amount) {
    const a = amount * P.shake;
    g.translate((Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
  }
  function bg(top, bot) {
    const grad = g.createLinearGradient(0, 0, 0, P.h);
    grad.addColorStop(0, top); grad.addColorStop(1, bot);
    g.fillStyle = grad; g.fillRect(-40, -40, P.w + 80, P.h + 80);
  }
  function ground(c) { rect(-40, P.h * 0.82, P.w + 80, P.h, c); }
  function star(x, y, s, c) { rect(x - s, y, s * 2 + 1, 1, c); rect(x, y - s, 1, s * 2 + 1, c); }

  // A chunky blocky person. pose: arm angle 0..1 (up), jump offset applied by caller.
  // pal: { skin, shirt, hat, leg }
  function person(x, y, s, pal, armUp, face) {
    // legs
    rect(x - s, y, s, s * 2, pal.leg); rect(x + 1, y, s, s * 2, pal.leg);
    // body
    rect(x - s - 1, y - s * 3, s * 2 + 3, s * 3, pal.shirt);
    // arms (raised when armUp)
    const ay = armUp ? -s * 4.5 : -s * 2.5;
    rect(x - s * 2 - 1, y + ay, s, armUp ? s * 2 : s, pal.skin);
    rect(x + s + 2, y + ay, s, armUp ? s * 2 : s, pal.skin);
    // head
    rect(x - s, y - s * 5, s * 2 + 1, s * 2, pal.skin);
    // hat
    if (pal.hat) { rect(x - s - 1, y - s * 6, s * 2 + 3, s, pal.hat); rect(x - s, y - s * 6.8, s * 2 + 1, s, pal.hat); }
    // eyes / smile
    if (face !== false) { rect(x - s + 1, y - s * 4, 1.5, 1.5, "#1a1a1a"); rect(x + s - 1, y - s * 4, 1.5, 1.5, "#1a1a1a"); }
  }

  function coin(x, y, r, spin) {
    // spin 0..1 squashes width to fake a 3D flip
    const w = Math.max(1, r * Math.abs(Math.cos(spin * Math.PI)) + 1);
    g.fillStyle = "#a9760a"; g.fillRect(x - w, y - r, w * 2, r * 2);
    g.fillStyle = "#ffcf3f"; g.fillRect(x - w + 1, y - r + 1, w * 2 - 2, r * 2 - 2);
    if (w > r * 0.5) { g.fillStyle = "#7a5200"; g.fillRect(x - 1, y - r * 0.5, 2, r); } // Ξ hint
  }

  // ---- particle systems (rebuilt each play) ----
  let coins = [], confetti = [];
  function spawnCoins(n, cx, cy, power, rg) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (rg() - 0.5) * 2.2;
      const v = power * (0.6 + rg() * 0.8);
      coins.push({ x: cx + (rg() - 0.5) * 20, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - power * 0.4, r: 3 + rg() * 3, spin: rg(), vs: 0.04 + rg() * 0.06 });
    }
  }
  function stepCoins() {
    for (const c of coins) { c.vy += 0.22; c.x += c.vx; c.y += c.vy; c.spin += c.vs; }
    coins = coins.filter((c) => c.y < P.h + 20);
    for (const c of coins) coin(c.x, c.y, c.r, c.spin);
  }
  const CONF = ["#ff5b5b", "#39e7ff", "#ffcf3f", "#34e39b", "#b06bff", "#ff7ad5"];
  function spawnConfetti(n, rg) {
    for (let i = 0; i < n; i++) confetti.push({ x: rg() * P.w, y: -rg() * P.h, vy: 1 + rg() * 2.4, vx: (rg() - 0.5) * 1.4, s: 2 + rg() * 3, c: CONF[(rg() * CONF.length) | 0], sw: rg() * 6 });
  }
  function stepConfetti() {
    for (const p of confetti) { p.y += p.vy; p.x += p.vx + Math.sin((startT + p.y) * 0.05) * 0.6; p.sw += 0.2; rect(p.x, p.y, p.s, p.s * (0.5 + Math.abs(Math.cos(p.sw)) * 0.8), p.c); }
    confetti = confetti.filter((p) => p.y < P.h + 10);
  }

  // ---- the win text overlay (pixel font via Press Start 2P) ----
  function winText(t) {
    const pop = Math.min(1, t / 260);
    const sc = 1 + Math.sin(Math.min(t, 600) / 600 * Math.PI) * 0.12;
    g.save();
    g.translate(P.w / 2, P.h * 0.30);
    g.scale(pop * sc, pop * sc);
    g.textAlign = "center";
    g.font = "700 " + Math.round(P.h * 0.12) + "px 'Press Start 2P', monospace";
    g.fillStyle = "#0a3"; g.fillText(P.headline, 3, 3);
    g.fillStyle = "#34e39b"; g.fillText(P.headline, 0, 0);
    g.font = "800 " + Math.round(P.h * 0.16) + "px 'Press Start 2P', monospace";
    g.fillStyle = "#b25b00"; g.fillText(P.amtStr, 3, P.h * 0.17 + 3);
    g.fillStyle = "#ffd14a"; g.fillText(P.amtStr, 0, P.h * 0.17);
    g.restore();
  }

  // =========================== SCENES ===========================
  // Each scene(t) draws ONE frame; t = ms since start. Uses P (params) + helpers.

  function sArcade(t) {
    bg("#1a1030", "#0a0a14");
    const r = rnd(77);
    for (let i = 0; i < 18; i++) {
      const sx = r() * P.w, sy = r() * P.h * 0.7;
      const tw = (Math.sin(t / 300 + i) + 1) * 0.5;
      if (tw > 0.4) star(sx, sy, Math.max(1, P.h * 0.006), i % 2 ? "#5b6bff" : "#2a3a8a");
    }
    ground("#241634");
    const gy = P.h * 0.84;
    const cabX = P.w * 0.66, cabW = P.w * 0.2, cabH = P.h * 0.42;
    const cabY = gy - cabH;
    rect(cabX - cabW / 2 - P.w * 0.01, cabY - P.h * 0.01, cabW + P.w * 0.02, cabH + P.h * 0.01, "#15101f");
    rect(cabX - cabW / 2, cabY, cabW, cabH, "#3a2f5e");
    const glow = (Math.sin(t / 160) + 1) * 0.5;
    const screenCol = glow > 0.5 ? "#ff4faf" : "#4fd0ff";
    rect(cabX - cabW * 0.36, cabY + cabH * 0.08, cabW * 0.72, cabH * 0.32, "#0a0814");
    rect(cabX - cabW * 0.3, cabY + cabH * 0.12, cabW * 0.6, cabH * 0.24, screenCol);
    for (let i = 0; i < 3; i++) {
      const bx = cabX - cabW * 0.18 + i * cabW * 0.18;
      rect(bx, cabY + cabH * 0.5, cabW * 0.08, cabH * 0.04, i === Math.floor(t / 200) % 3 ? "#ffe14f" : "#7a2f5e");
    }
    rect(cabX - cabW * 0.34, cabY + cabH * 0.6, cabW * 0.68, cabH * 0.18, "#241b3a");
  
    const cx = P.w * 0.34;
    const bounce = Math.abs(Math.sin(t / 150)) * P.h * 0.05;
    const armUp = (t % 360) < 200;
    person(cx, gy - bounce, Math.max(3, P.h * 0.03), { skin: "#ffd9a8", shirt: "#ff5b8a", hat: "#4fd0ff", leg: "#2b3a67" }, armUp, 0);
    if (P.step >= 2) {
      const b2 = Math.abs(Math.sin(t / 150 + 1)) * P.h * 0.04;
      person(cx - P.w * 0.13, gy - b2, Math.max(2, P.h * 0.024), { skin: "#ffcf9f", shirt: "#a06bff", hat: 0, leg: "#333" }, (t % 360) >= 180, 0);
    }
  
    const pop = Math.min(1, t / 220);
    const ease = pop < 1 ? 1 - Math.pow(1 - pop, 3) : 1;
    const wob = Math.sin(t / 120) * P.h * 0.012;
    const ux = cx, uy = gy - P.h * 0.42 - ease * P.h * 0.06 + wob;
    const us = ease * Math.max(8, P.h * 0.05);
    g.save();
    g.translate(ux, uy);
    g.fillStyle = "#0a0814";
    g.fillRect(-us * 1.5 - 2, -us * 0.7 - 2, us * 3 + 4, us * 1.4 + 4);
    g.fillStyle = (Math.floor(t / 120) % 2) ? "#ffe14f" : "#4fffa0";
    g.fillRect(-us * 1.5, -us * 0.7, us * 3, us * 1.4);
    g.fillStyle = "#0a0814";
    g.textAlign = "center";
    g.font = "bold " + Math.round(us * 1.5) + "px monospace";
    g.fillText("1UP", 0, us * 0.5);
    g.restore();
  
    if (t > 40 && t < 80) spawnCoins(3 + P.step * 2, cabX, cabY + cabH * 0.25, P.h * 0.05, P.rg);
    if (t % 70 < 8 && t > 100) spawnCoins(1 + P.step, cx, gy - P.h * 0.3, P.h * 0.045, P.rg);
    stepCoins();
  
    if (P.step >= 3 && t < 40) spawnConfetti(10 + P.step * 4, P.rg);
    stepConfetti();
  }

  function sLuckyCat(t) {
    bg("#3a1420", "#120608");
    ground("#2a1410");
    const r = rnd(77);
    for (let i = 0; i < 14 + P.step * 4; i++) {
      const sx = r() * P.w, sy = r() * P.h * 0.7;
      const tw = 0.5 + 0.5 * Math.sin(t / 240 + i);
      if (tw > 0.45) star(sx, sy, P.h * 0.012 * tw, "#ffd86b");
    }
    const cx = P.w / 2, gy = P.h * 0.84;
    const lx = P.w * 0.22, rx = P.w * 0.78;
    const swing = Math.sin(t / 300) * P.w * 0.006;
    const glow = 0.6 + 0.4 * Math.sin(t / 220);
    const drawLantern = (x, sw) => {
      const ly = P.h * 0.34 + sw;
      rect(x - P.w * 0.004, P.h * 0.06, P.w * 0.008, ly - P.h * 0.06, "#5a2a14");
      rect(x - P.w * 0.05, ly - P.h * 0.015, P.w * 0.1, P.h * 0.012, "#1a0a06");
      rect(x - P.w * 0.052, ly, P.w * 0.104, P.h * 0.13, "#7a0d0d");
      rect(x - P.w * 0.052, ly, P.w * 0.104, P.h * 0.13, `rgba(255,120,40,${0.25 * glow})`);
      rect(x - P.w * 0.052, ly + P.h * 0.055, P.w * 0.104, P.h * 0.02, "#c01515");
      rect(x - P.w * 0.014, ly + P.h * 0.03, P.w * 0.028, P.h * 0.07, `rgba(255,225,120,${0.55 * glow})`);
      rect(x - P.w * 0.05, ly + P.h * 0.13, P.w * 0.1, P.h * 0.012, "#1a0a06");
      for (let f = 0; f < 4; f++) rect(x - P.w * 0.04 + f * P.w * 0.026, ly + P.h * 0.142, P.w * 0.006, P.h * 0.03, "#e8b400");
    };
    drawLantern(lx, Math.sin(t / 260) * P.h * 0.01);
    drawLantern(rx, Math.sin(t / 260 + 1.3) * P.h * 0.01);
    const bob = Math.sin(t / 400) * P.h * 0.01;
    const cy = gy - bob;
    const u = Math.max(3, P.h * 0.05);
    g.save();
    g.translate(swing, 0);
    rect(cx - u * 2.4, cy - u * 0.4, u * 4.8, u * 0.5, "#1a0a06");
    rect(cx - u * 2.1, cy - u * 3.6, u * 4.2, u * 3.4, "#f4f0ea");
    rect(cx - u * 2.1, cy - u * 1.0, u * 4.2, u * 0.8, "#e2dcd2");
    rect(cx - u * 1.9, cy - u * 5.0, u * 3.8, u * 1.6, "#f4f0ea");
    rect(cx - u * 1.9, cy - u * 5.9, u * 0.9, u * 1.0, "#f4f0ea");
    rect(cx + u * 1.0, cy - u * 5.9, u * 0.9, u * 1.0, "#f4f0ea");
    rect(cx - u * 1.75, cy - u * 5.7, u * 0.55, u * 0.65, "#f0b8c0");
    rect(cx + u * 1.2, cy - u * 5.7, u * 0.55, u * 0.65, "#f0b8c0");
    rect(cx - u * 1.2, cy - u * 4.4, u * 0.55, u * 0.55, "#1a1a1a");
    rect(cx + u * 0.65, cy - u * 4.4, u * 0.55, u * 0.55, "#1a1a1a");
    rect(cx - u * 0.2, cy - u * 4.0, u * 0.4, u * 0.3, "#e08a3a");
    rect(cx - u * 0.55, cy - u * 3.7, u * 1.1, u * 0.16, "#caa");
    rect(cx - u * 2.3, cy - u * 3.55, u * 0.9, u * 0.12, "#caa");
    rect(cx + u * 1.4, cy - u * 3.55, u * 0.9, u * 0.12, "#caa");
    rect(cx - u * 1.6, cy - u * 1.7, u * 1.2, u * 1.4, "#7a0d0d");
    rect(cx + u * 0.4, cy - u * 1.7, u * 1.2, u * 1.4, "#7a0d0d");
    rect(cx - u * 0.4, cy - u * 2.4, u * 0.8, u * 0.8, "#e8b400");
    rect(cx - u * 0.18, cy - u * 2.25, u * 0.36, u * 0.5, "#a87800");
    const wave = (Math.sin(t / 160) + 1) * 0.5;
    const paw = -wave * u * 1.4;
    rect(cx + u * 1.9, cy - u * 2.2 + paw, u * 0.7, u * 1.4, "#f4f0ea");
    rect(cx + u * 1.85, cy - u * 2.5 + paw, u * 0.8, u * 0.6, "#f4f0ea");
    rect(cx - u * 2.55, cy - u * 1.4, u * 0.7, u * 1.0, "#f4f0ea");
    g.restore();
    if (t % 70 < 8 && t > 60) spawnCoins(2 + P.step * 2, cx + (P.rg() - 0.5) * P.w * 0.4, P.h * 0.1, P.h * 0.04, P.rg);
    stepCoins();
    if (P.step >= 2) {
      const su = Math.max(2, P.h * 0.03);
      const sb = Math.sin(t / 300 + 2) * P.h * 0.008;
      const scx = P.w * 0.34, scy = gy - sb;
      rect(scx - su * 1.6, scy - su * 2.6, su * 3.2, su * 2.4, "#1a1a1a");
      rect(scx - su * 1.4, scy - su * 3.6, su * 2.8, su * 1.2, "#1a1a1a");
      rect(scx - su * 1.0, scy - su * 3.0, su * 0.45, su * 0.45, "#e8b400");
      rect(scx + su * 0.5, scy - su * 3.0, su * 0.45, su * 0.45, "#e8b400");
      rect(scx - su * 0.2, scy - su * 2.6, su * 0.4, su * 0.3, "#f0b8c0");
      const sw2 = (Math.sin(t / 160 + 1.5) + 1) * 0.5;
      rect(scx + su * 1.4, scy - su * 1.8 - sw2 * su, su * 0.5, su * 1.0, "#1a1a1a");
    }
    if (P.step >= 3 && t < 40) spawnConfetti(20 + P.step * 6, P.rg);
    stepConfetti();
    if (P.step >= 4 && t % 90 < 8) spawnFirework(P.w * (0.3 + P.rg() * 0.4), P.h * 0.25, P.rg);
    stepFireworks();
  }

  function sCarnival(t) {
    bg("#2b1140", "#120816");
    ground("#3a2114");
    const cx = P.w / 2, gy = P.h * 0.86;
    const wheelR = P.h * 0.24;
    const wx = P.w * 0.30, wy = P.h * 0.42;
  
    const r = rnd(771);
    const bulbs = 16;
    for (let i = 0; i < bulbs; i++) {
      const a = (i / bulbs) * Math.PI * 2;
      const bx = wx + Math.cos(a) * (wheelR + P.h * 0.03);
      const by = wy + Math.sin(a) * (wheelR + P.h * 0.03);
      const on = ((i + Math.floor(t / 120)) % 2) === 0;
      star(bx, by, P.h * 0.012, on ? "#ffe66b" : "#7a5a1a");
    }
  
    let spin = 0;
    const spinDur = 1700;
    if (t < spinDur) {
      const p = t / spinDur;
      const ease = 1 - Math.pow(1 - p, 3);
      spin = ease * (Math.PI * 2 * (4 + P.step)) ;
    } else {
      const settle = Math.min(1, (t - spinDur) / 260);
      const wobble = Math.sin(settle * Math.PI * 3) * (1 - settle) * 0.18;
      spin = (Math.PI * 2 * (4 + P.step)) + wobble;
    }
  
    g.save();
    g.translate(wx, wy);
    g.rotate(spin);
    const segs = 8;
    const segCols = ["#ff4d6d", "#ffd23f", "#4dd0e1", "#9b5de5", "#ff8c42", "#06d6a0", "#ef476f", "#ffd166"];
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      g.beginPath();
      g.moveTo(0, 0);
      g.fillStyle = segCols[i % segCols.length];
      const stepsA = 6;
      for (let s = 0; s <= stepsA; s++) {
        const aa = a0 + (a1 - a0) * (s / stepsA);
        g.lineTo(Math.cos(aa) * wheelR, Math.sin(aa) * wheelR);
      }
      g.closePath();
      g.fill();
    }
    g.fillStyle = "#1a0e26";
    g.beginPath();
    for (let s = 0; s <= 24; s++) {
      const aa = (s / 24) * Math.PI * 2;
      g.lineTo(Math.cos(aa) * wheelR * 0.18, Math.sin(aa) * wheelR * 0.18);
    }
    g.fill();
    g.restore();
  
    rect(wx + wheelR + P.h * 0.005, wy - P.h * 0.018, P.h * 0.05, P.h * 0.036, "#ffe66b");
    rect(wx + wheelR + P.h * 0.04, wy - P.h * 0.01, P.h * 0.03, P.h * 0.02, "#c0392b");
    rect(wx - P.h * 0.014, wy + wheelR, P.h * 0.028, gy - (wy + wheelR), "#5a3a1f");
  
    const landed = t >= spinDur;
    if (landed && t < spinDur + 80) {
      g.save();
      shake(P.h * 0.012 * (1 + P.step * 0.3));
      g.restore();
    }
    if (landed) {
      const fl = Math.floor((t - spinDur) / 110) % 2 === 0;
      rect(wx - P.h * 0.07, wy - wheelR - P.h * 0.11, P.h * 0.14, P.h * 0.05, fl ? "#fff27a" : "#ffb300");
      g.fillStyle = "#7a1f00";
      g.textAlign = "center";
      g.font = "bold " + Math.floor(P.h * 0.03) + "px monospace";
      g.fillText("JACKPOT", wx, wy - wheelR - P.h * 0.072);
    }
  
    const balN = 4 + P.step * 2;
    const balCols = ["#ff5b8d", "#5bd1ff", "#ffd23f", "#9b5de5", "#06d6a0", "#ff8c42", "#ef476f", "#7af5b0"];
    for (let i = 0; i < balN; i++) {
      const rb = rnd(400 + i);
      const baseX = rb() * P.w;
      const speed = 0.12 + rb() * 0.10;
      const sway = Math.sin(t / 360 + i) * P.w * 0.02;
      const launch = landed ? (t - spinDur) : 0;
      const by = P.h + P.h * 0.1 - launch * speed - rb() * P.h * 0.3;
      if (by < -P.h * 0.1) continue;
      const bx = baseX + sway;
      const br = P.h * 0.03 + rb() * P.h * 0.015;
      g.fillStyle = "#caa";
      rect(bx - 1, by + br, 2, P.h * 0.06, "#8a7a6a");
      g.fillStyle = balCols[i % balCols.length];
      g.beginPath();
      for (let s = 0; s <= 14; s++) {
        const aa = (s / 14) * Math.PI * 2;
        g.lineTo(bx + Math.cos(aa) * br * 0.8, by + Math.sin(aa) * br);
      }
      g.fill();
      rect(bx - br * 0.25, by - br * 0.4, br * 0.2, br * 0.4, "#ffffff");
    }
  
    if (landed && (t - spinDur) % 90 < 10 && (t - spinDur) < 600) {
      spawnConfetti(6 + P.step * 3, P.rg);
    }
    if (landed && t < spinDur + 60) {
      spawnFirework(P.w * 0.7, P.h * 0.3, P.rg);
      if (P.step >= 3) spawnFirework(P.w * 0.85, P.h * 0.45, P.rg);
    }
  
    const hx = P.w * 0.74, hy = gy;
    const cheer = landed && Math.sin(t / 90) > 0;
    const hop = landed ? Math.abs(Math.sin(t / 130)) * P.h * 0.04 : 0;
    person(hx, hy - hop, Math.max(3, P.h * 0.034), { skin: "#ffe0bd", shirt: "#ff3b6b", hat: "#33d6ff", leg: "#5b2bd6" }, cheer, 1);
    rect(hx - P.h * 0.012, hy - hop - P.h * 0.075, P.h * 0.024, P.h * 0.024, "#ff5252");
  
    if (P.step >= 2) {
      const sx = P.w * 0.90, sy = gy;
      const hop2 = landed ? Math.abs(Math.sin(t / 110 + 1)) * P.h * 0.03 : 0;
      person(sx, sy - hop2, Math.max(2, P.h * 0.026), { skin: "#ffcf9f", shirt: "#ffd23f", hat: 0, leg: "#2b3a67" }, landed, 0);
    }
  
    stepFireworks();
    stepConfetti();
  }

  function sPirate(t) {
    bg("#1b3a5c", "#081320");
    const r = rnd(777);
    for (let i = 0; i < 26; i++) {
      const sx = r() * P.w, sy = r() * P.h * 0.5;
      const tw = 0.5 + 0.5 * Math.sin(t / 320 + i * 1.7);
      if (tw > 0.55) star(sx, sy, Math.max(1, P.h * 0.006), "#cfe8ff");
    }
    const sea = P.h * 0.7;
    rect(0, sea, P.w, P.h - sea, "#123a52");
    for (let i = 0; i < 7; i++) {
      const wy = sea + (i + 1) * (P.h - sea) / 8;
      const wob = Math.sin(t / 240 + i) * P.w * 0.01;
      rect(wob, wy, P.w, Math.max(1, P.h * 0.008), "#1c5a78");
    }
    const roll = Math.sin(t / 360) * P.h * 0.012;
    const deckY = P.h * 0.82 + roll;
    rect(0, deckY, P.w, P.h - deckY, "#5a3a1c");
    rect(0, deckY, P.w, Math.max(2, P.h * 0.014), "#7a4f26");
    for (let i = 0; i < 9; i++) rect(i * P.w / 9, deckY, Math.max(1, P.w * 0.004), P.h - deckY, "#3f2812");
    const mastX = P.w * 0.16;
    rect(mastX, P.h * 0.2, Math.max(3, P.w * 0.018), deckY - P.h * 0.2, "#6b4423");
    const flY = P.h * 0.22 + Math.sin(t / 200) * P.h * 0.01;
    rect(mastX + P.w * 0.018, flY, P.w * 0.09, P.h * 0.06, "#161616");
    star(mastX + P.w * 0.018 + P.w * 0.045, flY + P.h * 0.026, Math.max(2, P.h * 0.012), "#f5f5f5");
    const cx = P.w / 2, gy = deckY;
    const chestX = P.w * 0.5, chestY = gy;
    const open = Math.min(1, Math.max(0, (t - 120) / 300));
    const cw = P.w * 0.16, ch = P.h * 0.1;
    rect(chestX - cw / 2, chestY - ch, cw, ch, "#6b3f1a");
    rect(chestX - cw / 2, chestY - ch, cw, Math.max(2, ch * 0.18), "#caa53a");
    g.save();
    g.translate(chestX, chestY - ch);
    g.rotate(-open * 1.1);
    rect(-cw / 2, -ch * 0.55, cw, ch * 0.6, "#5a3414");
    rect(-cw / 2, -ch * 0.55, cw, Math.max(2, ch * 0.16), "#caa53a");
    g.restore();
    if (open > 0.3) {
      const glow = 0.4 + 0.6 * Math.abs(Math.sin(t / 180));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI - Math.PI / 2;
        star(chestX + Math.cos(a) * cw * 0.4, chestY - ch * 1.1 - Math.sin(a) * ch * 0.3 * glow, Math.max(2, P.h * 0.012), "#ffe66b");
      }
      coin(chestX, chestY - ch * 0.7, Math.max(3, P.h * 0.02), 0.3);
    }
    if (t < 80 && t > 24) spawnCoins(10 + P.step * 8, chestX, chestY - ch * 1.3, P.h * 0.07, P.rg);
    if (t > 130 && t % 70 < 8) spawnCoins(4 + P.step * 2, chestX + (P.rg() - 0.5) * P.w * 0.2, P.h * 0.1, P.h * 0.04, P.rg);
    const bob = Math.abs(Math.sin(t / 200)) * P.h * 0.06;
    const armUp = Math.sin(t / 220) > -0.2;
    const capX = P.w * 0.74;
    person(capX, gy - bob, Math.max(4, P.h * 0.036), { skin: "#e7b98a", shirt: "#7a1f1f", hat: "#161616", leg: "#2a2118" }, armUp, "^_^");
    const s = Math.max(4, P.h * 0.036);
    const flap = Math.sin(t / 120) * s * 0.4;
    const pbx = capX - s * 1.4, pby = gy - bob - s * 7.2;
    rect(pbx - s * 0.6, pby, s * 1.2, s * 1.4, "#e23b3b");
    rect(pbx - s * 0.6, pby - s * 0.8, s, s, "#e23b3b");
    rect(pbx - s * 0.6 - s * 0.4, pby + flap, s * 0.5, s * 1.1, "#1f6fe0");
    rect(pbx + s * 0.1, pby - flap, s * 0.5, s * 1.1, "#f5c518");
    rect(pbx - s * 0.6, pby - s * 0.5, s * 0.3, s * 0.3, "#111");
    rect(pbx - s * 1.0, pby - s * 0.2, s * 0.4, s * 0.25, "#f5a623");
    if (P.step >= 2) {
      const b2 = Math.abs(Math.sin(t / 200 + 1.2)) * P.h * 0.05;
      person(P.w * 0.9, gy - b2, Math.max(3, P.h * 0.028), { skin: "#d9a877", shirt: "#1f5a3a", hat: "#3a2a1a", leg: "#2a2118" }, !armUp, ":D");
    }
    if (P.step >= 4) {
      const b3 = Math.abs(Math.sin(t / 200 + 2.4)) * P.h * 0.05;
      person(P.w * 0.6, gy - b3, Math.max(3, P.h * 0.026), { skin: "#e7b98a", shirt: "#2a3a7a", hat: 0, leg: "#222" }, armUp, ":)");
    }
    if (t < 60 && t > 20) spawnConfetti(14 + P.step * 6, P.rg);
    if (P.step >= 3 && t > 90 && t % 90 < 8) spawnFirework(P.w * (0.2 + P.rg() * 0.6), P.h * (0.18 + P.rg() * 0.2), P.rg);
    stepCoins();
    stepFireworks();
    stepConfetti();
    if (P.step >= 3 && t < 90) { g.save(); shake(P.step); g.restore(); }
  }

  function sGoldRush(t) {
    bg("#3a2a14", "#0d0a06");
    const r = rnd(404);
    for (let i = 0; i < 26; i++) {
      const sx = r() * P.w, sy = r() * P.h * 0.55;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(t / 240 + i));
      if (tw > 0.55) star(sx, sy, P.h * 0.012, i % 2 ? "#ffe07a" : "#fff3c0");
    }
    ground("#241608");
    const gy = P.h * 0.82;
    const veinX = P.w * 0.62, veinY = gy - P.h * 0.02;
    const swing = Math.sin(t / 150);
    const strike = (Math.sin(t / 150) > 0.85);
    for (let i = 0; i < 7; i++) {
      const bx = P.w * (0.55 + r() * 0.22);
      const by = gy - P.h * (0.01 + r() * 0.10);
      rect(bx, by, P.w * 0.035, P.h * 0.05, i % 2 ? "#5a3d1c" : "#4a3216");
      rect(bx + P.w * 0.008, by + P.h * 0.012, P.w * 0.012, P.h * 0.012, "#ffd24a");
    }
    rect(veinX - P.w * 0.01, veinY - P.h * 0.08, P.w * 0.04, P.h * 0.09, "#3a2810");
    for (let i = 0; i < 5; i++) {
      star(veinX + (r() - 0.5) * P.w * 0.03, veinY - P.h * (0.02 + r() * 0.06), P.h * 0.014, "#ffe26b");
    }
    if (strike && t % 60 < 10 && t > 120) {
      spawnCoins(10 + P.step * 6, veinX, veinY - P.h * 0.06, P.h * 0.075, P.rg);
      spawnFirework(veinX, veinY - P.h * 0.10, P.rg);
    }
    if (t < 90 && t > 30) spawnCoins(8 + P.step * 5, veinX, veinY - P.h * 0.05, P.h * 0.06, P.rg);
    const minerX = P.w * 0.40, ms = Math.max(3, P.h * 0.032);
    person(minerX, gy, ms, { skin: "#e7b487", shirt: "#c8542a", hat: "#3a2c18", leg: "#2b2018" }, false);
    g.save();
    g.translate(minerX + ms * 1.1, gy - ms * 5.2);
    g.rotate(swing * 0.9 - 0.3);
    rect(-ms * 0.18, 0, ms * 0.36, ms * 3.4, "#7a5a2e");
    rect(-ms * 1.1, -ms * 0.3, ms * 2.2, ms * 0.55, "#c9d0d8");
    rect(-ms * 1.1, -ms * 0.3, ms * 0.5, ms * 0.55, "#9aa3ad");
    g.restore();
    if (P.step >= 2) {
      const buddyJump = Math.abs(Math.sin(t / 170)) * P.h * 0.08;
      person(P.w * 0.18, gy - buddyJump, Math.max(2, P.h * 0.026), { skin: "#ffcf9f", shirt: "#39c0ff", hat: "#ffcf3a", leg: "#333" }, true);
    }
    if (P.step >= 4) {
      person(P.w * 0.30, gy, Math.max(2, P.h * 0.024), { skin: "#e0a878", shirt: "#7bd95a", hat: 0, leg: "#2b2018" }, true);
    }
    const cartProg = ((t / 2600) * 1.4) % 1.3 - 0.15;
    const cartX = P.w * (1.15 - cartProg * 1.3);
    const cartY = gy - P.h * 0.02;
    const cartW = P.w * 0.16, cartH = P.h * 0.10;
    const bounce = Math.abs(Math.sin(t / 70)) * P.h * 0.008;
    rect(cartX, cartY - cartH - bounce, cartW, cartH, "#4a3320");
    rect(cartX + cartW * 0.06, cartY - cartH - bounce + cartH * 0.12, cartW * 0.88, cartH * 0.3, "#2a1c0e");
    for (let i = 0; i < 6; i++) {
      const px = cartX + cartW * (0.12 + (i % 3) * 0.32);
      const py = cartY - cartH - bounce + cartH * 0.1 - Math.floor(i / 3) * cartH * 0.22;
      coin(px + cartW * 0.08, py, cartW * 0.10, 0);
    }
    const wheelSpin = -t / 90;
    for (const wx of [cartX + cartW * 0.22, cartX + cartW * 0.78]) {
      rect(wx - cartW * 0.09, cartY - cartH * 0.18 - bounce, cartW * 0.18, cartW * 0.18, "#1a120a");
      g.save();
      g.translate(wx, cartY - cartH * 0.09 - bounce);
      g.rotate(wheelSpin);
      rect(-cartW * 0.07, -cartW * 0.012, cartW * 0.14, cartW * 0.024, "#8a6a3a");
      rect(-cartW * 0.012, -cartW * 0.07, cartW * 0.024, cartW * 0.14, "#8a6a3a");
      g.restore();
    }
    stepCoins();
    stepFireworks();
    stepConfetti();
    if (strike) {
      g.save();
      shake(P.step * 0.6 + 1);
      g.restore();
    }
  }

  function sStadium(t) {
    bg("#1b2c52", "#0a1020");
    const r = rnd(417);
    const beamN = 4 + P.step;
    for (let i = 0; i < beamN; i++) {
      const bx = (i + 0.5) / beamN * P.w;
      const sway = Math.sin(t / 520 + i * 1.7) * P.w * 0.06;
      g.save();
      g.fillStyle = "rgba(255,255,200,0.06)";
      g.beginPath();
      g.moveTo(bx, -P.h * 0.02);
      g.lineTo(bx + sway - P.w * 0.08, P.h * 0.62);
      g.lineTo(bx + sway + P.w * 0.08, P.h * 0.62);
      g.closePath();
      g.fill();
      g.restore();
    }
    const lightOn = (t % 600) < 460;
    for (let i = 0; i < beamN; i++) {
      const bx = (i + 0.5) / beamN * P.w;
      rect(bx - P.w * 0.012, 0, P.w * 0.024, P.h * 0.03, "#3a4768");
      star(bx, P.h * 0.018, P.h * 0.018, lightOn ? "#fff7c8" : "#8a8460");
    }
    const rows = 3 + Math.min(2, P.step);
    const fy0 = P.h * 0.10;
    const rowH = P.h * 0.085;
    for (let row = 0; row < rows; row++) {
      const ry = fy0 + row * rowH;
      rect(0, ry + rowH * 0.62, P.w, rowH * 0.18, row % 2 ? "#243a63" : "#2b416e");
      const cols = 14 + row * 2 + P.step;
      for (let c = 0; c < cols; c++) {
        const fx = (c + 0.5) / cols * P.w;
        const phase = (c / cols) * Math.PI * 2 * 1.5 - t / 220 + row * 0.4;
        const wave = Math.max(0, Math.sin(phase));
        const lift = wave * rowH * 0.55;
        const armUp = wave > 0.5;
        const s = Math.max(2, P.h * 0.014 + (rows - row) * P.h * 0.0016);
        const pi = (c * 7 + row * 3) % CONF.length;
        person(fx, ry + rowH * 0.62 - lift, s, {
          skin: r() > 0.5 ? "#ffd9a8" : "#e8b07a",
          shirt: CONF[pi],
          hat: 0,
          leg: "#1d2c4a"
        }, armUp, -1);
      }
    }
    const sbx = P.w * 0.5, sby = P.h * 0.40;
    const sbw = P.w * 0.30, sbh = P.h * 0.13;
    rect(sbx - sbw / 2 - P.w * 0.01, sby - sbh / 2 - P.h * 0.01, sbw + P.w * 0.02, sbh + P.h * 0.02, "#0a0e18");
    const flash = (t % 500) < 300;
    rect(sbx - sbw / 2, sby - sbh / 2, sbw, sbh, flash ? "#102040" : "#0c1830");
    g.save();
    g.fillStyle = flash ? "#ffe34d" : "#5a4a10";
    g.font = "bold " + Math.floor(sbh * 0.62) + "px monospace";
    g.textAlign = "center";
    g.fillText("WIN", sbx, sby + sbh * 0.22);
    g.restore();
    if (flash) {
      star(sbx - sbw / 2 + P.w * 0.012, sby - sbh / 2 + P.h * 0.018, P.h * 0.012, "#ff5b5b");
      star(sbx + sbw / 2 - P.w * 0.012, sby - sbh / 2 + P.h * 0.018, P.h * 0.012, "#39e7ff");
    }
    ground("#243a1c");
    rect(0, P.h * 0.86, P.w, P.h * 0.012, "#3f6b2e");
    const cx = P.w / 2, gy = P.h * 0.97;
    const hop = Math.abs(Math.sin(t / 200)) * P.h * 0.05;
    const hs = Math.max(4, P.h * 0.045);
    if (t < 90 && t > 20) spawnConfetti(40 + P.step * 14, P.rg);
    if (t % 70 < 8 && t > 120) spawnFirework(P.w * (0.2 + r() * 0.6), P.h * (0.18 + r() * 0.2), P.rg);
    if (P.step >= 2) {
      person(cx - P.w * 0.20, gy - hop * 0.6, hs * 0.78, { skin: "#ffcf9f", shirt: "#b06bff", hat: 0, leg: "#2b3a67" }, true, 1);
      person(cx + P.w * 0.20, gy - hop * 0.6, hs * 0.78, { skin: "#e8b07a", shirt: "#ff8c3b", hat: 0, leg: "#2b3a67" }, true, 1);
    }
    if (P.step >= 4) {
      person(cx - P.w * 0.32, gy - hop * 0.4, hs * 0.66, { skin: "#ffd9a8", shirt: "#39e7ff", hat: 0, leg: "#333" }, true, 1);
      person(cx + P.w * 0.32, gy - hop * 0.4, hs * 0.66, { skin: "#e8b07a", shirt: "#ff5b5b", hat: 0, leg: "#333" }, true, 1);
    }
    person(cx, gy - hop, hs, { skin: "#ffd9a8", shirt: "#2e57c9", hat: "#ffd24a", leg: "#1d2c4a" }, true, 1);
    const trY = gy - hop - hs * 6.2;
    const trBob = Math.sin(t / 160) * P.h * 0.008;
    const tw = hs * 1.1;
    rect(cx - tw * 0.55, trY + trBob, tw * 1.1, hs * 1.1, "#ffd24a");
    rect(cx - tw * 0.85, trY + trBob, tw * 0.3, hs * 0.8, "#f0b81e");
    rect(cx + tw * 0.55, trY + trBob, tw * 0.3, hs * 0.8, "#f0b81e");
    rect(cx - tw * 0.2, trY + trBob + hs * 1.1, tw * 0.4, hs * 0.7, "#e0a814");
    rect(cx - tw * 0.45, trY + trBob + hs * 1.8, tw * 0.9, hs * 0.35, "#ffd24a");
    if ((t % 700) < 200) star(cx + tw * 0.2, trY + trBob + hs * 0.2, hs * 0.5, "#ffffff");
    stepFireworks();
    stepConfetti();
  }

  function sCasino(t) {
    bg("#2a0033", "#08040f");
    const r = rnd(7331);
    for (let i = 0; i < 26 + P.step * 8; i++) {
      const sx = r() * P.w, sy = r() * P.h * 0.7;
      const tw = 0.5 + 0.5 * Math.sin(t / 200 + i * 1.3);
      star(sx, sy, P.h * (0.006 + 0.004 * tw), CONF[i % CONF.length]);
    }
    const neon = Math.sin(t / 120) > 0 ? "#ff3df0" : "#3df0ff";
    rect(P.w * 0.04, P.h * 0.05, P.w * 0.92, P.h * 0.012, neon);
    rect(P.w * 0.04, P.h * 0.05, P.w * 0.012, P.h * 0.14, neon);
    rect(P.w * 0.928, P.h * 0.05, P.w * 0.012, P.h * 0.14, neon);
    ground("#1a0d24");
    const gy = P.h * 0.86;
    const wx = P.w * 0.32, wy = P.h * 0.5, wr = P.h * 0.18;
    const spinT = Math.min(1, t / 1400);
    const ease = 1 - Math.pow(1 - spinT, 3);
    const rot = ease * (10 + P.step * 2) + (1 - ease) * 0;
    g.save();
    g.translate(wx, wy);
    rect(-wr * 1.25, -wr * 1.25, wr * 2.5, wr * 2.5, "#0c0612");
    for (let ring = 0; ring < 8; ring++) {
      const rr = wr * (1.18 - ring * 0.02);
      star(0, 0, 0, "#000");
    }
    g.save();
    g.rotate(rot * Math.PI);
    const segs = 12;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a0) * wr, Math.sin(a0) * wr);
      g.lineTo(Math.cos(a1) * wr, Math.sin(a1) * wr);
      g.closePath();
      g.fillStyle = i % 3 === 0 ? "#1aa64b" : (i % 2 === 0 ? "#c0142a" : "#15101a");
      g.fill();
    }
    g.fillStyle = "#f5d24a";
    g.beginPath();
    g.arc(0, 0, wr * 0.32, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#7a5a12";
    g.beginPath();
    g.arc(0, 0, wr * 0.18, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.fillStyle = "#22141f";
    g.beginPath();
    g.arc(0, 0, wr * 1.06, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#0c0612";
    g.beginPath();
    g.arc(0, 0, wr, 0, Math.PI * 2);
    g.fill();
    g.save();
    g.rotate(rot * Math.PI);
    const segs2 = 12;
    for (let i = 0; i < segs2; i++) {
      const a0 = (i / segs2) * Math.PI * 2;
      const a1 = ((i + 1) / segs2) * Math.PI * 2;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a0) * wr, Math.sin(a0) * wr);
      g.lineTo(Math.cos(a1) * wr, Math.sin(a1) * wr);
      g.closePath();
      g.fillStyle = i % 2 === 0 ? "#c0142a" : "#101418";
      g.fill();
    }
    g.fillStyle = "#1aa64b";
    g.beginPath();
    g.arc(0, 0, wr * 0.34, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#f5d24a";
    g.beginPath();
    g.arc(0, 0, wr * 0.2, 0, Math.PI * 2);
    g.fill();
    g.restore();
    const ballSpin = t < 1500 ? t / 90 : (1500 / 90) + (t - 1500) / 400;
    const ballR = t < 1500 ? wr * (1.0 - 0.45 * Math.min(1, t / 1500)) : wr * 0.55;
    const ba = -ballSpin * (t < 1500 ? 1 : 1);
    const bx = Math.cos(ba) * ballR;
    const by = Math.sin(ba) * ballR;
    rect(bx - wr * 0.05, by - wr * 0.05, wr * 0.1, wr * 0.1, "#fff8e8");
    if (t > 1450 && t % 400 < 200) star(bx, by, wr * 0.12, "#fff");
    g.restore();
    const stackX = P.w * 0.62;
    const chipCols = ["#e23a3a", "#2a7de0", "#19b35a", "#f0c024", "#9b3df0"];
    const maxChips = 5 + P.step * 3;
    for (let s = 0; s < 3 + Math.floor(P.step * 0.6); s++) {
      const colX = stackX + s * P.w * 0.045;
      const grown = Math.min(maxChips, Math.floor(((t - 200 - s * 120) / 90)));
      for (let c = 0; c < grown; c++) {
        const cy = gy - c * P.h * 0.022 - P.h * 0.02;
        const wob = Math.sin(t / 160 + c * 0.5 + s) * (c * 0.4);
        rect(colX - P.w * 0.018 + wob, cy, P.w * 0.036, P.h * 0.02, chipCols[(s + c) % chipCols.length]);
        rect(colX - P.w * 0.018 + wob, cy, P.w * 0.036, P.h * 0.006, "#ffffff44");
      }
    }
    if (t > 200 && t < 280) spawnCoins(10 + P.step * 6, stackX, gy - P.h * 0.2, P.h * 0.06, P.rg);
    if (t > 1500 && t % 70 < 8 && t < 2400) spawnConfetti(6 + P.step * 4, P.rg);
    if (t > 1550 && t % 320 < 16) {
      spawnFirework(P.w * (0.2 + P.rg() * 0.6), P.h * (0.18 + P.rg() * 0.22), P.rg);
    }
    const sweep = Math.max(0, Math.min(1, (t - 1300) / 900));
    const swEase = sweep * sweep * (3 - 2 * sweep);
    const croX = P.w * 0.5 + swEase * P.w * 0.06;
    const armUp = (t % 500) < 250 || t > 1400;
    person(croX, gy, Math.max(3, P.h * 0.034), { skin: "#f0c8a0", shirt: "#101015", hat: "#101015", leg: "#1a1a22" }, armUp, P.side === "HEADS" ? 1 : 2);
    rect(croX - P.w * 0.02, gy - P.h * 0.13, P.w * 0.04, P.h * 0.025, "#ffffff");
    if (P.step >= 2) {
      const hj = Math.abs(Math.sin(t / 150)) * P.h * 0.06;
      person(P.w * 0.84, gy - hj, Math.max(2, P.h * 0.028), { skin: "#ffcf9f", shirt: "#ff5bbf", hat: 0, leg: "#2b3a67" }, true, 0);
    }
    if (P.step >= 3) {
      const hj2 = Math.abs(Math.sin(t / 130 + 1)) * P.h * 0.05;
      person(P.w * 0.12, gy - hj2, Math.max(2, P.h * 0.026), { skin: "#e8b98a", shirt: "#3df0ff", hat: 0, leg: "#333" }, true, 0);
    }
    const coinX = croX - P.w * 0.12 + swEase * P.w * 0.04;
    coin(coinX, gy - P.h * 0.04, P.h * 0.035, Math.abs(Math.sin(t / 110)));
    stepCoins();
    stepConfetti();
    stepFireworks();
    if (P.step >= 4) {
      g.save();
      if (t > 1480 && t < 1620) shake(P.step);
      star(wx, wy, wr * 0.5 * Math.max(0, 1 - (t - 1480) / 200), "#fff8c0");
      g.restore();
    }
  }

  function sHeist(t) {
    bg("#1a0f2e", "#06070f");
    const r = rnd(404);
    const sky = P.h * 0.62;
    for (let i = 0; i < 14 + P.step * 5; i++) {
      const bx = r() * P.w;
      const bw = P.w * (0.05 + r() * 0.05);
      const bh = P.h * (0.18 + r() * 0.34);
      rect(bx, sky - bh, bw, bh, i % 2 ? "#150d24" : "#1d1233");
      const lit = "#ffd54a";
      for (let wy = sky - bh + P.h * 0.03; wy < sky - P.h * 0.02; wy += P.h * 0.05) {
        for (let wx = bx + bw * 0.18; wx < bx + bw * 0.82; wx += bw * 0.3) {
          if (r() > 0.45) rect(wx, wy, Math.max(2, bw * 0.12), Math.max(2, P.h * 0.02), lit);
        }
      }
    }
    for (let i = 0; i < 16 + P.step * 8; i++) {
      const ly = sky - P.h * 0.04 + r() * P.h * 0.36;
      const speed = 0.7 + r() * 1.3;
      const lx = ((P.w * 1.3 - ((t * speed * 0.9 + r() * P.w) % (P.w * 1.3)))) ;
      const lw = P.w * (0.08 + r() * 0.16);
      rect(lx, ly, lw, Math.max(2, P.h * 0.012), CONF[(i + Math.floor(t / 90)) % CONF.length]);
    }
    ground("#15171f");
    const roadY = P.h * 0.78;
    rect(0, roadY, P.w, P.h - roadY, "#101218");
    for (let i = -1; i < 9; i++) {
      const dash = ((i * P.w * 0.16 - (t * 0.6) % (P.w * 0.16)));
      rect(dash, roadY + (P.h - roadY) * 0.5, P.w * 0.08, Math.max(2, P.h * 0.015), "#5a5a3a");
    }
    for (let i = 0; i < 5 + P.step * 4; i++) {
      const sx = P.w - ((t * (1.4 + i * 0.3) + i * 130) % (P.w * 1.2));
      star(sx, roadY + P.h * 0.02 + (i % 3) * P.h * 0.04, Math.max(2, P.h * 0.012), "#9aa0b0");
    }
    const baseY = roadY + (P.h - roadY) * 0.42;
    const bob = Math.sin(t / 70) * P.h * 0.012;
    const cx = P.w * 0.5;
    const cw = P.w * 0.34, ch = P.h * 0.13;
    const cy = baseY - ch + bob;
    g.save();
    shake(P.step >= 3 ? 1.6 : 0.9);
    rect(cx - cw * 0.18, cy - ch * 0.75, cw * 0.5, ch * 0.8, "#161922");
    rect(cx - cw / 2, cy, cw, ch, "#c41f2e");
    rect(cx - cw / 2, cy + ch * 0.55, cw, ch * 0.45, "#8c121d");
    rect(cx - cw * 0.14, cy - ch * 0.62, cw * 0.42, ch * 0.6, "#2a3550");
    rect(cx - cw * 0.1, cy - ch * 0.55, cw * 0.15, ch * 0.42, "#7fd4ff");
    rect(cx + cw * 0.1, cy - ch * 0.55, cw * 0.15, ch * 0.42, "#7fd4ff");
    const ms = Math.max(2, ch * 0.18);
    rect(cx - cw * 0.05, cy - ch * 0.5, ms, ms, "#1a1a1a");
    rect(cx - cw * 0.05, cy - ch * 0.62, ms, ms * 0.6, "#222");
    rect(cx + cw * 0.16, cy - ch * 0.5, ms, ms, "#1a1a1a");
    rect(cx + cw * 0.16, cy - ch * 0.62, ms, ms * 0.6, "#222");
    rect(cx + cw * 0.46, cy + ch * 0.15, cw * 0.06, ch * 0.4, "#ffd54a");
    rect(cx - cw * 0.52, cy + ch * 0.15, cw * 0.04, ch * 0.35, "#ff4444");
    const wr = ch * 0.32;
    const wph = (t / 22) % (Math.PI * 2);
    for (const wxo of [-cw * 0.3, cw * 0.3]) {
      g.save();
      g.translate(cx + wxo, cy + ch);
      rect(-wr, -wr, wr * 2, wr * 2, "#111");
      g.rotate(wph);
      rect(-wr * 0.18, -wr * 0.8, wr * 0.36, wr * 1.6, "#444");
      rect(-wr * 0.8, -wr * 0.18, wr * 1.6, wr * 0.36, "#444");
      g.restore();
      rect(cx + wxo - wr * 0.2, cy + ch - wr * 0.2, wr * 0.4, wr * 0.4, "#888");
    }
    const bagBob = Math.abs(Math.sin(t / 90)) * P.h * 0.03;
    for (let i = 0; i < 2 + P.step; i++) {
      const bgx = cx - cw * 0.08 + i * cw * 0.16;
      const bgy = cy - ch * 0.78 - bagBob * (1 - i * 0.15);
      const bs = cw * 0.11;
      rect(bgx - bs / 2, bgy, bs, bs * 0.9, "#d8c48a");
      rect(bgx - bs * 0.3, bgy - bs * 0.18, bs * 0.6, bs * 0.25, "#b59c5e");
      g.fillStyle = "#3a2e10";
      g.font = "bold " + Math.max(7, bs * 0.6) + "px monospace";
      g.textAlign = "center";
      g.fillText("$", bgx, bgy + bs * 0.65);
    }
    person(cx - cw * 0.06, cy - ch * 0.18, Math.max(3, P.h * 0.026), { skin: "#1a1a1a", shirt: "#2b2b33", hat: "#111", leg: "#1a1a22" }, false);
    rect(cx - cw * 0.085, cy - ch * 0.5, Math.max(3, P.h * 0.02), Math.max(2, P.h * 0.01), "#fff");
    g.restore();
    if (t < 80 && t > 20) spawnConfetti(20 + P.step * 8, P.rg);
    if (t % 70 < 8) spawnFirework(cx + cw * 0.55, cy - ch * 0.1, P.rg);
    if (t % 50 < 8 && P.step >= 2) spawnCoins(4 + P.step * 2, cx + cw * 0.5, cy - ch * 0.1, P.h * 0.05, P.rg);
    stepCoins();
    stepConfetti();
    stepFireworks();
    if (P.step >= 4) {
      const lookY = baseY;
      const wave = Math.abs(Math.sin(t / 130)) > 0.5;
      person(P.w * 0.12, lookY, Math.max(3, P.h * 0.03), { skin: "#1a1a1a", shirt: "#5a2bff", hat: "#111", leg: "#222" }, wave);
      rect(P.w * 0.105, lookY - Math.max(3, P.h * 0.03) * 3.2, Math.max(3, P.h * 0.022), Math.max(2, P.h * 0.011), "#fff");
    }
    if (P.step >= 3) {
      for (let i = 0; i < 3; i++) {
        const fy = cy - ch * 0.4 + Math.sin(t / 120 + i) * P.h * 0.05 - (t / 1000) * P.h * 0.04 * i;
        const fx = cx + cw * 0.5 + ((t * 0.15 + i * 40) % (P.w * 0.3));
        g.save();
        g.translate(fx, fy);
        g.rotate(Math.sin(t / 160 + i) * 0.6);
        rect(-P.w * 0.018, -P.h * 0.01, P.w * 0.036, P.h * 0.02, "#6fcf6f");
        rect(-P.w * 0.006, -P.h * 0.004, P.w * 0.012, P.h * 0.008, "#2d5a2d");
        g.restore();
      }
    }
  }

  function sKaiju(t) {
    bg("#2a0d3a", "#0a0512");
    const r = rnd(7777);
    const skyN = 26 + P.step * 6;
    for (let i = 0; i < skyN; i++) {
      const sx = r() * P.w;
      const sy = r() * P.h * 0.55;
      star(sx, sy, 1 + Math.floor(r() * 2), (Math.sin(t / 200 + i) > 0.4 ? "#fff7c8" : "#c89bff"));
    }
    const moonX = P.w * 0.82, moonY = P.h * 0.16, moonR = P.h * 0.09;
    g.save();
    g.fillStyle = "#ffe6a0";
    g.beginPath();
    g.arc(moonX, moonY, moonR, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#e8c878";
    g.beginPath();
    g.arc(moonX - moonR * 0.3, moonY - moonR * 0.2, moonR * 0.18, 0, Math.PI * 2);
    g.arc(moonX + moonR * 0.25, moonY + moonR * 0.15, moonR * 0.12, 0, Math.PI * 2);
    g.fill();
    g.restore();
  
    const stomp = t % 700 < 90 || (t % 700 > 350 && t % 700 < 440);
    const bShake = stomp ? P.h * 0.012 : 0;
    const gy = P.h * 0.82;
    ground("#160a22");
  
    const neon = ["#ff3d8b", "#3df0ff", "#b06bff", "#ffd23d", "#3dff9e", "#ff6b3d"];
    const cityN = 11 + P.step * 2;
    for (let i = 0; i < cityN; i++) {
      const bw = P.w * (0.05 + r() * 0.045);
      const bx = (i / cityN) * P.w + r() * P.w * 0.02;
      const bh = P.h * (0.18 + r() * 0.34);
      const wob = Math.sin(t / 70 + i * 1.3) * bShake;
      const by = gy - bh;
      g.save();
      g.translate(wob, 0);
      rect(bx, by, bw, bh, i % 3 === 0 ? "#241038" : "#1a0c2e");
      rect(bx, by, bw, P.h * 0.01, neon[i % neon.length]);
      const cols = Math.max(2, Math.floor(bw / (P.w * 0.018)));
      const rows = Math.max(3, Math.floor(bh / (P.h * 0.05)));
      for (let cxw = 0; cxw < cols; cxw++) {
        for (let ry = 0; ry < rows; ry++) {
          const lit = ((cxw * 7 + ry * 13 + i * 3) % 5) !== 0;
          const flick = Math.sin(t / 90 + cxw * 2 + ry * 3 + i) > -0.3;
          if (lit && flick) {
            const wx = bx + P.w * 0.008 + cxw * (bw / cols);
            const wy = by + P.h * 0.02 + ry * (bh / rows);
            rect(wx, wy, bw / cols * 0.55, bh / rows * 0.45, "#ffe27a");
          }
        }
      }
      g.restore();
    }
  
    const walk = Math.sin(t / 320);
    const kx = P.w * (0.18 + (t / 2600) * 0.5);
    const ks = Math.max(5, P.h * 0.05);
    const bob = Math.abs(Math.sin(t / 230)) * P.h * 0.02;
    const ky = gy - bob;
    const bodyH = ks * 9;
    const bodyW = ks * 5;
    const bx0 = kx - bodyW / 2;
    const by0 = ky - bodyH;
  
    g.save();
    g.translate(Math.sin(t / 50) * bShake * 1.5, 0);
  
    const legSwing = walk * ks * 0.9;
    rect(kx - bodyW * 0.45, ky - ks * 3.2, ks * 1.5, ks * 3.2 + legSwing * 0.4, "#1f7a4d");
    rect(kx + bodyW * 0.05, ky - ks * 3.2, ks * 1.5, ks * 3.2 - legSwing * 0.4, "#1f7a4d");
    rect(kx - bodyW * 0.5, ky - ks * 0.5 + legSwing * 0.4, ks * 1.8, ks * 0.6, "#165c3a");
    rect(kx + bodyW * 0.05, ky - ks * 0.5 - legSwing * 0.4, ks * 1.8, ks * 0.6, "#165c3a");
  
    rect(bx0, by0 + ks * 2, bodyW, bodyH - ks * 2, "#27955f");
    rect(bx0 + ks * 0.6, by0 + ks * 3, bodyW - ks * 1.2, bodyH - ks * 4, "#3bbd7a");
    for (let s = 0; s < 5; s++) {
      rect(kx - ks * 0.4, by0 + ks * 2.2 + s * ks * 1.1, ks * 0.8, ks * 0.6, "#bff7d8");
    }
  
    const armSwing = walk * ks * 1.2;
    rect(bx0 - ks * 1.0, by0 + ks * 2.5 + armSwing, ks * 1.2, ks * 3.5, "#1f7a4d");
    rect(bx0 + bodyW - ks * 0.2, by0 + ks * 2.5 - armSwing, ks * 1.2, ks * 3.5, "#1f7a4d");
  
    rect(bx0 + ks * 0.5, by0 - ks * 1.6, bodyW - ks * 1.0, ks * 2.6, "#27955f");
    for (let sp = 0; sp < 4; sp++) {
      const spx = bx0 + ks * 0.8 + sp * (bodyW - ks * 1.6) / 3;
      rect(spx, by0 - ks * 2.4, ks * 0.5, ks * 1.0, "#7df0c8");
    }
    const eyeGlow = Math.sin(t / 120) > 0 ? "#ff3b3b" : "#ffd23b";
    rect(bx0 + ks * 1.0, by0 - ks * 0.9, ks * 0.9, ks * 0.7, eyeGlow);
    rect(bx0 + bodyW - ks * 1.9, by0 - ks * 0.9, ks * 0.9, ks * 0.7, eyeGlow);
    rect(bx0 + ks * 1.0, by0 + ks * 0.1, bodyW - ks * 2.0, ks * 0.45, "#0a3322");
    for (let tooth = 0; tooth < 4; tooth++) {
      rect(bx0 + ks * 1.0 + tooth * (bodyW - ks * 2.0) / 4, by0 + ks * 0.1, ks * 0.3, ks * 0.35, "#ffffff");
    }
    g.restore();
  
    if (stomp && t % 700 < 30) {
      if (t % 700 < 8) spawnFirework(kx, gy - ks * 0.5, P.rg);
    }
  
    if (t < 90 && t > 20) spawnCoins(10 + P.step * 8, P.w * 0.5, P.h * 0.1, P.h * 0.05, P.rg);
    if (t % 90 < 8) spawnCoins(6 + P.step * 3, r() * P.w, -P.h * 0.05, P.h * 0.04, P.rg);
    stepCoins();
  
    const heliN = 2 + P.step;
    for (let h = 0; h < heliN; h++) {
      const ang = t / 600 + h * (Math.PI * 2 / heliN);
      const hcx = kx + Math.cos(ang) * P.w * (0.16 + h * 0.03);
      const hcy = (by0 - ks * 1.0) + Math.sin(ang) * P.h * 0.07;
      const hs = Math.max(2, P.h * 0.012);
      rect(hcx - hs * 1.5, hcy, hs * 3, hs * 1.4, "#3a4a5a");
      rect(hcx - hs * 0.4, hcy + hs * 0.3, hs * 1.0, hs * 0.7, "#8be0ff");
      rect(hcx + hs * 1.2, hcy + hs * 0.3, hs * 2.0, hs * 0.4, "#2a3a4a");
      rect(hcx + hs * 3.0, hcy - hs * 0.2, hs * 0.4, hs * 1.2, "#2a3a4a");
      const blade = Math.sin(t / 30 + h) * hs * 2.5;
      rect(hcx - blade, hcy - hs * 0.6, blade * 2, hs * 0.3, "#cfe8ff");
      if (P.step >= 3 && (t / 60 + h) % 4 < 0.6) rect(hcx, hcy + hs, hs * 0.3, hs * 1.2, "#ffd23b");
    }
  
    spawnConfetti && (t < 60 ? spawnConfetti(20 + P.step * 6, P.rg) : null);
    stepConfetti();
  
    if (P.step >= 4) {
      const sm = Math.sin(t / 400);
      for (let p = 0; p < 3; p++) {
        const px = P.w * (0.15 + p * 0.32) + sm * P.w * 0.02;
        const ph = P.h * (0.05 + (Math.sin(t / 300 + p) * 0.5 + 0.5) * 0.06);
        rect(px, gy - ph, P.w * 0.04, ph, "#ff5a2a");
        rect(px + P.w * 0.005, gy - ph - P.h * 0.02, P.w * 0.025, P.h * 0.03, "#ffd23b");
      }
    }
  
    shake(stomp ? P.h * 0.01 * (1 + P.step * 0.3) : 0);
  }

  function sEmperor(t) {
    bg("#1a0b3a", "#04030d");
    const r = rnd(7331);
    const starN = 60 + P.step * 18;
    for (let i = 0; i < starN; i++) {
      const sx = r() * P.w, sy = r() * P.h * 0.88;
      const tw = 0.5 + 0.5 * Math.sin(t / 220 + i * 1.7);
      const sz = (0.6 + r() * 1.2) * (P.h * 0.006);
      star(sx, sy, sz * (0.7 + tw * 0.6), tw > 0.7 ? "#ffffff" : "#9fd0ff");
    }
    const pr = rnd(515);
    const planetN = 2 + Math.min(3, P.step);
    const pcol = ["#ff7b54", "#54b9ff", "#b06bff", "#5cf0a0", "#ffd24a"];
    for (let i = 0; i < planetN; i++) {
      const drift = Math.sin(t / 900 + i * 2.1) * P.w * 0.02;
      const px = (0.12 + pr() * 0.76) * P.w + drift;
      const py = (0.08 + pr() * 0.32) * P.h;
      const prad = (0.04 + pr() * 0.06) * P.h;
      g.save();
      g.beginPath();
      g.fillStyle = pcol[i % pcol.length];
      g.arc(px, py, prad, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.fillStyle = "rgba(0,0,0,0.28)";
      g.arc(px + prad * 0.35, py + prad * 0.2, prad * 0.85, 0, Math.PI * 2);
      g.fill();
      if (i % 2 === 0) {
        g.save();
        g.translate(px, py);
        g.rotate(-0.5);
        g.fillStyle = "rgba(255,255,255,0.35)";
        g.fillRect(-prad * 1.9, -prad * 0.12, prad * 3.8, prad * 0.24);
        g.restore();
      }
      g.restore();
    }
    ground("#160a26");
    const cx = P.w / 2, gy = P.h * 0.86;
    const rise = t < 600 ? (1 - t / 600) * P.h * 0.5 : 0;
    const breathe = Math.sin(t / 260) * P.h * 0.012;
    const halo = 0.5 + 0.5 * Math.sin(t / 200);
    const thrW = P.w * 0.22, thrH = P.h * 0.42;
    g.save();
    if (t > 560 && t < 760) { shake(Math.min(6, P.step * 2)); }
    const tx = cx - thrW / 2, ty = gy - thrH + rise;
    rect(tx, ty, thrW, thrH, "#3a2f5e");
    rect(tx, ty, thrW * 0.16, thrH, "#52407e");
    rect(tx + thrW * 0.84, ty, thrW * 0.16, thrH, "#2c2348");
    rect(tx - thrW * 0.1, ty - thrH * 0.18, thrW * 0.14, thrH * 0.5, "#52407e");
    rect(tx + thrW * 0.96, ty - thrH * 0.18, thrW * 0.14, thrH * 0.5, "#2c2348");
    for (let s = 0; s < 5; s++) {
      const spkH = thrH * (0.12 + 0.05 * s);
      rect(tx + thrW * (0.1 + s * 0.2), ty - spkH, thrW * 0.06, spkH, "#6a52a8");
    }
    rect(tx + thrW * 0.2, ty + thrH * 0.12, thrW * 0.6, thrH * 0.5, "#7a2f4a");
    rect(tx + thrW * 0.2, ty + thrH * 0.12, thrW * 0.6, thrH * 0.08, "#a8425f");
    for (let j = 0; j < 4; j++) {
      star(tx + thrW * (0.32 + j * 0.14), ty + thrH * 0.34, P.h * 0.01, "#ffe066");
    }
    const ps = Math.max(3, P.h * 0.03);
    const ey = gy - thrH * 0.02 + rise + breathe;
    g.save();
    g.fillStyle = "rgba(120,90,220," + (0.18 + halo * 0.22) + ")";
    g.beginPath();
    g.arc(cx, ey - ps * 5.2, ps * (3.2 + halo * 0.6), 0, Math.PI * 2);
    g.fill();
    g.restore();
    const armUp = (t % 1200) < 600;
    person(cx, ey, ps, { skin: "#ffd9a8", shirt: "#7b3fe4", hat: 0, leg: "#3a2a66" }, armUp, 1);
    rect(cx - ps * 2.4, ey - ps * 5.6, ps * 4.8, ps * 1.4, "#6a52a8");
    rect(cx - ps * 2.4, ey - ps * 5.6, ps * 4.8, ps * 0.5, "#8a6fd0");
    const crownY = ey - ps * 8.0;
    rect(cx - ps * 2.0, crownY + ps * 0.9, ps * 4.0, ps * 0.9, "#ffd24a");
    for (let c = 0; c < 4; c++) {
      const peak = ps * (0.7 + (c === 1 || c === 2 ? 0.5 : 0));
      rect(cx - ps * 2.0 + c * ps * 1.07, crownY + ps * 0.9 - peak, ps * 0.7, peak, "#ffe066");
      star(cx - ps * 1.65 + c * ps * 1.07, crownY + ps * 0.9 - peak, ps * 0.4, "#fff6c0");
    }
    star(cx, crownY + ps * 0.2, ps * 0.6 + halo * ps * 0.3, "#ffffff");
    const scepX = cx + (armUp ? ps * 2.6 : ps * 2.2);
    const scepTop = ey - ps * (armUp ? 9 : 5.5);
    rect(scepX, scepTop, ps * 0.5, ey - ps * 1.2 - scepTop, "#caa64a");
    star(scepX + ps * 0.25, scepTop, ps * 0.8 + halo * ps * 0.4, "#9fffe0");
    g.restore();
    if (P.step >= 3 && t > 700) {
      const subPs = Math.max(2, P.h * 0.022);
      const sb = Math.sin(t / 300) * P.h * 0.01;
      person(cx - thrW * 0.95, gy + sb, subPs, { skin: "#ffcf9f", shirt: "#39e7ff", hat: 0, leg: "#222" }, true, 1);
      person(cx + thrW * 0.95, gy - sb, subPs, { skin: "#e8b98a", shirt: "#5cf0a0", hat: 0, leg: "#222" }, true, 1);
      if (P.step >= 4) {
        person(cx - thrW * 1.35, gy - sb * 0.6, subPs * 0.9, { skin: "#ffd9a8", shirt: "#ff5b5b", hat: 0, leg: "#222" }, true, 0);
        person(cx + thrW * 1.35, gy + sb * 0.6, subPs * 0.9, { skin: "#d9a878", shirt: "#ffd24a", hat: 0, leg: "#222" }, true, 0);
      }
    }
    if (t < 60 && t > 20) spawnCoins(10 + P.step * 6, cx, gy - thrH * 0.5, P.h * 0.06, P.rg);
    stepCoins();
    if (t > 620 && t % 70 < 8) {
      const fx = (0.18 + P.rg() * 0.64) * P.w;
      const fy = (0.12 + P.rg() * 0.4) * P.h;
      spawnFirework(fx, fy, P.rg);
    }
    if (t < 50) spawnConfetti(30 + P.step * 14, P.rg);
    if (t > 800 && t % 90 < 8) spawnConfetti(8 + P.step * 4, P.rg);
    const laserN = 3 + P.step;
    for (let L = 0; L < laserN; L++) {
      const ang = (t / 600) + L * (Math.PI * 2 / laserN);
      const beat = Math.max(0, Math.sin(t / 160 + L));
      const len = P.h * (0.3 + beat * 0.5);
      const lx = cx + Math.cos(ang) * P.w * 0.06;
      const ly = gy - thrH * 0.5 + Math.sin(ang) * P.h * 0.04;
      g.save();
      g.translate(lx, ly);
      g.rotate(ang);
      g.fillStyle = "rgba(120,255,220," + (0.12 + beat * 0.3) + ")";
      g.fillRect(0, -P.h * 0.006, len, P.h * 0.012);
      g.fillStyle = "rgba(255,255,255," + (0.1 + beat * 0.25) + ")";
      g.fillRect(0, -P.h * 0.002, len, P.h * 0.004);
      g.restore();
    }
    stepFireworks();
    stepConfetti();
  }

  // simple firework bursts (reused by dragon scene)
  let fw = [];
  function spawnFirework(x, y, rg) { const c = CONF[(rg() * CONF.length) | 0]; for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; fw.push({ x, y, vx: Math.cos(a) * (1.5 + rg() * 1.5), vy: Math.sin(a) * (1.5 + rg() * 1.5), life: 1, c }); } }
  function stepFireworks() { for (const p of fw) { p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.life -= 0.03; if (p.life > 0) rect(p.x, p.y, 2.5, 2.5, p.c); } fw = fw.filter((p) => p.life > 0); }

  // Pick a scene + intensity from the win amount. Each grandeur band has a pool
  // of scenes, so same-size wins can roll different movies (escalation + variety).
  function selectScene(amt) {
    var BANDS = [
      { max: 100, base: 20,  shake: 0,   epic: false, pool: [sArcade] },
      { max: 180, base: 100, shake: 1,   epic: false, pool: [sLuckyCat, sCarnival] },
      { max: 260, base: 180, shake: 1,   epic: false, pool: [sPirate, sGoldRush] },
      { max: 340, base: 260, shake: 1.2, epic: false, pool: [sStadium, sCasino] },
      { max: 440, base: 340, shake: 1.6, epic: false, pool: [sHeist] },
      { max: 1e9, base: 440, shake: 2.6, epic: true,  pool: [sKaiju, sEmperor] }
    ];
    var b = BANDS.find(function (x) { return amt < x.max; }) || BANDS[BANDS.length - 1];
    var step = Math.max(0, Math.min(4, Math.floor((amt - b.base) / 20)));
    var fn = b.pool[Math.floor(Math.random() * b.pool.length)];
    return { fn: fn, step: step, shake: b.shake, epic: b.epic };
  }

  function frame(now) {
    if (!playing) return;
    const t = now - startT;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, P.w, P.h);
    g.save();
    if (P.shake) shake(t < 300 ? 3 : 1);
    try { scene.fn(t); } catch (e) { /* a buggy scene must never break the page */ }
    g.restore();
    winText(t);
    // fade out the last 400ms
    if (t > dur - 400) { g.fillStyle = "rgba(12,13,22," + Math.min(1, (t - (dur - 400)) / 400) + ")"; g.fillRect(0, 0, P.w, P.h); }
    if (t >= dur) { stop(); return; }
    raf = requestAnimationFrame(frame);
  }

  function play(opts) {
    if (!cv || !g) init();
    if (!cv || !g) return;
    const amt = Math.max(0, opts.amountUsd || 0);
    size();
    coins = []; confetti = []; fw = [];
    scene = selectScene(amt);
    const seed = Math.floor(amt) + (scene.step + 1) * 7 + 1;
    P = {
      w: cv.width, h: cv.height, amtUsd: amt, step: scene.step, shake: reduce ? 0 : scene.shake,
      rg: rnd(seed), side: opts.side || "HEADS",
      headline: scene.epic && scene.step >= 3 ? "LEGENDARY!" : "WINNER!",
      amtStr: "+$" + (amt >= 1000 ? (amt / 1000).toFixed(1) + "k" : Math.round(amt)),
    };
    cv.classList.add("on");
    dur = reduce ? 900 : 2600 + scene.step * 150 + (scene.epic ? 900 : 0);
    startT = performance.now();
    playing = true;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    if (cv) cv.classList.remove("on");
  }

  window.WinScenes = { init, play, stop, _select: selectScene };
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
