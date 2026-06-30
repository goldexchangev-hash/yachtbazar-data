/* ============================================================
   fishhunter3000.js — "FISH HUNTER 3000": cyber-neon year-3000 fish shooter.
   A NEW game — completely separate from Fish Shooter (fishshooter.js) and Reef
   Raiders (fishtable.js). Uses fishhunter3000-engine.js for odds (~88% RTP).

   PixiJS v7 top-down arcade: aim + shoot, auto-fire, lock-on, power 1–3, combo
   multiplier, jackpot meter → MEGA LEVIATHAN boss, vault/storm/frenzy bonus
   rounds, particle FX, coin bursts, session stats, fullscreen, responsive resize.

   Host bridge: setActive/setEnabled/setBalance/setBet/setPower/toggleAuto/
   toggleLock/toggleFullscreen/newSession + onBalance/onWin/onReady.
   ============================================================ */
(function (root) {
  "use strict";

  var PIXI = root.PIXI;
  var E = root.FishHunter3000Engine;
  var Sprites = root.FH3KSprites;
  var DIR = "/assets/fishhunter3000/";
  var FRAMES = 8;
  var FISH_KEYS = ["pixel", "neon", "chrome", "plasma", "glitch", "quantum", "laser", "cyber", "holo", "vault", "storm", "frenzy"];
  var COMMON = ["pixel", "neon", "chrome", "plasma", "glitch"];
  var JACKPOT_RAKE = E.JACKPOT_RAKE || 0.05;
  var MIN_BET = 1, MAX_BET = 50, MAX_POWER = 3;
  var FIRE_CD = { slow: 0.32, medium: 0.20, fast: 0.12 };

  var BONUS_THEME = {
    vault:  { name: "VAULT",  title: "◆ DATA VAULT ◆",  sub: "FREE SHOTS!", color: 0xffd23f },
    storm:  { name: "STORM",  title: "⚡ CYBER STORM ⚡", sub: "CHAIN BLASTS!", color: 0x44eeff },
    frenzy: { name: "FRENZY", title: "▶ FEEDING FRENZY ▶", sub: "AUTO HUNT!", color: 0xff4488 },
  };

  var WAVE_SPAWN = [
    { key: "pixel", w: 10 }, { key: "neon", w: 9 }, { key: "chrome", w: 8 },
    { key: "plasma", w: 7 }, { key: "glitch", w: 6 }, { key: "quantum", w: 4 },
    { key: "laser", w: 2.5 }, { key: "cyber", w: 1.2 },
  ];
  var WAVE_TOTW = WAVE_SPAWN.reduce(function (a, x) { return a + x.w; }, 0);

  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  function FishHunter3000(opts) {
    opts = opts || {};
    this.els = opts.els || {};
    this.mount = opts.mount;
    this.cW = opts.width || 960;
    this.cH = opts.height || 600;
    this.W = this.cW;
    this.H = this.cH;
    this._scale = 1;
    this._offX = 0;
    this._offY = 0;
    this.uiScale = 1;
    this.onBalance = opts.onBalance || null;
    this.onWin = opts.onWin || null;
    this.onReady = opts.onReady || null;
    this.balance = opts.initialBalance != null ? opts.initialBalance : 5000;
    this.unitBet = MIN_BET;
    this.power = 1;
    this.fireSpeed = "fast";
    this._active = false;
    this._enabled = true;
    this.auto = false;
    this.lock = false;
    this.engine = E.create();

    this.fish = [];
    this.bullets = [];
    this.coins = [];
    this.particles = [];
    this.fx = [];
    this.gridLines = [];
    this._t = 0;
    this._spawnT = 0;
    this._fireCd = 0;
    this._aim = -Math.PI / 2;
    this._barrelAng = -Math.PI / 2;
    this._won = 0;
    this._combo = 0;
    this._comboT = 0;
    this._jackpot = 0;
    this._jackpotPool = 0;
    this._sesSpent = 0;
    this._sesWon = 0;
    this._frenzy = 0;
    this._frenzyWon = 0;
    this._frenzyExpected = 0;
    this._frenzyBudget = 0;
    this._frenzyId = 0;
    this._frenzyUnit = MIN_BET;
    this._frenzyPow = 1;
    this._frenzyKind = "frenzy";
    this._boss = null;
    this._bossId = 0;
    this._bonus = null;
    this._bonusFinale = null;
    this._depositPulse = 0;
    this._holding = false;
    this._ready = false;
    this.tex = {};
    this._proc = null;

    this._initPixi();
    this._wireInput();
    this._load();
  }

  /* ---------- pixi + responsive ---------- */
  FishHunter3000.prototype._initPixi = function () {
    var self = this;
    this._measure();
    var app = new PIXI.Application({
      width: this.cW,
      height: this.cH,
      backgroundColor: 0x020818,
      antialias: true,
      resolution: Math.min(2, root.devicePixelRatio || 1),
      autoDensity: true,
    });
    this.app = app;
    this.view = app.view;
    var s = app.view.style;
    s.width = "100%";
    s.height = "100%";
    s.display = "block";
    s.touchAction = "none";
    if (this.mount) this.mount.appendChild(app.view);
    app.ticker.autoStart = false;
    app.ticker.stop();
    this._tick = function () { self._frame(Math.min(0.05, app.ticker.deltaMS / 1000)); };
    app.ticker.add(this._tick);
    this._onResize = function () { self._resize(); };
    window.addEventListener("resize", this._onResize);
    window.addEventListener("orientationchange", function () {
      setTimeout(self._onResize, 80);
      setTimeout(self._onResize, 360);
    });
  };

  FishHunter3000.prototype._measure = function () {
    var el = this.mount;
    var w = (el && el.clientWidth) || this.cW;
    var h = (el && el.clientHeight) || this.cH;
    if (w < 40) w = this.cW;
    if (h < 40) h = this.cH;
    this.cW = w;
    this.cH = h;
    this.W = w;
    this.H = h;
    this._scale = 1;
    this._offX = 0;
    this._offY = 0;
    this.uiScale = clamp(Math.min(w, h) / 460, 0.6, 1.6);
  };

  FishHunter3000.prototype._resize = function () {
    if (!this.app) return;
    var oldW = this.cW, oldH = this.cH;
    this._measure();
    try { this.app.renderer.resize(this.cW, this.cH); } catch (e) {}
    if (this._ready && (oldW !== this.cW || oldH !== this.cH)) this._layout();
  };

  /* ---------- assets ---------- */
  FishHunter3000.prototype._placeholderTex = function () {
    if (this._phTex) return this._phTex;
    var c = document.createElement("canvas");
    c.width = c.height = 1;
    this._phTex = PIXI.Texture.from(c);
    return this._phTex;
  };

  FishHunter3000.prototype._loadAsset = function (item) {
    var self = this;
    return PIXI.Assets.load(item.src).then(function (t) {
      self.tex[item.alias] = t;
    }, function () {
      return null;
    });
  };

  FishHunter3000.prototype._load = function () {
    var self = this;
    var list = [
      { alias: "bg", src: DIR + "background.png" },
      { alias: "cannon_img", src: DIR + "cannon.png" },
      { alias: "bullet_img", src: DIR + "bullet.png" },
    ];
    FISH_KEYS.concat(["leviathan"]).forEach(function (id) {
      for (var i = 0; i < FRAMES; i++) {
        list.push({ alias: id + "_" + i, src: DIR + id + "_" + i + ".png" });
      }
    });

    var loaded = 0;
    var total = list.length;

    function checkDone() {
      loaded++;
      if (loaded < total) return;
      if (self.tex.bullet_img && self.tex.bullet_img.valid) self.tex.bullet = self.tex.bullet_img;
      self._mergeProceduralGaps();
      self._buildFromTex();
      self._ready = true;
      if (self._active) { try { self.app.ticker.start(); } catch (e) {} }
      if (self.onReady) { try { self.onReady(); } catch (e) {} }
    }

    if (!list.length) { checkDone(); return; }
    list.forEach(function (item) {
      self._loadAsset(item).then(checkDone, checkDone);
    });
  };

  // Hybrid art: keep Grok-style PNG frames where they loaded; fill any missing fish
  // (or incomplete 8-frame set) from the procedural factory so spawns never stall.
  FishHunter3000.prototype._mergeProceduralGaps = function () {
    if (!Sprites) return;
    var self = this;
    var defs = E.FISH.concat([E.BOSS]);
    var needProc = false;
    defs.forEach(function (def) {
      if (self._frames(def.id, FRAMES).length >= FRAMES) return;
      needProc = true;
    });
    if (!needProc) return;
    this._proc = Sprites.build(PIXI, defs);
    defs.forEach(function (def) {
      if (self._frames(def.id, FRAMES).length >= FRAMES) return;
      var frames = self._proc.fish[def.id];
      if (!frames) return;
      for (var f = 0; f < frames.length && f < FRAMES; f++) self.tex[def.id + "_" + f] = frames[f];
    });
    if (!this.tex.bg || !this.tex.bg.valid) this.tex.bg = this._proc.bg;
    if (this.tex.bullet_img && this.tex.bullet_img.valid) this.tex.bullet = this.tex.bullet_img;
    else if (!this.tex.bullet) this.tex.bullet = this._proc.bullet;
    if (!this.tex.cannon_img || !this.tex.cannon_img.valid) {
      this.tex.cannon = this._proc.cannon;
      this._useProcCannon = true;
    }
  };

  FishHunter3000.prototype._buildProcedural = function () {
    if (!Sprites) { this._buildFromTex(); return; }
    var self = this;
    var defs = E.FISH.concat([E.BOSS]);
    this._proc = Sprites.build(PIXI, defs);
    var f;
    defs.forEach(function (def) {
      var frames = self._proc.fish[def.id];
      if (frames) {
        for (f = 0; f < frames.length; f++) self.tex[def.id + "_" + f] = frames[f];
      }
    });
    this.tex.cannon = this._proc.cannon;
    this.tex.bullet = this._proc.bullet;
    this.tex.bg = this._proc.bg;
    this._useProcCannon = true;
    this._buildFromTex();
  };

  FishHunter3000.prototype._frames = function (key, n) {
    var a = [], ph = this._phTex, i, t;
    for (i = 0; i < n; i++) {
      t = this.tex[key + "_" + i];
      if (!t || !t.valid || t === ph) return [];
      a.push(t);
    }
    return a;
  };

  /* ---------- scene ---------- */
  FishHunter3000.prototype._buildFromTex = function () {
    var self = this;
    this._measure();
    var app = this.app, W = this.W, H = this.H;

    this.bgLayer = new PIXI.Container();
    app.stage.addChild(this.bgLayer);
    this.bg = new PIXI.Sprite(this.tex.bg || this._radial(0x061a3a, 512));
    this.bg.anchor.set(0.5);
    this.bgLayer.addChild(this.bg);

    this.gridLayer = new PIXI.Container();
    this.gridLayer.alpha = 0.35;
    this.bgLayer.addChild(this.gridLayer);
    this._buildGrid();

    this.bgBonus = new PIXI.Graphics();
    this.bgBonus.alpha = 0;
    this.bgLayer.addChild(this.bgBonus);

    this.world = new PIXI.Container();
    app.stage.addChild(this.world);

    this.particleLayer = new PIXI.Container();
    this.particleLayer.blendMode = PIXI.BLEND_MODES.ADD;
    this.world.addChild(this.particleLayer);

    this.fishLayer = new PIXI.Container();
    this.world.addChild(this.fishLayer);

    this.bossLayer = new PIXI.Container();
    this.world.addChild(this.bossLayer);

    this.bulletLayer = new PIXI.Container();
    this.world.addChild(this.bulletLayer);

    this.fxLayer = new PIXI.Container();
    this.world.addChild(this.fxLayer);

    this.vign = new PIXI.Sprite(this._vignTex());
    this.world.addChild(this.vign);

    this.cannon = new PIXI.Container();
    this.world.addChild(this.cannon);
    if (this._useProcCannon && this.tex.cannon && this.tex.cannon.length) {
      this.barrel = new PIXI.AnimatedSprite(this.tex.cannon);
      this.barrel.anchor.set(0.5, 1);
      this.barrel.animationSpeed = 0.12;
      this.barrel.play();
      this._barrelTipLen = 48;
    } else if (this.tex.cannon_img && this.tex.cannon_img.valid) {
      this.barrel = new PIXI.Sprite(this.tex.cannon_img);
      this.barrel.anchor.set(0.5, 1);
      this._barrelTipLen = 56;
    } else {
      this.barrel = new PIXI.Graphics();
      this._drawCannonGfx(this.barrel);
      this._barrelTipLen = 52;
    }
    this.cannon.addChild(this.barrel);
    this._cannonK = 1;

    this.hud = new PIXI.Container();
    this.world.addChild(this.hud);
    this.jpBar = new PIXI.Graphics();
    this.hud.addChild(this.jpBar);
    var mk = function (sz, fill) {
      return new PIXI.Text("", {
        fontFamily: "Orbitron, Bungee, Arial",
        fontSize: sz,
        fontWeight: "700",
        fill: fill,
        stroke: 0x020818,
        strokeThickness: sz * 0.14,
      });
    };
    this.jpText = mk(14, 0x00f5ff);
    this.jpText.anchor.set(0.5, 0);
    this.hud.addChild(this.jpText);
    this.balText = mk(18, 0x9be8ff);
    this.hud.addChild(this.balText);
    this.powText = mk(13, 0xff3dff);
    this.hud.addChild(this.powText);
    this.comboText = mk(16, 0x39ff14);
    this.comboText.anchor.set(0.5, 0);
    this.comboText.alpha = 0;
    this.hud.addChild(this.comboText);
    this.banner = mk(38, 0xffd23f);
    this.banner.anchor.set(0.5);
    this.banner.alpha = 0;
    this.hud.addChild(this.banner);
    this.bannerSub = mk(20, 0xffffff);
    this.bannerSub.anchor.set(0.5);
    this.bannerSub.alpha = 0;
    this.hud.addChild(this.bannerSub);

    this._glowTex = this._radial(0x00f5ff, 128);
    this._coinTex = this._coinTexGen();

    for (var i = 0; i < 8; i++) this._spawnFish();
    this._layout();
    this._renderHud();
  };

  FishHunter3000.prototype._buildGrid = function () {
    var g = this.gridLayer;
    if (!g) return;
    g.removeChildren();
    this.gridLines = [];
    var W = this.cW, H = this.cH, step = 48, i;
    var gfx = new PIXI.Graphics();
    gfx.lineStyle(1, 0x00f5ff, 0.08);
    for (i = 0; i <= W / step; i++) {
      gfx.moveTo(i * step, 0);
      gfx.lineTo(i * step, H);
    }
    for (i = 0; i <= H / step; i++) {
      gfx.moveTo(0, i * step);
      gfx.lineTo(W, i * step);
    }
    g.addChild(gfx);
    this.gridLines.push(gfx);
  };

  FishHunter3000.prototype._drawCannonGfx = function (g) {
    g.clear();
    g.beginFill(0x1a2a44);
    g.lineStyle(3, 0x00f5ff, 1);
    g.drawCircle(0, 8, 26);
    g.endFill();
    g.beginFill(0x556688);
    g.drawRect(-7, -38, 14, 46);
    g.endFill();
    g.beginFill(0x00f5ff);
    g.drawCircle(0, -42, 5);
    g.endFill();
  };

  FishHunter3000.prototype._radial = function (color, size) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var x = c.getContext("2d");
    var g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    var r = color >> 16 & 255, gg = color >> 8 & 255, bb = color & 255;
    g.addColorStop(0, "rgba(" + r + "," + gg + "," + bb + ",1)");
    g.addColorStop(1, "rgba(" + r + "," + gg + "," + bb + ",0)");
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
    return PIXI.Texture.from(c);
  };

  FishHunter3000.prototype._vignTex = function () {
    var s = 256, c = document.createElement("canvas");
    c.width = c.height = s;
    var x = c.getContext("2d");
    var g = x.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(2,8,24,0.65)");
    x.fillStyle = g;
    x.fillRect(0, 0, s, s);
    return PIXI.Texture.from(c);
  };

  FishHunter3000.prototype._coinTexGen = function () {
    var c = document.createElement("canvas");
    c.width = c.height = 24;
    var x = c.getContext("2d");
    var g = x.createRadialGradient(12, 12, 2, 12, 12, 11);
    g.addColorStop(0, "#fff8c0");
    g.addColorStop(0.5, "#ffd23f");
    g.addColorStop(1, "#b8860b");
    x.fillStyle = g;
    x.beginPath();
    x.arc(12, 12, 10, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = "#fff";
    x.lineWidth = 1.5;
    x.stroke();
    return PIXI.Texture.from(c);
  };

  FishHunter3000.prototype._layout = function () {
    var W = this.W, H = this.H;
    if (this.world) {
      this.world.scale.set(this._scale);
      this.world.x = this._offX;
      this.world.y = this._offY;
    }
    if (this.bg) {
      var tw = this.bg.texture.width || W, th = this.bg.texture.height || H;
      this.bg.scale.set(Math.max(W / tw, H / th));
      this.bg.x = W / 2;
      this.bg.y = H / 2;
    }
    this._buildGrid();
    if (this.vign) { this.vign.width = W; this.vign.height = H; }
    if (this.cannon) {
      var targetDia = clamp(Math.min(W, H) * 0.24, 64, 180);
      this._cannonK = targetDia / 96;
      this.cannon.scale.set(this._cannonK);
      this.cannon.x = W / 2;
      this.cannon.y = H;
    }
    if (this._boss && this._boss.spr) {
      var bdw = W * 0.55;
      this._boss.scale = bdw / (this._boss.spr.texture.width || 128);
      this._boss.r = bdw * 0.38;
      this._boss.spr.x = W / 2;
      this._boss.baseY = H * 0.32;
    }
    for (var fi = 0; fi < this.fish.length; fi++) {
      var ff = this.fish[fi];
      if (!ff || !ff.frameW) continue;
      var dw = this._fishDispW(ff.def);
      ff.scale = dw / ff.frameW;
      ff.r = dw * 0.32;
      this._sizeLabel(ff);
    }
    this._drawHud();
  };

  FishHunter3000.prototype._fishDispW = function (def) {
    var base = (def.size || 1) * 72 * (this.uiScale || 1);
    return clamp(base, 28, Math.min(this.W, this.H) * 0.55);
  };

  FishHunter3000.prototype._sizeLabel = function (f) {
    if (!f.lbl) return;
    var target = clamp(Math.min(this.W, this.H) * 0.042, 18, 34);
    var cs = target / (44 * (f.scale || 1));
    f.lbl.scale.set((f.flip ? -1 : 1) * cs, cs);
  };

  /* ---------- fish ---------- */
  FishHunter3000.prototype._spawnFish = function (forceDef) {
    if (this.fish.length > 16) return;
    var def = forceDef || this.engine.pickFish();
    var frames = this._frames(def.id || def.key, FRAMES);
    if (!frames.length) return;
    var spr = new PIXI.AnimatedSprite(frames);
    spr.anchor.set(0.5);
    spr.animationSpeed = rand(0.12, 0.2);
    spr.play();
    var cont = new PIXI.Container();
    cont.addChild(spr);
    var dispW = this._fishDispW(def);
    var scale = dispW / frames[0].width;
    cont.scale.set(scale);

    if (def.special || def.bonus) {
      var gtex = this._radial(def.color || 0x00f5ff, 128);
      var gl = new PIXI.Sprite(gtex);
      gl.anchor.set(0.5);
      gl.alpha = 0.35;
      gl.blendMode = PIXI.BLEND_MODES.ADD;
      gl.scale.set((dispW * 0.8) / 128 / scale);
      cont.addChildAt(gl, 0);
    }

    var lbl = new PIXI.Text("x" + def.mult, {
      fontFamily: "Orbitron, Bungee, Arial",
      fontSize: 44,
      fontWeight: "700",
      fill: 0xffffff,
      stroke: 0x020818,
      strokeThickness: 6,
    });
    lbl.anchor.set(0.5);
    lbl.y = frames[0].height * 0.32;
    lbl.alpha = 0.92;
    cont.addChild(lbl);

    var fromLeft = Math.random() < 0.5;
    var y = rand(this.H * 0.1, this.H * 0.78);
    var speed = def.tier >= 4 ? rand(36, 58) : rand(50, 95);
    var fobj = {
      def: def,
      cont: cont,
      spr: spr,
      vx: (fromLeft ? 1 : -1) * speed,
      vy: rand(-12, 12),
      r: dispW * 0.32,
      scale: scale,
      frameW: frames[0].width,
      lbl: lbl,
      alive: true,
      flip: !fromLeft,
      flinch: 0,
    };
    this._sizeLabel(fobj);
    cont.x = fromLeft ? -dispW : this.W + dispW;
    cont.y = y;
    this.fishLayer.addChild(cont);
    this.fish.push(fobj);
  };

  FishHunter3000.prototype._pickWaveFish = function () {
    var r = Math.random() * WAVE_TOTW, acc = 0, i;
    for (i = 0; i < WAVE_SPAWN.length; i++) {
      acc += WAVE_SPAWN[i].w;
      if (r < acc) return E.BY_KEY[WAVE_SPAWN[i].key];
    }
    return E.BY_KEY.pixel;
  };

  /* ---------- aim + fire ---------- */
  FishHunter3000.prototype._pointAt = function (gx, gy) {
    if (this.lock) return;
    var r = this.app.view.getBoundingClientRect();
    var cx = (gx - r.left) / r.width * this.cW;
    var cy = (gy - r.top) / r.height * this.cH;
    var x = (cx - this._offX) / this._scale;
    var y = (cy - this._offY) / this._scale;
    var dx = x - this.cannon.x, dy = y - this.cannon.y;
    if (dy > -24) dy = -24;
    this._aim = clamp(Math.atan2(dy, dx), -(Math.PI - 0.08), -0.08);
  };

  FishHunter3000.prototype.cost = function () {
    return Math.round(this.unitBet * this.power * 100) / 100;
  };

  FishHunter3000.prototype._fire = function (manual) {
    if (!this._active || !this._enabled || !this._ready) return;
    if (this._boss && !this._boss.started) return;
    if (this._bonus && !this._bonus.started) return;
    if (this._bonusFinale) return;
    var free = this._frenzy > 0 || !!this._boss;
    if ((this._fireCd || 0) > 0 && (free || !manual)) return;

    var su = free ? this._frenzyUnit : this.unitBet;
    var sp = free ? this._frenzyPow : this.power;
    var paid = Math.round(su * sp * 100) / 100;
    var cost = free ? 0 : paid;
    if (!free && this.balance < cost) {
      this._flashBanner("INSUFFICIENT", "add funds", 0xff5d72);
      return;
    }
    if (cost > 0) {
      this._sesSpent = Math.round((this._sesSpent + cost) * 100) / 100;
      this.balance = Math.round((this.balance - cost) * 100) / 100;
      this._jackpotPool = Math.round((this._jackpotPool + cost * JACKPOT_RAKE) * 100) / 100;
      this._save();
      this._renderHud();
    }

    var ang = this._aim;
    var md = (this._barrelTipLen || 48) * (this._cannonK || 1);
    var tx = this.cannon.x + Math.cos(ang) * md;
    var ty = this.cannon.y + Math.sin(ang) * md;

    var b = new PIXI.Container();
    b.x = tx;
    b.y = ty;
    b.rotation = ang + Math.PI / 2;
    var glow = new PIXI.Sprite(this._glowTex);
    glow.anchor.set(0.5);
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    glow.alpha = 0.55;
    glow.scale.set(0.12 + sp * 0.02);
    b.addChild(glow);
    var core;
    if (this.tex.bullet && this.tex.bullet instanceof PIXI.Texture) {
      core = new PIXI.Sprite(this.tex.bullet);
      core.anchor.set(0.5);
    } else {
      core = new PIXI.Graphics();
      core.beginFill(0x00f5ff);
      core.drawCircle(0, 0, 4 + sp);
      core.endFill();
    }
    b.addChild(core);
    this.bulletLayer.addChild(b);

    var speed = 980 + sp * 40;
    while (this.bullets.length > 100) this._rmBullet(this.bullets[0]);
    this.bullets.push({
      s: b,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      r: 6 + sp * 1.2,
      hit: false,
      unitBet: su,
      power: sp,
      cost: paid,
      free: free,
      frenzyId: free ? this._frenzyId : 0,
      bossId: (this._boss && this._boss.started) ? this._bossId : 0,
    });
    this._recoil = 6;
    this._muzzle(tx, ty);
    this._spawnParticles(tx, ty, 0x00f5ff, 6);
    if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {}
    this._fireCd = FIRE_CD[this.fireSpeed] || FIRE_CD.fast;
  };

  FishHunter3000.prototype._muzzle = function (x, y) {
    var s = new PIXI.Sprite(this._radial(0xff3dff, 64));
    s.anchor.set(0.5);
    s.x = x;
    s.y = y;
    s.blendMode = PIXI.BLEND_MODES.ADD;
    s.scale.set(0.2 * (this._cannonK || 1));
    this.fxLayer.addChild(s);
    this.fx.push({ s: s, t: 0, dur: 0.14, kind: "flash" });
  };

  FishHunter3000.prototype._rmBullet = function (b) {
    if (!b) return;
    try {
      if (b.s) { this.bulletLayer.removeChild(b.s); b.s.destroy({ children: true }); }
    } catch (e) {}
    var i = this.bullets.indexOf(b);
    if (i >= 0) this.bullets.splice(i, 1);
  };

  FishHunter3000.prototype._clearRoundBullets = function () {
    for (var i = this.bullets.length - 1; i >= 0; i--) {
      var b = this.bullets[i];
      if (b && (b.free || b.bossId)) this._rmBullet(b);
    }
  };

  FishHunter3000.prototype._comboMult = function () {
    if (this._combo < 2) return 1;
    return 1 + Math.min(this._combo - 1, 8) * 0.04;
  };

  FishHunter3000.prototype._resolveHit = function (b, fish) {
    b.hit = true;
    if (this._boss && this._boss.started) {
      this._catchCosmetic(fish, b.s.x, b.s.y);
      return;
    }
    if (b.free && (this._frenzy <= 0 || b.frenzyId !== this._frenzyId)) {
      this._netFx(b.s.x, b.s.y, fish.def.color);
      return;
    }
    if (b.free) {
      this._frenzyExpected = (this._frenzyExpected || 0) +
        fish.def.mult * this.engine.killProb(fish.def, b.power) * (b.unitBet || this._frenzyUnit || 1);
    }
    var shot = { unitBet: b.unitBet, power: b.power, cost: b.cost, free: !!b.free };
    var res = this.engine.resolveHit(fish.def, shot.power);
    this._netFx(b.s.x, b.s.y, fish.def.color);
    if (res.dead) this._catch(fish, shot);
    else {
      fish.flinch = 0.14;
      fish.spr.tint = 0xff6688;
    }
  };

  FishHunter3000.prototype._catch = function (fish, shot, isChain) {
    if (!fish.alive) return;
    fish.alive = false;
    var unitBet = shot.unitBet || this.unitBet;
    var cm = this._comboMult();
    var payout = Math.round(fish.def.mult * unitBet * cm * 100) / 100;

    if (shot.free) {
      this._frenzyWon = Math.round((this._frenzyWon + payout) * 100) / 100;
    } else {
      this.balance = Math.round((this.balance + payout) * 100) / 100;
      this._sesWon = Math.round((this._sesWon + payout) * 100) / 100;
    }
    this._won = payout;
    this._save();
    this._renderHud();
    this._combo++;
    this._comboT = 1.4;

    this._netFx(fish.cont.x, fish.cont.y, fish.def.color, true);
    this._burstFx(fish.cont.x, fish.cont.y, clamp(0.5 + fish.def.mult * 0.018, 0.55, 2.2));
    this._spawnParticles(fish.cont.x, fish.cont.y, fish.def.color || 0x00f5ff, clamp(8 + fish.def.mult, 10, 40));
    var n = clamp(Math.round(fish.def.mult * 1.2) + 6, 6, 48);
    for (var i = 0; i < n; i++) this._spawnCoin(fish.cont.x, fish.cont.y);
    this._floatText("+$" + payout.toFixed(2) + (cm > 1 ? " x" + cm.toFixed(2) : ""), fish.cont.x, fish.cont.y - fish.r, 0x39ff14);

    if (fish.def.mult >= 40) this._screenFlash(fish.def.tier >= 4 ? 0xffd23f : 0xffffff);
    if (fish.def.mult >= 25) this._flashBanner("BIG WIN", fish.def.name + "  +$" + payout.toFixed(2), 0xffe08a);
    else if (this._combo >= 4) this._flashBanner("COMBO x" + this._combo, "+" + Math.round((cm - 1) * 100) + "% boost", 0x00f5ff);

    var C = root.Chiptune;
    if (C) try {
      if (fish.def.mult >= 40 && C.bigwin) C.bigwin();
      else if (C.coin) C.coin();
    } catch (e) {}

    if (this.onWin && payout >= Math.max(0.01, shot.cost || unitBet) * 6) {
      try { this.onWin({ profitUsd: payout - (shot.free ? 0 : (shot.cost || 0)), mult: fish.def.mult }); } catch (e) {}
    }

    if (!shot.free && !this._boss && !this._bonus && !this._bonusFinale && !isChain) {
      var bump = 0.005 * (shot.power || 1);
      if (fish.def.tier >= 4) bump += 0.08;
      if (fish.def.bonus) bump += 0.06;
      this._jackpot = clamp(this._jackpot + bump, 0, 1);
      if (this._jackpot >= 1) this._startBossRound();
    }

    if (!isChain && fish.def.bonus && this._canBonus()) {
      this._startBonus(fish.def.bonus, shot);
    }

    if (this._frenzy > 0 && this._frenzyKind === "storm" && shot.free) {
      this._chainLightning(fish, shot);
    }

    fish.death = 0;
  };

  FishHunter3000.prototype._catchCosmetic = function (fish) {
    if (!fish.alive) return;
    fish.alive = false;
    fish.death = 0;
    this._netFx(fish.cont.x, fish.cont.y, fish.def.color, true);
    this._burstFx(fish.cont.x, fish.cont.y, 0.6);
    for (var i = 0; i < 6; i++) this._spawnCoin(fish.cont.x, fish.cont.y);
    if (this._boss) this._accrueBoss((this._boss.inc || 0) * 0.4, fish.cont.x, fish.cont.y - fish.r, false);
  };

  FishHunter3000.prototype._splashRoll = function (def, power, free, unitBet) {
    var sr = this.engine.resolveSplash(def, power);
    if (free) {
      this._frenzyExpected = (this._frenzyExpected || 0) +
        def.mult * sr.p * (unitBet || this._frenzyUnit || 1);
    }
    return sr.dead;
  };

  FishHunter3000.prototype._chainLightning = function (src, shot) {
    var targets = this.fish.filter(function (o) { return o.alive && o !== src; })
      .map(function (o) { return { o: o, d: Math.hypot(o.cont.x - src.cont.x, o.cont.y - src.cont.y) }; })
      .sort(function (a, b) { return a.d - b.d; })
      .slice(0, 3);
    var px = src.cont.x, py = src.cont.y, i;
    for (i = 0; i < targets.length; i++) {
      var o = targets[i].o;
      this._lightning(px, py, o.cont.x, o.cont.y);
      px = o.cont.x;
      py = o.cont.y;
      if (this._splashRoll(o.def, shot.power, shot.free, shot.unitBet)) this._catch(o, shot, true);
    }
  };

  /* ---------- bonus rounds ---------- */
  FishHunter3000.prototype._canBonus = function () {
    return this._frenzy <= 0 && !this._boss && !this._bonus && !this._bonusFinale;
  };

  FishHunter3000.prototype._startBonus = function (kind, shot) {
    if (!this._canBonus()) return;
    this._bonus = {
      kind: kind,
      shot: { unitBet: shot.unitBet, power: shot.power, cost: shot.cost, free: !!shot.free },
      countT: 0,
      lastNum: 99,
      started: false,
    };
    this._shake = 24;
    var th = BONUS_THEME[kind] || BONUS_THEME.frenzy;
    this._flashBanner(th.title, "INCOMING…", th.color);
    this._tintBonusBg(th.color);
  };

  FishHunter3000.prototype._tintBonusBg = function (color) {
    if (!this.bgBonus) return;
    this.bgBonus.clear();
    this.bgBonus.beginFill(color || 0x00f5ff, 0.12);
    this.bgBonus.drawRect(0, 0, this.cW, this.cH);
    this.bgBonus.endFill();
    this.bgBonus.alpha = 1;
  };

  FishHunter3000.prototype._startFrenzy = function (dur, shot, kind) {
    if (this._frenzy > 0 || this._boss) return;
    kind = kind || "frenzy";
    this._frenzyKind = kind;
    var th = BONUS_THEME[kind] || BONUS_THEME.frenzy;
    this._frenzyId++;
    this._frenzy = dur;
    this._frenzyWon = 0;
    this._frenzyExpected = 0;
    this._frenzyUnit = shot.unitBet || this.unitBet;
    this._frenzyPow = 1;
    this._frenzyBudget = this.engine.bonusBudget(this._frenzyUnit);
    this._flashBanner(th.title, th.sub, th.color);
    this._screenFlash(th.color);
    for (var i = 0; i < 10; i++) {
      (function (self, idx) {
        setTimeout(function () {
          if (self._active && self._frenzy > 0) self._spawnFish(self._pickWaveFish());
        }, idx * 100);
      })(this, i);
    }
  };

  FishHunter3000.prototype._updateBonus = function (dt) {
    var bz = this._bonus;
    if (!bz) return;
    if (!bz.started) {
      bz.countT += dt;
      var num = 3 - Math.floor(bz.countT);
      if (num !== bz.lastNum) {
        bz.lastNum = num;
        if (num > 0) {
          this._flashBanner(String(num), "GET READY!", 0xffe08a);
          this._shake = Math.max(this._shake, 4 + (3 - num) * 2);
        }
      }
      if (bz.countT >= 3) {
        bz.started = true;
        this._startFrenzy(12, bz.shot, bz.kind);
      }
      return;
    }
    if (this._frenzy <= 0) this._endBonusWave();
  };

  FishHunter3000.prototype._endBonusWave = function () {
    var bz = this._bonus;
    if (!bz) return;
    var kind = bz.kind;
    this._bonus = null;
    this._clearRoundBullets();
    var th = BONUS_THEME[kind] || BONUS_THEME.frenzy;
    var won = Math.round((this._frenzyWon || 0) * 100) / 100;
    this._bonusFinale = { kind: kind, th: th, won: won, t: 0, dur: 4.2, paid: false, shot: bz.shot };
    for (var i = this.fish.length - 1; i >= 0; i--) {
      var f = this.fish[i];
      if (f && f.alive) { f.alive = false; f.death = 0; }
    }
    this._flashBanner(th.name + " COMPLETE!", won > 0 ? "YOU WON  $" + won.toFixed(2) : "", th.color);
    this._screenFlash(th.color);
    this._shake = 16;
  };

  FishHunter3000.prototype._updateBonusFinale = function (dt) {
    var fz = this._bonusFinale;
    if (!fz) return;
    fz.t += dt;
    if (fz.t < 1.8) { this.banner.alpha = 1; this.bannerSub.alpha = 1; this._bannerT = Math.min(this._bannerT, 0.9); }
    if (!fz.paid && fz.t >= 1.8) {
      fz.paid = true;
      if (fz.won > 0) {
        this.balance = Math.round((this.balance + fz.won) * 100) / 100;
        this._sesWon = Math.round((this._sesWon + fz.won) * 100) / 100;
        this._won = fz.won;
        this._save();
        if (fz.kind === "vault") this._vaultReveal(fz.won);
        this._flashBanner("DEPOSITED", "+$" + fz.won.toFixed(2), 0xffd23f);
        this._depositPulse = 1;
        for (var i = 0; i < 60; i++) this._rainCoin();
      }
      this._renderHud();
    }
    if (fz.t >= fz.dur) {
      this._bonusFinale = null;
      if (this.bgBonus) this.bgBonus.alpha = 0;
      this._renderHud();
    }
  };

  FishHunter3000.prototype._vaultReveal = function (won) {
    this._flashBanner("VAULT UNLOCKED", "+" + this.engine.rollVaultMult() + "x bonus tier", 0xffd23f);
    for (var i = 0; i < 40; i++) this._spawnCoin(this.W / 2 + rand(-80, 80), this.H * 0.38);
    this._burstFx(this.W / 2, this.H * 0.38, 2);
  };

  /* ---------- boss round ---------- */
  FishHunter3000.prototype._startBossRound = function () {
    if (this._boss || this._frenzy > 0 || this._bonus || this._bonusFinale) return;
    this._jackpot = 0;
    this._bossId++;
    this._boss = {
      id: this._bossId,
      pool: Math.round(this._jackpotPool * 100) / 100,
      won: 0,
      inc: 0,
      started: false,
      countT: 0,
      lastNum: 99,
      t: 0,
      dur: 40,
    };
    this._shake = 28;
    this._flashBanner("JACKPOT ROUND!", "MEGA LEVIATHAN INCOMING", 0xff0044);
  };

  FishHunter3000.prototype._spawnBoss = function () {
    var frames = this._frames("leviathan", FRAMES);
    if (!frames.length) { this._endBossRound(); return; }
    var spr = new PIXI.AnimatedSprite(frames);
    spr.anchor.set(0.5);
    spr.animationSpeed = 0.1;
    spr.play();
    var dispW = this.W * 0.55;
    var scale = dispW / frames[0].width;
    spr.scale.set(scale);
    spr.x = this.W / 2;
    spr.y = this.H * 0.32;
    this.bossLayer.addChild(spr);
    this._boss.spr = spr;
    this._boss.scale = scale;
    this._boss.r = dispW * 0.38;
    this._boss.baseY = spr.y;
    this._boss.hpMax = 120;
    this._boss.hp = 120;
    var bz = this._boss;
    bz.inc = Math.floor((bz.pool / bz.hpMax) * 0.88 * 100) / 100;
    if (bz.inc < 0.01 && bz.pool > 0) bz.inc = 0.01;
  };

  FishHunter3000.prototype._updateBoss = function (dt) {
    var bz = this._boss;
    if (!bz) return;
    if (!bz.started) {
      bz.countT += dt;
      var num = 3 - Math.floor(bz.countT);
      if (num !== bz.lastNum) {
        bz.lastNum = num;
        if (num > 0) this._flashBanner(String(num), "LEVIATHAN AWAKES", 0xff4488);
      }
      if (bz.countT >= 3) {
        bz.started = true;
        bz.t = 0;
        this._flashBanner("FIGHT!", "BLAST THE LEVIATHAN", 0xff0044);
        this._spawnBoss();
        this._shake = 22;
        var refund = 0, bi;
        for (bi = this.bullets.length - 1; bi >= 0; bi--) {
          var pbb = this.bullets[bi];
          if (pbb.bossId !== this._boss.id) {
            if (!pbb.free && pbb.cost > 0) refund += pbb.cost;
            this._rmBullet(pbb);
          }
        }
        if (refund > 0) {
          refund = Math.round(refund * 100) / 100;
          this.balance = Math.round((this.balance + refund) * 100) / 100;
          this._sesSpent = Math.round((this._sesSpent - refund) * 100) / 100;
          this._save();
          this._renderHud();
        }
      }
      return;
    }
    bz.t += dt;
    if (bz.spr) {
      bz.spr.y = bz.baseY + Math.sin(this._t * 1.4) * 14;
      bz.spr.x = this.W / 2 + Math.sin(this._t * 0.7) * this.W * 0.14;
      bz.spr.rotation = Math.sin(this._t * 0.6) * 0.04;
      if (bz.flash > 0) {
        bz.flash -= dt;
        if (bz.flash <= 0) bz.spr.tint = 0xffffff;
      }
    }
    if (bz.hp <= 0 || bz.t >= bz.dur) this._endBossRound();
  };

  FishHunter3000.prototype._accrueBoss = function (amount, x, y, isBossHit) {
    var bz = this._boss;
    if (!bz) return 0;
    var rem = Math.round((bz.pool - bz.won) * 100) / 100;
    if (rem <= 0) return 0;
    var amt = Math.min(Math.round(amount * 100) / 100, rem);
    if (amt <= 0) return 0;
    bz.won = Math.round((bz.won + amt) * 100) / 100;
    this.balance = Math.round((this.balance + amt) * 100) / 100;
    this._won = amt;
    this._sesWon = Math.round((this._sesWon + amt) * 100) / 100;
    this._save();
    this._renderHud();
    this._floatText("+$" + amt.toFixed(2), x, y, isBossHit ? 0xffd23f : 0x39ff14);
    return amt;
  };

  FishHunter3000.prototype._endBossRound = function () {
    var bz = this._boss;
    if (!bz) return;
    this._boss = null;
    this._clearRoundBullets();
    if (bz.spr) {
      this._burstFx(bz.spr.x, bz.spr.y, 2.8);
      this._spawnParticles(bz.spr.x, bz.spr.y, 0xff0044, 50);
      try { this.bossLayer.removeChild(bz.spr); bz.spr.destroy(); } catch (e) {}
    }
    var rem = Math.round(((bz.pool || 0) - (bz.won || 0)) * 100) / 100;
    if (rem > 0) {
      this.balance = Math.round((this.balance + rem) * 100) / 100;
      this._won = rem;
      this._sesWon = Math.round((this._sesWon + rem) * 100) / 100;
    }
    this._jackpotPool = 0;
    this._save();
    this._renderHud();
    var total = Math.round((bz.pool || 0) * 100) / 100;
    this._flashBanner("LEVIATHAN DOWN!", "+$" + total.toFixed(2), 0xffd23f);
    this._screenFlash(0xff0044);
    for (var i = 0; i < 80; i++) this._rainCoin();
    if (this.onWin) try { this.onWin({ profitUsd: total, bonus: true }); } catch (e) {}
  };

  /* ---------- fx ---------- */
  FishHunter3000.prototype._spawnParticles = function (x, y, color, n) {
    var i, p;
    for (i = 0; i < n; i++) {
      var g = new PIXI.Graphics();
      g.beginFill(color || 0x00f5ff);
      g.drawCircle(0, 0, rand(1.5, 3.5));
      g.endFill();
      g.x = x;
      g.y = y;
      g.blendMode = PIXI.BLEND_MODES.ADD;
      this.particleLayer.addChild(g);
      var a = rand(0, Math.PI * 2);
      var sp = rand(60, 280);
      this.particles.push({
        s: g,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: rand(0.25, 0.7),
        t: 0,
      });
    }
  };

  FishHunter3000.prototype._burstFx = function (x, y, scl) {
    var s = new PIXI.Sprite(this._radial(0xffd23f, 128));
    s.anchor.set(0.5);
    s.x = x;
    s.y = y;
    s.blendMode = PIXI.BLEND_MODES.ADD;
    s.scale.set(0.1);
    this.fxLayer.addChild(s);
    this.fx.push({ s: s, t: 0, dur: 0.45, kind: "ring", to: scl || 1.2 });
  };

  FishHunter3000.prototype._netFx = function (x, y, color, big) {
    var g = new PIXI.Graphics();
    g.lineStyle(big ? 3 : 2, color || 0x00f5ff, 0.9);
    g.drawCircle(0, 0, 8);
    g.x = x;
    g.y = y;
    g.blendMode = PIXI.BLEND_MODES.ADD;
    this.fxLayer.addChild(g);
    this.fx.push({ s: g, t: 0, dur: big ? 0.45 : 0.28, kind: "ring", to: big ? 0.5 : 0.28 });
  };

  FishHunter3000.prototype._screenFlash = function (color) {
    var g = new PIXI.Graphics();
    g.beginFill(color || 0xffffff, 0.35);
    g.drawRect(0, 0, this.W, this.H);
    g.endFill();
    g.blendMode = PIXI.BLEND_MODES.ADD;
    this.fxLayer.addChild(g);
    this.fx.push({ s: g, t: 0, dur: 0.24, kind: "fade" });
  };

  FishHunter3000.prototype._lightning = function (x1, y1, x2, y2) {
    var g = new PIXI.Graphics();
    g.lineStyle(3, 0x44eeff, 0.95);
    var seg = 7, i;
    g.moveTo(x1, y1);
    for (i = 1; i < seg; i++) {
      var t = i / seg;
      g.lineTo(lerp(x1, x2, t) + rand(-14, 14), lerp(y1, y2, t) + rand(-14, 14));
    }
    g.lineTo(x2, y2);
    g.blendMode = PIXI.BLEND_MODES.ADD;
    this.fxLayer.addChild(g);
    this.fx.push({ s: g, t: 0, dur: 0.2, kind: "fade" });
  };

  FishHunter3000.prototype._spawnCoin = function (x, y) {
    var s = new PIXI.Sprite(this._coinTex);
    s.anchor.set(0.5);
    s.x = x;
    s.y = y;
    s.scale.set(rand(0.2, 0.38));
    this.fxLayer.addChild(s);
    var a = rand(-Math.PI, 0);
    var sp = rand(100, 300);
    this.coins.push({
      s: s,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 60,
      t: 0,
      life: rand(0.65, 1.0),
      tx: this.W - 36,
      ty: this.H - 16,
    });
  };

  FishHunter3000.prototype._rainCoin = function () {
    var s = new PIXI.Sprite(this._coinTex);
    s.anchor.set(0.5);
    s.x = rand(0, this.W);
    s.y = -16;
    s.scale.set(rand(0.22, 0.42));
    this.fxLayer.addChild(s);
    this.coins.push({
      s: s,
      vx: rand(-28, 28),
      vy: rand(140, 320),
      t: 0,
      life: rand(1.4, 2.4),
      rain: true,
    });
  };

  FishHunter3000.prototype._floatText = function (txt, x, y, color) {
    var t = new PIXI.Text(txt, {
      fontFamily: "Orbitron, Bungee, Arial",
      fontSize: 20,
      fontWeight: "700",
      fill: color,
      stroke: 0x020818,
      strokeThickness: 4,
    });
    t.anchor.set(0.5);
    t.x = x;
    t.y = y;
    this.fxLayer.addChild(t);
    this.fx.push({ s: t, t: 0, dur: 0.85, kind: "float" });
  };

  FishHunter3000.prototype._flashBanner = function (txt, sub, color) {
    this.banner.text = txt;
    this.banner.style.fill = color || 0xffd23f;
    this.banner.alpha = 1;
    this.banner.scale.set(2);
    this.bannerSub.text = sub || "";
    this.bannerSub.alpha = sub ? 1 : 0;
    this._bannerT = 0;
  };

  /* ---------- per-frame ---------- */
  FishHunter3000.prototype._frame = function (dt) {
    if (!this._active || !this._ready) return;
    this._t += dt;
    var W = this.W, H = this.H;

    this._spawnT -= dt;
    if (this._spawnT <= 0) {
      this._spawnT = this._frenzy > 0 ? rand(0.18, 0.4) : rand(0.55, 1.1);
      if (this.fish.length < 6 || Math.random() < 0.65) {
        this._spawnFish(this._frenzy > 0 ? this._pickWaveFish() : undefined);
      }
    }

    this._fireCd -= dt;
    if (this.lock) this._autoAim();
    if ((this.auto || this._holding || this._frenzy > 0 || (this._boss && this._boss.started)) && this._fireCd <= 0) {
      this._fire(false);
    }

    var da = this._aim - this._barrelAng;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    this._barrelAng += da * Math.min(1, dt * 16);
    if (this.barrel) this.barrel.rotation = this._barrelAng + Math.PI / 2;
    this._recoil = (this._recoil || 0) * 0.78;
    if (this.barrel && this.barrel.y !== undefined) this.barrel.y = this._recoil;

    if (this._frenzy > 0) {
      this._frenzy -= dt;
      if (this._frenzy <= 0 || (this._frenzyExpected || 0) >= this._frenzyBudget) {
        this._frenzy = 0;
        this._clearRoundBullets();
      }
    }

    if (this._bonus) this._updateBonus(dt);
    if (this._bonusFinale) this._updateBonusFinale(dt);
    this._depositPulse = (this._depositPulse || 0) * 0.88;
    if (this._depositPulse < 0.01) this._depositPulse = 0;
    if (this.bgBonus && this.bgBonus.alpha > 0 && !this._bonus && !this._bonusFinale) {
      this.bgBonus.alpha = Math.max(0, this.bgBonus.alpha - dt * 2.5);
    }
    if (this._boss) this._updateBoss(dt);

    var i, f, bi, b, hit, fj, ff;
    for (i = this.fish.length - 1; i >= 0; i--) {
      f = this.fish[i];
      if (!f.alive) {
        f.death += dt;
        var k = f.death / 0.22;
        f.cont.scale.x = (f.flip ? -1 : 1) * f.scale * (1 + k * 0.35);
        f.cont.scale.y = f.scale * (1 + k * 0.35);
        f.cont.alpha = 1 - k;
        if (k >= 1) {
          this.fishLayer.removeChild(f.cont);
          f.cont.destroy({ children: true });
          this.fish.splice(i, 1);
        }
        continue;
      }
      f.cont.x += f.vx * dt;
      f.cont.y += f.vy * dt + Math.sin(this._t * 1.3 + f.r) * 4 * dt;
      var ang = f.flip ? Math.atan2(f.vy, -f.vx) : Math.atan2(f.vy, f.vx);
      f.cont.rotation = ang;
      f.cont.scale.x = (f.flip ? -1 : 1) * f.scale;
      f.cont.scale.y = f.scale;
      if (f.flinch > 0) { f.flinch -= dt; if (f.flinch <= 0) f.spr.tint = 0xffffff; }
      if (f.vx > 0 ? f.cont.x > W + f.r * 3 : f.cont.x < -f.r * 3) {
        this.fishLayer.removeChild(f.cont);
        f.cont.destroy({ children: true });
        this.fish.splice(i, 1);
      }
    }

    for (bi = this.bullets.length - 1; bi >= 0; bi--) {
      b = this.bullets[bi];
      if (!b || !b.s) continue;
      b.s.x += b.vx * dt;
      b.s.y += b.vy * dt;
      if (b.s.x < b.r) { b.s.x = b.r; b.vx = Math.abs(b.vx); }
      else if (b.s.x > W - b.r) { b.s.x = W - b.r; b.vx = -Math.abs(b.vx); }
      if (b.s.y < b.r) { b.s.y = b.r; b.vy = Math.abs(b.vy); }
      else if (b.s.y > H - b.r) { b.s.y = H - b.r; b.vy = -Math.abs(b.vy); }

      if (this._boss && this._boss.started && this._boss.spr && !b.hit && b.bossId === this._boss.id) {
        var bzz = this._boss;
        if (Math.hypot(b.s.x - bzz.spr.x, b.s.y - bzz.spr.y) < bzz.r + b.r) {
          b.hit = true;
          bzz.hp -= 1;
          bzz.flash = 0.12;
          bzz.spr.tint = 0xff8888;
          this._accrueBoss(bzz.inc, bzz.spr.x, bzz.spr.y - bzz.r * 0.5, true);
          this._spawnParticles(b.s.x, b.s.y, 0xff0044, 8);
          if (Math.random() < 0.3) this._spawnCoin(bzz.spr.x + rand(-40, 40), bzz.spr.y);
          this._shake = Math.max(this._shake, 3);
        }
      }
      if (b.hit) { this._rmBullet(b); continue; }
      hit = null;
      for (fj = 0; fj < this.fish.length; fj++) {
        ff = this.fish[fj];
        if (!ff.alive) continue;
        if (Math.hypot(b.s.x - ff.cont.x, b.s.y - ff.cont.y) < ff.r + b.r) { hit = ff; break; }
      }
      if (hit) this._resolveHit(b, hit);
      if (b.hit) this._rmBullet(b);
    }

    for (i = this.coins.length - 1; i >= 0; i--) {
      var c = this.coins[i];
      c.t += dt;
      var ck = c.t / c.life;
      if (c.rain) {
        c.vy += 220 * dt;
        c.s.x += c.vx * dt;
        c.s.y += c.vy * dt;
        if (ck > 0.75) c.s.alpha = (1 - ck) / 0.25;
        if (ck >= 1 || c.s.y > H + 30) {
          this.fxLayer.removeChild(c.s);
          c.s.destroy();
          this.coins.splice(i, 1);
        }
        continue;
      }
      if (ck < 0.38) {
        c.vy += 480 * dt;
        c.s.x += c.vx * dt;
        c.s.y += c.vy * dt;
      } else {
        var kk = (ck - 0.38) / 0.62;
        c.s.x = lerp(c.s.x, c.tx, kk * 0.3);
        c.s.y = lerp(c.s.y, c.ty, kk * 0.3);
        c.s.alpha = 1 - kk;
      }
      if (ck >= 1) {
        this.fxLayer.removeChild(c.s);
        c.s.destroy();
        this.coins.splice(i, 1);
      }
    }

    for (i = this.particles.length - 1; i >= 0; i--) {
      var p = this.particles[i];
      p.t += dt;
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      p.vy += 180 * dt;
      p.s.alpha = 1 - p.t / p.life;
      if (p.t >= p.life) {
        this.particleLayer.removeChild(p.s);
        p.s.destroy();
        this.particles.splice(i, 1);
      }
    }

    for (i = this.fx.length - 1; i >= 0; i--) {
      var e = this.fx[i];
      e.t += dt;
      var k2 = Math.min(1, e.t / e.dur);
      if (e.kind === "ring") {
        e.s.scale.set(lerp(0.04, e.to, 1 - Math.pow(1 - k2, 3)));
        e.s.alpha = 1 - k2;
      } else if (e.kind === "flash") {
        e.s.alpha = 1 - k2;
        e.s.scale.set((0.25 + k2 * 0.5) * (this._cannonK || 1));
      } else if (e.kind === "fade") {
        e.s.alpha = 1 - k2;
      } else if (e.kind === "float") {
        e.s.y -= 36 * dt;
        e.s.alpha = k2 < 0.65 ? 1 : 1 - (k2 - 0.65) / 0.35;
      }
      if (k2 >= 1) {
        this.fxLayer.removeChild(e.s);
        e.s.destroy();
        this.fx.splice(i, 1);
      }
    }

    if (this.banner.alpha > 0) {
      this._bannerT += dt;
      var bk = Math.min(1, this._bannerT / 0.3);
      var eb = 1 + 2.70158 * Math.pow(bk - 1, 3) + 1.70158 * Math.pow(bk - 1, 2);
      this.banner.scale.set(2 + (1 - 2) * eb);
      if (this._bannerT > 1.2) {
        this.banner.alpha = Math.max(0, this.banner.alpha - dt * 1.5);
        this.bannerSub.alpha = this.banner.alpha;
      }
    }
    if (this._comboT > 0) {
      this._comboT -= dt;
      if (this._comboT <= 0) this._combo = 0;
    }
    if (this.comboText) {
      this.comboText.alpha = this._combo >= 2 ? 1 : 0;
      this.comboText.text = this._combo >= 2 ? "COMBO x" + this._combo : "";
      this.comboText.x = W / 2;
      this.comboText.y = 36;
    }

    this._drawHud();
    this._shake = (this._shake || 0) * 0.84;
    if (this._shake < 0.15) this._shake = 0;
    this.app.stage.x = (Math.random() - 0.5) * this._shake;
    this.app.stage.y = (Math.random() - 0.5) * this._shake;
  };

  FishHunter3000.prototype._autoAim = function () {
    var best = null, bs = -1, i, f, s;
    for (i = 0; i < this.fish.length; i++) {
      f = this.fish[i];
      if (!f.alive) continue;
      s = f.def.mult - Math.hypot(f.cont.x - this.cannon.x, f.cont.y - this.cannon.y) * 0.015;
      if (s > bs) { bs = s; best = f; }
    }
    if (best) {
      this._aim = clamp(Math.atan2(best.cont.y - this.cannon.y, best.cont.x - this.cannon.x), -(Math.PI - 0.08), -0.08);
    }
  };

  /* ---------- HUD ---------- */
  FishHunter3000.prototype._usd = function (n) {
    return "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  FishHunter3000.prototype._drawHud = function () {
    if (!this.jpBar) return;
    var W = this.W, H = this.H, g = this.jpBar;
    g.clear();
    var bw = Math.min(280, W * 0.52), bh = 11, x = W / 2 - bw / 2, y = 12;
    g.beginFill(0x020818, 0.75);
    g.drawRoundedRect(x - 3, y - 3, bw + 6, bh + 6, 6);
    g.endFill();
    g.lineStyle(1, 0x00f5ff, 0.4);
    g.drawRoundedRect(x - 3, y - 3, bw + 6, bh + 6, 6);
    g.beginFill(0x0a1830);
    g.drawRoundedRect(x, y, bw, bh, 4);
    g.endFill();

    var inBoss = !!this._boss;
    var counting = !!(this._bonus && !this._bonus.started);
    var finale = !!this._bonusFinale;
    var bth = finale ? this._bonusFinale.th : (BONUS_THEME[this._frenzyKind] || BONUS_THEME.frenzy);
    var fr = this._frenzy > 0 ? clamp((this._frenzyExpected || 0) / (this._frenzyBudget || 1), 0, 1)
      : counting ? clamp(this._bonus.countT / 3, 0, 1)
      : finale ? 1
      : (inBoss && this._boss.hpMax ? Math.max(0, this._boss.hp / this._boss.hpMax) : this._jackpot);
    var barCol = (this._frenzy > 0 || counting || finale) ? bth.color : (inBoss ? 0xff0044 : 0xff3dff);
    g.beginFill(barCol);
    g.drawRoundedRect(x, y, bw * fr, bh, 4);
    g.endFill();

    this.jpText.x = W / 2;
    this.jpText.y = y + bh + 3;
    this.jpText.text = this._frenzy > 0 ? (bth.name + "  +$" + (this._frenzyWon || 0).toFixed(0))
      : counting ? (bth.name + " INCOMING…")
      : finale ? (bth.name + "  +$" + (this._bonusFinale.won || 0).toFixed(2))
      : (inBoss ? ("LEVIATHAN  " + Math.max(0, Math.ceil(this._boss.hp)) + " HP  +$" + (this._boss.won || 0).toFixed(0))
              : ("JACKPOT  " + Math.floor(this._jackpot * 100) + "%"));

    this.powText.anchor.set(0, 1);
    this.powText.x = 10;
    this.powText.y = H - 4;
    this.powText.text = "PWR " + this.power + "  ·  " + this._usd(this.cost()) + "/shot";

    this.balText.anchor.set(1, 1);
    this.balText.x = W - 10;
    this.balText.y = H - 4;
    var balShow = this.balance;
    var fz2 = this._bonusFinale;
    if (fz2 && fz2.paid && fz2.won > 0) {
      var dpp = clamp((fz2.t - 1.8) / 1.2, 0, 1);
      balShow = this.balance - fz2.won * (1 - dpp);
    }
    this.balText.text = "◈ " + this._usd(balShow);
    this.balText.scale.set(1 + (this._depositPulse || 0) * 0.45);

    this.banner.x = W / 2;
    this.banner.y = H * 0.38;
    this.bannerSub.x = W / 2;
    this.bannerSub.y = H * 0.38 + 32;
  };

  FishHunter3000.prototype._renderHud = function () {
    if (this.balText) this.balText.text = "◈ " + this._usd(this.balance);
    if (this.powText) this.powText.text = "PWR " + this.power + "  ·  " + this._usd(this.cost()) + "/shot";
    var e = this.els;
    if (e.betVal) e.betVal.textContent = this._usd(this.unitBet);
    if (e.power) e.power.textContent = String(this.power);
    if (e.cost) e.cost.textContent = this._usd(this.cost()) + " / shot";
    if (e.balance) e.balance.textContent = this._usd(this.balance);
    if (e.win) e.win.textContent = this._usd(this._won || 0);
    if (e.sesSpent) e.sesSpent.textContent = this._usd(this._sesSpent || 0);
    if (e.sesWon) e.sesWon.textContent = this._usd(this._sesWon || 0);
    if (e.sesNet) {
      var net = Math.round(((this._sesWon || 0) - (this._sesSpent || 0)) * 100) / 100;
      e.sesNet.textContent = (net >= 0 ? "+" : "−") + this._usd(Math.abs(net));
    }
  };

  FishHunter3000.prototype._save = function () {
    if (this.onBalance) try { this.onBalance(this.balance); } catch (e) {}
  };

  /* ---------- input ---------- */
  FishHunter3000.prototype._wireInput = function () {
    var self = this;
    var move = function (e) {
      var p = e.touches ? e.touches[0] : e;
      if (p) self._pointAt(p.clientX, p.clientY);
    };
    var down = function (e) {
      if (!self._active) return;
      e.preventDefault();
      var Cw = root.Chiptune;
      if (Cw && Cw.wake) try { Cw.wake(); } catch (er) {}
      var p = e.touches ? e.touches[0] : e;
      if (p) self._pointAt(p.clientX, p.clientY);
      self._holding = true;
      if (!self.auto) self._fire(true);
    };
    var up = function () { self._holding = false; };
    this._bindLater = function () {
      var v = self.app.view;
      v.addEventListener("mousemove", move);
      v.addEventListener("touchmove", move, { passive: false });
      v.addEventListener("mousedown", down);
      v.addEventListener("touchstart", down, { passive: false });
      window.addEventListener("mouseup", up);
      window.addEventListener("touchend", up);
      window.addEventListener("touchcancel", up);
      window.addEventListener("pointercancel", up);
      window.addEventListener("blur", up);
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
          self._holding = false;
          try { self.app.ticker.stop(); } catch (e) {}
        } else if (self._active && self._ready) {
          try { self.app.ticker.start(); } catch (e) {}
        }
      });
      var el = self.els;
      if (el.betSlider) el.betSlider.addEventListener("input", function () {
        self.setBet(parseFloat(el.betSlider.value) || MIN_BET);
      });
      if (el.powerUp) el.powerUp.addEventListener("click", function () { self.setPower(self.power + 1); });
      if (el.powerDown) el.powerDown.addEventListener("click", function () { self.setPower(self.power - 1); });
      if (el.autoBtn) el.autoBtn.addEventListener("click", function () { self.toggleAuto(); });
      if (el.lockBtn) el.lockBtn.addEventListener("click", function () { self.toggleLock(); });
    };
    setTimeout(this._bindLater, 0);
  };

  /* ---------- host bridge ---------- */
  FishHunter3000.prototype._teardownRounds = function () {
    if (this._boss && this._boss.spr) {
      try { this.bossLayer.removeChild(this._boss.spr); this._boss.spr.destroy(); } catch (e) {}
    }
    this._boss = null;
    this._bonus = null;
    this._bonusFinale = null;
    this._frenzyId++;
    this._frenzy = 0;
    this._frenzyWon = 0;
    this._frenzyExpected = 0;
    this._holding = false;
    this._clearRoundBullets();
    if (this.bgBonus) this.bgBonus.alpha = 0;
    try { this._renderHud(); } catch (e) {}
  };

  FishHunter3000.prototype.setActive = function (on) {
    on = !!on;
    if (on === this._active) return;
    this._active = on;
    var self = this;
    if (on) {
      if (this._ready) this.app.ticker.start();
      setTimeout(function () { try { self._resize(); } catch (e) {} }, 50);
    } else {
      try { this._teardownRounds(); } catch (e) {}
      this.app.ticker.stop();
      this._holding = false;
      try { this._fsExit(this._fsTarget); } catch (e) {}
    }
  };

  FishHunter3000.prototype.setEnabled = function (on) { this._enabled = !!on; this._renderHud(); };
  FishHunter3000.prototype.setBalance = function (usd) {
    this.balance = Math.max(0, Math.round((+usd || 0) * 100) / 100);
    this._renderHud();
  };
  FishHunter3000.prototype.setBet = function (v) {
    this.unitBet = clamp(Math.round((+v || MIN_BET) * 100) / 100, MIN_BET, MAX_BET);
    this._renderHud();
  };
  FishHunter3000.prototype.setPower = function (p) {
    this.power = clamp(p | 0, 1, MAX_POWER);
    this._renderHud();
  };
  FishHunter3000.prototype.toggleAuto = function () {
    this.auto = !this.auto;
    this._holding = false;
    if (this.els.autoBtn) this.els.autoBtn.classList.toggle("on", this.auto);
  };
  FishHunter3000.prototype.toggleLock = function () {
    this.lock = !this.lock;
    if (this.els.lockBtn) this.els.lockBtn.classList.toggle("on", this.lock);
  };
  FishHunter3000.prototype.newSession = function () {
    this._sesSpent = 0;
    this._sesWon = 0;
    try { this._teardownRounds(); } catch (e) {}
    this._renderHud();
  };
  FishHunter3000.prototype.start = function () { this.setActive(true); };

  FishHunter3000.prototype.setFullscreenTarget = function (el) { this._fsTarget = el; };
  FishHunter3000.prototype.isFullscreen = function () {
    var t = this._fsTarget || this.mount;
    return !!(document.fullscreenElement || (t && t.classList && t.classList.contains("rr-fs")));
  };
  FishHunter3000.prototype.enterFullscreen = function (el, opts) {
    var t = el || this._fsTarget || this.mount;
    opts = opts || {};
    if (!t || !t.classList) return;
    if (!this._fsHome) this._fsHome = { parent: t.parentNode, next: t.nextSibling };
    if (t.parentNode !== document.body) document.body.appendChild(t);
    t.classList.add("rr-fs");
    document.documentElement.classList.add("rr-fs-on");
    document.body.classList.add("rr-fs-on");
    this._fsAuto = !!opts.auto;
    if (!opts.skipNative) {
      try {
        var r = t.requestFullscreen || t.webkitRequestFullscreen;
        if (r) r.call(t);
      } catch (e) {}
    }
    if (this.els.fsBtn) this.els.fsBtn.classList.add("on");
    var self = this;
    setTimeout(function () { self._resize(); }, 60);
    setTimeout(function () { self._resize(); }, 320);
  };
  FishHunter3000.prototype._fsExit = function (t) {
    t = t || this._fsTarget || this.mount;
    if (!t || !t.classList || !t.classList.contains("rr-fs")) return;
    t.classList.remove("rr-fs");
    document.documentElement.classList.remove("rr-fs-on");
    document.body.classList.remove("rr-fs-on");
    this._fsAuto = false;
    if (this._fsHome && this._fsHome.parent) {
      try { this._fsHome.parent.insertBefore(t, this._fsHome.next || null); } catch (e) {}
      this._fsHome = null;
    }
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) {}
    if (this.els.fsBtn) this.els.fsBtn.classList.remove("on");
    var self = this;
    setTimeout(function () { self._resize(); }, 60);
  };
  FishHunter3000.prototype.toggleFullscreen = function (el) {
    var t = el || this._fsTarget || this.mount;
    if (!(t.classList && t.classList.contains("rr-fs"))) this.enterFullscreen(t, { auto: false });
    else this._fsExit(t);
  };

  root.FishHunter3000 = FishHunter3000;
})(typeof globalThis !== "undefined" ? globalThis : this);
