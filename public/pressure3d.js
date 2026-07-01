/* ============================================================
   pressure3d.js — "CRYPTO TV" Balloon Pop balloon in real 3D (Three.js r128).
   A glossy, glowing membrane that swells under pressure with volume-preserving
   squash + a wobble that tightens as the burst nears, then BANKS (relax + coins)
   or POPS (shards + flash). The HUD (multiplier, banners, gauge) stays in the
   existing Pixi/DOM layer — this only renders the balloon + burst FX.

   new Balloon3D({ mount, width, height })
     .setActive(on)        rAF on/off
     .setPressure(p, mult) p in [0,1] (burst-proximity) drives scale/wobble/color
     .reset()              limp balloon, ready
     .bank(tier)           release: relax + coin burst + glow ring
     .pop(tier)            burst: hide + shard explosion + white flash + shake
   ============================================================ */
(function (root) {
  "use strict";
  const THREE = root.THREE;

  function radialTexture(stops) {
    const S = 128, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
    stops.forEach((s) => g.addColorStop(s[0], s[1])); x.fillStyle = g; x.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(cv);
  }

  // It's a RED balloon — a rich red that deepens into a hot, strained
  // red-orange as it nears bursting (danger), never leaving the red family.
  function pressColor(p) {
    return new THREE.Color().lerpColors(new THREE.Color(0xd4142a), new THREE.Color(0xff3322), Math.max(0, Math.min(1, p)));
  }

  function Balloon3D(opts) {
    this.mount = opts.mount; this.W = opts.width || 800; this.H = opts.height || 600;
    this._active = false; this._raf = 0; this._t = 0; this._shake = 0;
    this.p = 0; this._wob = 0; this._baseScale = 0.7; this._state = "idle";
    this._shards = []; this._coins = []; this._rings = [];
    this._coinTex = radialTexture([[0, "#fff7cf"], [0.5, "#ffd23f"], [1, "rgba(184,134,11,0)"]]);
    this._glowTex = radialTexture([[0, "rgba(255,255,255,.9)"], [0.4, "rgba(255,210,63,.5)"], [1, "rgba(255,210,63,0)"]]);
    this._softTex = radialTexture([[0, "rgba(255,255,255,1)"], [0.5, "rgba(255,255,255,.5)"], [1, "rgba(255,255,255,0)"]]);
    this._initScene();
    this._loop = this._loop.bind(this);
  }

  Balloon3D.prototype._initScene = function () {
    const W = this.W, H = this.H;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(1.75, root.devicePixelRatio || 1));
    renderer.setSize(W, H, false);
    if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%"; renderer.domElement.style.display = "block";
    this.renderer = renderer; if (this.mount) this.mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene(); this.scene = scene; // transparent — HUD shows through
    const cam = new THREE.PerspectiveCamera(35, W / H, 0.1, 100); cam.position.set(0, 0, 7.4); cam.lookAt(0, 0, 0); this.cam = cam;

    scene.add(new THREE.AmbientLight(0x281018, 0.7));
    const key = new THREE.PointLight(0xffffff, 1.1, 30); key.position.set(-3, 5, 6); scene.add(key); // crisp specular highlight = gloss
    this._inner = new THREE.PointLight(0xff3322, 1.0, 12); this._inner.position.set(0, 0, 0); scene.add(this._inner); // glows from within
    this._rimA = new THREE.PointLight(0x39e7ff, 0.7, 20); this._rimA.position.set(-5, 4, 4); scene.add(this._rimA);
    this._rimB = new THREE.PointLight(0xff4d9d, 0.7, 20); this._rimB.position.set(5, -3, 4); scene.add(this._rimB);

    // balloon body — glossy translucent membrane
    this._balloon = new THREE.Group(); scene.add(this._balloon);
    const geo = new THREE.IcosahedronGeometry(1, 5); this._geo = geo; this._base = geo.attributes.position.array.slice();
    this._bodyMat = new THREE.MeshStandardMaterial({ color: 0x39e7ff, metalness: 0.1, roughness: 0.14, transparent: true, opacity: 0.8, emissive: 0x39e7ff, emissiveIntensity: 0.18 });
    this._body = new THREE.Mesh(geo, this._bodyMat); this._balloon.add(this._body);
    // outer fresnel-ish glow shell (backside additive)
    this._glowMat = new THREE.MeshBasicMaterial({ color: 0x39e7ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false });
    this._glow = new THREE.Mesh(new THREE.IcosahedronGeometry(1.07, 5), this._glowMat); this._balloon.add(this._glow);
    // specular hotspot
    this._spec = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._softTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7 }));
    this._spec.scale.set(0.5, 0.5, 0.5); this._balloon.add(this._spec);
    // knot at the bottom
    const knotMat = new THREE.MeshStandardMaterial({ color: 0x39e7ff, metalness: 0.1, roughness: 0.3, transparent: true, opacity: 0.85 });
    this._knot = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.28, 12), knotMat); this._knot.position.y = -1.0; this._knot.rotation.x = Math.PI; this._balloon.add(this._knot);
    this._knotMat = knotMat;

    this.fx = new THREE.Group(); scene.add(this.fx);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(30, 22), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })); this.flash.position.z = 3; scene.add(this.flash);

    this.reset();
    this.renderer.render(this.scene, this.cam);
  };

  /* ---------- public ---------- */
  Balloon3D.prototype.reset = function () {
    this.p = 0; this._state = "idle"; this._baseScale = 0.7; this._wob = 0;
    this._balloon.visible = true; this._balloon.scale.set(0.7, 0.7, 0.7); this._balloon.position.set(0, 0, 0);
    this._setColor(0);
  };
  // p in [0,1] = how close to bursting; mult only for display elsewhere.
  Balloon3D.prototype.setPressure = function (p) {
    this.p = Math.max(0, Math.min(1, p || 0));
    if (this._state === "idle" || this._state === "popped" || this._state === "banked") this._state = "inflating";
  };
  Balloon3D.prototype.bank = function (tier) {
    this._state = "banked"; this._bankT = 0; this._bankFrom = this._baseScale;
    this._ring(0x2bff88, tier === "mega" ? 6 : tier === "big" ? 4.5 : 3.2);
    if (tier === "mega") this._ring(0xffd23f, 8);
    const n = tier === "mega" ? 60 : tier === "big" ? 30 : 14; for (let i = 0; i < n; i++) this._spawnCoin();
    this.flash.material.color.set(0x9effc0); this.flash.material.opacity = tier === "mega" ? 0.3 : 0.18;
    this._punch(tier === "mega" ? 0.07 : tier === "big" ? 0.04 : 0.02);
  };
  Balloon3D.prototype.pop = function (tier) {
    if (this._state === "popped") return;
    this._state = "popped";
    const col = pressColor(this.p);
    // shard burst from the balloon surface
    const n = 90, R = this._baseScale;
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._softTex, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      const s = 0.12 + Math.random() * 0.16; sp.scale.set(s, s, s);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      sp.position.copy(dir.clone().multiplyScalar(R * 0.9)); this.fx.add(sp);
      this._shards.push({ s: sp, v: dir.multiplyScalar(3 + Math.random() * 5), life: 0.6 + Math.random() * 0.4, t: 0 });
    }
    this._balloon.visible = false;
    this.flash.material.color.set(0xffffff); this.flash.material.opacity = 0.85;
    this._punch(0.12);
    // crazy pop noise — scales with how big the balloon got
    if (root.Chiptune && root.Chiptune.balloonPop) try { root.Chiptune.balloonPop(this.p); } catch (e) {}
  };

  /* ---------- internals ---------- */
  Balloon3D.prototype._setColor = function (p) {
    const c = pressColor(p);
    this._bodyMat.color.copy(c); this._bodyMat.emissive.copy(c);
    this._glowMat.color.copy(c); this._knotMat.color.copy(c);
    this._inner.color.copy(c);
  };
  Balloon3D.prototype._spawnCoin = function () {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._coinTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const s = 0.3 + Math.random() * 0.3; sp.scale.set(s, s, s);
    sp.position.set((Math.random() - 0.5) * 3, 0.5 + Math.random(), 0.5); this.fx.add(sp);
    this._coins.push({ s: sp, vx: (Math.random() - 0.5) * 3.5, vy: 1.5 + Math.random() * 3.5, life: 1 + Math.random() * 0.7, t: 0 });
  };
  Balloon3D.prototype._ring = function (color, max) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._glowTex, color: color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sp.position.set(0, 0, 0.6); sp.scale.set(0.5, 0.5, 1); this.fx.add(sp); this._rings.push({ s: sp, t: 0, life: 0.55, max: max || 4 });
  };
  Balloon3D.prototype._punch = function (a) { this._shake = Math.max(this._shake, a); };

  Balloon3D.prototype._loop = function () {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now; this._t += dt;
    const p = this.p, B = this._balloon;

    if (this._state === "inflating") {
      const target = 0.7 + 1.2 * (1 - Math.pow(1 - p, 3)); // ease-out toward big at high pressure
      this._baseScale += (target - this._baseScale) * Math.min(1, dt * 8);
      // volume-preserving squash: idle gentle, nervous tremble near burst
      const amp = 0.04 + 0.12 * p, freq = 3 + 12 * p;
      const s = 1 + amp * Math.sin(this._t * freq);
      const bs = this._baseScale;
      B.scale.set(bs / Math.sqrt(s), bs * s, bs / Math.sqrt(s));
      this._setColor(p);
      this._inner.intensity = 0.5 + 1.1 * p + 0.3 * p * Math.sin(this._t * (4 + 10 * p)); // glows harder + flickers near burst
      this._glowMat.opacity = 0.18 + 0.32 * p;
      this._bodyMat.emissiveIntensity = 0.08 + 0.28 * p;
      B.position.x = (Math.random() - 0.5) * 0.02 * p; // micro-jitter at high pressure
    } else if (this._state === "banked") {
      this._bankT += dt; const k = Math.min(1, this._bankT / 0.45);
      const s = 1 + (0.12 * Math.exp(-7 * k) * Math.cos(20 * k)); // overshoot relax
      const bs = this._bankFrom; B.scale.set(bs * (1 / Math.sqrt(s)) * (1 - 0.06 * k), bs * s * (1 - 0.06 * k), bs / Math.sqrt(s));
      this._inner.intensity = Math.max(0.4, this._inner.intensity * 0.96);
    }
    // specular hotspot follows the upper-left of the balloon
    const r = this._baseScale; this._spec.position.set(-r * 0.4, r * 0.45, r * 0.9); this._spec.scale.setScalar(r * 0.7);

    // shards
    for (let i = this._shards.length - 1; i >= 0; i--) { const o = this._shards[i]; o.t += dt; o.v.y -= 6 * dt; o.s.position.addScaledVector(o.v, dt); o.s.material.opacity = Math.max(0, 1 - o.t / o.life); const sc = Math.max(0.01, o.s.scale.x - dt * 0.15); o.s.scale.setScalar(sc); if (o.t >= o.life) { this.fx.remove(o.s); o.s.material.dispose(); this._shards.splice(i, 1); } }
    // coins
    for (let i = this._coins.length - 1; i >= 0; i--) { const o = this._coins[i]; o.t += dt; o.vy -= 9 * dt; o.s.position.x += o.vx * dt; o.s.position.y += o.vy * dt; o.s.material.opacity = Math.max(0, 1 - o.t / o.life); if (o.t >= o.life || o.s.position.y < -3) { this.fx.remove(o.s); o.s.material.dispose(); this._coins.splice(i, 1); } }
    // rings
    for (let i = this._rings.length - 1; i >= 0; i--) { const r2 = this._rings[i]; r2.t += dt; const k = Math.min(1, r2.t / r2.life); r2.s.scale.set(0.5 + k * r2.max, 0.5 + k * r2.max, 1); r2.s.material.opacity = (1 - k) * 0.8; if (k >= 1) { this.fx.remove(r2.s); r2.s.material.dispose(); this._rings.splice(i, 1); } }
    // flash decay
    if (this.flash.material.opacity > 0.01) this.flash.material.opacity *= 0.88; else this.flash.material.opacity = 0;

    // shake
    this._shake *= 0.85; if (this._shake < 0.003) this._shake = 0;
    this.cam.position.x = (Math.random() - 0.5) * this._shake; this.cam.position.y = (Math.random() - 0.5) * this._shake; this.cam.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.cam);
  };

  Balloon3D.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
    else { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }
  };
  Balloon3D.prototype.resize = function (w, h) { this.W = w; this.H = h; this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); this.renderer.setSize(w, h, false); };

  root.Balloon3D = Balloon3D;
})(typeof globalThis !== "undefined" ? globalThis : this);
