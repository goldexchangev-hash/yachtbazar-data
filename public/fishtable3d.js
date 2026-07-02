/* ============================================================
   fishtable3d.js — "REEF RAIDERS v2": a 3D arcade fish-shooter rendered with
   PlayCanvas (engine-only, vendored, no build step) for the TV.

   MONEY/ODDS still live in FishTableEngine (fishtable-engine.js) — UNCHANGED, so
   the house edge (RTP 0.85 kills + self-budgeting jackpot/bonuses) is identical to
   v1. This file is the RENDERER + game loop only; it will mirror v1's money/safety
   invariants exactly (bullets snapshot their stake; resolveHit(fish.def,power); 5%
   jackpot rake; frenzy free-shots capped & ending at exactly 0; _forceEndBonuses on
   deactivate).

   Phase 1 (this commit): the underwater 3D scene (environment, lighting, god-rays,
   caustics, seabed, bubbles, placeholder fish). Gameplay added in later phases.

   Host bridge mirrors FishTable (v1):
     new FishTable3D({ mount, els, width, height, ethUsd, initialBalance,
                       onBalance, onWin })
   ============================================================ */
(function (root) {
  "use strict";
  var pc = root.pc, E = root.FishTableEngine;
  var MIN_BET = 1, MAX_BET = 50, MAX_POWER = 7;

  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  /* play field (world units). Fish swim in the z≈0 plane; camera looks down -Z. */
  var FIELD_W = 17, FIELD_H = 10.5, FLOOR_Y = -FIELD_H / 2;

  function rgb(hex) { return new pc.Color((hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255); }

  function FishTable3D(opts) {
    opts = opts || {};
    this.els = opts.els || {};
    this.mount = opts.mount;
    this.W = opts.width || 960; this.H = opts.height || 600;
    this.ethUsd = opts.ethUsd || 3400;
    this.onBalance = opts.onBalance || null;
    this.onWin = opts.onWin || null;
    this.balance = opts.initialBalance != null ? opts.initialBalance : 5000;
    this.unitBet = MIN_BET; this.power = 1;
    this._active = false; this._enabled = true;
    this.auto = false; this.lock = false;
    this.engine = E.create();
    this.serverSeed = this.engine.serverSeed; this.commitHash = this.engine.commitHash;

    this._t = 0;
    this._bubbles = [];
    this._decor = [];           // swaying kelp etc.
    this._caustics = [];        // drifting caustic point-lights
    this._demoFish = [];        // placeholder fish (Phase 2 replaces with the real roster)

    this._initApp();
    this._buildScene();
  }

  /* ---------- material helper ---------- */
  FishTable3D.prototype._mat = function (diffuseHex, emissiveHex, o) {
    o = o || {};
    var m = new pc.StandardMaterial();
    m.diffuse = rgb(diffuseHex);
    if (emissiveHex != null) { m.emissive = rgb(emissiveHex); m.emissiveIntensity = o.emi != null ? o.emi : 1; }
    if (o.opacity != null) { m.opacity = o.opacity; m.blendType = o.additive ? pc.BLEND_ADDITIVE : pc.BLEND_NORMAL; m.depthWrite = o.depthWrite != null ? o.depthWrite : !o.additive; }
    if (o.metalness != null) m.metalness = o.metalness;
    if (o.gloss != null) m.gloss = o.gloss;
    if (o.useLighting === false) m.useLighting = false;
    if (o.cull != null) m.cull = o.cull;
    m.update();
    return m;
  };

  FishTable3D.prototype._prim = function (type, mat, parent) {
    var e = new pc.Entity();
    e.addComponent("render", { type: type, material: mat, castShadows: false });
    (parent || this.app.root).addChild(e);
    return e;
  };

  /* ---------- app / camera / lights ---------- */
  FishTable3D.prototype._initApp = function () {
    var canvas = document.createElement("canvas");
    canvas.style.width = "100%"; canvas.style.height = "100%"; canvas.style.display = "block"; canvas.style.touchAction = "none";
    if (this.mount) this.mount.appendChild(canvas);
    this.canvas = canvas;

    var app = new pc.Application(canvas, {
      mouse: pc.Mouse ? new pc.Mouse(canvas) : null,
      touch: pc.TouchDevice ? new pc.TouchDevice(canvas) : null,
      graphicsDeviceOptions: { antialias: true, alpha: false, preferWebGl2: true },
    });
    this.app = app;
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);

    // deep-water atmosphere (PlayCanvas 2.x: scene.fog is a Fog object)
    app.scene.ambientLight = rgb(0x0b2f52);
    if (app.scene.fog && typeof app.scene.fog === "object") {
      app.scene.fog.type = pc.FOG_EXP2;
      app.scene.fog.color = rgb(0x041f3a);
      app.scene.fog.density = 0.055;
    } else {
      app.scene.fog = pc.FOG_EXP2; app.scene.fogColor = rgb(0x041f3a); app.scene.fogDensity = 0.055;
    }
    if (pc.TONEMAP_ACES != null && "toneMapping" in app.scene) { try { app.scene.toneMapping = pc.TONEMAP_ACES; } catch (e) {} }

    // camera looking into the tank
    var cam = new pc.Entity("camera");
    cam.addComponent("camera", { clearColor: rgb(0x05182e), fov: 52, nearClip: 0.1, farClip: 120 });
    cam.setPosition(0, 0.6, 13.2);
    cam.lookAt(0, 0, 0);
    app.root.addChild(cam);
    this.camera = cam;

    // key "sun" from upper-front (god-ray direction) + soft cyan fill from below
    var key = new pc.Entity("key");
    key.addComponent("light", { type: "directional", color: rgb(0xbfe8ff), intensity: 1.5, castShadows: false });
    key.setEulerAngles(58, -18, 0);
    app.root.addChild(key); this.keyLight = key;

    var fill = new pc.Entity("fill");
    fill.addComponent("light", { type: "directional", color: rgb(0x1c6aa8), intensity: 0.6 });
    fill.setEulerAngles(-40, 20, 0);
    app.root.addChild(fill);

    app.on("update", this._update, this);
  };

  /* ---------- scene ---------- */
  FishTable3D.prototype._buildScene = function () {
    var app = this.app;

    // ── back wall (a big dark plane far behind, catches fog) ──
    var backMat = this._mat(0x06223e, 0x041830, { emi: 0.5 });
    var back = this._prim("plane", backMat);
    back.setLocalScale(80, 1, 60);
    back.setEulerAngles(90, 0, 0);     // plane faces +Z
    back.setPosition(0, 0, -16);

    // ── seabed ──
    var sandMat = this._mat(0x123a52, 0x07202f, { emi: 0.4 });
    var floor = this._prim("plane", sandMat);
    floor.setLocalScale(70, 1, 50);
    floor.setPosition(0, FLOOR_Y - 0.2, -4);
    // gentle slope toward camera
    floor.setEulerAngles(-8, 0, 0);

    // ── coral clusters on the seabed ──
    var coralCols = [0xff6f91, 0xff9f45, 0x8a5cff, 0x36e0c8, 0xffd23f];
    for (var i = 0; i < 14; i++) {
      var col = coralCols[i % coralCols.length];
      var cmat = this._mat(col, col, { emi: 0.35 });
      var type = ["cone", "cylinder", "sphere", "capsule"][i % 4];
      var c = this._prim(type, cmat);
      var x = rand(-FIELD_W * 0.55, FIELD_W * 0.55);
      var z = rand(-9, -1);
      var s = rand(0.5, 1.5);
      c.setLocalScale(s * rand(0.6, 1.1), s * rand(1.2, 2.6), s * rand(0.6, 1.1));
      c.setPosition(x, FLOOR_Y + s * 0.6, z);
      c.setEulerAngles(rand(-12, 12), rand(0, 360), rand(-12, 12));
    }

    // ── swaying kelp ──
    for (var k = 0; k < 9; k++) {
      var kmat = this._mat([0x0f7a52, 0x12806a, 0x1d6e3a][k % 3], 0x0a3a2a, { emi: 0.3 });
      var blade = this._prim("cylinder", kmat);
      var h = rand(2.2, 4.6);
      blade.setLocalScale(0.18, h, 0.18);
      var kx = rand(-FIELD_W * 0.6, FIELD_W * 0.6), kz = rand(-10, -2);
      blade.setPosition(kx, FLOOR_Y + h / 2, kz);
      this._decor.push({ e: blade, baseX: kx, ph: rand(0, 6.28), amp: rand(2, 6), spd: rand(0.5, 1.1) });
    }

    // ── god-ray shafts (additive, very faint, from the surface) ──
    for (var r = 0; r < 6; r++) {
      var rayMat = this._mat(0x9fe0ff, 0x9fe0ff, { opacity: rand(0.04, 0.09), additive: true, useLighting: false, cull: pc.CULLFACE_NONE });
      var ray = this._prim("cone", rayMat);
      var rw = rand(1.2, 2.6);
      ray.setLocalScale(rw, 16, rw);
      ray.setPosition(rand(-FIELD_W * 0.6, FIELD_W * 0.6), 7, rand(-9, -1));
      ray.setEulerAngles(8, rand(0, 360), rand(-10, 10));
    }

    // ── drifting caustic point-lights (shimmer on the seabed) ──
    for (var p = 0; p < 4; p++) {
      var cl = new pc.Entity();
      cl.addComponent("light", { type: "point", color: rgb(0x6fd2ff), intensity: 0.9, range: 9 });
      cl.setPosition(rand(-7, 7), rand(-1, 4), rand(-6, 1));
      app.root.addChild(cl);
      this._caustics.push({ e: cl, ph: rand(0, 6.28), spd: rand(0.3, 0.8), baseY: cl.getPosition().y });
    }

    // ── rising bubbles (pooled emissive spheres) ──
    var bubMat = this._mat(0xbfe8ff, 0xbfe8ff, { opacity: 0.32, additive: true, useLighting: false });
    this._bubMat = bubMat;
    for (var b = 0; b < 40; b++) {
      var be = this._prim("sphere", bubMat);
      var sc = rand(0.05, 0.22);
      be.setLocalScale(sc, sc, sc);
      var bx = rand(-FIELD_W / 2, FIELD_W / 2), by = rand(FLOOR_Y, FIELD_H / 2), bz = rand(-7, 4);
      be.setPosition(bx, by, bz);
      this._bubbles.push({ e: be, x: bx, z: bz, vy: rand(0.7, 1.9), wob: rand(0.5, 1.5), ph: rand(0, 6.28), sc: sc });
    }

    // ── a few placeholder fish (Phase 2 replaces with the real roster) ──
    var fishCols = [0x6fe3ff, 0xff9a3d, 0x4d7bff, 0x45f0a6, 0xff5d9e];
    for (var fi = 0; fi < 5; fi++) {
      this._demoFish.push(this._makeDemoFish(fishCols[fi % fishCols.length]));
    }
  };

  // a stylized placeholder fish: squashed ellipsoid body + cone tail + emissive accent.
  FishTable3D.prototype._makeDemoFish = function (colHex) {
    var grp = new pc.Entity();
    this.app.root.addChild(grp);
    var bodyMat = this._mat(colHex, colHex, { emi: 0.5, gloss: 60 });
    var body = this._prim("sphere", bodyMat, grp);
    body.setLocalScale(1.5, 0.85, 0.7);
    var tail = this._prim("cone", bodyMat, grp);
    tail.setLocalScale(0.7, 0.9, 0.5);
    tail.setPosition(-1.05, 0, 0);
    tail.setEulerAngles(0, 0, 90);
    var eyeMat = this._mat(0x101018, 0xffffff, { emi: 0.2 });
    var eye = this._prim("sphere", eyeMat, grp);
    eye.setLocalScale(0.16, 0.16, 0.16); eye.setPosition(0.55, 0.18, 0.32);
    var fish = {
      grp: grp,
      x: rand(-FIELD_W / 2, FIELD_W / 2), y: rand(FLOOR_Y + 1, FIELD_H / 2 - 1), z: rand(-5, 2),
      dir: Math.random() < 0.5 ? 1 : -1, speed: rand(0.7, 1.6), bobAmp: rand(0.2, 0.6), bobSpd: rand(0.6, 1.4), ph: rand(0, 6.28),
    };
    grp.setLocalScale(fish.dir, 1, 1);
    grp.setPosition(fish.x, fish.y, fish.z);
    return fish;
  };

  /* ---------- per-frame ---------- */
  FishTable3D.prototype._update = function (dt) {
    if (!this._active) return;
    dt = Math.min(0.05, dt);
    this._t += dt;
    var t = this._t;

    // gentle camera sway for life
    if (this.camera) {
      this.camera.setPosition(Math.sin(t * 0.18) * 0.5, 0.6 + Math.sin(t * 0.23) * 0.2, 13.2);
      this.camera.lookAt(0, 0, 0);
    }

    // kelp sway
    for (var i = 0; i < this._decor.length; i++) { var d = this._decor[i]; d.e.setEulerAngles(0, 0, Math.sin(t * d.spd + d.ph) * d.amp); }

    // caustic lights drift + pulse
    for (var c = 0; c < this._caustics.length; c++) {
      var cs = this._caustics[c]; var p = cs.e.getPosition();
      cs.e.setPosition(Math.sin(t * cs.spd + cs.ph) * 7, cs.baseY + Math.sin(t * 0.7 + cs.ph) * 1.2, p.z);
      cs.e.light.intensity = 0.6 + 0.5 * Math.sin(t * 2 + cs.ph);
    }

    // bubbles rise + wobble + recycle
    for (var b = 0; b < this._bubbles.length; b++) {
      var bb = this._bubbles[b];
      var y = bb.e.getPosition().y + bb.vy * dt;
      var x = bb.x + Math.sin(t * bb.wob + bb.ph) * 0.4;
      if (y > FIELD_H / 2 + 0.5) { y = FLOOR_Y; bb.x = rand(-FIELD_W / 2, FIELD_W / 2); bb.z = rand(-7, 4); }
      bb.e.setPosition(x, y, bb.z);
    }

    // placeholder fish swim
    for (var f = 0; f < this._demoFish.length; f++) {
      var fh = this._demoFish[f];
      fh.x += fh.dir * fh.speed * dt;
      if (fh.x > FIELD_W / 2 + 2) { fh.x = -FIELD_W / 2 - 2; }
      if (fh.x < -FIELD_W / 2 - 2) { fh.x = FIELD_W / 2 + 2; }
      var yy = fh.y + Math.sin(t * fh.bobSpd + fh.ph) * fh.bobAmp;
      fh.grp.setPosition(fh.x, yy, fh.z);
      fh.grp.setLocalScale(fh.dir, 1, 1);
    }
  };

  /* ---------- host bridge (minimal for Phase 1; full API in later phases) ---------- */
  FishTable3D.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this.app.timeScale = 1; } else { /* pause loop work */ }
  };
  FishTable3D.prototype.setEnabled = function (on) { this._enabled = !!on; };
  FishTable3D.prototype.setBalance = function (usd) { this.balance = Math.max(0, Math.round((+usd || 0) * 100) / 100); };
  FishTable3D.prototype.setEthUsd = function (n) { if (n > 0) this.ethUsd = n; };
  FishTable3D.prototype.setBet = function (v) { this.unitBet = clamp(Math.round((+v || MIN_BET) * 100) / 100, MIN_BET, MAX_BET); };
  FishTable3D.prototype.setPower = function (p) { this.power = clamp(p | 0, 1, MAX_POWER); };
  FishTable3D.prototype.setMode = function () {};
  FishTable3D.prototype.newSession = function () {};
  FishTable3D.prototype.start = function () { this.app.start(); this.setActive(true); };

  root.FishTable3D = FishTable3D;
})(typeof globalThis !== "undefined" ? globalThis : this);
