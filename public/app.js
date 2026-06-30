/* ============================================================
   app.js — wallet, contract, lobby and the glue that drives the TV.
   ============================================================ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const E = window.ethers;
  const cfg = window.COINFLIP_CONFIG || {};
  const ART = window.COINFLIP_ARTIFACT || { abi: [], bytecode: "", defaultTreasury: null };
  const ABI = ART.abi && ART.abi.length ? ART.abi : cfg.abi || [];
  const params = new URLSearchParams(location.search);

  function loadStored() { try { return JSON.parse(localStorage.getItem("coinflip_deployment") || "null"); } catch { return null; } }
  function saveStored(d) { try { localStorage.setItem("coinflip_deployment", JSON.stringify(d)); } catch {} }

  const onLocalhost = /^(localhost$|127\.|0\.0\.0\.0|\[?::1\]?)/.test(location.hostname);
  // Canonical public site (Render — has the live chat). All share/invite links +
  // cards point here regardless of which mirror you're viewing it on.
  const CANONICAL_URL = "https://tv-crypto-flip.onrender.com/";
  function shareBase() { return onLocalhost ? (location.origin + location.pathname) : CANONICAL_URL; }

  // Which contract + chain are we using?  URL link > local config.js > saved > none.
  let deployment = (() => {
    const a = params.get("contract"), c = params.get("chain");
    // Only adopt a shared ?contract= link if ethers is loaded AND it's a valid address. (Was:
    // `!E || !E.isAddress || E.isAddress(a)` — which ACCEPTED an arbitrary ?contract= param during
    // the window before ethers loads. Matches the safe REF-param pattern below.)
    if (a && E && E.isAddress && E.isAddress(a)) return { address: a, chainId: c ? Number(c) : null };
    if (cfg.address) return { address: cfg.address, chainId: cfg.chainId || null }; // local dev (deploy:local)
    const s = loadStored();
    if (s && s.address) return s;
    return { address: null, chainId: onLocalhost ? 31337 : 11155111 };
  })();
  // On a hosted site, never use the local Hardhat chain (stale config/localStorage).
  if (!onLocalhost && deployment.chainId === 31337) {
    deployment = { address: null, chainId: 11155111 };
    try { localStorage.removeItem("coinflip_deployment"); } catch {}
  }
  let hostTreasury = null; // read from the contract once connected
  let ownerAddr = null; // contract owner (the host who deployed it)

  // ---- state ----
  let provider = null; // ethers BrowserProvider
  let signer = null;
  let account = null;
  let myBestNetUsd = 0; // biggest single net win (for achievements)
  // Referral: first-touch ?ref= is remembered; your own links carry ?ref=you.
  const REF = (() => {
    try {
      const r = params.get("ref");
      if (r && E && E.isAddress && E.isAddress(r) && !localStorage.getItem("coinflip_ref")) localStorage.setItem("coinflip_ref", r);
      return localStorage.getItem("coinflip_ref") || null;
    } catch { return null; }
  })();
  let connecting = false; // true while connect() runs, to suppress the auto-reload
  let contract = null; // connected to signer
  let twoDiceSupported = null; // null=unknown, true/false — does the active contract have Dice #2?
  let crashSupported = null;   // null=unknown, true/false — does the active contract have Crash?
  let slotsSupported = null;   // null=unknown, true/false — does the active contract have Slots?
  let slotsLoadPromise = null; // lazy-load guard for pixi.min.js + slots.js
  let pressureLoadPromise = null; // lazy-load guard for the Balloon Pop (pressure) engine
  let pressureGame = null;        // the Balloon Pop instance, built on first visit to CH 13
  let planeLoadPromise = null;    // lazy-load guard for the Plane (Aviator) engine
  let planeGame = null;           // the Plane instance, built on first visit to CH 14
  let slots3dLoadPromise = null;  // lazy-load guard for the Gem Vault 3D slot (Three.js)
  let slots3dGame = null;         // the Gem Vault 3D instance, built on first visit to CH 15
  let fishLoadPromise = null;     // lazy-load guard for Reef Raiders (PixiJS fish-shooter)
  let fishGame = null;            // the Reef Raiders instance, built on first visit to CH 17
  let playcanvasLoadPromise = null; // lazy-load guard for the PlayCanvas engine (Sky Swoop)
  let swoopLoadPromise = null;    // lazy-load guard for Sky Swoop (PlayCanvas biplane crash)
  let swoopGame = null;           // the Sky Swoop instance, built on first visit to CH 18
  let fishshooterLoadPromise = null; // lazy-load guard for Fish Shooter (PixiJS fish-table)
  let fishshooterGame = null;     // the Fish Shooter instance, built on first visit to CH 19
  let coinFlip3dLoadPromise = null; // lazy-load guard for the 3D coin (Three.js)
  let coinFlip3d = null;          // the CoinFlip3D instance, built on first visit to CH 8
  let rail3dLoadPromise = null;   // lazy-load guard for the 0-100 neon rail (Three.js)
  let rail3d = null;              // the Rail3D instance, built on first visit to CH 9
  let d2_3dLoadPromise = null;    // lazy-load guard for the Dice #2 3D dice (Three.js)
  let d2_3d = null;               // the TwoDice3D instance, built on first visit to CH 10
  let read = null; // connected to provider
  let maxBet = 0n;
  let gameWei = 0n; // cached in-game (deposited) balance, refreshed by refreshBalances
  let walletWei = 0n; // last-seen wallet ETH balance (for the deposit cap)
  let chainOK = false;
  // ── Demo mode: instant try-before-you-connect with play money ──
  // No wallet, no chain — outcomes are simulated locally with the SAME odds and
  // paytables as the real on-chain games, and drive the SAME TV animations.
  let demoOn = false;
  const DEMO_START_USD = 5000; // play-money grant + refill ceiling (site-wide): players top back up to $5,000
  const DEMO_MAX_USD = 10000000; // play-money is bounded — ignore a tampered/absurd stored value
  let demoUsd = DEMO_START_USD;
  try { const s = +localStorage.getItem("ctf_demo_usd"); if (s > 0) demoUsd = Math.min(s, DEMO_MAX_USD); } catch {}
  let activeRoomId = null; // a room I'm a participant in, currently live
  let ws = null;
  let wsPlayers = [];     // presence reported by a live chat server (only if one exists)
  let chainPlayers = [];  // addresses seen in recent on-chain rooms (newest first)
  let playerStats = {};   // addrLower -> { w, l, recent: ["W","L",…] newest-first }
  let userMutedMusic = false; // true only if the user explicitly turns music off
  let inviteRoomId = params.get("room");
  let inviteHostId = params.get("host");

  const fmt = (wei) => {
    try { return (+E.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 5 }); }
    catch { return "0"; }
  };
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
  const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const isZero = (a) => !a || /^0x0+$/i.test(a);

  // ---- USD <-> ETH (live price) ----
  let ethUsd = 3000; // fallback until the live price loads
  let ethTrend = 0;  // +1 up, -1 down vs the previous fetch
  async function fetchEthUsd() {
    const prev = ethUsd;
    try {
      const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { cache: "no-store" });
      const p = parseFloat((await r.json())?.data?.amount);
      if (p > 0) { ethUsd = p; if (prev) ethTrend = Math.sign(ethUsd - prev); updateEthTicker(); return; }
    } catch {}
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
      const u = (await r.json())?.ethereum?.usd;
      if (u > 0) { ethUsd = u; if (prev) ethTrend = Math.sign(ethUsd - prev); }
    } catch {}
    updateEthTicker();
  }
  // Matrix-style scrolling ETH price ticker above the chat.
  function updateEthTicker() {
    const t = document.getElementById("eth-ticker-track");
    if (!t) return;
    const arrow = ethTrend > 0 ? "▲" : ethTrend < 0 ? "▼" : "◆";
    const price = ethUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const seg = "ETH/USD  $" + price + "  " + arrow + "       ◆       ";
    const unit = seg.repeat(3);
    t.textContent = unit + unit; // duplicated for a seamless −50% loop
    t.classList.toggle("up", ethTrend >= 0);
    t.classList.toggle("down", ethTrend < 0);
  }
  const usd = (n) => "$" + (+n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const weiToUsd = (wei) => { try { return (+E.formatEther(wei)) * ethUsd; } catch { return 0; } };
  const usdToWei = (d) => E.parseEther((Math.max(0, +d) / ethUsd).toFixed(8));
  const usdOf = (wei) => usd(weiToUsd(wei)); // "$xx.xx" from wei
  const signedUsd = (wei) => (wei < 0n ? "−" : "+") + usdOf(wei < 0n ? -wei : wei);

  // Reveal numbers for a flip. We show the POT WON (the full payout that lands in
  // your balance = pot − 3% house), not just the net profit, so a $50 bet win
  // reads "+$97" not "+$47". A loss shows the stake you lost. `tier` escalates the
  // celebration by total pot size: big ($100+) and mega ($500+).
  function flipReveal(betWei, won) {
    const pot = betWei * 2n;
    const payout = pot - (pot * 3n) / 100n; // pot minus the 3% house cut → 1.94× stake
    const amountWei = won ? payout : betWei; // pot won / stake lost
    const netWei = won ? payout - betWei : -betWei; // true balance change (for the running total)
    const potUsd = weiToUsd(pot);
    const tier = won ? (potUsd >= 500 ? "mega" : potUsd >= 100 ? "big" : "normal") : "normal";
    return { amountUsd: weiToUsd(amountWei), amountWei, netWei, tier, potUsd };
  }

  // ---- shareable win/loss card (canvas -> PNG -> Web Share / download) ----
  let lastResult = null;
  // Active TV channel → friendly game name + emoji for the share card.
  const SHARE_GAME = { 8: ["Coin Flip", "🪙"], 9: ["0-100", "🎲"], 10: ["Dice #2", "🎲"], 11: ["Crash", "🚀"], 13: ["Balloon Pop", "🎈"], 14: ["Plane", "✈️"], 15: ["Gem Vault", "💎"] };
  function hideShareBtn() { const b = $("share-result-btn"); if (b) b.classList.add("hidden"); }
  function setLastResult(r) {
    r = r || {};
    if (!r.game) { const m = SHARE_GAME[(window.TV && TV._activeChannel) || 8]; if (m) { r.game = m[0]; r.emoji = m[1]; } }
    if (!r.detail && r.side) r.detail = "landed " + r.side;
    lastResult = r;
    const btn = $("share-result-btn");
    if (btn) btn.classList.toggle("hidden", !r.won); // the share button only appears on a WIN
  }
  // Clear the on-screen WIN/LOSE result overlay — called when the next bet starts
  // (the action-dock pointer listener) and when switching games, so a result never
  // lingers into the next round or follows you to another game.
  function clearTvWin() { if (window.TV && TV.clearOutcome) try { TV.clearOutcome(); } catch (e) {} }
  // The universal coin-flip-style WIN/LOSE result screen for the non-flip betting
  // games. Coin Flip (CH 8) has its own native result screen; the rapid slot
  // machines keep their in-canvas per-spin feedback. Shows over a dimmed game and
  // stays until the next bet. Canvas wins (Balloon Pop / Plane) call it via onWin.
  function showGameOutcome(won, amountUsd, tier, sub) {
    if (!window.TV || !TV.showOutcome) return;
    const amt = Math.abs(+amountUsd || 0);
    const t = won ? (tier || (amt >= 300 ? "mega" : amt >= 100 ? "big" : "normal")) : "normal";
    try { TV.showOutcome({ won: !!won, amountUsd: amt, tier: t, sub: sub || "" }); } catch (e) {}
  }
  function outcomeFromReveal(res) {
    if (!res || typeof res !== "object") return;
    const ch = (window.TV && TV._activeChannel) || 8;
    if (ch !== 9 && ch !== 10 && ch !== 11) return; // 0-100, Dice #2, Crash (one bet → one result)
    if (res.youWon === undefined && res.won === undefined) return; // bare lock-release call → ignore
    const won = res.youWon === true || res.won === true;
    const detail = (won && res.mult != null && res.mult > 0) ? Number(res.mult).toFixed(2) + "× payout" : "";
    // Clear each game's INLINE verdict/payout text so it doesn't show through and
    // collide with the result overlay (the overlay is now the single win/lose readout).
    const clr = (id) => { const e = $(id); if (e) e.textContent = ""; };
    if (ch === 9) { clr("dice-tv-verdict"); clr("dice-tv-payout"); }
    else if (ch === 10) { clr("td-tv-verdict"); clr("td-tv-payout"); }
    else if (ch === 11) { clr("crash-sub"); }
    showGameOutcome(won, res.amountUsd, res.tier, detail);
  }
  // Every game's reveal funnels through window.__onTvReveal with a result object —
  // surface the share button + remember the win uniformly, on any game.
  function maybeShareWin(res) {
    if (!res || typeof res !== "object") return;
    const won = res.youWon === true || res.won === true || (typeof res.winUsd === "number" && res.winUsd > 0);
    if (!won) return; // losses don't get a share button (cleared when the next bet starts)
    const ch = (window.TV && TV._activeChannel) || 8;
    const m = SHARE_GAME[ch] || ["Crypto TV", "🎰"];
    let amountUsd = (res.amountUsd != null) ? res.amountUsd : (typeof res.winUsd === "number" ? res.winUsd : 0);
    // Slots (CH 12) reveal carries GROSS winUsd (stake-inclusive); every other
    // game's amountUsd is NET profit. Subtract the stake so the share card's
    // "+$X" matches the +profit semantics used by flip/dice/crash.
    if (ch === 12 && res.amountUsd == null && typeof res.winUsd === "number" && typeof res.betUsd === "number") amountUsd = res.winUsd - res.betUsd;
    let detail = "";
    if (ch === 11 && res.crashX != null) detail = "cashed " + Number(res.targetX).toFixed(2) + "× · crashed " + Number(res.crashX).toFixed(2) + "×";
    else if (res.mult != null && res.mult > 0) detail = Number(res.mult).toFixed(2) + "× payout";
    else if (res.side) detail = "landed " + res.side;
    setLastResult({ won: true, game: m[0], emoji: m[1], amountUsd: amountUsd || 0, detail });
  }
  // Generic, green, "want-to-share" win card (1080² PNG).
  function drawShareCard(cv) {
    const W = 1080, H = 1080, r = lastResult || {};
    const emoji = r.emoji || "🎰", game = r.game || "Crypto TV";
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#06210f"); bg.addColorStop(1, "#0c0d16");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(0,231,1,0.08)"; g.lineWidth = 2;
    for (let x = 0; x <= W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y <= H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const glow = g.createRadialGradient(W / 2, 380, 60, W / 2, 380, 640);
    glow.addColorStop(0, "rgba(0,231,1,0.30)"); glow.addColorStop(1, "transparent");
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    g.textAlign = "center";
    g.fillStyle = "#00e701"; g.font = "700 40px 'Press Start 2P', monospace";
    g.fillText("📺 CRYPTO TV", W / 2, 112);
    g.fillStyle = "#b9c2e0"; g.font = "700 28px 'Press Start 2P', monospace";
    g.fillText(String(game).toUpperCase(), W / 2, 166);
    g.font = "250px 'Segoe UI Emoji', system-ui, sans-serif"; g.fillText(emoji, W / 2, 470);
    g.font = "800 108px 'Press Start 2P', monospace"; g.fillStyle = "#2bff88";
    g.fillText("YOU WON", W / 2, 636);
    g.font = "900 150px 'Space Grotesk', system-ui, sans-serif"; g.fillStyle = "#7cffb2";
    g.fillText("+" + usd(r.amountUsd || 0), W / 2, 794);
    if (r.detail) { g.font = "600 42px 'Space Grotesk', system-ui, sans-serif"; g.fillStyle = "#ffd23f"; g.fillText(r.detail, W / 2, 874); }
    g.font = "500 34px 'Space Grotesk', system-ui, sans-serif"; g.fillStyle = "#7f8bb0";
    g.fillText("Sepolia testnet · play money", W / 2, 966);
    g.fillStyle = "#00e701";
    g.fillText("tv-crypto-flip.onrender.com", W / 2, 1018);
  }
  async function shareResultCard() {
    if (!lastResult) return;
    try { await document.fonts.ready; } catch {}
    const cv = document.createElement("canvas");
    drawShareCard(cv);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) return toast("Couldn't make the card — try again.", "err");
    const file = new File([blob], "crypto-tv-win.png", { type: "image/png" });
    const text = "I just won " + usd(lastResult.amountUsd || 0) + " on " + (lastResult.game || "Crypto TV") + " 📺🎰 " + CANONICAL_URL;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    // Fallback (no native share): open the card in a NEW tab so the game page is
    // never navigated away — on iOS that navigation triggers a fresh reload that
    // would wipe the in-game balance back to the default.
    demoSave(); // flush the balance first, just in case
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "crypto-tv-win.png"; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    try { await navigator.clipboard.writeText(text); toast("Win card opened 📸 + caption copied", "ok"); }
    catch { toast("Win card opened 📸", "ok"); }
  }

  // Auto-size the gas LIMIT to the actual transaction (eth_estimateGas + 30%),
  // falling back to a safe fixed value if the flaky public RPC errors on the
  // estimate. The gas PRICE is set live by MetaMask from current network rates.
  async function estGas(method, args, overrides, fallback) {
    try {
      const fn = contract[method];
      const est = overrides ? await fn.estimateGas(...args, overrides) : await fn.estimateGas(...args);
      return (est * 13n) / 10n;
    } catch {
      return fallback;
    }
  }
  function setSliderUsd(id) {
    const v = +$(id).value;
    const valEl = $(id + "-val"); if (valEl) valEl.textContent = usd(v);
    const ethEl = $(id + "-eth"); if (ethEl) ethEl.textContent = "(approx ETH: " + (v / ethUsd).toFixed(4) + ")";
    if (id === "bet-input") updateCreateBreakdown();
    if (id === "house-bet") updateFlipButton();
  }
  // Fill a uniform action button's "BET $X · WIN $Y" amounts. Win id is either
  // {game}-payout-hint (dice/twodice/crash) or {game}-win-hint (slots/flip).
  function setBtnAmts(game, betUsd, winUsd) {
    const b = $(game + "-bet-hint"); if (b) b.textContent = Math.max(0, Math.round(betUsd || 0));
    const w = $(game + "-payout-hint") || $(game + "-win-hint");
    if (w) w.textContent = (winUsd > 0 ? winUsd : 0).toFixed(2);
  }
  // Coin flip pays the pot minus the 3% house cut = 1.94× stake → +0.94× profit.
  function updateFlipButton() {
    const s = $("house-bet"); if (!s) return;
    setBtnAmts("house", +s.value || 0, (+s.value || 0) * 0.94);
  }

  // Quick-bet: remember the last stake placed, then let one tap set ½×, 2× or the
  // current max the slider allows (which already reflects house cover + the cap).
  let lastBetUsd = 0;
  try { lastBetUsd = +localStorage.getItem("ctf_last_bet") || 0; } catch {}
  function rememberBet(usdVal) { if (!(usdVal > 0)) return; lastBetUsd = usdVal; try { localStorage.setItem("ctf_last_bet", String(usdVal)); } catch {} }
  // Spendable balance for the CURRENT game. The play-money games (Gem Vault,
  // Balloon Pop, Reef Raiders) run on the demo/play balance — NOT the on-chain
  // deposit — so "max" must clamp to that, never to the raw slider cap.
  function spendableUsd() {
    if (currentGame === "slots3d" || currentGame === "pressure" || currentGame === "fish" || currentGame === "swoop" || currentGame === "fishshooter") return demoUsd;
    return gameWei > 0n ? weiToUsd(gameWei) : 0;
  }
  function quickBet(id, mode) {
    const s = $(id); if (!s) return;
    const min = +s.min || 10, step = +s.step || 5;
    // The true ceiling RIGHT NOW = the slider cap AND your spendable balance —
    // you can't stake more than you actually have.
    const cap = +s.max || 500;
    const balUsd = spendableUsd();
    let max = Math.max(min, Math.min(cap, Math.floor(balUsd / step) * step));
    const base = lastBetUsd > 0 ? lastBetUsd : (+s.value || min);
    let v = mode === "half" ? base / 2 : mode === "double" ? base * 2 : max;
    v = Math.round(v / step) * step;
    v = Math.max(min, Math.min(max, v));
    s.value = String(v);
    setSliderUsd(id);
    try { s.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {} // refresh per-game handlers + the floating bet bar
    if (mode === "max") toast("Max you can bet now: " + usd(max), "ok");
    else if (mode === "double" && base * 2 > max) toast("Capped at the max available (" + usd(max) + ")", "ok");
    else if (mode === "half" && base / 2 < min) toast("Min bet is " + usd(min), "ok");
  }
  function wireQuickBet() {
    document.querySelectorAll(".quickbet-row").forEach((row) => {
      const target = row.getAttribute("data-target");
      row.querySelectorAll(".qbet").forEach((b) => { b.onclick = () => quickBet(target, b.getAttribute("data-mode")); });
    });
  }

  // ── Floating bet bar (phones) ────────────────────────────────────────────
  // The pinned action dock is the real per-game button (CSS-only). This strip
  // mirrors/drives the current game's REAL stake slider so you can change the
  // bet without scrolling. No game logic is duplicated — every change funnels
  // through the same <input> + "input" event the panel already listens to.
  const BETBAR_GAMES = new Set(["flip", "dice", "twodice", "crash", "pressure", "plane", "slots3d", "fish", "swoop", "fishshooter"]);
  const BETBAR_SL = { flip: "house-bet", dice: "dice-stake", twodice: "td-stake", crash: "crash-stake", pressure: "pr-bet-slider", slots3d: "s3d-bet-slider", plane: "plane-a-bet", fish: "fish-bet" };
  function curStakeSlider() { return $(BETBAR_SL[currentGame]); }
  // Measure the active game's pinned action dock and lift the stake strip above it.
  // Docks vary in height — Plane has TWO buttons, others one — so a fixed offset
  // would let a tall dock hide the strip's ½/2×/Max row. Measure after layout.
  function syncBetbarHeights() {
    if (!document.body.classList.contains("has-betbar")) return;
    const dock = document.querySelector('.stage > .action-dock[data-game="' + currentGame + '"]');
    if (!dock) return;
    const h = Math.ceil(dock.getBoundingClientRect().height);
    if (h > 0) document.body.style.setProperty("--betbar-action-h", h + "px");
  }
  let _betbarRO = null, _betbarDragging = false;
  // Keep re-measuring the active dock while it's pinned — Plane swaps button labels
  // (BET → CASH OUT) mid-round which can change its height; an observer keeps the
  // stake strip lifted clear of it at all times.
  function observeBetbarDock() {
    if (!window.ResizeObserver) { syncBetbarHeights(); return; }
    if (!_betbarRO) _betbarRO = new ResizeObserver(() => syncBetbarHeights());
    _betbarRO.disconnect();
    const dock = document.querySelector('.stage > .action-dock[data-game="' + currentGame + '"]');
    if (dock && dock.nodeType === 1 && document.body.classList.contains("has-betbar")) _betbarRO.observe(dock);
    else syncBetbarHeights();
  }
  function syncBetbarStake() {
    const bar = $("betbar-stake"); if (!bar) return;
    const s = curStakeSlider();
    const show = !!(s && BETBAR_GAMES.has(currentGame));
    if (show) bar.removeAttribute("hidden"); else bar.setAttribute("hidden", "");
    if (!show) return;
    requestAnimationFrame(syncBetbarHeights); // re-measure the dock once it's laid out
    observeBetbarDock();                       // and keep it measured as the dock changes
    const amt = $("bbs-amt"); if (amt) amt.textContent = usd(+s.value || 0);
    // mirror the active game's slider range + value onto the floating slider
    const sl = $("bbs-slider");
    if (sl) { sl.min = s.min || "10"; sl.max = s.max || "500"; sl.step = s.step || "5"; sl.value = s.value; }
  }
  // Push a value onto the current game's real slider (clamped to its range) and fire
  // the same "input" event the panel listens to, so all readouts refresh.
  function betbarSet(v) {
    const s = curStakeSlider(); if (!s) return;
    const step = +s.step || 5, min = +s.min || 0, max = +s.max || 1e9;
    v = Math.max(min, Math.min(max, Math.round(v / step) * step));
    if (String(v) !== s.value) { s.value = String(v); setSliderUsd(s.id); try { s.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {} }
  }
  function betbarStep(dir) { const s = curStakeSlider(); if (!s) betbarSet(0); else betbarSet((+s.value || 0) + (+s.step || 5) * (dir > 0 ? 1 : -1)); }
  function wireBetbar() {
    const bar = $("betbar-stake"); if (!bar) return;
    bar.addEventListener("click", (e) => {
      const s = curStakeSlider(); if (!s) return;
      const step = e.target.closest(".bbs-step"), preset = e.target.closest(".bbs-preset");
      if (step) betbarStep(+step.dataset.dir);
      else if (preset) quickBet(s.id, preset.dataset.mode);
      syncBetbarStake();
    });
    // drag the floating slider → drive the real game slider
    const sl = $("bbs-slider");
    if (sl) {
      sl.addEventListener("pointerdown", () => { _betbarDragging = true; });
      const endDrag = () => { _betbarDragging = false; };
      sl.addEventListener("pointerup", endDrag); sl.addEventListener("pointercancel", endDrag); sl.addEventListener("change", endDrag);
      sl.addEventListener("input", () => { betbarSet(+sl.value); const amt = $("bbs-amt"); if (amt) { const s = curStakeSlider(); if (s) amt.textContent = usd(+s.value || 0); } });
    }
    // keep the floating bar in lock-step when the panel slider (or quickBet/keys) moves it
    document.addEventListener("input", (e) => { if (e.target === curStakeSlider()) syncBetbarStake(); }, true);
    // Some games change stake/range PROGRAMMATICALLY without firing 'input' (Balloon Pop
    // raises its max to the full balance after lazy-load; Plane martingale doubles the
    // stake). Poll the live slider so the floating bar's range + amount never go stale —
    // critically so dragging "to the max" can actually reach the real ceiling.
    setInterval(() => {
      if (!document.body.classList.contains("has-betbar")) return;
      const s = curStakeSlider(), f = $("bbs-slider"); if (!s || !f) return;
      if (f.min !== String(s.min)) f.min = s.min;
      if (f.max !== String(s.max)) f.max = s.max;
      if (f.step !== String(s.step)) f.step = s.step;
      if (!_betbarDragging) {
        if (f.value !== s.value) f.value = s.value;
        const amt = $("bbs-amt"); if (amt) { const t = usd(+s.value || 0); if (amt.textContent !== t) amt.textContent = t; }
      }
    }, 350);
    // re-measure the dock height on rotate/resize and shortly after first paint
    window.addEventListener("resize", syncBetbarHeights);
    setTimeout(syncBetbarHeights, 400);
  }

  // Win-animation theme switcher (Neon Nights vs Magic Cliffs side-scroller).
  function initThemeSwitch() {
    if (!window.WinScenes || !WinScenes.getTheme) return;
    // Locked to the Scarfblade Films reels for now — the switcher card is hidden
    // (we can re-enable it later when there are more animation sets to choose).
    try { WinScenes.setTheme("cinematic"); } catch (e) {}
    const wrap = $("theme-toggle"); if (!wrap) return;
    const themes = (WinScenes.themes && WinScenes.themes()) || [];
    const creditEl = $("theme-credit");
    function paint() {
      const cur = WinScenes.getTheme();
      wrap.querySelectorAll(".theme-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-theme") === cur));
      const meta = themes.find((t) => t.id === cur);
      if (creditEl) creditEl.textContent = (meta && meta.credit) || "";
      // The cinematic reels replace the coin entirely — hide the spinning coin so
      // it doesn't twirl before the video plays.
      const tv = $("tv-screen"); if (tv) tv.classList.toggle("cine-theme", cur === "cinematic");
    }
    wrap.querySelectorAll(".theme-btn").forEach((b) => {
      b.onclick = () => { WinScenes.setTheme(b.getAttribute("data-theme")); paint(); toast("Win theme: " + b.textContent, "ok"); };
    });
    const prev = $("theme-preview-btn");
    if (prev) prev.onclick = () => {
      try {
        const amt = 60 + Math.floor(Math.random() * 380);
        const theme = WinScenes.getTheme();
        if (theme === "cinematic") { const w = Math.random() > 0.4; videoReveal(w, w ? amt : 0); }
        else if (theme === "world" && WinScenes.flipReveal) {
          const win = Math.random() > 0.4;
          WinScenes.flipStart({ betUsd: amt });
          setTimeout(() => WinScenes.flipReveal({ won: win, netUsd: win ? Math.round(amt * 0.9) : 0, betUsd: amt }), 1100);
        } else { WinScenes.play({ amountUsd: amt, side: "HEADS" }); }
      } catch {}
    };
    paint();
  }
  // Live preview under the create-room stake slider so it's obvious both players
  // match the stake, and where the pot / winnings / 3% cut land.
  function updateCreateBreakdown() {
    const el = $("create-breakdown"); if (!el) return;
    const v = +$("bet-input").value;
    const pot = v * 2, fee = pot * 0.03, win = pot - fee;
    el.innerHTML = "Both stake " + usd(v) + " → pot <strong>" + usd(pot) +
      "</strong> · winner gets <strong>" + usd(win) + "</strong> · house keeps " + usd(fee) + " (3%)";
  }

  // ---------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show " + (kind || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast hidden"), 3800);
  }

  // ---------------------------------------------------------- blockies avatar
  function blockies(address, size, scale, canvas) {
    // Compact deterministic identicon (classic blockies algorithm).
    const seedrand = (() => {
      const randseed = new Int32Array(4);
      let seed = address.toLowerCase();
      for (let i = 0; i < randseed.length; i++) randseed[i] = 0;
      for (let i = 0; i < seed.length; i++)
        randseed[i % 4] = (randseed[i % 4] << 5) - randseed[i % 4] + seed.charCodeAt(i);
      return () => {
        const t = randseed[0] ^ (randseed[0] << 11);
        randseed[0] = randseed[1]; randseed[1] = randseed[2]; randseed[2] = randseed[3];
        randseed[3] = randseed[3] ^ (randseed[3] >> 19) ^ t ^ (t >> 8);
        return (randseed[3] >>> 0) / ((1 << 31) >>> 0);
      };
    })();
    const rand = seedrand;
    const hsl2 = () => {
      const h = Math.floor(rand() * 360), s = rand() * 60 + 40, l = rand() * 25 + 45;
      return `hsl(${h},${s}%,${l}%)`;
    };
    const color = hsl2(), bg = hsl2(), spot = hsl2();
    const data = [];
    const mirror = size;
    for (let y = 0; y < size; y++) {
      const row = [];
      for (let x = 0; x < Math.ceil(mirror / 2); x++) {
        row[x] = Math.floor(rand() * 2.3);
      }
      const r = row.slice(0, Math.floor(mirror / 2)).reverse();
      data.push(row.concat(r));
    }
    const ctx = canvas.getContext("2d");
    canvas.width = canvas.height = size * scale;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < data.length; y++) {
      for (let x = 0; x < data[y].length; x++) {
        const v = data[y][x];
        if (v) {
          ctx.fillStyle = v === 1 ? color : spot;
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }
  }

  // ---------------------------------------------------------- setup / banners
  function banner(msg, warn) {
    const b = $("setup-banner");
    if (!msg) { b.classList.add("hidden"); return; }
    b.textContent = msg;
    b.className = "setup-banner" + (warn ? " warn" : "");
  }
  // Closable notice banners (the DEMO bar + the "on a phone" hint): an ✕ dismisses
  // them and the dismissal is remembered so they stay gone across refreshes.
  const NOTICE_KEYS = { demo: "notice:demo:dismissed", mobilehint: "notice:mobilehint:dismissed" };
  function initNoticeDismiss() {
    try {
      if (localStorage.getItem(NOTICE_KEYS.demo) === "1") { const el = $("demo-bar"); if (el) el.classList.add("notice-dismissed"); }
      if (localStorage.getItem(NOTICE_KEYS.mobilehint) === "1") { const el = $("mobile-hint"); if (el) el.classList.add("notice-dismissed"); }
    } catch (e) {}
    document.addEventListener("click", (e) => {
      const x = e.target.closest && e.target.closest("[data-dismiss]"); if (!x) return;
      const which = x.getAttribute("data-dismiss");
      const host = x.closest(".demo-bar, .mobile-hint"); if (host) host.classList.add("notice-dismissed");
      try { if (NOTICE_KEYS[which]) localStorage.setItem(NOTICE_KEYS[which], "1"); } catch (e2) {}
    });
  }
  // "Sending bet… confirm in your wallet" banner on the TV while a tx signs/mines.
  function tvPending(on) {
    const el = $("tv-pending"); if (el) el.classList.toggle("hidden", !on);
  }

  const NETWORKS = {
    31337: { chainId: "0x7a69", chainName: "Hardhat Local", rpcUrls: ["http://127.0.0.1:8545"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
    11155111: { chainId: "0xaa36a7", chainName: "Sepolia", rpcUrls: ["https://rpc.sepolia.org"], nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://sepolia.etherscan.io"] },
  };
  function explorerFor(chainId) { return chainId === 11155111 ? "https://sepolia.etherscan.io/address/" : null; }
  function explorerTx(hash) { const b = explorerFor(deployment.chainId); return b && hash ? b.replace("/address/", "/tx/") + hash : null; }
  function explorerContract() { const b = explorerFor(deployment.chainId); return b && deployment.address ? b + deployment.address : null; }
  function netName(chainId) { return chainId === 31337 ? "Local" : chainId === 11155111 ? "Sepolia" : "Connected"; }

  // ---------------------------------------------------------- connect
  async function connect() {
    if (!window.ethereum) {
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      if (isMobile) {
        // Mobile Safari/Chrome inject no wallet. Bounce into MetaMask's own
        // in-app browser via its universal link — it reopens THIS page (with the
        // contract params) inside MetaMask, where window.ethereum exists. If MM
        // isn't installed, the link lands on MetaMask's install page.
        const target = location.host + location.pathname + location.search;
        toast("Opening in the MetaMask app…", "ok");
        location.href = "https://metamask.app.link/dapp/" + target;
        return;
      }
      toast("MetaMask not found — install it to play.", "err");
      window.open("https://metamask.io/download/", "_blank");
      return;
    }
    // (music only starts when the user taps the Music button — never on connect)
    // Mark the whole connect as in-progress so the accountsChanged/chainChanged
    // listeners don't reload the page on the *initial* grant or network switch
    // (that reload is what made people click Connect twice).
    connecting = true;
    // Tear down the public read-only provider + its poller/listeners before the
    // wallet provider takes over (otherwise it keeps hammering the public RPC).
    try { if (read) read.removeAllListeners(); } catch {}
    try { if (provider && provider.destroy) provider.destroy(); } catch {}
    try {
      provider = new E.BrowserProvider(window.ethereum, "any");
      provider.pollingInterval = 2000; // tighter polling for events on injected providers
      await provider.send("eth_requestAccounts", []);
      await ensureNetwork();
      signer = await provider.getSigner();
      account = await signer.getAddress();
      await resolveActiveGame(provider); // honor the registry's active game

      if (!deployment.address) {
        // No game deployed here yet — let this user host one from the browser.
        banner("");
        renderWallet();
        showHostSetup();
        return;
      }
      contract = new E.Contract(deployment.address, ABI, signer);
      read = new E.Contract(deployment.address, ABI, provider);
      twoDiceSupported = null; // re-probe Dice #2 support for this contract
      crashSupported = null;   // re-probe Crash support for this contract
      slotsSupported = null;   // re-probe Slots support for this contract
      try {
        maxBet = await read.maxBet();
      } catch (e) {
        banner("⚠ No game found at this address on this network — switch networks, or deploy a new game.", true);
        renderWallet();
        showHostSetup();
        return;
      }
      try { hostTreasury = await read.treasury(); } catch {}
      try { ownerAddr = await read.owner(); } catch {}

      await startGameUI();
      // Wallet is live: TV switches from static to the game room, profile unlocks.
      if (window.TV && TV.setConnected) TV.setConnected(true);
      // Hand the live signer/contract to the TOKEN-mode controller (the bridge client).
      try { if (window.TokenMode) TokenMode.init({ ethers: E, signer: signer, contract: contract, account: account, chainId: deployment.chainId, contractAddr: deployment.address, usdToWei: usdToWei, toast: toast, gameBalanceUsd: function () { try { return weiToUsd(gameWei); } catch (e) { return 0; } }, isHouseWallet: function () { try { return !!(account && hostTreasury && eq(account, hostTreasury)); } catch (e) { return false; } }, onChange: function () { try { syncTokenGameBalances(); } catch (e) {} try { if (typeof refreshHouse === "function") refreshHouse(); } catch (e) {} try { checkStrandedLock(); } catch (e) {} try { if (currentGame === "blackjack") ensureBlackjackReady(); } catch (e) {} } }); } catch (e) {}
      { const rp = $("rail-profile"); if (rp) rp.hidden = false; }
      // Show Host tools to the contract owner OR the locked house wallet — so the
      // house can always reach "Start a fresh game" even on a game someone else deployed.
      if (eq(account, ownerAddr) || eq(account, ART.defaultTreasury)) { $("host-tools").hidden = false; const rh = $("rail-host"); if (rh) rh.hidden = false; }
      if (inviteRoomId) handleInvite();
      if (inviteHostId) loadHostTable(inviteHostId);
    } catch (err) {
      console.error(err);
      toast(err?.info?.error?.message || err?.shortMessage || "Connection failed", "err");
    } finally {
      connecting = false;
    }
  }

  async function ensureNetwork() {
    const net = await provider.getNetwork();
    const want = deployment.chainId;
    // No specific chain required (host can deploy on whatever testnet they're on).
    if (!want) { chainOK = true; return; }
    if (Number(net.chainId) === want) { chainOK = true; return; }
    chainOK = false;
    const target = NETWORKS[want];
    if (!target) { chainOK = false; return; }
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target.chainId }] });
    } catch (e) {
      if (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902)) {
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [target] });
      } else {
        throw e;
      }
    }
    provider = new E.BrowserProvider(window.ethereum, "any");
    provider.pollingInterval = 2000;
    const net2 = await provider.getNetwork();
    chainOK = Number(net2.chainId) === want;
  }

  // Private host dashboard — only the house (treasury) wallet sees it. Profit for
  // the selected period is summed straight from on-chain game results, so it shows
  // the real winnings AND is never skewed by deposits/withdrawals/cash-outs.
  let hostPeriod = "today";
  const HS_PERIOD_SEC = { today: 86400, week: 604800, month: 2592000, year: 31536000, all: 0 };
  const HS_PERIOD_LABEL = { today: "last 24h", week: "this week", month: "this month", year: "this year", all: "all-time (recent)" };

  // ── Host-earnings game registry ────────────────────────────────────────────
  // Each game declares how to fetch its settled rounds and turn each one into a
  // normalized earnings row. Add a game here and it AUTOMATICALLY gets its own
  // earnings tab + breakdown — nothing else to wire. A row is:
  //   { at, skip, bet, wagered, fees, table }
  //   at      — settle time (unix s)         skip — exclude (host's own test play)
  //   bet     — per-player stake             wagered — volume this round adds
  //   fees    — rake credited to the house   table  — house bankroll swing (±)
  // House net for a round = fees + table; the house's own test rounds are skipped.
  const HOST_GAMES = [
    {
      key: "flip", label: "🪙 Coin Flip",
      fetch: () => recentRooms(2000),
      rows: (list) => list
        .filter((r) => Number(r.status) === 2) // settled only
        .map((r) => ({
          at: Number(r.settledAt),
          skip: eq(r.player1, hostTreasury) || (!r.isHouseGame && eq(r.player2, hostTreasury)),
          bet: r.betAmount,
          wagered: r.betAmount * 2n, // pot = both stakes
          fees: (r.betAmount * 2n * 3n) / 100n, // 3% rake of the pot
          table: r.isHouseGame ? (eq(r.winner, hostTreasury) ? (r.betAmount * 94n) / 100n : -r.betAmount) : 0n,
        })),
    },
    {
      key: "dice", label: "🎲 0-100",
      fetch: () => recentDice(2000),
      rows: (list) => list.map((d) => ({
        at: Number(d.settledAt),
        skip: eq(d.player, hostTreasury), // host's own test rolls
        bet: d.betAmount,
        wagered: d.betAmount, // single-sided vs the house
        fees: 0n, // dice has no separate rake — the edge is realized in `table`
        table: d.won ? -(d.payout - d.betAmount) : d.betAmount, // house P&L vs the roller
      })),
    },
    {
      key: "twodice", label: "🎲🎲 Dice #2",
      fetch: () => recentTwoDice(2000),
      rows: (list) => list.map((d) => ({
        at: Number(d.settledAt),
        skip: eq(d.player, hostTreasury),
        bet: d.betAmount,
        wagered: d.betAmount,
        fees: 0n, // same as dice — edge realized as the bankroll swing
        table: d.won ? -(d.payout - d.betAmount) : d.betAmount,
      })),
    },
  ];
  let hostGame = "all"; // "all" | a HOST_GAMES key

  function renderHostGameTabs() {
    const box = $("hs-game-tabs");
    if (!box || box.dataset.built) return;
    const mk = (key, label) =>
      '<button type="button" class="hs-gtab' + (key === hostGame ? " active" : "") + '" data-game="' + key + '">' + label + "</button>";
    box.innerHTML = mk("all", "All") + HOST_GAMES.map((g) => mk(g.key, g.label)).join("");
    box.querySelectorAll(".hs-gtab").forEach((b) => {
      b.onclick = () => {
        hostGame = b.dataset.game;
        box.querySelectorAll(".hs-gtab").forEach((x) => x.classList.toggle("active", x === b));
        refreshHostPanel();
      };
    });
    box.dataset.built = "1";
  }

  // Sum normalized rows over a period (periodSec = 0 → all-time, within the window).
  function aggHostRows(rows, nowSec, periodSec) {
    let fees = 0n, table = 0n, wagered = 0n, betSum = 0n, games = 0;
    for (const x of rows) {
      if (x.skip) continue;
      if (periodSec && x.at < nowSec - periodSec) continue;
      fees += x.fees; table += x.table; wagered += x.wagered; betSum += x.bet; games += 1;
    }
    return { fees, table, wagered, betSum, games, grand: fees + table };
  }

  async function refreshHostPanel() {
    const card = $("host-stats-card");
    if (!card) return;
    const isHost = account && hostTreasury && eq(account, hostTreasury);
    card.classList.toggle("hidden", !isHost);
    if (!isHost || !read || !chainOK) return;
    renderHostGameTabs();
    try {
      const [bankroll, bal] = await Promise.all([read.houseBankroll(), read.balances(account)]);
      const holdings = bankroll + bal; // ALL the house's money in the contract (shared by every game)
      const nowSec = Math.floor(Date.now() / 1000);
      const periodSec = HS_PERIOD_SEC[hostPeriod] ?? 86400;

      // Build each game's normalized rows once, then pick the active filter.
      const perGame = {};
      await Promise.all(HOST_GAMES.map(async (g) => {
        let list = [];
        try { list = await g.fetch(); } catch {}
        perGame[g.key] = g.rows(list || []);
      }));
      const rows = hostGame === "all"
        ? HOST_GAMES.flatMap((g) => perGame[g.key] || [])
        : (perGame[hostGame] || []);

      const period = aggHostRows(rows, nowSec, periodSec); // selected period
      const life = aggHostRows(rows, nowSec, 0);           // all-time (within the recent window)
      const gLabel = hostGame === "all" ? "All games" : (HOST_GAMES.find((g) => g.key === hostGame)?.label || "");

      $("hs-period-label").textContent = gLabel + " · " + (HS_PERIOD_LABEL[hostPeriod] || "last 24h");
      const pe = $("hs-profit-today");
      pe.textContent = signedUsd(period.grand);
      pe.style.color = period.grand < 0n ? "#ff7a7a" : "#34e39b";
      $("hs-profit-sub").textContent = period.games + " game" + (period.games === 1 ? "" : "s") + " · " + usdOf(period.wagered) + " wagered";
      $("hs-period-fees").textContent = signedUsd(period.fees);
      $("hs-period-table").textContent = signedUsd(period.table);
      $("hs-fees-total").textContent = usdOf(life.fees);
      $("hs-games-total").textContent = life.games.toString();
      $("hs-volume-total").textContent = usdOf(life.wagered);
      $("hs-take").textContent = (life.wagered > 0n ? Number((life.grand * 10000n) / life.wagered) / 100 : 0).toFixed(1) + "%";
      $("hs-avg").textContent = life.games > 0 ? usdOf(life.betSum / BigInt(life.games)) : "$0";
      $("hs-bankroll").textContent = usdOf(bankroll);
      $("hs-balance").textContent = usdOf(holdings); // unified "house funds" = bankroll + balance

      // Live TOKEN-MODE exposure: principal locked in open sessions (can't be withdrawn until the
      // player cashes out) + unrealized house P&L (only hits the on-chain bankroll AT cash-out —
      // which is why "house funds" don't climb while a player is losing tokens mid-session).
      try {
        const tr = $("hs-token-row");
        const hs = await fetch("/api/token/house-state").then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (hs && hs.ok && tr) {
          tr.hidden = false;
          $("hs-tok-open").textContent = String(hs.openSessions || 0);
          $("hs-tok-locked").textContent = "$" + (Math.round((hs.buyInUnits || 0) * 100) / 100).toLocaleString();
          const pnl = Math.round((hs.houseUnrealizedUnits || 0) * 100) / 100;
          const pe2 = $("hs-tok-pnl");
          pe2.textContent = (pnl >= 0 ? "+$" : "−$") + Math.abs(pnl).toLocaleString();
          pe2.style.color = pnl >= 0 ? "#34e39b" : "#ff7a7a";
        } else if (tr) { tr.hidden = true; }
      } catch (e) {}

      // STRANDED-LOCK recovery: show the connected wallet's on-chain bjLocked IF it has no active
      // token session (a lock with no session = orphaned; e.g. lost before the disk was mounted).
      try {
        const sr = $("hs-stuck-row");
        let lockedWei = 0n; try { lockedWei = await read.bjLocked(account); } catch (e) {}
        const hasSession = !!(window.TokenMode && TokenMode.active());
        if (sr) {
          if (lockedWei > 0n && !hasSession) {
            sr.hidden = false;
            $("hs-stuck-amt").textContent = usdOf(lockedWei);
            $("hs-stuck-acct").textContent = "(" + account.slice(0, 6) + "…" + account.slice(-4) + ")";
            const rb = $("release-stuck-btn");
            if (rb && !rb._wired) { rb._wired = true; rb.onclick = async function () { if (!window.TokenMode) return; await TokenMode.releaseStuck(); try { await refreshHostPanel(); } catch (e) {} try { refreshBalances(); } catch (e) {} }; }
          } else { sr.hidden = true; }
        }
        // House-only: a "look up a player by address" tool → open that player's profile (locked funds + release).
        const pl = $("hs-player-lookup");
        if (pl) {
          pl.hidden = false;
          const pb = $("hs-player-btn"), pi = $("hs-player-addr");
          if (pb && !pb._wired) {
            pb._wired = true;
            const go = () => {
              const v = (pi && pi.value || "").trim();
              if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return toast("Enter a valid 0x… wallet address", "err");
              openProfile(v);
            };
            pb.onclick = go;
            if (pi) pi.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
          }
        }
      } catch (e) {}
    } catch {}
  }

  // Warn when the connected wallet is the house itself (you'd be on both sides).
  function updateHouseWalletBanner() {
    const el = $("house-wallet-banner");
    if (!el) return;
    const isHouse = account && hostTreasury && eq(account, hostTreasury);
    el.classList.toggle("hidden", !isHouse);
    // House wallet = the boss: grey out betting + show the "WELCOME BOSS" screen on the TV (CSS).
    try { document.body.classList.toggle("is-house", !!isHouse); } catch (e) {}
  }

  async function startGameUI() {
    renderWallet();
    wireEvents();
    connectWS();
    updateHouseWalletBanner();
    loadHostHistory();
    await refreshAll();
    try { checkStrandedLock(); } catch (e) {} // surface any stranded on-chain lock so the player can recover it
    seedHostHistory(); // backfill host-table flips from logs (async, best-effort)
    checkDailyStreak();
    renderInvite();
    { const r = $("registry-target"); if (r && !r.value && deployment.address) r.value = deployment.address; }
    TV.idle("Deposit ETH, then create or join a room");
    $("bankroll").hidden = false;
    $("play-house").hidden = false;
    $("dice-panel").hidden = false;
    { const td = $("twodice-panel"); if (td) td.hidden = false; }
    { const cp = $("crash-panel"); if (cp) cp.hidden = false; }
    { const pp = $("plane-panel"); if (pp) pp.hidden = false; }     // Plane plays for real (single-shot)
    { const pc = $("ch-plane"); if (pc) pc.hidden = false; }
    document.body.classList.add("plane-real");
    refreshDiceHouse();
    $("maxbet-hint").textContent = "· $10–$" + betCapUsd().toLocaleString();
    setupHouseSlider();
  }

  function renderWallet() {
    exitDemo(); // a real wallet takes over — leave play-money mode
    document.body.classList.add("connected");
    { const bar = $("demo-bar"); if (bar) bar.classList.add("hidden"); }
    { const below = $("demo-below"); if (below) below.classList.add("hidden"); }
    { const ses = $("demo-session"); if (ses) ses.classList.add("hidden"); }
    { const bdg = $("demo-tv-badge"); if (bdg) bdg.classList.add("hidden"); }
    $("connect-btn").classList.add("hidden");
    $("connect-btn").classList.remove("cta-pulse");
    $("disconnect-btn").classList.remove("hidden");
    const chip = $("wallet-chip");
    chip.classList.remove("hidden");
    $("wallet-addr").textContent = short(account);
    blockies(account, 8, 4, $("wallet-avatar"));
    { const f = $("bj-frame"); if (f && !bjFrameMatchesWallet(f, account)) { f.removeAttribute("src"); if (currentGame === "blackjack") ensureBlackjackReady(); } }
    const nb = $("net-badge");
    nb.classList.remove("hidden");
    nb.classList.toggle("wrong", !chainOK);
    $("net-name").textContent = chainOK ? netName(deployment.chainId) : "Wrong network";
    const exp = explorerFor(deployment.chainId);
    if (deployment.address) {
      const a = $("contract-link");
      if (exp) { a.href = exp + deployment.address; a.textContent = short(deployment.address); }
      else a.textContent = short(deployment.address);
    }
  }

  // ---------------------------------------------------------- in-browser hosting
  function showHostSetup() {
    $("host-setup").hidden = false;
    // The house wallet ALWAYS gets the host tools (redeploy / registry) — even when no
    // contract resolves on this network or maxBet() hiccups on a flaky RPC. Otherwise a
    // transient resolve miss hides "redeploy" until you reconnect several times.
    if (eq(account, ART.defaultTreasury) || (ownerAddr && eq(account, ownerAddr))) {
      $("host-tools").hidden = false; const rh = $("rail-host"); if (rh) rh.hidden = false;
    }
  }
  function hideHostSetup() { $("host-setup").hidden = true; }

  async function deployContract() {
    if (!ART.bytecode) return toast("Contract bytecode missing — rebuild with npm run artifact", "err");
    const btn = $("deploy-btn");
    btn.disabled = true;
    try {
      let net = await provider.getNetwork();
      if (Number(net.chainId) === 1) {
        // Never deploy on mainnet — move them to the Sepolia test network.
        toast("Switching MetaMask to Sepolia…");
        try {
          await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
        } catch (e) {
          if (e.code === 4902) {
            await window.ethereum.request({ method: "wallet_addEthereumChain", params: [NETWORKS[11155111]] });
          } else { btn.disabled = false; return txErr(e); }
        }
        provider = new E.BrowserProvider(window.ethereum, "any");
        provider.pollingInterval = 2000;
        signer = await provider.getSigner();
        net = await provider.getNetwork();
      }
      const bal = await provider.getBalance(account);
      if (bal === 0n) {
        btn.disabled = false;
        return toast("This wallet has 0 test ETH on " + netName(Number(net.chainId)) + ". Get free Sepolia ETH from a faucet, then try again.", "err");
      }
      toast("Deploying your game… confirm in MetaMask");
      const factory = new E.ContractFactory(ABI, ART.bytecode, signer);
      // The house (treasury / fee recipient) is LOCKED to the fixed wallet below,
      // not whoever deploys — so a player can never accidentally become the house.
      const houseWallet = ART.defaultTreasury || account;
      // Explicit gasLimit skips eth_estimateGas — flaky public Sepolia RPCs make
      // ethers throw "could not coalesce error" there even with funds available.
      // The contract is now ~24KB (flip + host tables + dice + crash + slots), so
      // code deposit alone is ~4.8M gas; 8M leaves margin. Sepolia blocks are 30M.
      const c = await factory.deploy(houseWallet, { gasLimit: 8_000_000n });
      await c.waitForDeployment();
      const addr = await c.getAddress();
      deployment = { address: addr, chainId: Number(net.chainId) };
      saveStored(deployment);
      contract = c.connect(signer);
      read = new E.Contract(addr, ABI, provider);
      twoDiceSupported = null; // re-probe Dice #2 support for this contract
      crashSupported = null;   // re-probe Crash support for this contract
      slotsSupported = null;   // re-probe Slots support for this contract
      // Seed a small house bankroll so vs-house works right away (best effort).
      try { await (await contract.fundHouse({ value: usdToWei(1000), gasLimit: 150_000n })).wait(); } catch {}
      maxBet = await read.maxBet();
      try { hostTreasury = await read.treasury(); } catch {}
      chainOK = true;
      // If a registry is configured + we're the owner, flip the whole site to the
      // new contract automatically — one tx, no code push, every visitor follows.
      let auto = false;
      if (cfg.registry && E.isAddress(cfg.registry)) {
        try {
          const reg = new E.Contract(cfg.registry, ["function owner() view returns (address)", "function setActiveGame(address)"], signer);
          if (eq(await reg.owner(), account)) {
            toast("Pointing the site at the new contract… confirm in MetaMask");
            await (await reg.setActiveGame(addr, { gasLimit: 80000 })).wait();
            auto = true;
          }
        } catch (e) { /* fall back to the manual prompt below */ }
      }
      history.replaceState(null, "", shareUrlFor(null));
      hideHostSetup();
      await startGameUI();
      showShareGameLink();
      toast(auto ? "Game deployed — the whole site is now on it! 🎉" : "Game deployed — you're the host! 🎉", "ok");
      if (!auto) {
        // No registry yet — surface the address so it can be baked into config.js.
        try {
          window.prompt(
            "✅ New contract deployed!\n\nCopy this address and send it over so the live site points at it:",
            addr
          );
        } catch {}
      }
    } catch (e) {
      btn.disabled = false;
      txErr(e);
    }
  }

  async function deployRegistry() {
    if (!account || !signer) return toast("Connect your wallet first.", "err");
    if (!ART.registry || !ART.registry.bytecode) return toast("Registry artifact missing — rebuild with npm run artifact", "err");
    if (!confirm(
      "Deploy the one-time GAME REGISTRY?\n\n" +
      "This is an immutable pointer that lets future redeploys switch the WHOLE site " +
      "to a new contract with a single transaction — no code push. You'll send its " +
      "address once to bake in, then never again.\n\nIt points at the current game to start."
    )) return;
    try {
      toast("Deploying the registry… confirm in MetaMask");
      const houseWallet = ART.defaultTreasury || account;
      const cur = deployment.address || houseWallet;
      const factory = new E.ContractFactory(ART.registry.abi, ART.registry.bytecode, signer);
      const c = await factory.deploy(houseWallet, cur, { gasLimit: 600000n });
      await c.waitForDeployment();
      const addr = await c.getAddress();
      toast("Registry deployed! 🛰️", "ok");
      try {
        window.prompt(
          "✅ Registry deployed (one-time)!\n\nSend this address to bake into config.js. After that, redeploys flip the site automatically:",
          addr
        );
      } catch {}
    } catch (e) { txErr(e); }
  }

  // Manually point the registry at a contract (owner only). Flips the whole site.
  async function setActiveGameManual() {
    if (!signer || !account) return toast("Connect your wallet first.", "err");
    if (!cfg.registry || !E.isAddress(cfg.registry)) return toast("No registry configured.", "err");
    const target = (($("registry-target") && $("registry-target").value) || deployment.address || "").trim();
    if (!E.isAddress(target)) return toast("Enter a valid contract address to make active.", "err");
    try {
      const reg = new E.Contract(cfg.registry, ["function owner() view returns (address)", "function setActiveGame(address)"], signer);
      if (!eq(await reg.owner(), account)) return toast("Only the registry owner (the house wallet) can do this.", "err");
      toast("Pointing the whole site at " + short(target) + "… confirm in MetaMask");
      await (await reg.setActiveGame(target, { gasLimit: 80000 })).wait();
      toast("Done — every visitor now lands on this contract. 🎯", "ok");
    } catch (e) { txErr(e); }
  }

  function showShareGameLink() {
    const box = $("host-share");
    if (!box) return;
    box.classList.remove("hidden");
    $("host-share-link").value = shareUrlFor(null);
  }

  // ---- Host tools (owner only) ----
  async function raiseMaxBet() {
    try {
      toast("Raising the max bet… confirm in MetaMask");
      const tx = await contract.setMaxBet(E.parseEther("1"), { gasLimit: 80000 });
      await tx.wait();
      maxBet = await read.maxBet();
      setupSliders(); refreshHouse();
      toast("Done — bets up to $500 are allowed now.", "ok");
    } catch (e) { txErr(e); }
  }
  async function fundHouseTool() {
    const v = parseFloat($("fund-house-input").value);
    if (!(v > 0)) return toast("Enter a $ amount to fund the house", "err");
    try {
      const value = usdToWei(v);
      // Funding spends REAL wallet ETH (not your in-game balance). Guard against
      // asking for more than the wallet holds so MetaMask doesn't flag/fail it.
      let wbal = walletWei;
      try { wbal = await provider.getBalance(account); walletWei = wbal; } catch {}
      const reserve = depositReserveWei(); // keep a little ETH for gas
      if (value + reserve > wbal) {
        const haveUsd = usd(weiToUsd(wbal > reserve ? wbal - reserve : 0n));
        return toast("Your wallet only has " + usd(weiToUsd(wbal)) + " — you can fund up to about " + haveUsd + ". Top up Sepolia ETH for more.", "err");
      }
      toast("Funding the house… confirm in MetaMask");
      const tx = await contract.fundHouse({ value, gasLimit: await estGas("fundHouse", [], { value }, 150_000n) });
      await tx.wait();
      toast("House funded with " + usd(v), "ok");
      refreshHouse();
    } catch (e) { txErr(e); }
  }

  // Register the TOKEN BRIDGE house signer on-chain (owner-only). The address comes from
  // `node server/realmoney.js --genkey`; its private key goes in the Render env HOUSE_SIGNER_KEY.
  // After this, the contract trusts settlements signed by that signer, so token cash-outs work.
  async function setSignerTool() {
    const addr = (($("bj-signer-input") || {}).value || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return toast("Paste the token signer ADDRESS (0x…) printed by `node server/realmoney.js --genkey`", "err");
    if (!account || !signer || !contract) return toast("Connect your (owner) wallet first.", "err");
    try {
      toast("Setting the token signer… confirm in MetaMask");
      const tx = await contract.setBlackjackSigner(addr, { gasLimit: await estGas("setBlackjackSigner", [addr], {}, 120_000n) });
      await tx.wait();
      toast("Token signer set ✓ — the bridge can now authorize cash-outs", "ok");
    } catch (e) { txErr(e); }
  }

  // Release ALL house funds (bankroll + your balance) to your MetaMask wallet.
  async function cashOutHouse() {
    if (!ready()) return;
    if (!confirm("Cash out ALL house funds (bankroll + balance) to your wallet?\n\nThis empties the house — players can't bet vs House until you deposit/fund it again.")) return;
    try {
      const [bankroll, bal] = await Promise.all([read.houseBankroll(), read.balances(account)]);
      let any = false;
      if (bankroll > 0n) {
        toast("Releasing house bankroll… confirm in MetaMask");
        await (await contract.withdrawHouse(bankroll, { gasLimit: await estGas("withdrawHouse", [bankroll], null, 150_000n) })).wait();
        any = true;
      }
      if (bal > 0n) {
        toast("Releasing your balance… confirm in MetaMask");
        await (await contract.withdrawAll()).wait();
        any = true;
      }
      toast(any ? "Cashed out to your wallet 🏦" : "Nothing to cash out", any ? "ok" : "err");
      refreshHouse(); refreshBalances(); refreshHostPanel();
    } catch (e) { txErr(e); }
  }

  // Cash out a chosen $ amount to your wallet — your balance first, then bankroll.
  async function cashOutAmount() {
    if (!ready()) return;
    const v = parseFloat($("cashout-input").value);
    if (!(v > 0)) return toast("Enter a $ amount to cash out", "err");
    let want = usdToWei(v);
    try {
      const [bankroll, bal] = await Promise.all([read.houseBankroll(), read.balances(account)]);
      const total = bankroll + bal;
      if (want > total) {
        if (want - total > usdToWei(1)) return toast("That's more than the house has. Max is " + usdOf(total) + ".", "err");
        want = total; // tiny rounding over — just take it all
      }
      const fromBal = want > bal ? bal : want;
      const fromBank = want - fromBal;
      if (fromBal > 0n) {
        toast("Withdrawing from balance… confirm in MetaMask");
        await (await contract.withdraw(fromBal, { gasLimit: await estGas("withdraw", [fromBal], null, 120_000n) })).wait();
      }
      if (fromBank > 0n) {
        toast("Withdrawing from bankroll… confirm in MetaMask");
        await (await contract.withdrawHouse(fromBank, { gasLimit: await estGas("withdrawHouse", [fromBank], null, 150_000n) })).wait();
      }
      $("cashout-input").value = "";
      toast("Cashed out " + usd(v) + " to your wallet 🏦", "ok");
      refreshHouse(); refreshBalances(); refreshHostPanel();
    } catch (e) { txErr(e); }
  }
  async function newGame() {
    if (!account || !signer) { toast("Connect your wallet first, then redeploy.", "err"); return; }
    if (!confirm(
      "Deploy a BRAND-NEW game contract from this wallet?\n\n" +
      "This mints a fresh, EMPTY contract on-chain (the latest version — includes Dice #2). " +
      "It does NOT move money: your in-game balance AND the house bankroll stay in the OLD " +
      "contract.\n\nRecommended first: open 'Host earnings' → 'Cash out everything to my wallet' " +
      "so you have the ETH to fund the new house. After it deploys, use 'Fund house' to set the " +
      "new bankroll.\n\n" +
      "When it finishes the site is auto-pointed at the new contract for everyone."
    )) return;
    // Drop any stale ?contract / saved deployment so we deploy clean.
    try { localStorage.removeItem("coinflip_deployment"); } catch {}
    await deployContract();
  }

  async function disconnect() {
    // MetaMask has no true "log out" from the dApp side; revoke the permission
    // (newer MetaMask) and reload so the page returns to the Connect state.
    try {
      await window.ethereum?.request?.({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {}
    try { ws && ws.close(); } catch {}
    location.reload();
  }

  // ---------------------------------------------------------- reads / render
  async function refreshAll() {
    if (!read || !chainOK) return;
    updateHouseWalletBanner();
    await Promise.all([refreshBalances(), refreshRooms(), refreshStats(), refreshHouse(), refreshPlayers(), refreshMyTables(), refreshMyHistory(), refreshHostPanel()]);
  }

  // While a flip/dice result is animating, freeze the in-game balance display so
  // it doesn't move (up=won / down=lost) and spoil the reveal. Unlocked when the
  // TV actually shows the result (tv.js fires window.__onTvReveal).
  let revealLock = false, revealLockTimer = 0;
  let demoFlipBusy = false; // a flip settles money immediately; block a 2nd until its reveal lands
  function lockReveal() {
    revealLock = true;
    clearTimeout(revealLockTimer);
    revealLockTimer = setTimeout(() => { revealLock = false; refreshBalances(); }, 20000); // safety
  }
  function unlockReveal() {
    if (!revealLock) return;
    revealLock = false;
    clearTimeout(revealLockTimer);
    refreshBalances();
  }
  // At the TV reveal climax: release the balance freeze, then (in demo) repaint
  // the play-money balance and re-sync the affordability guards to the new total.
  window.__onTvReveal = function (res) {
    unlockReveal(res);
    if (demoOn) demoSyncBalance();
    try { maybeShareWin(res); } catch (e) {} // green "share your win" button on any win
    try { outcomeFromReveal(res); } catch (e) {} // universal WIN/LOSE result screen
  };

  // Outcome handoff to the win-animation engine. For the Magic Cliffs theme the
  // whole reveal (build-up → win/loss) replaces the coin, so it handles BOTH
  // outcomes; flipReveal returns true when it takes over. For Neon, only a WIN
  // triggers a celebration scene over the landed coin.
  function playOutcome(o) {
    // The Coin Flip reveal is now the on-TV coin TOSS (spins into the air, lands
    // on HEADS/TAILS) plus the tiered green win celebration in tv.js — no video
    // overlay. Left as a no-op so all the flip callers stay unchanged; the TV's
    // _doReveal/_celebrate drive the whole show.
  }
  // Cinematic reels: one of four per outcome, picked at random. Muted so they
  // always autoplay (the chiptune fanfare carries the sound); on end the TV's
  // landed-result shows underneath.
  // ?aud=2 busts caches that still hold the earlier SILENT encodes of these reels.
  const CINE = {
    win: ["assets/wins/win1.mp4?aud=2", "assets/wins/win2.mp4?aud=2", "assets/wins/win3.mp4?aud=2", "assets/wins/win4.mp4?aud=2"],
    loss: ["assets/losses/loss1.mp4?aud=2", "assets/losses/loss2.mp4?aud=2", "assets/losses/loss3.mp4?aud=2", "assets/losses/loss4.mp4?aud=2"],
  };
  // Browsers block a video with sound from auto-playing a few seconds after a
  // click. So on the user's FIRST interaction we "bless" the reveal element with
  // a silent (volume 0) gesture-initiated play — after which it's allowed to play
  // WITH audio later, even programmatically. (iOS Safari especially needs this.)
  // Reel SOUNDTRACKS, extracted to small mp3s. We decode them to AudioBuffers and
  // play them through Web Audio — fully independent of the video element, so the
  // sound is smooth even when the video streams/hesitates on mobile, and it plays
  // on every platform (muted video autoplays; Web Audio carries the audio).
  const CINE_AUDIO = {
    win: ["assets/wins/win1.mp3", "assets/wins/win2.mp3", "assets/wins/win3.mp3", "assets/wins/win4.mp3"],
    loss: ["assets/losses/loss1.mp3", "assets/losses/loss2.mp3", "assets/losses/loss3.mp3", "assets/losses/loss4.mp3"],
  };
  const reelAudio = {};        // url -> decoded AudioBuffer
  let reelsPreloaded = false;
  function preloadReels() {
    if (reelsPreloaded) return; reelsPreloaded = true;
    CINE_AUDIO.win.concat(CINE_AUDIO.loss).forEach((u) => {
      fetch(u).then((r) => r.arrayBuffer()).then((ab) => (window.Chiptune && Chiptune.decode ? Chiptune.decode(ab) : null))
        .then((buf) => { if (buf) reelAudio[u] = buf; }).catch(() => {});
    });
    // Warm the video files into cache too so the picture doesn't hesitate.
    CINE.win.concat(CINE.loss).forEach((u) => { try { fetch(u).catch(() => {}); } catch (e) {} });
  }
  function resumeVideoCtx() { try { if (window.Chiptune && Chiptune.wake) Chiptune.wake(); } catch (e) {} }
  let audioUnlocked = false;
  function unlockReelAudio() {
    if (audioUnlocked) return; audioUnlocked = true;
    resumeVideoCtx();   // unlock the shared Web Audio context on this gesture
    preloadReels();     // decode soundtracks + warm videos in the background
  }
  function setupRevealAudioUnlock() {
    const evs = ["pointerdown", "touchend", "click", "keydown"];
    const f = () => { unlockReelAudio(); evs.forEach((e) => document.removeEventListener(e, f)); };
    evs.forEach((e) => document.addEventListener(e, f, { passive: true, once: true }));
  }
  // The outcome "payoff" — balance update + (fallback) win/loss sound — fires at
  // the reel's CLIMAX (when Scarfblade opens the chest), not at the start, so it
  // never spoils the result early. If the reel is playing WITH its own audio we
  // let that carry the moment; only when audio was blocked (muted fallback) do we
  // play the chiptune fanfare instead.
  function cinePayoff(won, netUsd) {
    try { window.__onTvReveal && window.__onTvReveal({}); } catch {}   // release the in-game balance now
    // Always play the coin-tally win/loss jingle at the climax — it layers nicely
    // OVER the reel's own audio (the player liked the "coins counting" sound).
    try {
      const C = window.Chiptune;
      if (C) { if (!won) C.lose && C.lose(); else if (netUsd >= 300 && C.jackpot) C.jackpot(); else if (netUsd >= 100 && C.bigwin) C.bigwin(); else C.win && C.win(); }
    } catch {}
  }
  function videoReveal(won, netUsd) {
    const v = $("reveal-video"); if (!v) return false;
    let myTimer = 0; // per-reveal safety timer so overlapping reveals don't orphan each other's
    const vids = won ? CINE.win : CINE.loss;
    const auds = won ? CINE_AUDIO.win : CINE_AUDIO.loss;
    if (!vids || !vids.length) return false;
    const i = Math.floor(Math.random() * vids.length);
    const src = vids[i], audUrl = auds[i];
    let paid = false, clip = null, ended = false;
    const pay = () => { if (paid) return; paid = true; cinePayoff(won, netUsd || 0); };
    const done = () => {
      if (ended) return; ended = true;
      clearTimeout(myTimer); v.onended = null; v.onerror = null; v.oncanplay = null;
      pay();                                              // balance + fanfare at the very end (no spoiler)
      try { if (clip) clip.stop(); } catch {}
      v.classList.remove("show"); try { v.pause(); } catch {} v.removeAttribute("src"); try { v.load(); } catch {}
      try { window.__winSceneActive = false; window.__cineActive = false; } catch {}
      try { window.Chiptune && Chiptune.duckMusic(false); } catch {}
    };
    clearTimeout(myTimer);
    resumeVideoCtx();                                     // make sure the audio context is awake
    try { window.Chiptune && Chiptune.duckMusic(true); } catch {}
    // The VIDEO is always muted -> it autoplays on every platform, and never
    // hesitates the audio. Sound comes from the pre-decoded buffer via Web Audio.
    v.muted = true; v.defaultMuted = true; v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
    v.classList.add("show");
    try { window.__winSceneActive = true; window.__cineActive = true; } catch {}
    v.onerror = done;
    v.src = src; try { v.load(); } catch {}

    // Play the (muted) picture.
    const go = () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); };
    if (v.readyState >= 1) go(); else v.oncanplay = () => { v.oncanplay = null; go(); };
    go();

    // Drive sound + timing off the SMOOTH decoded audio when we have it (immune to
    // video buffering). Fall back to the video's own end if it isn't decoded yet.
    const startClip = (buf) => {
      if (ended || !buf) return false;
      clip = (window.Chiptune && Chiptune.playClip) ? Chiptune.playClip(buf, done) : null;
      myTimer = setTimeout(done, buf.duration * 1000 + 1500); // safety past the clip
      return !!clip;
    };
    const buf = reelAudio[audUrl];
    if (buf) {
      if (!startClip(buf)) { v.onended = done; myTimer = setTimeout(done, 9500); }
    } else {
      // not decoded yet — fetch+decode on the fly, drive off the video meanwhile
      v.onended = done;
      myTimer = setTimeout(done, 9500);
      fetch(audUrl).then((r) => r.arrayBuffer()).then((ab) => Chiptune.decode(ab)).then((b) => {
        reelAudio[audUrl] = b;
        if (!ended && !clip) { clearTimeout(myTimer); v.onended = null; startClip(b); }
      }).catch(() => {});
    }
    return true;
  }
  function flipBuildup(betWei) { try { window.WinScenes && WinScenes.flipStart && WinScenes.flipStart({ betUsd: weiToUsd(betWei) }); } catch (e) {} }
  function cancelBuildup() { try { window.WinScenes && WinScenes.flipCancel && WinScenes.flipCancel(); } catch (e) {} }

  async function refreshBalances() {
    if (demoOn) { demoPaint(); return; }
    try {
      const [gb, wb] = await Promise.all([read.balances(account), provider.getBalance(account)]);
      const gameWeiChanged = gb !== gameWei;
      gameWei = gb; // cached so "Max" can read the live in-game balance instantly
      if (!revealLock) $("game-balance").textContent = usdOf(gb); // hold until the result is revealed
      $("wallet-balance").textContent = usdOf(wb);
      walletWei = wb;
      if (planeGame && !demoOn && !revealLock) try { planeGame.setBalance(weiToUsd(gb)); } catch (e) {}
      paintBjConnectedBalance();
      syncDepositSlider();
      syncWithdrawSlider();
      // BUG4 (deposit lag): a fresh deposit raises gameWei, but the TokenMode "Buy in" bar caches its
      // slider max from the OLD balance until something re-renders it — so the just-deposited amount
      // can't be added until a later cycle. Re-render the bar whenever the in-game balance actually
      // changes. The guard means this only fires on deposit/withdraw/settle (never mid-drag, since the
      // balance is static while the user drags the buy-in slider), so it can't interrupt a drag.
      if (gameWeiChanged) { try { if (window.TokenMode && TokenMode._render) TokenMode._render(); } catch (e) {} }
    } catch {}
  }

  // ── Deposit / withdraw buttons show a live dollar + approx-ETH value ──
  let withdrawTouched = false; // once the user drags the withdraw slider, stop auto-snapping to "all"
  function ethApprox(usdVal) { const e = ethUsd > 0 ? usdVal / ethUsd : 0; return e.toFixed(4); }
  function updateDepositBtn() {
    const s = $("deposit-input"), b = $("deposit-btn");
    if (!s || !b || b.dataset.busy) return;
    const v = Math.round(+s.value || 0);
    b.textContent = v > 0 ? ("Deposit $" + v + " · ≈ " + ethApprox(v) + " ETH") : "Deposit";
  }
  function updateWithdrawBtn() {
    const s = $("withdraw-input"), b = $("withdraw-btn");
    if (!s || !b || b.dataset.busy) return;
    const v = Math.round(+s.value || 0), max = Math.round(+s.max || 0);
    b.style.opacity = v <= 0 ? "0.55" : "";
    if (v <= 0) b.textContent = "Withdraw";
    else if (v >= max) b.textContent = "Withdraw all";
    else b.textContent = "Withdraw $" + v + " · ≈ " + ethApprox(v) + " ETH";
  }
  function syncWithdrawSlider() {
    const s = $("withdraw-input"); if (!s) return;
    const balUsd = gameWei > 0n ? Math.floor(weiToUsd(gameWei)) : 0;
    s.max = String(Math.max(0, balUsd));
    if (!withdrawTouched || +s.value > +s.max) s.value = s.max; // default to "all" until they drag it
    setSliderUsd("withdraw-input");
    updateWithdrawBtn();
  }

  // Keep ~0.01 ETH in the wallet so there's gas left for the bets that follow a
  // "deposit max" — depositing the literal full balance would leave nothing to
  // sign with.
  function depositReserveWei() { try { return E.parseEther("0.01"); } catch { return 0n; } }
  function depositableWei() {
    const r = depositReserveWei();
    return walletWei > r ? walletWei - r : 0n;
  }
  // The deposit slider tops out at what the wallet can actually cover (rounded
  // down to the $5 step), never above the $2,000 ceiling.
  function depositCapUsd() {
    if (!walletWei || walletWei <= 0n) return 500;
    const usd = Math.floor(weiToUsd(depositableWei()) / 5) * 5;
    return Math.max(10, Math.min(DEPOSIT_MAX_USD, usd));
  }
  function syncDepositSlider() {
    const s = $("deposit-input"); if (!s) return;
    const max = depositCapUsd();
    s.max = String(max);
    if (+s.value > max) s.value = String(max);
    if (+s.value < 10) s.value = String(Math.min(max, 50));
    const hint = $("deposit-max-hint");
    if (hint) {
      if (account && walletWei <= depositReserveWei()) {
        // No test ETH to play with — surface a faucet right where they're stuck.
        hint.innerHTML = 'No test ETH? <a href="https://sepolia-faucet.pk910.de/#/" target="_blank" rel="noopener">Get free Sepolia ETH ↗</a>';
      } else {
        hint.textContent = walletWei > 0n
          ? "Max ≈ " + usd(weiToUsd(depositableWei())) + " (a little ETH kept for gas)"
          : "Slide all the way to deposit your wallet max";
      }
    }
    setSliderUsd("deposit-input");
    updateDepositBtn();
  }

  async function refreshStats() {
    try {
      const [g, w, f] = await Promise.all([read.totalGamesPlayed(), read.totalWagered(), read.totalFeesCollected()]);
      $("stat-games").textContent = g.toString();
      $("stat-wagered").textContent = usdOf(w);
      $("stat-fees").textContent = usdOf(f);
    } catch {}
  }

  async function refreshRooms() {
    try {
      const rooms = await read.getOpenRooms();
      const list = $("rooms-list");
      $("rooms-count").textContent = rooms.length;
      list.innerHTML = "";
      if (!rooms.length) {
        list.innerHTML = '<li class="empty">No open rooms. Create one!</li>';
        return;
      }
      for (const r of rooms) {
        const id = r.id.toString();
        const mine = eq(r.creator, account);
        const li = document.createElement("li");
        li.className = "room-item";
        li.innerHTML =
          `<div class="rinfo"><div class="rname">${escapeHtml(r.name)}</div>` +
          `<div class="rmeta">#${id} · by ${mine ? "you" : short(r.creator)}</div></div>` +
          `<span class="rbet">${usdOf(r.betAmount)}</span>`;
        const btn = document.createElement("button");
        btn.className = "btn " + (mine ? "btn-ghost" : "btn-primary");
        btn.textContent = mine ? "Cancel" : "Join";
        btn.onclick = () => (mine ? cancelRoom(id) : joinRoom(id, r));
        li.appendChild(btn);
        list.appendChild(li);
      }
    } catch (e) { console.error(e); }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------- actions
  // Guard every on-chain action so a not-yet-connected / no-game state shows a
  // clear message instead of a raw "Cannot read properties of null" crash.
  function ready() {
    if (!account) { toast("Connect your wallet first 👆 (top-right).", "err"); return false; }
    if (!contract || !read || !deployment.address) {
      toast("No game loaded here — open the host's share link (it carries the game address), or deploy a game.", "err");
      return false;
    }
    if (!chainOK) { toast("Wrong network — switch to " + netName(deployment.chainId) + " and try again.", "err"); return false; }
    return true;
  }

  // A small "are you sure?" step before any wallet↔credits transfer, so the
  // player always sees exactly how much is moving (and which way) BEFORE the
  // MetaMask popup. Returns a Promise<boolean>.
  let _xferResolve = null;
  function confirmTransfer(o) {
    return new Promise((resolve) => {
      _xferResolve = resolve;
      $("xfer-title").textContent = o.title;
      $("xfer-sub").textContent = o.sub || "";
      $("xfer-usd").textContent = o.usd;
      $("xfer-eth").textContent = o.eth || "";
      $("xfer-from").textContent = o.from;
      $("xfer-to").textContent = o.to;
      const cb = $("xfer-confirm"); if (cb) cb.textContent = o.confirmLabel || "✓ Confirm";
      const nt = $("xfer-note"); if (nt) nt.textContent = o.note || "You'll still approve the transaction in your wallet on the next step.";
      $("xfer-modal").classList.remove("hidden");
    });
  }
  function closeXfer(result) {
    const m = $("xfer-modal"); if (m) m.classList.add("hidden");
    const r = _xferResolve; _xferResolve = null;
    if (r) r(!!result);
  }

  async function deposit() {
    if (!ready()) return;
    const s = $("deposit-input");
    const v = parseFloat(s.value); // USD
    if (!(v > 0)) return toast("Enter an amount to deposit (in $)", "err");
    // Sliding all the way deposits the true wallet max (minus a gas reserve);
    // otherwise convert the chosen $ amount, but never exceed the wallet.
    const cap = depositableWei();
    let value = (+s.value >= +s.max) ? cap : usdToWei(v);
    if (value > cap) value = cap;
    if (value <= 0n) return toast("Not enough ETH to deposit after leaving gas. Top up your wallet first.", "err");
    // Confirm the exact amount + direction before opening MetaMask.
    const ethStr = (() => { try { return (+E.formatEther(value)).toFixed(4); } catch { return ethApprox(weiToUsd(value)); } })();
    const ok = await confirmTransfer({
      title: "Add game credits", sub: "Move money from your wallet into the game so you can play.",
      usd: usd(weiToUsd(value)), eth: "≈ " + ethStr + " ETH", from: "Your wallet", to: "Game credits",
      confirmLabel: "✓ Add " + usd(weiToUsd(value)),
    });
    if (!ok) return;
    const btn = $("deposit-btn");
    setBtnBusy(btn, "Depositing Funds…");
    try {
      toast("Confirm the deposit in MetaMask…");
      const tx = await contract.deposit({ value, gasLimit: await estGas("deposit", [], { value }, 130_000n) });
      await tx.wait();
      toast("Deposited " + usd(weiToUsd(value)), "ok");
      refreshBalances();
    } catch (e) { txErr(e); }
    finally { clearBtnBusy(btn); updateDepositBtn(); }
  }

  // Mark a button as mid-transaction (locked + spinner text), then restore.
  function setBtnBusy(btn, text) {
    if (!btn) return;
    btn.dataset.busy = "1"; btn.disabled = true; btn.classList.add("is-busy"); btn.textContent = text;
  }
  function clearBtnBusy(btn) {
    if (!btn) return;
    delete btn.dataset.busy; btn.disabled = false; btn.classList.remove("is-busy");
  }
  // Withdraw the slider amount; full slider = withdrawAll (avoids dust).
  async function withdrawClick() {
    if (!ready()) return;
    const s = $("withdraw-input");
    const v = s ? +s.value : 0, max = s ? (+s.max || 0) : 0;
    if (!(v > 0)) return toast("Slide to choose how much to withdraw", "err");
    const all = v >= max;
    const amtUsd = all ? (gameWei > 0n ? weiToUsd(gameWei) : v) : v;
    const ok = await confirmTransfer({
      title: "Cash out to wallet", sub: "Move credits out of the game and back into your wallet.",
      usd: usd(amtUsd), eth: "≈ " + ethApprox(amtUsd) + " ETH", from: "Game credits", to: "Your wallet",
      confirmLabel: all ? "✓ Cash out everything" : "✓ Cash out " + usd(amtUsd),
    });
    if (!ok) return;
    doWithdraw(all ? null : usdToWei(v));
  }
  async function doWithdraw(weiAmtOrNull) {
    const btn = $("withdraw-btn");
    setBtnBusy(btn, "Withdrawing Funds…");
    try {
      toast("Confirm the withdrawal…");
      const tx = weiAmtOrNull == null
        ? await contract.withdrawAll()
        : await contract.withdraw(weiAmtOrNull, { gasLimit: await estGas("withdraw", [weiAmtOrNull], null, 120_000n) });
      await tx.wait();
      toast("Withdrawn to your wallet", "ok");
      withdrawTouched = false; // snap back to "all" default next time
      refreshBalances();
    } catch (e) { txErr(e); }
    finally { clearBtnBusy(btn); updateWithdrawBtn(); }
  }

  async function createRoom() {
    if (!ready()) return;
    const name = ($("room-name").value || "Coin Flip").trim();
    const v = parseFloat($("bet-input").value); // USD
    if (!(v > 0)) return toast("Pick a bet amount", "err");
    const bet = usdToWei(v);
    if (bet > maxBet) return toast("Max bet is " + usdOf(maxBet), "err");
    try {
      const gb = await read.balances(account);
      if (gb < bet) return toast("Deposit first 👇 — the bet comes from your in-game balance (you have " + usdOf(gb) + ").", "err");
    } catch {}
    try {
      toast("Creating room… confirm in MetaMask");
      const heads = sideOf("create-side");
      const tx = await contract.createRoom(bet, name, heads, { gasLimit: await estGas("createRoom", [bet, name, heads], null, 700000n) });
      const rcpt = await tx.wait();
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "RoomCreated");
      const id = ev ? ev.args.roomId.toString() : null;
      toast("Room created!", "ok");
      if (id) showShareLink(id);
      activeRoomId = id;
      TV.waiting({ p1: account, p1Heads: heads, sub: "Share your link · waiting for a challenger" });
      refreshBalances(); refreshRooms();
      wsSend({ type: "rooms-updated", roomId: id });
    } catch (e) { txErr(e); }
  }

  // Clicking "Join" opens the bet-confirmation modal (with an optional raise).
  function joinRoom(id, room) {
    if (!ready()) return;
    openBetModal({ kind: "join", id: id, room: room, bet: room.betAmount });
  }

  async function doJoinRoom(id, room, bet) {
    activeRoomId = id;
    lastRevealed = null;
    lockReveal();
    flipBuildup(bet);
    TV.startFlip({ p1: room ? room.creator : null, p2: account, p1Heads: room ? room.creatorHeads : true });
    tvPending(true);
    toast("Sending your bet… confirm in your wallet", "ok");
    try {
      const tx = await contract.joinRoom(id, { gasLimit: 700000n });
      await tx.wait();
      tvPending(false);
      toast("You're in! Flipping…", "ok");
      refreshBalances(); refreshRooms();
      wsSend({ type: "flip", roomId: id });
    } catch (e) {
      tvPending(false);
      activeRoomId = null;
      unlockReveal(); cancelBuildup();
      TV.idle("Deposit ETH, then create or join a room");
      txErr(e);
    }
  }

  // Clicking "Flip vs House" opens the bet-confirmation modal (drag-chosen stake).
  async function playHouse() {
    if (window.TokenMode && TokenMode.active()) return tokenFlip();
    if (demoOn) return demoFlip();
    if (!ready()) return;
    const v = parseFloat($("house-bet").value); // USD
    if (!(v > 0)) return toast("Drag to pick a stake", "err");
    const bet = usdToWei(v);
    if (bet > maxBet) return toast("Max bet is " + usdOf(maxBet), "err");
    // The house must be able to match your stake from its bankroll.
    const capUsd = parseFloat($("house-bet").max || "0");
    if (v > capUsd) return toast("House can only cover " + usd(capUsd) + " right now", "err");
    try {
      const gb = await read.balances(account);
      if (gb < bet) return toast("Deposit first 👇 — your stake comes from your in-game balance (you have " + usdOf(gb) + ").", "err");
    } catch {}
    rememberBet(v);
    openBetModal({ kind: "house", bet: bet, heads: sideOf("house-side") });
  }

  async function doPlayHouse(bet, wantsHeads) {
    // Instant feedback: spin the coin + show the "confirm in wallet" banner the
    // moment they accept, so the wait for the wallet popup isn't a dead screen.
    lastRevealed = null;
    activeRoomId = null;
    lockReveal();
    flipBuildup(bet);
    TV.startFlip({ p1: account, p2: "HOUSE", p1Heads: wantsHeads });
    tvPending(true);
    toast("Sending your bet… confirm in your wallet", "ok");
    try {
      // Learn the room id up-front so the result reveal can't race ahead of us.
      let predicted;
      try {
        predicted = await contract.playHouse.staticCall(bet, wantsHeads);
      } catch (e) {
        tvPending(false); unlockReveal(); cancelBuildup(); TV.idle("Deposit ETH, then create or join a room");
        return txErr(e);
      }
      activeRoomId = predicted.toString();
      // Fixed gas skips the eth_estimateGas round-trip — one less slow hop to the
      // wallet popup on mobile (700k is plenty for playHouse).
      const tx = await contract.playHouse(bet, wantsHeads, { gasLimit: 700000n });
      const rcpt = await tx.wait();
      tvPending(false);
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "HouseGameStarted");
      if (ev) activeRoomId = ev.args.roomId.toString();
      refreshBalances(); refreshHouse(); refreshStats();
      wsSend({ type: "flip", roomId: activeRoomId });
    } catch (e) {
      tvPending(false);
      activeRoomId = null;
      unlockReveal(); cancelBuildup();
      TV.idle("Deposit ETH, then create or join a room");
      txErr(e);
    }
  }

  // TOKEN flip: the coin outcome comes from the SERVER bridge (no wallet popup per flip),
  // rendered with the exact demoFlip choreography. Balance is the token ledger (TokenMode),
  // never demoUsd. Modeled 1:1 on demoFlip().
  async function tokenFlip() {
    if (demoFlipBusy || revealLock) return;
    const v = parseFloat($("house-bet").value);
    if (!(v > 0)) return toast("Drag to pick a stake", "err");
    if (v > TokenMode.tokens()) return toast("Not enough tokens — cash out or buy in more", "err");
    const wantsHeads = sideOf("house-side");
    rememberBet(v);
    demoFlipBusy = true;
    const fb = $("play-house-btn"); if (fb) fb.disabled = true;
    const release = () => { demoFlipBusy = false; if (fb) fb.disabled = false; };
    lockReveal();
    TV.startFlip({ p1: "TOKEN", p2: "HOUSE", p1Heads: wantsHeads });
    const seq = TV._seq;
    let result;
    try {
      result = await TokenMode.bet("coinflip", v, { side: wantsHeads ? 0 : 1 }); // server-authoritative
    } catch (e) {
      if (TV._seq === seq) { unlockReveal(); try { TV.idle("Token bet failed — try again"); } catch (er) {} }
      release(); return txErr ? txErr(e) : toast("Bet failed", "err");
    }
    const coinHeads = !!(result.outcome && result.outcome.landed === 0); // 0=heads,1=tails
    const won = !!result.win;
    const side = coinHeads ? "HEADS" : "TAILS";
    const rv = flipReveal(usdToWei(v), won); // TV display amounts (1.94x identical client/server)
    setTimeout(() => {
      if (TV._seq !== seq) { release(); return; } // tuned away mid round-trip
      playOutcome({ won, netUsd: weiToUsd(rv.netWei), betUsd: v, side });
      TV.revealResult({
        side, youWon: won, role: "participant", picked: wantsHeads ? "HEADS" : "TAILS",
        amountUsd: won ? weiToUsd(rv.netWei) : rv.amountUsd, tier: rv.tier,
        sub: won ? "TOKEN win" : "TOKEN play",
      });
      if (window.TokenMode && TokenMode.syncBalance) TokenMode.syncBalance(); // coin has landed — now reveal the new balance (held until now so it didn't spoil the flip)
      release();
    }, 2800);
  }

  async function refreshHouse() {
    if (demoOn) return;
    try {
      const b = await read.houseBankroll();
      $("house-bankroll").textContent = usdOf(b);
      // House bets can't exceed what the bankroll can match (USD, $2,000 ceiling).
      const capWei = b < maxBet ? b : maxBet;
      const capUsd = Math.max(10, Math.min(HARD_MAX_USD, Math.floor(weiToUsd(capWei))));
      const s = $("house-bet");
      s.max = String(capUsd);
      if (+s.value > capUsd) s.value = String(capUsd);
      setSliderUsd("house-bet");
    } catch {}
  }

  // ---------------------------------------------------------- host tables
  let currentTable = null;          // the table I'm viewing/playing (from a link)
  const closingTables = new Set();  // ids with an in-flight auto-close

  function hostUrlFor(id) {
    let base = shareBase();
    const q = new URLSearchParams();
    if (deployment.address) q.set("contract", deployment.address);
    if (deployment.chainId) q.set("chain", String(deployment.chainId));
    q.set("host", String(id));
    return base + "?" + q.toString();
  }

  async function createHostTable() {
    if (!ready()) return;
    const name = ($("host-table-name").value || "Host Table").trim();
    const v = parseFloat($("host-bank").value); // USD
    if (!(v > 0)) return toast("Pick a bank amount", "err");
    const bank = usdToWei(v);
    try {
      const gb = await read.balances(account);
      if (gb < bank) return toast("Deposit first 👇 — the bank comes from your in-game balance (you have " + usdOf(gb) + ").", "err");
    } catch {}
    try {
      toast("Creating your table… confirm in MetaMask");
      const tx = await contract.createHostRoom(bank, name, { gasLimit: await estGas("createHostRoom", [bank, name], null, 320000n) });
      const rcpt = await tx.wait();
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "HostRoomCreated");
      const id = ev ? ev.args.roomId.toString() : null;
      if (id) { $("host-table-share").classList.remove("hidden"); $("host-table-link").value = hostUrlFor(id); }
      toast("Table is live — share your link! 🎉", "ok");
      refreshBalances(); refreshMyTables();
    } catch (e) { txErr(e); }
  }

  // Open a table from its link (or the lobby). If it's yours, show your manager.
  async function loadHostTable(id) {
    if (!read || !chainOK) return;
    try {
      const hr = await read.getHostRoom(id);
      if (!hr || hr.id.toString() === "0") return toast("That table doesn't exist.", "err");
      if (!hr.open) return toast("That table has closed.", "err");
      if (eq(hr.creator, account)) { refreshMyTables(); return; } // it's mine → manage it
      currentTable = { id: hr.id.toString(), creator: hr.creator, name: hr.name };
      $("pt-name").textContent = hr.name;
      $("pt-sub").textContent = "Flip against " + short(hr.creator) + "'s bank — you're HEADS. The host keeps half of the 3% fee.";
      configureTableSlider(hr.bank);
      $("play-table").hidden = false;
    } catch (e) { console.error(e); }
  }

  function configureTableSlider(bankWei) {
    $("pt-bank").textContent = usdOf(bankWei);
    const capUsd = Math.max(10, Math.min(HARD_MAX_USD, Math.floor(weiToUsd(bankWei < maxBet ? bankWei : maxBet))));
    const s = $("table-bet");
    s.min = "10"; s.step = "5"; s.max = String(capUsd);
    if (+s.value > capUsd) s.value = String(capUsd);
    if (+s.value < 10) s.value = "10";
    setSliderUsd("table-bet");
  }

  async function refreshTableInfo() {
    if (!currentTable || !read || !chainOK) return;
    try {
      const hr = await read.getHostRoom(currentTable.id);
      if (!hr.open) { $("play-table").hidden = true; currentTable = null; toast("This table just closed.", "err"); return; }
      configureTableSlider(hr.bank);
    } catch {}
  }

  async function playTable() {
    if (!ready() || !currentTable) return;
    const v = parseFloat($("table-bet").value);
    if (!(v > 0)) return toast("Drag to pick a stake", "err");
    const bet = usdToWei(v);
    try {
      const gb = await read.balances(account);
      if (gb < bet) return toast("Deposit first 👇 — your stake comes from your in-game balance (you have " + usdOf(gb) + ").", "err");
    } catch {}
    rememberBet(v);
    doPlayTable(currentTable.id, bet, sideOf("table-side"));
  }

  async function doPlayTable(id, bet, wantsHeads) {
    activeRoomId = null; lastRevealed = null;
    lockReveal();
    flipBuildup(bet);
    TV.startFlip({ p1: account, p2: "HOST", p1Heads: wantsHeads });
    tvPending(true);
    toast("Sending your bet… confirm in your wallet", "ok");
    try {
      let predicted;
      try { predicted = await contract.playHostRoom.staticCall(id, bet, wantsHeads); }
      catch (e) { tvPending(false); unlockReveal(); cancelBuildup(); TV.idle("Deposit ETH, then create or join a room"); return txErr(e); }
      const tx = await contract.playHostRoom(id, bet, wantsHeads, { gasLimit: 500000n });
      const rcpt = await tx.wait();
      tvPending(false);
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "HostFlip");
      const playerWon = ev ? ev.args.playerWon : predicted;
      const betAmt = ev ? ev.args.betAmount : bet;
      const rv = flipReveal(betAmt, playerWon);
      const coinHeads = playerWon ? wantsHeads : !wantsHeads; // the coin's actual face
      setLastResult({ won: playerWon, side: coinHeads ? "HEADS" : "TAILS", amountUsd: rv.amountUsd, amountWei: rv.amountWei, betWei: betAmt, label: "Host table" });
      playOutcome({ won: playerWon, netUsd: weiToUsd(rv.netWei), betUsd: weiToUsd(betAmt), side: coinHeads ? "HEADS" : "TAILS" });
      TV.revealResult({
        side: coinHeads ? "HEADS" : "TAILS",
        youWon: playerWon,
        role: "participant",
        picked: wantsHeads ? "HEADS" : "TAILS",
        amountUsd: playerWon ? weiToUsd(rv.netWei) : rv.amountUsd,
        tier: rv.tier,
        sub: playerWon ? "YOU WON! Net profit shown — your stake came back too (3% fee)" : "You lost your stake — it went to the host",
      });
      addHostGame({ label: "Host table", won: playerWon, amount: rv.amountWei.toString(), net: rv.netWei.toString(), ts: Math.floor(Date.now() / 1000), tx: rcpt.hash });
      refreshBalances(); refreshTableInfo(); refreshPlayers(); refreshMyHistory();
    } catch (e) {
      tvPending(false);
      unlockReveal(); cancelBuildup();
      TV.idle("Deposit ETH, then create or join a room");
      txErr(e);
    }
  }

  // ════════════════════════════ DICE (CH 09) ════════════════════════════
  let diceMode = "under";          // "under" | "over"
  let currentGame = "flip";        // "flip" | "dice"
  let diceHouseWei = 0n;           // cached house bankroll for the can-cover check
  let dicePayoutCapBps = 100n;     // per-roll cap (bps of bankroll); read live, 1% fallback for old contracts

  async function refreshDiceHouse() {
    if (demoOn) { demoSyncBalance(); return; }
    try {
      diceHouseWei = await read.houseBankroll();
      const el = $("dice-house-bankroll"); if (el) el.textContent = usdOf(diceHouseWei);
      const el2 = $("td-house-bankroll"); if (el2) el2.textContent = usdOf(diceHouseWei); // Dice #2 shares the bankroll
      const el3 = $("crash-house-bankroll"); if (el3) el3.textContent = usdOf(diceHouseWei); // Crash shares the bankroll too
      const el4 = $("slots-house-bankroll"); if (el4) el4.textContent = usdOf(diceHouseWei); // Slots shares the bankroll too
    } catch {}
    // Newer contracts expose an owner-tunable cap; old ones don't — fall back to 1%.
    try { if (read.maxPayoutBpsOfBankroll) dicePayoutCapBps = BigInt(await read.maxPayoutBpsOfBankroll()); } catch { dicePayoutCapBps = 100n; }
  }
  function diceMaxProfitWei() { return diceHouseWei > 0n ? (diceHouseWei * dicePayoutCapBps) / 10000n : 0n; }
  const DICE_MAX_WIN_OUTCOMES = 9800; // keep total payout >= stake after the 2% edge
  function clampDiceTarget(raw, mode) {
    let t = Math.min(9899, Math.max(100, (+raw) | 0));
    if (mode === "over") t = Math.max(t, 9999 - DICE_MAX_WIN_OUTCOMES);
    else t = Math.min(t, DICE_MAX_WIN_OUTCOMES);
    return t;
  }

  // Live odds bar + readouts as the player drags. Target T in [100,9899] (1%–99%).
  function diceReadouts() {
    const tEl = $("dice-target"); if (!tEl) return;
    const T = clampDiceTarget(tEl.value, diceMode);
    if (((+tEl.value) | 0) !== T) tEl.value = String(T);
    const winOutcomes = diceMode === "under" ? T : (9999 - T);
    const chance = winOutcomes / 100;        // %
    const mult = Math.floor(9800 * 10000 / winOutcomes) / 10000; // 2% edge; floor to match on-chain bps
    const stake = +$("dice-stake").value;
    const profit = Math.max(0, stake * (mult - 1));
    const pct = T / 100;
    $("dice-target-val").textContent = pct.toFixed(2);
    $("ob-flag").textContent = pct.toFixed(2);
    $("dice-chance").textContent = chance.toFixed(2) + "%";
    $("dice-mult").textContent = mult.toFixed(2) + "×";
    $("dice-profit").textContent = "+$" + profit.toFixed(2);
    setBtnAmts("dice", stake, profit);
    $("dice-mode-hint").textContent = diceMode === "under" ? "— roll under to win" : "— roll over to win";
    $("ob-target").style.left = pct + "%";
    if (diceMode === "under") { $("ob-win").style.cssText = "left:0;width:" + pct + "%"; $("ob-lose").style.cssText = "left:" + pct + "%;width:" + (100 - pct) + "%"; }
    else { $("ob-lose").style.cssText = "left:0;width:" + pct + "%"; $("ob-win").style.cssText = "left:" + pct + "%;width:" + (100 - pct) + "%"; }
    $("dice-oddsbar").dataset.mode = diceMode;
    if (currentGame === "dice" && !revealLock && window.TV && TV.previewDice) try { TV.previewDice({ target: pct, mode: diceMode }); } catch (e) {}
    // affordability guards
    let hint = "";
    let stakeWei = 0n; try { stakeWei = usdToWei(stake); } catch {}
    let profitWei = 0n; try { profitWei = usdToWei(profit); } catch {}
    if (stakeWei > gameWei) hint = "Not enough in-game balance — deposit first 👇";
    else if (maxBet > 0n && stakeWei > maxBet) hint = "Max bet is " + usdOf(maxBet);
    else if (diceHouseWei > 0n && profitWei > diceMaxProfitWei()) hint = (dicePayoutCapBps >= 10000n ? "House can't cover that win yet — fund the house or lower the stake (max win " + usdOf(diceMaxProfitWei()) + ")" : "Max win per roll is " + usdOf(diceMaxProfitWei()) + " (" + (Number(dicePayoutCapBps) / 100) + "% of the house bankroll) — lower the stake or multiplier");
    const btn = $("dice-roll-btn");
    if (btn) { btn.disabled = !!hint; btn.style.opacity = hint ? "0.55" : ""; }
    $("dice-roll-hint").textContent = hint;
  }

  async function playDiceClick() {
    if (window.TokenMode && TokenMode.active()) return tokenDice();
    if (demoOn) return demoDice();
    if (!ready()) return;
    const stakeUsd = parseFloat($("dice-stake").value);
    if (!(stakeUsd > 0)) return toast("Drag to pick a stake", "err");
    const bet = usdToWei(stakeUsd);
    if (bet > maxBet) return toast("Max bet is " + usdOf(maxBet), "err");
    try {
      const gb = await read.balances(account);
      gameWei = gb;
      if (gb < bet) return toast("Deposit first 👇 — your stake comes from your in-game balance (you have " + usdOf(gb) + ").", "err");
    } catch {}
    const rollOver = diceMode === "over";
    const target = clampDiceTarget($("dice-target").value, rollOver ? "over" : "under");
    $("dice-target").value = String(target);
    rememberBet(stakeUsd);
    doPlayDice(bet, target, rollOver);
  }

  async function doPlayDice(bet, target, rollOver) {
    activeRoomId = null; lastRevealed = null;
    lockReveal();
    tvPending(true);
    toast("Sending your roll… confirm in your wallet", "ok");
    try {
      const tx = await contract.playDice(bet, target, rollOver, { gasLimit: 700000n });
      const rcpt = await tx.wait();
      tvPending(false);
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "DiceRolled");
      if (!ev) { unlockReveal(); TV.idle(); refreshBalances(); refreshDiceHouse(); toast("Roll settled on-chain — check your balance.", "ok"); return; }
      const a = ev.args;
      const won = a.won;
      const netWei = won ? (a.payout - bet) : bet;          // profit on win / stake on loss
      const profitUsd = won ? weiToUsd(a.payout - bet) : 0;
      const tier = profitUsd >= 500 ? "mega" : profitUsd >= 100 ? "big" : "normal";
      TV.revealDice({
        roll: Number(a.roll) / 100,
        target: Number(a.target) / 100,
        mode: a.rollOver ? "over" : "under",
        youWon: won,
        mult: Number(a.multiplierBps) / 10000,
        amountUsd: weiToUsd(netWei),
        tier: tier,
      });
      refreshBalances(); refreshDiceHouse(); refreshStats();
    } catch (e) {
      tvPending(false);
      unlockReveal();
      TV.idle("Pick a game and place a bet");
      txErr(e);
    }
  }

  // ── Dice #2 (CH 10): two d6 dice, sum 2..12, roll under/over a target total ──
  let tdMode = "under"; // "under" | "over"
  // Ways to roll each two-dice sum: 6 - |s-7| for s in [2,12].
  function tdWays(s) { return 6 - Math.abs(s - 7); }
  function tdWinCombos(T, over) {
    let c = 0;
    if (over) { for (let s = T + 1; s <= 12; s++) c += tdWays(s); }
    else { for (let s = 2; s < T; s++) c += tdWays(s); }
    return c;
  }
  function twoDiceReadouts() {
    const tEl = $("td-target"); if (!tEl) return;
    const T = Math.min(12, Math.max(2, (+tEl.value) | 0));
    const over = tdMode === "over";
    const combos = tdWinCombos(T, over);
    const chance = (combos / 36) * 100;
    const mult = combos > 0 ? Math.floor(9800 * 36 / combos) / 10000 : 0; // 2% edge; floor to match on-chain bps
    const stake = +$("td-stake").value;
    const profit = combos > 0 ? stake * (mult - 1) : 0;
    $("td-target-val").textContent = T;
    const scale = $("td-scale");
    if (scale) scale.querySelectorAll("span").forEach((s, i) => s.classList.toggle("on", i === T - 2));
    $("td-chance").textContent = chance.toFixed(2) + "%";
    $("td-mult").textContent = combos > 0 ? mult.toFixed(2) + "×" : "—";
    $("td-profit").textContent = "+$" + profit.toFixed(2);
    setBtnAmts("td", stake, profit);
    // Spell out the winning totals so it's clear the target itself never wins
    // (the sum must be strictly under/over T — landing exactly on T loses).
    const winLo = over ? T + 1 : 2, winHi = over ? 12 : T - 1;
    const rangeTxt = winLo > winHi ? "—" : (winLo === winHi ? String(winLo) : winLo + "–" + winHi);
    $("td-mode-hint").textContent = over
      ? "— win on " + rangeTxt + " · " + T + " & under lose"
      : "— win on " + rangeTxt + " · " + T + " & over lose";
    // affordability + validity guards (Dice #2 shares the house bankroll + cap)
    let hint = "";
    let stakeWei = 0n; try { stakeWei = usdToWei(stake); } catch {}
    let profitWei = 0n; try { profitWei = usdToWei(profit); } catch {}
    if (combos <= 0) hint = "Pick a different target for this bet type";
    else if (stakeWei > gameWei) hint = "Not enough in-game balance — deposit first 👇";
    else if (maxBet > 0n && stakeWei > maxBet) hint = "Max bet is " + usdOf(maxBet);
    else if (diceHouseWei > 0n && profitWei > diceMaxProfitWei()) hint = (dicePayoutCapBps >= 10000n ? "House can't cover that win yet — fund the house or lower the stake (max win " + usdOf(diceMaxProfitWei()) + ")" : "Max win per roll is " + usdOf(diceMaxProfitWei()));
    const btn = $("td-roll-btn");
    if (btn) { btn.disabled = !!hint; btn.style.opacity = hint ? "0.55" : ""; }
    $("td-roll-hint").textContent = hint;
    if (twoDiceSupported === false) applyTwoDiceSupport();
  }
  // Not every deployed house contract has Dice #2 — older deploys predate it.
  // Probe a Dice #2 view function once; if it reverts, the contract lacks the
  // feature, so we disable the channel with an honest message instead of letting
  // a bet fail with a misleading "over the limit" error.
  async function ensureTwoDiceSupport() {
    if (!contract) return null;
    if (twoDiceSupported === null) {
      try { await contract.nextTwoDiceGameId.staticCall(); twoDiceSupported = true; }
      catch (e) {
        // Only a real revert/decode failure means the contract lacks Dice #2.
        // A flaky-RPC network error must NOT latch it off — leave null to retry.
        if (e?.code === "CALL_EXCEPTION" || e?.code === "BAD_DATA") twoDiceSupported = false;
      }
      applyTwoDiceSupport();
    }
    return twoDiceSupported;
  }
  function applyTwoDiceSupport() {
    const btn = $("td-roll-btn"), hint = $("td-roll-hint");
    if (twoDiceSupported === false) {
      if (btn) { btn.disabled = true; btn.style.opacity = "0.55"; }
      if (hint) hint.textContent = "⚠️ This house contract predates Dice #2 — it needs to be redeployed/upgraded before you can play it. Coin Flip and 0-100 still work here.";
    }
  }
  async function playTwoDiceClick() {
    if (window.TokenMode && TokenMode.active()) return tokenTwoDice();
    if (demoOn) return demoTwoDice();
    if (!ready()) return;
    if ((await ensureTwoDiceSupport()) === false)
      return toast("Dice #2 isn't on this house contract yet — it needs a redeploy. (Coin Flip and 0-100 still work.)", "err");
    const stakeUsd = parseFloat($("td-stake").value);
    if (!(stakeUsd > 0)) return toast("Drag to pick a stake", "err");
    const bet = usdToWei(stakeUsd);
    if (bet > maxBet) return toast("Max bet is " + usdOf(maxBet), "err");
    try {
      const gb = await read.balances(account);
      gameWei = gb;
      if (gb < bet) return toast("Deposit first 👇 — your stake comes from your in-game balance (you have " + usdOf(gb) + ").", "err");
    } catch {}
    const target = (+$("td-target").value) | 0;
    const over = tdMode === "over";
    if (tdWinCombos(target, over) <= 0) return toast("Pick a different target for this bet type", "err");
    rememberBet(stakeUsd);
    doPlayTwoDice(bet, target, over);
  }
  async function doPlayTwoDice(bet, target, over) {
    activeRoomId = null; lastRevealed = null;
    lockReveal();
    tvPending(true);
    toast("Throwing the dice… confirm in your wallet", "ok");
    try {
      const tx = await contract.playTwoDice(bet, target, over, { gasLimit: 700000n });
      const rcpt = await tx.wait();
      tvPending(false);
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "TwoDiceRolled");
      if (!ev) { unlockReveal(); TV.idle(); refreshBalances(); refreshDiceHouse(); toast("Roll settled on-chain — check your balance.", "ok"); return; }
      const a = ev.args;
      const won = a.won;
      const netWei = won ? (a.payout - bet) : bet;
      const profitUsd = won ? weiToUsd(a.payout - bet) : 0;
      const tier = profitUsd >= 500 ? "mega" : profitUsd >= 100 ? "big" : "normal";
      TV.revealTwoDice({
        d1: Number(a.d1), d2: Number(a.d2),
        target: Number(a.target),
        mode: a.rollOver ? "over" : "under",
        youWon: won,
        mult: Number(a.multiplierBps) / 10000,
        amountUsd: weiToUsd(netWei),
        tier: tier,
      });
      refreshBalances(); refreshDiceHouse(); refreshStats();
    } catch (e) {
      tvPending(false);
      unlockReveal();
      TV.idle("Pick a game and place a bet");
      txErr(e);
    }
  }

  // ── Crash (CH 11): provably-fair rocket, auto-cash-out at a target multiplier ──
  const CRASH_EDGE = 0.01; // 1% — mirrors crashEdgeBps on-chain
  function crashTargetVal() {
    let t = parseFloat($("crash-target") ? $("crash-target").value : "2");
    if (!(t >= 1.01)) t = 1.01;
    if (t > 1000) t = 1000;
    return t;
  }
  function crashReadouts() {
    const tEl = $("crash-target"); if (!tEl) return;
    const target = crashTargetVal();
    const chance = Math.min(100, ((1 - CRASH_EDGE) / target) * 100);
    const stake = +$("crash-stake").value;
    const profit = stake * (target - 1);
    $("crash-target-val").textContent = target.toFixed(2) + "×";
    $("crash-chance").textContent = chance.toFixed(2) + "%";
    $("crash-mult-ro").textContent = target.toFixed(2) + "×";
    $("crash-profit").textContent = "+$" + profit.toFixed(2);
    setBtnAmts("crash", stake, profit);
    // affordability + validity guards (Crash shares the house bankroll + cap)
    let hint = "";
    let stakeWei = 0n; try { stakeWei = usdToWei(stake); } catch {}
    let profitWei = 0n; try { profitWei = usdToWei(profit); } catch {}
    if (!(stake > 0)) hint = "Drag to pick a stake";
    else if (stakeWei > gameWei) hint = "Not enough in-game balance — deposit first 👇";
    else if (maxBet > 0n && stakeWei > maxBet) hint = "Max bet is " + usdOf(maxBet);
    else if (diceHouseWei > 0n && profitWei > diceMaxProfitWei()) hint = (dicePayoutCapBps >= 10000n ? "House can't cover that win yet — fund the house or lower the target (max win " + usdOf(diceMaxProfitWei()) + ")" : "Max win per round is " + usdOf(diceMaxProfitWei()));
    const btn = $("crash-launch");
    if (btn) { btn.disabled = !!hint; btn.style.opacity = hint ? "0.55" : ""; }
    $("crash-roll-hint").textContent = hint;
    if (crashSupported === false) applyCrashSupport(); // don't let the readout re-enable an unsupported channel
  }
  // Older deploys predate Crash — probe a crash-only getter once, same pattern as Dice #2.
  async function ensureCrashSupport() {
    if (!contract) return null;
    if (crashSupported === null) {
      try { await contract.nextCrashGameId.staticCall(); crashSupported = true; }
      catch (e) {
        if (e?.code === "CALL_EXCEPTION" || e?.code === "BAD_DATA") crashSupported = false;
      }
      applyCrashSupport();
    }
    return crashSupported;
  }
  function applyCrashSupport() {
    const btn = $("crash-launch"), hint = $("crash-roll-hint");
    if (crashSupported === false) {
      if (btn) { btn.disabled = true; btn.style.opacity = "0.55"; }
      if (hint) hint.textContent = "⚠️ This house contract predates Crash — it needs to be redeployed/upgraded before you can play it. The other channels still work here.";
    }
  }
  async function playCrashClick() {
    if (window.TokenMode && TokenMode.active()) return tokenCrash();
    if (demoOn) return demoCrash();
    if (!ready()) return;
    if ((await ensureCrashSupport()) === false)
      return toast("Crash isn't on this house contract yet — it needs a redeploy. (The other channels still work.)", "err");
    const stakeUsd = parseFloat($("crash-stake").value);
    if (!(stakeUsd > 0)) return toast("Drag to pick a stake", "err");
    const bet = usdToWei(stakeUsd);
    if (bet > maxBet) return toast("Max bet is " + usdOf(maxBet), "err");
    try {
      const gb = await read.balances(account);
      gameWei = gb;
      if (gb < bet) return toast("Deposit first 👇 — your stake comes from your in-game balance (you have " + usdOf(gb) + ").", "err");
    } catch {}
    const target = crashTargetVal();
    const targetX100 = Math.round(target * 100);
    if (targetX100 < 101 || targetX100 > 100000) return toast("Cash-out target must be between 1.01× and 1000×", "err");
    rememberBet(stakeUsd);
    doPlayCrash(bet, targetX100);
  }
  async function doPlayCrash(bet, targetX100) {
    activeRoomId = null; lastRevealed = null;
    lockReveal();
    tvPending(true);
    toast("Launching the rocket… confirm in your wallet", "ok");
    try {
      const tx = await contract.playCrash(bet, BigInt(targetX100), { gasLimit: 500000n });
      const rcpt = await tx.wait();
      tvPending(false);
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "CrashRolled");
      if (!ev) { unlockReveal(); TV.idle(); refreshBalances(); refreshDiceHouse(); toast("Round settled on-chain — check your balance.", "ok"); return; }
      const a = ev.args;
      const won = a.won;
      const targetX = Number(a.targetX100) / 100;
      const crashX = Number(a.crashX100) / 100;
      const netWei = won ? (a.payout - bet) : bet;
      const profitUsd = won ? weiToUsd(a.payout - bet) : 0;
      const tier = profitUsd >= 500 ? "mega" : profitUsd >= 100 ? "big" : "normal";
      TV.revealCrash({ crashX, targetX, won, amountUsd: weiToUsd(netWei), mult: targetX, tier });
      refreshBalances(); refreshDiceHouse(); refreshStats();
    } catch (e) {
      tvPending(false);
      unlockReveal();
      TV.idle("Pick a game and place a bet");
      txErr(e);
    }
  }

  // ── Crypto Reels (CH 12): 5x3 slot, real-dollar bets, plays on the TV ──
  const SLOTS_MAX_UNITS = 2500 / 9; // a single 5-of-a-kind wild line, in total-bet units
  function slotsReadouts() {
    const sEl = $("slots-stake"); if (!sEl) return;
    const stake = +sEl.value;
    setSliderUsd("slots-stake");
    $("slots-bet-hint").textContent = Math.round(stake);
    // honest "max win": the paytable jackpot for this stake, but never more than
    // the house can currently pay (the bankroll cap).
    let topWei = 0n; try { topWei = usdToWei(stake * SLOTS_MAX_UNITS); } catch {}
    const capWei = diceMaxProfitWei();
    if (capWei > 0n && topWei > capWei) topWei = capWei;
    $("slots-maxwin").textContent = topWei > 0n ? usdOf(topWei) : "$0";
    { const w = $("slots-win-hint"); if (w) w.textContent = topWei > 0n ? Math.round(weiToUsd(topWei)).toLocaleString() : "0"; } // jackpot potential
    // affordability guard
    let hint = "";
    let stakeWei = 0n; try { stakeWei = usdToWei(stake); } catch {}
    if (!(stake > 0)) hint = "Drag to pick a bet";
    else if (stakeWei > gameWei) hint = "Not enough in-game balance — deposit first 👇";
    else if (maxBet > 0n && stakeWei > maxBet) hint = "Max bet is " + usdOf(maxBet);
    const btn = $("slots-spin");
    if (btn) { btn.disabled = !!hint; btn.style.opacity = hint ? "0.55" : ""; }
    $("slots-roll-hint").textContent = hint;
    if (slotsSupported === false) applySlotsSupport();
  }
  async function ensureSlotsSupport() {
    if (!contract) return null;
    if (slotsSupported === null) {
      try { await contract.nextSlotsGameId.staticCall(); slotsSupported = true; }
      catch (e) {
        if (e?.code === "CALL_EXCEPTION" || e?.code === "BAD_DATA") slotsSupported = false;
      }
      applySlotsSupport();
    }
    return slotsSupported;
  }
  function applySlotsSupport() {
    const btn = $("slots-spin"), hint = $("slots-roll-hint");
    if (slotsSupported === false) {
      if (btn) { btn.disabled = true; btn.style.opacity = "0.55"; }
      if (hint) hint.textContent = "⚠️ This house contract predates Crypto Reels — it needs to be redeployed/upgraded before you can play it. The other channels still work here.";
    }
  }
  // Lazily inject PixiJS + the slot engine the first time slots are used, so the
  // ~1MB library never loads for players who never open this channel.
  function loadScriptOnce(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = () => res(); s.onerror = () => rej(new Error("failed to load " + src));
      document.body.appendChild(s);
    });
  }
  // PixiJS is shared by Slots and Balloon Pop — load it at most once, even if
  // both channels request it before the script's onload fires (in-flight guard).
  let pixiLoadPromise = null;
  function loadPixiOnce() {
    if (window.PIXI) return Promise.resolve();
    if (pixiLoadPromise) return pixiLoadPromise;
    pixiLoadPromise = loadScriptOnce("vendor/pixi.min.js?v=1243").catch((e) => { pixiLoadPromise = null; throw e; });
    return pixiLoadPromise;
  }
  // PlayCanvas engine (~2.2MB) — only loaded when the Sky Swoop channel is first opened.
  function loadPlayCanvasOnce() {
    if (window.pc) return Promise.resolve();
    if (playcanvasLoadPromise) return playcanvasLoadPromise;
    playcanvasLoadPromise = loadScriptOnce("vendor/playcanvas.min.js?v=1243").catch((e) => { playcanvasLoadPromise = null; throw e; });
    return playcanvasLoadPromise;
  }
  function ensureSlotsLoaded() {
    if (window.CryptoReels) return Promise.resolve(true);
    if (slotsLoadPromise) return slotsLoadPromise;
    slotsLoadPromise = loadPixiOnce()
      .then(() => loadScriptOnce("slots.js?v=1243"))
      .then(() => { if (window.TV && TV._activeChannel === 12 && TV._slotsIdle) TV._slotsIdle(); return true; })
      .catch((e) => { slotsLoadPromise = null; throw e; });
    return slotsLoadPromise;
  }
  // ── Balloon Pop (CH 13): lazy-load the engine, then build + bridge the instance.
  function ensurePressureLoaded() {
    if (window.PressureGame) return Promise.resolve(true);
    if (pressureLoadPromise) return pressureLoadPromise;
    pressureLoadPromise = loadPixiOnce()
      .then(() => loadScriptOnce("pressure-engine.js?v=1243"))
      .then(() => loadScriptOnce("pressure-render.js?v=1243"))
      .then(() => loadScriptOnce("pressure-ui.js?v=1245"))
      // optional 3D red balloon (Three.js) — falls back to the 2D balloon if it can't load
      .then(() => loadThreeOnce().then(() => loadScriptOnce("pressure3d.js?v=1243")).catch(() => {}))
      .then(() => true)
      .catch((e) => { pressureLoadPromise = null; throw e; });
    return pressureLoadPromise;
  }
  function buildPressureGame() {
    if (pressureGame || !window.PressureGame) return pressureGame;
    const el = (id) => $(id);
    const mount = $("pressure-stage"); if (!mount) return null;
    // Build at a FIXED 4:3 size (the TV screen is 4:3). CSS stretches the canvas
    // to fill the screen uniformly → no distortion, and it can't get squished by a
    // bad/early getBoundingClientRect measurement (which caused a portrait-ratio
    // canvas to be squashed into the landscape screen).
    // optional 3D red balloon mounted behind the (transparent) Pixi HUD
    let balloon3d = null;
    if (window.Balloon3D) { const b3m = $("pressure3d-stage"); if (b3m) try { balloon3d = new window.Balloon3D({ mount: b3m, width: 800, height: 600 }); } catch (e) { balloon3d = null; } }
    pressureGame = new window.PressureGame({
      mount, width: 800, height: 600,
      autoOn: (window.TokenMode && TokenMode.active()) ? false : true, // manual default in token mode (owner rule)
      balloon3d: balloon3d,
      ethUsd: ethUsd,
      initialBalance: (window.TokenMode && TokenMode.active()) ? TokenMode.tokens() : demoUsd,
      onBalance: (b) => { if (window.TokenMode && TokenMode.active()) return; demoUsd = Math.round(b * 100) / 100; demoSave(); demoPaint(); }, // demo only (token mode: balance owned by TokenMode)
      onWin: (i) => setLastResult({ won: true, game: "Balloon Pop", emoji: "🎈", amountUsd: i.profitUsd, detail: i.mult.toFixed(2) + "× banked" }), // Balloon Pop shows its own rich in-canvas win — no result overlay (would collide)
      // TOKEN mode: HOLD starts a server-paced round (pressure burst = 3% edge), RELEASE is
      // the manual cash-out. Settles through the pressure engine on the round-runner.
      onTokenLaunch: (stake, autoTarget, onTick) => {
        if (!window.CrashRounds || !(window.TokenMode && TokenMode.active())) return Promise.resolve(null);
        const sess = TokenMode.session(); if (!sess) return Promise.resolve(null);
        return CrashRounds.start({ sessionId: sess.sessionId, sessionToken: sess.sessionToken, game: "pressure", betUnits: stake, autoTarget: autoTarget || 0, onTick: onTick })
          .then((res) => { try { if (res && typeof res.tokens === "number") TokenMode.syncTokens(res.tokens); } catch (e) {} return res; });
      },
      onTokenCashOut: () => { if (window.CrashRounds && CrashRounds.active && CrashRounds.active()) CrashRounds.cashOut(); }, // guard: a stale tap with no live round can't fire a spurious cashout
      els: {
        balance: el("pr-balance"),
        betSlider: el("pr-bet-slider"), betVal: el("pr-bet-val"), betEth: el("pr-bet-eth"),
        betHalf: el("pr-bet-half"), betDouble: el("pr-bet-double"), betMax: el("pr-bet-max"),
        risk: el("pr-risk"),
        autoSlider: el("pr-auto-slider"), autoVal: el("pr-auto-val"), autoToggle: el("pr-auto-toggle"),
        holdPad: el("pr-hold"),
        message: el("pr-message"),
        pfHash: el("pr-pf-hash"), pfClient: el("pr-pf-client"), pfNonce: el("pr-pf-nonce"),
        pfVerify: el("pr-pf-verify"), pfReveal: el("pr-pf-reveal"), pfLast: el("pr-pf-last"),
      },
    });
    try { window.__pressure = pressureGame; } catch (e) {} // debug/support handle
    return pressureGame;
  }
  // Build (first time) + activate the Balloon Pop channel, syncing the shared
  // play-money balance and enabling/disabling for demo vs real-money mode.
  function ensurePressureReady() {
    ensurePressureLoaded().then(() => {
      const g = buildPressureGame(); if (!g) return;
      g.setActive(true);
      g.setEthUsd(ethUsd);
      if (window.TokenMode && TokenMode.active()) {
        // Token mode: default auto OFF so HOLD/RELEASE is fully manual (owner rule).
        g.autoOn = false; if (g.els.autoToggle) { g.els.autoToggle.textContent = "AUTO OFF"; g.els.autoToggle.classList.remove("active"); }
        g.setBalance(TokenMode.tokens()); g.setEnabled(true);
      } else if (demoOn) { g.setBalance(demoUsd); g.setEnabled(true); }
      else { g.setBalance(0); g.setEnabled(true); } // connected but not bought in → token-only: 0 balance, buy in via the top bar
      // Now the canvas exists → reveal the layer (idle may have shown the ready
      // room while it was still loading, e.g. right after the promo ended).
      if (window.TV && currentGame === "pressure" && !TV._promoPlaying) try { TV.idle(); } catch (e) {}
    }).catch(() => toast("Couldn't load Balloon Pop — check your connection", "err"));
  }

  // ── Plane (CH 14): lazy-load the Aviator engine, then build + bridge the instance.
  function ensurePlaneLoaded() {
    if (window.PlaneGame) return Promise.resolve(true);
    if (planeLoadPromise) return planeLoadPromise;
    planeLoadPromise = loadPixiOnce()
      .then(() => loadScriptOnce("plane-engine.js?v=1243"))
      .then(() => loadScriptOnce("plane-render.js?v=1243"))
      .then(() => loadScriptOnce("plane-feed.js?v=1243"))
      .then(() => loadScriptOnce("plane-ui.js?v=1245"))
      .then(() => true)
      .catch((e) => { planeLoadPromise = null; throw e; });
    return planeLoadPromise;
  }
  function buildPlaneGame() {
    if (planeGame || !window.PlaneGame) return planeGame;
    const el = (id) => $(id);
    const mount = $("plane-stage"); if (!mount) return null;
    const panel = (p) => ({
      action: el("plane-" + p + "-action"),
      betInput: el("plane-" + p + "-bet"), betVal: el("plane-" + p + "-betval"), betEth: el("plane-" + p + "-eth"),
      betHalf: el("plane-" + p + "-half"), betDouble: el("plane-" + p + "-double"), betMax: el("plane-" + p + "-max"),
      autoSlider: el("plane-" + p + "-auto-slider"), autoVal: el("plane-" + p + "-autoval"), autoToggle: el("plane-" + p + "-auto-toggle"),
      autobet: el("plane-" + p + "-autobet"), mart: el("plane-" + p + "-mart"),
    });
    // 4:3 to fill the TV screen uniformly (CSS stretches it, like Balloon Pop).
    planeGame = new window.PlaneGame({
      mount, width: 800, height: 600,
      ethUsd: ethUsd, houseEdge: CRASH_EDGE, // 1% — identical to the on-chain crash it settles through
      mode: demoOn ? "demo" : "token", // connected (non-demo) is ALWAYS token now — the legacy on-chain "real" plane is retired (token bridge replaces direct on-chain bets)
      initialBalance: demoOn ? demoUsd : ((window.TokenMode && TokenMode.active()) ? TokenMode.tokens() : 0), // token-only: 0 until you buy in
      onBalance: (b) => { if (window.TokenMode && TokenMode.active()) return; demoUsd = Math.round(b * 100) / 100; demoSave(); demoPaint(); }, // demo only (token mode: balance owned by TokenMode)
      onWin: (i) => setLastResult({ won: true, game: "Plane", emoji: "✈️", amountUsd: i.profitUsd, detail: i.mult.toFixed(2) + "× cashed" }), // Plane shows its own in-canvas cash-out win — no result overlay (would collide)
      onRealBet: (betUsd, targetX100) => doPlanePlay(betUsd, targetX100),       // single on-chain round
      onRealDone: () => { unlockReveal(); refreshBalances().then(() => { if (planeGame) planeGame.setBalance(weiToUsd(gameWei)); }); refreshDiceHouse(); try { refreshStats(); } catch (e) {} },
      // TOKEN mode: a server-paced live round (CrashRounds) settles through the same crash
      // engine. onTick drives the climb; the cash-out is a manual tap (auto opt-in).
      onTokenLaunch: (stake, autoTarget, onTick) => {
        if (!window.CrashRounds || !(window.TokenMode && TokenMode.active())) return Promise.resolve(null);
        const sess = TokenMode.session(); if (!sess) return Promise.resolve(null);
        return CrashRounds.start({ sessionId: sess.sessionId, sessionToken: sess.sessionToken, game: "plane", betUnits: stake, autoTarget: autoTarget || 0, onTick: onTick })
          .then((res) => { try { if (res && typeof res.tokens === "number") TokenMode.syncTokens(res.tokens); } catch (e) {} return res; });
      },
      onTokenCashOut: () => { if (window.CrashRounds && CrashRounds.active && CrashRounds.active()) CrashRounds.cashOut(); }, // guard: a stale tap with no live round can't fire a spurious cashout
      els: {
        balance: el("plane-balance"), message: el("plane-message"),
        history: el("plane-history"), feed: el("plane-feed"),
        feedTabs: Array.prototype.slice.call(document.querySelectorAll(".plane-feed-tabs .ftab")),
        pfHash: el("plane-pf-hash"), pfClient: el("plane-pf-client"), pfNonce: el("plane-pf-nonce"),
        pfVerify: el("plane-pf-verify"), pfReveal: el("plane-pf-reveal"), pfLast: el("plane-pf-last"),
      },
      panels: [panel("a"), panel("b")],
    });
    try { window.__plane = planeGame; } catch (e) {} // debug/support handle
    return planeGame;
  }
  function ensurePlaneReady() {
    document.body.classList.toggle("plane-real", !demoOn); // hides demo-only UI (2nd bet, feed, autobet)
    ensurePlaneLoaded().then(() => {
      const g = buildPlaneGame(); if (!g) return;
      g.setActive(true);
      g.setEthUsd(ethUsd);
      if (window.TokenMode && TokenMode.active()) {
        g.setMode("token");
        // Manual cash-out is the DEFAULT (owner rule): force bet A's auto OFF on entry so
        // LAUNCH climbs until the player taps CASH OUT. They can still opt into auto.
        if (g.bets && g.bets[0]) { g.bets[0].autoOn = false; try { g._syncPanel(g.bets[0]); } catch (e) {} }
        g.setBalance(TokenMode.tokens()); g.setEnabled(true);
      }
      else if (demoOn) { g.setMode("demo"); g.setBalance(demoUsd); g.setEnabled(true); }
      else { // connected but not bought in → token idle ("Buy in with tokens to play"), NOT legacy on-chain "real"
        g.setMode("token"); g.setBalance(0); g.setEnabled(false);
        if (g.bets && g.bets[0]) { g.bets[0].autoOn = false; try { g._syncPanel(g.bets[0]); } catch (e) {} }
      }
      // Now the canvas exists → reveal the layer (idle may have shown the ready
      // room while it was still loading, e.g. right after the promo ended).
      if (window.TV && currentGame === "plane" && !TV._promoPlaying) try { TV.idle(); } catch (e) {}
    }).catch(() => toast("Couldn't load Plane — check your connection", "err"));
  }
  // The Plane's REAL mode settles each launch as ONE on-chain crash round (the
  // audited playCrash path) at the bet's pre-set auto-cash-out target, then the
  // renderer animates the outcome. Returns the parsed result, or null on cancel.
  async function doPlanePlay(betUsd, targetX100) {
    if (!ready()) return null;
    if ((await ensureCrashSupport()) === false) { toast("Plane needs the Crash contract on this house — it needs a redeploy. (Other channels still work.)", "err"); return null; }
    let bet; try { bet = usdToWei(betUsd); } catch { return null; }
    if (bet > maxBet) { toast("Max bet is " + usdOf(maxBet), "err"); return null; }
    try {
      const gb = await read.balances(account);
      gameWei = gb;
      if (gb < bet) { toast("Not enough in-game balance — deposit first 👇", "err"); return null; }
    } catch {}
    const tx100 = Math.max(101, Math.min(100000, targetX100 | 0));
    activeRoomId = null; lastRevealed = null;
    lockReveal();
    toast("Launching the plane… confirm in your wallet ✈️", "ok");
    try {
      const tx = await contract.playCrash(bet, BigInt(tx100), { gasLimit: 500000n });
      const rcpt = await tx.wait();
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "CrashRolled");
      if (!ev) { unlockReveal(); refreshBalances(); refreshDiceHouse(); toast("Round settled on-chain — check your balance.", "ok"); return null; }
      const a = ev.args;
      return { won: a.won, crashX: Number(a.crashX100) / 100, targetX: Number(a.targetX100) / 100, profitUsd: a.won ? weiToUsd(a.payout - bet) : 0 };
    } catch (e) { unlockReveal(); txErr(e); return null; }
  }

  // ── Gem Vault (CH 15, internal key "slots3d"): premium Three.js slot,
  //    play-money/demo. NOTE FOR CHATGPT (v11.50): player-facing name restored
  //    to Gem Vault; channel/key/engine are the same. ──
  let threeLoadPromise = null;
  function loadThreeOnce() {
    if (window.THREE) return Promise.resolve();
    if (threeLoadPromise) return threeLoadPromise;
    threeLoadPromise = loadScriptOnce("vendor/three.min.js?v=1243").catch((e) => { threeLoadPromise = null; throw e; });
    return threeLoadPromise;
  }
  function ensureSlots3dLoaded() {
    if (window.Slots3D) return Promise.resolve(true);
    if (slots3dLoadPromise) return slots3dLoadPromise;
    slots3dLoadPromise = loadThreeOnce()
      .then(() => loadScriptOnce("slots3d-engine.js?v=1243"))
      .then(() => loadScriptOnce("slots3d.js?v=1245"))
      .then(() => true)
      .catch((e) => { slots3dLoadPromise = null; throw e; });
    return slots3dLoadPromise;
  }
  function buildSlots3d() {
    if (slots3dGame || !window.Slots3D) return slots3dGame;
    const el = (id) => $(id);
    const mount = $("slots3d-stage"); if (!mount) return null;
    slots3dGame = new window.Slots3D({
      mount, width: 800, height: 600, ethUsd: ethUsd, initialBalance: (window.TokenMode && TokenMode.active()) ? TokenMode.tokens() : demoUsd,
      onBalance: (b) => { if (window.TokenMode && TokenMode.active()) return; demoUsd = Math.round(b * 100) / 100; demoSave(); demoPaint(); }, // demo play-money (token mode: balance is owned by TokenMode)
      onWin: (i) => setLastResult({ won: true, game: "Gem Vault", emoji: "💎", amountUsd: i.profitUsd, detail: i.mult.toFixed(2) + "× spin" }),
      els: {
        balance: el("s3d-balance"), win: el("s3d-win"), message: el("s3d-message"),
        betSlider: el("s3d-bet-slider"), betVal: el("s3d-bet-val"), betEth: el("s3d-bet-eth"),
        betHalf: el("s3d-bet-half"), betDouble: el("s3d-bet-double"), betMax: el("s3d-bet-max"),
        spinBtn: el("s3d-spin"),
        pfHash: el("s3d-pf-hash"), pfClient: el("s3d-pf-client"), pfNonce: el("s3d-pf-nonce"),
        pfVerify: el("s3d-pf-verify"), pfReveal: el("s3d-pf-reveal"), pfLast: el("s3d-pf-last"),
      },
    });
    try { window.__s3d = slots3dGame; } catch (e) {} // debug/support handle
    return slots3dGame;
  }
  function ensureSlots3dReady() {
    ensureSlots3dLoaded().then(() => {
      const g = buildSlots3d(); if (!g) return;
      g.setActive(true); g.setEthUsd(ethUsd);
      g.setBalance((window.TokenMode && TokenMode.active()) ? TokenMode.tokens() : demoUsd); g.setEnabled(true);
      if (window.TV && currentGame === "slots3d" && !TV._promoPlaying) try { TV.idle(); } catch (e) {}
    }).catch(() => toast("Couldn't load Gem Vault — check your connection", "err"));
  }

  // ── Reef Raiders (CH 17, key "fish"): PixiJS arcade fish-shooter, play-money/demo.
  //    NOTE FOR CHATGPT (v11.37): new channel. Renderer fishtable.js + money engine
  //    fishtable-engine.js (~90% RTP). Demo-only for now (real-money/wallet parked,
  //    same buy-in→credits→settle model as blackjack). ──
  function ensureFishLoaded() {
    if (window.FishTable) return Promise.resolve(true);
    if (fishLoadPromise) return fishLoadPromise;
    fishLoadPromise = loadPixiOnce()
      .then(() => loadScriptOnce("fishtable-engine.js?v=1243"))
      .then(() => loadScriptOnce("fishtable.js?v=1243"))
      .then(() => true)
      .catch((e) => { fishLoadPromise = null; throw e; });
    return fishLoadPromise;
  }
  function buildFish() {
    if (fishGame || !window.FishTable) return fishGame;
    const el = (id) => $(id);
    const mount = $("fish-stage"); if (!mount) return null;
    fishGame = new window.FishTable({
      mount, width: 900, height: 600, ethUsd: ethUsd, initialBalance: (window.TokenMode && TokenMode.active()) ? TokenMode.tokens() : demoUsd,
      onBalance: (b) => { if (window.TokenMode && TokenMode.active()) return; demoUsd = Math.round(b * 100) / 100; demoSave(); demoPaint(); }, // demo only (token mode: balance owned by TokenMode)
      onWin: (i) => setLastResult({ won: true, game: "Reef Raiders", emoji: "🐟", amountUsd: i.profitUsd, detail: i.bonus ? "bonus catch" : (i.mult ? Math.round(i.mult) + "× catch" : "big catch") }),
      els: {
        balance: el("fish-balance"), win: el("fish-win"), message: el("fish-message"),
        betSlider: el("fish-bet"), betVal: el("fish-bet-val"), cost: el("fish-cost"), power: el("fish-power"),
        powerUp: el("fish-pup"), powerDown: el("fish-pdn"), autoBtn: el("fish-auto"), lockBtn: el("fish-lock"), fsBtn: el("fish-fs"),
        sesSpent: el("fish-ses-spent"), sesWon: el("fish-ses-won"), sesNet: el("fish-ses-net"),
      },
    });
    try { fishGame.setFullscreenTarget($("layer-fish")); } catch (e) {}
    { const fb = $("fish-fs"); if (fb) fb.addEventListener("click", () => { try { fishGame.toggleFullscreen($("layer-fish")); } catch (e) {} }); }
    { const fx = $("fish-fs-exit"); if (fx) fx.addEventListener("click", () => { try { fishGame.toggleFullscreen($("layer-fish")); } catch (e) {} }); }
    setupFishTiltFullscreen();
    try { window.__fish = fishGame; } catch (e) {} // debug/support handle
    return fishGame;
  }
  function setupFishTiltFullscreen() {
    if (setupFishTiltFullscreen.done) return;
    setupFishTiltFullscreen.done = true;
    const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (window.matchMedia && window.matchMedia("(max-width: 900px)").matches);
    const isLandscape = () => window.matchMedia ? window.matchMedia("(orientation: landscape)").matches : window.innerWidth > window.innerHeight;
    const sync = () => {
      if (!fishGame || currentGame !== "fish" || !isMobile()) return;
      try { fishGame.autoFullscreen(isLandscape(), $("layer-fish")); } catch (e) {}
    };
    const afterTilt = () => [80, 220, 520, 900].forEach((ms) => setTimeout(sync, ms));
    window.addEventListener("orientationchange", afterTilt, { passive: true });
    window.addEventListener("resize", afterTilt, { passive: true });
    document.addEventListener("visibilitychange", sync);
    setTimeout(sync, 0);
  }
  function ensureFishReady() {
    let kicked = 0;
    const boot = () => ensureFishLoaded().then(() => {
      const g = buildFish(); if (!g) return;
      g.setActive(true); g.setEthUsd(ethUsd);
      if (window.TokenMode && TokenMode.active()) g.setBalance(TokenMode.tokens()); else if (demoOn) g.setBalance(demoUsd);
      g.setEnabled(true); // play-money: always enabled (kept on wallet connect)
      try { if (g._sesSpent === 0 && g._sesWon === 0) g.newSession(); } catch (e) {} // fresh money-flow session on first entry
      setupFishTiltFullscreen();
    }).catch(() => { fishLoadPromise = null; });
    boot();
    // Watchdog: keep re-poking TV.idle() until the Pixi canvas is actually mounted AND
    // the TV is showing the fish phase. The lazy build can race the first idle() and
    // leave the LOADING layer stuck on (the "loads but keeps the loading screen" bug).
    // If the canvas never appears, re-kick the loader a couple of times before giving up.
    let tries = 0;
    const settle = () => {
      if (currentGame !== "fish") return; // user navigated away — stop
      const promo = !!(window.TV && TV._promoPlaying);
      const canvas = document.querySelector("#fish-stage canvas");
      if (window.TV && !promo) { try { TV.idle(); } catch (e) {} } // never fight the promo reveal
      if (canvas && window.TV && TV._phase === "fish") return;     // revealed — done
      // Don't spend the retry budget while the promo intro is still playing — it can
      // run longer than the budget, which used to leave Reef stuck after the promo.
      if (!promo) {
        tries++;
        if (!canvas && tries === 12 && kicked < 2) { kicked++; fishLoadPromise = null; boot(); } // loader stalled — retry
        if (tries >= 44 && kicked >= 2 && !canvas) { toast("Couldn't load Reef Raiders — tap the channel again", "err"); return; }
      }
      if (tries < 48) setTimeout(settle, 200);
    };
    settle();
  }

  // ── Sky Swoop (CH 18, key "swoop"): PlayCanvas 3D biplane CRASH game, play-money/demo.
  //    Renderer swoop3d.js (PlayCanvas) reuses the AUDITED crash-engine.js for the
  //    provably-fair bust point (1% edge) — the flying is purely cosmetic. ──
  function ensureSwoopLoaded() {
    if (window.SwoopGame) return Promise.resolve(true);
    if (swoopLoadPromise) return swoopLoadPromise;
    swoopLoadPromise = loadPlayCanvasOnce()
      .then(() => loadScriptOnce("swoop3d.js?v=1243"))
      .then(() => true)
      .catch((e) => { swoopLoadPromise = null; throw e; });
    return swoopLoadPromise;
  }
  function buildSwoop() {
    if (swoopGame || !window.SwoopGame) return swoopGame;
    const el = (id) => $(id);
    const mount = $("swoop-stage"); if (!mount) return null;
    const go = el("swoop-go"), mult = el("swoop-mult");
    const usd = (n) => "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const launchLabel = () => "LAUNCH  " + usd(swoopGame.unitBet);
    swoopGame = new window.SwoopGame({
      mount, width: 960, height: 600, ethUsd: ethUsd, initialBalance: demoUsd,
      onBalance: (b) => { demoUsd = Math.round(b * 100) / 100; demoSave(); demoPaint(); }, // demo play-money
      onWin: (i) => setLastResult({ won: true, game: "Sky Swoop", emoji: "✈️", amountUsd: i.profitUsd, detail: i.mult ? i.mult.toFixed(2) + "× cash-out" : "cash-out" }),
      onTick: (m) => { if (mult) mult.textContent = m.toFixed(2) + "x"; },
      onState: (s) => {
        if (mult) mult.classList.remove("win", "bust");
        if (s.state === "idle") { if (mult) mult.textContent = ""; if (go) { go.textContent = launchLabel(); go.className = "swoop-go"; } }
        else if (s.state === "climbing") { if (go) { go.textContent = "CASH OUT"; go.className = "swoop-go cash"; } }
        else if (s.state === "cashed") { if (mult) { mult.classList.add("win"); mult.textContent = s.mult.toFixed(2) + "x"; } if (go) { go.textContent = "✓ +" + usd(Math.max(0, (s.won || 0) - (s.bet || 0))); go.className = "swoop-go dead"; } } // +profit, not gross (stake already yours)
        else if (s.state === "crashed") { if (mult) { mult.classList.add("bust"); mult.textContent = "BUST @ " + (s.bust || s.mult).toFixed(2) + "x"; } if (go) { go.textContent = "💥 CRASHED"; go.className = "swoop-go dead"; } }
      },
      els: { fsBtn: el("swoop-fs") },
    });
    { const b = el("swoop-bet"), bv = el("swoop-bet-val"); if (b) b.addEventListener("input", () => { swoopGame.setBet(parseFloat(b.value) || 10); if (bv) bv.textContent = usd(swoopGame.unitBet).replace(".00", ""); if (swoopGame._state === "idle" && go) go.textContent = launchLabel(); }); }
    // the single one-action button: LAUNCH when idle, CASH OUT while climbing
    if (go) go.addEventListener("click", () => { if (swoopGame._state === "idle") swoopGame.launch(); else if (swoopGame._state === "climbing") swoopGame.cashOut(); });
    try { swoopGame.setFullscreenTarget($("layer-swoop")); } catch (e) {}
    { const fb = $("swoop-fs"); if (fb) fb.addEventListener("click", () => { try { swoopGame.toggleFullscreen($("layer-swoop")); } catch (e) {} }); }
    { const fx = $("swoop-fs-exit"); if (fx) fx.addEventListener("click", () => { try { swoopGame.toggleFullscreen($("layer-swoop")); } catch (e) {} }); }
    setupSwoopTiltFullscreen();
    try { window.__swoop = swoopGame; } catch (e) {} // debug/support handle
    return swoopGame;
  }
  function setupSwoopTiltFullscreen() {
    if (setupSwoopTiltFullscreen.done) return;
    setupSwoopTiltFullscreen.done = true;
    const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (window.matchMedia && window.matchMedia("(max-width: 900px)").matches);
    const isLandscape = () => window.matchMedia ? window.matchMedia("(orientation: landscape)").matches : window.innerWidth > window.innerHeight;
    const sync = () => { if (!swoopGame || currentGame !== "swoop" || !isMobile()) return; try { swoopGame.autoFullscreen(isLandscape(), $("layer-swoop")); } catch (e) {} };
    const afterTilt = () => [80, 220, 520, 900].forEach((ms) => setTimeout(sync, ms));
    window.addEventListener("orientationchange", afterTilt, { passive: true });
    window.addEventListener("resize", afterTilt, { passive: true });
    document.addEventListener("visibilitychange", sync);
    setTimeout(sync, 0);
  }
  function ensureSwoopReady() {
    let kicked = 0;
    const boot = () => ensureSwoopLoaded().then(() => {
      const g = buildSwoop(); if (!g) return;
      g.setActive(true); g.setEthUsd(ethUsd);
      if (demoOn) g.setBalance(demoUsd); g.setEnabled(true); // play-money: always enabled
      setupSwoopTiltFullscreen();
    }).catch(() => { swoopLoadPromise = null; });
    boot();
    let tries = 0;
    const settle = () => {
      if (currentGame !== "swoop") return; // user navigated away — stop
      const promo = !!(window.TV && TV._promoPlaying);
      const canvas = document.querySelector("#swoop-stage canvas");
      if (window.TV && !promo) { try { TV.idle(); } catch (e) {} }
      if (canvas && window.TV && TV._phase === "swoop") return;     // revealed — done
      if (!promo) {
        tries++;
        if (!canvas && tries === 12 && kicked < 2) { kicked++; swoopLoadPromise = null; boot(); }
        if (tries >= 44 && kicked >= 2 && !canvas) { toast("Couldn't load Sky Swoop — tap the channel again", "err"); return; }
      }
      if (tries < 48) setTimeout(settle, 200);
    };
    settle();
  }

  // ── Fish Shooter (CH 19, key "fishshooter"): PixiJS top-down fish-table with the
  //    Grok-generated animated art pack, play-money/demo. Reuses fishtable-engine.js
  //    UNCHANGED for the money/RTP (same engine as Reef Raiders). ──
  function ensureFishShooterLoaded() {
    if (window.FishShooter) return Promise.resolve(true);
    if (fishshooterLoadPromise) return fishshooterLoadPromise;
    fishshooterLoadPromise = loadPixiOnce()
      .then(() => loadScriptOnce("fishshooter-engine.js?v=1243")) // OWN engine (decoupled from Reef's fishtable-engine.js)
      .then(() => loadScriptOnce("fishshooter.js?v=1243"))
      .then(() => true)
      .catch((e) => { fishshooterLoadPromise = null; throw e; });
    return fishshooterLoadPromise;
  }
  function buildFishShooter() {
    if (fishshooterGame || !window.FishShooter) return fishshooterGame;
    const el = (id) => $(id);
    const mount = $("fishshooter-stage"); if (!mount) return null;
    fishshooterGame = new window.FishShooter({
      mount, ethUsd: ethUsd, initialBalance: (window.TokenMode && TokenMode.active()) ? TokenMode.tokens() : demoUsd,
      onBalance: (b) => { if (window.TokenMode && TokenMode.active()) return; demoUsd = Math.round(b * 100) / 100; demoSave(); demoPaint(); }, // demo only (token mode: balance owned by TokenMode)
      onReady: () => { // critical assets built → reveal the channel (replaces the loading screen) regardless of the settle() poll window
        if (currentGame !== "fishshooter") return;
        try { if (window.TV && !TV._promoPlaying) TV.idle(); } catch (e) {}
        try { fishshooterGame && fishshooterGame._resize(); } catch (e) {}
      },
      onWin: (i) => setLastResult({ won: true, game: "Fish Shooter", emoji: "🎣", amountUsd: i.profitUsd, detail: i.bonus ? "bonus" : (i.mult ? Math.round(i.mult) + "× catch" : "big catch") }),
      els: {
        betSlider: el("fsh-bet"), betVal: el("fsh-bet-val"), cost: el("fsh-cost"), power: el("fsh-power"),
        powerUp: el("fsh-pup"), powerDown: el("fsh-pdn"), autoBtn: el("fsh-auto"), lockBtn: el("fsh-lock"), fsBtn: el("fsh-fs"),
        speedSlow: el("fsh-spd-slow"), speedMed: el("fsh-spd-med"), speedFast: el("fsh-spd-fast"),
        balance: el("fsh-balance"), win: el("fsh-win"), sesSpent: el("fsh-ses-spent"), sesWon: el("fsh-ses-won"), sesNet: el("fsh-ses-net"),
      },
    });
    try { fishshooterGame.setFullscreenTarget($("layer-fishshooter")); } catch (e) {}
    { const fb = $("fsh-fs"); if (fb) fb.addEventListener("click", () => { try { fishshooterGame.toggleFullscreen($("layer-fishshooter")); } catch (e) {} }); }
    { const fx = $("fsh-fs-exit"); if (fx) fx.addEventListener("click", () => { try { fishshooterGame.toggleFullscreen($("layer-fishshooter")); } catch (e) {} }); }
    setupFishShooterTiltFullscreen();
    try { window.__fshoot = fishshooterGame; } catch (e) {}
    return fishshooterGame;
  }
  function setupFishShooterTiltFullscreen() {
    if (setupFishShooterTiltFullscreen.done) return;
    setupFishShooterTiltFullscreen.done = true;
    const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (window.matchMedia && window.matchMedia("(max-width: 900px)").matches);
    const isLandscape = () => window.matchMedia ? window.matchMedia("(orientation: landscape)").matches : window.innerWidth > window.innerHeight;
    const sync = () => { if (!fishshooterGame || currentGame !== "fishshooter" || !isMobile()) return; try { fishshooterGame.autoFullscreen(isLandscape(), $("layer-fishshooter")); } catch (e) {} };
    const afterTilt = () => [80, 220, 520, 900].forEach((ms) => setTimeout(sync, ms));
    window.addEventListener("orientationchange", afterTilt, { passive: true });
    window.addEventListener("resize", afterTilt, { passive: true });
    document.addEventListener("visibilitychange", sync);
    setTimeout(sync, 0);
  }
  function ensureFishShooterReady() {
    // Show the LOADING screen the instant the channel is entered so the first visit
    // never flashes a black screen while the (uncached) Pixi engine downloads.
    try { if (window.TV && TV._loadingScreen && !document.querySelector("#fishshooter-stage canvas")) TV._loadingScreen(); } catch (e) {}
    let kicked = 0;
    const boot = () => ensureFishShooterLoaded().then(() => {
      const g = buildFishShooter(); if (!g) return;
      g.setActive(true); g.setEthUsd(ethUsd);
      if (window.TokenMode && TokenMode.active()) g.setBalance(TokenMode.tokens()); else if (demoOn) g.setBalance(demoUsd);
      g.setEnabled(true);
      try { g._resize(); } catch (e) {}
      setupFishShooterTiltFullscreen();
    }).catch(() => { fishshooterLoadPromise = null; });
    boot();
    let tries = 0;
    const settle = () => {
      if (currentGame !== "fishshooter") return;
      const promo = !!(window.TV && TV._promoPlaying);
      const ready = !!(fishshooterGame && fishshooterGame._ready);
      const canvas = document.querySelector("#fishshooter-stage canvas");
      // Reveal the channel ONLY once the renderer can paint (critical assets built). Until then
      // the loading screen (shown on channel entry) stays up — never a blank canvas. onReady also
      // fires the reveal directly, so a slow first load still reveals after this poll window closes.
      if (window.TV && !promo && ready) { try { TV.idle(); } catch (e) {} }
      if (ready && canvas && window.TV && TV._phase === "fishshooter") { try { fishshooterGame._resize(); } catch (e) {} return; }
      if (!promo) {
        tries++;
        if (!canvas && tries === 12 && kicked < 2) { kicked++; fishshooterLoadPromise = null; boot(); }
        if (tries >= 44 && kicked >= 2 && !ready) { toast("Couldn't load Fish Shooter — tap the channel again", "err"); return; }
      }
      if (tries < 48) setTimeout(settle, 200);
    };
    settle();
  }

  // ── Coin Flip (CH 8): premium Three.js 3D coin. Lazy-loaded; the CSS coin is
  //    the fallback if WebGL/Three isn't available. tv.js drives it via TV._coin3d.
  function loadCoinFlip3dOnce() {
    if (window.CoinFlip3D) return Promise.resolve(true);
    if (coinFlip3dLoadPromise) return coinFlip3dLoadPromise;
    coinFlip3dLoadPromise = loadThreeOnce()
      .then(() => loadScriptOnce("coinflip3d.js?v=1243"))
      .then(() => true)
      .catch((e) => { coinFlip3dLoadPromise = null; throw e; });
    return coinFlip3dLoadPromise;
  }
  function buildCoinFlip3d() {
    if (coinFlip3d || !window.CoinFlip3D) return coinFlip3d;
    const mount = $("flip3d-stage"); if (!mount) return null;
    coinFlip3d = new window.CoinFlip3D({ mount: mount, width: 800, height: 600 });
    if (window.TV) TV._coin3d = coinFlip3d;
    document.body.classList.add("coin3d-on"); // hides the CSS coin fallback
    try { window.__coin3d = coinFlip3d; } catch (e) {}
    return coinFlip3d;
  }
  function ensureCoinFlip3dReady() {
    loadCoinFlip3dOnce().then(() => {
      const g = buildCoinFlip3d(); if (!g) return;
      g.setActive(true);
      if (window.TV && currentGame === "flip" && !TV._promoPlaying && TV._flipPreview) { try { TV._flipPreview(); } catch (e) {} }
    }).catch(() => {}); // silent — the CSS coin stays as the fallback
  }

  // ── 0-100 (CH 9): premium Three.js neon racetrack rail. Lazy-loaded; the DOM
  //    number-line is the fallback. tv.js drives it via TV._rail3d.
  function loadRail3dOnce() {
    if (window.Rail3D) return Promise.resolve(true);
    if (rail3dLoadPromise) return rail3dLoadPromise;
    rail3dLoadPromise = loadThreeOnce().then(() => loadScriptOnce("dice3d.js?v=1243")).then(() => true).catch((e) => { rail3dLoadPromise = null; throw e; });
    return rail3dLoadPromise;
  }
  function buildRail3d() {
    if (rail3d || !window.Rail3D) return rail3d;
    const mount = $("dice3d-stage"); if (!mount) return null;
    rail3d = new window.Rail3D({ mount: mount, width: 800, height: 600 });
    if (window.TV) TV._rail3d = rail3d;
    document.body.classList.add("dice3d-on"); // hides the DOM number-line bar
    try { window.__rail3d = rail3d; } catch (e) {}
    return rail3d;
  }
  function ensureDice3dReady() {
    loadRail3dOnce().then(() => { const g = buildRail3d(); if (g) g.setActive(true); }).catch(() => {}); // silent — DOM rail stays as fallback
  }

  // ── Dice #2 (CH 10): two chunky neon dice tumble in 3D. Lazy-loaded; the CSS
  //    dice are the fallback. tv.js drives it via TV._d2_3d.
  function loadDice2_3dOnce() {
    if (window.TwoDice3D) return Promise.resolve(true);
    if (d2_3dLoadPromise) return d2_3dLoadPromise;
    d2_3dLoadPromise = loadThreeOnce().then(() => loadScriptOnce("dice2-3d.js?v=1243")).then(() => true).catch((e) => { d2_3dLoadPromise = null; throw e; });
    return d2_3dLoadPromise;
  }
  function buildDice2_3d() {
    if (d2_3d || !window.TwoDice3D) return d2_3d;
    const mount = $("dice2-3d-stage"); if (!mount) return null;
    d2_3d = new window.TwoDice3D({ mount: mount, width: 800, height: 600 });
    if (window.TV) TV._d2_3d = d2_3d;
    document.body.classList.add("dice2-3d-on"); // hides the CSS dice
    try { window.__d2_3d = d2_3d; } catch (e) {}
    return d2_3d;
  }
  function ensureDice2_3dReady() {
    loadDice2_3dOnce().then(() => { const g = buildDice2_3d(); if (g) g.setActive(true); }).catch(() => {}); // silent — CSS dice stay as fallback
  }
  // "How free spins & payouts work" explainer — built live from the engine so the
  // numbers always match the real math (paytable, scatter, free-spin counts).
  let s3dHelpBuilt = false;
  function buildSlots3dHelp() {
    const E = window.Slots3DEngine, body = $("s3d-help-body");
    if (!E || !body || s3dHelpBuilt) return;
    const EMO = ["🍒", "🔔", "⭐", "7️⃣", "🥇", "💎", "🃏", "🔒"];
    const NAME = ["Cherry", "Bell", "Star", "Lucky 7", "Gold Bar", "Diamond", "WILD line", "Vault"];
    // paytable: payout per matching LINE, as a multiple of the per-line bet (3/4/5)
    let payRows = "";
    for (let s = 0; s <= 6; s++) { const p = E.PAY[s]; if (!p) continue;
      payRows += `<tr><td class="s3dh-sym">${EMO[s]} ${NAME[s]}</td><td>${p[0]}×</td><td>${p[1]}×</td><td>${p[2]}×</td></tr>`; }
    // a real bonus-triggering board (grid[reel][row]) — exactly 3 Vaults anywhere
    const board = [[0, 7, 2], [1, 3, 0], [7, 4, 1], [5, 0, 2], [7, 1, 3]];
    let cells = "";
    for (let row = 0; row < 3; row++) for (let reel = 0; reel < 5; reel++) {
      const sym = board[reel][row], v = sym === 7;
      cells += `<div class="s3dh-cell${v ? " v" : ""}">${EMO[sym]}</div>`;
    }
    const fs = E.FREE_SPINS, sp = E.SCATTER_PAY, mult = E.FREE_MULT;
    let fsRows = "";
    [3, 4, 5].forEach((n) => { fsRows += `<tr><td>${n} × 🔒 Vault</td><td><strong>${fs[n]} free spins</strong></td><td>+ ${sp[n]}× total-bet cash</td></tr>`; });
    body.innerHTML =
      `<h2>💎 Gem Vault — how it pays</h2>
       <p class="s3dh-lead">5 reels × 3 rows, <strong>20 paylines</strong>. Your bet is split across all 20 lines. Match <strong>3+ identical symbols left-to-right</strong> on a line (starting from reel 1) to win. <strong>🃏 WILD</strong> stands in for any symbol except the Vault.</p>
       <h3>Line payouts <span class="muted">(× the per-line bet, for 3 / 4 / 5 in a row)</span></h3>
       <table class="s3dh-pay"><thead><tr><th>Symbol</th><th>3</th><th>4</th><th>5</th></tr></thead><tbody>${payRows}</tbody></table>
       <h3>🎁 Free-spins bonus — this is the big one</h3>
       <p class="s3dh-lead">Land <strong>3 or more 🔒 Vault</strong> symbols <em>anywhere</em> on the reels (they don't need to be on a line) and you trigger a <strong>FREE SPINS</strong> round — plus an instant scatter cash payout. Here's a board that triggers it (3 Vaults lit):</p>
       <div class="s3dh-grid">${cells}</div>
       <p class="s3dh-trigger">⬆ 3 × 🔒 &nbsp;→&nbsp; <strong>${fs[3]} FREE SPINS</strong></p>
       <table class="s3dh-pay s3dh-bonus"><thead><tr><th>Vaults</th><th>Free spins</th><th>Scatter cash</th></tr></thead><tbody>${fsRows}</tbody></table>
       <p class="s3dh-lead">During the round, spins play automatically and <strong>every win is multiplied ×${mult}</strong>, all adding to one running grand total that stays on screen. It's <strong>provably fair</strong> — the whole bonus is fixed the instant the Vaults land (derived from the same commit), so the total can't change, it just plays out.</p>
       <p class="muted s3dh-foot">Play-money demo · ~95% RTP · verify any spin in the “Provably fair” panel.</p>`;
    s3dHelpBuilt = true;
  }
  function openSlots3dHelp() {
    const m = $("s3d-help-modal"); if (!m) return;
    const show = () => { buildSlots3dHelp(); m.classList.remove("hidden"); };
    if (window.Slots3DEngine) show();
    else ensureSlots3dLoaded().then(show).catch(() => toast("Couldn't load the paytable — check your connection", "err"));
  }
  // Unpack the contract's 15-symbol grid (4 bits each, cell = reel*3+row) into [5][3].
  function unpackSlotsGrid(packed) {
    const p = BigInt(packed);
    const grid = [[], [], [], [], []];
    for (let i = 0; i < 15; i++) {
      const sym = Number((p >> BigInt(4 * i)) & 0xFn);
      grid[(i / 3) | 0][i % 3] = sym;
    }
    return grid;
  }
  async function playSlotsClick() {
    if (window.TokenMode && TokenMode.active()) return tokenSlots();
    if (demoOn) return demoSlots();
    if (!ready()) return;
    if ((await ensureSlotsSupport()) === false)
      return toast("Crypto Reels isn't on this house contract yet — it needs a redeploy. (The other channels still work.)", "err");
    const stakeUsd = parseFloat($("slots-stake").value);
    if (!(stakeUsd > 0)) return toast("Drag to pick a bet", "err");
    const bet = usdToWei(stakeUsd);
    if (bet > maxBet) return toast("Max bet is " + usdOf(maxBet), "err");
    rememberBet(stakeUsd);
    doPlaySlots(bet);
  }
  async function doPlaySlots(bet) {
    activeRoomId = null; lastRevealed = null;
    lockReveal();
    tvPending(true);
    toast("Spinning the reels… confirm in your wallet", "ok");
    try {
      ensureSlotsLoaded().catch(() => {}); // warm the engine while the tx mines
      const tx = await contract.playSlots(bet, { gasLimit: 800000n });
      const rcpt = await tx.wait();
      tvPending(false);
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "SlotsRolled");
      if (!ev) { unlockReveal(); TV.idle(); refreshBalances(); refreshDiceHouse(); toast("Spin settled on-chain — check your balance.", "ok"); return; }
      const a = ev.args;
      const grid = unpackSlotsGrid(a.gridPacked);
      const won = a.payout > 0n;
      await ensureSlotsLoaded().catch(() => {}); // must be ready to animate the reveal
      TV.revealSlots({ grid, winUsd: weiToUsd(a.payout), betUsd: weiToUsd(bet), won });
      refreshBalances(); refreshDiceHouse(); refreshStats();
    } catch (e) {
      tvPending(false);
      unlockReveal();
      TV.idle("Pick a game and place a bet");
      txErr(e);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  DEMO MODE — try every game instantly with play money, no wallet required.
  //  Outcomes are simulated locally with the SAME odds, edge and paytables as
  //  the on-chain games and drive the SAME TV animations. Nothing touches the
  //  chain; the demo balance lives only in localStorage.
  // ════════════════════════════════════════════════════════════════════════
  function demoSave() { try { localStorage.setItem("ctf_demo_usd", String(Math.round(demoUsd * 100) / 100)); } catch {} }
  function demoPaint() {
    if (revealLock) return; // frozen mid-reveal so the balance can't spoil the outcome
    // ONLY paint the shared #game-balance in demo mode. A canvas game's onBalance callback calls
    // demoPaint() whenever its play-money balance changes; without this guard that would overwrite
    // the REAL on-chain balance (owned by refreshBalances) while a wallet is connected — making a
    // user size a real bet off the wrong number.
    if (demoOn) { const b = $("game-balance"); if (b) b.textContent = usd(demoUsd); }
    const d = $("demo-balance"); if (d) d.textContent = usd(demoUsd);
    paintSession(); // keep the site-wide session net live (it tracks demoUsd for ALL games)
  }
  // ── Site-wide session tracker (#demo-session, shown under the TV on every channel in demo mode).
  // NET is computed live from demoUsd so it's correct for EVERY game (table + canvas). wagered/won
  // accumulate from the discrete table-game settles via recordSession().
  let sessionBase = null, sesWagered = 0, sesWon = 0, _sesBal = null;
  function sessionReset() { sessionBase = demoUsd; _sesBal = demoUsd; sesWagered = 0; sesWon = 0; paintSession(); }
  function recordSession(wager, returned) { // table games report EXACT gross wagered + returned
    sesWagered = Math.round((sesWagered + Math.max(0, +wager || 0)) * 100) / 100;
    sesWon = Math.round((sesWon + Math.max(0, +returned || 0)) * 100) / 100;
    _sesBal = demoUsd; paintSession(); // this settle already moved demoUsd → mark it counted so the watcher skips it
  }
  function paintSession() {
    if (sessionBase == null) { sessionBase = demoUsd; _sesBal = demoUsd; }
    // Canvas games (fish/plane/slots3d/swoop/…) move demoUsd without recordSession — classify the
    // unhandled balance delta (up = won, down = wagered) so NET stays exact for EVERY game.
    if (_sesBal != null && demoUsd !== _sesBal) {
      const d = Math.round((demoUsd - _sesBal) * 100) / 100;
      if (d > 0) sesWon = Math.round((sesWon + d) * 100) / 100; else sesWagered = Math.round((sesWagered - d) * 100) / 100;
      _sesBal = demoUsd;
    }
    const w = $("ds-wagered"), wn = $("ds-won"), nt = $("ds-net");
    if (w) w.textContent = usd(sesWagered);
    if (wn) wn.textContent = usd(sesWon);
    if (nt) { const net = Math.round((demoUsd - sessionBase) * 100) / 100; nt.textContent = (net >= 0 ? "+" : "−") + usd(Math.abs(net)); nt.className = "ds-net " + (net > 0 ? "up" : net < 0 ? "down" : ""); }
  }
  // Mirror demo credits into the same guards the live readouts use, so the
  // per-game affordability hints ("not enough credits") work unchanged.
  function demoSyncBalance() {
    if (!demoOn) return; // defensive: this writes gameWei=usdToWei(demoUsd) — must NEVER run in real/token mode (would clobber the on-chain balance). All callers are demo-context; belt-and-suspenders.
    try { gameWei = usdToWei(demoUsd); } catch { gameWei = 0n; }
    try { maxBet = usdToWei(HARD_MAX_USD); } catch {}
    try { diceHouseWei = usdToWei(1000000); } catch {} // the "house" always covers in demo
    dicePayoutCapBps = 10000n;
    demoPaint();
    if (pressureGame) try { pressureGame.setEthUsd(ethUsd); if (window.TokenMode && TokenMode.active()) pressureGame.setBalance(TokenMode.tokens()); } catch (e) {}
    if (planeGame) try { planeGame.setEthUsd(ethUsd); if (window.TokenMode && TokenMode.active()) planeGame.setBalance(TokenMode.tokens()); else if (demoOn) planeGame.setBalance(demoUsd); } catch (e) {}
    if (slots3dGame) try { slots3dGame.setEthUsd(ethUsd); if (window.TokenMode && TokenMode.active()) slots3dGame.setBalance(TokenMode.tokens()); else if (demoOn) slots3dGame.setBalance(demoUsd); } catch (e) {}
    if (fishGame) try { fishGame.setEthUsd(ethUsd); if (window.TokenMode && TokenMode.active()) fishGame.setBalance(TokenMode.tokens()); else if (demoOn) fishGame.setBalance(demoUsd); } catch (e) {}
    if (swoopGame) try { swoopGame.setEthUsd(ethUsd); if (demoOn) swoopGame.setBalance(demoUsd); } catch (e) {}
    if (fishshooterGame) try { fishshooterGame.setEthUsd(ethUsd); if (window.TokenMode && TokenMode.active()) fishshooterGame.setBalance(TokenMode.tokens()); else if (demoOn) fishshooterGame.setBalance(demoUsd); } catch (e) {}
    try {
      setupSliders();
      if (currentGame === "dice") diceReadouts();
      else if (currentGame === "twodice") twoDiceReadouts();
      else if (currentGame === "crash") crashReadouts();
    } catch (e) {}
  }
  // Resync EVERY canvas game's displayed balance to the current mode WITHOUT touching gameWei
  // (demoSyncBalance forces gameWei=demoUsd, which is wrong in real/token mode). Wired as
  // TokenMode.onChange so a buy-in / cash-out / token bet immediately corrects the HUDs instead
  // of leaving a stale number (the "$10.72 / $4,500 stuck balance" the user saw after cash-out).
  function tokenStateBalanceUsd() {
    if (window.TokenMode && TokenMode.active()) return TokenMode.tokens();
    if (demoOn) return demoUsd;
    try { return weiToUsd(gameWei); } catch (e) { return 0; }
  }
  function syncTokenGameBalances() {
    var bal = tokenStateBalanceUsd();
    var tokOn = !!(window.TokenMode && TokenMode.active());
    // Re-apply the per-game MODE on every session change. Channel ENTRY already picks the right mode
    // (ensurePressure/PlaneReady), but if you BUY IN while already standing on Balloon Pop or Plane,
    // nothing else flips the game into token play — plane would stay stuck in legacy "real" (on-chain)
    // mode and refuse to bet, and pressure would keep showing demo. setMode() no-ops when already in
    // the target mode (and won't disturb a round mid-flight), so this is safe on every onChange tick.
    // pressure/plane are token-only when connected → balance 0 until buy-in (prevents accidental
    // play-money rounds on a connected wallet).
    var pbBal = tokOn ? TokenMode.tokens() : (demoOn ? demoUsd : 0);
    if (planeGame) {
      try {
        var want = demoOn ? "demo" : "token"; // connected (non-demo) is ALWAYS token now
        if (planeGame.mode !== want) {
          planeGame.setMode(want);
          if (want === "token" && planeGame.bets && planeGame.bets[0]) { planeGame.bets[0].autoOn = false; try { planeGame._syncPanel(planeGame.bets[0]); } catch (e) {} }
        }
        // don't toggle enabled mid-flight (would fight the live round UI)
        if (planeGame.state !== "token-flying" && planeGame.state !== "flying" && planeGame.state !== "takeoff") planeGame.setEnabled(demoOn || tokOn);
        planeGame.setEthUsd(ethUsd); planeGame.setBalance(pbBal);
      } catch (e) {}
    }
    if (pressureGame) {
      try {
        if (!(pressureGame.pressing && pressureGame.state === "inflating")) {
          pressureGame.setEnabled(true); // _tokenActive() keys off the live session, not this flag
          if (tokOn) { pressureGame.autoOn = false; if (pressureGame.els && pressureGame.els.autoToggle) { pressureGame.els.autoToggle.textContent = "AUTO OFF"; pressureGame.els.autoToggle.classList.remove("active"); } }
        }
        pressureGame.setEthUsd(ethUsd); pressureGame.setBalance(pbBal);
      } catch (e) {}
    }
    [slots3dGame, fishGame, fishshooterGame].forEach(function (g) {
      if (g) try { g.setEthUsd(ethUsd); g.setBalance(bal); } catch (e) {}
    });
    if (swoopGame && demoOn) try { swoopGame.setBalance(demoUsd); } catch (e) {} // swoop is demo-only
  }
  // Surface a STRANDED on-chain lock to ANY connected player (not just the owner host panel): read
  // the wallet's bjLocked; if funds are locked with no active token session, tell TokenMode the USD
  // so it shows a "Recover" button. The cross-session guard blocks a new buy-in until it's cleared,
  // so a stranded player otherwise could not play at all.
  async function checkStrandedLock() {
    if (!window.TokenMode || !TokenMode.setStranded) return;
    try {
      if (!account || !read || TokenMode.active()) { TokenMode.setStranded(0); return; }
      let locked = 0n; try { locked = await read.bjLocked(account); } catch (e) { return; }
      TokenMode.setStranded(locked > 0n ? weiToUsd(locked) : 0);
    } catch (e) {}
  }
  function enterDemo() {
    if (demoOn || account) return; // never override a live wallet connection
    demoOn = true;
    document.body.classList.add("demo-mode");
    $("play-house").hidden = false;
    $("dice-panel").hidden = false;
    { const td = $("twodice-panel"); if (td) td.hidden = false; }
    { const cp = $("crash-panel"); if (cp) cp.hidden = false; }
    { const pp = $("pressure-panel"); if (pp) pp.hidden = false; }
    { const pc = $("ch-pressure"); if (pc) pc.hidden = false; } // Balloon Pop is play-money → demo only
    { const pp = $("plane-panel"); if (pp) pp.hidden = false; }   // Plane shows in demo AND real
    { const pc = $("ch-plane"); if (pc) pc.hidden = false; }
    { const pp = $("slots3d-panel"); if (pp) pp.hidden = false; }  // Gem Vault 3D is play-money → demo only
    { const pc = $("ch-slots3d"); if (pc) pc.hidden = false; }
    { const pp = $("fish-panel"); if (pp) pp.hidden = false; }     // Reef Raiders is play-money → demo only
    { const pc = $("ch-fish"); if (pc) pc.hidden = false; }
    document.body.classList.remove("plane-real"); // demo → show the 2nd bet + feed + autobet
    { const bar = $("demo-bar"); if (bar) bar.classList.remove("hidden"); }
    { const below = $("demo-below"); if (below) below.classList.remove("hidden"); }
    { const ses = $("demo-session"); if (ses) ses.classList.remove("hidden"); }
    sessionReset(); // start the session tracker fresh from the current balance
    { const bdg = $("demo-tv-badge"); if (bdg) bdg.classList.remove("hidden"); }
    if (window.TV && TV.setConnected) TV.setConnected(true); // show game-ready previews, not SIGNAL LOST
    const mh = $("maxbet-hint"); if (mh) mh.textContent = "· demo · $10–$" + HARD_MAX_USD;
    if (pressureGame) { pressureGame.setBalance(demoUsd); pressureGame.setEnabled(true); }
    if (planeGame) { planeGame.setMode("demo"); planeGame.setBalance(demoUsd); planeGame.setEnabled(true); }
    if (slots3dGame) { slots3dGame.setBalance(demoUsd); slots3dGame.setEnabled(true); }
    if (fishGame) { fishGame.setBalance(demoUsd); fishGame.setEnabled(true); }
    if (swoopGame) { swoopGame.setBalance(demoUsd); swoopGame.setEnabled(true); }
    if (fishshooterGame) { fishshooterGame.setBalance(demoUsd); fishshooterGame.setEnabled(true); }
    demoSyncBalance();
  }
  function exitDemo() {
    if (!demoOn) return;
    demoOn = false;
    document.body.classList.remove("demo-mode");
    { const bar = $("demo-bar"); if (bar) bar.classList.add("hidden"); }
    { const below = $("demo-below"); if (below) below.classList.add("hidden"); }
    { const ses = $("demo-session"); if (ses) ses.classList.add("hidden"); }
    { const bdg = $("demo-tv-badge"); if (bdg) bdg.classList.add("hidden"); }
    // Balloon Pop, Gem Vault & Reef Raiders are PLAY-MONEY games. Connecting a
    // wallet used to hide them — but players want them to stay. Keep the channels
    // visible and the games playable on their own play-money balance even with a
    // wallet connected (they never touch real ETH).
    { const pc = $("ch-pressure"); if (pc) pc.hidden = false; }
    { const pc = $("ch-slots3d"); if (pc) pc.hidden = false; }
    { const pc = $("ch-fish"); if (pc) pc.hidden = false; }
    { const pp = $("pressure-panel"); if (pp) pp.hidden = false; }
    { const pp = $("slots3d-panel"); if (pp) pp.hidden = false; }
    { const pp = $("fish-panel"); if (pp) pp.hidden = false; }
    // Connected → Balloon Pop is a TOKEN game (not play-money): show the token balance (0 until you
    // buy in) and let _tokenActive() route the TAP to the server round. setEnabled(true) lifts the
    // legacy "play-money only" lock; syncTokenGameBalances re-applies this on every buy-in/cash-out.
    if (pressureGame) {
      pressureGame.setBalance((window.TokenMode && TokenMode.active()) ? TokenMode.tokens() : 0); pressureGame.setEnabled(true);
      if (window.TokenMode && TokenMode.active()) { pressureGame.autoOn = false; if (pressureGame.els && pressureGame.els.autoToggle) { pressureGame.els.autoToggle.textContent = "AUTO OFF"; pressureGame.els.autoToggle.classList.remove("active"); } }
    }
    if (slots3dGame) { slots3dGame.setBalance(demoUsd); slots3dGame.setEnabled(true); }
    if (fishGame) { fishGame.setBalance(demoUsd); fishGame.setEnabled(true); }
    if (swoopGame) { swoopGame.setBalance(demoUsd); swoopGame.setEnabled(true); }
    if (fishshooterGame) { fishshooterGame.setBalance(demoUsd); fishshooterGame.setEnabled(true); }
    // Connected → Plane is a TOKEN game (the legacy single-shot on-chain "real" mode is retired). The
    // plane-real class still applies: it hides the demo-only 2nd bet / feed / autobet (token is single-bet).
    document.body.classList.add("plane-real");
    if (planeGame) {
      planeGame.setMode("token");
      planeGame.setBalance((window.TokenMode && TokenMode.active()) ? TokenMode.tokens() : 0);
      planeGame.setEnabled(!!(window.TokenMode && TokenMode.active())); // disabled until buy-in → "Buy in with tokens to play"
      if (planeGame.bets && planeGame.bets[0]) { planeGame.bets[0].autoOn = false; try { planeGame._syncPanel(planeGame.bets[0]); } catch (e) {} }
    }
  }
  function demoReset() {
    // A Plane round mid-flight has already debited its stake; restart it cleanly so
    // the reset balance isn't settled against a stale in-flight bet.
    if (planeGame && demoOn) try { planeGame.restartDemo(); } catch (e) {}
    if (pressureGame && demoOn) try { pressureGame.restartDemo(); } catch (e) {}
    if (slots3dGame && demoOn) try { slots3dGame.restartDemo(); } catch (e) {}
    if (fishGame && demoOn) try { fishGame.restartDemo(); } catch (e) {}
    if (fishshooterGame && demoOn) try { fishshooterGame.restartDemo(); } catch (e) {} // end any open Fish Shooter bonus/boss round on a demo top-up
    demoUsd = Math.max(demoUsd, DEMO_START_USD); demoSave(); demoSyncBalance(); // top UP only — never knock a winning demo balance back down to the start grant
    sessionReset(); // a credit top-up re-bases the session so it doesn't show as winnings
    if (pressureGame) pressureGame.setBalance(demoUsd);
    if (planeGame && demoOn) planeGame.setBalance(demoUsd);
    if (slots3dGame && demoOn) slots3dGame.setBalance(demoUsd);
    if (fishGame && demoOn) fishGame.setBalance(demoUsd);
    toast("Demo credits topped up to " + usd(demoUsd) + " 🎮", "ok");
  }
  // Read + validate a demo stake from a slider. Returns 0 (and toasts) if invalid.
  function demoStake(sliderId) {
    const v = parseFloat($(sliderId).value);
    if (!(v > 0)) { toast("Drag to pick a stake", "err"); return 0; }
    if (v > demoUsd) { toast("Not enough demo credits — tap ↻ Reset to top up", "err"); return 0; }
    return v;
  }
  const demoTier = (profitUsd) => (profitUsd >= 500 ? "mega" : profitUsd >= 100 ? "big" : "normal");

  function demoFlip() {
    if (demoFlipBusy || revealLock) return; // settling OR still in the TV reveal HOLD → ignore the spam tap/key so a re-bet can't swallow the result screen
    const v = demoStake("house-bet"); if (!v) return;
    const wantsHeads = sideOf("house-side");
    rememberBet(v);
    const coinHeads = Math.random() < 0.5;
    const won = coinHeads === wantsHeads;
    const side = coinHeads ? "HEADS" : "TAILS";
    const betWei = usdToWei(v);
    const rv = flipReveal(betWei, won); // used for the TV display amounts only
    // Win pays the pot minus the 3% house cut = 1.94× stake → +0.94× profit.
    // Credit in plain USD to match the other demo games (no wei round-trip drift).
    demoUsd += (won ? 0.94 * v : -v); demoSave();
    recordSession(v, won ? 1.94 * v : 0);
    demoFlipBusy = true;
    const fb = $("play-house-btn"); if (fb) fb.disabled = true;
    const release = () => { demoFlipBusy = false; if (fb) fb.disabled = false; };
    lockReveal();
    TV.startFlip({ p1: "DEMO", p2: "HOUSE", p1Heads: wantsHeads });
    const seq = TV._seq;
    // Reveal after the on-TV countdown (~tuning + 3·2·1 + FLIP), mirroring the
    // pause the real game has while the tx mines.
    setTimeout(() => {
      // Tuned away mid-flip → release the frozen balance now instead of waiting
      // out the 20s safety timer.
      if (!demoOn || TV._seq !== seq) { release(); try { window.__onTvReveal && window.__onTvReveal({}); } catch (e) {} return; }
      playOutcome({ won, netUsd: weiToUsd(rv.netWei), betUsd: v, side });
      TV.revealResult({
        side, youWon: won, role: "participant",
        picked: wantsHeads ? "HEADS" : "TAILS", // show the player exactly what they bet vs what landed
        amountUsd: won ? weiToUsd(rv.netWei) : rv.amountUsd, tier: rv.tier,
        sub: won ? "DEMO win — play money (connect a wallet to play for real)" : "DEMO — play money, nothing real lost",
      });
      release();
    }, 2800); // land sooner — then the TV holds on the flat, fully-facing coin so the side is clear
  }
  function demoDice() {
    if (revealLock) return; // a reveal is in flight → ignore the spam tap (no stacked debits)
    const v = demoStake("dice-stake"); if (!v) return;
    const over = diceMode === "over";
    const T = clampDiceTarget($("dice-target").value, over ? "over" : "under");
    $("dice-target").value = String(T);
    const roll = Math.floor(Math.random() * 10000); // 0..9999 (landing on T loses)
    const won = over ? roll > T : roll < T;
    const winOutcomes = over ? (9999 - T) : T;
    const mult = Math.floor(9800 * 10000 / winOutcomes) / 10000;
    const profitUsd = won ? Math.max(0, v * (mult - 1)) : 0;
    rememberBet(v);
    demoUsd += (won ? profitUsd : -v); demoSave();
    recordSession(v, won ? v + profitUsd : 0);
    lockReveal();
    TV.revealDice({ roll: roll / 100, target: T / 100, mode: over ? "over" : "under", youWon: won, mult, amountUsd: won ? profitUsd : v, tier: demoTier(profitUsd) });
  }
  function demoTwoDice() {
    if (revealLock) return; // in-flight guard (see demoDice)
    const v = demoStake("td-stake"); if (!v) return;
    const T = Math.min(12, Math.max(2, (+$("td-target").value) | 0));
    const over = tdMode === "over";
    const combos = tdWinCombos(T, over);
    if (combos <= 0) return toast("Pick a different target for this bet type", "err");
    const d1 = 1 + Math.floor(Math.random() * 6), d2 = 1 + Math.floor(Math.random() * 6);
    const sum = d1 + d2;
    const won = over ? sum > T : sum < T;
    const mult = Math.floor(9800 * 36 / combos) / 10000;
    const profitUsd = won ? v * (mult - 1) : 0;
    rememberBet(v);
    demoUsd += (won ? profitUsd : -v); demoSave();
    recordSession(v, won ? v + profitUsd : 0);
    lockReveal();
    TV.revealTwoDice({ d1, d2, target: T, mode: over ? "over" : "under", youWon: won, mult, amountUsd: won ? profitUsd : v, tier: demoTier(profitUsd) });
  }
  function demoCrash() {
    if (revealLock) return; // in-flight guard (see demoDice)
    const v = demoStake("crash-stake"); if (!v) return;
    const targetX = crashTargetVal();
    const crashX = (window.CrashEngine && CrashEngine.crashFromRandom) ? CrashEngine.crashFromRandom(Math.random, CRASH_EDGE) : 1;
    const won = crashX >= targetX;
    const profitUsd = won ? v * (targetX - 1) : 0;
    rememberBet(v);
    demoUsd += (won ? profitUsd : -v); demoSave();
    recordSession(v, won ? v + profitUsd : 0);
    lockReveal();
    TV.revealCrash({ crashX, targetX, won, amountUsd: won ? profitUsd : v, mult: targetX, tier: demoTier(profitUsd) });
  }
  function demoSlots() {
    if (revealLock) return; // in-flight guard (see demoDice)
    const v = demoStake("slots-stake"); if (!v) return;
    rememberBet(v);
    ensureSlotsLoaded().then(() => {
      if (!window.CryptoReels || !CryptoReels.simulate) return toast("Slots engine still loading — try again", "err");
      const { grid, winUsd } = CryptoReels.simulate(v);
      const won = winUsd > 0;
      demoUsd += (won ? winUsd : 0) - v; demoSave();
      recordSession(v, won ? winUsd : 0);
      lockReveal();
      TV.revealSlots({ grid, winUsd, betUsd: v, won });
    }).catch(() => toast("Couldn't load the slots engine — check your connection", "err"));
  }

  // ── TOKEN-mode discrete games: outcome from the SERVER bridge (no wallet popup per
  //    bet), rendered with the SAME TV.reveal* path as the demo games. Balance is the
  //    token ledger (TokenMode) — never demoUsd / recordSession (those are demo-only;
  //    token wagering is tracked server-side). One server engine decides each result.
  function tokenStake(id) {
    const el = $(id); const v = el ? parseFloat(el.value) : 0;
    if (!(v > 0)) { toast("Drag to pick a stake", "err"); return 0; }
    if (v > TokenMode.tokens()) { toast("Not enough tokens — cash out or buy in more", "err"); return 0; }
    return v;
  }
  async function tokenDice() {
    if (revealLock) return;
    const v = tokenStake("dice-stake"); if (!v) return;
    const over = diceMode === "over";
    const T = clampDiceTarget($("dice-target").value, over ? "over" : "under");
    $("dice-target").value = String(T);
    rememberBet(v); lockReveal();
    let r; try { r = await TokenMode.bet("dice", v, { target: T, over: over }); }
    catch (e) { unlockReveal(); return txErr ? txErr(e) : toast("Bet failed", "err"); }
    const won = !!r.win, roll = (r.outcome && r.outcome.roll) || 0, mult = r.multiplier || 0;
    const profitUsd = won ? Math.max(0, (r.payoutUnits || 0) - v) : 0;
    TV.revealDice({ roll: roll / 100, target: T / 100, mode: over ? "over" : "under", youWon: won, mult, amountUsd: won ? profitUsd : v, tier: demoTier(profitUsd) });
    setTimeout(function () { if (window.TokenMode && TokenMode.syncBalance) TokenMode.syncBalance(); }, 2800); // update balance AFTER the dice reveal, not before
  }
  async function tokenTwoDice() {
    if (revealLock) return;
    const v = tokenStake("td-stake"); if (!v) return;
    const T = Math.min(12, Math.max(2, (+$("td-target").value) | 0));
    const over = tdMode === "over";
    if (tdWinCombos(T, over) <= 0) return toast("Pick a different target for this bet type", "err");
    rememberBet(v); lockReveal();
    let r; try { r = await TokenMode.bet("dice2", v, { target: T, over: over }); }
    catch (e) { unlockReveal(); return txErr ? txErr(e) : toast("Bet failed", "err"); }
    const won = !!r.win, mult = r.multiplier || 0;
    const d1 = (r.outcome && r.outcome.d1) || 1, d2 = (r.outcome && r.outcome.d2) || 1;
    const profitUsd = won ? Math.max(0, (r.payoutUnits || 0) - v) : 0;
    TV.revealTwoDice({ d1, d2, target: T, mode: over ? "over" : "under", youWon: won, mult, amountUsd: won ? profitUsd : v, tier: demoTier(profitUsd) });
    setTimeout(function () { if (window.TokenMode && TokenMode.syncBalance) TokenMode.syncBalance(); }, 2800); // update balance AFTER the dice reveal
  }
  async function tokenCrash() {
    if (revealLock) return;
    const v = tokenStake("crash-stake"); if (!v) return;
    const targetX = crashTargetVal();
    rememberBet(v); lockReveal();
    let r; try { r = await TokenMode.bet("crash", v, { cashOutAt: targetX }); }
    catch (e) { unlockReveal(); return txErr ? txErr(e) : toast("Bet failed", "err"); }
    const won = !!r.win;
    const crashX = (r.outcome && r.outcome.crashPoint) || targetX;
    const profitUsd = won ? Math.max(0, (r.payoutUnits || 0) - v) : 0;
    TV.revealCrash({ crashX, targetX, won, amountUsd: won ? profitUsd : v, mult: targetX, tier: demoTier(profitUsd) });
    setTimeout(function () { if (window.TokenMode && TokenMode.syncBalance) TokenMode.syncBalance(); }, 2800); // update balance AFTER the crash reveal
  }
  async function tokenSlots() {
    if (revealLock) return;
    const v = tokenStake("slots-stake"); if (!v) return;
    rememberBet(v);
    try { await ensureSlotsLoaded(); } catch (e) { return toast("Couldn't load the slots engine — check your connection", "err"); }
    let r; try { r = await TokenMode.bet("slots", v, { bet: v }); }
    catch (e) { return txErr ? txErr(e) : toast("Bet failed", "err"); }
    const won = !!r.win, grid = (r.outcome && r.outcome.grid) || [], winUsd = won ? (r.payoutUnits || 0) : 0;
    lockReveal();
    TV.revealSlots({ grid, winUsd, betUsd: v, won });
    setTimeout(function () { if (window.TokenMode && TokenMode.syncBalance) TokenMode.syncBalance(); }, 2800); // update balance AFTER the slots reveal
  }

  // ── Game switcher ("change the channel") ──
  // Poker is temporarily disabled (hidden from the channel bar) — to be revisited.
  const GAME_CHANNEL = { flip: 8, dice: 9, twodice: 10, crash: 11, pressure: 13, plane: 14, slots3d: 15, blackjack: 16, fish: 17, swoop: 18, fishshooter: 19 };
  const GAME_TITLE = { flip: "CRYPTO TV FLIP", dice: "CRYPTO TV 0-100", twodice: "CRYPTO TV DICE #2", crash: "CRYPTO TV CRASH", pressure: "BALLOON POP", plane: "CRYPTO TV PLANE", slots3d: "GEM VAULT", blackjack: "BLACKJACK", fish: "REEF RAIDERS", swoop: "SKY SWOOP", fishshooter: "FISH SHOOTER" };
  const GAME_ORDER = ["flip", "dice", "twodice", "crash", "pressure", "plane", "slots3d", "fish", "fishshooter", "blackjack"]; // Sky Swoop hidden for now
  function paintGameTabs(game) {
    document.body.classList.toggle("game-dice", game === "dice");
    document.body.classList.toggle("game-twodice", game === "twodice");
    document.body.classList.toggle("game-crash", game === "crash");
    document.body.classList.toggle("game-slots", game === "slots");
    document.body.classList.toggle("game-pressure", game === "pressure");
    document.body.classList.toggle("game-plane", game === "plane");
    document.body.classList.toggle("game-slots3d", game === "slots3d");
    document.body.classList.toggle("game-fish", game === "fish");
    document.body.classList.toggle("game-swoop", game === "swoop");
    document.body.classList.toggle("game-fishshooter", game === "fishshooter");
    document.body.classList.toggle("game-blackjack", game === "blackjack");
    document.body.classList.toggle("game-poker", game === "poker"); // CSS hides the TV layout, shows #poker-view
    const bar = $("game-nav"); if (bar) bar.dataset.game = game;
    document.querySelectorAll("#game-nav .game-card").forEach((b) => {
      const on = b.dataset.game === game;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false");
    });
    // The TV owns the idle title now (it shows SIGNAL LOST when disconnected).
    if (window.TV && TV.setChannelTitle) TV.setChannelTitle(GAME_TITLE[game] || GAME_TITLE.flip);
    else { const title = $("idle-title"); if (title) title.textContent = GAME_TITLE[game] || GAME_TITLE.flip; }
    document.body.classList.toggle("has-betbar", BETBAR_GAMES.has(game)); // pin the floating bet bar (phones)
    syncBetbarStake();
  }
  function switchGame(game) {
    if (game === currentGame || !GAME_CHANNEL[game]) return;
    hideShareBtn(); // leaving a game clears its win-share button
    clearTvWin();   // …and the on-screen win badge — a win doesn't follow you to another game
    unlockReveal(); // clear any pending reveal-lock so the new channel's balance isn't frozen for ~20s after a bet-then-switch
    currentGame = game;
    paintGameTabs(game);
    try { localStorage.setItem("ctf_game", game); } catch {}
    // leaving canvas-heavy channels? pause their tickers so they don't burn CPU off-channel.
    if (game !== "slots" && window.CryptoReels && CryptoReels.setActive) CryptoReels.setActive(false);
    if (game !== "pressure" && pressureGame) pressureGame.setActive(false);
    if (game !== "plane" && planeGame) planeGame.setActive(false);
    if (game !== "slots3d" && slots3dGame) slots3dGame.setActive(false);
    if (game !== "fish" && fishGame) fishGame.setActive(false);
    if (game !== "swoop" && swoopGame) swoopGame.setActive(false);
    if (game !== "fishshooter" && fishshooterGame) fishshooterGame.setActive(false);
    if (game !== "flip" && coinFlip3d) coinFlip3d.setActive(false);
    if (game !== "dice" && rail3d) rail3d.setActive(false);
    if (game !== "twodice" && d2_3d) d2_3d.setActive(false);
    if (game !== "blackjack" && window.BJ_MUTE) { window.BJ_MUTE(true); bjStopCount(); bjBetSig = ""; } // hush blackjack + stop its countdown off-channel; clear the dock sig so re-entry always repaints the BET controls
    // Blackjack uses its OWN standalone server balance — hide the demo credits on this channel.
    document.body.classList.toggle("bj-channel", game === "blackjack");
    if (game === "blackjack") { const wl = $("bj-wallet"); if (wl) wl.textContent = "🪪 " + short(account || bjGuestId()); }
    // Poker is its own full-width view (no TV); everything else uses the TV channel.
    if (game === "poker") { if (window.PokerUI) PokerUI.show(); }
    else { if (window.PokerUI) PokerUI.hide(); if (window.TV && TV.changeChannel) TV.changeChannel(GAME_CHANNEL[game]); }
    if (game === "flip") { ensureCoinFlip3dReady(); }
    else if (game === "dice") { refreshDiceHouse(); diceReadouts(); ensureDice3dReady(); }
    else if (game === "twodice") { refreshDiceHouse(); twoDiceReadouts(); ensureTwoDiceSupport(); ensureDice2_3dReady(); }
    else if (game === "crash") { refreshDiceHouse(); crashReadouts(); ensureCrashSupport(); }
    else if (game === "pressure") { ensurePressureReady(); }
    else if (game === "plane") { refreshDiceHouse(); ensurePlaneReady(); }
    else if (game === "slots3d") { ensureSlots3dReady(); }
    else if (game === "fish") { ensureFishReady(); }
    else if (game === "swoop") { ensureSwoopReady(); }
    else if (game === "fishshooter") { ensureFishShooterReady(); }
    else if (game === "blackjack") { ensureBlackjackReady(); }
  }
  // ── Blackjack channel (CH 16): the live felt runs in an isolated iframe (its own
  // CSS/scripts can't collide with the site). Lazy-set the src on first visit. The
  // betting + action CONTROLS are native site elements in the dock under the TV,
  // bridged to the felt via postMessage. ──
  function bjFramePost(active) { const f = $("bj-frame"); if (f && f.contentWindow) try { f.contentWindow.postMessage({ type: "bj:active", active }, "*"); } catch (e) {} }
  // A persistent temp "guest" identity so every visitor is a distinct player with
  // their own demo balance and can sit at a shared table together (multiplayer demo).
  function bjGuestId() {
    try { let g = localStorage.getItem("bj_guest"); if (!g || !/^guest:/.test(g)) { g = "guest:" + Math.random().toString(36).slice(2, 10); localStorage.setItem("bj_guest", g); } return g; }
    catch (e) { return "guest:" + Math.random().toString(36).slice(2, 10); }
  }
  let bjPendingTable = null; // a specific table id arrived via a share link (?bjtable=…)
  try { bjPendingTable = new URLSearchParams(location.search).get("bjtable"); } catch (e) {}
  let bjRoomId = null; // latest table id the felt reports (for the Share button)
  const BJ_START = 5000; // blackjack play-chip balance — matches the site-wide $5,000 demo refill (reload tops up to $5,000)
  let bjBridgeBusy = false;
  function bjBridgeSessionKey() { return account ? "ctf_bj_session_" + account.toLowerCase() : ""; }
  function bjBridgeTokenKey() { return account ? "ctf_bj_token_" + account.toLowerCase() : ""; }
  function bjSettlementKey(sessionId) { return account ? "ctf_bj_settlement_" + account.toLowerCase() + "_" + (sessionId || "latest") : ""; }
  async function bridgeJson(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Bridge request failed");
    return j;
  }
  function bjBridgeMessage(intent, body) {
    const lines = [
      "Crypto TV Blackjack Bridge",
      "Action: " + intent,
      "Player: " + account,
      "Contract: " + deployment.address,
      "Chain ID: " + Number(deployment.chainId),
    ];
    if (intent === "start") {
      lines.push("Buy-in wei: " + String(body.buyInWei || "0"));
    } else if (intent === "settle") {
      lines.push("Session: " + String(body.sessionId || "latest"));
    }
    return lines.join("\n");
  }
  async function signBjBridge(intent, body) {
    if (!signer || !account) throw new Error("Wallet is not connected");
    return signer.signMessage(bjBridgeMessage(intent, body || {}));
  }
  async function bridgeStatus() {
    const cid = Number(deployment && deployment.chainId) || 11155111;
    const r = await fetch("/api/bridge/status?chainId=" + encodeURIComponent(String(cid)), { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Bridge status unavailable");
    return j;
  }
  function bjFrameMatchesWallet(frame, wallet) {
    if (!frame || !frame.getAttribute("src") || !wallet) return false;
    try {
      const u = new URL(frame.getAttribute("src"), location.href);
      return String(u.searchParams.get("guest") || "").toLowerCase() === String(wallet).toLowerCase();
    } catch (e) { return false; }
  }
  let bjFeltNonce = 0; // bumps each felt (re)load so the iframe TRULY reloads — changing only the #hash
                       // (where the token session lives) does NOT reload an iframe, so the felt would keep
                       // its old hash-less connection and never bind to the token session (the CH16 bug).
  function ensureBlackjackReady() {
    const f = $("bj-frame");
    if (f && f.getAttribute("src") && account && !bjFrameMatchesWallet(f, account)) f.removeAttribute("src");
    // If the player's TOKEN session changed (bought in / cashed out) since the felt loaded, reload it so the
    // table re-binds to the right session (its chips ARE the token balance). Safe: token cash-out is refused
    // mid-hand server-side, so this won't reload over a live hand.
    if (f && f.getAttribute("src")) {
      let wantSid = "";
      try { if (account && window.TokenMode && TokenMode.active && TokenMode.active() && TokenMode.session) { const si = TokenMode.session(); wantSid = (si && si.sessionId) || ""; } } catch (e) {}
      let curSid = "";
      try { curSid = new URLSearchParams(((new URL(f.src, location.href)).hash || "").replace(/^#/, "")).get("bjsession") || ""; } catch (e) {}
      if (curSid !== wantSid) f.removeAttribute("src");
    }
    if (f && !f.getAttribute("src")) {
      // No &bal= seed — the table starts from its own server default ($1,000), NOT the demo balance.
      const tableWallet = account || bjGuestId();
      // &r=<nonce> in the QUERY forces a real iframe reload (so the felt re-reads the #bjsession from the
      // hash and re-sends its hello → the server re-binds the table to the token session).
      let src = "blackjack.html?tv=1&v=1238&r=" + (++bjFeltNonce) + "&guest=" + encodeURIComponent(tableWallet);
      let tokenHash = "";
      // PREFERRED real-money path: fund the table with the player's TOKEN session (chips = tokens, no lock step).
      if (account && window.TokenMode && TokenMode.active && TokenMode.active() && TokenMode.session) {
        try { const si = TokenMode.session(); if (si && si.sessionId) tokenHash = "#bjtoken=" + encodeURIComponent(si.sessionToken || "") + "&bjsession=" + encodeURIComponent(si.sessionId); } catch (e) {}
      }
      // Fallback: the old experimental on-chain blackjack bridge token (if that path was ever used).
      if (!tokenHash && account) { try { const tok = localStorage.getItem(bjBridgeTokenKey()) || ""; if (tok) tokenHash = "#bjtoken=" + encodeURIComponent(tok); } catch {} }
      if (bjPendingTable) { src += "&table=" + encodeURIComponent(bjPendingTable); bjPendingTable = null; }
      f.src = src + tokenHash; // loads the felt + scripts inside the TV
    }
    setTimeout(() => { bjFramePost(true); }, 50);
  }
  // Blackjack chips are a self-contained play-money balance held by the server, separate from
  // the site demo credits (those were getting tangled up with the table). The ⟳ Reload button
  // tops the table back up to $1,000. The server refuses a re-seed mid-hand, so reload can
  // never wipe a live bet/hand.
  async function bjReload() {
    const f = $("bj-frame");
    if (!account) {
      if (f && f.contentWindow) try { f.contentWindow.postMessage({ type: "bj:seed", balance: BJ_START }, "*"); } catch (e) {}
      return;
    }
    // TOKEN-FUNDED: the table is funded by your token session — there is nothing to "lock" and the OLD
    // on-chain bridge is disabled (its "needs durable server state" error is what users were hitting). So
    // instead of touching the old bridge, just (re)bind the felt to your token session and bail.
    if (window.TokenMode && TokenMode.active && TokenMode.active()) {
      try { if (f) { f.removeAttribute("src"); ensureBlackjackReady(); } } catch (e) {}
      toast("Your tokens fund this table — just place a bet 🪙", "ok");
      return;
    }
    if (bjBridgeBusy) return;
    if (!ready()) return;
    await refreshBalances();
    const buyUsd = Math.min(BJ_START, Math.floor(weiToUsd(gameWei)));
    if (!(buyUsd >= 10)) return toast("Deposit at least $10 into game credits first.", "err");
    const buyWei = usdToWei(buyUsd);
    try {
      const st = await bridgeStatus();
      if (!st.enabled) return toast(!st.signerConfigured ? "Bridge signer is not configured on the server yet." : !st.stateConfigured ? "Blackjack bridge needs durable server state before it can be enabled." : "Blackjack bridge is not enabled on the server yet.", "err");
      if (!st.rpcConfigured) return toast("Bridge RPC is not configured, so buy-ins cannot be verified yet.", "err");
    } catch (e) { return toast(e.message || "Bridge status unavailable", "err"); }
    const ok = await confirmTransfer({
      title: "Lock blackjack credits",
      sub: "These credits move into a server-held blackjack table session until you cash out.",
      usd: usd(buyUsd), eth: "approx " + ethApprox(buyUsd) + " ETH",
      from: "Game credits", to: "Blackjack table",
      confirmLabel: "Lock " + usd(buyUsd),
      note: "MetaMask first locks the credits on-chain. The server verifies that transaction before giving table chips.",
    });
    if (!ok) return;
    const btn = $("bj-reload");
    bjBridgeBusy = true; setBtnBusy(btn, "Locking...");
    try {
      const startBody = {
        player: account,
        contract: deployment.address,
        chainId: Number(deployment.chainId),
        buyInWei: buyWei.toString(),
      };
      startBody.signature = await signBjBridge("start", startBody);
      toast("Confirm the blackjack buy-in in MetaMask...");
      const tx = await contract.blackjackBuyIn(buyWei, { gasLimit: await estGas("blackjackBuyIn", [buyWei], null, 160000n) });
      const rcpt = await tx.wait();
      startBody.txHash = rcpt.hash || tx.hash;
      const started = await bridgeJson("/api/bridge/blackjack/start", startBody);
      try {
        if (started && started.session && started.session.id) localStorage.setItem(bjBridgeSessionKey(), started.session.id);
        if (started && started.wsToken) localStorage.setItem(bjBridgeTokenKey(), started.wsToken);
      } catch {}
      const tableUsd = +(started && started.balanceUsd) || buyUsd;
      if (f) { f.removeAttribute("src"); ensureBlackjackReady(); }
      setTimeout(() => { if (f && f.contentWindow) try { f.contentWindow.postMessage({ type: "bj:seed", balance: tableUsd }, "*"); } catch (e) {} }, 250);
      refreshBalances();
      toast("Blackjack credits locked: " + usd(buyUsd), "ok");
    } catch (e) {
      toast(e.message || "Blackjack bridge could not start", "err");
    } finally {
      bjBridgeBusy = false; clearBtnBusy(btn);
    }
  }
  async function bjCashout() {
    if (!account) return toast("Demo blackjack has no wallet cash-out.", "err");
    if (bjBridgeBusy) return;
    if (!ready()) return;
    const ok = await confirmTransfer({
      title: "Cash out blackjack",
      sub: "The server signs your settled table balance, then MetaMask releases the locked credits.",
      usd: "Table balance", eth: "", from: "Blackjack table", to: "Game credits",
      confirmLabel: "Cash out",
      note: "Finish the current hand first. Cash-out is refused while cards or bets are live.",
    });
    if (!ok) return;
    const btn = $("bj-cashout");
    bjBridgeBusy = true; setBtnBusy(btn, "Cashing out...");
    try {
      let sessionId = "";
      try { sessionId = localStorage.getItem(bjBridgeSessionKey()) || ""; } catch {}
      const key = bjSettlementKey(sessionId);
      let s = null;
      try { s = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
      if (!s || !s.signature || String(s.player || "").toLowerCase() !== account.toLowerCase()) {
        const settleBody = { player: account, contract: deployment.address, chainId: Number(deployment.chainId), sessionId };
        settleBody.signature = await signBjBridge("settle", settleBody);
        s = await bridgeJson("/api/bridge/blackjack/settle", settleBody);
        try { localStorage.setItem(key, JSON.stringify(s)); } catch {}
      }
      toast("Confirm the signed settlement in MetaMask...");
      const net = BigInt(s.netWei);
      const tx = await contract.settleBlackjack(account, net, BigInt(s.nonce), s.signature, {
        gasLimit: await estGas("settleBlackjack", [account, net, BigInt(s.nonce), s.signature], null, 220000n),
      });
      await tx.wait();
      try { localStorage.removeItem(key); localStorage.removeItem(bjBridgeSessionKey()); localStorage.removeItem(bjBridgeTokenKey()); } catch {}
      refreshBalances();
      toast("Blackjack settled back to game credits.", "ok");
    } catch (e) {
      toast(e.message || "Blackjack bridge could not cash out", "err");
    } finally {
      bjBridgeBusy = false; clearBtnBusy(btn);
    }
  }
  window.BJ_MUTE = (mute) => bjFramePost(!mute); // hush the iframe's audio when off-channel
  function bjShareLink() { return location.origin + location.pathname + "?game=blackjack" + (bjRoomId ? "&bjtable=" + encodeURIComponent(bjRoomId) : ""); }
  function bjShareTable() {
    const link = bjShareLink();
    const done = () => toast("Table link copied — send it to a friend to sit down with you", "ok");
    try { navigator.clipboard.writeText(link).then(done, () => { window.prompt("Copy this table link:", link); }); }
    catch (e) { window.prompt("Copy this table link:", link); }
  }
  // ---- Blackjack dock (under the TV). The felt emits a compact "bj:dock" state on
  // every render; here we paint native, site-styled controls and post the player's
  // intents back into the iframe as "bj:cmd". ----
  let bjBet = 25, bjBetSig = "";
  let bjHealAt = 0; // throttle for the felt self-heal (re-init a guest-stuck felt after the wallet connects)
  let bjTokenSyncAt = 0; // debounce for refreshing the top token bar from the server while at a token table
  let bjCountTimer = null, bjBetEndAt = 0;
  function paintBjConnectedBalance(state) {
    if (currentGame !== "blackjack" || !account) return;
    const balEl = $("bj-bal");
    if (!balEl) return;
    const tableUsd = state && state.balance != null ? Number(state.balance) : 0;
    const tokenFunded = !!(window.TokenMode && TokenMode.active && TokenMode.active());
    if (tokenFunded) {
      // Token-funded table: the chips ARE your tokens — say so plainly (no "Table"/"Credits" confusion).
      balEl.textContent = "🪙 $" + tableUsd.toLocaleString() + " tokens";
    } else if (tableUsd > 0) balEl.textContent = "💰 Table $" + tableUsd.toLocaleString();
    else balEl.textContent = "💳 Credits " + usd(weiToUsd(gameWei));
    const reload = $("bj-reload");
    if (reload) reload.textContent = tableUsd > 0 ? "Lock more" : "Lock credits";
  }
  function bjStopCount() { if (bjCountTimer) { clearInterval(bjCountTimer); bjCountTimer = null; } }
  function bjPaintCount() {
    const el = $("bj-count"); if (!el) { bjStopCount(); return; }
    const s = Math.max(0, Math.ceil((bjBetEndAt - Date.now()) / 1000));
    el.textContent = "⏱ " + s + " sec"; el.classList.toggle("crit", s <= 3);
    if (bjBetEndAt - Date.now() <= 0) bjStopCount();
  }
  function bjCmd(cmd, extra) { const f = $("bj-frame"); if (f && f.contentWindow) try { f.contentWindow.postMessage(Object.assign({ type: "bj:cmd", cmd }, extra || {}), "*"); } catch (e) {} }
  function bjEth(usd) { const r = ethUsd || 3400; return "≈ Ξ" + (usd / r).toFixed(4); }
  function buildBjBet(ctr, s) {
    if (!(s.betMax >= 10)) {
      const note = document.createElement("div"); note.className = "bj-placed";
      const lbl = document.createElement("div"); lbl.className = "bj-placed-lbl";
      lbl.textContent = account ? "Lock credits before placing a bet." : "Reload chips before placing a bet.";
      note.appendChild(lbl); ctr.appendChild(note); return;
    }
    bjBet = Math.min(Math.max(10, Math.round((s.bet || bjBet) / 5) * 5), s.betMax);
    const wrap = document.createElement("div"); wrap.className = "bj-bet";
    const val = document.createElement("div"); val.className = "bj-bet-val";
    const moneyEl = document.createElement("span"); moneyEl.className = "bj-bet-money";
    const renderVal = () => { moneyEl.innerHTML = '<span class="bj-bv">$' + bjBet.toLocaleString() + "</span>" + (s.showEth ? '<span class="bj-bv-eth">' + bjEth(bjBet) + "</span>" : ""); };
    renderVal(); val.append(moneyEl);
    const slider = document.createElement("input"); slider.type = "range"; slider.className = "bj-slider";
    slider.min = "10"; slider.max = String(s.betMax); slider.step = "5"; slider.value = String(bjBet);
    const fill = () => { const pct = ((bjBet - 10) / Math.max(1, s.betMax - 10)) * 100; slider.style.setProperty("--fill", pct.toFixed(1) + "%"); };
    fill();
    slider.oninput = () => { bjBet = Math.max(10, Math.round(+slider.value / 5) * 5); renderVal(); fill(); bjCmd("setBet", { value: bjBet }); };
    const chips = document.createElement("div"); chips.className = "bj-chips";
    [["$10", 10], ["$25", 25], ["$50", 50], ["$100", 100], ["MAX", s.betMax]].forEach((pair) => {
      const label = pair[0], v = pair[1];
      const b = document.createElement("button"); b.className = "btn btn-ghost bj-chip"; b.textContent = label;
      b.onclick = () => { bjBet = Math.min(s.betMax, Math.max(10, Math.round(v / 5) * 5)); slider.value = bjBet; renderVal(); fill(); bjCmd("setBet", { value: bjBet }); };
      chips.appendChild(b);
    });
    const place = document.createElement("button"); place.className = "btn btn-primary btn-block act-btn bj-place";
    place.innerHTML = '<span class="ab-verb">🃏 PLACE BET</span><span class="ab-amt">Deal me in</span>';
    place.onclick = () => bjCmd("placeBet", { value: bjBet });
    wrap.append(val, slider, chips, place); ctr.appendChild(wrap);
  }
  const BJ_ACT = { hit: ["HIT", "btn-primary"], stand: ["STAND", "bj-stand"], double: ["DOUBLE", "bj-double"], split: ["SPLIT", "bj-split"], surrender: ["SURRENDER", "btn-ghost"] };
  function buildBjActions(ctr, s) {
    const row = document.createElement("div"); row.className = "bj-actions";
    const need = s.needFunds || [];
    ["hit", "stand", "double", "split", "surrender"].forEach((a) => {
      const canDo = (s.legal || []).indexOf(a) >= 0;
      const needTopUp = !account && (a === "double" || a === "split") && need.indexOf(a) >= 0;
      if (!canDo && !needTopUp) return;
      const b = document.createElement("button");
      if (needTopUp) {
        // You can double/split here but don't have the chips to match the bet → offer a top-up.
        b.className = "btn bj-act bj-topup-act";
        b.innerHTML = '💰 TOP&nbsp;UP <span class="bj-tu-sub">to ' + BJ_ACT[a][0] + "</span>";
        b.onclick = () => bjTopUp(a, s, b);
      } else {
        b.className = "btn bj-act " + BJ_ACT[a][1]; b.textContent = BJ_ACT[a][0];
        b.onclick = () => { Array.from(row.children).forEach((c) => (c.disabled = true)); bjCmd("action", { action: a }); };
      }
      row.appendChild(b);
    });
    ctr.appendChild(row);
  }
  // Mid-hand top-up so you can afford a double/split after seeing your cards. Play-money
  // tops up instantly server-side and re-emits the turn (so DOUBLE/SPLIT light up). For a
  // real-money table this is where the on-chain buy-in + MetaMask approval would run (and
  // pause the turn clock) — wired with real-money blackjack.
  function bjTopUp(action, s, btn) {
    const amount = Math.max(500, Math.ceil(s.handBet || 0)); // always enough to cover the matching bet
    if (btn) { btn.disabled = true; btn.innerHTML = "💰 Topping up…"; }
    bjCmd("topUp", { amount: amount });
  }
  function buildBjInsurance(ctr) {
    const row = document.createElement("div"); row.className = "bj-actions";
    const yes = document.createElement("button"); yes.className = "btn btn-primary bj-act"; yes.textContent = "INSURE ½";
    yes.onclick = () => { yes.disabled = no.disabled = true; bjCmd("insurance", { take: true }); };
    const no = document.createElement("button"); no.className = "btn btn-ghost bj-act"; no.textContent = "NO";
    no.onclick = () => { yes.disabled = no.disabled = true; bjCmd("insurance", { take: false }); };
    row.append(yes, no); ctr.appendChild(row);
  }
  function renderBjDock(s) {
    const status = $("bj-status"), ctr = $("bj-controls"); if (!ctr) return;
    // SELF-HEAL: if the wallet is connected but the felt is still on a GUEST / old connection (e.g. it
    // loaded on a page-reload BEFORE the wallet connected, the cause of the stuck "guest:…" + LOCK CREDITS
    // + dead-bridge screen), re-init it so it binds to the account + token session. Throttled so it can't loop.
    try {
      const f0 = $("bj-frame");
      if (account && f0 && f0.getAttribute("src") && !bjFrameMatchesWallet(f0, account) && Date.now() - bjHealAt > 3000) {
        bjHealAt = Date.now();
        const wl = $("bj-wallet"); if (wl) wl.textContent = "🪪 " + short(account);
        f0.removeAttribute("src"); ensureBlackjackReady();
        return;
      }
    } catch (e) {}
    if (status) status.innerHTML = s.msg || "Taking a seat at a live table…";
    // Blackjack's own standalone balance (separate from the demo credits, which are hidden here).
    const balEl = $("bj-bal");
    if (balEl) balEl.textContent = s.balance != null ? "💰 $" + Number(s.balance).toLocaleString() : "";
    if (account) {
      // Token-funded table: the player's chips ARE their token balance (managed by the top token bar).
      // There's no separate "lock credits" / table cash-out — hide those and point at the bar above.
      const tokenFunded = !!(window.TokenMode && TokenMode.active && TokenMode.active());
      const reloadB = $("bj-reload"), cashoutB = $("bj-cashout");
      if (reloadB) reloadB.style.display = tokenFunded ? "none" : "";
      if (cashoutB) cashoutB.style.display = tokenFunded ? "none" : "";
      // LIVE-SYNC the top token bar to your real token balance while at the table, so a hand's win/loss
      // shows there in real time instead of staying frozen until cash-out. We refresh from the AUTHORITATIVE
      // server session (not the felt's display value — so a guest/old felt can never wipe the bar), debounced
      // to ≤ once/1.5s. The on-chain settle is unaffected (it reads the server session directly).
      try {
        const f1 = $("bj-frame");
        if (tokenFunded && f1 && bjFrameMatchesWallet(f1, account) && TokenMode.refreshTokens && Date.now() - bjTokenSyncAt > 1500) {
          bjTokenSyncAt = Date.now();
          TokenMode.refreshTokens();
        }
      } catch (e) {}
      paintBjConnectedBalance(s);
      const tableUsd = s.balance != null ? Number(s.balance) : 0;
      if (status && tableUsd <= 0) {
        status.innerHTML = tokenFunded
          ? "You're playing with your tokens 🪙 — add more or cash out from the bar above ↑"
          : (gameWei > 0n
            ? "Tap <b>Lock credits</b> to move game credits into this table."
            : "Deposit game credits first, then lock them into this table.");
      }
    }
    // countdown: only reset the local timer when it moves by more than a tick, so smoothed
    // jitter from the felt never makes the seconds bounce around.
    if (s.countMsLeft != null && s.countMsLeft > 0) {
      const next = Date.now() + s.countMsLeft;
      if (Math.abs(next - bjBetEndAt) > 900) { bjBetEndAt = next; bjPaintCount(); }
      if (!bjCountTimer) bjCountTimer = setInterval(bjPaintCount, 250);
    } else { bjStopCount(); const cEl = $("bj-count"); if (cEl) cEl.textContent = ""; }
    if (s.mode === "betting") {
      const sig = "bet|" + s.betMax + "|" + (s.showEth ? 1 : 0);
      // Rebuild when the signature changed OR when the dock is empty. On channel RE-ENTRY the
      // felt re-emits the SAME betting sig, but #bj-controls may have been cleared off-channel
      // (the last on-channel emit was a non-betting mode → line below blanked it, or the felt
      // iframe reloaded). Without the !ctr.firstChild check the sig-cache would skip the rebuild
      // and the BET buttons would never come back until a felt reconnect coincidentally changed betMax.
      if (sig !== bjBetSig || !ctr.firstChild) { bjBetSig = sig; ctr.innerHTML = ""; buildBjBet(ctr, s); }
      return;
    }
    bjBetSig = ""; ctr.innerHTML = ""; // turn/insurance rebuild every emit so a rejected action re-enables its buttons
    if (s.mode === "betplaced") buildBjPlaced(ctr, s);
    else if (s.mode === "turn") buildBjActions(ctr, s);
    else if (s.mode === "insurance") buildBjInsurance(ctr);
    // waiting / dealing / settle / spectating → status line only
  }
  // After a bet is locked in (chips are on the table): confirm the amount + a Remove
  // button to take it back before the deal starts.
  function buildBjPlaced(ctr, s) {
    const wrap = document.createElement("div"); wrap.className = "bj-placed";
    const lbl = document.createElement("div"); lbl.className = "bj-placed-lbl";
    lbl.innerHTML = '🃏 Bet locked in <b>$' + Number(s.placed || s.bet).toLocaleString() + "</b> — chips are on the table";
    const rm = document.createElement("button"); rm.className = "btn btn-ghost bj-remove"; rm.textContent = "✕ Remove bet";
    rm.onclick = () => { rm.disabled = true; bjCmd("cancelBet"); };
    wrap.append(lbl, rm); ctr.appendChild(wrap);
  }
  window.addEventListener("message", (e) => {
    const f = $("bj-frame"); if (!f || e.source !== f.contentWindow) return; // only accept dock-state from our felt iframe
    const d = e.data; if (!d) return;
    if (d.type === "bj:ready") { return; } // felt booted — it uses its own standalone $1,000 balance, nothing to seed
    if (d.type !== "bj:dock") return;
    if (d.roomId) { bjRoomId = d.roomId; const sb = $("bj-share"); if (sb) sb.disabled = false; } // enable the Share button once we're at a table
    // unify the balances: the blackjack table balance IS the demo balance (only while
    // on the channel, so playing another game off-channel can't get clobbered).
    // Blackjack balance is standalone (server-held) — it does NOT touch the demo credits.
    if (currentGame === "blackjack") renderBjDock(d);
  });
  // Poker chips are a session-local pool seeded from your in-game balance.
  // Phase 1 (vs house bots) plays out client-side; net results are NOT yet
  // written on-chain — the trusted house-signed settlement lands with the
  // authoritative server in the multiplayer phase.
  let pokerPoolUsd = null;
  function pokerSeedUsd() { return gameWei > 0n ? weiToUsd(gameWei) : 0; }
  function pokerAvailUsd() { return pokerPoolUsd != null ? pokerPoolUsd : pokerSeedUsd(); }
  function initPoker() {
    if (!window.PokerUI) return;
    PokerUI.config({
      getBalanceUsd: pokerAvailUsd,
      onSit: (amt) => { if (pokerPoolUsd == null) pokerPoolUsd = pokerSeedUsd(); pokerPoolUsd = Math.max(0, pokerPoolUsd - amt); },
      onLeave: (amt) => { if (pokerPoolUsd == null) pokerPoolUsd = pokerSeedUsd(); pokerPoolUsd += amt; },
      usd: (n) => usd(n),
      toast: (m, t) => toast(m, t),
    });
    PokerUI.mount();
  }
  function initDice() {
    const t = $("dice-target"); if (!t) return;
    t.oninput = () => diceReadouts();
    // Drag the odds bar itself to set the target (the bar IS the slider now).
    const ob = $("dice-oddsbar");
    if (ob) {
      const lo = +t.min, hi = +t.max;
      const setFromX = (clientX) => {
        const r = ob.getBoundingClientRect(); if (!r.width) return;
        let f = (clientX - r.left) / r.width; f = f < 0 ? 0 : f > 1 ? 1 : f;
        t.value = Math.round(lo + f * (hi - lo)); diceReadouts();
      };
      let dragging = false;
      ob.addEventListener("pointerdown", (e) => { dragging = true; try { ob.setPointerCapture(e.pointerId); } catch (_) {} setFromX(e.clientX); e.preventDefault(); });
      ob.addEventListener("pointermove", (e) => { if (dragging) setFromX(e.clientX); });
      const stop = () => { dragging = false; };
      ob.addEventListener("pointerup", stop); ob.addEventListener("pointercancel", stop);
      ob.addEventListener("keydown", (e) => { // arrow-key nudges for accessibility
        const d = e.key === "ArrowLeft" ? -100 : e.key === "ArrowRight" ? 100 : 0; if (!d) return;
        t.value = Math.max(lo, Math.min(hi, (+t.value) + d)); diceReadouts(); e.preventDefault();
      });
    }
    $("dice-stake").oninput = () => { setSliderUsd("dice-stake"); diceReadouts(); };
    document.querySelectorAll("#dice-mode .side-btn").forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll("#dice-mode .side-btn").forEach((x) => x.classList.toggle("active", x === b));
        diceMode = b.dataset.mode; diceReadouts();
      };
    });
    $("dice-roll-btn").onclick = playDiceClick;
    // Dice #2 controls
    if ($("td-target")) {
      $("td-target").oninput = () => twoDiceReadouts();
      $("td-stake").oninput = () => { setSliderUsd("td-stake"); twoDiceReadouts(); };
      document.querySelectorAll("#td-mode .side-btn").forEach((b) => {
        b.onclick = () => {
          document.querySelectorAll("#td-mode .side-btn").forEach((x) => x.classList.toggle("active", x === b));
          tdMode = b.dataset.mode; twoDiceReadouts();
        };
      });
      $("td-roll-btn").onclick = playTwoDiceClick;
      setSliderUsd("td-stake");
      twoDiceReadouts();
    }
    // Crash controls (CH 11)
    if ($("crash-target")) {
      $("crash-target").oninput = () => crashReadouts();
      $("crash-stake").oninput = () => { setSliderUsd("crash-stake"); crashReadouts(); };
      document.querySelectorAll("#crash-target-presets .qbet").forEach((b) => {
        b.onclick = () => { $("crash-target").value = b.dataset.target; crashReadouts(); };
      });
      $("crash-launch").onclick = playCrashClick;
      setSliderUsd("crash-stake");
      crashReadouts();
    }
    // Gem Vault paytable / free-spins explainer
    { const b = $("s3d-help-btn"); if (b) b.onclick = openSlots3dHelp; }
    { const c = $("s3d-help-close"); if (c) c.onclick = () => $("s3d-help-modal").classList.add("hidden"); }
    { const m = $("s3d-help-modal"); if (m) m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); }); }
    document.querySelectorAll("#game-nav .game-card").forEach((b) => { b.onclick = () => switchGame(b.dataset.game); });
    // keyboard: ←/→ to cycle channels through every game. SPACE is swallowed here
    // too (belt-and-suspenders) so a focused nav card can never switch on Space —
    // the global SPACE→bet handler routes it to the live game instead.
    $("game-nav").addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); return; }
      const i = GAME_ORDER.indexOf(currentGame);
      if (i < 0) return; // unknown/hidden channel (e.g. poker) → don't snap to flip
      if (e.key === "ArrowLeft") switchGame(GAME_ORDER[Math.max(0, i - 1)]);
      else if (e.key === "ArrowRight") switchGame(GAME_ORDER[Math.min(GAME_ORDER.length - 1, i + 1)]);
    });
    setSliderUsd("dice-stake");
    diceReadouts();
    initPoker();
    // restore the last-played game silently (no CRT animation on load)
    let saved = "flip"; try { saved = localStorage.getItem("ctf_game") || "flip"; } catch {}
    if (saved === "swoop") saved = "flip"; // Sky Swoop hidden for now — don't restore onto it
    // A shared link (?game=blackjack[&bjtable=…]) drops you straight onto that channel/table.
    try {
      const qp = new URLSearchParams(location.search);
      const qg = qp.get("game");
      if (qg === "slots") saved = "slots3d";
      else if (qg && GAME_CHANNEL[qg]) saved = qg;
      else if (qp.get("bjtable")) saved = "blackjack";
    } catch (e) {}
    if (saved === "slots") saved = "slots3d";
    if (!GAME_CHANNEL[saved]) saved = "flip";
    currentGame = saved;
    paintGameTabs(saved);
    if (saved === "poker" && window.PokerUI) PokerUI.show();
    if (window.TV) TV._activeChannel = GAME_CHANNEL[saved] || 8;
    if (saved === "crash" && window.TV && TV._crashIdle) { try { TV._crashIdle(); } catch (e) {} }
    // Balloon Pop needs its engine built + activated on reload too (enterDemo,
    // which runs just after, flips it to enabled once it exists).
    if (saved === "pressure") ensurePressureReady();
    // Plane (CH 14) is lazy-loaded too — build it on reload so the TV shows the
    // game instead of an empty black layer once the promo intro ends.
    if (saved === "plane") ensurePlaneReady();
    if (saved === "slots3d") ensureSlots3dReady();
    // Reef Raiders (CH 17) is lazy-loaded too. WITHOUT this branch a manual page
    // refresh on the fish channel never calls ensureFishReady(), so the canvas is
    // never built and the loading screen hangs forever — the only recovery was
    // switching channels and back. THIS is the "reef stuck on loading after refresh" bug.
    if (saved === "fish") ensureFishReady();
    if (saved === "swoop") ensureSwoopReady(); // build the PlayCanvas biplane on reload too
    if (saved === "fishshooter") ensureFishShooterReady(); // build the Fish Shooter on reload too
    if (saved === "flip") ensureCoinFlip3dReady(); // build the 3D coin on reload too
    if (saved === "dice") ensureDice3dReady();     // build the 0-100 neon rail on reload too
    if (saved === "twodice") ensureDice2_3dReady(); // build the 3D dice on reload too
    if (saved === "blackjack") { document.body.classList.add("bj-channel"); { const wl = $("bj-wallet"); if (wl) wl.textContent = "🪪 " + short(account || bjGuestId()); } ensureBlackjackReady(); if (window.TV && TV._blackjackIdle) try { TV._blackjackIdle(); } catch (e) {} } // restore + show the CH 16 felt on reload (hide demo credits, show table wallet)
  }

  // My open tables: show bank + idle countdown, auto-close (refund) when stale.
  async function refreshMyTables() {
    if (!read || !chainOK || !account) return;
    try {
      const all = await read.getOpenHostRooms();
      const mine = all.filter((t) => eq(t.creator, account));
      const card = $("my-tables-card"), list = $("my-tables-list");
      $("my-tables-count").textContent = mine.length;
      card.classList.toggle("hidden", mine.length === 0);
      list.innerHTML = "";
      const nowSec = Math.floor(Date.now() / 1000);
      for (const t of mine) {
        const id = t.id.toString();
        const left = Math.max(0, 300 - (nowSec - Number(t.lastActivity)));
        if (left === 0) autoCloseTable(id); // idle 5 min → reclaim the bank
        const li = document.createElement("li");
        li.className = "room-item";
        const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
        li.innerHTML =
          `<div class="rinfo"><div class="rname">${escapeHtml(t.name)}</div>` +
          `<div class="rmeta">#${id} · bank ${usdOf(t.bank)} · ${t.gamesPlayed} plays · auto-close ${mm}:${ss}</div></div>`;
        const copy = document.createElement("button");
        copy.className = "btn btn-ghost";
        copy.textContent = "Copy link";
        copy.onclick = () => navigator.clipboard?.writeText(hostUrlFor(id)).then(() => toast("Table link copied!", "ok"), () => {});
        li.appendChild(copy);
        const btn = document.createElement("button");
        btn.className = "btn btn-ghost";
        btn.textContent = "Close & refund";
        btn.onclick = () => closeTable(id);
        li.appendChild(btn);
        list.appendChild(li);
      }
    } catch (e) {}
  }

  async function autoCloseTable(id) {
    if (closingTables.has(id)) return;
    closingTables.add(id);
    try {
      const tx = await contract.closeHostRoom(id, { gasLimit: await estGas("closeHostRoom", [id], null, 130000n) });
      await tx.wait();
      toast("Idle table closed — bank refunded to your balance.", "ok");
      refreshBalances(); refreshMyTables();
    } catch (e) { /* someone else may have closed it already */ }
    finally { closingTables.delete(id); }
  }

  async function closeTable(id) {
    if (!ready()) return;
    try {
      toast("Closing the table… confirm in MetaMask");
      const tx = await contract.closeHostRoom(id, { gasLimit: await estGas("closeHostRoom", [id], null, 130000n) });
      await tx.wait();
      toast("Table closed — bank refunded.", "ok");
      refreshBalances(); refreshMyTables();
    } catch (e) { txErr(e); }
  }

  // Sliders run in USD; the ETH amount is computed from the live price. Bets are
  // capped at $500 (keeps house variance sane); deposits are bounded only by the
  // wallet balance.
  const HARD_MAX_USD = 100; // per-game bet ceiling. betCapUsd() = min(read.maxBet≈$500, HARD_MAX_USD), so this
                            // caps every bet slider at $100 client-side with no contract change (on-chain $500
                            // limit becomes an unreachable no-op).
  const DEPOSIT_MAX_USD = 100000;
  function betCapUsd() {
    const m = (maxBet && maxBet > 0n) ? Math.floor(weiToUsd(maxBet)) : HARD_MAX_USD;
    return Math.max(10, Math.min(HARD_MAX_USD, m));
  }
  function setupSliders() {
    const cap = betCapUsd();
    for (const id of ["house-bet", "bet-input", "deposit-input", "host-bank"]) {
      const s = $(id);
      if (!s) continue;
      // Deposits aren't bounded by maxBet, but are bounded by the wallet balance.
      s.min = "10"; s.max = String(id === "deposit-input" ? depositCapUsd() : cap); s.step = "5";
      if (+s.value < 10) s.value = id === "deposit-input" ? "50" : id === "host-bank" ? "100" : "25";
      setSliderUsd(id);
    }
  }
  function setupHouseSlider() { setupSliders(); }

  // ---------------------------------------------------------- bet modal + negotiation
  let pendingBet = null;        // { kind, id?, room?, bet (BigInt) }
  let pendingProposal = null;   // host side: { roomId, amount, proposer }
  let myProposal = null;        // joiner side: { id, amount }

  function breakdown(bet) {
    const pot = bet * 2n;
    const fee = (pot * 300n) / 10000n; // 3% house fee — matches the contract (HOUSE_FEE_BPS=300) and flipReveal()
    return { pot, fee, win: pot - fee };
  }

  function openBetModal(opts) {
    pendingBet = opts;
    const isJoin = opts.kind === "join";
    $("bet-modal-title").textContent = isJoin ? "Join room #" + opts.id : "Flip vs House";
    $("bd-opplabel").textContent = isJoin ? "Host's bet" : "House matches";
    const raise = $("bet-raise");
    if (isJoin) {
      raise.classList.remove("hidden");
      const s = $("join-bet");
      const minUsd = Math.max(10, Math.round(weiToUsd(opts.room.betAmount))); // host's bet in $
      s.min = String(minUsd); s.max = String(Math.max(minUsd, betCapUsd())); s.step = "5";
      s.value = String(minUsd);
      $("join-bet-val").textContent = usd(minUsd);
    } else {
      raise.classList.add("hidden");
    }
    // Show which side you're on. Joiners get the opposite of the host's pick.
    const sideEl = $("bet-side");
    let yourHeads = null;
    if (isJoin) yourHeads = !opts.room.creatorHeads;
    else if (opts.kind === "house") yourHeads = opts.heads;
    if (yourHeads === null) { sideEl.classList.add("hidden"); }
    else {
      sideEl.textContent = "Your side: " + (yourHeads ? "Ξ HEADS" : "★ TAILS") +
        (isJoin ? " — host took " + (opts.room.creatorHeads ? "heads" : "tails") : "");
      sideEl.classList.remove("hidden");
    }
    updateBetModalAmount(opts.bet);
    $("bet-modal").classList.remove("hidden");
  }
  function closeBetModal() { $("bet-modal").classList.add("hidden"); }

  function updateBetModalAmount(bet) {
    if (!pendingBet) return;
    pendingBet.bet = bet;
    const { pot, fee, win } = breakdown(bet);
    $("bd-yourbet").textContent = usdOf(bet);
    $("bd-oppbet").textContent = usdOf(bet);
    $("bd-pot").textContent = usdOf(pot);
    $("bd-fee").textContent = usdOf(fee);
    $("bd-win").textContent = usdOf(win);
    const raised = pendingBet.kind === "join" && bet > pendingBet.room.betAmount;
    $("bet-accept").textContent = raised ? "📨 Propose bet to host" : "✓ Accept bet & flip";
    $("bet-hint").textContent = raised
      ? "Above the host's bet — they must approve before the flip."
      : pendingBet.kind === "join"
      ? "Matches the host's bet — flips immediately."
      : "";
  }

  function acceptBet() {
    const p = pendingBet;
    closeBetModal();
    if (!p) return;
    if (p.kind === "house") return doPlayHouse(p.bet, p.heads);
    if (p.bet > p.room.betAmount) return proposeBet(p.id, p.room, p.bet);
    doJoinRoom(p.id, p.room, p.bet);
  }

  // --- joiner proposes a higher bet; host approves/denies over the socket ---
  function proposeBet(id, room, amount) {
    myProposal = { id: String(id), amount: amount.toString(), room: room };
    toast("Proposed " + usdOf(amount) + " to the host — waiting…");
    wsSend({ type: "bet-proposal", roomId: String(id), amount: amount.toString() });
  }

  async function handleProposal(d) {
    try {
      const r = await read.getRoom(d.roomId);
      if (!eq(r.creator, account) || Number(r.status) !== 0) return; // not my room / not open
      pendingProposal = { roomId: String(d.roomId), amount: BigInt(d.amount), proposer: d.from };
      $("nego-text").innerHTML =
        escapeHtml(short(d.from)) + " wants to bet <b>" + usdOf(BigInt(d.amount)) +
        "</b> (your room is " + usdOf(r.betAmount) + "). Accept to raise the stake for both of you.";
      $("nego-modal").classList.remove("hidden");
    } catch (e) { console.error(e); }
  }

  async function negoAccept() {
    const p = pendingProposal;
    $("nego-modal").classList.add("hidden");
    if (!p) return;
    try {
      toast("Raising the room bet… confirm in MetaMask");
      const tx = await contract.updateRoomBet(p.roomId, p.amount, { gasLimit: await estGas("updateRoomBet", [p.roomId, p.amount], null, 300000n) });
      await tx.wait();
      refreshBalances(); refreshRooms();
      wsSend({ type: "bet-response", roomId: p.roomId, amount: p.amount.toString(), accepted: true, to: p.proposer });
      toast("Bet raised — waiting for them to join", "ok");
    } catch (e) {
      wsSend({ type: "bet-response", roomId: p.roomId, amount: p.amount.toString(), accepted: false, to: p.proposer });
      txErr(e);
    }
    pendingProposal = null;
  }
  function negoDeny() {
    const p = pendingProposal;
    $("nego-modal").classList.add("hidden");
    if (!p) return;
    wsSend({ type: "bet-response", roomId: p.roomId, amount: p.amount.toString(), accepted: false, to: p.proposer });
    toast("Denied — they can propose a different amount");
    pendingProposal = null;
  }

  function handleProposalResponse(d) {
    if (!eq(d.to, account) || !myProposal || myProposal.id !== String(d.roomId)) return;
    // NEVER trust the relayed `amount`/identity — a forged bet-response could drive
    // us to auto-join at an attacker-chosen stake. Use OUR own proposed amount, and
    // only act if the response truly came from the room's on-chain creator.
    const amount = BigInt(myProposal.amount);
    read.getRoom(d.roomId).then((r) => {
      if (!eq(d.from, r.creator)) return; // only the table's creator can accept/deny
      if (d.accepted) {
        if (Number(r.status) !== 0) { toast("That table is no longer open", "err"); myProposal = null; return; }
        toast("Host accepted! Joining at " + usdOf(amount) + "…", "ok");
        doJoinRoom(String(d.roomId), r, amount);
      } else {
        toast("Host denied — pick another amount and propose again", "err");
        if (Number(r.status) === 0) joinRoom(String(d.roomId), r);
      }
      myProposal = null;
    }).catch(() => {});
  }

  // ---------------------------------------------------------- TV reveal reconciler
  let lastRevealed = null;
  async function reconcile() {
    if (!activeRoomId || !read || !chainOK) return;
    try {
      const r = await read.getRoom(activeRoomId);
      const status = Number(r.status);
      // Only ever reveal a game I'm actually in. If I lost a join race, my
      // activeRoomId may briefly point at someone else's flipping room — never
      // show a false WIN/LOSE for that.
      const mine = eq(r.player1, account) || eq(r.player2, account);
      if (status === 2 && mine && lastRevealed !== activeRoomId) {
        lastRevealed = activeRoomId;
        const side = r.headsWon ? "HEADS" : "TAILS";
        const youWon = eq(r.winner, account);
        const rv = flipReveal(r.betAmount, youWon);
        setLastResult({ won: youWon, side, amountUsd: rv.amountUsd, amountWei: rv.amountWei, betWei: r.betAmount, label: r.isHouseGame ? "vs House" : "PvP" });
        playOutcome({ won: youWon, netUsd: weiToUsd(rv.netWei), betUsd: weiToUsd(r.betAmount), side });
        TV.revealResult({
          side,
          youWon,
          role: "participant",
          picked: youWon ? side : (side === "HEADS" ? "TAILS" : "HEADS"), // your side won iff you won
          amountUsd: youWon ? weiToUsd(rv.netWei) : rv.amountUsd,
          tier: rv.tier,
          sub: youWon ? "YOU WON! Net profit shown — your stake came back too (3% to house)" : "You lost your stake — the pot went to the other side",
        });
        activeRoomId = null;
        refreshBalances(); refreshHouse(); refreshStats(); refreshRooms(); refreshPlayers(); refreshMyHistory();
      } else if ((status === 2 && !mine) || status === 3) {
        // settled room I'm not in, or cancelled → drop it silently, no reveal
        activeRoomId = null;
        if (TV._phase === "flip" || TV._phase === "countdown" || TV._phase === "tuning") {
          TV.idle("Deposit ETH, then create or join a room");
        }
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------- chat (Matrix terminal)
  function agoLabel(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function renderChatLine(from, text, ts, name) {
    const log = $("chat-log");
    const isHost = hostTreasury && eq(from, hostTreasury);
    const sys = log.querySelector(".chat-sys");
    if (sys) sys.remove();
    const line = document.createElement("div");
    line.className = "chat-line " + (isHost ? "host" : "visitor");
    const label = (name && String(name).trim()) ? String(name).trim() : short(from);
    const h = document.createElement("span");
    h.className = "chat-handle";
    h.textContent = label + (isHost ? "(host)" : "");
    // reveal/copy the real address (display names aren't unique)
    const rev = document.createElement("button");
    rev.type = "button"; rev.className = "chat-reveal"; rev.title = "Show address";
    rev.textContent = "👁";
    rev.onclick = () => { rev.replaceWith(document.createTextNode(" " + short(from))); try { navigator.clipboard && navigator.clipboard.writeText(from); } catch {} };
    const colon = document.createElement("span"); colon.className = "chat-handle"; colon.textContent = ":";
    const t = document.createElement("span");
    t.className = "chat-text selectable"; // long-press copy on mobile (selectstart exempts .selectable)
    t.textContent = " " + text;
    line.appendChild(h); line.appendChild(rev); line.appendChild(colon); line.appendChild(t);
    if (ts) { const a = document.createElement("span"); a.className = "chat-ago"; a.textContent = " " + agoLabel(ts); line.appendChild(a); }
    log.appendChild(line);
    while (log.children.length > 80) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
  // Replay the server's recent chat buffer when we (re)connect, so the
  // conversation is already loaded — and a host sees what players said while away.
  let chatHistoryLoaded = false;
  function renderChatHistory(messages) {
    if (chatHistoryLoaded || !Array.isArray(messages) || !messages.length) return;
    chatHistoryLoaded = true;
    const log = $("chat-log");
    const sys = log.querySelector(".chat-sys");
    if (sys) sys.remove();
    const div = document.createElement("div");
    div.className = "chat-divider";
    div.textContent = "— recent chat —";
    log.appendChild(div);
    for (const m of messages.slice(-60)) renderChatLine(m.from, m.text, m.ts, m.name);
  }
  function sendChat() {
    const inp = $("chat-input");
    const text = inp.value.trim();
    if (!text) return;
    // Real wallets chat as their profile name; demo players chat as a guest.
    const myName = account ? ((window.Profile) ? Profile.name(account) : "") : ("Guest " + bjGuestId().slice(6, 10));
    wsSend({ type: "chat", text: text, name: myName || undefined });
    inp.value = "";
  }
  // ---- chat unread badges (tab + top-bar 💬 + bottom-nav) and the blackjack pulse ----
  let chatUnread = 0;
  function renderChatBadges() {
    const show = chatUnread > 0, label = chatUnread > 99 ? "99+" : String(chatUnread);
    ["chat-tab-badge", "chat-toggle-badge", "bn-chat-badge"].forEach((id) => { const b = $(id); if (b) { b.textContent = label; b.classList.toggle("hidden", !show); } });
  }
  function clearChatUnread() { chatUnread = 0; renderChatBadges(); const tab = $("chat-tab"); if (tab) tab.classList.remove("pulsing"); }
  function bumpChatUnread() {
    if (document.body.classList.contains("chat-open")) return; // drawer open ⇒ already reading
    chatUnread++; renderChatBadges();
    if (currentGame === "blackjack") { const tab = $("chat-tab"); if (tab) { tab.classList.remove("pulsing"); void tab.offsetWidth; tab.classList.add("pulsing"); } }
  }
  function openChat() {
    document.body.classList.add("chat-open"); clearChatUnread();
    const ta = $("chat-tab"); if (ta) ta.setAttribute("aria-expanded", "true");
    const inp = $("chat-input"); if (inp) setTimeout(() => inp.focus(), 350);
  }

  // ---------------------------------------------------------- player profile
  // The wallet whose profile the modal is showing: your own (editable), or another player's
  // (read-only) when you click them in Players & Records. The house sees extra on-chain diagnostics.
  let profileAddr = null;
  async function openProfile(viewAddr) {
    const addr = (typeof viewAddr === "string" && /^0x[0-9a-fA-F]{40}$/.test(viewAddr)) ? E.getAddress(viewAddr) : account;
    if (!addr) return toast("Connect a wallet first", "err");
    const pm = $("profile-modal"); if (!pm) return;
    profileAddr = addr;
    const mine = !!(account && eq(addr, account));
    const p = window.Profile ? Profile.load(addr) : {};
    const nameEl = $("profile-name");
    if (nameEl) { nameEl.value = p.name || ""; nameEl.readOnly = !mine; nameEl.placeholder = mine ? "Display name" : (p.name || "Unnamed player"); }
    // Bio is browser-local, so another player's is unknown — hide the field entirely when viewing them.
    if ($("profile-bio")) { $("profile-bio").value = mine ? (p.bio || "") : ""; $("profile-bio").style.display = mine ? "" : "none"; }
    if ($("profile-addr-short")) $("profile-addr-short").textContent = short(addr);
    try { if ($("profile-avatar")) blockies(addr, 8, 8, $("profile-avatar")); } catch {}
    { const sv = $("profile-save"); if (sv) sv.style.display = mine ? "" : "none"; }
    { const nt = pm.querySelector(".profile-note"); if (nt) nt.style.display = mine ? "" : "none"; }
    { const rv = $("profile-addr-reveal"); if (rv) rv.style.display = mine ? "" : "none"; } // copy is for your own address
    pm.classList.remove("hidden");
    renderProfileStats();
    renderHouseDiag(addr, mine);
  }
  function saveProfile() {
    if (!account || !window.Profile) return;
    if (profileAddr && !eq(profileAddr, account)) return; // never overwrite another player's profile
    const name = ($("profile-name") ? $("profile-name").value : "").slice(0, 24).trim();
    const bio = ($("profile-bio") ? $("profile-bio").value : "").slice(0, 160).trim();
    Profile.save(account, { name, bio });
    toast("Profile saved ✓", "ok");
  }
  function netStr(wei) { return (wei < 0n ? "-" : "+") + usdOf(wei < 0n ? -wei : wei); }
  async function renderProfileStats() {
    const box = $("profile-stats"), hist = $("profile-history");
    if (!box || !window.Profile) return;
    const addr = profileAddr || account;
    const mine = !!(account && eq(addr, account));
    box.innerHTML = '<p class="muted">Loading ' + (mine ? "your" : "their") + ' stats…</p>';
    let rooms = [], dice = [], twoDice = [];
    try { [rooms, dice, twoDice] = await Promise.all([
      recentRooms(2000).catch(() => []), recentDice(2000).catch(() => []), recentTwoDice(2000).catch(() => []),
    ]); } catch {}
    const s = Profile.computeStats(addr, { rooms, dice, twoDice }, eq);
    const since = s.memberSinceSec ? new Date(s.memberSinceSec * 1000).toLocaleDateString() : "—";
    const cell = (k, v) => '<div class="ps-cell"><span class="ps-k muted">' + k + '</span><strong class="ps-v">' + v + "</strong></div>";
    box.innerHTML =
      cell("Games played", s.played) +
      cell("Win rate", s.played ? (s.winRate * 100).toFixed(0) + "%" : "—") +
      cell("Wins / Losses", s.wins + " / " + s.losses) +
      cell("Total wagered", usdOf(s.wageredWei)) +
      cell("Biggest win", s.biggestWinWei > 0n ? usdOf(s.biggestWinWei) : "—") +
      cell("Net result", netStr(s.netWei)) +
      cell("Favorite game", s.favoriteGameLabel) +
      cell("Member since", since);
    if (hist) {
      if (!s.history.length) { hist.innerHTML = '<p class="muted">No games yet — go play a channel!</p>'; }
      else {
        const lbl = (window.Profile && Profile.GAMES) || {};
        hist.innerHTML = s.history.map((h) =>
          '<div class="ph-row ' + (h.won ? "win" : "lose") + '"><span class="ph-game">' + (lbl[h.game] || h.game) +
          '</span><span class="ph-net">' + netStr(h.net) + "</span></div>").join("");
      }
    }
  }

  // HOUSE-ONLY diagnostics panel inside the profile modal: the owner clicks a player and sees their
  // live on-chain token state (locked principal, open-session tokens / buy-in / unrealized P&L) plus a
  // one-tap "Release stuck funds" when they have an orphaned lock and no active session. Lets the owner
  // unstick a player who reports trapped funds — settleBlackjack always returns to the PLAYER, so this
  // can never move funds to the house.
  async function renderHouseDiag(addr, mine) {
    const box = $("profile-house"); if (!box) return;
    const isHouse = account && hostTreasury && eq(account, hostTreasury);
    if (!isHouse || mine || !window.TokenMode || !TokenMode.adminPlayerInfo) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    box.classList.remove("hidden");
    box.innerHTML = '<h3 class="profile-h3">🏦 House view</h3><p class="muted">Reading on-chain token state…</p>';
    let info = null;
    try { info = await TokenMode.adminPlayerInfo(addr); }
    catch (e) { box.innerHTML = '<h3 class="profile-h3">🏦 House view</h3><p class="muted">Couldn\'t read on-chain state — ' + ((e && e.message) || "error") + "</p>"; return; }
    if (profileAddr !== addr) return; // the modal moved on while we awaited
    const usd = (n) => "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString();
    const row = (k, v, cls) => '<div class="hd-row"><span class="muted">' + k + '</span><strong' + (cls ? ' class="' + cls + '"' : "") + ">" + v + "</strong></div>";
    let html = '<h3 class="profile-h3">🏦 House view</h3>';
    html += row("Locked on-chain", usd(info.lockedUsd), info.lockedUsd > 0 ? "warn" : "");
    if (info.hasOpenSession && info.session) {
      const pnl = info.session.unrealizedUnits;
      html += row("Active session", "yes · " + usd(info.session.tokens) + " tokens");
      html += row("Buy-in", usd(info.session.buyInUnits));
      html += row("Unrealized P&L", (pnl >= 0 ? "+" : "−") + usd(Math.abs(pnl)).slice(1), pnl >= 0 ? "up" : "down");
      html += '<p class="muted hd-note">Player is in a live game — they cash out themselves. Nothing to release.</p>';
    } else {
      html += row("Active session", "none");
    }
    if (info.strandedUsd > 0 && !info.hasOpenSession) {
      html += '<p class="muted hd-note">' + usd(info.strandedUsd) + ' is locked with no active session — you can release it back to this player.</p>';
      html += '<button id="hd-release-btn" class="btn btn-primary btn-block">🔓 Release ' + usd(info.strandedUsd) + " to player</button>";
    }
    box.innerHTML = html;
    const rb = $("hd-release-btn");
    if (rb) rb.onclick = async function () {
      rb.disabled = true; rb.textContent = "Confirm in your wallet…";
      try { await TokenMode.adminRelease(addr); toast("Released to player ✓", "ok"); await renderHouseDiag(addr, mine); }
      catch (e) { rb.disabled = false; rb.textContent = "🔓 Release to player"; }
    };
  }

  async function cancelRoom(id) {
    try {
      const tx = await contract.cancelRoom(id);
      await tx.wait();
      toast("Room cancelled, bet refunded", "ok");
      if (activeRoomId === id) { activeRoomId = null; TV.idle(); }
      refreshBalances(); refreshRooms();
      wsSend({ type: "rooms-updated", roomId: id });
    } catch (e) { txErr(e); }
  }

  const FRIENDLY_ERR = {
    InsufficientBalance: "Not enough in-game balance — deposit ETH first (panel under the TV).",
    BetTooHigh: "That bet is above the maximum allowed.",
    BetIsZero: "Enter a bet greater than zero.",
    HouseBankrollLow: "The house can't cover that bet right now — try a smaller stake.",
    RoomNotOpen: "That room is no longer open.",
    CannotJoinOwnRoom: "You can't join your own room.",
    NotRoomCreator: "Only the room creator can do that.",
    NothingToWithdraw: "Nothing to withdraw yet.",
    UnknownRoom: "That room doesn't exist.",
    HostRoomNotOpen: "That table is closed.",
    CannotPlayOwnTable: "You can't play against your own table.",
    BankTooLow: "The table's bank can't cover that bet right now — another player may have just taken some. Try a smaller stake.",
    HostRoomStillActive: "That table is still active — only the host can close it before it's been idle 5 minutes.",
    BetTooSmall: "That bet is below the minimum allowed.",
    DiceBadTarget: "Pick a different target for this bet type.",
    DiceEdgeTooHigh: "That target isn't offered (it would pay below your stake) — pick another.",
    TooManyOpen: "You have too many open rooms — finish or cancel one first.",
    TransferFailed: "The ETH transfer failed — please try again.",
  };
  function txErr(e) {
    console.error(e);
    // Prefer an exact custom-error name from the decoded revert before any
    // fuzzy substring matching (which can mismap unrelated messages).
    if (e?.revert?.name && FRIENDLY_ERR[e.revert.name]) return toast(FRIENDLY_ERR[e.revert.name], "err");
    const blob = [e?.revert?.name, e?.shortMessage, e?.reason, e?.info?.error?.message, e?.message]
      .filter(Boolean)
      .join(" ");
    for (const k of Object.keys(FRIENDLY_ERR)) if (blob.includes(k)) return toast(FRIENDLY_ERR[k], "err");
    if (e?.code === "ACTION_REJECTED" || /user (rejected|denied)/i.test(blob))
      return toast("You cancelled the transaction.", "err");
    if (/could not coalesce|missing response|timeout|SERVER_ERROR|failed to fetch/i.test(blob))
      return toast("Sepolia network hiccup (the public test RPC is flaky) — just click Deploy again.", "err");
    if (/insufficient funds|gas required exceeds|intrinsic gas/i.test(blob))
      return toast("Not enough test ETH for gas. Top up Sepolia ETH from a faucet and retry.", "err");
    if (/execution reverted|unknown custom error|CALL_EXCEPTION|revert/i.test(blob))
      return toast("The contract rejected that — most often you need to Deposit ETH into the game first (or the amount is over the limit).", "err");
    const m = e?.shortMessage || e?.reason || e?.message || "Transaction failed";
    toast(m.length > 90 ? m.slice(0, 90) + "…" : m, "err");
  }
  function safeParse(log) { try { return contract.interface.parseLog(log); } catch { return null; } }

  // ---------------------------------------------------------- share link
  function shareUrlFor(id) {
    let base = shareBase();
    const q = new URLSearchParams();
    if (deployment.address) q.set("contract", deployment.address);
    if (deployment.chainId) q.set("chain", String(deployment.chainId));
    if (account) q.set("ref", account); // your invite attribution
    if (id != null) q.set("room", String(id));
    const qs = q.toString();
    return qs ? base + "?" + qs : base;
  }

  // ---- Live wins feed (from the on-chain room scan) ----
  function renderFeed(rooms) {
    const list = $("feed-list"); if (!list) return;
    const rows = [];
    for (const r of rooms) {
      if (Number(r.status) !== 2) continue; // settled only
      const bet = r.betAmount, bd = breakdown(bet), netWin = bd.win - bet;
      let who, won, amt;
      if (r.isHouseGame) {
        won = eq(r.winner, r.player1);
        who = eq(account, r.player1) ? "you" : short(r.player1);
        amt = won ? netWin : bet;
      } else {
        won = true; who = eq(account, r.winner) ? "you" : short(r.winner); amt = netWin;
      }
      rows.push({ who, won, amt });
      if (rows.length >= 16) break;
    }
    if (!rows.length) { list.innerHTML = '<li class="empty">Recent flips will scroll here.</li>'; return; }
    list.innerHTML = rows.map((x) =>
      `<li class="feed-item ${x.won ? "win" : "loss"}"><span class="feed-who">${x.who}</span>` +
      `<span class="feed-res">${x.won ? "won" : "lost"}</span>` +
      `<span class="feed-amt ${x.won ? "up" : "down"}">${x.won ? "+" : "−"}${usdOf(x.amt)}</span></li>`
    ).join("");
  }

  // ---- Daily streak (per account, UTC day) ----
  function checkDailyStreak() {
    if (!account) return;
    const card = $("progress-card"); if (card) card.hidden = false;
    let st = {};
    try { st = JSON.parse(localStorage.getItem("coinflip_daily_" + account) || "{}"); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    if (st.last !== today) {
      const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      st.streak = st.last === yest ? (st.streak || 0) + 1 : 1;
      st.last = today; st.best = Math.max(st.best || 0, st.streak);
      try { localStorage.setItem("coinflip_daily_" + account, JSON.stringify(st)); } catch {}
    }
    const pill = $("daily-streak-pill"); if (pill) pill.textContent = "Day " + (st.streak || 1) + " 🔥";
    const note = $("daily-streak-note");
    if (note) note.textContent = "Checked in " + (st.streak || 1) + " day" + ((st.streak || 1) === 1 ? "" : "s") + " in a row · best " + (st.best || 1) + ".";
  }

  // ---- Achievements (cosmetic, from on-chain stats + best win) ----
  function renderAchievements() {
    const grid = $("achievements-grid"); if (!grid || !account) return;
    const st = playerStats[account.toLowerCase()] || { w: 0, l: 0, recent: [] };
    const games = st.w + st.l, best = winStreaks(st.recent).best;
    const defs = [
      { ic: "🎬", nm: "First Flip", got: games >= 1 },
      { ic: "✅", nm: "First Win", got: st.w >= 1 },
      { ic: "🎯", nm: "10 Games", got: games >= 10 },
      { ic: "🏟️", nm: "50 Games", got: games >= 50 },
      { ic: "🔥", nm: "3 Streak", got: best >= 3 },
      { ic: "⚡", nm: "5 Streak", got: best >= 5 },
      { ic: "💰", nm: "$100 Win", got: myBestNetUsd >= 100 },
      { ic: "💎", nm: "$300 Win", got: myBestNetUsd >= 300 },
    ];
    grid.innerHTML = defs.map((d) =>
      `<div class="ach ${d.got ? "got" : "locked"}" title="${d.nm}${d.got ? " ✓" : " (locked)"}"><span class="ach-ic">${d.ic}</span><span class="ach-nm">${d.nm}</span></div>`
    ).join("");
  }

  function renderInvite() {
    const inp = $("invite-link"); if (inp) inp.value = shareUrlFor(null);
    const by = $("invited-by");
    if (by) by.textContent = REF && (!account || !eq(REF, account)) ? "🎟️ Invited by " + short(REF) : "";
  }

  // hotkey helpers
  function setHotSide(heads) {
    const btn = document.querySelector('#house-side .side-btn[data-heads="' + (heads ? "1" : "0") + '"]');
    if (btn) btn.click();
  }
  function stepHouseBet(delta) {
    const s = $("house-bet"); if (!s) return;
    s.value = String(Math.max(+s.min, Math.min(+s.max, (+s.value || 0) + delta)));
    if (typeof setSliderUsd === "function") setSliderUsd("house-bet");
  }
  function showShareLink(id) {
    $("share-box").classList.remove("hidden");
    $("share-link").value = shareUrlFor(id);
  }
  async function handleInvite() {
    try {
      const r = await read.getRoom(inviteRoomId);
      if (!r || r.id.toString() === "0") return;
      if (Number(r.status) !== 0) { toast("That room is no longer open", "err"); return; }
      if (eq(r.creator, account)) { showShareLink(inviteRoomId); return; }
      banner("");
      toast("You were invited to room #" + inviteRoomId + " — review & accept the bet", "ok");
      // Open the bet-confirmation modal directly (it has its own Accept step).
      joinRoom(String(inviteRoomId), r);
    } catch (e) { console.error(e); }
  }

  // ---------------------------------------------------------- contract events
  function wireEvents() {
    try { read.removeAllListeners(); } catch {} // bind exactly once per read instance
    read.on(read.filters.PlayerJoined(), (roomId) => {
      const id = roomId.toString();
      refreshRooms();
      if (activeRoomId === id) {
        // someone joined MY open room -> start the broadcast for me
        lockReveal();
        read.getRoom(id).then((r) => { flipBuildup(r.betAmount); TV.startFlip({ p1: r.player1, p2: r.player2, p1Heads: r.creatorHeads }); });
      }
    });
    read.on(read.filters.RoomCreated(), () => refreshRooms());
    read.on(read.filters.RoomCancelled(), () => refreshRooms());
    read.on(read.filters.FlipSettled(), () => {
      // The reconciler does the per-viewer reveal so the event and the poll
      // can never double-fire (guarded by lastRevealed).
      refreshStats(); refreshBalances(); refreshHouse(); refreshRooms();
      reconcile();
    });
    read.on(read.filters.RoomBetUpdated(), () => refreshRooms());
  }

  // ---------------------------------------------------------- websocket (active players)
  let wsTries = 0;
  function connectWS() {
    // Already connecting/open? Just re-identify (e.g. a wallet connected after the
    // guest session started) instead of opening a second socket.
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) { wsSend({ type: "hello", address: account || bjGuestId() }); return; }
    try {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}`);
      // Identify with the real wallet, or a persistent guest id so demo players can
      // still chat at a shared blackjack table.
      ws.onopen = () => { wsTries = 0; wsSend({ type: "hello", address: account || bjGuestId() }); };
      ws.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (d.type === "players") { wsPlayers = d.players || []; renderRoster(); }
        else if (d.type === "rooms-updated" || d.type === "flip") { refreshRooms(); refreshPlayers(); reconcile(); }
        else if (d.type === "chat") { renderChatLine(d.from, d.text, undefined, d.name); const me = String(account || bjGuestId()).toLowerCase(); if (d.from && String(d.from).toLowerCase() !== me) bumpChatUnread(); }
        else if (d.type === "chat-history") renderChatHistory(d.messages);
        else if (d.type === "bet-proposal") handleProposal(d);
        else if (d.type === "bet-response") handleProposalResponse(d);
        else if (d.type && d.type.indexOf("cr:") === 0 && CrashRounds) CrashRounds.handle(d); // live token crash rounds
      };
      // Retry a few times, then give up (e.g. static host with no chat server).
      ws.onclose = () => { if (wsTries++ < 5) setTimeout(connectWS, 2500); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    } catch (e) { console.warn("ws unavailable", e); }
  }
  function wsSend(obj) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch {} }

  // Client seam for the server-paced crash rounds (token mode). Created once; every cr:*
  // frame from the ws is piped into CrashRounds.handle (above). A crash-family channel
  // (crash/plane/swoop/pressure) calls CrashRounds.start({...}) to run a MANUAL-default
  // round. Inert until a channel uses it — see TOKEN-CRASH-ROUNDS.md for the wiring steps.
  const CrashRounds = (window.CrashRoundsClient && window.CrashRoundsClient.make)
    ? window.CrashRoundsClient.make({ send: function (o) { wsSend(o); } })
    : null;

  // Build the per-wallet history + presence roster straight from on-chain rooms,
  // so it works even on a static host (GitHub Pages) with no chat/presence server.
  async function refreshPlayers() {
    if (read && chainOK) {
      try {
        // Scan deep so the W–L tally reflects your TRUE record, not just the last
        // 60 games (returns all games until volume reaches this cap).
        const rooms = await recentRooms(2000);
        const order = [], seen = new Set(), stats = {};
        const touch = (a) => {
          const k = a.toLowerCase();
          if (!stats[k]) stats[k] = { w: 0, l: 0, recent: [] };
          return stats[k];
        };
        const addOrder = (a) => {
          if (isZero(a)) return;
          const k = a.toLowerCase();
          if (!seen.has(k)) { seen.add(k); order.push(a); }
        };
        for (const r of rooms) { // newest-first
          const house = r.isHouseGame;
          // presence: the creator + both human players (never the house wallet)
          addOrder(r.creator);
          addOrder(r.player1);
          if (!house) addOrder(r.player2);
          // win/loss record: settled games only (status 2)
          if (Number(r.status) === 2) {
            const p1 = touch(r.player1), p1won = eq(r.winner, r.player1);
            p1.recent.push(p1won ? "W" : "L"); p1won ? p1.w++ : p1.l++;
            if (!house && !isZero(r.player2)) {
              const p2 = touch(r.player2), p2won = eq(r.winner, r.player2);
              p2.recent.push(p2won ? "W" : "L"); p2won ? p2.w++ : p2.l++;
            }
          }
        }
        chainPlayers = order;
        playerStats = stats;
        renderFeed(rooms);
      } catch (e) { /* keep last-known roster */ }
    }
    renderRoster();
    renderLeaderboard();
    renderAchievements();
  }

  // HIGH SCORES — rank recent participants by net record (wins − losses).
  function renderLeaderboard() {
    const list = $("leaderboard-list");
    if (!list) return;
    const rows = Object.entries(playerStats)
      .map(([addr, s]) => ({ addr, w: s.w, l: s.l, net: s.w - s.l, best: winStreaks(s.recent).best, games: s.w + s.l }))
      .filter((r) => r.games > 0)
      .sort((a, b) => b.net - a.net || b.w - a.w || b.best - a.best)
      .slice(0, 8);
    if (!rows.length) { list.innerHTML = '<li class="empty">No games yet — top the board first!</li>'; return; }
    list.innerHTML = "";
    rows.forEach((r, i) => {
      const mine = account && eq(account, r.addr);
      const li = document.createElement("li");
      li.className = "lb-item clickable" + (mine ? " me" : "");
      li.title = "View profile";
      li.onclick = () => openProfile(r.addr);
      const rank = ["🥇", "🥈", "🥉"][i] || (i + 1) + ".";
      li.innerHTML =
        `<span class="lb-rank">${rank}</span>` +
        `<span class="lb-who">${mine ? "you" : short(r.addr)}</span>` +
        `<span class="lb-rec">${r.w}W–${r.l}L</span>` +
        `<span class="lb-net ${r.net >= 0 ? "up" : "down"}">${r.net >= 0 ? "+" : ""}${r.net}</span>` +
        (r.best >= 2 ? `<span class="lb-streak" title="Best win streak">🔥${r.best}</span>` : "");
      list.appendChild(li);
    });
  }

  // Merge: you (always), any live-server presence, then on-chain participants.
  function renderRoster() {
    const merged = [], seen = new Set();
    const add = (a) => { if (isZero(a)) return; const k = a.toLowerCase(); if (!seen.has(k)) { seen.add(k); merged.push(a); } };
    if (account) add(account);
    for (const a of wsPlayers) add(a);
    for (const a of chainPlayers) add(a);
    renderPlayers(merged);
  }

  // Longest run of consecutive wins (record) and the current active streak,
  // computed from `recent` (newest-first).
  function winStreaks(recent) {
    let best = 0, run = 0;
    for (const o of recent) { if (o === "W") { run++; if (run > best) best = run; } else run = 0; }
    let cur = 0;
    for (const o of recent) { if (o === "W") cur++; else break; }
    return { best, cur };
  }

  function recordBadges(addr) {
    const wrap = document.createElement("span");
    wrap.className = "precord";
    const st = playerStats[addr.toLowerCase()];
    if (st && st.recent.length) {
      // last 3, oldest→newest left-to-right
      for (const o of st.recent.slice(0, 10).reverse()) {
        const b = document.createElement("span");
        b.className = "pbadge " + (o === "W" ? "win" : "loss");
        b.textContent = o;
        wrap.appendChild(b);
      }
      const t = document.createElement("span");
      t.className = "ptally";
      t.textContent = st.w + "W–" + st.l + "L";
      wrap.appendChild(t);
      // win-streak record (🔥). Highlight if they're riding it right now.
      const { best, cur } = winStreaks(st.recent);
      if (best >= 2) {
        const s = document.createElement("span");
        s.className = "pstreak" + (cur === best && cur >= 2 ? " hot" : "");
        s.textContent = "🔥" + best;
        s.title = "Best win streak: " + best + " in a row" + (cur >= 2 ? " · on " + cur + " now" : "");
        wrap.appendChild(s);
      }
    } else {
      const b = document.createElement("span");
      b.className = "pbadge none";
      b.textContent = "no games yet";
      wrap.appendChild(b);
    }
    return wrap;
  }

  function renderPlayers(players) {
    const ul = $("players-list");
    $("players-count").textContent = players.length;
    if (!players.length) { ul.innerHTML = '<li class="empty">No one tuned in yet.</li>'; return; }
    ul.innerHTML = "";
    // You first, then the 7 most-recent participants — keeps the panel compact.
    for (const p of players.slice(0, 8)) {
      const li = document.createElement("li");
      li.className = "player-item clickable";
      li.title = "View profile";
      li.onclick = () => openProfile(p); // click any player → their profile (read-only; house sees diagnostics)
      const c = document.createElement("canvas");
      blockies(p, 8, 3, c);
      li.appendChild(c);
      const mid = document.createElement("div");
      mid.className = "pmid";
      const top = document.createElement("div");
      top.className = "ptop";
      const name = document.createElement("span");
      name.className = "pname"; name.textContent = short(p);
      top.appendChild(name);
      if (eq(p, account)) { const you = document.createElement("span"); you.className = "pyou"; you.textContent = "YOU"; top.appendChild(you); }
      mid.appendChild(top);
      mid.appendChild(recordBadges(p));
      li.appendChild(mid);
      ul.appendChild(li);
    }
  }

  // ---------------------------------------------------------- your games (P&L)
  // A per-flip ledger for the connected wallet. Far clearer than MetaMask's
  // "Contract interaction" rows: vs-house & PvP wins/losses move funds inside the
  // contract's balance ledger, not your wallet ETH, so MetaMask shows no amount —
  // only Deposit/Withdraw actually move wallet ETH. vs-House & PvP come from the
  // on-chain rooms; host-table flips come from HostFlip event logs (seeded once +
  // appended live), cached in localStorage so they survive a reload.
  let hostHistory = [];               // [{label, won, delta(str wei), ts, tx}]
  const seenHostTx = new Set();
  function hostHistKey() { return "coinflip_hosthist_v2_" + (deployment.address || "") + "_" + (account || ""); }
  function loadHostHistory() {
    hostHistory = []; seenHostTx.clear();
    try {
      const raw = JSON.parse(localStorage.getItem(hostHistKey()) || "[]");
      for (const e of raw) if (e && e.tx && !seenHostTx.has(e.tx)) { seenHostTx.add(e.tx); hostHistory.push(e); }
    } catch {}
  }
  function saveHostHistory() {
    try { localStorage.setItem(hostHistKey(), JSON.stringify(hostHistory.slice(-60))); } catch {}
  }
  function addHostGame(e) {
    if (!e.tx || seenHostTx.has(e.tx)) return;
    seenHostTx.add(e.tx);
    hostHistory.push(e);
    saveHostHistory();
  }

  // One-time backfill of this wallet's host-table flips from event logs.
  async function seedHostHistory() {
    if (!read || !chainOK || !account || !deployment.address) return;
    try {
      const latest = await provider.getBlockNumber();
      const from = Math.max(0, latest - 9000); // recent window; safe under common getLogs caps
      const evs = await read.queryFilter(read.filters.HostFlip(null, account), from, latest);
      const head = await provider.getBlock(latest);
      const baseTs = head ? Number(head.timestamp) : Math.floor(Date.now() / 1000);
      for (const e of evs) {
        const a = e.args;
        const payout = breakdown(a.betAmount).win;
        addHostGame({
          label: "Host table",
          won: a.playerWon,
          amount: (a.playerWon ? payout : a.betAmount).toString(), // pot won / stake lost
          net: (a.playerWon ? payout - a.betAmount : -a.betAmount).toString(), // true change
          ts: baseTs - (latest - e.blockNumber) * 12, // ~12s/block on Sepolia
          tx: e.transactionHash,
        });
      }
      refreshMyHistory();
    } catch (e) { /* RPC may reject the range or not index logs — skip gracefully */ }
  }

  async function refreshMyHistory() {
    if (!read || !chainOK || !account) return;
    try {
      const rooms = await recentRooms(2000);
      const games = [];
      for (const r of rooms) {
        if (Number(r.status) !== 2) continue; // settled only
        const isPlayer = eq(r.player1, account) || (eq(r.player2, account) && !r.isHouseGame);
        if (!isPlayer) continue;
        const won = eq(r.winner, account);
        const payout = breakdown(r.betAmount).win;
        const amount = won ? payout : r.betAmount;       // pot won / stake lost (gross)
        const net = won ? payout - r.betAmount : -r.betAmount; // true balance change
        games.push({ label: r.isHouseGame ? "vs House" : "PvP #" + r.id.toString(), won, amount, net, ts: Number(r.settledAt) });
      }
      for (const h of hostHistory) games.push({ label: h.label, won: h.won, amount: BigInt(h.amount), net: BigInt(h.net), ts: h.ts });
      games.sort((a, b) => b.ts - a.ts); // newest first
      // biggest single net win (for achievements)
      let bestNet = 0n;
      for (const g of games) if (g.won && g.net > bestNet) bestNet = g.net;
      myBestNetUsd = Math.max(myBestNetUsd, weiToUsd(bestNet));
      renderAchievements();
      renderMyHistory(games);
    } catch {}
  }

  function renderMyHistory(games) {
    const list = $("my-history-list");
    if (!list) return;
    $("my-history-count").textContent = games.length;
    const netEl = $("my-history-net");
    if (!games.length) {
      if (netEl) netEl.textContent = "";
      list.innerHTML = '<li class="empty">No games yet — your wins &amp; losses show here.</li>';
      return;
    }
    // running true profit across all shown games (after your stakes)
    let net = 0n;
    for (const g of games) net += g.net;
    if (netEl) {
      const up = net >= 0n;
      netEl.textContent = "profit " + (up ? "+" : "−") + usdOf(up ? net : -net);
      netEl.className = "hist-net " + (up ? "up" : "down");
    }
    list.innerHTML = "";
    for (const g of games.slice(0, 20)) {
      const li = document.createElement("li");
      li.className = "hist-item " + (g.won ? "won" : "lost");
      const label = document.createElement("span");
      label.className = "hist-label";
      label.textContent = g.label + " · " + (g.won ? "pot won" : "lost");
      // Verifiable on-chain: link the settlement tx (host games) or the
      // contract's on-chain activity (room games) on Etherscan.
      const href = explorerTx(g.tx) || explorerContract();
      if (href) {
        const v = document.createElement("a");
        v.className = "hist-verify"; v.href = href; v.target = "_blank"; v.rel = "noopener";
        v.textContent = " verify ↗"; v.title = "See this result settled on-chain (Etherscan)";
        label.appendChild(v);
      }
      const amt = document.createElement("span");
      amt.className = "hist-amt " + (g.won ? "up" : "down");
      amt.textContent = (g.won ? "+" : "−") + usdOf(g.amount); // gross: pot won / stake lost
      li.appendChild(label);
      li.appendChild(amt);
      list.appendChild(li);
    }
  }

  // ---------------------------------------------------------- sound + help
  // After the promo intro's first run, kick off a RANDOM background track. Audio
  // needs a user gesture, so if none has happened yet we start on the first one.
  let musicAfterPromoDone = false;
  function startRandomTrack() {
    try {
      if (!window.Chiptune) return;
      if (Chiptune.isOn && Chiptune.isOn()) return; // already playing — don't override the user
      const list = Chiptune.tracks ? Chiptune.tracks() : [];
      const n = list && list.length ? list.length : 1;
      const idx = Math.floor(Math.random() * n);
      if (Chiptune.wake) Chiptune.wake();
      if (Chiptune.playTrack) Chiptune.playTrack(idx);
      if (!Chiptune.isOn()) Chiptune.start();
      syncSoundBtn();
    } catch (e) {}
  }
  function startMusicAfterPromo() {
    if (musicAfterPromoDone) return;
    musicAfterPromoDone = true;
    if (window.Chiptune && Chiptune.isOn && Chiptune.isOn()) return; // user already started music
    if (audioUnlocked) { startRandomTrack(); return; }              // gesture already happened
    const go = () => {
      ["pointerdown", "touchstart", "touchend", "click", "keydown"].forEach((e) => window.removeEventListener(e, go, true));
      startRandomTrack();
    };
    ["pointerdown", "touchstart", "touchend", "click", "keydown"].forEach((e) => window.addEventListener(e, go, true));
  }

  function syncSoundBtn() {
    const on = !!(window.Chiptune && window.Chiptune.isOn());
    const btn = $("sound-btn");
    if (btn) {
      btn.textContent = on ? "🔊" : "🔇";
      btn.classList.toggle("active", on);
    }
    const play = $("music-play"); if (play) play.textContent = on ? "⏸" : "▶";
    if (window.Chiptune && Chiptune.current) {
      const c = Chiptune.current();
      const now = $("music-now"); if (now) now.textContent = (on ? "♪ " : "") + (c ? c.name : "—");
      document.querySelectorAll("#music-tracks .mm-track").forEach((el, i) => el.classList.toggle("active", i === (c ? c.index : -1)));
    }
  }
  // Build the track list once (from Chiptune.tracks()), then keep it in sync.
  function renderTrackList() {
    const wrap = $("music-tracks");
    if (!wrap || !window.Chiptune || !Chiptune.tracks) return;
    if (!wrap.dataset.built) {
      wrap.innerHTML = Chiptune.tracks().map((t, i) =>
        '<button type="button" class="mm-track" data-i="' + i + '">' + escapeHtml(t.name) + "</button>").join("");
      wrap.querySelectorAll(".mm-track").forEach((el) => {
        el.onclick = (e) => {
          e.stopPropagation();
          Chiptune.playTrack(+el.dataset.i);
          if (!Chiptune.isOn()) Chiptune.start();
          userMutedMusic = false;
          syncSoundBtn();
        };
      });
      wrap.dataset.built = "1";
    }
    syncSoundBtn();
  }
  // Skip to the next/previous track; start playback if it was paused.
  function musicSkip(dir) {
    if (!window.Chiptune) return;
    dir < 0 ? Chiptune.prev() : Chiptune.next();
    if (!Chiptune.isOn()) Chiptune.start();
    userMutedMusic = false;
    syncSoundBtn();
  }

  // Heads/Tails picker: returns true if the HEADS button is active in #id.
  function sideOf(id) {
    const el = document.querySelector("#" + id + " .side-btn.active");
    return el ? el.dataset.heads === "1" : true;
  }
  function wireSideToggles() {
    document.querySelectorAll(".side-toggle").forEach((tog) => {
      tog.querySelectorAll(".side-btn").forEach((b) => {
        b.onclick = () => {
          tog.querySelectorAll(".side-btn").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
        };
      });
    });
  }

  function wireUI() {
    wireSideToggles();
    $("connect-btn").onclick = connect;
    $("disconnect-btn").onclick = disconnect;
    { const dr = $("demo-reset"); if (dr) dr.onclick = demoReset; }
    { const dc = $("demo-connect"); if (dc) dc.onclick = connect; }
    { const bs = $("bj-share"); if (bs) bs.onclick = bjShareTable; } // copy a link to the current blackjack table
    { const br = $("bj-reload"); if (br) br.onclick = () => { bjReload(); if (!account) toast("Table chips topped back up to $1,000 💰", "ok"); }; }
    { const bc = $("bj-cashout"); if (bc) bc.onclick = bjCashout; }
    $("raise-max-btn").onclick = raiseMaxBet;
    $("fund-house-btn").onclick = fundHouseTool;
    { const b = $("bj-signer-btn"); if (b) b.onclick = setSignerTool; }
    $("cashout-house-btn").onclick = cashOutHouse;
    $("cashout-amount-btn").onclick = cashOutAmount;
    $("new-game-btn").onclick = newGame;
    { const b = $("deploy-registry-btn"); if (b) b.onclick = deployRegistry; }
    { const b = $("set-active-btn"); if (b) b.onclick = setActiveGameManual; }
    document.querySelectorAll(".hs-tab").forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll(".hs-tab").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        hostPeriod = b.dataset.period;
        refreshHostPanel();
      };
    });
    $("deposit-btn").onclick = deposit;
    $("withdraw-btn").onclick = withdrawClick;
    { const c = $("xfer-confirm"); if (c) c.onclick = () => closeXfer(true); }
    { const c = $("xfer-cancel"); if (c) c.onclick = () => closeXfer(false); }
    { const c = $("xfer-close"); if (c) c.onclick = () => closeXfer(false); }
    { const m = $("xfer-modal"); if (m) m.onclick = (e) => { if (e.target === m) closeXfer(false); }; }
    { const wi = $("withdraw-input"); if (wi) wi.oninput = () => { withdrawTouched = true; setSliderUsd("withdraw-input"); updateWithdrawBtn(); }; }
    $("create-room-btn").onclick = createRoom;
    $("play-house-btn").onclick = playHouse;
    $("create-host-btn").onclick = createHostTable;
    $("play-table-btn").onclick = playTable;
    $("host-table-copy").onclick = () => {
      const inp = $("host-table-link"); inp.select();
      navigator.clipboard?.writeText(inp.value).then(() => toast("Table link copied!", "ok"), () => {});
    };
    $("refresh-rooms").onclick = () => refreshRooms();

    // House + create-room + host-table stake sliders (USD)
    $("house-bet").oninput = () => setSliderUsd("house-bet");
    $("bet-input").oninput = () => setSliderUsd("bet-input");
    $("deposit-input").oninput = () => { setSliderUsd("deposit-input"); updateDepositBtn(); };
    $("host-bank").oninput = () => setSliderUsd("host-bank");
    $("table-bet").oninput = () => setSliderUsd("table-bet");
    wireQuickBet();
    wireBetbar();
    initThemeSwitch();
    initDice();
    setupRevealAudioUnlock();
    // Join raise slider (USD): at/near the host's bet use the exact amount, else convert
    $("join-bet").oninput = (e) => {
      const u = +e.target.value;
      $("join-bet-val").textContent = usd(u);
      const room = pendingBet && pendingBet.room;
      const roomUsd = room ? weiToUsd(room.betAmount) : 0;
      const bet = room && u <= roomUsd + 4 ? room.betAmount : usdToWei(u);
      updateBetModalAmount(bet);
    };
    // Bet confirmation modal
    $("bet-accept").onclick = acceptBet;
    $("bet-close").onclick = closeBetModal;
    $("bet-modal").onclick = (e) => { if (e.target === $("bet-modal")) closeBetModal(); };
    // Bet negotiation (host side)
    $("nego-accept").onclick = negoAccept;
    $("nego-deny").onclick = negoDeny;
    // Chat
    $("chat-send").onclick = sendChat;
    $("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
    // In-browser hosting
    $("deploy-btn").onclick = deployContract;
    $("host-copy").onclick = () => {
      const inp = $("host-share-link"); inp.select();
      navigator.clipboard?.writeText(inp.value).then(() => toast("Game link copied!", "ok"), () => {});
    };
    $("copy-link-btn").onclick = () => {
      const inp = $("share-link"); inp.select();
      navigator.clipboard?.writeText(inp.value).then(() => toast("Link copied!", "ok"), () => {});
    };
    const shareBtn = $("share-result-btn"); if (shareBtn) shareBtn.onclick = shareResultCard;
    const inviteCopy = $("invite-copy");
    if (inviteCopy) inviteCopy.onclick = () => {
      const inp = $("invite-link"); if (!inp) return; inp.select();
      navigator.clipboard?.writeText(inp.value).then(() => toast("Invite link copied! 🎟️", "ok"), () => {});
    };
    // Step the CURRENT game's stake slider (not just the flip one) and refresh it.
    function stepCurrentStake(dir) {
      const s = $(BETBAR_SL[currentGame]); if (!s) return false; // shared map (incl. plane/slots3d)
      const step = (+s.step || 5) * (dir > 0 ? 1 : -1);
      const v = Math.max(+s.min || 0, Math.min(+s.max || 1e9, (+s.value || 0) + step));
      if (String(v) === s.value) return true;
      s.value = String(v);
      try { s.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
      return true;
    }
    // ---- Keyboard hotkeys (skip while typing / over a modal / on a focused control) ----
    document.addEventListener("keydown", (e) => {
      const el = e.target, tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const isOpen = (id) => { const m = $(id); return !!(m && !m.classList.contains("hidden")); };
      const betOpen = isOpen("bet-modal");

      if (k === "escape") { // close only the topmost open overlay
        if (betOpen) { closeBetModal(); return; }
        for (const id of ["nego-modal", "profile-modal", "help-modal"]) if (isOpen(id)) { $(id).classList.add("hidden"); return; }
        if (document.body.classList.contains("chat-open")) document.body.classList.remove("chat-open");
        return;
      }
      if (betOpen) { if (k === "enter") { e.preventDefault(); $("bet-accept").click(); } return; }
      // Behind any open overlay → don't fire game hotkeys.
      if (isOpen("help-modal") || isOpen("profile-modal") || isOpen("nego-modal") ||
          document.body.classList.contains("chat-open") || document.body.classList.contains("rail-open")) return;

      if (k === " ") {
        if (e.repeat) { e.preventDefault(); return; } // ignore key-repeat → no bet flood
        // SPACE is a dedicated BET key on the game page. ALWAYS swallow its default
        // action so it can never activate a stray focused button / nav card (the
        // old "let it activate natively" branch is exactly how a Space could land
        // on the Coin Flip card or — with no slots3d entry below — fall through to
        // the flip bet button and yank you into Coin Flip from Gem Vault).
        e.preventDefault();
        // Canvas games own SPACE through their OWN handlers (pump / launch / spin) —
        // bail so we don't double-fire; do NOT fall back to the flip button.
        if (currentGame === "pressure" || currentGame === "plane" || currentGame === "slots3d") return;
        const BTN = { flip: "play-house-btn", dice: "dice-roll-btn", twodice: "td-roll-btn", crash: "crash-launch" };
        const btn = $(BTN[currentGame]); // no default → an unknown channel (e.g. poker) does nothing
        if (btn && !btn.disabled) btn.click();
        return;
      }
      if (k === "enter") return; // native: activate the focused control (e.g. a game tab)
      if (k === "h" && currentGame === "flip") setHotSide(true);
      else if (k === "t" && currentGame === "flip") setHotSide(false);
      else if (k === "+" || k === "=" || k === "arrowup") { if (stepCurrentStake(1)) e.preventDefault(); }
      else if (k === "-" || k === "_" || k === "arrowdown") { if (stepCurrentStake(-1)) e.preventDefault(); }
    });
    $("help-btn").onclick = () => $("help-modal").classList.remove("hidden");
    $("help-close").onclick = () => $("help-modal").classList.add("hidden");
    $("help-modal").onclick = (e) => { if (e.target === $("help-modal")) $("help-modal").classList.add("hidden"); };

    // ── Stake-style sidebar: mobile drawer toggle + essentials links ──
    const closeRail = () => document.body.classList.remove("rail-open");
    { const t = $("rail-toggle"); if (t) t.onclick = () => document.body.classList.toggle("rail-open"); }
    // tap the dimmed overlay (the ::after) to close — listen on body when open
    document.addEventListener("click", (e) => {
      if (!document.body.classList.contains("rail-open")) return;
      const rail = $("game-nav") && $("game-nav").closest(".channels");
      const toggle = $("rail-toggle");
      if (rail && !rail.contains(e.target) && e.target !== toggle) closeRail();
    });
    // selecting a game closes the drawer on mobile
    document.querySelectorAll("#game-nav .game-card").forEach((b) => b.addEventListener("click", () => { if (window.matchMedia("(max-width:900px)").matches) closeRail(); }));
    { const w = $("rail-wallet"); if (w) w.onclick = () => { closeRail(); const t = $("game-balance") || $("deposit-input"); if (t) t.scrollIntoView({ behavior: "smooth", block: "center" }); }; }
    { const h = $("rail-howto"); if (h) h.onclick = () => { closeRail(); $("help-modal").classList.remove("hidden"); }; }
    { const ht = $("rail-host"); if (ht) ht.onclick = () => { closeRail(); const t = $("host-tools"); if (t) { t.hidden = false; t.scrollIntoView({ behavior: "smooth", block: "center" }); } }; }
    { const rp = $("rail-profile"); if (rp) rp.onclick = () => { closeRail(); openProfile(); }; }
    { const pc = $("profile-close"); if (pc) pc.onclick = () => $("profile-modal").classList.add("hidden"); }
    { const pm = $("profile-modal"); if (pm) pm.onclick = (e) => { if (e.target === pm) pm.classList.add("hidden"); }; }
    { const ps = $("profile-save"); if (ps) ps.onclick = saveProfile; }
    { const pr = $("profile-addr-reveal"); if (pr) pr.onclick = () => {
        const el = $("profile-addr-short");
        if (el) el.textContent = account || "—";
        try { navigator.clipboard && navigator.clipboard.writeText(account || ""); toast("Address copied", "ok"); } catch {}
      }; }

    // ── Chat drawer: slide-in panel toggled from the top bar ──
    const closeChat = () => { document.body.classList.remove("chat-open"); const ta = $("chat-tab"); if (ta) ta.setAttribute("aria-expanded", "false"); };
    const toggleChat = () => { if (document.body.classList.contains("chat-open")) closeChat(); else openChat(); };
    { const ct = $("chat-toggle"); if (ct) ct.onclick = (e) => { e.stopPropagation(); toggleChat(); }; }
    { const tab = $("chat-tab"); if (tab) tab.onclick = (e) => { e.stopPropagation(); openChat(); }; }
    { const sc = $("chat-scrim"); if (sc) sc.onclick = closeChat; }
    { const cc = $("chat-close"); if (cc) cc.onclick = closeChat; }
    document.addEventListener("click", (e) => {
      if (!document.body.classList.contains("chat-open")) return;
      const drawer = $("chat-drawer"); const toggle = $("chat-toggle"); const tab = $("chat-tab");
      if (drawer && !drawer.contains(e.target) && e.target !== toggle && e.target !== tab && (!tab || !tab.contains(e.target))) closeChat();
    });

    // ── Promo intro reel: autoplays (muted) ONCE on load, then fades to the game.
    //    The only control is the Replay button under the TV (plays back WITH sound). ──
    // Music NEVER auto-starts after the promo — it only plays when the user taps the
    // Music button (the auto-start felt intrusive). We DO use the promo-end hook to
    // re-assert the active channel's reveal: a game that lazy-loaded UNDER the promo
    // (especially Reef Raiders) otherwise gets stuck on its loading screen, because
    // _endPromo's single idle() can fire before the Pixi canvas finishes mounting.
    window.__onPromoEnded = function () {
      try { if (currentGame === "fish") ensureFishReady(); } catch (e) {}
    };
    // The intro reel plays ONCE per deployed build, then is remembered — it only
    // replays after a NEW website push (the build tag changes), never on plain
    // refreshes or channel switches within the same build.
    {
      const playPromo = () => { if (window.TV && TV.playPromo) { try { TV.playPromo(); } catch (e) {} } };
      let build = "", seen = null;
      try { build = (($("build-tag") || {}).textContent || "").trim(); } catch (e) {}
      try { seen = localStorage.getItem("ctf_promo_seen"); } catch (e) {}
      if (!build) { playPromo(); }                    // no build tag → just play (don't lock out)
      else if (seen !== build) {                      // not seen for THIS build → play once, remember it
        playPromo();
        try { localStorage.setItem("ctf_promo_seen", build); } catch (e) {}
      }
    }
    // Hitting any bet/play button mid-intro skips the promo instantly so you can
    // bet right away. Capture phase → runs BEFORE the button's own handler (covers
    // clicks AND the Balloon Pop hold-to-pump pointerdown).
    document.addEventListener("pointerdown", (e) => {
      const t = e.target;
      if (!(t && t.closest && t.closest(".action-dock"))) return;
      hideShareBtn(); // a new bet is starting → clear the previous win's share button
      clearTvWin();   // …and the previous win's on-screen amount badge
      if (window.TV && TV._promoPlaying && TV.skipPromo) TV.skipPromo();
    }, true);

    // ── Mobile bottom tab bar ──
    { const b = $("bn-games"); if (b) b.onclick = (e) => { e.stopPropagation(); closeChat(); document.body.classList.toggle("rail-open"); }; }
    { const b = $("bn-wallet"); if (b) b.onclick = () => { closeRail(); closeChat(); const t = $("game-balance") || $("deposit-input"); if (t) t.scrollIntoView({ behavior: "smooth", block: "center" }); }; }
    { const b = $("bn-chat"); if (b) b.onclick = (e) => { e.stopPropagation(); closeRail(); toggleChat(); }; }
    { const b = $("bn-help"); if (b) b.onclick = () => { closeRail(); closeChat(); $("help-modal").classList.remove("hidden"); }; }
    // ── Music dropdown: open the track menu, play/pause, prev/next, pick a track ──
    { const sb = $("sound-btn"); if (sb) sb.onclick = (e) => {
        e.stopPropagation();
        const menu = $("music-menu");
        if (!menu) return;
        menu.classList.toggle("hidden");
        if (!menu.classList.contains("hidden")) {
          renderTrackList();
          // Menu is position:fixed (escapes the topbar stacking context), so pin it
          // just below the bar at all widths. Align its right edge to the button.
          const tb = document.querySelector(".topbar");
          menu.style.top = ((tb ? tb.getBoundingClientRect().bottom : 60) + 6) + "px";
          if (window.matchMedia("(max-width:640px)").matches) {
            menu.style.right = ""; // mobile rule stretches it full-width (left/right:10px)
          } else {
            const r = sb.getBoundingClientRect();
            menu.style.right = Math.max(10, window.innerWidth - r.right) + "px";
          }
        }
      }; }
    { const p = $("music-play"); if (p) p.onclick = (e) => { e.stopPropagation(); if (!window.Chiptune) return; const on = Chiptune.toggle(); userMutedMusic = !on; syncSoundBtn(); }; }
    { const n = $("music-next"); if (n) n.onclick = (e) => { e.stopPropagation(); musicSkip(1); }; }
    { const pv = $("music-prev"); if (pv) pv.onclick = (e) => { e.stopPropagation(); musicSkip(-1); }; }
    document.addEventListener("click", (e) => {
      const menu = $("music-menu"); if (!menu || menu.classList.contains("hidden")) return;
      const wrap = menu.closest(".music-wrap");
      if (wrap && !wrap.contains(e.target)) menu.classList.add("hidden");
    });

    if (window.ethereum) {
      // Don't reload during the initial connect (that caused the "click twice"
      // bug). Only reload on a *real* account/network change after connecting.
      window.ethereum.on?.("accountsChanged", (accs) => {
        if (connecting) return;
        const next = (accs && accs[0]) || null;
        if (account && next && eq(next, account)) return; // same account → ignore
        location.reload();
      });
      window.ethereum.on?.("chainChanged", () => { if (!connecting) location.reload(); });
    }
    // learn our public share host (if the server was started with PUBLIC_HOST)
    fetch("/api/info").then((r) => r.json()).then((d) => { if (d.publicHost) window.__PUBLIC_HOST = d.publicHost; }).catch(() => {});

    // Periodic lobby refresh + TV reveal reconciler — a BACKSTOP for missed
    // events (events + ws cover the fast path). Skip when the tab is hidden, and
    // keep the heavy on-chain scans (players/history/host panel) on a slower beat.
    let heavyTick = 0;
    setInterval(() => {
      if (document.hidden || !(chainOK && read)) return;
      refreshRooms(); refreshBalances(); refreshHouse(); reconcile();
      if (++heavyTick % 3 === 0) { refreshPlayers(); refreshMyTables(); refreshMyHistory(); refreshHostPanel(); }
    }, 12000);
  }

  // Shared short-TTL cache for getRecentRooms so the players / history / host-panel
  // scans in one cycle don't each fire their own (expensive) RPC fetch.
  let _recent = { t: 0, n: 0, rooms: null };
  async function recentRooms(n) {
    const now = Date.now();
    if (_recent.rooms && _recent.n >= n && now - _recent.t < 5000) return _recent.rooms.slice(0, n);
    const want = Math.max(n, 150);
    const rooms = await read.getRecentRooms(want);
    _recent = { t: now, n: want, rooms };
    return rooms.slice(0, n);
  }
  let _recentDice = { t: 0, n: 0, dice: null };
  async function recentDice(n) {
    const now = Date.now();
    if (_recentDice.dice && _recentDice.n >= n && now - _recentDice.t < 5000) return _recentDice.dice.slice(0, n);
    const want = Math.max(n, 150);
    let dice = [];
    try { dice = await read.getRecentDice(want); } catch { dice = []; }
    _recentDice = { t: now, n: want, dice };
    return dice.slice(0, n);
  }
  let _recentTwoDice = { t: 0, n: 0, dice: null };
  async function recentTwoDice(n) {
    const now = Date.now();
    if (_recentTwoDice.dice && _recentTwoDice.n >= n && now - _recentTwoDice.t < 5000) return _recentTwoDice.dice.slice(0, n);
    const want = Math.max(n, 150);
    let dice = [];
    try { if (read.getRecentTwoDice) dice = await read.getRecentTwoDice(want); } catch { dice = []; }
    _recentTwoDice = { t: now, n: want, dice };
    return dice.slice(0, n);
  }

  // ---------------------------------------------------------- boot
  // Public read-only provider so the lobby — players & records, open rooms,
  // house stats — loads for EVERYONE, even before a wallet is connected and on
  // mobile browsers that inject no wallet at all. The wallet provider replaces
  // this the moment you connect (betting still requires connecting).
  // If a GameRegistry is configured, resolve the live game from it once (an
  // explicit ?contract= share link always wins). Falls back to config.address.
  let registryResolved = false;
  async function resolveActiveGame(prov) {
    if (registryResolved) return;
    registryResolved = true;
    try {
      if (!cfg.registry || !E.isAddress(cfg.registry) || params.get("contract")) return;
      const reg = new E.Contract(cfg.registry, ["function activeGame() view returns (address)"], prov);
      const live = await reg.activeGame();
      if (live && E.isAddress(live) && !/^0x0+$/i.test(live)) deployment.address = live;
    } catch (e) { /* keep config.address fallback */ }
  }

  async function setupReadOnly() {
    if (read || !deployment.address) return;
    const RO_RPC = {
      11155111: "https://ethereum-sepolia-rpc.publicnode.com",
      31337: "http://127.0.0.1:8545",
    };
    const chain = deployment.chainId || 11155111;
    const url = RO_RPC[chain];
    if (!url) return;
    try {
      const ro = new E.JsonRpcProvider(url, chain);
      ro.pollingInterval = 8000;
      await resolveActiveGame(ro); // may update deployment.address from the registry
      const code = await ro.getCode(deployment.address);
      if (!code || code === "0x") return; // nothing deployed there to read
      provider = ro;
      read = new E.Contract(deployment.address, ABI, ro);
      chainOK = true;
      try { hostTreasury = await read.treasury(); } catch {}
      refreshStats(); refreshHouse(); refreshRooms(); refreshPlayers();
    } catch {}
  }

  // Hard-disable browser zoom gestures across every mobile browser + Safari:
  // pinch (multi-touch + iOS gesture events) and the double-tap / double-tap-hold
  // zoom (Chrome). The viewport meta (user-scalable=no) covers most of it; these
  // listeners close the gaps (esp. iOS, which ignores user-scalable=no).
  function lockZoom() {
    const stop = (e) => { try { e.preventDefault(); } catch (_) {} };
    const inField = (t) => !!(t && t.closest && t.closest("input, textarea, select, [contenteditable=\"true\"], .selectable"));
    ["gesturestart", "gesturechange", "gestureend"].forEach((ev) => document.addEventListener(ev, stop, { passive: false }));
    document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1) stop(e); }, { passive: false });
    // NB: no touchend double-tap guard — preventDefault on touchend suppresses the
    // synthesized click, so a fast second tap would silently do nothing. Double-tap
    // zoom is already killed by `touch-action: manipulation` + the viewport meta.
    document.addEventListener("dblclick", stop, { passive: false });
    // Stop the iOS long-press magnifier loupe at its source (selection start),
    // except inside real form fields. Also block the long-press context menu.
    document.addEventListener("selectstart", (e) => { if (!inField(e.target)) stop(e); }, { passive: false });
    document.addEventListener("contextmenu", (e) => { if (!inField(e.target)) stop(e); }, { passive: false });
  }

  // Always flush the play balance before the page is hidden/backgrounded (iOS may
  // reload the tab after a share/app-switch) so it's never lost.
  window.addEventListener("pagehide", () => { try { if (demoOn) demoSave(); } catch (e) {} });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { try { if (demoOn) demoSave(); } catch (e) {} return; }
    // Back in view: a real-money settle event can drop while the tab is hidden (and the
    // poll is paused), leaving an in-flight round without its TV reveal. Catch it up.
    try { if (activeRoomId && read && chainOK) reconcile(); } catch (e) {}
  });

  window.addEventListener("DOMContentLoaded", () => {
    lockZoom();
    TV.init();
    wireUI();
    syncSoundBtn();
    setupSliders();
    setupReadOnly();
    renderInvite();
    // Default landing experience: instant play-money demo so visitors can try
    // every game before connecting a wallet. A real connection takes over later.
    enterDemo();
    initNoticeDismiss(); // wire the ✕ close buttons on the demo / phone notices
    connectWS(); // connect the live socket for everyone (guest chat + presence + blackjack), not just connected wallets
    // Register the PWA service worker (after load, best-effort).
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => { try { navigator.serviceWorker.register("sw.js"); } catch (e) {} });
    }
    // Warm Three.js in the background once the page is idle, so the first 3D game
    // (Gem Vault, the coin, the 0-100 rail, etc.) builds fast instead of paying
    // the ~600KB fetch+parse on the critical path. Cheap after the SW caches it.
    {
      const warmThree = () => { try { loadThreeOnce(); } catch (e) {} };
      if (window.requestIdleCallback) requestIdleCallback(warmThree, { timeout: 3000 });
      else setTimeout(warmThree, 1500);
    }
    // Music NEVER auto-plays — it only starts when the user taps the Music button.
    // Live ETH→USD price: fetch now, refresh labels, and re-poll every 60s.
    fetchEthUsd().then(() => { setupSliders(); if (demoOn) demoSyncBalance(); if (read && chainOK) { refreshBalances(); refreshStats(); refreshHouse(); refreshRooms(); } });
    setInterval(() => { if (document.hidden) return; fetchEthUsd().then(() => { setupSliders(); if (demoOn) demoSyncBalance(); if (read && chainOK) { refreshBalances(); refreshStats(); refreshHouse(); refreshRooms(); } }); }, 60000);
    $("connect-btn").classList.add("cta-pulse");
    // On a phone with no injected wallet, nudge users into the MetaMask browser.
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && !window.ethereum) {
      $("mobile-hint").classList.remove("hidden");
    }
    const remoteHost = location.hostname && !/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/.test(location.hostname);
    if (deployment.address && deployment.chainId === 31337 && remoteHost) {
      banner(
        "⚠ This game is on a LOCAL test chain that only works on the host's own computer. " +
          "For remote play, the host should deploy on the Sepolia testnet (Connect → 🚀 Deploy).",
        true
      );
    } else if (!deployment.address) {
      banner("👋 New here? Click Connect Wallet, then 🚀 Deploy a game (you'll be the host). Tap ? for help.");
    }
    if (inviteRoomId) toast("You've been invited to room #" + inviteRoomId + " — connect to join.");
  });
})();
