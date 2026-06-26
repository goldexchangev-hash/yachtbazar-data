/* ============================================================
   dice3d.js — "CRYPTO TV" 0-100 as a neon RACETRACK RAIL (Three.js r128).
   A glowing light-puck fires from 0 and races along a neon rail toward the
   roll, decelerating (ease-out-quint) with a near-miss micro-stall, over green
   WIN / red LOSE zones split at the target. Lands with a colored particle
   burst + shake. The number readout + verdict stay in the DOM on top.

   new Rail3D({ mount, width, height })
     .setActive(on)
     .setup(target, mode)   green/red zones (mode: "under" | "over")
     .setPuck(v)            puck at value v (0..100) while racing
     .land(won)             settle: burst + shake + puck locks green/red
     .reset()
   ============================================================ */
(function (root) {
  "use strict";
  const THREE = root.THREE;
  const X0 = -6, X1 = 6; // value 0..100 → x
  const xOf = (v) => X0 + (Math.max(0, Math.min(100, v)) / 100) * (X1 - X0);

  function softTex() {
    const S = 128, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.4, "rgba(255,255,255,.6)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, S, S); return new THREE.CanvasTexture(cv);
  }

  function Rail3D(opts) {
    this.mount = opts.mount; this.W = opts.width || 800; this.H = opts.height || 600;
    this._active = false; this._raf = 0; this._t = 0; this._shake = 0;
    this._v = 0; this._won = null; this._parts = []; this._trail = [];
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
    const cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 100); cam.position.set(0, 1.4, 9.2); cam.lookAt(0, -0.2, 0); this.cam = cam;
    scene.add(new THREE.AmbientLight(0x5566aa, 0.8));
    const key = new THREE.PointLight(0xffffff, 0.8, 40); key.position.set(0, 6, 8); scene.add(key);

    // base rail
    const railMat = new THREE.MeshStandardMaterial({ color: 0x1a2740, metalness: 0.6, roughness: 0.4, emissive: 0x0a1830, emissiveIntensity: 0.6 });
    const rail = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0 + 0.6, 0.5, 0.7), railMat); rail.position.y = -0.1; scene.add(rail);
    // WIN (green) + LOSE (red) zone bars sitting on the rail — resized in setup()
    this._winZone = new THREE.Mesh(new THREE.BoxGeometry(1, 0.14, 0.74), new THREE.MeshBasicMaterial({ color: 0x2bff88, transparent: true, opacity: 0.85 })); this._winZone.position.y = 0.2; scene.add(this._winZone);
    this._loseZone = new THREE.Mesh(new THREE.BoxGeometry(1, 0.14, 0.74), new THREE.MeshBasicMaterial({ color: 0xff3b4e, transparent: true, opacity: 0.7 })); this._loseZone.position.y = 0.2; scene.add(this._loseZone);
    // glow under each zone (additive)
    this._winGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: 0x2bff88, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5 })); this._winGlow.position.set(0, 0.2, 0.5); scene.add(this._winGlow);
    this._loseGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: 0xff3b4e, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.4 })); this._loseGlow.position.set(0, 0.2, 0.5); scene.add(this._loseGlow);

    // tick posts at 0/25/50/75/100
    for (let v = 0; v <= 100; v += 25) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.1), new THREE.MeshBasicMaterial({ color: 0x4a5e88 })); p.position.set(xOf(v), 0.25, 0.42); scene.add(p); }
    // target post
    this._target = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.3, 0.16), new THREE.MeshBasicMaterial({ color: 0xffd23f })); this._target.position.set(0, 0.5, 0.45); scene.add(this._target);

    // the racing puck (emissive glowing orb) + glow sprite
    this._puck = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 24), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x39e7ff, emissiveIntensity: 1.6, metalness: 0.3, roughness: 0.3 }));
    this._puck.position.set(X0, 0.55, 0.55); scene.add(this._puck);
    this._puckGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: 0x39e7ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this._puckGlow.scale.set(2, 2, 1); scene.add(this._puckGlow);

    this.fx = new THREE.Group(); scene.add(this.fx);
    this.reset();
    this.renderer.render(this.scene, this.cam);
  };

  Rail3D.prototype.setup = function (target, mode) {
    const tx = xOf(target);
    this._target.position.x = tx;
    // under: win = 0..target ; over: win = target..100
    const under = mode !== "over";
    const wA = under ? X0 : tx, wB = under ? tx : X1;
    const lA = under ? tx : X0, lB = under ? X1 : tx;
    const set = (mesh, glow, a, b) => { const w = Math.max(0.02, b - a); mesh.scale.x = w; mesh.position.x = (a + b) / 2; glow.position.x = (a + b) / 2; glow.scale.set(Math.max(1, w * 0.8), 1.1, 1); };
    set(this._winZone, this._winGlow, wA, wB);
    set(this._loseZone, this._loseGlow, lA, lB);
  };
  Rail3D.prototype.setPuck = function (v) { this._v = v; };
  Rail3D.prototype.land = function (won) {
    this._won = !!won;
    const col = won ? 0x2bff88 : 0xff3b4e;
    this._puck.material.emissive.set(col); this._puckGlow.material.color.set(col);
    const x = xOf(this._v);
    for (let i = 0; i < 36; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._soft, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      const s = 0.18 + Math.random() * 0.22; sp.scale.set(s, s, s); sp.position.set(x, 0.55, 0.6); this.fx.add(sp);
      const a = Math.random() * 6.28, sp2 = 2 + Math.random() * 4;
      this._parts.push({ s: sp, vx: Math.cos(a) * sp2, vy: Math.abs(Math.sin(a)) * sp2 + 1, life: 0.6 + Math.random() * 0.4, t: 0 });
    }
    this._shake = won ? 0.18 : 0.1;
  };
  Rail3D.prototype.reset = function () {
    this._v = 0; this._won = null; this._puck.material.emissive.set(0x39e7ff); this._puckGlow.material.color.set(0x39e7ff);
    this._puck.position.x = X0; this._puckGlow.position.set(X0, 0.55, 0.55);
    for (const p of this._parts) this.fx.remove(p.s); this._parts.length = 0; this._trail.length = 0;
  };

  Rail3D.prototype._loop = function () {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now; this._t += dt;
    const x = xOf(this._v);
    this._puck.position.x += (x - this._puck.position.x) * Math.min(1, dt * 18);
    this._puckGlow.position.set(this._puck.position.x, 0.55, 0.55);
    const pulse = 1 + 0.12 * Math.sin(this._t * 8); this._puckGlow.scale.set(2 * pulse, 2 * pulse, 1);
    this._puck.material.emissiveIntensity = 1.4 + 0.4 * Math.sin(this._t * 8);
    // particles
    for (let i = this._parts.length - 1; i >= 0; i--) { const p = this._parts[i]; p.t += dt; p.vy -= 7 * dt; p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.material.opacity = Math.max(0, 1 - p.t / p.life); if (p.t >= p.life) { this.fx.remove(p.s); p.s.material.dispose(); this._parts.splice(i, 1); } }
    // shake
    this._shake *= 0.85; if (this._shake < 0.004) this._shake = 0;
    this.cam.position.x = (Math.random() - 0.5) * this._shake; this.cam.position.y = 1.4 + (Math.random() - 0.5) * this._shake; this.cam.lookAt(0, -0.2, 0);
    this.renderer.render(this.scene, this.cam);
  };

  Rail3D.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
    else { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }
  };
  root.Rail3D = Rail3D;
})(typeof globalThis !== "undefined" ? globalThis : this);
