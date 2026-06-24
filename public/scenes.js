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

  function sCoinPop(t) {
    bg("#241a3a", "#0c0d16");
    ground("#2a1d12");
    const jump = Math.abs(Math.sin(t / 180)) * P.h * 0.12;
    const cx = P.w / 2, gy = P.h * 0.82;
    if (t < 80 && t > 20) spawnCoins(8 + P.step * 7, cx, gy - P.h * 0.25, P.h * 0.06, P.rg);
    person(cx, gy - jump, Math.max(3, P.h * 0.03), { skin: "#ffd9a8", shirt: "#39e7ff", hat: "#ff5b5b", leg: "#2b3a67" }, true);
    stepCoins();
    if (P.step >= 2) { person(cx - P.w * 0.28, gy - jump * 0.6, Math.max(2, P.h * 0.024), { skin: "#ffcf9f", shirt: "#b06bff", hat: 0, leg: "#333" }, true); }
    if (P.step >= 3) { person(cx + P.w * 0.28, gy - jump * 0.8, Math.max(2, P.h * 0.024), { skin: "#ffcf9f", shirt: "#34e39b", hat: 0, leg: "#333" }, true); }
    stepConfetti();
  }

  function sSlot(t) {
    bg("#102a3a", "#0c0d16");
    const cx = P.w / 2, cy = P.h * 0.58, bw = P.w * 0.5, bh = P.h * 0.34;
    // cabinet
    rect(cx - bw / 2 - 6, cy - bh / 2 - 6, bw + 12, bh + 12, "#6b4bd6");
    rect(cx - bw / 2, cy - bh / 2, bw, bh, "#1a1230");
    // blinking bulbs
    for (let i = 0; i < 10; i++) { const on = (((t / 120) | 0) + i) % 2; star(cx - bw / 2 + (i / 9) * bw, cy - bh / 2 - 10, 2, on ? "#ffe9a8" : "#7a5200"); }
    // three reels: spin then lock
    const lock = Math.min(3, Math.floor(t / 500));
    for (let i = 0; i < 3; i++) {
      const rx = cx - bw / 3 + i * (bw / 3), ry = cy;
      rect(rx - bw / 9, ry - bh / 3, bw / 4.5, bh / 1.5, "#0c0d16");
      const locked = i < lock;
      const yo = locked ? 0 : (t * 0.6 + i * 30) % (bh / 1.5);
      coin(rx, ry - bh / 3 + yo + 8, 6, locked ? 0 : (t / 60) % 1);
    }
    // bell rings on full lock
    if (lock >= 3) { g.save(); shake(3); rect(cx - 8, cy - bh / 2 - 24, 16, 12, "#ffcf3f"); rect(cx - 2, cy - bh / 2 - 12, 4, 5, "#7a5200"); g.restore(); spawnCoins(2 + P.step, cx, cy - bh / 2, P.h * 0.05, P.rg); }
    person(cx + bw / 2 + P.w * 0.06, P.h * 0.82, Math.max(3, P.h * 0.028), { skin: "#ffd9a8", shirt: "#ff7ad5", hat: 0, leg: "#2b3a67" }, lock >= 3);
    stepCoins(); stepConfetti();
  }

  function sTreasure(t) {
    bg("#1a1030", "#0c0d16");
    ground("#241608");
    const cx = P.w / 2, cy = P.h * 0.74, cw = P.w * 0.34, ch = P.h * 0.2;
    const open = Math.min(1, Math.max(0, (t - 250) / 350));
    // chest base
    rect(cx - cw / 2, cy - ch, cw, ch, "#7a4a16"); rect(cx - cw / 2 + 4, cy - ch + 4, cw - 8, ch - 8, "#a9760a");
    // lid (lifts/rotates)
    g.save(); g.translate(cx, cy - ch); g.rotate(-open * 0.9); rect(-cw / 2, -ch * 0.55, cw, ch * 0.55, "#7a4a16"); rect(-cw / 2 + 4, -ch * 0.55 + 3, cw - 8, ch * 0.4, "#caa24a"); g.restore();
    // gold glow + fountain
    if (open > 0.4) { rect(cx - cw / 2 + 4, cy - ch * 1.1, cw - 8, ch * 0.4, "rgba(255,210,60,0.5)"); if (t % 60 < 20) spawnCoins(3 + P.step, cx, cy - ch, P.h * 0.06, P.rg); }
    // dog mascot runs in
    const dx = cx + P.w * 0.42 - Math.min(P.w * 0.42, t * 0.18);
    const wag = Math.sin(t / 80) * 2;
    rect(dx, cy - 8, 14, 8, "#caa24a"); rect(dx + 12, cy - 12, 7, 7, "#caa24a"); rect(dx - 4, cy - 11 + wag, 5, 4, "#8a5a1a"); rect(dx + 16, cy - 13, 1.5, 1.5, "#000");
    stepCoins(); stepConfetti();
  }

  function sParade(t) {
    bg("#2a103a", "#0c0d16");
    ground("#1c1030");
    // confetti cannons from both sides
    if (t < 120) { spawnConfetti(20 + P.step * 6, P.rg); }
    if (t % 40 < 8) spawnConfetti(6, P.rg);
    // marchers along the bottom
    const n = 4 + P.step;
    for (let i = 0; i < n; i++) {
      const bx = ((t * 0.05 + i * (P.w / n)) % (P.w + 40)) - 20;
      const bob = Math.abs(Math.sin(t / 150 + i)) * 6;
      person(bx, P.h * 0.86 - bob, Math.max(2, P.h * 0.02), { skin: "#ffcf9f", shirt: CONF[i % CONF.length], hat: "#ffd14a", leg: "#222" }, false);
      rect(bx - 1, P.h * 0.86 - bob - P.h * 0.13, 2, P.h * 0.07, "#ddd"); // flagpole
      rect(bx + 1, P.h * 0.86 - bob - P.h * 0.13, 10, 6, CONF[(i + 2) % CONF.length]); // flag
    }
    // hero carried up center
    person(P.w / 2, P.h * 0.6 + Math.sin(t / 200) * 4, Math.max(3, P.h * 0.03), { skin: "#ffd9a8", shirt: "#39e7ff", hat: "#ff5b5b", leg: "#2b3a67" }, true);
    stepConfetti();
  }

  function sRocket(t) {
    bg("#070b1f", "#0c0d16");
    // stars
    const sr = P.rg;
    for (let i = 0; i < 40; i++) { const x = sr() * P.w, y = sr() * P.h, tw = ((t / 200 + i) % 2) | 0; star(x, y, 1, tw ? "#fff" : "#88a"); }
    // moon
    rect(P.w * 0.78, P.h * 0.16, P.h * 0.16, P.h * 0.16, "#e8e6c8"); rect(P.w * 0.82, P.h * 0.18, 4, 4, "#cfc9a0"); rect(P.w * 0.86, P.h * 0.24, 5, 5, "#cfc9a0");
    // rocket rising
    const ry = P.h * 1.1 - Math.min(P.h * 0.75, t * 0.35);
    const rx = P.w / 2 + Math.sin(t / 120) * 6;
    // cash/flame trail
    for (let i = 0; i < 6 + P.step * 2; i++) { const fy = ry + 28 + i * 8 + (t % 8); rect(rx - 6 + (i % 2) * 12, fy, 7, 5, i % 2 ? "#34e39b" : "#ffcf3f"); }
    rect(rx - 8, ry, 16, 28, "#cdd6ea"); rect(rx - 8, ry, 16, 8, "#ff5b5b"); // body + nose band
    rect(rx - 3, ry + 12, 6, 6, "#39e7ff"); // window
    rect(rx - 12, ry + 18, 5, 10, "#ff5b5b"); rect(rx + 7, ry + 18, 5, 10, "#ff5b5b"); // fins
    // flames
    rect(rx - 5, ry + 28, 10, 6 + (t % 6), "#ffd14a"); rect(rx - 3, ry + 28, 6, 10 + (t % 6), "#ff7a2f");
    stepConfetti();
    if (t < 60) spawnConfetti(18, P.rg);
  }

  function sDragon(t) {
    bg("#3a0c1a", "#0c0d16");
    ground("#3a2a08");
    // gold hoard
    for (let i = 0; i < 60; i++) { const gx = (i * 53 % P.w), gy = P.h * 0.8 + (i * 31 % (P.h * 0.18)); coin(gx, gy, 3, 0.2); }
    // dragon body
    const cx = P.w * 0.42, cy = P.h * 0.6;
    rect(cx - 30, cy - 10, 60, 34, "#2a8a4a"); rect(cx - 30, cy - 10, 60, 6, "#39c06a"); // body
    rect(cx + 22, cy - 28, 22, 22, "#2a8a4a"); // head
    rect(cx + 40, cy - 22, 4, 4, "#ffd14a"); // eye
    // wing flap
    const flap = Math.sin(t / 160) * 14;
    g.save(); g.translate(cx - 10, cy - 8); g.rotate(-0.3 - flap * 0.02); rect(0, -30, 34, 30, "#1f6a38"); g.restore();
    // fire breath puffs
    if (t % 90 < 40) { for (let i = 0; i < 5; i++) rect(cx + 44 + i * 10, cy - 22 + (P.rg() - 0.5) * 10, 8, 6, i % 2 ? "#ff7a2f" : "#ffd14a"); }
    // fireworks
    if (t % 70 < 6) spawnFirework(P.rg() * P.w, P.rg() * P.h * 0.4, P.rg);
    stepFireworks();
    stepCoins(); stepConfetti();
    if (t < 60) spawnConfetti(26, P.rg);
  }

  // simple firework bursts (reused by dragon scene)
  let fw = [];
  function spawnFirework(x, y, rg) { const c = CONF[(rg() * CONF.length) | 0]; for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; fw.push({ x, y, vx: Math.cos(a) * (1.5 + rg() * 1.5), vy: Math.sin(a) * (1.5 + rg() * 1.5), life: 1, c }); } }
  function stepFireworks() { for (const p of fw) { p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.life -= 0.03; if (p.life > 0) rect(p.x, p.y, 2.5, 2.5, p.c); } fw = fw.filter((p) => p.life > 0); }

  // pick a scene + intensity from the win amount
  function selectScene(amt) {
    const bands = [
      { max: 100, fn: sCoinPop, base: 20, name: "Coin Pop", shake: 0 },
      { max: 180, fn: sSlot, base: 100, name: "Slot Jackpot", shake: 1 },
      { max: 260, fn: sTreasure, base: 180, name: "Treasure Vault", shake: 1 },
      { max: 340, fn: sParade, base: 260, name: "Confetti Parade", shake: 1 },
      { max: 440, fn: sRocket, base: 340, name: "Money Rocket", shake: 1.5 },
      { max: 1e9, fn: sDragon, base: 440, name: "Dragon's Hoard", shake: 2.5 },
    ];
    const b = bands.find((x) => amt < x.max) || bands[bands.length - 1];
    const step = Math.max(0, Math.min(4, Math.floor((amt - b.base) / 20))); // 0..4 within band
    return { fn: b.fn, step, shake: b.shake, name: b.name };
  }

  function frame(now) {
    if (!playing) return;
    const t = now - startT;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, P.w, P.h);
    g.save();
    if (P.shake) shake(t < 300 ? 3 : 1);
    scene.fn(t);
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
      headline: scene.name === "Dragon's Hoard" && scene.step >= 3 ? "LEGENDARY!" : "WINNER!",
      amtStr: "+$" + (amt >= 1000 ? (amt / 1000).toFixed(1) + "k" : Math.round(amt)),
    };
    cv.classList.add("on");
    dur = reduce ? 900 : 2600 + scene.step * 150 + (scene.name === "Dragon's Hoard" ? 700 : 0);
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
