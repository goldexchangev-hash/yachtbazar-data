/* ============================================================
   dice3d.js — "CRYPTO TV" 0-100 as a neon TACHOMETER ("REDLINE", Three.js r128).
   A glowing arcade rev-counter: a 240° dial sweeps 0→100, the player's target
   sits on the arc as a gold REDLINE splitting a green WIN zone from a red LOSE
   zone (hottest right at the line). A needle + comet head whips around the dial
   as the roll resolves, a shift-light bar chases it cell-by-cell, then it either
   over-revs with a tach-bounce + green shockwave (win) or recoils like a blown
   engine (lose). The big number + verdict are drawn by the DOM on top.

   API is unchanged (driven from tv.js revealDice):
   new Rail3D({ mount, width, height })
     .setActive(on)
     .setup(target, mode)   green/red zones (mode: "under" | "over")
     .setPuck(v)            needle to value v (0..100) while racing
     .land(won)             settle: bounce/recoil + burst + shake
     .reset()
   ============================================================ */
(function (root) {
  "use strict";
  const THREE = root.THREE;
  const HALF = Math.PI / 2, TAU = Math.PI * 2;

  // 240° arc with the gap at the TOP: value 0 → upper-LEFT, 50 → bottom, 100 → upper-right.
  const ARC = (240 * Math.PI) / 180;
  const ANG0 = -HALF + ARC / 2;
  const ANG100 = -HALF - ARC / 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // mirrored horizontally so 0 starts on the left and 100 ends on the right
  const angOf = (v) => Math.PI - (ANG0 + (clamp(v, 0, 100) / 100) * (ANG100 - ANG0)); // increases as v rises

  // radii
  const R_BEZEL = 3.02, R_DIAL = 2.78, CELL_IN = 2.30, CELL_OUT = 2.60;
  const R_TICK = 2.68, R_NUM = 2.99, NEEDLE_LEN = 2.18, R_TIP = 2.34, R_TARGET = 2.45;
  const N_CELLS = 44;

  // palette
  const C = {
    cyan: 0x39e7ff, magenta: 0xff4d9d, gold: 0xffd23f,
    greenHot: 0x2bff88, greenDeep: 0x0c5a31, redHot: 0xff3b4e, redDeep: 0x5e1320,
    white: 0xeaffff, cellOff: 0x16233c, metal: 0x1a2236,
  };
  const col = (h) => new THREE.Color(h);

  function softTex() {
    const S = 128, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.4, "rgba(255,255,255,.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, S, S); return new THREE.CanvasTexture(cv);
  }
  function dialTex() {
    const S = 512, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, S / 2);
    g.addColorStop(0, "#0c1426"); g.addColorStop(0.55, "#080d1a"); g.addColorStop(1, "#04060d");
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    x.strokeStyle = "rgba(60,90,150,0.10)"; x.lineWidth = 1.5;
    for (let r = 40; r < S / 2; r += 26) { x.beginPath(); x.arc(S / 2, S / 2, r, 0, TAU); x.stroke(); }
    return new THREE.CanvasTexture(cv);
  }
  function numTex(label) {
    const W = 96, H = 64, cv = document.createElement("canvas"); cv.width = W; cv.height = H; const x = cv.getContext("2d");
    x.clearRect(0, 0, W, H);
    x.font = "700 italic 40px 'Rajdhani','Arial Narrow',sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.shadowColor = "rgba(57,231,255,0.9)"; x.shadowBlur = 12; x.fillStyle = "#cdeeff";
    x.fillText(label, W / 2, H / 2 + 2);
    return new THREE.CanvasTexture(cv);
  }

  function Rail3D(opts) {
    this.mount = opts.mount; this.W = opts.width || 800; this.H = opts.height || 600;
    this._active = false; this._raf = 0; this._t = 0; this._shake = 0;
    this._v = 0; this._won = null; this._parts = []; this._rings = []; this._trail = [];
    this._target = 50; this._under = true; this._land = null;
    this._soft = softTex();
    this._initScene();
    this._loop = this._loop.bind(this);
  }

  Rail3D.prototype._initScene = function () {
    const W = this.W, H = this.H;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(1.75, root.devicePixelRatio || 1)); renderer.setSize(W, H, false);
    if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%"; renderer.domElement.style.display = "block";
    this.renderer = renderer; if (this.mount) this.mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene(); this.scene = scene;
    const cam = new THREE.PerspectiveCamera(38, W / H, 0.1, 100); cam.position.set(0, 0.05, 9.5); cam.lookAt(0, 0.05, 0); this.cam = cam; scene.add(cam);
    this._camBase = cam.position.clone();

    scene.add(new THREE.AmbientLight(0x223066, 0.6));
    const key = new THREE.PointLight(C.cyan, 1.3, 30); key.position.set(-3.5, 3, 6); scene.add(key);
    const acc = new THREE.PointLight(C.magenta, 1.0, 30); acc.position.set(3.5, -2.5, 5); scene.add(acc);

    // soft ambient halo behind the dial
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: 0x18306a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7 }));
    halo.position.set(0, 0.1, -3); halo.scale.set(15, 15, 1); scene.add(halo);

    // everything in the dial is raked slightly toward the camera like an instrument cluster
    const gauge = new THREE.Group(); gauge.rotation.x = -0.16; gauge.position.y = 0.1; scene.add(gauge); this.gauge = gauge;

    // bezel (brushed-metal money-wheel frame)
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(R_BEZEL, 0.17, 12, 72),
      new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.95, roughness: 0.28, emissive: 0x0a1830, emissiveIntensity: 0.4 }));
    gauge.add(bezel);
    const bezel2 = new THREE.Mesh(new THREE.TorusGeometry(R_BEZEL - 0.16, 0.05, 8, 64),
      new THREE.MeshStandardMaterial({ color: 0x0e1626, metalness: 0.8, roughness: 0.3, emissive: C.cyan, emissiveIntensity: 0.18 }));
    gauge.add(bezel2);

    // dial face
    const dial = new THREE.Mesh(new THREE.CircleGeometry(R_DIAL, 64),
      new THREE.MeshStandardMaterial({ map: dialTex(), metalness: 0.55, roughness: 0.55, emissive: 0x060c18, emissiveIntensity: 0.7 }));
    dial.position.z = -0.04; gauge.add(dial);

    // the 44 shift-light / zone cells along the arc
    this.cells = [];
    for (let i = 0; i < N_CELLS; i++) {
      const vLo = (i / N_CELLS) * 100, vHi = ((i + 1) / N_CELLS) * 100;
      const a1 = angOf(vLo), a2 = angOf(vHi);
      const start = Math.min(a1, a2), span = Math.abs(a2 - a1), pad = span * 0.16; // winding-robust
      const geo = new THREE.RingGeometry(CELL_IN, CELL_OUT, 3, 1, start + pad / 2, span - pad);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: C.cellOff, transparent: true, opacity: 0.95 }));
      m.position.z = 0.02; gauge.add(m);
      this.cells.push({ m, v: (i + 0.5) / N_CELLS * 100, base: col(C.cellOff) });
    }

    // tick marks + number labels (0..100 by 10)
    for (let v = 0; v <= 100; v += 10) {
      const a = angOf(v);
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.2, 0.04), new THREE.MeshBasicMaterial({ color: 0x8fbfff }));
      tick.position.set(Math.cos(a) * R_TICK, Math.sin(a) * R_TICK, 0.04); tick.rotation.z = a - HALF; gauge.add(tick);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: numTex(String(v)), transparent: true, depthWrite: false }));
      sp.position.set(Math.cos(a) * R_NUM, Math.sin(a) * R_NUM, 0.06); sp.scale.set(0.62, 0.42, 1); gauge.add(sp);
    }
    // minor ticks every 5
    for (let v = 5; v < 100; v += 10) {
      const a = angOf(v);
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.03), new THREE.MeshBasicMaterial({ color: 0x46618f }));
      tick.position.set(Math.cos(a) * (R_TICK + 0.02), Math.sin(a) * (R_TICK + 0.02), 0.04); tick.rotation.z = a - HALF; gauge.add(tick);
    }

    // hub + glowing core
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.4, 0.22, 28),
      new THREE.MeshStandardMaterial({ color: 0x0d1424, metalness: 1.0, roughness: 0.22, emissive: C.cyan, emissiveIntensity: 0.3 }));
    hub.rotation.x = HALF; hub.position.z = 0.16; gauge.add(hub);
    const hubGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: C.cyan, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7 }));
    hubGlow.position.set(0, 0, 0.2); hubGlow.scale.set(1.1, 1.1, 1); gauge.add(hubGlow); this._hubGlow = hubGlow;

    // needle (tapered blade pointing +Y at rest) under a pivot
    const pivot = new THREE.Group(); gauge.add(pivot); this._pivot = pivot;
    const blade = new THREE.CylinderGeometry(0.02, 0.11, NEEDLE_LEN, 10); blade.translate(0, NEEDLE_LEN / 2, 0);
    const needle = new THREE.Mesh(blade, new THREE.MeshStandardMaterial({ color: 0xeaf7ff, emissive: C.cyan, emissiveIntensity: 1.6, metalness: 0.3, roughness: 0.3 }));
    needle.position.z = 0.18; pivot.add(needle); this._needle = needle;
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8), new THREE.MeshStandardMaterial({ color: 0x141c2e, metalness: 0.9, roughness: 0.3 }));
    tail.position.set(0, -0.25, 0.16); pivot.add(tail);
    // comet head + light parented to the needle tip
    const comet = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: C.cyan, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    comet.position.set(0, R_TIP, 0.22); comet.scale.set(0.9, 0.9, 1); pivot.add(comet); this._comet = comet;
    const nlight = new THREE.PointLight(C.cyan, 1.6, 6); nlight.position.set(0, R_TIP, 0.6); pivot.add(nlight); this._nlight = nlight;

    // motion-blur trail (6 additive sprites trailing the comet)
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: C.cyan, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
      s.scale.set(0.7, 0.7, 1); s.position.z = 0.2; gauge.add(s); this._trail.push({ s, a: ANG0 });
    }

    // target redline marker (positioned in setup)
    const tg = new THREE.Group(); gauge.add(tg); this._tgMark = tg;
    const red = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.62, 0.05), new THREE.MeshBasicMaterial({ color: C.gold }));
    red.position.set(0, R_TARGET, 0.05); tg.add(red);
    const tgGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: C.gold, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85 }));
    tgGlow.position.set(0, R_TARGET, 0.1); tgGlow.scale.set(0.95, 0.95, 1); tg.add(tgGlow); this._tgGlow = tgGlow;

    // fx group (particles, shockwave rings) + camera-pinned flash quad
    this.fx = new THREE.Group(); gauge.add(this.fx);
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ color: C.greenHot, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    flash.position.z = -2.2; cam.add(flash); this._flash = flash;

    this.setup(50, "under");
    this.reset();
    this.renderer.render(this.scene, this.cam);
  };

  Rail3D.prototype.setup = function (target, mode) {
    this._target = clamp(target, 0, 100); this._under = mode !== "over";
    const tg = this._target, under = this._under;
    const gh = col(C.greenHot), gd = col(C.greenDeep), rh = col(C.redHot), rd = col(C.redDeep), gold = col(C.gold);
    for (const c of this.cells) {
      const win = under ? c.v < tg : c.v > tg;
      const t = 1 - Math.min(1, Math.abs(c.v - tg) / 35);          // hottest near the line
      let base;
      if (Math.abs(c.v - tg) < (100 / N_CELLS)) base = gold.clone();
      else base = (win ? gd.clone().lerp(gh, t) : rd.clone().lerp(rh, t));
      c.base = base; c.m.material.color.copy(base);
    }
    // redline marker to the target angle
    const a = angOf(tg);
    this._tgMark.rotation.z = a - HALF;
  };

  Rail3D.prototype.setPuck = function (v) { this._v = clamp(v, 0, 100); };

  Rail3D.prototype.land = function (won) {
    this._won = !!won;
    const c = won ? C.greenHot : C.redHot;
    this._comet.material.color.set(c); this._nlight.color.set(c); this._needle.material.emissive.set(c);
    this._land = { t: 0, won };
    this._flash.material.color.set(c); this._flash.material.opacity = won ? 0.5 : 0.42;
    this._shake = won ? 0.18 : 0.12;
    // particle burst at the needle tip
    const a = angOf(this._v), tx = Math.cos(a) * R_TIP, ty = Math.sin(a) * R_TIP;
    const n = won ? 46 : 32;
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      const s = 0.16 + Math.random() * 0.2; sp.scale.set(s, s, s); sp.position.set(tx, ty, 0.3); this.fx.add(sp);
      const ang = Math.random() * TAU, sp2 = (won ? 2.5 : 1.8) + Math.random() * (won ? 4 : 2.5);
      this._parts.push({ s: sp, vx: Math.cos(ang) * sp2, vy: Math.sin(ang) * sp2 + (won ? 1.2 : -0.4), g: won ? -5 : -9, life: 0.7 + Math.random() * 0.4, t: 0 });
    }
    // win shockwave ring from the hub
    if (won) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.42, 40), new THREE.MeshBasicMaterial({ color: C.greenHot, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }));
      ring.position.z = 0.12; this.fx.add(ring); this._rings.push({ m: ring, t: 0, life: 0.55 });
    }
  };

  Rail3D.prototype.reset = function () {
    this._v = 0; this._won = null; this._land = null;
    this._comet.material.color.set(C.cyan); this._nlight.color.set(C.cyan); this._needle.material.emissive.set(C.cyan);
    this._flash.material.opacity = 0; this._shake = 0;
    this._pivot.rotation.z = angOf(0) - HALF;
    for (const p of this._parts) { this.fx.remove(p.s); p.s.material.dispose(); } this._parts.length = 0;
    for (const r of this._rings) { this.fx.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); } this._rings.length = 0;
    for (const t of this._trail) t.s.material.opacity = 0;
    this.cam.position.copy(this._camBase); this.cam.lookAt(0, 0.05, 0);
  };

  Rail3D.prototype._loop = function () {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now; this._t += dt;

    // needle angle from value (+ bounce/recoil on landing)
    let vEff = this._v;
    if (this._land) {
      this._land.t += dt; const lt = this._land.t;
      if (this._land.won) vEff = clamp(this._v + 5 * Math.sin(lt * 18) * Math.exp(-lt * 6), 0, 100);     // tach over-rev bounce
      else vEff = clamp(this._v - 8 * Math.exp(-lt * 7) * Math.cos(lt * 6), 0, 100);                      // blown-engine recoil
      if (lt > 0.9) this._land = null;
    }
    const a = angOf(vEff);
    this._pivot.rotation.z = a - HALF;

    // comet pulse + strain near redline of the dial
    const strain = this._v > 80 ? (this._v - 80) / 20 : 0;
    const pulse = 0.9 + 0.12 * Math.sin(this._t * 12) + 0.06 * strain * Math.sin(this._t * 40);
    this._comet.scale.set(pulse, pulse, 1);
    this._needle.material.emissiveIntensity = 1.5 + 0.4 * Math.sin(this._t * 12) + 0.8 * strain;
    this._hubGlow.material.opacity = 0.6 + 0.12 * Math.sin(this._t * 6);

    // shift-light chase: cells up to v glow brighter, the frontier cell flashes white
    const tipX = Math.cos(a) * R_TIP, tipY = Math.sin(a) * R_TIP;
    let frontier = -1, fd = 1e9;
    for (let i = 0; i < this.cells.length; i++) { const d = Math.abs(this.cells[i].v - this._v); if (d < fd) { fd = d; frontier = i; } }
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      if (i === frontier && !this._land) c.m.material.color.copy(c.base).lerp(col(C.white), 0.75);
      else if (c.v <= this._v) c.m.material.color.copy(c.base).multiplyScalar(1.35);
      else c.m.material.color.copy(c.base);
    }

    // trail: shift positions, newest at comet tip
    for (let i = this._trail.length - 1; i > 0; i--) { this._trail[i].a = this._trail[i - 1].a; }
    this._trail[0].a = a;
    for (let i = 0; i < this._trail.length; i++) {
      const tr = this._trail[i], aa = tr.a;
      tr.s.position.set(Math.cos(aa) * R_TIP, Math.sin(aa) * R_TIP, 0.2);
      tr.s.material.color.copy(this._comet.material.color);
      tr.s.material.opacity = (this._land ? 0.0 : 0.42) * (1 - i / this._trail.length);
      const sc = 0.66 * (1 - i / this._trail.length * 0.6); tr.s.scale.set(sc, sc, 1);
    }

    // target marker breathe
    const tp = 0.88 + 0.12 * Math.sin(this._t * 4); this._tgGlow.scale.set(tp, tp, 1);

    // particles
    for (let i = this._parts.length - 1; i >= 0; i--) {
      const p = this._parts[i]; p.t += dt; p.vy += p.g * dt;
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt;
      p.s.material.opacity = Math.max(0, 1 - p.t / p.life);
      if (p.t >= p.life) { this.fx.remove(p.s); p.s.material.dispose(); this._parts.splice(i, 1); }
    }
    // shockwave rings
    for (let i = this._rings.length - 1; i >= 0; i--) {
      const r = this._rings[i]; r.t += dt; const k = r.t / r.life, s = 0.3 + k * 7;
      r.m.scale.set(s, s, 1); r.m.material.opacity = Math.max(0, 0.9 * (1 - k));
      if (r.t >= r.life) { this.fx.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); this._rings.splice(i, 1); }
    }
    // flash fade
    if (this._flash.material.opacity > 0) this._flash.material.opacity = Math.max(0, this._flash.material.opacity - dt * 1.4);

    // camera shake
    this._shake *= 0.86; if (this._shake < 0.004) this._shake = 0;
    this.cam.position.set(this._camBase.x + (Math.random() - 0.5) * this._shake, this._camBase.y + (Math.random() - 0.5) * this._shake, this._camBase.z);
    this.cam.lookAt(0, 0.05, 0);

    this.renderer.render(this.scene, this.cam);
  };

  Rail3D.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
    else { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }
  };
  root.Rail3D = Rail3D;
})(typeof globalThis !== "undefined" ? globalThis : this);
