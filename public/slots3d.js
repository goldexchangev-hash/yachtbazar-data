/* ============================================================
   slots3d.js — "GEM VAULT 3D": a premium Three.js (WebGL) slot machine that
   renders into the TV. Real 3D reels with depth + neon lighting, an eased
   left-to-right reel stop, glowing win lines and a coin storm.

   Money + odds live in Slots3DEngine (provably fair, frame-rate independent);
   this file is presentation + a host bridge that mirrors PressureGame/PlaneGame:
     new Slots3D({ mount, els, width, height, ethUsd, initialBalance,
                   onBalance, onWin })
   ============================================================ */
(function (root) {
  "use strict";
  const THREE = root.THREE, E = root.Slots3DEngine;
  const REELS = 5, ROWS = 3, MIN_BET = 10;

  /* palette per symbol id (0..7) */
  const SYM = [
    { c: "#ff5d7a", c2: "#7a1030", glyph: "cherry" },   // 0 cherry
    { c: "#ffd23f", c2: "#7a5400", glyph: "bell" },      // 1 bell
    { c: "#39e7ff", c2: "#0b4a63", glyph: "star" },      // 2 star
    { c: "#b14dff", c2: "#3a1063", glyph: "seven" },     // 3 lucky 7
    { c: "#ffb43d", c2: "#7a3d00", glyph: "bar" },       // 4 gold bar
    { c: "#9be8ff", c2: "#1d6e8c", glyph: "diamond" },   // 5 diamond
    { c: "#45f0a6", c2: "#0b5e3c", glyph: "wild" },      // 6 wild
    { c: "#ff4d9d", c2: "#5e0b39", glyph: "vault" },     // 7 scatter/vault
  ];

  /* ---- procedural symbol textures (no external art) ---- */
  function symTexture(id) {
    const s = SYM[id], S = 256, cv = document.createElement("canvas"); cv.width = cv.height = S;
    const x = cv.getContext("2d");
    // rounded tile background
    const g = x.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, "#141d2e"); g.addColorStop(1, "#0a1018");
    x.fillStyle = g; rr(x, 10, 10, S - 20, S - 20, 34); x.fill();
    x.lineWidth = 6; x.strokeStyle = "rgba(255,255,255,.06)"; rr(x, 13, 13, S - 26, S - 26, 32); x.stroke();
    // glow blob
    const rg = x.createRadialGradient(S / 2, S / 2, 8, S / 2, S / 2, S * 0.5);
    rg.addColorStop(0, hexA(s.c, 0.5)); rg.addColorStop(1, hexA(s.c, 0));
    x.fillStyle = rg; x.fillRect(0, 0, S, S);
    x.save(); x.translate(S / 2, S / 2);
    drawGlyph(x, s.glyph, s.c, s.c2, S * 0.32);
    x.restore();
    const t = new THREE.CanvasTexture(cv); t.anisotropy = 4; return t;
  }
  function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")"; }
  function drawGlyph(x, kind, c, c2, R) {
    x.lineJoin = "round"; x.lineCap = "round";
    const grad = x.createLinearGradient(0, -R, 0, R); grad.addColorStop(0, lighten(c)); grad.addColorStop(1, c2);
    x.fillStyle = grad; x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = R * 0.12;
    x.shadowColor = c; x.shadowBlur = 26;
    if (kind === "diamond") { x.beginPath(); x.moveTo(0, -R); x.lineTo(R * 0.86, -R * 0.1); x.lineTo(0, R); x.lineTo(-R * 0.86, -R * 0.1); x.closePath(); x.fill(); x.stroke(); x.shadowBlur = 0; x.strokeStyle = "rgba(255,255,255,.5)"; x.lineWidth = R * 0.05; x.beginPath(); x.moveTo(-R * 0.86, -R * 0.1); x.lineTo(R * 0.86, -R * 0.1); x.moveTo(0, -R); x.lineTo(0, R); x.moveTo(-R * 0.4, -R * 0.1); x.lineTo(0, -R); x.lineTo(R * 0.4, -R * 0.1); x.stroke(); }
    else if (kind === "star") { star(x, 0, 0, 5, R, R * 0.45); x.fill(); x.stroke(); }
    else if (kind === "wild") { x.font = "900 " + (R * 1.9) + "px 'Bungee',Arial"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("W", 0, R * 0.06); x.lineWidth = R * 0.06; x.strokeText("W", 0, R * 0.06); }
    else if (kind === "seven") { x.font = "900 " + (R * 2.0) + "px 'Bungee',Arial"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("7", 0, R * 0.08); x.lineWidth = R * 0.06; x.strokeText("7", 0, R * 0.08); }
    else if (kind === "bar") { x.shadowBlur = 18; rr(x, -R * 0.95, -R * 0.5, R * 1.9, R, R * 0.22); x.fill(); x.stroke(); x.shadowBlur = 0; x.fillStyle = "rgba(0,0,0,.55)"; x.font = "900 " + (R * 0.7) + "px 'Bungee',Arial"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("BAR", 0, R * 0.04); }
    else if (kind === "bell") { x.beginPath(); x.moveTo(0, -R); x.bezierCurveTo(R * 0.7, -R * 0.9, R * 0.8, R * 0.4, R * 0.95, R * 0.55); x.lineTo(-R * 0.95, R * 0.55); x.bezierCurveTo(-R * 0.8, R * 0.4, -R * 0.7, -R * 0.9, 0, -R); x.fill(); x.stroke(); x.beginPath(); x.arc(0, R * 0.78, R * 0.18, 0, 7); x.fill(); }
    else if (kind === "cherry") { for (const dx of [-R * 0.42, R * 0.42]) { x.beginPath(); x.arc(dx, R * 0.45, R * 0.5, 0, 7); x.fill(); x.stroke(); } x.strokeStyle = "#3fae3f"; x.lineWidth = R * 0.14; x.beginPath(); x.moveTo(-R * 0.42, R * 0.0); x.quadraticCurveTo(0, -R * 0.7, R * 0.1, -R); x.moveTo(R * 0.42, R * 0.0); x.quadraticCurveTo(R * 0.2, -R * 0.6, R * 0.1, -R); x.stroke(); }
    else if (kind === "vault") {
      // PADLOCK — the bonus/scatter symbol. Drawn to read like the 🔒 in the
      // "how it pays" guide so players recognize it scrolling by. Extra glow so
      // it stands out from the regular symbols.
      x.shadowBlur = 26; x.shadowColor = c;
      // shackle (the U-loop on top)
      x.lineWidth = R * 0.2; x.strokeStyle = lighten(c);
      x.beginPath(); x.arc(0, -R * 0.34, R * 0.42, Math.PI * 1.02, -0.02, false); x.stroke();
      // body (rounded block)
      x.shadowBlur = 18;
      rr(x, -R * 0.62, -R * 0.06, R * 1.24, R * 0.96, R * 0.2); x.fill(); x.stroke();
      // keyhole
      x.shadowBlur = 0; x.fillStyle = "rgba(0,0,0,.55)";
      x.beginPath(); x.arc(0, R * 0.3, R * 0.17, 0, 7); x.fill();
      x.beginPath(); x.moveTo(-R * 0.07, R * 0.32); x.lineTo(R * 0.07, R * 0.32); x.lineTo(R * 0.12, R * 0.66); x.lineTo(-R * 0.12, R * 0.66); x.closePath(); x.fill();
    }
  }
  function star(x, cx, cy, n, R, r) { x.beginPath(); for (let i = 0; i < n * 2; i++) { const rad = i % 2 ? r : R, a = (i / (n * 2)) * 6.283 - Math.PI / 2; x[i ? "lineTo" : "moveTo"](cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); } x.closePath(); }
  function lighten(hex) { const n = parseInt(hex.slice(1), 16); const r = Math.min(255, (n >> 16 & 255) + 70), g = Math.min(255, (n >> 8 & 255) + 70), b = Math.min(255, (n & 255) + 70); return "rgb(" + r + "," + g + "," + b + ")"; }
  function coinTexture() {
    const S = 64, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    const g = x.createRadialGradient(S * 0.4, S * 0.35, 4, S / 2, S / 2, S / 2);
    g.addColorStop(0, "#fff7cf"); g.addColorStop(0.5, "#ffd23f"); g.addColorStop(1, "#b8860b");
    x.fillStyle = g; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 2, 0, 7); x.fill();
    return new THREE.CanvasTexture(cv);
  }

  /* ============================ the game ============================ */
  function Slots3D(opts) {
    this.els = opts.els || {};
    this.mount = opts.mount;
    this.W = opts.width || 800; this.H = opts.height || 600;
    this.ethUsd = opts.ethUsd || 3400;
    this.onBalance = opts.onBalance || null;
    this.onWin = opts.onWin || null;
    this.balance = opts.initialBalance != null ? opts.initialBalance : 5000;
    this.bet = MIN_BET;
    this._active = false; this._enabled = true; this._spinning = false; this._raf = 0;
    this._bonus = null; this._bonusT = 0; // free-spins round state + timer
    this.state = "idle"; // idle | spinning | win
    this.serverSeed = E.randomSeed(24); this.commitHash = E.commit(this.serverSeed);
    this.clientSeed = (this.els.pfClient && this.els.pfClient.value) || E.randomSeed(8);
    this.nonce = 0;

    this._texCache = []; for (let i = 0; i < 8; i++) this._texCache[i] = symTexture(i);
    this._coinTex = coinTexture();
    this._coins = []; this._pulses = []; this._t = 0; this._winFx = null;

    this._initScene();
    this._buildOverlay();
    this._wire();
    this._syncBet(); this._renderHud();
    this._loop = this._loop.bind(this);
  }

  Slots3D.prototype._initScene = function () {
    const W = this.W, H = this.H;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(1.75, root.devicePixelRatio || 1));
    renderer.setSize(W, H, false);
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%"; renderer.domElement.style.display = "block";
    this.renderer = renderer; if (this.mount) this.mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x05060f);
    scene.fog = new THREE.Fog(0x05060f, 9, 18); this.scene = scene;
    const cam = new THREE.PerspectiveCamera(42, W / H, 0.1, 100); cam.position.set(0, 0, 8.2); cam.lookAt(0, 0, 0); this.cam = cam;

    // lighting — warm key + neon cyan/magenta rims
    scene.add(new THREE.AmbientLight(0x4a5a8a, 0.7));
    const key = new THREE.PointLight(0xffffff, 0.9, 40); key.position.set(0, 4, 9); scene.add(key);
    const cyan = new THREE.PointLight(0x39e7ff, 0.8, 30); cyan.position.set(-7, 2, 6); scene.add(cyan);
    const mag = new THREE.PointLight(0xff4d9d, 0.8, 30); mag.position.set(7, -2, 6); scene.add(mag);

    // backdrop glow plane
    const bgTex = (function () { const S = 256, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d"); const g = x.createRadialGradient(S / 2, S * 0.42, 10, S / 2, S / 2, S * 0.62); g.addColorStop(0, "#221a4a"); g.addColorStop(0.5, "#120a2a"); g.addColorStop(1, "#05060f"); x.fillStyle = g; x.fillRect(0, 0, S, S); return new THREE.CanvasTexture(cv); })();
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(40, 26), new THREE.MeshBasicMaterial({ map: bgTex }));
    bg.position.z = -6; scene.add(bg);

    // ── reel bank ──
    this.TILE = 1.5; this.REELW = 1.66;
    const bank = new THREE.Group(); scene.add(bank); this.bank = bank;
    const faceGeo = new THREE.PlaneGeometry(1.5, 1.5);
    const bodyGeo = new THREE.BoxGeometry(1.66, 1.6, 0.36);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0c1422, metalness: 0.6, roughness: 0.45 });
    this.reels = [];
    for (let r = 0; r < REELS; r++) {
      const reel = { x: (r - 2) * this.REELW, pos: r * 7.3, strip: [], tiles: [], spinning: false, t: 0, dur: 1, start: 0, land: 0 };
      for (let i = 0; i < 64; i++) reel.strip.push((Math.random() * 8) | 0);
      for (let s = 0; s < 5; s++) { // 5 tiles: buffer + 3 visible + buffer
        const grp = new THREE.Group(); grp.position.x = reel.x;
        const body = new THREE.Mesh(bodyGeo, bodyMat); grp.add(body);
        const faceMat = new THREE.MeshStandardMaterial({ map: this._texCache[0], emissive: 0x223044, emissiveMap: this._texCache[0], emissiveIntensity: 0.55, metalness: 0.2, roughness: 0.6, transparent: true });
        const face = new THREE.Mesh(faceGeo, faceMat); face.position.z = 0.2; grp.add(face);
        grp.userData = { face: face, mat: faceMat, sym: 0 };
        bank.add(grp); reel.tiles.push(grp);
      }
      this.reels.push(reel);
    }

    // cabinet frame: top & bottom masks (hide buffer tiles) + neon side posts
    const maskMat = new THREE.MeshStandardMaterial({ color: 0x080c16, metalness: 0.5, roughness: 0.5 });
    const winH = ROWS * this.TILE; const bankW = REELS * this.REELW + 0.5;
    const top = new THREE.Mesh(new THREE.BoxGeometry(bankW + 1.2, 4, 1.2), maskMat); top.position.set(0, winH / 2 + 2 + 0.02, 0.5); scene.add(top);
    const bot = top.clone(); bot.position.y = -(winH / 2 + 2 + 0.02); scene.add(bot);
    // neon trim bars on the window edge
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x39e7ff, emissive: 0x39e7ff, emissiveIntensity: 1.3, roughness: 0.4 });
    const tb = new THREE.Mesh(new THREE.BoxGeometry(bankW + 0.4, 0.12, 0.2), trimMat); tb.position.set(0, winH / 2 + 0.06, 0.62); scene.add(tb); this._trimTop = tb;
    const bb = tb.clone(); bb.position.y = -(winH / 2 + 0.06); scene.add(bb); this._trimBot = bb;
    const postMat = new THREE.MeshStandardMaterial({ color: 0xff4d9d, emissive: 0xff4d9d, emissiveIntensity: 1.1, roughness: 0.4 });
    const lp = new THREE.Mesh(new THREE.BoxGeometry(0.12, winH + 0.4, 0.2), postMat); lp.position.set(-(bankW) / 2 + 0.18, 0, 0.62); scene.add(lp);
    const rp = lp.clone(); rp.position.x = (bankW) / 2 - 0.18; scene.add(rp);
    this._trims = [tb, bb, lp, rp];

    // glassy sheen overlay
    const sheen = new THREE.Mesh(new THREE.PlaneGeometry(bankW, winH), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05 }));
    sheen.position.z = 1.0; scene.add(sheen);

    // fx layers
    this.fx = new THREE.Group(); scene.add(this.fx);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(40, 26), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })); this.flash.position.z = 2; scene.add(this.flash);

    this._fitCamera();
    this._paintReels(true);
    this.renderer.render(this.scene, this.cam);
  };

  // Pull the camera back so all 5 reels + 3 rows always fit inside the TV with a
  // margin — no clipped edges, whatever the screen aspect.
  Slots3D.prototype._fitCamera = function () {
    const aspect = this.W / this.H, halfH = Math.tan((this.cam.fov * Math.PI / 180) / 2);
    const bankW = REELS * this.REELW + 0.9;   // reels + posts + air
    const winH = ROWS * this.TILE + 0.9;
    const zForW = (bankW / 0.94) / (2 * halfH * aspect); // width fits within 94%
    const zForH = (winH / 0.86) / (2 * halfH);           // height fits within 86%
    this.cam.position.set(0, 0, Math.max(zForW, zForH));
    this.cam.lookAt(0, 0, 0); this.cam.updateProjectionMatrix();
  };

  // place tiles for current reel.pos and set their symbol textures
  Slots3D.prototype._paintReels = function () {
    const TILE = this.TILE;
    for (let r = 0; r < REELS; r++) {
      const reel = this.reels[r], L = reel.strip.length, i0 = Math.floor(reel.pos), f = reel.pos - i0;
      for (let s = -1; s <= 3; s++) {
        const tile = reel.tiles[s + 1];
        const sym = reel.strip[(((i0 + s) % L) + L) % L];
        tile.position.y = (1 - s + f) * TILE;
        tile.position.z = -Math.abs((1 - s + f)) * 0.0; // flat (kept simple/stable)
        if (tile.userData.sym !== sym) { tile.userData.sym = sym; const t = this._texCache[sym]; tile.userData.mat.map = t; tile.userData.mat.emissiveMap = t; tile.userData.mat.needsUpdate = true; }
      }
    }
  };

  /* ---------- spin ---------- */
  Slots3D.prototype._spin = function () {
    if (!this._active || this._spinning || this._bonus) return; // no manual spins during a free-spins round
    if (!this._enabled) { this._msg("Connect a wallet to play for real", ""); return; }
    if (this.balance < this.bet) { this._msg("Not enough balance — add funds 👇", "lose"); return; }
    const bet = this.bet;
    this.balance = Math.round((this.balance - bet) * 100) / 100; this._save(); this._renderHud();
    this._clearWinFx();
    this.nonce += 1;
    const grid = E.deriveGrid(this.serverSeed, this.clientSeed, this.nonce); // grid[reel][row]
    this._result = E.evaluate(grid, bet);
    this._betThisSpin = bet; this._landedGrid = grid;
    this.state = "spinning"; this._spinning = true;
    this._msg("Spinning…", "");
    if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {}
    this._launchReels(grid, false);
    this._renderSpinBtn();
  };
  // Start the eased reel-stop animation so each reel lands on the given grid.
  // `fast` shortens the spin (used for the auto-played free spins).
  Slots3D.prototype._launchReels = function (grid, fast) {
    for (let r = 0; r < REELS; r++) {
      const reel = this.reels[r], L = reel.strip.length;
      const turns = (fast ? 8 : 14) + r * (fast ? 2 : 3) + ((Math.random() * 3) | 0);
      const land = Math.floor(reel.pos) + turns;
      // write the result into the strip at the landing window
      reel.strip[((land % L) + L) % L] = grid[r][0];
      reel.strip[(((land + 1) % L) + L) % L] = grid[r][1];
      reel.strip[(((land + 2) % L) + L) % L] = grid[r][2];
      // also scramble the cells just before landing so the approach looks random
      for (let k = 1; k <= 3; k++) reel.strip[((((land - k) % L) + L) % L)] = (Math.random() * 8) | 0;
      reel.spinning = true; reel.t = 0; reel.start = reel.pos; reel.land = land;
      reel.dur = (fast ? 0.6 : 1.15) + r * (fast ? 0.14 : 0.32);
    }
  };

  Slots3D.prototype._settle = function () {
    this._spinning = false; this.state = "win";
    const res = this._result, bet = this._betThisSpin;
    if (res.winUsd > 0) {
      this.balance = Math.round((this.balance + res.winUsd) * 100) / 100; this._save();
      this._showWinFx(res, bet);
    } else if (!this._bonus) {
      this._msg("No win — spin again", "");
      const C = root.Chiptune; if (C && C.lose) try { C.lose(); } catch (e) {}
    }
    this.lastRound = { nonce: this.nonce, win: res.winUsd };
    this._updatePf(); this._renderHud();

    // During a free-spins round each settle accumulates toward the grand total.
    if (this._bonus) { this._afterBonusSpin(res); return; }

    // Normal spin: bank the profit, then check whether 3+ Vaults lit the bonus.
    if (res.winUsd > 0 && this.onWin) { const profit = res.winUsd - bet; if (profit > 0) try { this.onWin({ profitUsd: profit, mult: res.winUsd / bet }); } catch (e) {} }
    if (res.scatter && res.scatter.count >= 3 && E.freeSpinsFor(res.scatter.count) > 0) { this._beginBonus(res.scatter.count); return; }
    clearTimeout(this._idleT); this._idleT = setTimeout(() => { if (!this._spinning && !this._bonus) { this.state = "idle"; this._msg("Tap SPIN", ""); this._renderSpinBtn(); } }, 1600);
    this._renderSpinBtn();
  };

  // Shared win presentation (pulses, coin storm, flash, count-up, fanfare) for a
  // settled result — used by both normal spins and free spins.
  Slots3D.prototype._showWinFx = function (res, bet) {
    const mark = {};
    res.lines.forEach((ln) => ln.rows.forEach((row, r) => { mark[r + ":" + row] = 1; }));
    if (res.scatter) res.scatter.cells.forEach((c) => { mark[c[0] + ":" + c[1]] = 1; });
    this._pulseCells(mark);
    const big = res.winUsd >= bet * 10, mega = res.winUsd >= bet * 40;
    this.flash.material.opacity = mega ? 0.5 : big ? 0.34 : 0.2; this.flash.material.color.set(mega ? 0xffd23f : (this._bonus ? 0xff4d9d : 0x45f0a6));
    this._winFx = { t: 0, total: res.winUsd, shown: 0, dur: this._bonus ? 0.7 : (mega ? 1.9 : big ? 1.5 : 1.0), big: big, mega: mega, lastCoin: -1 };
    const n = mega ? 46 : big ? 28 : 14; for (let i = 0; i < n; i++) this._spawnCoin();
    if (!this._bonus) this._msg("💰 WIN  " + this._usd(res.winUsd) + (res.scatter ? "  · VAULT BONUS" : ""), "win");
    const C = root.Chiptune; if (C) try { if (mega && C.jackpot) C.jackpot(); else if (big && C.bigwin) C.bigwin(); else if (C.win) C.win(); } catch (e) {}
  };

  /* ---------- FREE SPINS bonus round ---------- */
  // 3+ Vaults → a deterministic free-spins round (provably-fair: every spin
  // derives from this commit). Each spin auto-plays, wins are ×-multiplied and
  // banked toward a running grand total that stays on screen.
  Slots3D.prototype._beginBonus = function (scatterCount) {
    const plan = E.deriveBonus(this.serverSeed, this.clientSeed, this.nonce, this._betThisSpin, scatterCount);
    if (!plan.spins) { clearTimeout(this._idleT); this._idleT = setTimeout(() => { this.state = "idle"; this._msg("Tap SPIN", ""); this._renderSpinBtn(); }, 1600); return; }
    this._bonus = { plan: plan, i: 0, total: 0, count: scatterCount };
    this._renderSpinBtn();
    this._showOverlay("🔓 VAULT BONUS!", plan.spins + " FREE SPINS", "every win pays ×" + plan.mult, "intro");
    const C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
    clearTimeout(this._bonusT); this._bonusT = setTimeout(() => this._bonusSpin(), 2100);
  };
  Slots3D.prototype._bonusSpin = function () {
    const b = this._bonus; if (!b) return;
    const spin = b.plan.results[b.i];
    this._clearWinFx();
    this._result = { winUsd: spin.winUsd, lines: spin.lines, scatter: spin.scatter };
    this.state = "spinning"; this._spinning = true;
    this._updateOverlay("FREE SPIN " + (b.i + 1) + " / " + b.plan.spins, "BONUS  " + this._usd(b.total), "×" + b.plan.mult);
    if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (e) {}
    this._launchReels(spin.grid, true);
    this._renderSpinBtn();
  };
  Slots3D.prototype._afterBonusSpin = function (res) {
    const b = this._bonus; if (!b) return;
    b.total = Math.round((b.total + res.winUsd) * 100) / 100;
    this._updateOverlay("FREE SPIN " + (b.i + 1) + " / " + b.plan.spins, "BONUS  " + this._usd(b.total), res.winUsd > 0 ? "+" + this._usd(res.winUsd) : "— no win");
    b.i += 1;
    clearTimeout(this._bonusT);
    if (b.i < b.plan.spins) this._bonusT = setTimeout(() => this._bonusSpin(), res.winUsd > 0 ? 1050 : 650);
    else this._bonusT = setTimeout(() => this._endBonus(), 1100);
  };
  Slots3D.prototype._endBonus = function () {
    const b = this._bonus; if (!b) return;
    const total = b.total, spins = b.plan.spins, mult = b.plan.mult;
    this._bonus = null; this._spinning = false;
    this._showOverlay("🏆 BONUS COMPLETE", "+" + this._usd(total), spins + " free spins · ×" + mult, "end");
    const C = root.Chiptune; if (C && C.jackpot) try { C.jackpot(); } catch (e) {}
    if (this.onWin && total > 0) try { this.onWin({ profitUsd: total, mult: mult, bonus: true }); } catch (e) {}
    this._renderHud(); this._renderSpinBtn();
    clearTimeout(this._bonusT); this._bonusT = setTimeout(() => { this._hideOverlay(); this.state = "idle"; this._msg("Tap SPIN", ""); this._renderSpinBtn(); }, 2900);
  };
  // Abort (e.g. leaving the channel): honor the predetermined total by banking any
  // free spins not yet animated, then close out cleanly.
  Slots3D.prototype._finishBonusNow = function () {
    const b = this._bonus; if (!b) return;
    clearTimeout(this._bonusT); this._bonusT = 0;
    for (let i = b.i; i < b.plan.results.length; i++) {
      const w = b.plan.results[i].winUsd;
      if (w > 0) { this.balance = Math.round((this.balance + w) * 100) / 100; b.total = Math.round((b.total + w) * 100) / 100; }
    }
    this._save();
    if (this.onWin && b.total > 0) try { this.onWin({ profitUsd: b.total, mult: b.plan.mult, bonus: true }); } catch (e) {}
    this._bonus = null; this._spinning = false; this.state = "idle";
    this._hideOverlay(); this._renderHud(); this._renderSpinBtn();
  };

  /* ---------- bonus overlay (DOM over the canvas) ---------- */
  Slots3D.prototype._buildOverlay = function () {
    if (this._ov || !this.mount) return;
    const ov = document.createElement("div"); ov.className = "s3d-bonus hidden";
    ov.innerHTML = '<div class="s3d-bonus-title"></div><div class="s3d-bonus-big"></div><div class="s3d-bonus-sub"></div>';
    this.mount.appendChild(ov);
    this._ov = ov;
    this._ovEls = { title: ov.querySelector(".s3d-bonus-title"), big: ov.querySelector(".s3d-bonus-big"), sub: ov.querySelector(".s3d-bonus-sub") };
  };
  Slots3D.prototype._showOverlay = function (title, big, sub, mode) {
    this._buildOverlay(); if (!this._ov) return;
    this._ovEls.title.textContent = title || ""; this._ovEls.big.textContent = big || ""; this._ovEls.sub.textContent = sub || "";
    this._ov.className = "s3d-bonus " + (mode || "spin");
    void this._ov.offsetWidth; this._ov.classList.add("pop");
  };
  Slots3D.prototype._updateOverlay = function (title, big, sub) {
    this._buildOverlay(); if (!this._ov) return;
    this._ovEls.title.textContent = title || ""; this._ovEls.big.textContent = big || ""; this._ovEls.sub.textContent = sub || "";
    if (this._ov.classList.contains("hidden") || !this._ov.classList.contains("spin")) this._ov.className = "s3d-bonus spin";
  };
  Slots3D.prototype._hideOverlay = function () { if (this._ov) this._ov.className = "s3d-bonus hidden"; };

  Slots3D.prototype._pulseCells = function (mark) {
    this._pulses = [];
    for (let r = 0; r < REELS; r++) for (let row = 0; row < ROWS; row++) {
      if (!mark[r + ":" + row]) continue;
      const tile = this.reels[r].tiles[row + 1]; // at landed pos, row → slot s=row → tile index row+1
      this._pulses.push({ tile: tile, t: 0 });
    }
  };

  Slots3D.prototype._spawnCoin = function () {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._coinTex, transparent: true }));
    const sc = 0.4 + Math.random() * 0.4; sp.scale.set(sc, sc, sc);
    sp.position.set((Math.random() - 0.5) * 6, -3.4, 2.4); this.fx.add(sp);
    this._coins.push({ s: sp, vx: (Math.random() - 0.5) * 3.5, vy: 5.5 + Math.random() * 4, vr: 0, life: 1.1 + Math.random() * 0.7, t: 0 });
  };

  /* ---------- per-frame ---------- */
  Slots3D.prototype._loop = function () {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now(); const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now; this._t += dt;

    // reels
    if (this._spinning) {
      let allStopped = true;
      for (let r = 0; r < REELS; r++) {
        const reel = this.reels[r];
        if (!reel.spinning) continue;
        allStopped = false;
        reel.t += dt; const k = Math.min(1, reel.t / reel.dur);
        const e = 1 - Math.pow(1 - k, 3); // easeOutCubic (fast → settle)
        reel.pos = reel.start + (reel.land - reel.start) * e;
        if (k >= 1) { reel.pos = reel.land; reel.spinning = false;
          if (root.Chiptune && root.Chiptune.blip) try { root.Chiptune.blip(); } catch (x) {} }
      }
      this._paintReels();
      if (allStopped || this.reels.every((rr) => !rr.spinning)) { this._paintReels(); this._settle(); }
    } else { this._paintReels(); }

    // trim neon pulse
    const tp = 1.0 + 0.35 * Math.sin(this._t * 3);
    this._trimTop.material.emissiveIntensity = tp; this._trimBot.material.emissiveIntensity = tp;

    // win count-up
    if (this._winFx) { const w = this._winFx; w.t += dt; const kk = Math.min(1, w.t / w.dur); w.shown = w.total * (1 - Math.pow(1 - kk, 3));
      if (this.els.win) this.els.win.textContent = this._usd(w.shown);
      if (kk < 1 && this._t - w.lastCoin > 0.06) { w.lastCoin = this._t; if (root.Chiptune && root.Chiptune.coin) try { root.Chiptune.coin(); } catch (e) {} }
      if (kk >= 1) this._winFx = null; }

    // pulse winning tiles
    for (const p of this._pulses) { p.t += dt; const s = 1 + 0.12 * Math.abs(Math.sin(p.t * 7)); p.tile.scale.set(s, s, 1); p.tile.userData.mat.emissiveIntensity = 0.55 + 0.9 * Math.abs(Math.sin(p.t * 7)); }

    // coins
    for (let i = this._coins.length - 1; i >= 0; i--) { const c = this._coins[i]; c.t += dt; c.vy -= 9 * dt; c.s.position.x += c.vx * dt; c.s.position.y += c.vy * dt; c.s.material.opacity = Math.max(0, 1 - c.t / c.life);
      if (c.t >= c.life || c.s.position.y < -4) { this.fx.remove(c.s); c.s.material.dispose(); this._coins.splice(i, 1); } }

    // flash decay
    if (this.flash.material.opacity > 0.01) this.flash.material.opacity *= 0.9; else this.flash.material.opacity = 0;

    // gentle camera parallax
    this.cam.position.x = Math.sin(this._t * 0.4) * 0.18; this.cam.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.cam);
  };

  Slots3D.prototype._clearWinFx = function () {
    for (const p of this._pulses) { p.tile.scale.set(1, 1, 1); p.tile.userData.mat.emissiveIntensity = 0.55; }
    this._pulses = []; this._winFx = null; if (this.els.win) this.els.win.textContent = this._usd(0);
    for (const c of this._coins) { this.fx.remove(c.s); }
    this._coins = [];
  };

  /* ---------- HUD / wiring ---------- */
  Slots3D.prototype._usd = function (n) { return "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  Slots3D.prototype._eth = function (n) { return "Ξ" + ((+n || 0) / (this.ethUsd || 3400)).toFixed(4); };
  Slots3D.prototype._msg = function (t, cls) { if (this.els.message) { this.els.message.textContent = t; this.els.message.className = "s3d-msg " + (cls || ""); } };
  Slots3D.prototype._renderHud = function () { const e = this.els;
    if (e.balance) e.balance.textContent = this._usd(this.balance);
    if (e.betVal) e.betVal.textContent = this._usd(this.bet);
    if (e.betEth) e.betEth.textContent = "≈ " + this._eth(this.bet);
    if (e.pfHash) e.pfHash.textContent = this.commitHash.slice(0, 16) + "…";
    if (e.pfNonce) e.pfNonce.textContent = String(this.nonce);
  };
  Slots3D.prototype._renderSpinBtn = function () {
    const b = this.els.spinBtn; if (!b) return;
    if (this._bonus) { b.textContent = "🎁 FREE SPINS…"; b.dataset.kind = "wait"; b.disabled = true; }
    else if (this._spinning) { b.textContent = "SPINNING…"; b.dataset.kind = "wait"; b.disabled = true; }
    else if (!this._enabled) { b.textContent = "CONNECT TO PLAY"; b.dataset.kind = "wait"; b.disabled = true; }
    else { b.textContent = "🎰 SPIN  " + this._usd(this.bet); b.dataset.kind = "spin"; b.disabled = this.balance < this.bet; }
  };
  Slots3D.prototype._syncBet = function () { const e = this.els;
    if (e.betSlider) e.betSlider.value = this.bet;
    this._renderHud(); this._renderSpinBtn();
  };
  Slots3D.prototype._setBet = function (v) { this.bet = Math.max(MIN_BET, Math.round((+v || MIN_BET) * 100) / 100); this._syncBet(); };
  Slots3D.prototype._updatePf = function () { if (this.els.pfNonce) this.els.pfNonce.textContent = String(this.nonce); if (this.els.pfLast && this.lastRound) this.els.pfLast.textContent = "round #" + this.lastRound.nonce + " · win " + this._usd(this.lastRound.win); };
  Slots3D.prototype._verifyLast = function () {
    if (!this.lastRound) { this._msg("Spin once, then verify", ""); return; }
    const v = E.verify(this.serverSeed, this.commitHash, this.clientSeed, this.lastRound.nonce, this._betThisSpin || this.bet);
    const ok = v.hashOk;
    if (this.els.pfReveal) this.els.pfReveal.textContent = "serverSeed " + this.serverSeed.slice(0, 12) + "… → hash " + (ok ? "MATCHES ✓" : "✗") + " · win " + this._usd(v.result.winUsd);
    this._msg(ok ? "✅ Round #" + this.lastRound.nonce + " verified" : "⚠️ mismatch", ok ? "win" : "lose");
  };
  Slots3D.prototype._save = function () { if (this.onBalance) try { this.onBalance(this.balance); } catch (e) {} };

  Slots3D.prototype._wire = function () {
    const e = this.els;
    if (e.spinBtn) e.spinBtn.addEventListener("click", () => this._spin());
    const step = (b) => (b < 100 ? 10 : b < 500 ? 25 : 100);
    if (e.betSlider) e.betSlider.addEventListener("input", () => this._setBet(parseFloat(e.betSlider.value) || MIN_BET));
    if (e.betHalf) e.betHalf.addEventListener("click", () => this._setBet(this.bet / 2));
    if (e.betDouble) e.betDouble.addEventListener("click", () => this._setBet(this.bet * 2));
    if (e.betMax) e.betMax.addEventListener("click", () => this._setBet(this.balance));
    if (e.pfClient) e.pfClient.addEventListener("change", () => { this.clientSeed = e.pfClient.value || E.randomSeed(8); });
    if (e.pfVerify) e.pfVerify.addEventListener("click", () => this._verifyLast());
    // SPACE spins (only while this is the live channel + no modal/typing)
    window.addEventListener("keydown", (ev) => {
      if (ev.code !== "Space" || !this._active) return;
      const tag = (ev.target && ev.target.tagName) || ""; if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (document.querySelector(".modal:not(.hidden)")) return;
      ev.preventDefault(); this._spin();
    });
  };

  /* ---------- host bridge API (mirrors PressureGame) ---------- */
  Slots3D.prototype.setActive = function (on) {
    on = !!on; if (on === this._active) return; this._active = on;
    if (on) { this._last = performance.now(); this._raf = requestAnimationFrame(this._loop); }
    else {
      if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0;
      if (this._bonus) this._finishBonusNow(); // leaving mid-bonus → bank the rest, don't strand it
    }
  };
  Slots3D.prototype.setEnabled = function (on) { this._enabled = !!on; this._renderSpinBtn(); };
  Slots3D.prototype.setBalance = function (usd) { this.balance = Math.max(0, Math.round((+usd || 0) * 100) / 100); this._renderHud(); this._renderSpinBtn(); };
  Slots3D.prototype.setEthUsd = function (n) { if (n > 0) { this.ethUsd = n; this._renderHud(); } };
  Slots3D.prototype.setMode = function () { /* demo-only for now; kept for API symmetry */ };

  root.Slots3D = Slots3D;
})(typeof globalThis !== "undefined" ? globalThis : this);
