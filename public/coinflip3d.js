/* ============================================================
   coinflip3d.js — "CRYPTO TV" Coin Flip in real 3D (Three.js r128, WebGL).
   A machined metal coin (beveled cylinder, embossed ETH-heads / star-tails
   faces) tumbles in neon light and lands on the PRE-DETERMINED side, then a
   tier-scaled celebration. Mirrors slots3d.js so both screens feel like one
   cabinet. No external assets — every texture/env is procedural.

   new CoinFlip3D({ mount, width, height, onApex })
     .setActive(on)        rAF on/off (channel on-screen)
     .reset(side)          rest flat, given face up ("HEADS"|"TAILS")
     .toss()               anticipation → launch arc → spin → air hang (awaits result)
     .land(side, tier)     drop + bounce + settle onto side, celebrate(tier) on a win
   ============================================================ */
(function (root) {
  "use strict";
  const THREE = root.THREE;
  const HEADS = "HEADS", TAILS = "TAILS";

  /* ---------- procedural face textures ----------
     HEADS = warm gold + big "HEADS" word + ETH diamond.
     TAILS = cool cyan-silver + big "TAILS" word + 6-point star.
     The word is the dominant element so the side reads at a glance, even mid-spin.
     Legibility comes from a 3-pass engraved stamp (dark recess + bright raised edge
     + crisp stroke), not blur. Warm-vs-cool tone makes them tell apart instantly. */
  function shapeFor(kind, x, R) { // draw heads diamond / tails star centered at current origin
    if (kind === HEADS) {
      x.beginPath(); x.moveTo(0, -R); x.lineTo(R * 0.62, 0); x.lineTo(0, R * 0.34); x.lineTo(-R * 0.62, 0); x.closePath(); x.fill();
      x.beginPath(); x.moveTo(0, R * 0.5); x.lineTo(R * 0.62, R * 0.12); x.lineTo(0, R); x.lineTo(-R * 0.62, R * 0.12); x.closePath(); x.fill();
    } else {
      x.beginPath(); for (let i = 0; i < 12; i++) { const rad = i % 2 ? R * 0.46 : R, a = i / 12 * 6.283 - Math.PI / 2; x[i ? "lineTo" : "moveTo"](Math.cos(a) * rad, Math.sin(a) * rad); } x.closePath(); x.fill();
    }
  }
  function faceTexture(kind) {
    const S = 1024, cv = document.createElement("canvas"); cv.width = cv.height = S;
    const x = cv.getContext("2d"), C = S / 2, heads = kind === HEADS;
    const P = heads
      ? { f0: "#fff7d6", f1: "#ffd23f", f2: "#9a6a06", ink: "#7a5402", hi: "#fff4c2", rec: "rgba(40,24,0,.55)", rim: "#8a5e08" }
      : { f0: "#eaffff", f1: "#9fe9ff", f2: "#1f6e94", ink: "#0e4e6b", hi: "#eafcff", rec: "rgba(0,28,44,.55)", rim: "#1c5d80" };
    // metal base field — radial, light from upper-left
    const g = x.createRadialGradient(C * 0.78, C * 0.70, 12, C, C, C);
    g.addColorStop(0, P.f0); g.addColorStop(0.45, P.f1); g.addColorStop(1, P.f2);
    x.fillStyle = g; x.beginPath(); x.arc(C, C, C - 6, 0, 7); x.fill();
    // Present TAILS right-side-up: the coin's landing flip (rotation.x = π) turns the
    // -Z face top-to-bottom, so pre-rotate its engraving 180° to net out upright.
    if (!heads) { x.translate(C, C); x.rotate(Math.PI); x.translate(-C, -C); }
    // inner engraved ring + bright groove
    x.strokeStyle = P.rim; x.lineWidth = 10; x.beginPath(); x.arc(C, C, C * 0.80, 0, 7); x.stroke();
    x.strokeStyle = P.hi; x.lineWidth = 2; x.beginPath(); x.arc(C, C, C * 0.80 - 7, 0, 7); x.stroke();
    // reeded inner tick band
    x.strokeStyle = P.rim; x.globalAlpha = 0.55; x.lineWidth = 4;
    for (let i = 0; i < 120; i++) { const a = i / 120 * 6.283; x.beginPath(); x.moveTo(C + Math.cos(a) * (C - 14), C + Math.sin(a) * (C - 14)); x.lineTo(C + Math.cos(a) * (C - 30), C + Math.sin(a) * (C - 30)); x.stroke(); }
    x.globalAlpha = 1;
    // engraved curved word along an arc (midA = arc-center angle; up = +1 top / -1 bottom)
    const arcText = (text, radius, midA, size, up) => {
      x.save(); x.textAlign = "center"; x.textBaseline = "middle";
      x.font = "900 " + size + "px 'Arial Black', Arial, sans-serif";
      const step = (size * 0.92) / radius;
      const start = midA - step * (text.length - 1) / 2 * up;
      for (let i = 0; i < text.length; i++) {
        const a = start + step * i * up, ch = text[i];
        x.save(); x.translate(C + Math.cos(a) * radius, C + Math.sin(a) * radius);
        x.rotate(a + (up > 0 ? Math.PI / 2 : -Math.PI / 2));
        x.fillStyle = P.rec; x.fillText(ch, 2, 3);   // recess shadow
        x.fillStyle = P.hi; x.fillText(ch, -1, -2);   // raised highlight
        x.fillStyle = P.ink; x.fillText(ch, 0, 0);    // engraved body
        x.lineWidth = 3; x.strokeStyle = P.rim; x.strokeText(ch, 0, 0);
        x.restore();
      }
      x.restore();
    };
    arcText(kind, C * 0.64, -Math.PI / 2, 150, 1); // the WORD across the top
    // center emblem — 3-pass embossed
    const emblem = (dx, dy, fill, R) => { x.save(); x.translate(C + dx, C + dy); x.fillStyle = fill; shapeFor(kind, x, R); x.restore(); };
    const ER = C * 0.30;
    emblem(3, 4, P.rec, ER); emblem(-2, -3, P.hi, ER); emblem(0, 0, P.ink, ER);
    x.lineWidth = 4; x.strokeStyle = P.rim; x.save(); x.translate(C, C); shapeFor(kind, x, ER); x.stroke(); x.restore();
    // three mini icons along the bottom arc — side identity survives even off-axis
    for (let k = -1; k <= 1; k++) { const a = Math.PI / 2 + k * 0.34, r = C * 0.60; const mx = C + Math.cos(a) * r, my = C + Math.sin(a) * r; x.save(); x.translate(mx, my); x.fillStyle = P.rec; shapeFor(kind, x, C * 0.05); x.restore(); x.save(); x.translate(mx, my); x.fillStyle = P.ink; shapeFor(kind, x, C * 0.05); x.restore(); }
    // two specular glint dots that survive texture sampling
    x.fillStyle = "rgba(255,255,255,.85)"; x.beginPath(); x.arc(C * 0.62, C * 0.5, 7, 0, 7); x.fill(); x.beginPath(); x.arc(C * 0.5, C * 0.66, 5, 0, 7); x.fill();
    const t = new THREE.CanvasTexture(cv); t.anisotropy = 16; if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding; return t;
  }
  function reededEdge() { // vertical-stripe bump so the cylinder wall reads as a milled (reeded) edge
    const w = 1024, h = 64, cv = document.createElement("canvas"); cv.width = w; cv.height = h; const x = cv.getContext("2d");
    x.fillStyle = "#9a6f12"; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) { const px = i / 160 * w; x.fillStyle = i % 2 ? "rgba(255,240,180,.9)" : "rgba(40,26,0,.85)"; x.fillRect(px, 0, w / 160 * 0.6, h); }
    const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  function coinSprite() {
    const S = 64, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S * 0.38, S * 0.34, 3, S / 2, S / 2, S / 2);
    g.addColorStop(0, "#fff7cf"); g.addColorStop(0.5, "#ffd23f"); g.addColorStop(1, "#b8860b");
    x.fillStyle = g; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 2, 0, 7); x.fill();
    return new THREE.CanvasTexture(cv);
  }
  function radialTexture(stops) {
    const S = 256, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
    stops.forEach((s) => g.addColorStop(s[0], s[1])); x.fillStyle = g; x.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(cv);
  }

  function CoinFlip3D(opts) {
    this.mount = opts.mount; this.W = opts.width || 800; this.H = opts.height || 600;
    this.onApex = opts.onApex || null;
    this._active = false; this._raf = 0; this._t = 0; this._shake = 0;
    this.phase = "idle"; this._coins = []; this._rings = [];
    this._spin = 0; this._spinVel = 0; this._side = HEADS;
    this._coinTex = coinSprite();
    this._glowTex = radialTexture([[0, "rgba(255,255,255,.9)"], [0.4, "rgba(255,210,63,.5)"], [1, "rgba(255,210,63,0)"]]);
    this._initScene();
    this._loop = this._loop.bind(this);
  }

  CoinFlip3D.prototype._initScene = function () {
    const W = this.W, H = this.H;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(1.75, root.devicePixelRatio || 1));
    renderer.setSize(W, H, false);
    if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05; }
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%"; renderer.domElement.style.display = "block";
    this.renderer = renderer; if (this.mount) this.mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x05060f);
    scene.fog = new THREE.Fog(0x05060f, 10, 22); this.scene = scene;
    const cam = new THREE.PerspectiveCamera(42, W / H, 0.1, 100); cam.position.set(0, 0.5, 9.6); cam.lookAt(0, 0.8, 0); this.cam = cam;

    scene.add(new THREE.AmbientLight(0x4a5a8a, 0.6));
    this._key = new THREE.PointLight(0xffffff, 1.0, 40); this._key.position.set(0, 5, 9); scene.add(this._key);
    this._cyan = new THREE.PointLight(0x39e7ff, 0.95, 30); this._cyan.position.set(-7, 1, 6); scene.add(this._cyan);
    this._mag = new THREE.PointLight(0xff4d9d, 0.95, 30); this._mag.position.set(7, -1, 6); scene.add(this._mag);
    this._gold = new THREE.PointLight(0xffd23f, 0.0, 26); this._gold.position.set(0, 0.5, 7); scene.add(this._gold);
    // fill from the camera so the resting face is ALWAYS clearly lit (fixes "can't tell which face is up")
    this._face = new THREE.PointLight(0xffffff, 0.5, 30); this._face.position.set(0, 0.6, 9.4); scene.add(this._face);

    // backdrop glow
    const bgTex = (function () { const Sz = 256, cv = document.createElement("canvas"); cv.width = cv.height = Sz; const x = cv.getContext("2d"); const g = x.createRadialGradient(Sz / 2, Sz * 0.42, 10, Sz / 2, Sz / 2, Sz * 0.62); g.addColorStop(0, "#241b52"); g.addColorStop(0.5, "#120a2a"); g.addColorStop(1, "#05060f"); x.fillStyle = g; x.fillRect(0, 0, Sz, Sz); return new THREE.CanvasTexture(cv); })();
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(46, 30), new THREE.MeshBasicMaterial({ map: bgTex, depthWrite: false })); bg.position.z = -7; scene.add(bg);

    this._buildEnv();
    this._buildCoin();

    // fx group + flash
    this.fx = new THREE.Group(); scene.add(this.fx);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(46, 30), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })); this.flash.position.z = 3; scene.add(this.flash);

    // ground shadow blob
    this._shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.1), new THREE.MeshBasicMaterial({ map: radialTexture([[0, "rgba(0,0,0,.55)"], [0.7, "rgba(0,0,0,.12)"], [1, "rgba(0,0,0,0)"]]), transparent: true, depthWrite: false }));
    this._shadow.rotation.x = -Math.PI / 2.1; this._shadow.position.set(0, -1.9, 0); scene.add(this._shadow);

    this.reset(HEADS);
    this.renderer.render(this.scene, this.cam);
  };

  // Procedural neon environment map (no HDRI) so the chrome samples cyan/magenta/gold as it turns.
  CoinFlip3D.prototype._buildEnv = function () {
    try {
      const Sz = 256, cv = document.createElement("canvas"); cv.width = cv.height = Sz; const x = cv.getContext("2d");
      const g = x.createLinearGradient(0, 0, 0, Sz);
      g.addColorStop(0, "#1a1430"); g.addColorStop(0.5, "#0a0820"); g.addColorStop(1, "#05060f"); x.fillStyle = g; x.fillRect(0, 0, Sz, Sz);
      const band = (y, col) => { const gg = x.createLinearGradient(0, y - 26, 0, y + 26); gg.addColorStop(0, "rgba(0,0,0,0)"); gg.addColorStop(0.5, col); gg.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = gg; x.fillRect(0, y - 26, Sz, 52); };
      band(Sz * 0.30, "#39e7ff"); band(Sz * 0.55, "#ff4d9d"); band(Sz * 0.74, "#ffd23f");
      x.fillStyle = "rgba(255,255,255,.9)"; x.beginPath(); x.arc(Sz * 0.5, Sz * 0.14, 26, 0, 7); x.fill();
      const tex = new THREE.CanvasTexture(cv); tex.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer); pmrem.compileEquirectangularShader();
      this._envRT = pmrem.fromEquirectangular(tex); this.scene.environment = this._envRT.texture;
      pmrem.dispose(); tex.dispose();
    } catch (e) { this._envRT = null; } // env map is a bonus; coin still renders without it
  };

  CoinFlip3D.prototype._buildCoin = function () {
    const env = this._envRT ? this._envRT.texture : null;
    const R = 1.62, T = 0.2;
    const coin = new THREE.Group(); this.coin = coin; this.scene.add(coin);
    // rim (high-metal, reflective) with a milled reeded edge
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xa9842a, metalness: 1.0, roughness: 0.24, envMap: env, envMapIntensity: 1.6 });
    rimMat.bumpMap = reededEdge(); rimMat.bumpScale = 0.012;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(R, R, T, 120, 1), rimMat); rim.rotation.x = Math.PI / 2; coin.add(rim);
    // bevel rings (catch light at the edges)
    const bevelMat = new THREE.MeshStandardMaterial({ color: 0xfff0b0, metalness: 1.0, roughness: 0.12, envMap: env, envMapIntensity: 1.8 });
    const bevelGeo = new THREE.TorusGeometry(R - 0.015, 0.045, 14, 72);
    const bvF = new THREE.Mesh(bevelGeo, bevelMat); bvF.position.z = T / 2 - 0.02; coin.add(bvF);
    const bvB = new THREE.Mesh(bevelGeo, bevelMat); bvB.position.z = -T / 2 + 0.02; coin.add(bvB);
    // faces (heads at +Z, tails at -Z) — lower metalness so the baked engraving survives;
    // a low emissive of the same map self-lights the raised lettering without a glow halo.
    const htex = faceTexture(HEADS), ttex = faceTexture(TAILS);
    const headsMat = new THREE.MeshStandardMaterial({ map: htex, emissive: 0xffffff, emissiveMap: htex, emissiveIntensity: 0.14, metalness: 0.55, roughness: 0.42, envMap: env, envMapIntensity: 0.85 });
    const tailsMat = new THREE.MeshStandardMaterial({ map: ttex, emissive: 0xffffff, emissiveMap: ttex, emissiveIntensity: 0.14, metalness: 0.55, roughness: 0.42, envMap: env, envMapIntensity: 0.85 });
    const faceGeo = new THREE.CircleGeometry(R - 0.05, 72);
    const heads = new THREE.Mesh(faceGeo, headsMat); heads.position.z = T / 2 + 0.001; coin.add(heads);
    const tails = new THREE.Mesh(faceGeo, tailsMat); tails.position.z = -(T / 2 + 0.001); tails.rotation.y = Math.PI; coin.add(tails);
  };

  /* ---------- public state ---------- */
  // group.rotation.x: 0 → heads faces camera (+Z); π → tails. Whole turns of 2π preserve the face.
  CoinFlip3D.prototype.reset = function (side) {
    this._side = side === TAILS ? TAILS : HEADS;
    this.phase = "idle"; this._spinVel = 0;
    this._spin = (this._side === TAILS ? Math.PI : 0);
    this.coin.position.set(0, 0.4, 0); this.coin.scale.set(1, 1, 1);
    this.coin.rotation.set(this._spin, 0, 0);
    this._gold.intensity = 0;
  };
  CoinFlip3D.prototype.toss = function () {
    this.phase = "anticip"; this._pt = 0; this._y0 = this.coin.position.y;
    this._spinVel = 9; this._gold.intensity = 0.15; this._apexFired = false;
    this._pendingLand = null;
  };
  CoinFlip3D.prototype.land = function (side, tier) {
    this._landSide = side === TAILS ? TAILS : HEADS; this._landTier = tier || "normal";
    if (this.phase === "anticip" || this.phase === "launch") { this._pendingLand = true; return; } // still rising → drop when it hangs
    this._startDrop();
  };
  CoinFlip3D.prototype._startDrop = function () {
    // choose a final rotation that's a forward multiple of 2π landing on the right face
    const want = this._landSide === TAILS ? Math.PI : 0;
    const turns = Math.ceil((this._spin + 4) / (2 * Math.PI)); // a few more spins
    this._spinEnd = turns * 2 * Math.PI + want;
    this._spinStart = this._spin; this.phase = "drop"; this._pt = 0;
    this._dropY0 = this.coin.position.y;
    // signature flash colour: gold = heads, cyan = tails (readable even peripherally)
    if (this._gold) this._gold.color.set(this._landSide === TAILS ? 0x49d8ff : 0xffd23f);
  };

  /* ---------- per-frame ---------- */
  CoinFlip3D.prototype._loop = function () {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now; this._t += dt;
    const c = this.coin, P = this.phase;

    if (P === "anticip") {
      this._pt += dt; const k = Math.min(1, this._pt / 0.18), e = 1 - Math.pow(1 - k, 2);
      c.position.y = 0.4 - 0.28 * e; c.scale.set(1 + 0.08 * e, 1 - 0.1 * e, 1 + 0.08 * e);
      if (k >= 1) { this.phase = "launch"; this._pt = 0; this._vy = 7.0; }
    } else if (P === "launch") {
      this._pt += dt; this._vy -= 13 * dt; c.position.y += this._vy * dt;
      c.position.z = Math.min(1.2, c.position.z + dt * 2.2);
      const sk = Math.min(1, this._pt / 0.12); c.scale.set(1 - 0.06 * (1 - sk), 1 + 0.06 * (1 - sk), 1 - 0.06 * (1 - sk));
      this._spinVel = Math.min(26, this._spinVel + 40 * dt); // accelerate the tumble
      if (this._vy <= 0.2) { this.phase = "hang"; this._pt = 0; if (!this._apexFired && this.onApex) { this._apexFired = true; try { this.onApex(); } catch (e) {} } }
    } else if (P === "hang") {
      this._pt += dt; this._spinVel = Math.max(9, this._spinVel - 14 * dt); // decelerate the spin = suspense
      c.position.y += Math.sin(this._t * 2) * 0.004; // gentle hover
      if (this._pendingLand) { this._pendingLand = false; this._startDrop(); }
    } else if (P === "drop") {
      this._pt += dt; const dur = 0.92, k = Math.min(1, this._pt / dur);
      // fall with two decaying bounces
      const fall = this._dropY0 + (0.4 - this._dropY0) * (1 - Math.pow(1 - k, 2));
      const bounce = 0.5 * Math.exp(-5 * k) * Math.abs(Math.cos(k * 16));
      c.position.y = fall + bounce; c.position.z = Math.max(0, c.position.z - dt * 2.2);
      // ease the spin onto the exact landing rotation
      const se = 1 - Math.pow(1 - k, 3); this._spin = this._spinStart + (this._spinEnd - this._spinStart) * se;
      c.rotation.x = this._spin;
      // settle wobble on Z
      c.rotation.z = (k > 0.5 ? 1 : 0) * 0.13 * Math.exp(-6 * (k - 0.5)) * Math.cos(22 * (k - 0.5));
      c.scale.set(1, 1, 1);
      if (k >= 1) {
        this.phase = "landed"; this._spin = this._spinEnd; this._landT = 0;
        c.rotation.set(this._spin - 0.14, 0, 0); // tip ~8° back so the winning face catches light, not edge-on
        this._punch(0.05);
        // bright specular pop on the resting face the instant it lands
        if (this._face) { this._face.intensity = 0.95; clearTimeout(this._faceT); this._faceT = setTimeout(function (f) { return function () { f.intensity = 0.5; }; }(this._face), 450); }
      }
      this._spinVel = 0;
    } else if (P === "landed") {
      // Hold a confident, flat, camera-facing PRESENT and grow slightly so the landed
      // face is unmistakable — the coin must always read clearly as HEADS or TAILS at rest.
      this._landT = (this._landT || 0) + dt;
      const e = 1 - Math.pow(1 - Math.min(1, this._landT / 0.45), 3);
      const sc = 1 + 0.12 * e; c.scale.set(sc, sc, sc);
      c.rotation.set(this._spinEnd - 0.14, 0, 0); // pin it flat to the camera (no drift / edge-on)
    }
    // free spin (anticip/launch/hang) about the X axis
    if (P === "anticip" || P === "launch" || P === "hang") { this._spin += this._spinVel * dt; c.rotation.x = this._spin; c.rotation.y = this._spin * 0.08; }

    // shadow tracks height (tightens + dims when airborne)
    const air = Math.max(0, c.position.y - 0.4);
    this._shadow.scale.set(Math.max(0.4, 1 - air * 0.12), Math.max(0.4, 1 - air * 0.12), 1);
    this._shadow.material.opacity = Math.max(0.12, 0.5 - air * 0.05);

    // gold light eases toward target during celebration, else off
    this._gold.intensity += ((this._goldTarget || 0) - this._gold.intensity) * Math.min(1, dt * 8);

    // coins
    for (let i = this._coins.length - 1; i >= 0; i--) { const o = this._coins[i]; o.t += dt; o.vy -= 9 * dt; o.s.position.x += o.vx * dt; o.s.position.y += o.vy * dt; o.s.material.rotation += o.vr * dt; o.s.material.opacity = Math.max(0, 1 - o.t / o.life); if (o.t >= o.life || o.s.position.y < -3) { this.fx.remove(o.s); o.s.material.dispose(); this._coins.splice(i, 1); } }
    // rings
    for (let i = this._rings.length - 1; i >= 0; i--) { const r = this._rings[i]; r.t += dt; const k = Math.min(1, r.t / r.life); const sc = 0.5 + k * r.max; r.s.scale.set(sc, sc, 1); r.s.material.opacity = (1 - k) * 0.8; if (k >= 1) { this.fx.remove(r.s); r.s.material.dispose(); this._rings.splice(i, 1); } }
    // flash decay
    if (this.flash.material.opacity > 0.01) this.flash.material.opacity *= 0.9; else this.flash.material.opacity = 0;

    // camera parallax + shake
    this._shake *= 0.86; if (this._shake < 0.003) this._shake = 0;
    this.cam.position.x = Math.sin(this._t * 0.4) * 0.14 + (Math.random() - 0.5) * this._shake;
    this.cam.position.y = 0.3 + (Math.random() - 0.5) * this._shake; this.cam.lookAt(0, 0.5, 0);

    this.renderer.render(this.scene, this.cam);
  };
  CoinFlip3D.prototype._punch = function (a) { this._shake = Math.max(this._shake, a); };

  /* ---------- celebration ---------- */
  CoinFlip3D.prototype._spawnCoin = function (spread) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._coinTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const s = 0.32 + Math.random() * 0.34; sp.scale.set(s, s, s);
    sp.position.set((Math.random() - 0.5) * (spread || 4), 1 + Math.random() * 1.5, 1.6);
    this.fx.add(sp); this._coins.push({ s: sp, vx: (Math.random() - 0.5) * 4, vy: 1.5 + Math.random() * 4, vr: (Math.random() - 0.5) * 6, life: 1.1 + Math.random() * 0.8, t: 0 });
  };
  CoinFlip3D.prototype._ring = function (color, max) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._glowTex, color: color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sp.position.set(0, 0.5, 1.4); sp.scale.set(0.5, 0.5, 1); this.fx.add(sp); this._rings.push({ s: sp, t: 0, life: 0.55, max: max || 5 });
  };
  CoinFlip3D.prototype.celebrate = function (tier) {
    tier = tier || "normal";
    const n = tier === "mega" ? 52 : tier === "big" ? 26 : 12;
    for (let i = 0; i < n; i++) this._spawnCoin(tier === "mega" ? 6 : 4);
    this._ring(0xffd23f, tier === "mega" ? 7 : tier === "big" ? 5 : 3.5);
    if (tier === "mega") { this._ring(0xffffff, 9); this._ring(0xff4d9d, 6); }
    this.flash.material.color.set(0xffe9a8); this.flash.material.opacity = tier === "mega" ? 0.4 : tier === "big" ? 0.26 : 0.16;
    this._goldTarget = tier === "mega" ? 1.7 : tier === "big" ? 1.15 : 0.7;
    this._punch(tier === "mega" ? 0.09 : tier === "big" ? 0.05 : 0.03);
    clearTimeout(this._goldT); this._goldT = setTimeout(() => { this._goldTarget = 0; }, tier === "mega" ? 1600 : 900);
  };
  CoinFlip3D.prototype.lose = function () {
    this._mag.color.set(0xff3b3b); clearTimeout(this._loseT);
    this._loseT = setTimeout(() => { this._mag.color.set(0xff4d9d); }, 260);
    this._punch(0.02);
  };

  /* ---------- host bridge ---------- */
  CoinFlip3D.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
    else { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }
  };
  CoinFlip3D.prototype.resize = function (w, h) { this.W = w; this.H = h; this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); this.renderer.setSize(w, h, false); };

  root.CoinFlip3D = CoinFlip3D;
})(typeof globalThis !== "undefined" ? globalThis : this);
