/* ============================================================
   dice2-3d.js — "CRYPTO TV" Dice #2 (two d6) in real 3D (Three.js r128).
   Two chunky neon dice tumble in and land showing the rolled faces, lit by the
   same cyan/magenta rig as the other 3D games. Sum + verdict stay in the DOM.

   new TwoDice3D({ mount, width, height })
     .setActive(on)
     .roll(d1, d2, won)   tumble both dice → land on d1/d2, burst on win
     .reset()
   ============================================================ */
(function (root) {
  "use strict";
  const THREE = root.THREE;
  // Euler rotation that brings face value V to face the camera (+Z).
  const HALF = Math.PI / 2;
  const FACEUP = { 1: [0, 0, 0], 2: [HALF, 0, 0], 3: [0, -HALF, 0], 4: [0, HALF, 0], 5: [-HALF, 0, 0], 6: [0, Math.PI, 0] };

  // pip texture for a die face (N pips, standard layout) on a rounded white tile
  function pipTex(n) {
    const S = 256, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createLinearGradient(0, 0, S, S); g.addColorStop(0, "#fdfbff"); g.addColorStop(1, "#d9def0");
    x.fillStyle = g; rr(x, 8, 8, S - 16, S - 16, 40); x.fill();
    x.strokeStyle = "rgba(80,90,130,.35)"; x.lineWidth = 5; rr(x, 12, 12, S - 24, S - 24, 36); x.stroke();
    const q = S / 4, c = S / 2, layouts = {
      1: [[c, c]], 2: [[q, q], [3 * q, 3 * q]], 3: [[q, q], [c, c], [3 * q, 3 * q]],
      4: [[q, q], [3 * q, q], [q, 3 * q], [3 * q, 3 * q]], 5: [[q, q], [3 * q, q], [c, c], [q, 3 * q], [3 * q, 3 * q]],
      6: [[q, q], [3 * q, q], [q, c], [3 * q, c], [q, 3 * q], [3 * q, 3 * q]],
    };
    for (const p of layouts[n]) { const rg = x.createRadialGradient(p[0] - 6, p[1] - 6, 2, p[0], p[1], 26); rg.addColorStop(0, "#ff6a8a"); rg.addColorStop(1, "#b1183f"); x.fillStyle = rg; x.beginPath(); x.arc(p[0], p[1], 26, 0, 7); x.fill(); }
    const t = new THREE.CanvasTexture(cv); if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding; return t;
  }
  function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
  function softTex() {
    const S = 128, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, S, S); return new THREE.CanvasTexture(cv);
  }

  function TwoDice3D(opts) {
    this.mount = opts.mount; this.W = opts.width || 800; this.H = opts.height || 600;
    this._active = false; this._raf = 0; this._t = 0; this._shake = 0; this._parts = [];
    this._soft = softTex();
    // BoxGeometry material order +X,-X,+Y,-Y,+Z,-Z → values 3,4,2,5,1,6 (opposite faces sum 7)
    this._mats = [3, 4, 2, 5, 1, 6].map((v) => new THREE.MeshStandardMaterial({ map: pipTex(v), metalness: 0.25, roughness: 0.45 }));
    this._initScene();
    this._loop = this._loop.bind(this);
  }

  TwoDice3D.prototype._initScene = function () {
    const W = this.W, H = this.H;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(1.75, root.devicePixelRatio || 1)); renderer.setSize(W, H, false);
    if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%"; renderer.domElement.style.display = "block";
    this.renderer = renderer; if (this.mount) this.mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene(); this.scene = scene;
    const cam = new THREE.PerspectiveCamera(42, W / H, 0.1, 100); cam.position.set(0, 0.2, 8.4); cam.lookAt(0, 0, 0); this.cam = cam;
    scene.add(new THREE.AmbientLight(0x4a5a8a, 0.75));
    const key = new THREE.PointLight(0xffffff, 0.9, 40); key.position.set(0, 5, 9); scene.add(key);
    const cyan = new THREE.PointLight(0x39e7ff, 0.8, 30); cyan.position.set(-7, 2, 6); scene.add(cyan);
    const mag = new THREE.PointLight(0xff4d9d, 0.8, 30); mag.position.set(7, -2, 6); scene.add(mag);

    const geo = new THREE.BoxGeometry(1.7, 1.7, 1.7);
    this._dice = [];
    for (let i = 0; i < 2; i++) {
      const d = new THREE.Mesh(geo, this._mats); d.position.set(i ? 2.0 : -2.0, 0, 0); scene.add(d);
      this._dice.push({ m: d, spin: new THREE.Vector3(), t: 0, dur: 1, from: new THREE.Euler(), to: new THREE.Euler(), x: i ? 2.0 : -2.0, state: "idle" });
    }
    this.fx = new THREE.Group(); scene.add(this.fx);
    this.reset();
    this.renderer.render(this.scene, this.cam);
  };

  TwoDice3D.prototype.reset = function () {
    for (const d of this._dice) { d.state = "idle"; d.m.rotation.set(-0.5, 0.5, 0.2); d.m.position.set(d.x, 0, 0); }
    for (const p of this._parts) this.fx.remove(p.s); this._parts.length = 0;
  };
  TwoDice3D.prototype.roll = function (d1, d2, won) {
    this._won = won; const vals = [d1, d2];
    this._dice.forEach((d, i) => {
      const v = Math.max(1, Math.min(6, vals[i] | 0)), f = FACEUP[v];
      const turns = 3 + ((Math.random() * 2) | 0);
      d.from = new THREE.Euler().copy(d.m.rotation);
      d.to = new THREE.Euler(f[0] + turns * 2 * Math.PI * (Math.random() < 0.5 ? 1 : -1), f[1] + turns * 2 * Math.PI, f[2]);
      d.t = 0; d.dur = 1.3 + i * 0.18; d.state = "rolling"; d.hop = 1.6;
    });
  };
  TwoDice3D.prototype._burst = function (col) {
    for (let i = 0; i < 30; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      const s = 0.18 + Math.random() * 0.2; sp.scale.set(s, s, s); sp.position.set((Math.random() - 0.5) * 4, 0, 0.5); this.fx.add(sp);
      const a = Math.random() * 6.28, sp2 = 2 + Math.random() * 4;
      this._parts.push({ s: sp, vx: Math.cos(a) * sp2, vy: Math.abs(Math.sin(a)) * sp2 + 1, life: 0.6 + Math.random() * 0.4, t: 0 });
    }
    this._shake = 0.12;
  };

  TwoDice3D.prototype._loop = function () {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now; this._t += dt;
    let anyRolling = false, justLanded = false;
    for (const d of this._dice) {
      if (d.state === "rolling") {
        anyRolling = true; d.t += dt; const k = Math.min(1, d.t / d.dur), e = 1 - Math.pow(1 - k, 4);
        d.m.rotation.set(d.from.x + (d.to.x - d.from.x) * e, d.from.y + (d.to.y - d.from.y) * e, d.from.z + (d.to.z - d.from.z) * e);
        d.m.position.y = Math.sin(k * Math.PI) * d.hop * (1 - k * 0.3); // arc hop, settling
        if (k >= 1) { d.state = "landed"; d.m.position.y = 0; d.m.rotation.set(d.to.x, d.to.y, d.to.z); justLanded = true; if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {} }
      } else if (d.state === "idle") { d.m.rotation.y += dt * 0.5; d.m.rotation.x += dt * 0.3; } // gentle idle tumble
    }
    if (justLanded && !anyRolling && this._won != null) { this._burst(this._won ? 0x2bff88 : 0xff3b4e); this._won = null; }
    for (let i = this._parts.length - 1; i >= 0; i--) { const p = this._parts[i]; p.t += dt; p.vy -= 7 * dt; p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.material.opacity = Math.max(0, 1 - p.t / p.life); if (p.t >= p.life) { this.fx.remove(p.s); p.s.material.dispose(); this._parts.splice(i, 1); } }
    this._shake *= 0.85; if (this._shake < 0.004) this._shake = 0;
    this.cam.position.x = (Math.random() - 0.5) * this._shake; this.cam.position.y = 0.2 + (Math.random() - 0.5) * this._shake; this.cam.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.cam);
  };

  TwoDice3D.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
    else { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }
  };
  root.TwoDice3D = TwoDice3D;
})(typeof globalThis !== "undefined" ? globalThis : this);
