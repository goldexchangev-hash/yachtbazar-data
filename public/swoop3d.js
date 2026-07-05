/* ============================================================
   swoop3d.js — "SKY SWOOP": a 3D biplane CRASH casino game rendered with
   PlayCanvas (engine-only, vendored, no build step) for the TV.

   MONEY/ODDS reuse the audited CrashEngine (crash-engine.js) UNCHANGED, so the
   house edge is identical to the Crash game (provably-fair Bustabit distribution,
   1% edge). The flying is purely cosmetic: at launch a bust multiplier is drawn
   (CrashEngine.crashFromRandom), the biplane climbs while the multiplier rises
   (multiplierAtMs), the player taps CASH OUT to bank mult×bet; if the multiplier
   reaches the bust point first the engine cuts and the plane dives = lose. Skill
   never affects EV.

   Phase S1 (this commit): the sky / floating-island / biplane scene + chase camera.
   Crash mechanic + controls added in later phases. Our own procedural art — no
   third-party (SWOOOP) assets.

   Host bridge mirrors the other games:
     new SwoopGame({ mount, els, width, height, ethUsd, initialBalance,
                     onBalance, onWin })
   ============================================================ */
(function (root) {
  "use strict";
  var pc = root.pc, CE = root.CrashEngine;
  var MIN_BET = 10, MAX_BET = 1000;
  var CRASH_EDGE = 0.01;
  var BASE_ALT = 13, CLIMB_HEIGHT = 52, DISPLAY_MAX = 24; // altitude/feel mapping for the climb (well above the island)
  var R_OUT = 14, R_IN = 6;                               // spiral radius: wide at takeoff → tight at altitude

  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  function rgb(hex) { return new pc.Color((hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255); }

  function SwoopGame(opts) {
    opts = opts || {};
    this.els = opts.els || {};
    this.mount = opts.mount;
    this.W = opts.width || 960; this.H = opts.height || 600;
    this.ethUsd = opts.ethUsd || 3400;
    this.onBalance = opts.onBalance || null;
    this.onWin = opts.onWin || null;
    this.onState = opts.onState || null;   // (stateObj) → host dock/preview updates the button
    this.onTick = opts.onTick || null;     // (mult) → live multiplier readout while climbing
    this.balance = opts.initialBalance != null ? opts.initialBalance : 5000;
    this.unitBet = MIN_BET;
    this._active = false; this._enabled = true; this._started = false;

    this._t = 0;
    this._clouds = [];
    this._trees = [];

    // ── crash round state (money rides the audited CrashEngine; edge untouched) ──
    this._state = "idle";       // idle | climbing | cashed | crashed
    this._mult = 1; this._bustMult = 0; this._bet = 0; this._roundMs = 0;
    this._won = 0; this._climb01 = 0; this._stateT = 0;
    this._planeAngle = 0; this._planeY = BASE_ALT; this._diveVy = 0;
    this._headX = 0; this._headZ = 1;   // smoothed yaw-only camera heading
    this._baseFov = 62; this._K = (CE && CE.DEFAULT_K) || 0.0001;

    // FX pools (cosmetic only — never touch the money) + audio cadence
    this._contrail = []; this._gems = []; this._trailT = 0; this._gemSpawnT = 0; this._tickT = 0;
    this._sndOn = true;

    this._initApp();
    this._buildSky();
    this._buildIsland();
    this._buildClouds();
    this._buildPlane();
    this._buildFx();
  }

  /* ---------- helpers ---------- */
  SwoopGame.prototype._mat = function (diffuseHex, emissiveHex, o) {
    o = o || {};
    var m = new pc.StandardMaterial();
    m.diffuse = rgb(diffuseHex);
    if (emissiveHex != null) { m.emissive = rgb(emissiveHex); m.emissiveIntensity = o.emi != null ? o.emi : 1; }
    if (o.opacity != null) { m.opacity = o.opacity; m.blendType = o.additive ? pc.BLEND_ADDITIVE : pc.BLEND_NORMAL; m.depthWrite = o.depthWrite != null ? o.depthWrite : !o.additive; }
    if (o.gloss != null) m.gloss = o.gloss;
    if (o.metalness != null) m.metalness = o.metalness;
    if (o.useLighting === false) m.useLighting = false;
    if (o.cull != null) m.cull = o.cull;
    m.update();
    return m;
  };
  SwoopGame.prototype._prim = function (type, mat, parent) {
    var e = new pc.Entity();
    e.addComponent("render", { type: type, material: mat, castShadows: false });
    (parent || this.app.root).addChild(e);
    return e;
  };

  /* ---------- app / camera / lights ---------- */
  SwoopGame.prototype._initApp = function () {
    var self = this;
    var canvas = document.createElement("canvas");
    canvas.style.width = "100%"; canvas.style.height = "100%"; canvas.style.display = "block"; canvas.style.touchAction = "none";
    if (this.mount) this.mount.appendChild(canvas);
    this.canvas = canvas;

    var app = new pc.Application(canvas, {
      mouse: pc.Mouse ? new pc.Mouse(canvas) : null,
      touch: pc.TouchDevice ? new pc.TouchDevice(canvas) : null,
      // antialias OFF: CameraFrame renders to an offscreen AA target (don't pay twice)
      graphicsDeviceOptions: { antialias: false, alpha: false, preferWebGl2: true },
    });
    this.app = app;
    // FILL_WINDOW + RESOLUTION_AUTO = the canvas always fills its container at the
    // device pixel ratio; combined with _resize() on orientationchange this gives a
    // correct full-bleed view in portrait AND landscape, on phones + tablets.
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);

    // one sky color reused for clear color + fog so the horizon dissolves seamlessly
    var SKY = new pc.Color(0.55, 0.76, 0.92); this._sky = SKY;

    // ── low-poly "studio" atmosphere ──
    app.scene.ambientLight = new pc.Color(0.40, 0.42, 0.47);   // lifted ambient floor = soft, premium
    if ("exposure" in app.scene) app.scene.exposure = 1.05;
    if (app.scene.fog && typeof app.scene.fog === "object") {
      app.scene.fog.type = pc.FOG_LINEAR; app.scene.fog.color = SKY.clone();
      app.scene.fog.start = 45; app.scene.fog.end = 230;
    }

    var cam = new pc.Entity("camera");
    cam.addComponent("camera", { clearColor: SKY.clone(), fov: 62, nearClip: 0.1, farClip: 700 });
    app.root.addChild(cam);
    this.camera = cam;

    // ── 3-light rig: warm KEY + cool FILL (the friendly flat-shaded feel) ──
    var key = new pc.Entity("key");
    key.addComponent("light", { type: "directional", color: new pc.Color(1.0, 0.93, 0.78), intensity: 1.7, castShadows: false });
    key.setLocalEulerAngles(52, 28, 0); app.root.addChild(key);
    var fill = new pc.Entity("fill");
    fill.addComponent("light", { type: "directional", color: new pc.Color(0.62, 0.74, 0.95), intensity: 0.5, castShadows: false });
    fill.setLocalEulerAngles(28, 210, 0); app.root.addChild(fill);

    // ── post-fx: bloom + ACES tonemap + vignette + grading (engine-native CameraFrame) ──
    try {
      var cf = new pc.CameraFrame(app, cam.camera);
      cf.rendering.toneMapping = pc.TONEMAP_ACES;
      try { cf.rendering.renderFormats = [pc.PIXELFORMAT_RGBA16F]; } catch (e) {}  // HDR so emissives bloom
      cf.bloom.intensity = 0.025; cf.bloom.blurLevel = 16;                          // tasteful, 0..0.1 range
      if (cf.grading) { cf.grading.enabled = true; cf.grading.saturation = 1.12; cf.grading.contrast = 1.05; }
      if (cf.vignette) { cf.vignette.intensity = 0.24; cf.vignette.inner = 0.55; cf.vignette.outer = 1.1; }
      cf.update();                                                                  // REQUIRED after any change
      this.cameraFrame = cf;
    } catch (e) {
      try { cam.camera.toneMapping = pc.TONEMAP_ACES; } catch (e2) {}
      if (root.console) console.warn("[swoop] CameraFrame unavailable, fell back to camera tonemap:", e.message);
    }

    // ── responsive: keep canvas + framing correct on resize / orientation change ──
    this._resize();
    var onResize = function () { self._resize(); };
    window.addEventListener("resize", onResize);
    // mobile orientation flips settle late — re-sync a couple of times after the event
    window.addEventListener("orientationchange", function () { setTimeout(onResize, 60); setTimeout(onResize, 350); });

    // chase camera follows at the END of _update (after the plane has moved this frame)
    this._camCur = cam.getPosition().clone();
    this._tmpV = new pc.Vec3();
    app.on("update", this._update, this);
  };

  // Resize the canvas to its container and pick an aspect-aware FOV:
  //  • landscape (phone/tablet turned sideways) → HORIZONTAL fov = a wide view
  //  • portrait → VERTICAL fov so the climb (altitude = multiplier) stays framed
  SwoopGame.prototype._resize = function () {
    if (!this.app) return;
    try { this.app.resizeCanvas(); } catch (e) {}
    var gd = this.app.graphicsDevice;
    var aspect = (gd.width || 1) / Math.max(1, gd.height || 1);
    var cam = this.camera && this.camera.camera;
    if (!cam) return;
    if (aspect >= 1) { cam.horizontalFov = true; this._baseFov = 78; }   // wide landscape
    else { cam.horizontalFov = false; this._baseFov = 64; }              // tall portrait
    if (this._state !== "climbing") cam.fov = this._baseFov;             // climb feel owns fov mid-round
  };

  /* ---------- sky dome + sun disc ---------- */
  SwoopGame.prototype._buildSky = function () {
    // big inverted sphere as a soft gradient dome (emissive, unlit, culled to inside)
    var domeMat = this._mat(0x8fd0ff, 0x9bd6ff, { emi: 0.9, useLighting: false, cull: pc.CULLFACE_FRONT });
    var dome = this._prim("sphere", domeMat);
    dome.setLocalScale(360, 360, 360);
    this._dome = dome;
    // warm sun disc
    var sunMat = this._mat(0xfff6d0, 0xfff0b0, { emi: 1.4, useLighting: false });
    var disc = this._prim("sphere", sunMat);
    disc.setLocalScale(7, 7, 7);
    disc.setPosition(-40, 38, -90);
  };

  /* ---------- floating magical island ---------- */
  SwoopGame.prototype._buildIsland = function () {
    var root3 = new pc.Entity("island"); this.app.root.addChild(root3); this._island = root3;
    root3.setPosition(0, -4, 0);

    // grass top
    var grass = this._prim("cylinder", this._mat(0x57c14e, 0x2e6e2a, { emi: 0.25 }), root3);
    grass.setLocalScale(18, 1.4, 18);
    grass.setPosition(0, 0, 0);
    // sandy rim
    var rim = this._prim("cylinder", this._mat(0xe8d49a, 0x8a7a44, { emi: 0.2 }), root3);
    rim.setLocalScale(19.2, 1.0, 19.2);
    rim.setPosition(0, -0.4, 0);
    // rocky underside (floating-island cone pointing down)
    var rock = this._prim("cone", this._mat(0x6b5640, 0x2e2418, { emi: 0.2 }), root3);
    rock.setLocalScale(16, 16, 16);
    rock.setPosition(0, -8.5, 0);
    rock.setEulerAngles(180, 0, 0);

    // hills
    for (var h = 0; h < 4; h++) {
      var hill = this._prim("sphere", this._mat([0x4fae46, 0x46a83e, 0x57c14e][h % 3], 0x2e6e2a, { emi: 0.2 }), root3);
      var s = rand(3, 6);
      hill.setLocalScale(s, s * 0.7, s);
      hill.setPosition(rand(-9, 9), 0.6, rand(-9, 9));
    }
    // a little lighthouse/tower for a landmark
    var tower = this._prim("cylinder", this._mat(0xf5f5f5, 0xbfc6cc, { emi: 0.2 }), root3);
    tower.setLocalScale(1.4, 4, 1.4); tower.setPosition(5, 3, -3);
    var towerTop = this._prim("cone", this._mat(0xe23b3b, 0x7a1414, { emi: 0.3 }), root3);
    towerTop.setLocalScale(2, 1.6, 2); towerTop.setPosition(5, 5.6, -3);

    // trees (trunk + foliage) scattered on the grass
    for (var t = 0; t < 12; t++) {
      var tx = rand(-8.5, 8.5), tz = rand(-8.5, 8.5);
      if (Math.hypot(tx - 5, tz + 3) < 3) continue; // keep clear of tower
      var trunk = this._prim("cylinder", this._mat(0x7a5230, 0x3a2614, { emi: 0.15 }), root3);
      trunk.setLocalScale(0.4, 1.6, 0.4); trunk.setPosition(tx, 1.4, tz);
      var fol = this._prim("cone", this._mat([0x2f8f3a, 0x3aa84a, 0x277a32][t % 3], 0x16451d, { emi: 0.2 }), root3);
      var fs = rand(1.6, 2.6);
      fol.setLocalScale(fs, fs * 1.6, fs); fol.setPosition(tx, 2.8, tz);
    }
  };

  /* ---------- drifting clouds (clusters of squashed spheres) ---------- */
  SwoopGame.prototype._buildClouds = function () {
    var cloudMat = this._mat(0xffffff, 0xf0f6ff, { emi: 0.45, opacity: 0.96 });
    this._cloudMat = cloudMat;
    for (var c = 0; c < 12; c++) {
      var grp = new pc.Entity(); this.app.root.addChild(grp);
      var puffs = 3 + (Math.random() * 3 | 0);
      for (var p = 0; p < puffs; p++) {
        var puff = this._prim("sphere", cloudMat, grp);
        var s = rand(2.2, 4.2);
        puff.setLocalScale(s * 1.4, s * 0.8, s);
        puff.setPosition(rand(-3, 3), rand(-0.6, 0.6), rand(-2, 2));
      }
      var ang = rand(0, 6.28), r = rand(22, 55);
      grp.setPosition(Math.cos(ang) * r, rand(4, 22), Math.sin(ang) * r);
      this._clouds.push({ e: grp, ang: ang, r: r, y: grp.getPosition().y, spd: rand(0.01, 0.04) });
    }
  };

  /* ---------- the biplane (built nose toward -Z so lookAt() faces travel) ---------- */
  SwoopGame.prototype._buildPlane = function () {
    var plane = new pc.Entity("plane"); this.app.root.addChild(plane); this._plane = plane;

    var bodyMat = this._mat(0xe23b3b, 0x5a0e0e, { emi: 0.25, gloss: 50 });
    var creamMat = this._mat(0xf3e6c0, 0x8a7c54, { emi: 0.2 });
    var darkMat = this._mat(0x202833, 0x05070a, { emi: 0.2 });
    var goldMat = this._mat(0xffd23f, 0x7a5400, { emi: 0.4, gloss: 80 });

    // fuselage (long along Z)
    var fus = this._prim("capsule", bodyMat, plane);
    fus.setLocalScale(0.55, 1.25, 0.55); fus.setEulerAngles(90, 0, 0);
    // nose engine cowl
    var cowl = this._prim("cylinder", goldMat, plane);
    cowl.setLocalScale(0.62, 0.3, 0.62); cowl.setEulerAngles(90, 0, 0); cowl.setPosition(0, 0, -1.25);
    // spinner + propeller (spins about Z)
    var prop = new pc.Entity("prop"); plane.addChild(prop); prop.setPosition(0, 0, -1.45); this._prop = prop;
    var bladeMat = this._mat(0x14181f, 0x05070a, { emi: 0.1 });
    var bladeA = this._prim("box", bladeMat, prop); bladeA.setLocalScale(0.12, 2.4, 0.06);
    var bladeB = this._prim("box", bladeMat, prop); bladeB.setLocalScale(2.4, 0.12, 0.06);
    var hub = this._prim("sphere", goldMat, prop); hub.setLocalScale(0.22, 0.22, 0.22);
    // top + bottom wings (span along X)
    var top = this._prim("box", creamMat, plane); top.setLocalScale(3.6, 0.09, 0.78); top.setPosition(0, 0.62, -0.05);
    var bot = this._prim("box", creamMat, plane); bot.setLocalScale(3.3, 0.09, 0.72); bot.setPosition(0, -0.18, 0.05);
    // struts connecting the wings
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var strutF = this._prim("box", darkMat, plane); strutF.setLocalScale(0.07, 0.82, 0.07); strutF.setPosition(sgn * 1.15, 0.22, -0.2);
      var strutB = this._prim("box", darkMat, plane); strutB.setLocalScale(0.07, 0.82, 0.07); strutB.setPosition(sgn * 1.15, 0.22, 0.25);
    }
    // cockpit
    var pit = this._prim("sphere", darkMat, plane); pit.setLocalScale(0.42, 0.4, 0.5); pit.setPosition(0, 0.34, 0.35);
    // tail fin + horizontal stabilizer
    var fin = this._prim("box", bodyMat, plane); fin.setLocalScale(0.09, 0.7, 0.55); fin.setPosition(0, 0.35, 1.15);
    var stab = this._prim("box", creamMat, plane); stab.setLocalScale(1.5, 0.08, 0.5); stab.setPosition(0, 0.1, 1.2);
    // wheels
    for (var w = -1; w <= 1; w += 2) {
      var wheel = this._prim("cylinder", darkMat, plane); wheel.setLocalScale(0.5, 0.08, 0.5); wheel.setEulerAngles(0, 0, 90); wheel.setPosition(w * 0.6, -0.7, -0.3);
    }
  };

  /* ---------- per-frame ---------- */
  SwoopGame.prototype._update = function (dt) {
    if (!this._active) return;
    dt = Math.min(0.05, dt);
    this._t += dt; this._stateT += dt;

    if (this._prop) this._prop.rotateLocal(0, 0, 1600 * dt);

    // clouds drift slowly around
    for (var c = 0; c < this._clouds.length; c++) {
      var cl = this._clouds[c]; cl.ang += cl.spd * dt; cl.e.setPosition(Math.cos(cl.ang) * cl.r, cl.y, Math.sin(cl.ang) * cl.r);
    }

    if (this._state === "climbing") {
      this._roundMs += dt * 1000;
      this._mult = Math.max(1, CE.multiplierAtMs(this._roundMs, this._K));   // cosmetic rising curve
      if (this._mult >= this._bustMult) { this._bust(); }                    // pre-decided bust point reached
      else {
        this._climb01 = clamp(Math.log(this._mult) / Math.log(DISPLAY_MAX), 0, 1);
        this._flyClimb(dt, this._climb01);
        this._applyClimbFeel(this._climb01);
        if (this.onTick) { try { this.onTick(this._mult); } catch (e) {} }
        // juice: exhaust contrail + streaming gems + an accelerating tension tick
        this._trailT -= dt; if (this._trailT <= 0) { this._trailT = 0.03; this._emitTrail(0.45 + this._climb01 * 0.55); }
        this._gemSpawnT -= dt; if (this._gemSpawnT <= 0) { this._gemSpawnT = rand(0.45, 0.8); this._spawnGem(); }
        this._tickT -= dt; if (this._tickT <= 0) { this._tickT = lerp(0.55, 0.09, this._climb01); this._snd("blip"); }
      }
    } else if (this._state === "crashed") {
      this._flyDive(dt);
      this._trailT -= dt; if (this._trailT <= 0) { this._trailT = 0.02; this._emitTrail(0.9); } // smoke plume
      if (this._stateT > 1.7) this._reset();
    } else if (this._state === "cashed") {
      this._flyGlide(dt);
      this._trailT -= dt; if (this._trailT <= 0) { this._trailT = 0.05; this._emitTrail(0.5); }
      if (this._stateT > 1.7) this._reset();
    } else {
      this._flyIdle(dt);
    }

    this._updateFx(dt);
    this._postUpdate(dt);   // chase the plane after it has moved this frame
  };

  /* ---------- flight states (plane motion only; camera follows in postupdate) ---------- */
  SwoopGame.prototype._aim = function (px, py, pz, lx, ly, lz, bank, pitch) {
    var p = this._plane; p.setPosition(px, py, pz); p.lookAt(lx, ly, lz);
    if (pitch || bank) p.rotateLocal(pitch || 0, 0, bank || 0);
    this._planeY = py;
  };
  SwoopGame.prototype._flyIdle = function (dt) {
    this._planeAngle += dt * 0.45;
    var a = this._planeAngle, R = R_OUT, y = BASE_ALT + Math.sin(this._t * 0.6) * 0.8, na = a + 0.2;
    this._aim(Math.cos(a) * R, y, Math.sin(a) * R, Math.cos(na) * R, y + 0.1, Math.sin(na) * R, -16, 3);
  };
  SwoopGame.prototype._flyClimb = function (dt, c01) {
    this._planeAngle += dt * (0.55 + c01 * 0.7);                 // swoops faster the higher it goes
    var a = this._planeAngle, R = lerp(R_OUT, R_IN, c01), y = BASE_ALT + c01 * CLIMB_HEIGHT;
    var na = a + 0.18, nR = lerp(R_OUT, R_IN, clamp(c01 + 0.05, 0, 1));
    this._aim(Math.cos(a) * R, y, Math.sin(a) * R, Math.cos(na) * nR, y + 1.0 + c01 * 1.6, Math.sin(na) * nR, -24 - c01 * 8, 6 + c01 * 10);
  };
  SwoopGame.prototype._flyGlide = function (dt) {                // after a cash-out: level off, gentle climb away (keep it framed)
    this._planeAngle += dt * 0.45;
    var a = this._planeAngle, R = lerp(R_OUT, R_IN, this._climb01) + this._stateT * 1.2, y = this._planeY + dt * 1.0, na = a + 0.18;
    this._aim(Math.cos(a) * R, y, Math.sin(a) * R, Math.cos(na) * R, y + 0.4, Math.sin(na) * R, -12, 2);
  };
  SwoopGame.prototype._flyDive = function (dt) {                 // bust: nose hard down, plummet + tumble
    this._diveVy += 40 * dt;
    var p = this._plane.getPosition(), ny = p.y - this._diveVy * dt;
    this._planeAngle += dt * 1.3;
    var a = this._planeAngle, R = Math.max(2, 7 - this._stateT * 2.2);
    this._aim(Math.cos(a) * R, ny, Math.sin(a) * R, Math.cos(a) * R, ny - 3, Math.sin(a) * R, 30, 72);
  };

  // climb feel: widen FOV + push the fog out so the world reads faster/clearer as you climb
  SwoopGame.prototype._applyClimbFeel = function (c01) {
    var cam = this.camera && this.camera.camera; if (cam) cam.fov = this._baseFov + c01 * 16;
    var fog = this.app.scene.fog;
    if (fog && typeof fog === "object") { fog.start = 45 + c01 * 35; fog.end = 230 + c01 * 170; }
  };

  /* ---------- chase camera (frame-rate-independent, yaw-only so the horizon stays level) ---------- */
  SwoopGame.prototype._postUpdate = function (dt) {
    if (!this._active || !this._camCur) return;
    dt = Math.min(0.05, dt);
    var p = this._plane.getPosition(), f = this._plane.forward;
    var l = Math.hypot(f.x, f.z);
    if (l > 0.25) { this._headX = f.x / l; this._headZ = f.z / l; }   // ignore pitch/roll (e.g. during a dive)
    var dist = 12, height = 5;
    this._tmpV.set(p.x - this._headX * dist, p.y + height, p.z - this._headZ * dist);
    var k = 1 - Math.pow(1 - 0.90, dt);                              // FPS-independent damping
    this._camCur.lerp(this._camCur, this._tmpV, k);
    this.camera.setPosition(this._camCur);
    this.camera.lookAt(p.x, p.y + 1.2, p.z);
  };

  /* ---------- round lifecycle (money on the audited CrashEngine — edge untouched) ---------- */
  SwoopGame.prototype._emitState = function () {
    if (this.onState) { try { this.onState({ state: this._state, mult: this._mult, bet: this._bet, balance: this.balance, won: this._won, bust: (this._state === "crashed" ? this._bustMult : 0) }); } catch (e) {} }
  };
  SwoopGame.prototype._save = function () { if (this.onBalance) { try { this.onBalance(this.balance); } catch (e) {} } };

  SwoopGame.prototype.launch = function () {
    if (!this._active || !this._enabled || this._state !== "idle") return false;
    var bet = this.unitBet;
    if (this.balance < bet) { this._emitState(); return false; }
    this.balance = Math.round((this.balance - bet) * 100) / 100; this._save();     // stake locked
    this._bet = bet; this._won = 0; this._roundMs = 0; this._mult = 1; this._climb01 = 0; this._diveVy = 0; this._stateT = 0; this._tickT = 0.3;
    // provably-fair-ready bust point from the audited engine (1% edge). Demo uses Math.random
    // exactly like the 2D Crash demo; on-chain hash settlement is a later pass.
    this._bustMult = CE.crashFromRandom(Math.random, CRASH_EDGE);
    this._state = "climbing"; this._snd("swoosh", 750); this._emitState();
    return true;
  };
  SwoopGame.prototype.cashOut = function () {
    if (this._state !== "climbing") return false;
    var m = this._mult;                                  // < bustMult (bust flips state first, in _update)
    var payout = Math.round(this._bet * m * 100) / 100;
    this.balance = Math.round((this.balance + payout) * 100) / 100; this._won = payout; this._save();
    this._state = "cashed"; this._stateT = 0;
    // tiered fanfare scaled to the multiplier + a celebratory gem fountain
    this._snd(m >= 10 ? "jackpot" : m >= 5 ? "bigwin" : "win");
    var pp = this._plane.getPosition(); this._burstGems(pp.x, pp.y, pp.z, Math.min(30, 8 + Math.round(m * 2)));
    if (this.cameraFrame && this.cameraFrame.bloom) { try { this.cameraFrame.bloom.intensity = 0.055; this.cameraFrame.update(); } catch (e) {} }
    if (this.onWin) { try { this.onWin({ profitUsd: Math.round((payout - this._bet) * 100) / 100, mult: m, bonus: m >= 10 }); } catch (e) {} }
    this._emitState();
    return true;
  };
  SwoopGame.prototype._bust = function () {
    this._state = "crashed"; this._stateT = 0; this._diveVy = 5; this._won = 0;
    this._snd("lose"); this._snd("balloonPop", 0.85);     // engine cuts + impact boom
    var pp = this._plane.getPosition(); this._burstGems(pp.x, pp.y, pp.z, 6);
    if (this.cameraFrame && this.cameraFrame.vignette) { try { this.cameraFrame.vignette.color = new pc.Color(0.7, 0.05, 0.05); this.cameraFrame.vignette.intensity = 0.7; this.cameraFrame.update(); } catch (e) {} }
    this._emitState();
  };
  SwoopGame.prototype._reset = function () {
    this._state = "idle"; this._stateT = 0; this._mult = 1; this._climb01 = 0;
    if (this.cameraFrame) { try { if (this.cameraFrame.vignette) { this.cameraFrame.vignette.color = new pc.Color(0, 0, 0); this.cameraFrame.vignette.intensity = 0.24; } if (this.cameraFrame.bloom) this.cameraFrame.bloom.intensity = 0.025; this.cameraFrame.update(); } catch (e) {} }
    var fog = this.app.scene.fog; if (fog && typeof fog === "object") { fog.start = 45; fog.end = 230; }
    var cam = this.camera && this.camera.camera; if (cam) cam.fov = this._baseFov;
    this._emitState();
  };

  /* ---------- audio: hook the shared procedural Chiptune synth (no 2nd AudioContext) ---------- */
  SwoopGame.prototype._snd = function (fn, arg) {
    if (!this._sndOn) return;
    var C = root.Chiptune; if (C && typeof C[fn] === "function") { try { C[fn](arg); } catch (e) {} }
  };
  // select the "Sunrise Skyway" track for this channel — does NOT auto-start music
  // (house rule: music plays only on the Music button); just the preference.
  SwoopGame.prototype._preferMusic = function () { var C = root.Chiptune; if (C && C.playTrack) { try { C.playTrack("skyway"); } catch (e) {} } };

  /* ---------- FX: world-space contrail, streaming gems, bursts (COSMETIC; no money effect) ---------- */
  SwoopGame.prototype._buildFx = function () {
    this._trailMat = this._mat(0xffffff, 0xeaf4ff, { opacity: 0.55, additive: true, useLighting: false });
    this._gemMats = [
      this._mat(0xffd23f, 0xffd23f, { emi: 2.6, gloss: 0.9 }),   // gold — emissive bloom-bait
      this._mat(0x21d4ff, 0x21d4ff, { emi: 2.6, gloss: 0.9 }),   // cyan
      this._mat(0xff5db0, 0xff5db0, { emi: 2.4, gloss: 0.9 }),   // magenta
    ];
  };
  // additive puff that scales 0→max→0 over its life (no alpha pop without per-puff materials)
  SwoopGame.prototype._spawnPuff = function (x, y, z, scN, life, vy) {
    var pool = this._contrail, rec = null, i;
    for (i = 0; i < pool.length; i++) { if (pool[i].dead) { rec = pool[i]; break; } }
    if (!rec) {
      if (pool.length >= 80) { rec = pool[(this._t * 7 | 0) % pool.length]; }   // recycle oldest-ish
      else { rec = { e: this._prim("sphere", this._trailMat), dead: true }; pool.push(rec); }
    }
    rec.dead = false; rec.t = 0; rec.life = life; rec.scN = scN; rec.vy = vy || 0;
    rec.e.enabled = true; rec.e.setLocalScale(0.01, 0.01, 0.01); rec.e.setPosition(x, y, z);
  };
  SwoopGame.prototype._spawnGem = function () {
    var live = 0, i; for (i = 0; i < this._gems.length; i++) if (!this._gems[i].burst) live++;
    if (live > 10) return;
    var a = this._planeAngle + rand(0.6, 1.9), R = lerp(R_OUT, R_IN, this._climb01) + rand(-2, 3), y = this._planeY + rand(1, 8);
    var e = this._prim("cone", this._gemMats[(Math.random() * this._gemMats.length) | 0]);
    var s = rand(0.4, 0.7); e.setLocalScale(s, s * 1.7, s);
    var x = Math.cos(a) * R, z = Math.sin(a) * R; e.setPosition(x, y, z);
    this._gems.push({ e: e, x: x, baseY: y, z: z, spin: rand(2, 5), ph: rand(0, 6.28), collected: false, burst: false, t: 0 });
  };
  SwoopGame.prototype._burstGems = function (x, y, z, n) {
    for (var i = 0; i < n; i++) {
      var e = this._prim("cone", this._gemMats[i % this._gemMats.length]);
      var ang = rand(0, 6.28), sp = rand(3, 9);
      var s = rand(0.3, 0.6); e.setLocalScale(s, s * 1.6, s); e.setPosition(x, y, z);
      this._gems.push({ e: e, x: x, y: y, z: z, vx: Math.cos(ang) * sp, vy: rand(3, 8), vz: Math.sin(ang) * sp, spin: rand(5, 11), t: 0, life: rand(0.7, 1.2), burst: true });
    }
  };
  SwoopGame.prototype._updateFx = function (dt) {
    var i, p = this._plane.getPosition();
    // contrail puffs
    for (i = 0; i < this._contrail.length; i++) {
      var pf = this._contrail[i]; if (pf.dead) continue;
      pf.t += dt; var k = pf.t / pf.life;
      if (k >= 1) { pf.dead = true; pf.e.enabled = false; continue; }
      var sc = Math.sin(k * Math.PI) * pf.scN;
      pf.e.setLocalScale(sc, sc, sc);
      if (pf.vy) { var pp = pf.e.getPosition(); pf.e.setPosition(pp.x, pp.y + pf.vy * dt, pp.z); }
    }
    // gems (floating collectibles + burst bits)
    for (i = this._gems.length - 1; i >= 0; i--) {
      var g = this._gems[i]; g.t += dt;
      if (g.burst) {
        g.vy -= 13 * dt; g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
        g.e.setPosition(g.x, g.y, g.z); g.e.rotateLocal(0, g.spin * 60 * dt, 0);
        var bk = g.t / g.life; if (bk < 1) { var bs = (0.5 * (1 - bk) + 0.5); g.e.setLocalScale(0.45 * bs, 0.7 * bs, 0.45 * bs); }
        if (g.t >= g.life) { this.app.root.removeChild(g.e); g.e.destroy(); this._gems.splice(i, 1); }
        continue;
      }
      g.e.setPosition(g.x, g.baseY + Math.sin((this._t + g.ph) * 2) * 0.3, g.z);
      g.e.rotateLocal(0, g.spin * 60 * dt, 0);
      var d = Math.hypot(p.x - g.x, p.y - g.baseY, p.z - g.z);
      if (!g.collected && d < 2.0 && this._state === "climbing") {
        g.collected = true; this._snd("coin"); this._burstGems(g.x, g.baseY, g.z, 4);
        this.app.root.removeChild(g.e); g.e.destroy(); this._gems.splice(i, 1); continue;
      }
      if (g.t > 9 || g.baseY < this._planeY - 14) { this.app.root.removeChild(g.e); g.e.destroy(); this._gems.splice(i, 1); }
    }
  };
  // emit a contrail puff from the plane's tail (world space, so it's left behind)
  SwoopGame.prototype._emitTrail = function (scN) {
    var p = this._plane.getPosition(), f = this._plane.forward;
    this._spawnPuff(p.x - f.x * 1.3 + rand(-0.12, 0.12), p.y - f.y * 1.3 - 0.05, p.z - f.z * 1.3 + rand(-0.12, 0.12), scN, 0.95, 0.4);
  };

  /* ---------- host bridge (minimal for S1; full crash mechanic in S2) ---------- */
  SwoopGame.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) {
      if (!this._started) { this._started = true; try { this.app.start(); } catch (e) {} } // boot the render/update loop once
      try { this.app.autoRender = true; } catch (e) {}
      this._preferMusic();                                    // select "Sunrise Skyway" (Music button still controls play)
    } else {
      try { this.app.autoRender = false; } catch (e) {}       // pause rendering off-channel (don't burn GPU)
      try { this._fsExit(this._fsTarget); } catch (e) {}      // leaving the channel can't strand fullscreen
    }
  };
  SwoopGame.prototype.setEnabled = function (on) { this._enabled = !!on; };
  SwoopGame.prototype.setBalance = function (usd) { this.balance = Math.max(0, Math.round((+usd || 0) * 100) / 100); };
  SwoopGame.prototype.setEthUsd = function (n) { if (n > 0) this.ethUsd = n; };
  SwoopGame.prototype.setBet = function (v) { this.unitBet = clamp(Math.round((+v || MIN_BET) * 100) / 100, MIN_BET, MAX_BET); };
  SwoopGame.prototype.setMode = function () {};
  SwoopGame.prototype.newSession = function () {};

  /* ---------- fullscreen (immersive; mirrors Reef's reparent-to-body pattern) ----------
     REPARENT the game layer to <body> + add .rr-fs / rr-fs-on so one CSS rule hides ALL
     site chrome in any orientation, AND re-sync the canvas after the flip so a sideways
     phone/tablet gets the full wide view (object-fit:contain keeps the aspect). */
  SwoopGame.prototype.setFullscreenTarget = function (el) {
    this._fsTarget = el;
    var self = this;
    var sync = function () {
      var real = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!real && el && el.classList && el.classList.contains("rr-fs") && self._fsWasReal) {
        self.enterFullscreen(el, { auto: self._fsAuto, skipNative: true });
      }
      self._fsWasReal = real; self._resize();
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
  };
  SwoopGame.prototype.isFullscreen = function () {
    var t = this._fsTarget || this.mount;
    return !!(document.fullscreenElement || document.webkitFullscreenElement || (t && t.classList && t.classList.contains("rr-fs")));
  };
  SwoopGame.prototype.enterFullscreen = function (el, opts) {
    var target = el || this._fsTarget || this.mount; opts = opts || {};
    if (!target || !target.classList) return;
    if (!this._fsHome) this._fsHome = { parent: target.parentNode, next: target.nextSibling };
    if (target.parentNode !== document.body) document.body.appendChild(target);
    target.classList.add("rr-fs");
    document.documentElement.classList.add("rr-fs-on"); document.body.classList.add("rr-fs-on");
    this._fsAuto = !!opts.auto;
    // FsUtil: native fullscreen (URL bar gone) where supported + landscape lock on a manual ⛶ tap
    // + tilt re-assertion + iOS/MetaMask fake-mode chrome-collapse. rr-fs shell above unchanged.
    if (root.FsUtil) { try { root.FsUtil.enterFs(target, { skipNative: !!opts.skipNative, lockOrientation: opts.auto ? null : "landscape", landscapeOnly: !!opts.auto }); } catch (e) {} }
    else if (!opts.skipNative) { try { var req = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen; if (req) req.call(target); } catch (e) {} }
    if (this.els.fsBtn) this.els.fsBtn.classList.add("on");
    var self = this; setTimeout(function () { self._resize(); }, 60); setTimeout(function () { self._resize(); }, 320);
  };
  SwoopGame.prototype._fsExit = function (target) {
    target = target || this._fsTarget || this.mount;
    if (!target || !target.classList || !target.classList.contains("rr-fs")) return;
    target.classList.remove("rr-fs");
    document.documentElement.classList.remove("rr-fs-on"); document.body.classList.remove("rr-fs-on");
    this._fsAuto = false;
    if (this._fsHome && this._fsHome.parent) { try { this._fsHome.parent.insertBefore(target, this._fsHome.next || null); } catch (e) {} this._fsHome = null; }
    if (root.FsUtil) { try { root.FsUtil.exitFs(); } catch (e) {} } // exits native + unlocks orientation + stops re-assertion
    else { try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen(); } catch (e) {} }
    if (this.els.fsBtn) this.els.fsBtn.classList.remove("on");
    var self = this; setTimeout(function () { self._resize(); }, 60);
  };
  SwoopGame.prototype.toggleFullscreen = function (el) {
    var target = el || this._fsTarget || this.mount;
    if (!(target.classList && target.classList.contains("rr-fs"))) this.enterFullscreen(target, { auto: false });
    else this._fsExit(target);
  };
  SwoopGame.prototype.exitFullscreen = function () { this._fsExit(this._fsTarget || this.mount); };
  // called by the host on mobile landscape tilt (CSS-only fullscreen — no user gesture needed)
  SwoopGame.prototype.autoFullscreen = function (on, el) {
    var target = el || this._fsTarget || this.mount;
    if (on) { if (!this.isFullscreen()) this.enterFullscreen(target, { auto: true, skipNative: true }); }
    else if (this._fsAuto) { this._fsExit(target); }
  };

  SwoopGame.prototype.start = function () { this.setActive(true); };

  root.SwoopGame = SwoopGame;
})(typeof globalThis !== "undefined" ? globalThis : this);
