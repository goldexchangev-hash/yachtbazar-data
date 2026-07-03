/* ============================================================
   fishshooter.js — "FISH SHOOTER": a premium top-down fish-table (Ocean King
   style) rendered with PixiJS v7 using the Grok-generated ANIMATED art pack.
   A NEW game = an upgraded Reef Raiders. MONEY/ODDS reuse fishtable-engine.js
   UNCHANGED (RTP 0.85 kills + self-budgeting 5% jackpot rake → ~10% house edge).

   Alive: every fish is a real PIXI.AnimatedSprite (4 Grok swim frames), travels
   and rotates to its heading; living seabed (caustics, seaweed sway, bubbles);
   cannon aims + fires energy orbs; catches burst into spinning coins + floating
   +$. Fully responsive: renders at the container's actual size and reflows on
   resize / orientation, with reparent-to-<body> fullscreen.

   Host bridge mirrors FishTable (Reef): setActive/setEnabled/setBalance/setEthUsd/
   setBet/setPower/toggleAuto/toggleLock/toggleFullscreen/newSession + onBalance/onWin.
   ============================================================ */
(function (root) {
  "use strict";
  var PIXI = root.PIXI, E = root.FishShooterEngine; // OWN engine, decoupled from Reef Raiders (fishtable-engine.js)
  var DIR = "/assets/fishshooter/";
  // P5: version-stamp every texture URL so the service worker treats the ~25MB fish pack as immutable
  // (cache-first) instead of network-first — otherwise each of the 150+ files costs a round-trip per session.
  // Dedicated token, NOT the site build number: bump fs1→fs2 ONLY when a texture file is actually replaced.
  var ASSET_Q = "?v=fs1";
  var JACKPOT_RAKE = 0.02; // % of every paid shot skimmed to the boss-jackpot pool. KEPT LOW (was 0.05) so the
  // RTP is FELT on regular catches instead of being locked inside a rare boss round — the boss is a small
  // cherry on top, not where most of your money hides. The bulk of the return rides the kill-prob knob (catches).
  var MIN_BET = 1, MAX_BET = 50, MAX_POWER = 2; // power 2 cap: at x3 with fast auto-fire, high per-shot kill-prob makes redundant bullets OVERKILL already-dead fish (wasted paid shots), cratering realized RTP to ~72% (renderer-measured). x1/x2 keep waste small → realized ~92%. The bet slider is the main stake dial; power is a modest speed/stake boost.
  // Shooting-speed cooldowns (seconds/shot). ONE rate governs EVERY fire path — manual taps, auto-fire,
  // AND bonus/boss free shots — so you can never tap-spam the dragon faster than the chosen speed. FAST
  // ≈ 9 shots/s = a brisk "fast clicking" cap, never faster.
  var FIRE_CD = { slow: 0.30, medium: 0.18, fast: 0.11 };
  var FISH_KEYS = ["minnow", "clown", "tang", "puffer", "turtle", "squid", "eel", "bomb", "crab", "clam", "shark", "kraken", "whale", "lobster", "armadillo", "anglerfish", "seadragon", "warturtle", "gator", "stormjelly"];
  // per-creature animation frame count (default 4); the new creatures are authored at 8 for smoother motion
  var FRAMES = { eel: 8, lobster: 8, armadillo: 8, anglerfish: 8, seadragon: 8, warturtle: 8, gator: 8, stormjelly: 8 };
  function frameCount(k) { return FRAMES[k] || 4; }
  // The high-weight common fish that fill the board at start → load these (+ background, cannon,
  // shot/catch FX) in the CRITICAL first phase. Every other creature loads in the background.
  var FSH_COMMON = ["minnow", "clown", "tang", "puffer", "turtle", "squid"];

  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  function FishShooter(opts) {
    opts = opts || {};
    this.els = opts.els || {};
    this.mount = opts.mount;
    // Gameplay FILLS the whole screen (no letterbox). Assets scale with the screen via
    // uiScale so a fish looks the same size in portrait & landscape (never stretched), and
    // the spawn cap keeps the SAME count of fish on screen in every view — so no view shows
    // more/less of the board, while still using every pixel.
    this.cW = opts.width || 960; this.cH = opts.height || 600;
    this.W = this.cW; this.H = this.cH;
    this._scale = 1; this._offX = 0; this._offY = 0; // world transform = identity (full-screen)
    this.uiScale = 1;
    this.ethUsd = opts.ethUsd || 3400;
    this.onBalance = opts.onBalance || null;
    this.onWin = opts.onWin || null;
    this.onReady = opts.onReady || null; // host hides the loading screen + reveals the channel when this fires
    this.balance = opts.initialBalance != null ? opts.initialBalance : 5000;
    this.unitBet = MIN_BET; this.power = 1; this.fireSpeed = "fast"; // slow | medium | fast (caps EVERY fire path)
    this._active = false; this._enabled = true; this.auto = false; this.lock = false;
    this.engine = E.create();

    this.fish = []; this.bullets = []; this.coins = []; this.bubbles = []; this.fx = []; this.weeds = [];
    this._t = 0; this._spawnT = 0; this._fireCd = 0; this._aim = -Math.PI / 2; this._barrelAng = -Math.PI / 2;
    this._won = 0; this._combo = 0; this._comboT = 0; this._jackpot = 0; this._jackpotPool = 0;
    this._sesSpent = 0; this._sesWon = 0;
    this._frenzy = 0; this._frenzyMax = 0; this._frenzyWon = 0; this._frenzyBudget = 0; this._frenzyId = 0; this._frenzyUnit = MIN_BET; this._frenzyPow = 1;
    this._boss = null; this._bossId = 0; // active jackpot boss bonus round (id bumps each round)
    this._bonus = null; this._frenzyKind = "frenzy"; // active wave bonus round (frenzy/vault/storm) + its theme
    this._bonusFinale = null; this._depositPulse = 0; // end-of-round reveal → deposit-to-bank sequence
    this._holding = false; this._ready = false; this.tex = {};

    this._initPixi();
    this._wireInput();
    this._load();
  }

  /* ---------- pixi + responsive ---------- */
  FishShooter.prototype._initPixi = function () {
    var self = this;
    this._measure();
    var app = new PIXI.Application({
      width: this.cW, height: this.cH, backgroundColor: 0x05203a, antialias: true,
      resolution: Math.min(2, root.devicePixelRatio || 1), autoDensity: true,
    });
    this.app = app; this.view = app.view;
    var s = app.view.style; s.width = "100%"; s.height = "100%"; s.display = "block"; s.touchAction = "none";
    if (this.mount) this.mount.appendChild(app.view);
    app.ticker.autoStart = false; app.ticker.stop();
    this._tick = function () { self._frame(Math.min(0.05, app.ticker.deltaMS / 1000)); };
    app.ticker.add(this._tick);
    this._onResize = function () { self._resize(); };
    window.addEventListener("resize", this._onResize);
    window.addEventListener("orientationchange", function () { setTimeout(self._onResize, 80); setTimeout(self._onResize, 360); });
  };
  FishShooter.prototype._measure = function () {
    // Gameplay FILLS the whole screen — W/H track the container, no letterbox. uiScale sizes
    // assets off the SHORTER dimension so a fish looks the same in portrait & landscape and is
    // never stretched, while the spawn cap keeps the same count of fish on screen in any view.
    var el = this.mount;
    var w = (el && el.clientWidth) || this.cW, h = (el && el.clientHeight) || this.cH;
    if (w < 40) w = this.cW; if (h < 40) h = this.cH;
    this.cW = w; this.cH = h; this.W = w; this.H = h;
    this._scale = 1; this._offX = 0; this._offY = 0;
    this.uiScale = clamp(Math.min(w, h) / 460, 0.6, 1.6);
  };
  FishShooter.prototype._resize = function () {
    if (!this.app) return;
    var oldW = this.cW, oldH = this.cH;
    this._measure();
    try { this.app.renderer.resize(this.cW, this.cH); } catch (e) {}
    if (this._ready && (oldW !== this.cW || oldH !== this.cH)) this._layout();
  };
  // Cover-fit a background sprite, but HIDE (never blow up) a tiny/unloaded/placeholder texture,
  // and cap the scale — so a transient critical-asset failure can never produce a full-screen blast.
  FishShooter.prototype._coverBg = function (spr) {
    if (!spr || !spr.texture) return;
    var tw = spr.texture.width, th = spr.texture.height;
    if (tw < 32 || th < 32) { spr.visible = false; return; } // not a real background yet → don't render it
    spr.visible = true;
    spr.scale.set(Math.min(8, Math.max(this.cW / tw, this.cH / th)));
    spr.x = this.cW / 2; spr.y = this.cH / 2;
  };
  // (re)position the responsive scene elements for the current W/H
  FishShooter.prototype._layout = function () {
    var W = this.W, H = this.H, cW = this.cW, cH = this.cH;
    // Place + scale the WORLD: contain-fit, centered (letterbox). Same board every view.
    if (this.world) { this.world.scale.set(this._scale); this.world.x = this._offX; this.world.y = this._offY; }
    // Backgrounds COVER the FULL container (raw px) so the letterbox margins show seabed.
    // _coverBg caps the cover-scale so a tiny/unloaded texture can NEVER blow up to fill the
    // screen (the v12.16 "blast"); a real bg only ever needs <~3x.
    this._coverBg(this.bg); this._coverBg(this.bgBonus); this._coverBg(this.bgBoss); this._coverBg(this.bgWorld);
    if (this._boss && this._boss.spr) { var bdw = W * 0.52; this._boss.scale = bdw / this._boss.spr.texture.width; this._boss.r = bdw * 0.4; this._boss.spr.x = W / 2; this._boss.baseY = H * 0.34; }
    if (this.vign) { this.vign.width = W; this.vign.height = H; }
    // Seat the cannon on the bottom edge: drop its center so the base bottom sits
    // just at (slightly into) the screen rim — barrel points up into the play field.
    if (this.cannon) {
      // Responsive turret pinned to the bottom-center. Size off the SHORTER screen
      // dimension so it stays small & consistent in BOTH portrait and landscape
      // (width-based sizing blew up sideways). Seat its center on the bottom rim so
      // only the top HALF of the wheel shows (half-circle mount); the barrel rotates
      // about this fixed pivot.
      var targetDia = clamp(Math.min(W, H) * 0.26, 70, 200); // sizes the (now base-less) barrel
      var k = this._cannonBaseW ? targetDia / this._cannonBaseW : 0.5;
      this._cannonK = k; this.cannon.scale.set(k);
      this.cannon.x = W / 2;
      this.cannon.y = H; // barrel pivot pinned to the VERY BOTTOM-center of the screen — it rotates about this fixed point and emerges from the bottom edge
    }
    // Re-fit every live fish to the CURRENT screen (prevents any stuck/growing sizes).
    for (var fi3 = 0; fi3 < this.fish.length; fi3++) { var ff3 = this.fish[fi3]; if (!ff3 || !ff3.frameW) continue; var dw3 = this._fishDispW(ff3.def); ff3.scale = dw3 / ff3.frameW; ff3.r = dw3 * 0.294; this._sizeLabel(ff3); }
    for (var i = 0; i < this.weeds.length; i++) { var wq = this.weeds[i]; wq.s.x = W * (wq.frac != null ? wq.frac : 0.5); wq.s.y = H + 6; wq.s.scale.set((wq.baseScale != null ? wq.baseScale : 0.6) * this.uiScale); } // refit weed X + scale to current width (was pinned to old width on rotate)
    this._drawHud();
  };

  /* ---------- assets ---------- */
  // TWO-PHASE LOAD. The old path did ONE PIXI.Assets.load() over the whole 77MB pack, which
  // (a) blocked first paint until everything downloaded and (b) was all-or-nothing — a single
  // 404/stalled file rejected the batch, leaving _ready=false → a black screen until a refresh
  // happened to succeed ("needs a few refreshes"). Now:
  //   CRITICAL — the minimum to paint a playable board (background, cannon, the COMMON fish,
  //              shot/catch FX). Loaded first → _build() + _ready + onReady fire fast (~a few MB).
  //   DEFERRED — rare creatures, boss, bonus-world backgrounds, burst/chest FX. Loaded in the
  //              BACKGROUND after first paint; per-asset, failures tolerated (guarded at use).
  // Either phase loads PER-ASSET so one bad file can never block the rest.
  FishShooter.prototype._load = function () {
    var self = this, critical = [], deferred = [];
    FISH_KEYS.forEach(function (n) {
      var fc = frameCount(n), into = FSH_COMMON.indexOf(n) >= 0 ? critical : deferred;
      for (var i = 0; i < fc; i++) into.push({ alias: n + "_" + i, src: DIR + n + "_" + i + ".png" });
    });
    critical.push({ alias: "background", src: DIR + "background.jpg" }); // P7: opaque full-screen fill → JPG (696KB png → 276KB jpg); new filename auto-cache-busts, old .png kept one cycle for rollback
    ["seaweed", "cannon_base", "cannon_barrel", "bullet", "muzzle", "net", "coin"].forEach(function (n) { critical.push({ alias: n, src: DIR + n + ".png" }); });
    for (var csp = 0; csp < 4; csp++) critical.push({ alias: "coinspin_" + csp, src: DIR + "coinspin_" + csp + ".png" }); // catch-coin FX — wanted on the very first catch
    deferred.push({ alias: "boss", src: DIR + "boss.png" });                          // dragon boss (jackpot round, ~45s+ in)
    ["bg_bonus", "bg_boss", "bg_vault", "bg_frenzy", "bg_storm"].forEach(function (n) { deferred.push({ alias: n, src: DIR + n + ".jpg" }); }); // world backgrounds (bonus rounds)
    for (var cb = 0; cb < 9; cb++) deferred.push({ alias: "coinburst_" + cb, src: DIR + "coinburst_" + cb + ".png" });
    for (var ch = 0; ch < 4; ch++) deferred.push({ alias: "chest_" + ch, src: DIR + "chest_" + ch + ".png" });

    self.tex = {};
    self._loadAssets(critical, true, function () {                 // PHASE 1 — must complete to paint
      self._build();
      self._ready = true;
      if (self._active) { try { self.app.ticker.start(); } catch (e) {} }
      if (self.onReady) { try { self.onReady(); } catch (e) {} }   // host: hide the loading screen + reveal
      self._loadAssets(deferred, false, function () { self._refreshBgSprites(); }); // PHASE 2 — background
    });
  };
  // Load a list with a CONCURRENCY CAP + per-asset RETRY. Loading every asset at once flooded the
  // connection on a cold load, so some CRITICAL assets transiently failed → a placeholder was used →
  // (with the old 16px opaque placeholder) _layout scaled it ~40x to fill the screen = the v12.16
  // full-screen "blast" hiding the cannon (it cleared "after a few refreshes" = once cached). Now:
  // retry up to 3x with backoff (transient failures recover IN THE SAME LOAD), cap concurrency so we
  // don't flood, and a persistent CRITICAL failure falls back to a 1x1 TRANSPARENT placeholder
  // (invisible — never a blast; the sprite just doesn't show). DEFERRED failures are left absent
  // (guarded at use). done() fires once EVERY item settles. Never rejects.
  FishShooter.prototype._loadAssets = function (list, placeholderOnFail, done) {
    var self = this, n = list.length, i = 0, finished = 0, CONC = 6;
    if (!n) { if (done) done(); return; }
    function tryLoad(item, attempt) {
      // WEBP: once .webp siblings are generated for the pack (owner: cwebp -q 90 each PNG, keep the PNGs;
      // then set window.FS_WEBP_PACK = true in config.js), prefer them — measured ~50% of the PNG bytes
      // (pack 17.6MB → ~8.5MB; boss.png 1,317,811 → 552,027 @ q0.85). A missing/failed .webp falls back
      // PER-ASSET to the original .png, so a half-generated pack or an old browser is never worse than today.
      // Flag is OFF by default → behavior is byte-identical until the owner opts in. Art pipeline untouched.
      if (tryLoad._w == null) { try { tryLoad._w = root.FS_WEBP_PACK === true && document.createElement("canvas").toDataURL("image/webp").indexOf("data:image/webp") === 0; } catch (e) { tryLoad._w = false; } }
      var src = (tryLoad._w && !item.noWebp && /\.png$/.test(item.src)) ? item.src.replace(/\.png$/, ".webp") : item.src;
      return PIXI.Assets.load(src + ASSET_Q).then(function (t) { self.tex[item.alias] = t; }, function (e) { // P5: ?v=fs1 → SW cache-first
        if (src !== item.src) { item.noWebp = true; return tryLoad(item, attempt); } // .webp missing/broken → immediate fallback to the PNG, same retry budget
        if (attempt < 3) return new Promise(function (r) { setTimeout(r, 250 * attempt); }).then(function () { return tryLoad(item, attempt + 1); });
        if (root.console) console.warn("[fishshooter] asset failed after retries: " + item.alias, e && e.message);
        if (placeholderOnFail) self.tex[item.alias] = self._placeholderTex();
      });
    }
    function next() {
      if (i >= n) return;
      var item = list[i++];
      tryLoad(item, 1).then(function () { finished++; if (finished === n) { if (done) done(); } else next(); });
    }
    for (var k = 0; k < Math.min(CONC, n); k++) next(); // prime the worker pool
  };
  // 1x1 FULLY TRANSPARENT — any scale is invisible, so a failed sprite never renders as a blast.
  FishShooter.prototype._placeholderTex = function () {
    if (this._phTex) return this._phTex;
    var c = document.createElement("canvas"); c.width = c.height = 1; this._phTex = PIXI.Texture.from(c); return this._phTex;
  };
  // Re-point the persistent background sprites once the deferred world backgrounds arrive (they
  // were built against the critical `background` texture as a valid stand-in, so _layout never
  // divides by a zero-width EMPTY texture). bgWorld is left alone if a round is currently showing.
  FishShooter.prototype._refreshBgSprites = function () {
    if (this.bgBonus && this.tex.bg_bonus) this.bgBonus.texture = this.tex.bg_bonus;
    if (this.bgBoss && this.tex.bg_boss) this.bgBoss.texture = this.tex.bg_boss;
    if (this.bgWorld && this.tex.bg_frenzy && !(this._bonus || this._bonusFinale)) this.bgWorld.texture = this.tex.bg_frenzy;
    try { this._layout(); } catch (e) {}
  };

  // Return the n frames for a creature/FX — but [] if ANY frame is missing, invalid, or a
  // placeholder (a deferred/transient-failed asset). Callers check .length and skip, so
  // `new PIXI.AnimatedSprite(frames)` is never handed an undefined/empty array (which throws).
  FishShooter.prototype._frames = function (key, n) {
    var a = [], ph = this._phTex; for (var i = 0; i < n; i++) { var t = this.tex[key + "_" + i]; if (!t || !t.valid || t === ph) return []; a.push(t); } return a;
  };

  /* ---------- scene ---------- */
  FishShooter.prototype._build = function () {
    this._measure(); // fresh size before spawning the initial fish (mount is laid out by now)
    var app = this.app, W = this.W, H = this.H;
    // BACKGROUND layer — raw CONTAINER pixels, cover-fills the whole screen so the
    // letterbox margins show seabed (not bars). NOT inside the scaled world.
    this.bgLayer = new PIXI.Container(); app.stage.addChild(this.bgLayer);
    this.bg = new PIXI.Sprite(this.tex.background); this.bg.anchor.set(0.5); this.bgLayer.addChild(this.bg);
    // The world backgrounds are DEFERRED — until they arrive, stand them up against the critical
    // `background` texture (alpha 0, so invisible) so _layout never divides by a 0-width EMPTY
    // texture. _refreshBgSprites() re-points them to the real art when the deferred load finishes.
    this.bgBonus = new PIXI.Sprite(this.tex.bg_bonus || this.tex.background); this.bgBonus.anchor.set(0.5); this.bgBonus.alpha = 0; this.bgLayer.addChild(this.bgBonus); // (unused — frenzy keeps normal bg)
    this.bgBoss = new PIXI.Sprite(this.tex.bg_boss || this.tex.background); this.bgBoss.anchor.set(0.5); this.bgBoss.alpha = 0; this.bgLayer.addChild(this.bgBoss);   // boss-arena crossfade
    // Bonus-round WORLD (Feeding Frenzy / Treasure Vault / Lightning Storm) — texture swapped per round, crossfaded in.
    this.bgWorld = new PIXI.Sprite(this.tex.bg_frenzy || this.tex.background); this.bgWorld.anchor.set(0.5); this.bgWorld.alpha = 0; this.bgLayer.addChild(this.bgWorld);
    // WORLD container — holds ALL gameplay; contain-fit scaled + centered in _layout, so
    // the SAME 4:3 board shows in every view (portrait / landscape / TV frame).
    this.world = new PIXI.Container(); app.stage.addChild(this.world);

    this.causticLayer = new PIXI.Container(); this.causticLayer.blendMode = PIXI.BLEND_MODES.ADD; this.world.addChild(this.causticLayer);
    var cg = this._radial(0x8fe6ff, 256);
    for (var i = 0; i < 6; i++) { var c = new PIXI.Sprite(cg); c.anchor.set(0.5); c.alpha = 0.09; c.x = rand(0, W); c.y = rand(0, H); c.scale.set(rand(1.6, 3)); c._vx = rand(-7, 7); c._ph = rand(0, 6.28); this.causticLayer.addChild(c); }

    this.weedLayer = new PIXI.Container(); this.world.addChild(this.weedLayer);
    for (var w = 0; w < 2; w++) { var wd = new PIXI.Sprite(this.tex.seaweed); wd.anchor.set(0.5, 1); var wfrac = w === 0 ? 0.2 : 0.8, wbase = rand(0.4, 0.8); wd.scale.set(wbase * this.uiScale); wd.x = W * wfrac; this.weedLayer.addChild(wd); this.weeds.push({ s: wd, ph: rand(0, 6.28), amp: rand(0.05, 0.12), spd: rand(0.5, 1.1), frac: wfrac, baseScale: wbase }); }

    this.bubbleLayer = new PIXI.Container(); this.world.addChild(this.bubbleLayer);
    this.fishLayer = new PIXI.Container(); this.world.addChild(this.fishLayer);
    this.bossLayer = new PIXI.Container(); this.world.addChild(this.bossLayer); // the dragon boss rides above the minions
    this.bulletLayer = new PIXI.Container(); this.world.addChild(this.bulletLayer);
    this.fxLayer = new PIXI.Container(); this.world.addChild(this.fxLayer);
    this._bubTex = this._bubbleTex();
    this._glowTex = this._radial(0x4dff7a, 128); // small neon-green glow halo for the little bullets
    for (var b = 0; b < 22; b++) this._spawnBubble(true);

    // depth vignette — frames the PLAY rect (world coords)
    this.vign = new PIXI.Sprite(this._vignTex()); this.world.addChild(this.vign);

    // cannon: base + rotating barrel — bottom-center of the PLAY rect
    this.cannon = new PIXI.Container(); this.world.addChild(this.cannon);
    var base = new PIXI.Sprite(this.tex.cannon_base); base.anchor.set(0.5); base.scale.set(0.5);
    this._cannonBaseW = base.width; this._cannonBaseH = base.height; // kept ONLY as a sizing reference
    base.visible = false; // the ornate gear "circle" is removed — just the barrel shows, pinned to the bottom
    this.barrel = new PIXI.Sprite(this.tex.cannon_barrel); this.barrel.anchor.set(0.5, 1.0); this.barrel.scale.set(0.5, 0.25); this.cannon.addChild(this.barrel); // 50% shorter barrel (half height)
    this._barrelTipLen = this.barrel.height; // anchor at the barrel BOTTOM → it touches the screen edge & pivots there; tip is a full barrel-length up

    // HUD — in the world so it tracks the play rect (corners of the BOARD, not the screen)
    this.hud = new PIXI.Container(); this.world.addChild(this.hud);
    this.jpBar = new PIXI.Graphics(); this.hud.addChild(this.jpBar);
    var mk = function (sz, fill) { return new PIXI.Text("", { fontFamily: "Bungee, Arial", fontSize: sz, fontWeight: "700", fill: fill, stroke: 0x041326, strokeThickness: sz * 0.16 }); };
    this.jpText = mk(15, 0xffd23f); this.jpText.anchor.set(0.5, 0); this.hud.addChild(this.jpText);
    this.balText = mk(20, 0x9be8ff); this.hud.addChild(this.balText);
    this.winText = mk(20, 0x45f0a6); this.winText.anchor.set(1, 0); this.hud.addChild(this.winText);
    this.powText = mk(14, 0xffe08a); this.powText.anchor.set(0.5, 1); this.hud.addChild(this.powText);
    this.banner = mk(42, 0xffd23f); this.banner.anchor.set(0.5); this.banner.alpha = 0; this.hud.addChild(this.banner);
    this.bannerSub = mk(22, 0xffffff); this.bannerSub.anchor.set(0.5); this.bannerSub.alpha = 0; this.hud.addChild(this.bannerSub);

    for (var f = 0; f < 7; f++) this._spawnFish();
    this._layout(); this._renderHud();
  };

  FishShooter.prototype._radial = function (color, size) {
    var c = document.createElement("canvas"); c.width = c.height = size; var x = c.getContext("2d");
    var g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    var r = color >> 16 & 255, gg = color >> 8 & 255, bb = color & 255;
    g.addColorStop(0, "rgba(" + r + "," + gg + "," + bb + ",1)"); g.addColorStop(1, "rgba(" + r + "," + gg + "," + bb + ",0)");
    x.fillStyle = g; x.fillRect(0, 0, size, size); return PIXI.Texture.from(c);
  };
  FishShooter.prototype._bubbleTex = function () {
    var c = document.createElement("canvas"); c.width = c.height = 32; var x = c.getContext("2d");
    x.strokeStyle = "rgba(190,230,255,0.7)"; x.lineWidth = 2; x.beginPath(); x.arc(16, 16, 12, 0, 6.3); x.stroke();
    x.fillStyle = "rgba(255,255,255,0.5)"; x.beginPath(); x.arc(11, 11, 3.2, 0, 6.3); x.fill(); return PIXI.Texture.from(c);
  };
  FishShooter.prototype._vignTex = function () {
    var s = 256, c = document.createElement("canvas"); c.width = c.height = s; var x = c.getContext("2d");
    var g = x.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s * 0.72);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(2,8,18,0.55)"); x.fillStyle = g; x.fillRect(0, 0, s, s);
    return PIXI.Texture.from(c);
  };

  /* ---------- fish (animated) ---------- */
  // Display width is a PURE function of the CURRENT screen (recomputed every layout), so a
  // fish can NEVER get stuck at a stale/growing size across resizes or refreshes.
  FishShooter.prototype._fishDispW = function (def) {
    var dw = Math.min(def.r * 3.4 * (this.uiScale || 1) * 2.5, Math.min(this.W, this.H) * 0.7);
    return def.sizeMul ? dw * def.sizeMul : dw; // per-creature size tweak (e.g. whale 0.7 = 30% smaller)
  };
  // Counter-scale the x-multiplier label so it's the SAME readable on-screen size on every
  // creature (small or large), and apply the travel-direction flip so it never reads backwards.
  FishShooter.prototype._sizeLabel = function (f) {
    if (!f.lbl) return;
    var target = clamp(Math.min(this.W, this.H) * 0.046, 21, 39); // ~35% smaller; uniform on every creature so eel/turtle stay readable
    var cs = target / (50 * (f.scale || 1)); // 50 = base fontSize; cancels the container's f.scale
    f.lbl.scale.set((f.flip ? -1 : 1) * cs, cs);
  };
  FishShooter.prototype._spawnFish = function (forceDef) {
    if (this.fish.length > 14) return;
    var def = forceDef || this.engine.pickFish();
    var nf = frameCount(def.key);
    var frames = this._frames(def.key, nf);
    if (!frames.length) return; // frames not all loaded yet (deferred/transient) → skip this spawn
    var spr = new PIXI.AnimatedSprite(frames);
    // 8-frame creatures read smooth at a lower per-tick speed; 4-frame ones need it faster to feel alive.
    spr.anchor.set(0.5); spr.animationSpeed = nf >= 8 ? rand(0.11, 0.16) : rand(0.16, 0.26); spr.play();
    var cont = new PIXI.Container(); cont.addChild(spr);
    var dispW = this._fishDispW(def); var scale = dispW / frames[0].width; cont.scale.set(scale);

    if (def.special) { this._glowCache = this._glowCache || {}; var gtex = this._glowCache[def.color] || (this._glowCache[def.color] = this._radial(def.color, 256)); var gl = new PIXI.Sprite(gtex); gl.anchor.set(0.5); gl.alpha = 0.4; gl.blendMode = PIXI.BLEND_MODES.ADD; gl.scale.set((def.r * 6) / 256 / scale); cont.addChildAt(gl, 0); } // cache glow texture by color (was leaking a 256px texture per spawn)
    var lbl = new PIXI.Text("x" + def.mult, { fontFamily: "Bungee, Arial", fontSize: 50, fontWeight: "700", fill: 0xffffff, stroke: 0x041326, strokeThickness: 7 });
    lbl.anchor.set(0.5); lbl.y = frames[0].height * 0.34; lbl.alpha = 0.9; cont.addChild(lbl); // just under the body; size kept CONSISTENT + flipped via _sizeLabel

    var fromLeft = Math.random() < 0.5;
    var y = rand(this.H * 0.12, this.H * 0.8);
    var speed = def.tier === "boss" ? 34 : rand(48, 92);
    var fobj = { def: def, cont: cont, spr: spr, vx: (fromLeft ? 1 : -1) * speed, vy: rand(-14, 14), r: dispW * 0.294, scale: scale, frameW: frames[0].width, lbl: lbl, alive: true, flip: !fromLeft, flinch: 0 };
    this._sizeLabel(fobj); // consistent on-screen label size regardless of creature size, + correct flip
    cont.x = fromLeft ? -dispW : this.W + dispW; cont.y = y;
    this.fishLayer.addChild(cont); this.fish.push(fobj);
  };

  FishShooter.prototype._spawnBubble = function (anywhere) {
    var s = new PIXI.Sprite(this._bubTex); s.anchor.set(0.5); s.x = rand(0, this.W); s.y = anywhere ? rand(0, this.H) : this.H + 10;
    var sc = rand(0.3, 1); s.scale.set(sc); s.alpha = rand(0.3, 0.7); this.bubbleLayer.addChild(s);
    this.bubbles.push({ s: s, vy: rand(18, 44), wob: rand(0.5, 1.4), ph: rand(0, 6.28) });
  };

  /* ---------- aim + fire ---------- */
  FishShooter.prototype._pointAt = function (gx, gy) {
    if (this.lock) return;
    var r = this.app.view.getBoundingClientRect();
    // client → container px → world coords (undo the contain-fit transform)
    var cx = (gx - r.left) / r.width * this.cW, cy = (gy - r.top) / r.height * this.cH;
    var x = (cx - this._offX) / this._scale, y = (cy - this._offY) / this._scale;
    var dx = x - this.cannon.x, dy = y - this.cannon.y;
    if (dy > -30) dy = -30;
    this._aim = clamp(Math.atan2(dy, dx), -(Math.PI - 0.1), -0.1);
  };
  FishShooter.prototype.cost = function () { return Math.round(this.unitBet * this.power * 100) / 100; };
  // True when a token session is open → each PAID shot settles per-shot with the server
  // (server engine v2 also disburses the bonus/splash EV), and the local demo ledger /
  // jackpot meter / double bonus-triggers are all gated off.
  FishShooter.prototype._tokenActive = function () { return !!(root.TokenMode && root.TokenMode.active()); };
  FishShooter.prototype._fire = function (manual) {
    if (!this._active || !this._enabled || !this._ready) return;
    if (this._boss && !this._boss.started) return;   // hold fire during the boss 3-2-1 countdown
    if (this._bonus && !this._bonus.started) return; // hold fire during the bonus-world 3-2-1 countdown
    if (this._bonusFinale) return;                   // hold fire during the end-of-round reveal + deposit
    var free = this._frenzy > 0 || !!this._boss;
    // Cooldown gate. FREE (bonus/boss) shots are ALWAYS paced by the speed setting — no tap-spamming
    // the dragon. Auto-fire/hold also respects it. But a MANUAL tap on a PAID shot fires as fast as
    // you can click (it's fun, and RTP-neutral — every shot still returns ~92%, you just spend faster).
    if ((this._fireCd || 0) > 0 && (free || !manual)) return;
    var su = free ? this._frenzyUnit : this.unitBet, sp = free ? this._frenzyPow : this.power;
    var paid = Math.round(su * sp * 100) / 100, cost = free ? 0 : paid;
    if (!free && this.balance < cost) { this._flashBanner("INSUFFICIENT", "add funds", 0xff5d72); return; }
    // v6 #12: TOKEN debits on the SERVER when a bullet CONNECTS (in _resolveHit), not at fire — so require the
    // balance to also cover the stakes of paid shots STILL IN FLIGHT (unsettled), else rapid taps queue more than
    // the balance covers. Derived from the bullets array (never leaks). Demo debits at fire so its balance already
    // reflects this. (v12.99: the DISPLAY also subtracts this same in-flight sum so the charge shows the INSTANT you
    // tap — see _renderTv balShow — while this.balance stays the authoritative server value.)
    if (!free && this._tokenActive()) {
      var pend = 0;
      for (var pi = 0; pi < this.bullets.length; pi++) { var pb = this.bullets[pi]; if (pb && !pb.free && !pb.settled && (pb.cost || 0) > 0) pend += pb.cost; }
      if (this.balance < cost + pend) { this._flashBanner("EASY!", "let your shots land", 0xffd23f); return; }
    }
    if (cost > 0) {
      this._sesSpent = Math.round((this._sesSpent + cost) * 100) / 100;
      // TOKEN: the server debits the stake on each per-shot bet (in _resolveHit) and there is no client jackpot rake
      // — the server's flat RTP already includes everything (the DISPLAY shows the debit instantly via the in-flight
      // subtraction). DEMO: debit the play-money stake at fire + skim the rake into the self-funded jackpot pool.
      if (!this._tokenActive()) { this.balance = Math.round((this.balance - cost) * 100) / 100; this._jackpotPool = Math.round((this._jackpotPool + cost * JACKPOT_RAKE) * 100) / 100; }
      this._save(); this._renderHud();
    }
    var ang = this._aim, md = (this._barrelTipLen || 44) * (this._cannonK || 1), tx = this.cannon.x + Math.cos(ang) * md, ty = this.cannon.y + Math.sin(ang) * md;
    // Little glowing bullet: a small stretched core + an additive glow halo, much
    // smaller than before, oriented along its travel direction.
    var bs = 0.038 + sp * 0.007;
    var b = new PIXI.Container(); b.x = tx; b.y = ty; b.rotation = ang + Math.PI / 2;
    var glow = new PIXI.Sprite(this._glowTex); glow.anchor.set(0.5); glow.blendMode = PIXI.BLEND_MODES.ADD; glow.scale.set(bs * 3.6); glow.alpha = 0.5; b.addChild(glow);
    var core = new PIXI.Sprite(this.tex.bullet); core.anchor.set(0.5); core.tint = 0xc8ffd6; core.scale.set(bs, bs * 1.8); b.addChild(core);
    this.bulletLayer.addChild(b);
    var speed = 1040 + sp * 30; // faster bullets connect sooner → fewer redundant in-flight shots at a fish that already died (less auto-fire overkill → higher REALIZED rtp, esp. at power 2)
    while (this.bullets.length > 120) this._rmBullet(this.bullets[0]); // higher cap → bullets ricochet until they connect instead of being culled (culled = paid-but-wasted, which craters realized RTP)
    this.bullets.push({ s: b, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, r: 7 + sp * 1.1, hit: false, unitBet: su, power: sp, cost: paid, free: free, frenzyId: free ? this._frenzyId : 0, bossId: (this._boss && this._boss.started) ? this._bossId : 0 });
    this._recoil = 7; this._muzzle(tx, ty);
    if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {}
    this._fireCd = FIRE_CD[this.fireSpeed] || FIRE_CD.fast; // ONE rate governs EVERY path (manual tap, auto-hold, bonus/boss free shots) — tap-spamming the dragon can NEVER exceed the chosen speed
  };
  FishShooter.prototype._muzzle = function (x, y) {
    var mk = (this._cannonK || 1) * 1.5; // muzzle flash tracks the (now small) barrel
    var s = new PIXI.Sprite(this.tex.muzzle); s.anchor.set(0.5); s.x = x; s.y = y; s.rotation = this._aim + Math.PI / 2; s.blendMode = PIXI.BLEND_MODES.ADD; s.scale.set(0.3 * mk); this.fxLayer.addChild(s);
    this.fx.push({ s: s, t: 0, dur: 0.16, kind: "flash", mk: mk });
  };
  FishShooter.prototype._rmBullet = function (b) { if (!b) return; try { if (b.s) { this.bulletLayer.removeChild(b.s); b.s.destroy(); } } catch (e) {} var i = this.bullets.indexOf(b); if (i >= 0) this.bullets.splice(i, 1); };
  // Remove EVERY bonus/boss (free) bullet — called the instant any round ends so a leftover round
  // shot can never ricochet into normal play and pop a creature (it has no power off-round anyway).
  FishShooter.prototype._clearRoundBullets = function () { for (var i = this.bullets.length - 1; i >= 0; i--) { var b = this.bullets[i]; if (b && (b.free || b.bossId)) this._rmBullet(b); } };

  FishShooter.prototype._resolveHit = function (b, fish) {
    b.hit = true;
    if (this._boss) { this._catchCosmetic(fish, b.s.x, b.s.y); return; } // boss round: minions pop for show only
    if (b.free && (this._frenzy <= 0 || b.frenzyId !== this._frenzyId)) { this._net(b.s.x, b.s.y, fish.def.color); return; } // stale free bullet after the wave → no catch
    // ── TOKEN MODE: a PAID shot is a server-settled micro-bet. The server engine (v2) returns
    //    the catch AND, on a bonus/splash fish, the disbursed bonus/splash total — all folded
    //    into r.tokens. We render from the authoritative result; local money is never touched.
    if (this._tokenActive() && !b.free) {
      var self = this, shot = { unitBet: b.unitBet, power: b.power, cost: b.cost, free: false };
      var epoch = (self._tokenEpoch = self._tokenEpoch || 0); // v11 #1: pin the epoch so an off-channel resolve (after setActive(false) bumps it) can't re-arm a bonus on a screen you already left
      this._net(b.s.x, b.s.y, fish.def.color); // immediate net FX (latency-friendly)
      root.TokenMode.bet("fishshooter", b.cost, { targetKey: fish.def.key, power: b.power }).then(function (r) {
        b.settled = true; // v12.99: server resolved this shot → it leaves the in-flight display sum (balShow) + the over-bet pend, and the bullet loop may now remove it
        if (epoch !== self._tokenEpoch || !self._active) { if (root.TokenMode && root.TokenMode.paintTokens) root.TokenMode.paintTokens(); return; } // v11 #1: left the channel / mode changed → keep the top token bar synced but suppress off-channel bonus/catch
        var bonus = r && r.win && r.outcome && r.outcome.bonus && r.outcome.bonus.total > 0 ? r.outcome.bonus : null;
        var inBonus = self._bonus || self._bonusFinale; // a bonus round is already animating → HOLD the HUD; it reveals at the finale
        if (!inBonus) {
          // OWNER: a bonus win must land when the FINALE animation ends, not the instant the trigger fish dies.
          // The server already folded the whole bonus total into r.tokens — so when a bonus triggers, show only
          // the stake + the direct catch now (full total MINUS the bonus), and bank the bonus at _updateBonusFinale.
          self.balance = bonus
            ? Math.round((root.TokenMode.tokens() - bonus.total) * 100) / 100
            : root.TokenMode.tokens(); // authoritative (stake debited + any payout/disbursement)
          self._tokenRevealUntil = Date.now() + 520; // brief hold so a normal win reveals AFTER the burst (a buy-in/top-up still forces through)
        }
        if (r && r.win) {
          if (fish.alive) self._catch(fish, shot); // direct-catch FX (local credit + local triggers gated in _catch)
          if (bonus) self._startTokenBonus(bonus, shot); // server-driven wave (its total reveals at the finale, not here)
        } else if (fish.alive && !inBonus) { fish.flinch = 0.16; fish.spr.tint = 0xff8888; }
        // Hold the balance HUD until the catch/blow-up has played out — otherwise the new total reveals the
        // win/loss before the fish bursts and spoils it. Skip the repaint entirely while a bonus is running so
        // the held balance can't flash the bonus total early. Sync the TOP token bar at the same beat.
        setTimeout(function () { if (!(self._bonus || self._bonusFinale)) { self._renderHud(); if (root.TokenMode && root.TokenMode.paintTokens) root.TokenMode.paintTokens(); } }, 480);
      }).catch(function (e) { b.settled = true; if (epoch !== self._tokenEpoch || !self._active) { if (root.TokenMode && root.TokenMode.paintTokens) root.TokenMode.paintTokens(); return; } if (!(self._bonus || self._bonusFinale)) { self.balance = root.TokenMode.tokens(); self._renderHud(); if (root.TokenMode && root.TokenMode.paintTokens) root.TokenMode.paintTokens(); } }); // v11 #1: drop an off-channel resolve; transactional bridge: a rejected bet cost nothing (settled ⇒ leaves the in-flight sum, balance recovers)
      return;
    }
    if (b.free) { // accumulate the EXPECTED value this connecting free shot delivers; the wave ends when it reaches the budget (variable realized payout)
      this._frenzyExpected = (this._frenzyExpected || 0) + fish.def.mult * this.engine.killProb(fish.def, b.power) * (b.unitBet || this._frenzyUnit || 1);
    }
    var shot = { unitBet: b.unitBet, power: b.power, cost: b.cost, free: !!b.free };
    var res = this.engine.resolveHit(fish.def, shot.power);
    this._net(b.s.x, b.s.y, fish.def.color);
    if (res.dead) this._catch(fish, shot); else { fish.flinch = 0.16; fish.spr.tint = 0xff8888; }
  };
  FishShooter.prototype._catch = function (fish, shot, isSplash) {
    if (!fish.alive) return; fish.alive = false;
    var unitBet = shot.unitBet || this.unitBet;
    var payout = Math.round(fish.def.mult * unitBet * 100) / 100;
    if (shot.free) {
      // UNCAPPED real winnings → VARIABLE bonus payout. The wave is bounded by the EXPECTED-value
      // budget (see _resolveHit / _frame), not by clamping each catch, so a lucky big fish really
      // pays big. Accumulated here, deposited all at once in the finale (_updateBonusFinale).
      if (!this._tokenActive()) {
        this._frenzyWon = Math.round((this._frenzyWon + payout) * 100) / 100;
      } else {
        // TOKEN: the SERVER already disbursed the WHOLE wave total (held out of the displayed balance at
        // trigger time — see _resolveHit). REVEAL it one pop at a time so the bonus COUNTER + meter climb
        // with each real catch ("what I win is what I win"), instead of showing the full lump from the start.
        // Each pop counts its natural mult*unit, clamped so the running collected never exceeds the server
        // total. The BALANCE corner itself stays held and deposits once at the finale (owner's "drop the win
        // when the animation ends") — so RTP/total is UNTOUCHED, only the reveal cadence changes.
        var remain = Math.max(0, Math.round(((this._tokenWaveTotal || 0) - (this._tokenWavePaid || 0)) * 100) / 100);
        var inc = Math.min(remain, payout);
        this._tokenWavePaid = Math.round(((this._tokenWavePaid || 0) + inc) * 100) / 100;
        this._frenzyWon = this._tokenWavePaid; // the bonus counter shows what you've COLLECTED so far
        if (inc <= 0) { fish.death = 0; return; } // total already collected → pop silently (no +$0 flash); the wave ends this frame in _frame
        payout = inc; // the coin burst + "+$" float below show the REAL amount collected on THIS pop
      }
    } else {
      // TOKEN: balance is the authoritative server ledger (set in _resolveHit's .then); never credit locally.
      if (!this._tokenActive()) this.balance = Math.round((this.balance + payout) * 100) / 100;
      this._sesWon = Math.round((this._sesWon + payout) * 100) / 100;
    }
    this._won = payout; this._save(); this._renderHud();
    this._combo++; this._comboT = 1.2;
    this._net(fish.cont.x, fish.cont.y, fish.def.color, true);
    this._burst(fish.cont.x, fish.cont.y, clamp(0.55 + fish.def.mult * 0.02, 0.6, 2.6) * 0.49);
    var n = clamp(Math.round(fish.def.mult * 1.4) + 7, 8, 60);
    for (var i = 0; i < n; i++) this._spawnCoin(fish.cont.x, fish.cont.y);
    this._floatText("+$" + payout.toFixed(2), fish.cont.x, fish.cont.y - fish.r, fish.def.tier === "boss" ? 0xffd23f : 0x45f0a6);
    if (fish.def.mult >= 25) this._screenFlash(fish.def.tier === "boss" ? 0xffd23f : 0xffffff);
    if (fish.def.special === "boss") this._flashBanner(fish.def.name.toUpperCase() + "!", "MEGA WIN  +$" + payout.toFixed(2), 0xffd23f);
    else if (fish.def.mult >= 25) this._flashBanner("BIG WIN", fish.def.name + "  +$" + payout.toFixed(2), 0xffe08a);
    else if (this._combo >= 4) this._flashBanner("COMBO x" + this._combo, "", 0x39e7ff);
    var C = root.Chiptune; if (C) try { if (fish.def.special === "boss" && C.jackpot) C.jackpot(); else if (fish.def.mult >= 20 && C.bigwin) C.bigwin(); else if (C.coin) C.coin(); } catch (e) {}
    if (this.onWin && payout >= Math.max(0.01, shot.cost || unitBet) * 8) try { this.onWin({ profitUsd: payout - (shot.free ? 0 : (shot.cost || 0)), mult: fish.def.mult }); } catch (e) {}
    // JACKPOT ROUND meter (self-funding pool). The Abyssal Angler SPIKES it; any boss-tier
    // kill SURGES it — so killing big creatures randomly pushes you into the jackpot round.
    if (!shot.free && !this._boss && !this._bonus && !this._bonusFinale && !isSplash && !this._tokenActive()) { // TOKEN: no self-funded jackpot meter (server RTP is flat; a server-side progressive is future v3)
      var bump = 0.0048 * (shot.power || 1); // fills ~2x faster → boss jackpot fires ~twice as often, so the (now smaller 2%) rake comes back in MORE FREQUENT, smaller bursts instead of one rare lump
      if (fish.def.key === "anglerfish") bump = 0.30;
      else if (fish.def.tier === "boss") bump += 0.10;
      this._jackpot = clamp(this._jackpot + bump, 0, 1); if (this._jackpot >= 1) this._startBossRound();
    }
    // specials + bonus-round triggers (all funded through existing channels — see fishtable-engine.js)
    if (!isSplash) {
      // Lightning Storm round: every free kill arcs chain-lightning to nearby fish (payouts still
      // capped by the frenzy budget in _resolveHit/_catch, so the round total stays ≤ its budget).
      if (this._frenzy > 0 && this._frenzyKind === "storm" && shot.free) this._chain(fish, shot);
      if (fish.def.special === "bomb") this._bomb(fish, shot);   // splash renders in token too (server already paid splash.total)
      else if (fish.def.special === "chain") this._chain(fish, shot);
      // TOKEN: the wave/boss is triggered by the SERVER's disbursement (_startTokenBonus in
      // _resolveHit's .then), never locally — else it would double-fire.
      if (!this._tokenActive()) {
        if (fish.def.bonus === "frenzy" && this._canBonus()) this._startBonus("frenzy", shot);   // Magma Lobster / Treasure Clam → Feeding Frenzy world
        else if (fish.def.bonus === "chest" && this._canBonus()) this._startBonus("vault", shot); // Gold Crab / Armored Reef Crab → Treasure Vault world
        else if (fish.def.bonus === "storm" && this._canBonus()) this._startBonus("storm", shot); // Electric Eel → Lightning Storm world
        else if (fish.def.key === "seadragon" && this._canBonus()) this._startBossRound();         // Royal Sea Dragon → boss round
      }
    }
    fish.death = 0;
    // (frenzy no longer ends early on the budget — it runs its full timer; payouts stay capped in _resolveHit)
  };
  // One splash/chain kill-roll. For a FREE (bonus-wave) roll, accrue its expected value toward the
  // wave budget too — otherwise the bomb/storm-chain extra kills would pay on top of the budget and
  // break the house edge. (E[payout] per roll = mult*p, so accruing mult*p keeps it unbiased.)
  FishShooter.prototype._splashRoll = function (def, power, free, unitBet) {
    var sr = this.engine.resolveSplash(def, power);
    if (free) this._frenzyExpected = (this._frenzyExpected || 0) + def.mult * sr.p * (unitBet || this._frenzyUnit || 1);
    return sr.dead;
  };
  FishShooter.prototype._bomb = function (src, shot) {
    this._explosion(src.cont.x, src.cont.y, 0xff7a3d);
    // v6 #25: TOKEN paid splash = VISUAL ONLY. The server already paid the authoritative splash.total for the
    // bomb catch (folded into r.tokens); despawning nearby fish from a CLIENT Math.random roll would remove
    // real shootable fish the server never settled — robbing future real bets. Keep the explosion, skip the kills.
    if (this._tokenActive() && !shot.free) return;
    var t = this.fish.filter(function (o) { return o.alive && o !== src; }).map(function (o) { return { o: o, d: Math.hypot(o.cont.x - src.cont.x, o.cont.y - src.cont.y) }; }).filter(function (z) { return z.d < 160; }).sort(function (a, b) { return a.d - b.d; }).slice(0, 4);
    for (var i = 0; i < t.length; i++) { var o = t[i].o; if (this._splashRoll(o.def, shot.power, shot.free, shot.unitBet)) this._catch(o, shot, true); }
  };
  FishShooter.prototype._chain = function (src, shot) {
    var visualOnly = this._tokenActive() && !shot.free; // v6 #25: keep the lightning arcs, but in token paid play don't despawn shootable fish from a client roll (server paid splash.total already)
    var t = this.fish.filter(function (o) { return o.alive && o !== src; }).map(function (o) { return { o: o, d: Math.hypot(o.cont.x - src.cont.x, o.cont.y - src.cont.y) }; }).sort(function (a, b) { return a.d - b.d; }).slice(0, 3);
    var px = src.cont.x, py = src.cont.y;
    for (var i = 0; i < t.length; i++) { var o = t[i].o; this._lightning(px, py, o.cont.x, o.cont.y); px = o.cont.x; py = o.cont.y; if (!visualOnly && this._splashRoll(o.def, shot.power, shot.free, shot.unitBet)) this._catch(o, shot, true); }
  };
  FishShooter.prototype._awardJackpot = function () {
    var amt = Math.round(this._jackpotPool * 100) / 100; this._jackpot = 0;
    if (amt < this.unitBet) return; this._jackpotPool = 0;
    this.balance = Math.round((this.balance + amt) * 100) / 100; this._won = amt; this._sesWon = Math.round((this._sesWon + amt) * 100) / 100; this._save(); this._renderHud();
    this._flashBanner("JACKPOT!", "+$" + amt.toFixed(2), 0xffd23f);
    for (var i = 0; i < 60; i++) this._rainCoin();
    if (this.onWin) try { this.onWin({ profitUsd: amt, bonus: true }); } catch (e) {}
    var C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
  };
  // BONUS_THEME: per-round world background + banner + accent. All are free-shot WAVE rounds,
  // funded by the trigger creature's pre-paid budget (25× unitBet) — house edge unchanged.
  var BONUS_THEME = {
    frenzy: { name: "FRENZY", bg: "bg_frenzy", title: "⚡ FEEDING FRENZY ⚡", sub: "FREE SHOTS!", color: 0x45f0a6 },
    vault:  { name: "VAULT",  bg: "bg_vault",  title: "💰 TREASURE VAULT 💰", sub: "FREE SHOTS!", color: 0xffd23f },
    storm:  { name: "STORM",  bg: "bg_storm",  title: "🌩 LIGHTNING STORM 🌩", sub: "FREE CHAIN SHOTS!", color: 0x2bd6ff },
  };
  // Bonus-wave spawn roster: PLAIN fish only (EV per connecting shot = RTP*cost, so the expected-
  // value budget stays an unbiased estimator), with the mid-bosses (shark/kraken) BOOSTED so you get
  // real shots at BIG fish during a bonus. NO bonus/splash creatures (they'd re-arm a round or skew
  // the accounting), and not the very top bosses (bounds the variance).
  var WAVE_SPAWN = [
    { key: "minnow", w: 9 }, { key: "clown", w: 8 }, { key: "tang", w: 7 }, { key: "puffer", w: 6 },
    { key: "turtle", w: 5 }, { key: "squid", w: 4 }, { key: "shark", w: 2.4 }, { key: "kraken", w: 1.1 },
  ];
  var WAVE_TOTW = WAVE_SPAWN.reduce(function (a, x) { return a + x.w; }, 0);
  FishShooter.prototype._pickWaveFish = function () {
    var r = Math.random() * WAVE_TOTW, acc = 0;
    for (var i = 0; i < WAVE_SPAWN.length; i++) { acc += WAVE_SPAWN[i].w; if (r < acc) return E.BY_KEY[WAVE_SPAWN[i].key]; }
    return E.BY_KEY.minnow;
  };
  FishShooter.prototype._startFrenzy = function (dur, shot, kind) {
    if (this._frenzy > 0 || this._boss) return; // never stack a wave on an active boss round
    kind = kind || "frenzy"; this._frenzyKind = kind;
    var th = BONUS_THEME[kind] || BONUS_THEME.frenzy;
    this._frenzyId++; this._frenzy = dur; this._frenzyMax = dur; this._frenzyWon = 0; this._frenzyExpected = 0;
    if (this._tokenActive()) { this._frenzyWon = 0; this._tokenWavePaid = 0; } // token: COLLECT the server total one pop at a time (climbs in _catch) — "what I win is what I win", not a lump reveal
    this._frenzyUnit = shot.unitBet || this.unitBet;
    this._frenzyPow = 1; // free shots are POWER 1 → the wave is a CONSISTENT length at every bet/power
    // VARIABLE PAYOUT (no more "always 1250"): the wave pays the player's REAL, UNCAPPED free-shot
    // winnings and ends when the EXPECTED value delivered (accumulated in _resolveHit) reaches the
    // pre-paid budget (25× unitBet). So E[payout] = budget EXACTLY (house edge intact, power-neutral),
    // but the realized amount SWINGS — a lucky shark/kraken pays big, a cold run pays small.
    this._frenzyBudget = Math.round(this._frenzyUnit * 25 * 100) / 100;
    if (this.bgWorld && this.tex[th.bg]) { try { this.bgWorld.texture = this.tex[th.bg]; this._layout(); } catch (e) {} } // swap to this round's world
    this._flashBanner(th.title, th.sub, th.color);
    this._screenFlash(th.color);
    for (var i = 0; i < 8; i++) { (function (self) { setTimeout(function () { if (self._active && self._frenzy > 0) self._spawnFish(self._pickWaveFish()); }, i * 120); })(this); }
  };
  // ── shared bonus-WAVE launcher: 3-2-1 countdown → world crossfade → free-shot wave ──
  FishShooter.prototype._canBonus = function () { return this._frenzy <= 0 && !this._boss && !this._bonus && !this._bonusFinale; };
  FishShooter.prototype._startBonus = function (kind, shot) {
    if (!this._canBonus()) return;
    this._bonus = { kind: kind, shot: { unitBet: shot.unitBet, power: shot.power, cost: shot.cost, free: !!shot.free }, countT: 0, lastNum: 99, started: false };
    // v6 #10: clear in-flight PAID shots the instant a bonus wave triggers — mirror the boss round (which
    // already does this at _updateBoss). Otherwise a pre-wave paid bullet still travels and can hit a FREE
    // wave fish: in token mode that fires an unexpected mid-wave server bet on connect; in demo it debits/
    // credits as a stray paid shot instead of contributing to the wave. Refund the debited stake in DEMO only
    // (token paid shots debit on HIT — which removing the bullet prevents — so there is nothing to refund).
    var refund = 0;
    for (var bi = this.bullets.length - 1; bi >= 0; bi--) { var pbb = this.bullets[bi]; if (pbb && !pbb.free && !pbb.bossId) { if (!this._tokenActive() && pbb.cost > 0) refund += pbb.cost; this._rmBullet(pbb); } }
    if (refund > 0) { refund = Math.round(refund * 100) / 100; this.balance = Math.round((this.balance + refund) * 100) / 100; this._sesSpent = Math.round((this._sesSpent - refund) * 100) / 100; this._save(); this._renderHud(); }
    this._shake = 30;
    var C = root.Chiptune; if (C) try { (C.bigwin || C.jackpot || function () {})(); } catch (e) {}
  };
  // TOKEN: a bonus-trigger fish was caught and the SERVER disbursed the wave total (real money,
  // already in r.tokens). Render the same wave; it pays the server total at the finale (no local
  // deposit). kind: server "chest"→"vault", else "storm"/"frenzy".
  FishShooter.prototype._startTokenBonus = function (serverBonus, shot) {
    if (!this._canBonus()) return;
    this._tokenWaveTotal = Math.round((serverBonus.total || 0) * 100) / 100;
    this._startBonus(serverBonus.kind === "chest" ? "vault" : serverBonus.kind, shot);
  };
  FishShooter.prototype._updateBonus = function (dt) {
    var bz = this._bonus; if (!bz) return;
    if (!bz.started) { // 3-2-1 countdown
      bz.countT += dt;
      var num = 3 - Math.floor(bz.countT);
      if (num !== bz.lastNum) { bz.lastNum = num; if (num > 0) { this._flashBanner(String(num), "GET READY!", 0xffe08a); this._shake = Math.max(this._shake, 4 + (3 - num) * 3); var Cc = root.Chiptune; if (Cc && Cc.blip) try { Cc.blip(); } catch (e) {} } }
      if (bz.countT >= 3) { bz.started = true; this._startFrenzy(10, bz.shot, bz.kind); } // 10s = safety cap; the wave normally ends earlier when the expected budget is delivered
      return;
    }
    if (this._frenzy <= 0) this._endBonusWave(); // wave finished → finale + revert
  };
  FishShooter.prototype._endBonusWave = function () {
    var bz = this._bonus; if (!bz) return; var kind = bz.kind; this._bonus = null;
    this._clearRoundBullets(); // wave over → no free bullet may linger into the finale / normal play
    var th = BONUS_THEME[kind] || BONUS_THEME.frenzy;
    // TOKEN: free wave catches aren't accumulated locally (the server disbursed the whole wave into r.tokens),
    // so the finale "YOU WON" + deposit uses the server bonus total; DEMO uses the locally-accrued _frenzyWon.
    var won = Math.round((this._tokenActive() ? (this._tokenWaveTotal || 0) : (this._frenzyWon || 0)) * 100) / 100;
    // Enter the FINALE: a few-second held reveal of the total, THEN the deposit-to-bank (the wave
    // winnings were accumulated but not yet banked — see _catch). _updateBonusFinale drives it.
    this._bonusFinale = { kind: kind, th: th, won: won, t: 0, dur: 4.4, paid: false, shot: bz.shot };
    // clear leftover wave fish so the reveal panel reads cleanly
    for (var i = this.fish.length - 1; i >= 0; i--) { var f = this.fish[i]; if (f && f.alive) { f.alive = false; f.death = 0; } }
    this._flashBanner(th.name + " COMPLETE!", won > 0 ? "YOU WON  $" + won.toFixed(2) : "NO WIN THIS TIME", th.color);
    this._screenFlash(th.color); this._shake = 18;
    var C = root.Chiptune; if (C && C.bigwin) try { C.bigwin(); } catch (e) {}
  };
  // FINALE: hold the "YOU WON $X" reveal, then bank the total into the bottom-right balance with a
  // coin stream + count-up + pulse, so the deposit is unmistakable (and never too fast to read).
  FishShooter.prototype._updateBonusFinale = function (dt) {
    var fz = this._bonusFinale; if (!fz) return;
    fz.t += dt;
    // keep the WIN panel pinned up through the reveal (don't let the banner auto-fade yet)
    if (fz.t < 1.9) { this.banner.alpha = 1; this.bannerSub.alpha = 1; this._bannerT = Math.min(this._bannerT, 0.9); }
    // DEPOSIT at ~1.9s: bank the total, rain coins into the balance corner, pulse it, ka-ching.
    if (!fz.paid && fz.t >= 1.9) {
      fz.paid = true;
      if (fz.won > 0) {
        // THE DEPOSIT MOMENT (owner's "drop the win when the animation ends"): bank the win NOW.
        // TOKEN: the held HUD (stake+direct-catch only) jumps to the authoritative server total — which already
        // includes this bonus AND any paid shots that connected mid-round — so the bonus lands here, on screen.
        // DEMO: add the locally-accrued wave winnings.
        if (this._tokenActive()) { this.balance = root.TokenMode.tokens(); this._tokenRevealUntil = 0; if (root.TokenMode && root.TokenMode.paintTokens) try { root.TokenMode.paintTokens(); } catch (e) {} }
        else this.balance = Math.round((this.balance + fz.won) * 100) / 100;
        this._sesWon = Math.round((this._sesWon + fz.won) * 100) / 100; this._won = fz.won; this._save();
        if (fz.kind === "vault") this._openChest({ cont: { x: this.W / 2, y: this.H * 0.40 }, r: this.W * 0.12 }, fz.shot); // vault pops its chest on the deposit
        this._flashBanner("YOU WON  $" + fz.won.toFixed(2), "DEPOSITED →", 0xffd23f);
        this._depositPulse = 1; for (var i = 0; i < 70; i++) this._rainCoin();
        var C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
      } else { this._flashBanner((fz.th.name || "BONUS") + " COMPLETE", "", fz.th.color); }
      this._renderHud();
    }
    if (fz.t >= fz.dur) { this._bonusFinale = null; this._renderHud(); } // resume normal play; world bg fades via _frame
  };


  // Chest-burst (Gold Crab / Armored Reef Crab). PURE VISUAL — the catch payout was already
  // metered through the crab's chest budget in the engine; the chest hands out NO extra money.
  FishShooter.prototype._openChest = function (fish, shot) {
    var x = fish.cont.x, y = fish.cont.y, self = this;
    this._flashBanner("TREASURE CHEST!", "", 0xffd23f);
    this._shake = Math.max(this._shake, 10);
    var C = root.Chiptune; if (C && C.bigwin) try { C.bigwin(); } catch (e) {}
    if (this._frames("chest", 4).length) {
      var s = new PIXI.AnimatedSprite(this._frames("chest", 4)); s.anchor.set(0.5); s.x = x; s.y = y;
      s.loop = false; s.animationSpeed = 0.16; s.scale.set((fish.r * 2.7) / s.texture.width); // ~35% smaller chest
      s.onFrameChange = function () { for (var i = 0; i < 5; i++) self._spawnCoin(x + rand(-30, 30), y - 8); };
      s.onComplete = function () { for (var i = 0; i < 36; i++) self._spawnCoin(x + rand(-46, 46), y); self._screenFlash(0xffd23f); self._burst(x, y, 1.8);
        setTimeout(function () { try { self.fxLayer.removeChild(s); s.destroy(); } catch (e) {} }, 1000); }; // open chest lingers ~1s
      this.fxLayer.addChild(s); s.play();
    } else {
      for (var i = 0; i < 36; i++) this._spawnCoin(x + rand(-46, 46), y); this._screenFlash(0xffd23f); this._burst(x, y, 1.8);
    }
  };

  /* ---------- boss bonus round (fires when the BONUS ROUND meter fills) ---------- */
  FishShooter.prototype._startBossRound = function () {
    if (this._boss || this._frenzy > 0 || this._bonus || this._bonusFinale) return; // one round at a time
    this._jackpot = 0;
    // pool = the accumulated jackpot rake; awarded on boss death (house edge preserved).
    this._bossId++;
    this._boss = { id: this._bossId, pool: Math.round(this._jackpotPool * 100) / 100, won: 0, inc: 0, started: false, countT: 0, lastNum: 99, t: 0, dur: 45, minT: 0, flash: 0 };
    this._shake = 30;
    this._flashBanner("JACKPOT ROUND!", "GET READY…", 0xffd23f);
    var C = root.Chiptune; if (C) try { (C.bigwin || C.jackpot || function () {})(); } catch (e) {}
  };
  FishShooter.prototype._spawnBoss = function () {
    if (!this.tex.boss) { this._endBossRound(); return; }
    var spr = new PIXI.Sprite(this.tex.boss); spr.anchor.set(0.5);
    var dispW = this.W * 0.52, scale = dispW / spr.texture.width; spr.scale.set(scale);
    spr.x = this.W / 2; spr.y = this.H * 0.34;
    this.bossLayer.addChild(spr);
    this._boss.spr = spr; this._boss.scale = scale; this._boss.r = dispW * 0.4;
    this._boss.baseY = spr.y; this._boss.hpMax = 150; this._boss.hp = 150; // a real battle — many hits to fell the dragon
    // Dole the purse across the fight: per-hit increment from pool/hpMax with 0.9 headroom
    // (so live credits stay strictly under the purse; the remainder settles at the end).
    var bz = this._boss; var events = Math.max(1, bz.hpMax);
    bz.inc = Math.floor((bz.pool / events) * 0.9 * 100) / 100;
    if (bz.inc < 0.01 && bz.pool > 0) bz.inc = 0.01;
  };
  FishShooter.prototype._updateBoss = function (dt) {
    var bz = this._boss; if (!bz) return;
    if (!bz.started) { // 3-2-1 countdown
      bz.countT += dt;
      var num = 3 - Math.floor(bz.countT);
      if (num !== bz.lastNum) { bz.lastNum = num; if (num > 0) { this._flashBanner(String(num), "GET READY!", 0xffe08a); var Cc = root.Chiptune; if (Cc && Cc.blip) try { Cc.blip(); } catch (e) {} } }
      if (bz.countT >= 3) {
        bz.started = true; bz.t = 0;
        this._flashBanner("FIGHT!", "BLAST THE DRAGON", 0xff4d6a);
        this._spawnBoss(); this._shake = 24;
        // The boss arena clears your in-flight PAID shots (so they don't clutter / dump damage on the
        // dragon). They never got to resolve, so REFUND their cost — the boss round must never "cost
        // you shots". Then drop all pre-boss bullets.
        var refund = 0;
        for (var bi = this.bullets.length - 1; bi >= 0; bi--) { var pbb = this.bullets[bi]; if (this._boss && pbb.bossId !== this._boss.id) { if (!this._tokenActive() && !pbb.free && pbb.cost > 0) refund += pbb.cost; this._rmBullet(pbb); } }
        if (refund > 0) { refund = Math.round(refund * 100) / 100; this.balance = Math.round((this.balance + refund) * 100) / 100; this._sesSpent = Math.round((this._sesSpent - refund) * 100) / 100; this._save(); this._renderHud(); this._floatText("shots refunded +$" + refund.toFixed(2), this.W / 2, this.H * 0.58, 0x45f0a6); }
        var Cg = root.Chiptune; if (Cg && Cg.bigwin) try { Cg.bigwin(); } catch (e) {}
      }
      return;
    }
    bz.t += dt;
    if (bz.spr) {
      bz.spr.y = bz.baseY + Math.sin(this._t * 1.6) * 12;
      bz.spr.x = this.W / 2 + Math.sin(this._t * 0.8) * this.W * 0.16; // sway across the screen — track it
      bz.spr.rotation = Math.sin(this._t * 0.7) * 0.05;
      bz.spr.scale.set(bz.scale * (1 + Math.sin(this._t * 4) * 0.012) * (bz.flash > 0 ? 1.05 : 1));
      if (bz.flash > 0) { bz.flash -= dt; if (bz.flash <= 0) bz.spr.tint = 0xffffff; }
    }
    bz.minT -= dt; if (bz.minT <= 0) { bz.minT = rand(0.5, 1.0); if (this.fish.length < 6) this._spawnFish(E.FISH[(Math.random() * 4) | 0]); }
    if (bz.hp <= 0 || bz.t >= bz.dur) this._endBossRound();
  };
  // Single choke point for boss-round EARNED credits: clamps to the remaining purse, credits
  // balance, tracks bz.won, shows a +$ floater. bz.won can never exceed bz.pool.
  FishShooter.prototype._accrueBoss = function (amount, x, y, isBossHit) {
    var bz = this._boss; if (!bz) return 0;
    var rem = Math.round((bz.pool - bz.won) * 100) / 100;
    if (rem <= 0) return 0;
    var amt = Math.min(Math.round(amount * 100) / 100, rem);
    if (amt <= 0) return 0;
    bz.won = Math.round((bz.won + amt) * 100) / 100;
    this.balance = Math.round((this.balance + amt) * 100) / 100;
    this._won = amt; this._sesWon = Math.round((this._sesWon + amt) * 100) / 100;
    this._save(); this._renderHud();
    this._floatText("+$" + amt.toFixed(2), x, y, isBossHit ? 0xffd23f : 0x45f0a6);
    return amt;
  };
  FishShooter.prototype._catchCosmetic = function (fish) { // boss-round minion pop — EARNED increment
    if (!fish.alive) return; fish.alive = false; fish.death = 0;
    this._net(fish.cont.x, fish.cont.y, fish.def.color, true);
    this._burst(fish.cont.x, fish.cont.y, 0.7);
    for (var i = 0; i < 8; i++) this._spawnCoin(fish.cont.x, fish.cont.y);
    if (this._boss) this._accrueBoss((this._boss.inc || 0) * 0.5, fish.cont.x, fish.cont.y - fish.r, false);
    var C = root.Chiptune; if (C && C.coin) try { C.coin(); } catch (e) {}
  };
  FishShooter.prototype._endBossRound = function () {
    var bz = this._boss; if (!bz) return; this._boss = null;
    this._clearRoundBullets(); // boss over → drop its free shots so they don't bounce into normal play
    if (bz.spr) { this._burst(bz.spr.x, bz.spr.y, 3.0); this._explosion(bz.spr.x, bz.spr.y, 0xffd23f); try { this.bossLayer.removeChild(bz.spr); bz.spr.destroy(); } catch (e) {} }
    this._shake = 28;
    // Pay only the UNDISTRIBUTED remainder so the round total === bz.pool EXACTLY (house edge preserved).
    var rem = Math.round(((bz.pool || 0) - (bz.won || 0)) * 100) / 100;
    if (rem > 0) { this.balance = Math.round((this.balance + rem) * 100) / 100; this._won = rem; this._sesWon = Math.round((this._sesWon + rem) * 100) / 100; }
    this._jackpotPool = 0; this._save(); this._renderHud();
    var total = Math.round((bz.pool || 0) * 100) / 100;
    this._flashBanner("JACKPOT!!!", "+$" + total.toFixed(2) + " EARNED", 0xffd23f);
    this._screenFlash(0xffd23f);
    for (var i = 0; i < 90; i++) this._rainCoin();
    var C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
    if (this.onWin) try { this.onWin({ profitUsd: total, bonus: true }); } catch (e) {}
  };

  /* ---------- fx ---------- */
  FishShooter.prototype._burst = function (x, y, scl) { // juicy additive coin-burst on a catch
    var bf = this._frames("coinburst", 9); if (!bf.length) return; // deferred FX not loaded yet → skip
    var s = new PIXI.AnimatedSprite(bf); s.anchor.set(0.5); s.x = x; s.y = y;
    s.blendMode = PIXI.BLEND_MODES.ADD; s.loop = false; s.animationSpeed = 0.5; s.scale.set(scl || 1);
    var self = this; s.onComplete = function () { try { self.fxLayer.removeChild(s); s.destroy(); } catch (e) {} };
    this.fxLayer.addChild(s); s.play();
  };
  FishShooter.prototype._screenFlash = function (color) {
    var g = new PIXI.Graphics(); g.beginFill(color || 0xffffff, 0.5); g.drawRect(0, 0, this.W, this.H); g.endFill();
    g.blendMode = PIXI.BLEND_MODES.ADD; this.fxLayer.addChild(g); this.fx.push({ s: g, t: 0, dur: 0.28, kind: "fade" });
  };
  FishShooter.prototype._net = function (x, y, color, big) {
    var s = new PIXI.Sprite(this.tex.net); s.anchor.set(0.5); s.x = x; s.y = y; s.tint = big ? 0xffffff : color; s.blendMode = PIXI.BLEND_MODES.ADD; s.scale.set(0.05);
    this.fxLayer.addChild(s); this.fx.push({ s: s, t: 0, dur: big ? 0.5 : 0.3, kind: "ring", to: big ? 0.44 : 0.224 }); // hit + kill rings another 30% smaller
  };
  FishShooter.prototype._explosion = function (x, y, color) { this._explCache = this._explCache || {}; var t = this._explCache[color] || (this._explCache[color] = this._radial(color, 256)); var s = new PIXI.Sprite(t); s.anchor.set(0.5); s.x = x; s.y = y; s.blendMode = PIXI.BLEND_MODES.ADD; s.scale.set(0.2); this.fxLayer.addChild(s); this.fx.push({ s: s, t: 0, dur: 0.4, kind: "ring", to: 1.6 }); this._shake = 14; }; // cache radial by color (was leaking per explosion)
  FishShooter.prototype._lightning = function (x1, y1, x2, y2) { var g = new PIXI.Graphics(); g.lineStyle(3, 0xfff15a, 0.95); var seg = 6; g.moveTo(x1, y1); for (var i = 1; i < seg; i++) { var t = i / seg; g.lineTo(lerp(x1, x2, t) + rand(-12, 12), lerp(y1, y2, t) + rand(-12, 12)); } g.lineTo(x2, y2); g.blendMode = PIXI.BLEND_MODES.ADD; this.fxLayer.addChild(g); this.fx.push({ s: g, t: 0, dur: 0.22, kind: "fade" }); };
  FishShooter.prototype._spawnCoin = function (x, y) { var cf = this._frames("coinspin", 4); if (!cf.length) return; var s = new PIXI.AnimatedSprite(cf); s.anchor.set(0.5); s.animationSpeed = 0.4; s.play(); s.x = x; s.y = y; s.scale.set(rand(0.18, 0.34)); this.fxLayer.addChild(s); var a = rand(-Math.PI, 0), sp = rand(120, 320); this.coins.push({ s: s, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 70, t: 0, life: rand(0.7, 1.1), tx: this.W - 38, ty: this.H - 18 }); };
  FishShooter.prototype._rainCoin = function () { var cf = this._frames("coinspin", 4); if (!cf.length) return; var s = new PIXI.AnimatedSprite(cf); s.anchor.set(0.5); s.animationSpeed = 0.4; s.play(); s.x = rand(0, this.W); s.y = -20; s.scale.set(rand(0.2, 0.4)); this.fxLayer.addChild(s); this.coins.push({ s: s, vx: rand(-30, 30), vy: rand(150, 340), t: 0, life: rand(1.6, 2.6), rain: true }); };
  FishShooter.prototype._floatText = function (txt, x, y, color) { var t = new PIXI.Text(txt, { fontFamily: "Bungee, Arial", fontSize: 22, fontWeight: "700", fill: color, stroke: 0x041326, strokeThickness: 4 }); t.anchor.set(0.5); t.x = x; t.y = y; this.fxLayer.addChild(t); this.fx.push({ s: t, t: 0, dur: 0.9, kind: "float" }); };
  FishShooter.prototype._flashBanner = function (txt, sub, color) { this.banner.text = txt; this.banner.style.fill = color; this.banner.alpha = 1; this.banner.scale.set(2.2); this.bannerSub.text = sub || ""; this.bannerSub.alpha = sub ? 1 : 0; this._bannerT = 0; };

  /* ---------- per-frame ---------- */
  FishShooter.prototype._frame = function (dt) {
    if (!this._active || !this._ready) return;
    this._t += dt; var W = this.W, H = this.H;

    this._spawnT -= dt;
    if (this._spawnT <= 0) { this._spawnT = this._frenzy > 0 ? rand(0.2, 0.45) : rand(0.6, 1.3); if (this.fish.length < 5 || Math.random() < 0.6) this._spawnFish(this._frenzy > 0 ? this._pickWaveFish() : undefined); }

    this._fireCd -= dt;
    if (this.lock) this._autoAim();
    if ((this.auto || this._holding || this._frenzy > 0 || (this._boss && this._boss.started)) && this._fireCd <= 0) this._fire();

    // barrel aim
    var da = this._aim - this._barrelAng; da = Math.atan2(Math.sin(da), Math.cos(da)); this._barrelAng += da * Math.min(1, dt * 14);
    this.barrel.rotation = this._barrelAng + Math.PI / 2;
    this._recoil = (this._recoil || 0) * 0.8; this.barrel.y = this._recoil; // simple axial recoil; barrel bottom stays pinned to cannon.y (= screen bottom)

    // frenzy timer — ends when the pre-paid EXPECTED budget has been delivered (variable realized
    // payout) OR the safety timer runs out. On end, drop ALL unfired/in-flight free bullets so a
    // bonus shot can never ricochet into normal play and pop a creature.
    if (this._frenzy > 0) {
      this._frenzy -= dt;
      // TOKEN: end when the whole SERVER total has been collected pop-by-pop (or the 10s safety timer). The
      // synthetic expected-budget cutoff is DEMO-only — in token play the bar tracks REAL collected/total.
      var tokenDone = this._tokenActive() && (this._tokenWaveTotal || 0) > 0 && (this._tokenWavePaid || 0) >= (this._tokenWaveTotal || 0) - 0.005;
      if (this._frenzy <= 0 || (!this._tokenActive() && (this._frenzyExpected || 0) >= this._frenzyBudget) || tokenDone) {
        this._frenzy = 0;
        this._clearRoundBullets(); // drop ALL in-flight free bullets so none carry into normal play
      }
    }
    if (this._bonus) this._updateBonus(dt); // bonus-world 3-2-1 countdown → wave
    if (this._bonusFinale) this._updateBonusFinale(dt); // reveal total → deposit to bank
    this._depositPulse = (this._depositPulse || 0) * 0.9; if (this._depositPulse < 0.01) this._depositPulse = 0;
    if (this.bgBonus && this.bgBonus.alpha > 0) this.bgBonus.alpha = Math.max(0, this.bgBonus.alpha - dt * 3);
    if (this.bgBoss) { var bbt = this._boss ? 1 : 0; this.bgBoss.alpha += (bbt - this.bgBoss.alpha) * Math.min(1, dt * 2.6); }
    // Bonus rounds (Frenzy / Vault / Storm) crossfade their OWN world in for the whole round (countdown + wave + finale).
    if (this.bgWorld) { var bwt = (this._bonus || this._bonusFinale) ? 1 : 0; this.bgWorld.alpha += (bwt - this.bgWorld.alpha) * Math.min(1, dt * 2.6); }
    if (this._boss) this._updateBoss(dt);

    // fish
    for (var i = this.fish.length - 1; i >= 0; i--) {
      var f = this.fish[i];
      if (!f.alive) { f.death += dt; var k = f.death / 0.25; f.cont.scale.x = (f.flip ? -1 : 1) * f.scale * (1 + k * 0.4); f.cont.scale.y = f.scale * (1 + k * 0.4); f.cont.alpha = 1 - k; if (k >= 1) { this.fishLayer.removeChild(f.cont); f.cont.destroy({ children: true }); this.fish.splice(i, 1); } continue; }
      f.cont.x += f.vx * dt; f.cont.y += f.vy * dt + Math.sin(this._t * 1.2 + (f.r)) * 5 * dt;
      var ang = f.flip ? Math.atan2(f.vy, -f.vx) : Math.atan2(f.vy, f.vx);
      f.cont.rotation = ang; f.cont.scale.x = (f.flip ? -1 : 1) * f.scale; f.cont.scale.y = f.scale;
      if (f.flinch > 0) { f.flinch -= dt; if (f.flinch <= 0) f.spr.tint = 0xffffff; }
      var off = f.vx > 0 ? f.cont.x > W + f.r * 4 : f.cont.x < -f.r * 4;
      if (off) { this.fishLayer.removeChild(f.cont); f.cont.destroy({ children: true }); this.fish.splice(i, 1); }
    }

    // bullets (ricochet off walls)
    for (var bi2 = this.bullets.length - 1; bi2 >= 0; bi2--) {
      var b = this.bullets[bi2]; if (!b || !b.s) continue; b.s.x += b.vx * dt; b.s.y += b.vy * dt; b.s.rotation = Math.atan2(b.vy, b.vx) + Math.PI / 2;
      if (b.s.x < b.r) { b.s.x = b.r; b.vx = Math.abs(b.vx); } else if (b.s.x > W - b.r) { b.s.x = W - b.r; b.vx = -Math.abs(b.vx); }
      if (b.s.y < b.r) { b.s.y = b.r; b.vy = Math.abs(b.vy); } else if (b.s.y > H - b.r) { b.s.y = H - b.r; b.vy = -Math.abs(b.vy); }
      // boss takes priority during the boss round
      if (this._boss && this._boss.started && this._boss.spr && !b.hit && b.bossId === this._boss.id) {
        var bzz = this._boss;
        if (Math.hypot(b.s.x - bzz.spr.x, b.s.y - bzz.spr.y) < bzz.r + b.r) {
          b.hit = true; bzz.hp -= 1; bzz.flash = 0.1; bzz.spr.tint = 0xffd0d0;
          this._accrueBoss(bzz.inc, bzz.spr.x, bzz.spr.y - bzz.r * 0.6, true); // EARNED per hit
          // light hit FX — small spark at the impact only; auto-fire is rapid so keep it subtle so the boss + scene stay visible
          if (Math.random() < 0.22) this._burst(b.s.x, b.s.y, 0.16);
          if (Math.random() < 0.4) this._net(b.s.x, b.s.y, 0xffd23f);
          if (Math.random() < 0.25) this._spawnCoin(bzz.spr.x + rand(-50, 50), bzz.spr.y + rand(-40, 40));
          this._shake = Math.max(this._shake, 2);
        }
      }
      // v12.99: a PAID token shot that has connected but whose server bet hasn't RESOLVED yet stays in the array
      // (hidden, no re-collision) so it keeps counting toward the in-flight display sum until settled — that keeps
      // the tapped-instant debit steady with no flicker. Free/boss bullets (no server bet) are removed normally.
      var awaitSettle = this._tokenActive() && b.hit && !b.free && !b.bossId && !b.settled && (b.cost || 0) > 0;
      if (b.hit) { if (awaitSettle) { if (b.s) b.s.visible = false; continue; } this._rmBullet(b); continue; }
      var hit = null;
      for (var fj = 0; fj < this.fish.length; fj++) { var ff = this.fish[fj]; if (!ff.alive) continue; if (Math.hypot(b.s.x - ff.cont.x, b.s.y - ff.cont.y) < ff.r + b.r) { hit = ff; break; } }
      if (hit) this._resolveHit(b, hit);
      if (b.hit) { var aw2 = this._tokenActive() && !b.free && !b.bossId && !b.settled && (b.cost || 0) > 0; if (aw2) { if (b.s) b.s.visible = false; } else this._rmBullet(b); }
    }

    // coins
    for (var ci = this.coins.length - 1; ci >= 0; ci--) {
      var c = this.coins[ci]; c.t += dt; var ck = c.t / c.life;
      if (c.rain) { c.vy += 240 * dt; c.s.x += c.vx * dt; c.s.y += c.vy * dt; if (ck > 0.8) c.s.alpha = (1 - ck) / 0.2; if (ck >= 1 || c.s.y > H + 40) { this.fxLayer.removeChild(c.s); c.s.destroy(); this.coins.splice(ci, 1); } continue; }
      if (ck < 0.4) { c.vy += 520 * dt; c.s.x += c.vx * dt; c.s.y += c.vy * dt; } else { var kk = (ck - 0.4) / 0.6; c.s.x = lerp(c.s.x, c.tx, kk * 0.32); c.s.y = lerp(c.s.y, c.ty, kk * 0.32); c.s.alpha = 1 - kk; }
      if (ck >= 1) { this.fxLayer.removeChild(c.s); c.s.destroy(); this.coins.splice(ci, 1); }
    }

    // bubbles + caustics + weeds
    for (var ui = this.bubbles.length - 1; ui >= 0; ui--) { var ub = this.bubbles[ui]; ub.s.y -= ub.vy * dt; ub.s.x += Math.sin(this._t * ub.wob + ub.ph) * 10 * dt; if (ub.s.y < -12) { this.bubbleLayer.removeChild(ub.s); ub.s.destroy(); this.bubbles.splice(ui, 1); } }
    if (this.bubbles.length < 22 && Math.random() < 0.25) this._spawnBubble();
    for (var cc = 0; cc < this.causticLayer.children.length; cc++) { var cs = this.causticLayer.children[cc]; cs.x += cs._vx * dt; if (cs.x < -200) cs.x = W + 200; if (cs.x > W + 200) cs.x = -200; cs.alpha = 0.06 + 0.05 * Math.sin(this._t * 0.8 + cs._ph); }
    for (var ww = 0; ww < this.weeds.length; ww++) { this.weeds[ww].s.skew.x = Math.sin(this._t * this.weeds[ww].spd + this.weeds[ww].ph) * this.weeds[ww].amp; }

    // fx
    for (var xi = this.fx.length - 1; xi >= 0; xi--) {
      var e = this.fx[xi]; e.t += dt; var k2 = Math.min(1, e.t / e.dur);
      if (e.kind === "ring") { e.s.scale.set(lerp(0.05, e.to, 1 - Math.pow(1 - k2, 3))); e.s.alpha = 1 - k2; }
      else if (e.kind === "flash") { e.s.alpha = 1 - k2; e.s.scale.set((0.3 + k2 * 0.6) * (e.mk || 1)); }
      else if (e.kind === "fade") { e.s.alpha = 1 - k2; }
      else if (e.kind === "float") { e.s.y -= 40 * dt; e.s.alpha = k2 < 0.7 ? 1 : 1 - (k2 - 0.7) / 0.3; }
      if (k2 >= 1) { this.fxLayer.removeChild(e.s); e.s.destroy(); this.fx.splice(xi, 1); }
    }

    // banner
    if (this.banner.alpha > 0) { this._bannerT += dt; var bk = Math.min(1, this._bannerT / 0.32); var eb = 1 + 2.70158 * Math.pow(bk - 1, 3) + 1.70158 * Math.pow(bk - 1, 2); this.banner.scale.set(2.2 + (1 - 2.2) * eb); if (this._bannerT > 1.3) { this.banner.alpha = Math.max(0, this.banner.alpha - dt * 1.6); this.bannerSub.alpha = this.banner.alpha; } }
    if (this._comboT > 0) { this._comboT -= dt; if (this._comboT <= 0) this._combo = 0; }

    this._drawHud();
    this._shake = (this._shake || 0) * 0.85; if (this._shake < 0.2) this._shake = 0;
    this.app.stage.x = (Math.random() - 0.5) * this._shake; this.app.stage.y = (Math.random() - 0.5) * this._shake;
  };

  FishShooter.prototype._autoAim = function () {
    var best = null, bs = -1;
    for (var i = 0; i < this.fish.length; i++) { var f = this.fish[i]; if (!f.alive) continue; var s = f.def.mult - Math.hypot(f.cont.x - this.cannon.x, f.cont.y - this.cannon.y) * 0.02; if (s > bs) { bs = s; best = f; } }
    if (best) this._aim = clamp(Math.atan2(best.cont.y - this.cannon.y, best.cont.x - this.cannon.x), -(Math.PI - 0.1), -0.1);
  };

  /* ---------- HUD ---------- */
  FishShooter.prototype._usd = function (n) { return "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  FishShooter.prototype._drawHud = function () {
    if (!this.jpBar) return; var W = this.W, H = this.H, g = this.jpBar; g.clear();
    var bw = Math.min(260, W * 0.5), bh = 12, x = W / 2 - bw / 2, y = 14;
    var inBoss = !!this._boss;
    var counting = !!(this._bonus && !this._bonus.started); // bonus-world 3-2-1 pre-wave
    var finale = !!this._bonusFinale; // end-of-round reveal + deposit
    // TOKEN: there is NO self-funded jackpot/boss meter in token play (the pool is a client-side rake, gated
    // off in _catch). So a token player in NORMAL play (no bonus wave / countdown / finale) sees NOTHING here
    // rather than a permanently-stuck "JACKPOT ROUND 0%" meter. The bonus-WAVE meter still renders normally.
    // v12.99: the idle "JACKPOT ROUND %" progress meter is HIDDEN in BOTH modes (owner disabled it). A top meter now
    // renders ONLY for an ACTIVE bonus feature — bonus wave (frenzy), the 3-2-1 countdown, the finale reveal, or a
    // boss HP bar. In plain play there's no top meter (token play was already hidden; this extends it to demo too).
    var idleNoMeter = this._frenzy <= 0 && !counting && !finale && !inBoss;
    if (idleNoMeter) { this.jpText.text = ""; }
    else {
      g.beginFill(0x041326, 0.7); g.drawRoundedRect(x - 3, y - 3, bw + 6, bh + 6, 6); g.endFill();
      g.beginFill(0x0c2840); g.drawRoundedRect(x, y, bw, bh, 5); g.endFill();
      var bth = finale ? (this._bonusFinale.th || BONUS_THEME.frenzy) : (BONUS_THEME[this._frenzyKind] || BONUS_THEME.frenzy);
      // bonus wave = TIME bar (constant); countdown fills the bar; finale = full; else boss HP or the jackpot meter.
      var fr = this._frenzy > 0 ? (this._tokenActive() // TOKEN: fill by REAL collected/total (climbs as you pop); DEMO: fill toward the pre-paid expected budget
          ? clamp((this._tokenWavePaid || 0) / (this._tokenWaveTotal || 1), 0, 1)
          : clamp((this._frenzyExpected || 0) / (this._frenzyBudget || 1), 0, 1))
        : counting ? clamp(this._bonus.countT / 3, 0, 1)
        : finale ? 1
        : (inBoss && this._boss.hpMax ? Math.max(0, this._boss.hp / this._boss.hpMax) : this._jackpot);
      var barCol = (this._frenzy > 0 || counting || finale) ? bth.color : (inBoss ? 0xff4d6a : 0xffd23f);
      g.beginFill(barCol); g.drawRoundedRect(x, y, bw * fr, bh, 5); g.endFill();
      this.jpText.x = W / 2; this.jpText.y = y + bh + 2;
      this.jpText.text = this._frenzy > 0 ? (bth.name + "  +$" + (this._frenzyWon || 0).toFixed(0))
        : counting ? (bth.name + " INCOMING…")
        : finale ? (bth.name + " COMPLETE   YOU WON $" + (this._bonusFinale.won || 0).toFixed(2))
        : (inBoss ? (this._boss.started ? ("BOSS  " + Math.max(0, Math.ceil(this._boss.hp)) + " HP   ·   BONUS +$" + (this._boss.won || 0).toFixed(2)) : "JACKPOT ROUND")
                  : ("JACKPOT ROUND  " + Math.floor(this._jackpot * 100) + "%"));
    }
    // POWER bottom-LEFT, BALANCE bottom-RIGHT (replaced the old WIN readout), bottom
    // CENTER stays clear for the half-circle turret. Per-catch wins show as the floating
    // "+$" pop and the banner, so a persistent WIN number is redundant.
    this.powText.anchor.set(0, 1); this.powText.x = 12; this.powText.y = H - 4;
    this.balText.anchor.set(1, 1); this.balText.x = W - 12; this.balText.y = H - 4;
    // During the bonus finale the banked total COUNTS UP into the balance (so the deposit reads clearly),
    // and the balance label PULSES when the coins land. Normal play shows the live balance unchanged.
    var balShow = this.balance, fz2 = this._bonusFinale;
    // v12.99: TOKEN shows the per-shot debit the INSTANT you tap — subtract paid shots STILL IN FLIGHT (fired but
    // not yet settled by the server). A culled/cleared bullet leaves the array → the balance recovers; a settled hit
    // leaves this sum AND is already reflected in this.balance → no flicker. this.balance stays the authoritative value.
    if (this._tokenActive() && !this._bonus && !this._bonusFinale) { var infl = 0; for (var qi = 0; qi < this.bullets.length; qi++) { var qb = this.bullets[qi]; if (qb && !qb.free && !qb.bossId && !qb.settled && (qb.cost || 0) > 0) infl += qb.cost; } if (infl > 0) balShow = Math.max(0, Math.round((balShow - infl) * 100) / 100); } // v13.00 review: skip the in-flight subtraction during a bonus wave/finale — shots are free there and the finale animates the authoritative server total (a pre-wave shot settling would otherwise jump the count-up)
    if (fz2 && fz2.paid && fz2.won > 0) { var dpp = clamp((fz2.t - 1.95) / 1.3, 0, 1); balShow = balShow - fz2.won * (1 - dpp); }
    this.balText.text = "💰 " + this._usd(balShow);
    this.balText.scale.set(1 + (this._depositPulse || 0) * 0.5);
    if (this.winText) this.winText.visible = false;
    this.banner.x = W / 2; this.banner.y = H * 0.4; this.bannerSub.x = W / 2; this.bannerSub.y = H * 0.4 + 34;
  };
  FishShooter.prototype._renderHud = function () {
    if (this.balText) this.balText.text = "💰 " + this._usd(this.balance);
    if (this.winText) this.winText.text = this._won > 0 ? "WIN " + this._usd(this._won) : "";
    if (this.powText) this.powText.text = "PWR " + this.power + "  ·  " + this._usd(this.cost()) + "/shot";
    var e = this.els;
    if (e.betVal) e.betVal.textContent = this._usd(this.unitBet);
    if (e.power) e.power.textContent = String(this.power); // compact stepper carries its own "POWER" label
    if (e.cost) e.cost.textContent = this._usd(this.cost()) + " / shot";
    // Reef-style session tracker panel (#fishshooter-panel)
    if (e.balance) e.balance.textContent = this._usd(this.balance);
    if (e.win) e.win.textContent = this._usd(this._won || 0);
    if (e.sesSpent) e.sesSpent.textContent = this._usd(this._sesSpent || 0);
    if (e.sesWon) e.sesWon.textContent = this._usd(this._sesWon || 0);
    if (e.sesNet) { var net = Math.round(((this._sesWon || 0) - (this._sesSpent || 0)) * 100) / 100; e.sesNet.textContent = (net >= 0 ? "+" : "−") + this._usd(Math.abs(net)); }
  };
  FishShooter.prototype._save = function () { if (this.onBalance) try { this.onBalance(this.balance); } catch (e) {} };

  /* ---------- input ---------- */
  FishShooter.prototype._wireInput = function () {
    var self = this;
    var move = function (e) { var p = e.touches ? e.touches[0] : e; if (p) self._pointAt(p.clientX, p.clientY); };
    var down = function (e) { if (!self._active) return; e.preventDefault(); var Cw = root.Chiptune; if (Cw && Cw.wake) { try { Cw.wake(); } catch (er) {} } var p = e.touches ? e.touches[0] : e; if (p) self._pointAt(p.clientX, p.clientY); self._holding = true; if (!self.auto) self._fire(true); };
    var up = function () { self._holding = false; };
    this._bindLater = function () {
      var v = self.app.view;
      v.addEventListener("mousemove", move); v.addEventListener("touchmove", move, { passive: false });
      v.addEventListener("mousedown", down); v.addEventListener("touchstart", down, { passive: false });
      window.addEventListener("mouseup", up); window.addEventListener("touchend", up);
      window.addEventListener("touchcancel", up); window.addEventListener("pointercancel", up); window.addEventListener("blur", up);
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) { self._holding = false; try { self.app.ticker.stop(); } catch (e) {} } // pause the loop when backgrounded — no background auto-fire / no frozen-mid-round resuming on return
        else if (self._active) { if (self._ready) { try { self.app.ticker.start(); } catch (e) {} } var C = root.Chiptune; if (C) { try { C.wake && C.wake(); } catch (e) {} } } // resume + re-wake audio (chiptune.js owns the music resync; no playTrack here = no doubled bar / no track-choice clobber)
      });
      window.addEventListener("focus", function () { if (self._active) { var C = root.Chiptune; if (C) { try { C.wake && C.wake(); } catch (e) {} } } }); // re-wake audio after app-switch
      var el = self.els;
      if (el.betSlider) el.betSlider.addEventListener("input", function () { self.setBet(parseFloat(el.betSlider.value) || MIN_BET); });
      if (el.powerUp) el.powerUp.addEventListener("click", function () { self.setPower(self.power + 1); });
      if (el.powerDown) el.powerDown.addEventListener("click", function () { self.setPower(self.power - 1); });
      if (el.autoBtn) el.autoBtn.addEventListener("click", function () { self.toggleAuto(); });
      if (el.lockBtn) el.lockBtn.addEventListener("click", function () { self.toggleLock(); });
      if (el.speedSlow) el.speedSlow.addEventListener("click", function () { self.setFireSpeed("slow"); });
      if (el.speedMed) el.speedMed.addEventListener("click", function () { self.setFireSpeed("medium"); });
      if (el.speedFast) el.speedFast.addEventListener("click", function () { self.setFireSpeed("fast"); });
    };
    setTimeout(this._bindLater, 0);
  };

  /* ---------- host bridge ---------- */
  // Hard-discard any in-progress round on channel exit / demo restart WITHOUT paying out: the jackpot
  // rake stays in _jackpotPool and rolls into the next boss round (house edge preserved); unbanked wave
  // winnings are forfeited (house-favorable). Prevents a stranded auto-firing round from surviving a
  // channel switch — the ticker freezes the round mid-flight otherwise and it resumes auto-firing on return.
  FishShooter.prototype._teardownRounds = function () {
    if (this._boss && this._boss.spr) { try { this.bossLayer.removeChild(this._boss.spr); this._boss.spr.destroy(); } catch (e) {} }
    this._boss = null; this._bonus = null; this._bonusFinale = null;
    this._frenzyId++; this._frenzy = 0; this._frenzyMax = 0; this._frenzyWon = 0; this._frenzyExpected = 0; // bump id → any in-flight free bullet is rejected
    this._tokenWaveTotal = 0; this._tokenWavePaid = 0; // clear the token per-pop collect state so no stale total leaks into the next wave
    this._holding = false;
    for (var i = this.bullets.length - 1; i >= 0; i--) { var b = this.bullets[i]; if (b && (b.free || b.bossId)) this._rmBullet(b); }
    if (this.bgBoss) this.bgBoss.alpha = 0; if (this.bgWorld) this.bgWorld.alpha = 0;
    try { this._renderHud(); } catch (e) {}
  };
  FishShooter.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on; var self = this;
    if (on) {
      if (this._ready) this.app.ticker.start();
      setTimeout(function () { try { self._resize(); } catch (e) {} }, 50);   // re-measure once the layer is shown
      var C = root.Chiptune; if (C) { try { C.wake && C.wake(); } catch (e) {} if (C.playTrack && !this._musicPinned) { this._musicPinned = true; try { C.playTrack("coral"); } catch (e) {} } } // wake audio on entry; pin Coral ONCE so a user-chosen track isn't clobbered on re-entry
    } else { this._tokenEpoch = (this._tokenEpoch || 0) + 1; try { this._teardownRounds(); } catch (e) {} this.app.ticker.stop(); this._holding = false; try { this._fsExit(this._fsTarget); } catch (e) {} } // v11 #1: bump epoch on leave so an in-flight token bet's resolve is dropped (no off-channel bonus re-arm)
  };
  FishShooter.prototype.setEnabled = function (on) { this._enabled = !!on; this._renderHud(); };
  FishShooter.prototype.setBalance = function (usd) { this.balance = Math.max(0, Math.round((+usd || 0) * 100) / 100); this._renderHud(); };
  FishShooter.prototype.setEthUsd = function (n) { if (n > 0) this.ethUsd = n; };
  FishShooter.prototype.setMode = function () {};
  FishShooter.prototype.setBet = function (v) { this.unitBet = clamp(Math.round((+v || MIN_BET) * 100) / 100, MIN_BET, MAX_BET); this._renderHud(); };
  FishShooter.prototype.setPower = function (p) { this.power = clamp(p | 0, 1, MAX_POWER); this._renderHud(); };
  FishShooter.prototype.setFireSpeed = function (s) {
    s = String(s || "fast").toLowerCase(); if (!FIRE_CD[s]) s = "fast";
    this.fireSpeed = s;
    // re-render the speed-segment UI active state
    var e = this.els; if (e && e.speedSlow && e.speedMed && e.speedFast) {
      e.speedSlow.classList.toggle("on", s === "slow"); e.speedMed.classList.toggle("on", s === "medium"); e.speedFast.classList.toggle("on", s === "fast");
      e.speedSlow.setAttribute("aria-pressed", String(s === "slow")); e.speedMed.setAttribute("aria-pressed", String(s === "medium")); e.speedFast.setAttribute("aria-pressed", String(s === "fast"));
    }
    this._renderHud();
  };
  FishShooter.prototype.toggleAuto = function () { this.auto = !this.auto; this._holding = false; if (this.els.autoBtn) { this.els.autoBtn.classList.toggle("on", this.auto); this.els.autoBtn.setAttribute("aria-pressed", String(this.auto)); } };
  FishShooter.prototype.toggleLock = function () { this.lock = !this.lock; if (this.els.lockBtn) { this.els.lockBtn.classList.toggle("on", this.lock); this.els.lockBtn.setAttribute("aria-pressed", String(this.lock)); } };
  FishShooter.prototype.newSession = function () { this._sesSpent = 0; this._sesWon = 0; try { this._teardownRounds(); } catch (e) {} this._renderHud(); };
  FishShooter.prototype.restartDemo = function () { this.auto = false; this.lock = false; this._holding = false; if (this.els.autoBtn) { this.els.autoBtn.classList.remove("on"); this.els.autoBtn.setAttribute("aria-pressed", "false"); } if (this.els.lockBtn) { this.els.lockBtn.classList.remove("on"); this.els.lockBtn.setAttribute("aria-pressed", "false"); } try { this._teardownRounds(); } catch (e) {} this._renderHud(); };
  FishShooter.prototype.start = function () { this.setActive(true); };

  /* fullscreen (reparent-to-body, mirrors Reef) */
  FishShooter.prototype.setFullscreenTarget = function (el) {
    this._fsTarget = el;
    // Android can drop native fullscreen while rotating — keep the CSS shell alive
    // (fishtable/swoop keep-alive parity; was missing here).
    var self = this;
    var sync = function () {
      var real = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!real && el && el.classList && el.classList.contains("rr-fs") && self._fsWasReal) self.enterFullscreen(el, { auto: self._fsAuto, skipNative: true });
      self._fsWasReal = real;
    };
    document.addEventListener("fullscreenchange", sync); document.addEventListener("webkitfullscreenchange", sync);
  };
  FishShooter.prototype.isFullscreen = function () { var t = this._fsTarget || this.mount; return !!(document.fullscreenElement || (t && t.classList && t.classList.contains("rr-fs"))); };
  FishShooter.prototype.enterFullscreen = function (el, opts) {
    var t = el || this._fsTarget || this.mount; opts = opts || {}; if (!t || !t.classList) return;
    if (!this._fsHome) this._fsHome = { parent: t.parentNode, next: t.nextSibling };
    if (t.parentNode !== document.body) document.body.appendChild(t);
    t.classList.add("rr-fs"); document.documentElement.classList.add("rr-fs-on"); document.body.classList.add("rr-fs-on"); this._fsAuto = !!opts.auto;
    // FsUtil: native fullscreen (URL bar gone) where supported + landscape lock on a manual ⛶ tap
    // + tilt re-assertion + iOS/MetaMask fake-mode chrome-collapse. rr-fs shell above unchanged.
    if (root.FsUtil) { try { root.FsUtil.enterFs(t, { skipNative: !!opts.skipNative, lockOrientation: opts.auto ? null : "landscape", landscapeOnly: !!opts.auto }); } catch (e) {} }
    else if (!opts.skipNative) { try { var r = t.requestFullscreen || t.webkitRequestFullscreen; if (r) r.call(t); } catch (e) {} }
    if (this.els.fsBtn) this.els.fsBtn.classList.add("on");
    var self = this; setTimeout(function () { self._resize(); }, 60); setTimeout(function () { self._resize(); }, 320);
  };
  FishShooter.prototype._fsExit = function (t) {
    t = t || this._fsTarget || this.mount; if (!t || !t.classList || !t.classList.contains("rr-fs")) return;
    t.classList.remove("rr-fs"); document.documentElement.classList.remove("rr-fs-on"); document.body.classList.remove("rr-fs-on"); this._fsAuto = false;
    if (this._fsHome && this._fsHome.parent) { try { this._fsHome.parent.insertBefore(t, this._fsHome.next || null); } catch (e) {} this._fsHome = null; }
    if (root.FsUtil) { try { root.FsUtil.exitFs(); } catch (e) {} }
    else { try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) {} }
    if (this.els.fsBtn) this.els.fsBtn.classList.remove("on");
    var self = this; setTimeout(function () { self._resize(); }, 60);
  };
  FishShooter.prototype.toggleFullscreen = function (el) { var t = el || this._fsTarget || this.mount; if (!(t.classList && t.classList.contains("rr-fs"))) this.enterFullscreen(t, { auto: false }); else this._fsExit(t); };
  FishShooter.prototype.exitFullscreen = function () { this._fsExit(this._fsTarget || this.mount); };
  FishShooter.prototype.autoFullscreen = function (on, el) { var t = el || this._fsTarget || this.mount; if (on) { if (!this.isFullscreen()) this.enterFullscreen(t, { auto: true, skipNative: true }); } else if (this._fsAuto) this._fsExit(t); };

  root.FishShooter = FishShooter;
})(typeof globalThis !== "undefined" ? globalThis : this);
