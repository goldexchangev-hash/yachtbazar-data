/* ============================================================
   slots.js — "Crypto Reels", a PixiJS video slot machine.

   Self-contained, play-money, no wallet/contract required. Matches the
   neon-CRT aesthetic of TV Crypto Flip and reuses window.Chiptune for SFX.

   5 reels × 3 rows, 9 paylines, wild (💎) + scatter (🪙). Reels are weighted
   "physical" strips, so the house edge lives in the strip composition — exactly
   how a real slot works. Randomness is client-side Math.random for this
   stand-alone toy; the single seam to swap in a provably-fair / on-chain source
   later is spinOutcome() → just feed each reel a stop index from your RNG.
   ============================================================ */
(function () {
  "use strict";

  if (!window.PIXI) {
    const veil = document.getElementById("screen-loading");
    if (veil) veil.innerHTML = "<div>⚠️</div><div>PixiJS failed to load.<br>Check vendor/pixi.min.js</div>";
    return;
  }

  /* ───────────────────────── Config ───────────────────────── */
  const W = 960, H = 600;
  const REELS = 5, ROWS = 3;
  const SS = 146;                 // symbol cell size (px, design units)
  const GAP = 8;                  // gap between reels
  const REEL_TOP = 64;            // y where the visible reel window starts
  const BLOCK_W = REELS * SS + (REELS - 1) * GAP;
  const START_X = Math.round((W - BLOCK_W) / 2);
  const N = 48;                   // strip length per reel
  const TILE_COUNT = ROWS + 2;    // visible rows + top/bottom buffer

  const WILD = 7, SCATTER = 8;

  // pay[count] = multiple of the LINE bet for 3/4/5 of a kind. Indexed by the
  // match count, so indices 0-2 are unused (need 3+ to pay).
  const SYM = [
    { key: "cherry",  glyph: "🍒", name: "Cherry",   weight: 22, pay: [0, 0, 0, 5, 12, 30] },
    { key: "bell",    glyph: "🔔", name: "Bell",     weight: 18, pay: [0, 0, 0, 5, 16, 42] },
    { key: "star",    glyph: "⭐", name: "Star",     weight: 16, pay: [0, 0, 0, 9, 23, 68] },
    { key: "cash",    glyph: "💵", name: "Cash",     weight: 13, pay: [0, 0, 0, 13, 42, 115] },
    { key: "eth",     glyph: "Ξ",  name: "Ethereum", weight: 10, pay: [0, 0, 0, 20, 65, 190],  glyphFill: 0xb9c7ff },
    { key: "btc",     glyph: "₿",  name: "Bitcoin",  weight: 7,  pay: [0, 0, 0, 35, 110, 350], glyphFill: 0xffd23f },
    { key: "seven",   glyph: "7",  name: "Lucky 7",  weight: 5,  pay: [0, 0, 0, 55, 225, 700], glyphFill: 0xff4d9d, seven: true },
    { key: "wild",    glyph: "💎", name: "WILD",     weight: 5,  pay: [0, 0, 0, 100, 450, 2500] },
    { key: "scatter", glyph: "🪙", name: "SCATTER",  weight: 4,  pay: [0, 0, 0, 4, 22, 120] }, // scatter pay × TOTAL bet (~90% RTP)
  ];

  // 9 paylines as [row per reel] (row 0 = top … 2 = bottom).
  const LINES = [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2],
    [1, 0, 0, 0, 1],
    [1, 2, 2, 2, 1],
    [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0],
  ];
  const LINE_COLORS = [0x39e7ff, 0xff4d9d, 0x45f0a6, 0xffd23f, 0xff8a3d, 0x9b6bff, 0x6effa0, 0xff5b8a, 0x5ad1ff];

  const BET_STEPS = [1, 2, 5, 10, 25, 50, 100];
  const CREDITS_KEY = "cryptoReels.credits";
  const BIG_WIN_MULT = 18;        // win ≥ this × total bet ⇒ BIG WIN fanfare

  /* ───────────────────────── State ───────────────────────── */
  let credits = loadCredits();
  let betIdx = 2;                 // BET_STEPS[2] = 5
  let spinning = false;
  let autoOn = false;
  let reelsLeft = 0;

  const lineBet = () => BET_STEPS[betIdx];
  const totalBet = () => lineBet() * LINES.length;

  // Win presentation state.
  let winFx = null;               // { start, total, displayed, cells:Set, lines:[], big }
  let creditWinSynced = -1;       // guards the one-time HUD sync at count-up end

  // Channel mode: embedded in the main TV page (no standalone HUD/credits). When
  // true, app.js drives spins via CryptoReels.channelSpin against the on-chain
  // result and owns the real-dollar balance; this file only renders the reels.
  const CHANNEL = !document.getElementById("spin-btn");
  let onChannelDone = null;   // fired when a channel spin's reveal finishes
  let forcedGrid = null;      // when set, the next spin lands on exactly this 5x3 grid
  let channelWinUsd = 0;      // dollar win to count up on the TV (channel mode)
  let channelBetUsd = 0;      // dollar stake (for the BIG WIN threshold)

  /* ───────────────────────── Pixi app ───────────────────────── */
  const app = new PIXI.Application({
    width: W, height: H,
    backgroundColor: 0x0a0717,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
  });
  document.getElementById("pixi-mount").appendChild(app.view);

  // ── Scene graph
  const bg = new PIXI.Graphics();
  app.stage.addChild(bg);
  drawBackground();

  const world = new PIXI.Container();   // everything that can "shake"
  app.stage.addChild(world);

  const frame = new PIXI.Graphics();    // reel cabinet frame
  world.addChild(frame);
  drawFrame();

  const reelsLayer = new PIXI.Container();
  world.addChild(reelsLayer);

  const lineLayer = new PIXI.Graphics(); // win lines + cell highlights
  world.addChild(lineLayer);

  const ui = new PIXI.Container();
  world.addChild(ui);

  const particles = new PIXI.Container();
  world.addChild(particles);

  // ── UI text
  const headerText = makeText("PAYS LEFT → RIGHT · 9 LINES", {
    fontFamily: '"Press Start 2P", monospace', fontSize: 13, fill: 0x6f7bb5, letterSpacing: 1,
  });
  headerText.anchor.set(0.5);
  headerText.position.set(W / 2, 34);
  ui.addChild(headerText);

  const messageText = makeText("PRESS  SPIN", {
    fontFamily: '"Bungee", monospace', fontSize: 30, fill: 0xffffff, letterSpacing: 1,
    dropShadow: true, dropShadowColor: 0x000000, dropShadowDistance: 3, dropShadowAlpha: 0.6,
  });
  messageText.anchor.set(0.5);
  messageText.position.set(W / 2, H - 30);
  ui.addChild(messageText);

  const bigWinText = makeText("BIG WIN!", {
    fontFamily: '"Bungee", monospace', fontSize: 86, fill: 0xffd23f, letterSpacing: 2,
    dropShadow: true, dropShadowColor: 0xff4d9d, dropShadowDistance: 0, dropShadowBlur: 18, dropShadowAlpha: 1,
  });
  bigWinText.anchor.set(0.5);
  bigWinText.position.set(W / 2, H / 2 - 6);
  bigWinText.visible = false;
  ui.addChild(bigWinText);

  /* ───────────────────────── Reels ───────────────────────── */
  const reels = [];
  for (let i = 0; i < REELS; i++) {
    const rx = START_X + i * (SS + GAP);

    const container = new PIXI.Container();
    container.position.set(rx, REEL_TOP);
    reelsLayer.addChild(container);

    // mask to the 3-row window
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(rx, REEL_TOP, SS, ROWS * SS).endFill();
    reelsLayer.addChild(mask);
    container.mask = mask;

    const blur = new PIXI.BlurFilter(0, 4);
    blur.blurX = 0; blur.blurY = 0;

    const strip = buildStrip();
    const reel = {
      container, blur, strip,
      position: Math.floor(Math.random() * N),
      prevPosition: 0,
      target: 0, from: 0, tStart: 0, tDur: 0, tweening: false,
      tiles: [],
    };
    reel.prevPosition = reel.position;

    for (let k = 0; k < TILE_COUNT; k++) {
      const tile = makeTile();
      tile.symId = -1;
      container.addChild(tile);
      reel.tiles.push(tile);
    }
    reels.push(reel);
  }

  /* ───────────────────────── Tiles ───────────────────────── */
  function makeTile() {
    const tile = new PIXI.Container();
    const inner = new PIXI.Container();
    inner.position.set(SS / 2, SS / 2);

    const tbg = new PIXI.Graphics();
    const pad = 5, r = 18;
    tbg.beginFill(0x140e26, 0.92);
    tbg.lineStyle(2, 0x35305c, 0.9);
    tbg.drawRoundedRect(-SS / 2 + pad, -SS / 2 + pad, SS - pad * 2, SS - pad * 2, r);
    tbg.endFill();
    // inner sheen
    tbg.beginFill(0xffffff, 0.04);
    tbg.drawRoundedRect(-SS / 2 + pad, -SS / 2 + pad, SS - pad * 2, (SS - pad * 2) / 2, r);
    tbg.endFill();

    const txt = new PIXI.Text("", new PIXI.TextStyle({
      fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif',
      fontSize: 86, fill: 0xffffff, align: "center",
    }));
    txt.anchor.set(0.5);

    inner.addChild(tbg, txt);
    tile.addChild(inner);
    tile.inner = inner;
    tile.txt = txt;
    return tile;
  }

  function setTileSymbol(tile, symId) {
    const s = SYM[symId];
    const t = tile.txt;
    if (s.glyphFill !== undefined) {
      t.style.fontFamily = s.seven ? '"Bungee", "Space Grotesk", sans-serif' : 'Arial, "Space Grotesk", sans-serif';
      t.style.fontWeight = "700";
      t.style.fontSize = s.seven ? 104 : 96;
      t.style.fill = s.glyphFill;
      t.style.dropShadow = true;
      t.style.dropShadowColor = 0x000000;
      t.style.dropShadowDistance = 3;
      t.style.dropShadowAlpha = 0.5;
    } else {
      t.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui, sans-serif';
      t.style.fontWeight = "400";
      t.style.fontSize = 84;
      t.style.fill = 0xffffff;
      t.style.dropShadow = false;
    }
    t.text = s.glyph;
  }

  /* ───────────────────────── Strip / outcome ───────────────────────── */
  function weightedPool() {
    const pool = [];
    SYM.forEach((s, id) => { for (let i = 0; i < s.weight; i++) pool.push(id); });
    return pool;
  }
  function buildStrip() {
    const pool = weightedPool();
    const strip = [];
    let last = -1, lastScatterAt = -99;
    for (let i = 0; i < N; i++) {
      let id, guard = 0;
      do {
        id = pool[(Math.random() * pool.length) | 0];
        guard++;
        // avoid 3-in-a-column repeats and scatters too close together (cosmetic)
      } while (guard < 8 && ((id === last && Math.random() < 0.6) || (id === SCATTER && i - lastScatterAt < 3)));
      if (id === SCATTER) lastScatterAt = i;
      last = id;
      strip.push(id);
    }
    return strip;
  }

  // The single seam to swap in a provably-fair RNG: return an integer stop index
  // per reel. In channel mode we land on the contract's grid by patching the
  // strip at the chosen stop so the visible 3-row window equals forcedGrid[reel].
  function spinOutcome(reelIndex) {
    const stop = (Math.random() * N) | 0;
    if (forcedGrid) {
      const strip = reels[reelIndex].strip;
      for (let r = 0; r < ROWS; r++) strip[(stop + r) % N] = forcedGrid[reelIndex][r];
    }
    return stop;
  }

  /* ───────────────────────── Spin ───────────────────────── */
  function spin() {
    if (spinning) return;
    if (!CHANNEL) {
      if (credits < totalBet()) {
        autoSet(false);
        toast("Not enough credits — add more to keep playing.", "err");
        revealAddCredits(true);
        return;
      }
      credits -= totalBet();
      saveCredits();
      updateHUD(0);
    }
    clearWinFx();
    spinning = true;
    reelsLeft = REELS;
    setSpinUI(true);
    messageText.text = "GOOD  LUCK";
    messageText.style.fill = 0xffffff;
    blip();

    const now = performance.now();
    for (let i = 0; i < REELS; i++) {
      const reel = reels[i];
      reel.position = ((Math.round(reel.position) % N) + N) % N; // normalize
      const stop = spinOutcome(i);
      const revolutions = 4 + i;                 // later reels travel further
      const target = reel.position + revolutions * N + ((stop - reel.position % N + N) % N);
      reel.from = reel.position;
      reel.target = target;
      reel.tStart = now;
      reel.tDur = 720 + i * 240;                 // cascade stop
      reel.tweening = true;
    }
  }

  function onReelStop(i) {
    const reel = reels[i];
    reel.position = ((Math.round(reel.target) % N) + N) % N;
    reel.prevPosition = reel.position; // clean stop: no one-frame blur spike
    reel.tweening = false;
    if (i === REELS - 1) Chiptune.coin && Chiptune.coin(); else blip();
    reelsLeft--;
    if (reelsLeft === 0) onAllStopped();
  }

  function readGrid() {
    const grid = [];
    for (let i = 0; i < REELS; i++) {
      const P = ((Math.round(reels[i].position) % N) + N) % N;
      const col = [];
      for (let r = 0; r < ROWS; r++) col.push(reels[i].strip[(P + r) % N]);
      grid.push(col);
    }
    return grid;
  }

  function evalLine(grid, line) {
    const first = grid[0][line[0]];
    if (first === SCATTER) return null;
    let pay = first;
    if (pay === WILD) {
      for (let r = 1; r < REELS; r++) {
        const s = grid[r][line[r]];
        if (s !== WILD) { pay = s; break; }
      }
    }
    if (pay === SCATTER) return null;
    let count = 0;
    for (let r = 0; r < REELS; r++) {
      const s = grid[r][line[r]];
      if (s === pay || s === WILD) count++;
      else break;
    }
    if (count < 3) return null;
    const mult = SYM[pay].pay[count];
    if (!mult) return null;
    const cells = [];
    for (let r = 0; r < count; r++) cells.push({ reel: r, row: line[r] });
    return { paySym: pay, count, mult, cells };
  }

  function evaluate(grid) {
    const wins = [];
    const cells = new Set();
    let total = 0;

    LINES.forEach((line, li) => {
      const w = evalLine(grid, line);
      if (w) {
        w.amount = w.mult * lineBet();
        w.lineIndex = li;
        total += w.amount;
        wins.push(w);
        w.cells.forEach((c) => cells.add(c.reel + "," + c.row));
      }
    });

    // scatter pays anywhere
    const scatterCells = [];
    for (let i = 0; i < REELS; i++)
      for (let r = 0; r < ROWS; r++)
        if (grid[i][r] === SCATTER) scatterCells.push({ reel: i, row: r });
    let scatterWin = 0;
    if (scatterCells.length >= 3) {
      const c = Math.min(5, scatterCells.length);
      scatterWin = SYM[SCATTER].pay[c] * totalBet();
      total += scatterWin;
      scatterCells.forEach((c2) => cells.add(c2.reel + "," + c2.row));
    }

    return { total, wins, scatterWin, scatterCells, cells };
  }

  function onAllStopped() {
    spinning = false;
    const grid = readGrid();
    const res = evaluate(grid); // cells/lines for highlighting; amount overridden in channel mode

    // In channel mode the amount shown is the on-chain dollar payout, not credits.
    const shown = CHANNEL ? channelWinUsd : res.total;
    const won = shown > 0;

    if (won) {
      if (!CHANNEL) { credits += res.total; saveCredits(); }
      const big = CHANNEL ? (channelBetUsd > 0 && shown >= channelBetUsd * BIG_WIN_MULT)
                          : (shown >= totalBet() * BIG_WIN_MULT);
      winFx = {
        start: performance.now(),
        total: shown,
        displayed: 0,
        cells: res.cells,
        lines: res.wins.map((w) => ({ line: LINES[w.lineIndex], count: w.count, color: LINE_COLORS[w.lineIndex % LINE_COLORS.length] })),
        big,
        scatter: res.scatterWin > 0,
        usd: CHANNEL,
      };
      messageText.style.fill = 0x45f0a6;
      if (big) {
        bigWinText.visible = true;
        bigWinText.scale.set(0.2);
        shake(0.6);
        win(); win();
        burstParticles(70);
      } else {
        win();
        burstParticles(28);
      }
      if (res.scatterWin > 0) Chiptune.coin && Chiptune.coin();
      flashWinCell(true);
    } else {
      messageText.text = "NO  WIN  ·  SPIN  AGAIN";
      messageText.style.fill = 0x9aa3c7;
    }

    setSpinUI(false);
    if (!CHANNEL) {
      revealAddCredits(credits < totalBet());
      updateHUD(res.total);
      // auto-spin continuation (standalone only)
      if (autoOn && credits >= totalBet()) {
        const delay = res.total > 0 ? (winFx && winFx.big ? 2000 : 1200) : 650;
        setTimeout(() => { if (autoOn && !spinning) spin(); }, delay);
      } else if (autoOn) {
        autoSet(false);
      }
    } else if (onChannelDone) {
      const cb = onChannelDone; onChannelDone = null;
      cb({ won, winUsd: shown, big: winFx && winFx.big });
    }
  }

  /* ───────────────────────── Win FX ───────────────────────── */
  function clearWinFx() {
    winFx = null;
    lineLayer.clear();
    bigWinText.visible = false;
    // reset the message back to a plain, un-popped state (so losses/idle read clean)
    messageText.scale.set(1);
    messageText.style.dropShadowColor = 0x000000;
    messageText.style.dropShadowBlur = 0;
    for (const reel of reels) for (const t of reel.tiles) t.inner.scale.set(1);
  }

  function flashWinCell() { /* visual handled in render loop */ }

  function drawWinFx(tNow) {
    lineLayer.clear();
    if (!winFx) return;
    const elapsed = (tNow - winFx.start) / 1000;
    const blink = 0.55 + 0.45 * Math.sin(elapsed * 7);

    // cell highlights
    winFx.cells.forEach((key) => {
      const [ri, row] = key.split(",").map(Number);
      const x = START_X + ri * (SS + GAP);
      const y = REEL_TOP + row * SS;
      lineLayer.lineStyle(4, 0xffffff, 0.25 + 0.35 * blink);
      lineLayer.drawRoundedRect(x + 5, y + 5, SS - 10, SS - 10, 16);
      lineLayer.lineStyle(2, 0xffd23f, 0.5 + 0.5 * blink);
      lineLayer.drawRoundedRect(x + 9, y + 9, SS - 18, SS - 18, 13);
    });

    // win lines (matched portion)
    winFx.lines.forEach((wl) => {
      lineLayer.lineStyle(6, wl.color, 0.35 + 0.45 * blink);
      for (let r = 0; r < wl.count; r++) {
        const cx = START_X + r * (SS + GAP) + SS / 2;
        const cy = REEL_TOP + wl.line[r] * SS + SS / 2;
        if (r === 0) lineLayer.moveTo(cx, cy); else lineLayer.lineTo(cx, cy);
      }
    });
  }

  /* ───────────────────────── Particles ───────────────────────── */
  const GLYPHS = ["🪙", "💎", "⭐", "💰"];
  function burstParticles(n) {
    for (let i = 0; i < n; i++) {
      const p = new PIXI.Text(GLYPHS[(Math.random() * GLYPHS.length) | 0],
        new PIXI.TextStyle({ fontFamily: '"Segoe UI Emoji", system-ui', fontSize: 22 + (Math.random() * 16 | 0) }));
      p.anchor.set(0.5);
      p.x = W / 2 + (Math.random() - 0.5) * 220;
      p.y = H / 2 + (Math.random() - 0.5) * 60;
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.0;
      const spd = 280 + Math.random() * 360;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.vr = (Math.random() - 0.5) * 10;
      p.life = 1.4 + Math.random() * 0.8;
      particles.addChild(p);
    }
  }
  function updateParticles(dt) {
    for (let i = particles.children.length - 1; i >= 0; i--) {
      const p = particles.children[i];
      p.life -= dt;
      p.vy += 900 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.vr * dt;
      if (p.life < 0.5) p.alpha = Math.max(0, p.life / 0.5);
      if (p.life <= 0 || p.y > H + 40) { particles.removeChild(p); p.destroy(); }
    }
  }

  /* ───────────────────────── Shake ───────────────────────── */
  let shakeUntil = 0, shakeMag = 0;
  function shake(seconds) { shakeUntil = performance.now() + seconds * 1000; shakeMag = 12; }

  /* ───────────────────────── Main loop ───────────────────────── */
  app.ticker.add(() => {
    const dt = Math.min(0.05, app.ticker.deltaMS / 1000);
    const now = performance.now();

    // advance reel tweens
    let anyTweening = false;
    for (let i = 0; i < REELS; i++) {
      const reel = reels[i];
      if (reel.tweening) {
        anyTweening = true;
        const phase = Math.min(1, (now - reel.tStart) / reel.tDur);
        const e = easeOutBack(phase);
        reel.position = reel.from + (reel.target - reel.from) * e;
        if (phase >= 1) { reel.position = reel.target; onReelStop(i); }
      }
    }

    renderReels();

    // win FX + count-up — an exciting "money adding up" reveal: the amount pops
    // in big + gold, races up fast, and ticks a coin sound the whole climb,
    // then settles to a green pulse. (Losses use the plain muted message.)
    if (winFx) {
      drawWinFx(now);
      const DUR = 760; // count-up duration (ms) — quick + punchy
      const k = Math.min(1, (now - winFx.start) / DUR);
      winFx.displayed = Math.round(winFx.total * easeOutCubic(k));
      messageText.text = "YOU WON  " + (winFx.usd ? "$" : "") + fmt(winFx.displayed);
      // overshoot pop on entry, then a lively pulse while the number climbs
      const pop = easeOutBack(Math.min(1, (now - winFx.start) / 340));
      const pulse = k < 1 ? (1 + 0.07 * Math.sin(now / 80)) : 1;
      messageText.scale.set((0.55 + 0.95 * pop) * pulse);
      messageText.style.fill = k < 1 ? 0xffd23f : 0x45f0a6; // gold while counting → green when banked
      messageText.style.dropShadowColor = k < 1 ? 0xff8a3d : 0x1e6b46;
      messageText.style.dropShadowBlur = 10;
      // coin "cha-ching" ticks racing up with the number
      if (k < 1 && now - (winFx.lastTick || 0) > 55) {
        winFx.lastTick = now;
        try { Chiptune.coin && Chiptune.coin(); } catch (e) {}
      }
      if (winFx.big) {
        bigWinText.scale.set(Math.min(1, easeOutBack(Math.min(1, (now - winFx.start) / 500))));
        bigWinText.rotation = Math.sin(now / 140) * 0.04;
      }
      if (!CHANNEL && k >= 1 && winFx.displayed !== creditWinSynced) {
        creditWinSynced = winFx.displayed;
        updateHUD(winFx.total);
      }
    }

    updateParticles(dt);

    // shake
    if (now < shakeUntil) {
      const m = shakeMag * ((shakeUntil - now) / 600);
      world.position.set((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    } else if (world.position.x || world.position.y) {
      world.position.set(0, 0);
    }
  });

  function renderReels() {
    for (let i = 0; i < REELS; i++) {
      const reel = reels[i];
      const delta = reel.position - reel.prevPosition;
      reel.prevPosition = reel.position;

      const speed = Math.abs(delta);
      if (speed > 0.02) {
        reel.blur.blurY = Math.min(16, speed * 9);
        if (!reel.blurOn) { reel.container.filters = [reel.blur]; reel.blurOn = true; }
      } else if (reel.blurOn) {
        reel.blur.blurY = 0;
        reel.container.filters = null;
        reel.blurOn = false;
      }

      const floorP = Math.floor(reel.position);
      const frac = reel.position - floorP;
      for (let k = 0; k < TILE_COUNT; k++) {
        const tile = reel.tiles[k];
        const idx = (((floorP + k - 1) % N) + N) % N;
        const sym = reel.strip[idx];
        if (tile.symId !== sym) { setTileSymbol(tile, sym); tile.symId = sym; }
        tile.y = (k - 1 - frac) * SS;

        // win pulse for visible winning cells (row = k-1)
        const row = k - 1;
        if (winFx && row >= 0 && row < ROWS && winFx.cells.has(i + "," + row)) {
          const pulse = 1 + 0.07 * Math.sin(performance.now() / 90 + i);
          tile.inner.scale.set(pulse);
        } else if (tile.inner.scale.x !== 1) {
          tile.inner.scale.set(1);
        }
      }
    }
  }

  /* ───────────────────────── Drawing helpers ───────────────────────── */
  function drawBackground() {
    bg.clear();
    bg.beginFill(0x0a0717).drawRect(0, 0, W, H).endFill();
    // subtle top/bottom bands
    bg.beginFill(0x140a26, 0.6).drawRect(0, 0, W, REEL_TOP).endFill();
    bg.beginFill(0x140a26, 0.6).drawRect(0, REEL_TOP + ROWS * SS, W, H - (REEL_TOP + ROWS * SS)).endFill();
  }
  function drawFrame() {
    frame.clear();
    const x = START_X - 12, y = REEL_TOP - 12, w = BLOCK_W + 24, h = ROWS * SS + 24;
    // glow rings
    frame.lineStyle(8, 0xff4d9d, 0.16).drawRoundedRect(x - 4, y - 4, w + 8, h + 8, 26);
    frame.lineStyle(3, 0x39e7ff, 0.85).drawRoundedRect(x, y, w, h, 22);
    frame.lineStyle(1, 0xffffff, 0.18).drawRoundedRect(x + 3, y + 3, w - 6, h - 6, 20);
    // row guide lines
    frame.lineStyle(1, 0xffffff, 0.06);
    for (let r = 1; r < ROWS; r++) {
      frame.moveTo(START_X, REEL_TOP + r * SS).lineTo(START_X + BLOCK_W, REEL_TOP + r * SS);
    }
  }
  function makeText(str, styleObj) {
    return new PIXI.Text(str, new PIXI.TextStyle(styleObj));
  }

  /* ───────────────────────── Easing ───────────────────────── */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) {
    const c1 = 1.70158 * 0.7, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  /* ───────────────────────── SFX ───────────────────────── */
  function blip() { try { Chiptune.blip && Chiptune.blip(); } catch (e) {} }
  function win() { try { Chiptune.win && Chiptune.win(); } catch (e) {} }

  /* ───────────────────────── HUD / DOM ───────────────────────── */
  const $ = (id) => document.getElementById(id);
  const elCredits = $("hud-credits"), elBet = $("hud-bet"), elWin = $("hud-win"),
    elWinCell = $("hud-win-cell"), elBetLine = $("bet-line"),
    spinBtn = $("spin-btn"), autoBtn = $("auto-btn"), maxBtn = $("max-bet"),
    addBtn = $("add-credits"), betUp = $("bet-up"), betDown = $("bet-down"),
    soundBtn = $("sound-btn"), rulesBtn = $("rules-btn"), rulesModal = $("rules-modal"),
    rulesClose = $("rules-close"), toastEl = $("toast"), loadingEl = $("screen-loading");

  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
  function loadCredits() {
    const v = parseInt(localStorage.getItem(CREDITS_KEY), 10);
    return Number.isFinite(v) && v >= 0 ? v : 1000;
  }
  function saveCredits() { try { localStorage.setItem(CREDITS_KEY, String(Math.round(credits))); } catch (e) {} }

  function updateHUD(lastWin) {
    elCredits.textContent = fmt(credits);
    elBet.textContent = fmt(totalBet());
    elBetLine.textContent = fmt(lineBet());
    if (lastWin !== undefined) {
      elWin.textContent = fmt(lastWin);
      if (lastWin > 0) { elWinCell.classList.remove("flash"); void elWinCell.offsetWidth; elWinCell.classList.add("flash"); }
    }
  }

  function setSpinUI(isSpinning) {
    if (!spinBtn) return; // channel mode: app.js owns the spin button
    spinBtn.disabled = isSpinning;
    spinBtn.classList.toggle("spinning", isSpinning);
    spinBtn.textContent = isSpinning ? "SPINNING" : "SPIN";
    betUp.disabled = isSpinning; betDown.disabled = isSpinning; maxBtn.disabled = isSpinning;
  }

  function autoSet(on) {
    autoOn = on;
    autoBtn.classList.toggle("active", on);
    autoBtn.textContent = on ? "AUTO ⏹" : "AUTO";
    if (on && !spinning) spin();
  }

  function revealAddCredits(show) { addBtn.classList.toggle("hidden", !show); }

  function setBet(idx) {
    betIdx = Math.max(0, Math.min(BET_STEPS.length - 1, idx));
    updateHUD();
    revealAddCredits(credits < totalBet());
  }

  let toastTimer = null;
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = "toast show " + (kind || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = "toast"), 2600);
  }

  /* ───────────────────────── Paytable modal ───────────────────────── */
  function buildPaytable() {
    const wrap = $("paytable");
    if (!wrap) return;
    const order = [6, 5, 4, 3, 2, 1, 0, 7, 8]; // high → low, then wild/scatter
    wrap.innerHTML = order.map((id) => {
      const s = SYM[id];
      const tag = s.key === "wild" ? " · WILD" : s.key === "scatter" ? " · SCATTER" : "";
      const pays = s.key === "scatter"
        ? `3 = <b>2×</b> · 4 = <b>10×</b> · 5 = <b>50×</b> <span class="pt-name">× total bet, anywhere</span>`
        : `3 = <b>${s.pay[3]}×</b> · 4 = <b>${s.pay[4]}×</b> · 5 = <b>${s.pay[5]}×</b> <span class="pt-name">${s.name}${tag}</span>`;
      return `<div class="pt-row"><div class="pt-sym">${s.glyph}</div><div class="pt-pays">${pays}</div></div>`;
    }).join("");
  }
  function openRules() { rulesModal.classList.remove("hidden"); }
  function closeRules() { rulesModal.classList.add("hidden"); }

  function ensureAudio() { try { Chiptune._sfx && Chiptune._sfx(); } catch (e) {} }

  /* ───────────────────────── Wiring + boot (standalone page only) ───────────────────────── */
  if (!CHANNEL) {
    spinBtn.addEventListener("click", () => { ensureAudio(); spin(); });
    betUp.addEventListener("click", () => { blip(); setBet(betIdx + 1); });
    betDown.addEventListener("click", () => { blip(); setBet(betIdx - 1); });
    maxBtn.addEventListener("click", () => { blip(); setBet(BET_STEPS.length - 1); });
    autoBtn.addEventListener("click", () => { ensureAudio(); autoSet(!autoOn); });
    addBtn.addEventListener("click", () => { credits += 1000; saveCredits(); updateHUD(); revealAddCredits(false); toast("+1000 credits added 💰", "ok"); });

    rulesBtn.addEventListener("click", openRules);
    rulesClose.addEventListener("click", closeRules);
    rulesModal.addEventListener("click", (e) => { if (e.target === rulesModal) closeRules(); });

    soundBtn.addEventListener("click", () => {
      const on = Chiptune.toggle();
      soundBtn.textContent = on ? "🔊 Music" : "🔇 Music";
    });

    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !e.repeat) {
        const tag = (e.target && e.target.tagName) || "";
        if (tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); ensureAudio(); spin(); }
      } else if (e.code === "Escape") {
        closeRules();
      }
    });

    buildPaytable();
    setBet(betIdx);
    updateHUD(0);
    revealAddCredits(credits < totalBet());
  }

  // prime one render then drop the loading veil (channel mode has no veil)
  renderReels();
  requestAnimationFrame(() => { if (loadingEl) loadingEl.classList.add("gone"); });
  setTimeout(() => { if (loadingEl) loadingEl.classList.add("gone"); }, 400);

  window.CryptoReels = {
    app, reels, LINES, SYM,
    spin, evaluate, readGrid, spinOutcome,
    state: () => ({ credits, betIdx, lineBet: lineBet(), totalBet: totalBet(), spinning, autoOn }),
    setCredits: (n) => { credits = n; saveCredits(); updateHUD(); },
    // ── Channel API (used by app.js when embedded in the TV page) ──
    isChannel: CHANNEL,
    isSpinning: () => spinning,
    // Land the reels on a contract-decided grid (5 reels × 3 rows of symbol ids
    // 0..8) and count up `winUsd` dollars. onDone({won,winUsd,big}) fires at the
    // end of the reveal. Returns false if a spin is already running.
    channelSpin: (grid, winUsd, betUsd, onDone) => {
      if (spinning) return false;
      forcedGrid = grid; channelWinUsd = winUsd || 0; channelBetUsd = betUsd || 0;
      onChannelDone = (r) => { forcedGrid = null; if (onDone) onDone(r); };
      try { app.ticker.start(); } catch (e) {} // never reveal against a stopped ticker (would strand onDone)
      spin();
      return true;
    },
    // Demo/play-money outcome: roll 15 independent weighted cells (same as the
    // on-chain RNG) and score them in DOLLARS against `totalBetUsd`, using the
    // exact same paytable + 9 paylines as the contract. Returns { grid, winUsd }
    // ready to hand straight to TV.revealSlots — no chain involved.
    simulate: (totalBetUsd) => {
      const pool = weightedPool();
      const grid = [];
      for (let i = 0; i < REELS; i++) {
        const col = [];
        for (let r = 0; r < ROWS; r++) col.push(pool[(Math.random() * pool.length) | 0]);
        grid.push(col);
      }
      const lineBetUsd = (totalBetUsd || 0) / LINES.length;
      let total = 0;
      LINES.forEach((line) => { const w = evalLine(grid, line); if (w) total += w.mult * lineBetUsd; });
      let sc = 0;
      for (let i = 0; i < REELS; i++) for (let r = 0; r < ROWS; r++) if (grid[i][r] === SCATTER) sc++;
      if (sc >= 3) total += SYM[SCATTER].pay[Math.min(5, sc)] * (totalBetUsd || 0);
      return { grid, winUsd: total };
    },
    // Pause/resume the Pixi ticker so the slot doesn't burn CPU off-channel.
    setActive: (on) => { try { on ? app.ticker.start() : app.ticker.stop(); } catch (e) {} },
    setMessage: (t) => { try { messageText.text = t; messageText.style.fill = 0xffffff; } catch (e) {} },
  };
})();
