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
    // Only adopt a shared ?contract= link if it's a valid address (fail fast on junk).
    if (a && (!E || !E.isAddress || E.isAddress(a))) return { address: a, chainId: c ? Number(c) : null };
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
  let read = null; // connected to provider
  let maxBet = 0n;
  let walletWei = 0n; // last-seen wallet ETH balance (for the deposit cap)
  let chainOK = false;
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
  // your balance = pot − 10% house), not just the net profit, so a $50 bet win
  // reads "+$90" not "+$40". A loss shows the stake you lost. `tier` escalates the
  // celebration by total pot size: big ($100+) and mega ($500+).
  function flipReveal(betWei, won) {
    const pot = betWei * 2n;
    const payout = pot - pot / 10n; // pot minus the 10% house cut
    const amountWei = won ? payout : betWei; // pot won / stake lost
    const netWei = won ? payout - betWei : -betWei; // true balance change (for the running total)
    const potUsd = weiToUsd(pot);
    const tier = won ? (potUsd >= 500 ? "mega" : potUsd >= 100 ? "big" : "normal") : "normal";
    return { amountUsd: weiToUsd(amountWei), amountWei, netWei, tier, potUsd };
  }

  // ---- shareable win/loss card (canvas -> PNG -> Web Share / download) ----
  let lastResult = null;
  function setLastResult(r) {
    lastResult = r;
    const btn = $("share-result-btn");
    if (btn) btn.classList.remove("hidden");
  }
  function drawShareCoin(g, cx, cy, rad) {
    const grad = g.createRadialGradient(cx - rad * 0.3, cy - rad * 0.3, rad * 0.2, cx, cy, rad);
    grad.addColorStop(0, "#fff3b0"); grad.addColorStop(0.55, "#ffcf3f"); grad.addColorStop(1, "#a9760a");
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
    g.lineWidth = 10; g.strokeStyle = "#7a5200"; g.stroke();
    // Ethereum diamond, two stacked facets
    g.fillStyle = "rgba(74,53,0,0.85)";
    const s = rad * 0.72;
    g.beginPath(); g.moveTo(cx, cy - s); g.lineTo(cx - s * 0.55, cy); g.lineTo(cx, cy + s * 0.18); g.lineTo(cx + s * 0.55, cy); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(cx, cy + s * 0.34); g.lineTo(cx - s * 0.55, cy + s * 0.1); g.lineTo(cx, cy + s); g.lineTo(cx + s * 0.55, cy + s * 0.1); g.closePath(); g.fill();
  }
  function drawShareCard(cv) {
    const W = 1080, H = 1080, r = lastResult, won = r.won;
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0c0d16"); bg.addColorStop(1, "#141627");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(57,231,255,0.06)"; g.lineWidth = 2;
    for (let x = 0; x <= W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y <= H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const glow = g.createRadialGradient(W / 2, 330, 60, W / 2, 330, 560);
    glow.addColorStop(0, won ? "rgba(52,227,155,0.25)" : "rgba(255,91,91,0.20)"); glow.addColorStop(1, "transparent");
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    g.textAlign = "center";
    g.fillStyle = "#39e7ff"; g.font = "700 40px 'Press Start 2P', monospace";
    g.fillText("📺 CRYPTO TV FLIP", W / 2, 112);
    drawShareCoin(g, W / 2, 330, 132);
    g.font = "700 88px 'Press Start 2P', monospace"; g.fillStyle = won ? "#34e39b" : "#ff5b5b";
    g.fillText(won ? "WINNER" : "BUSTED", W / 2, 612);
    g.font = "800 120px 'Space Grotesk', system-ui, sans-serif"; g.fillStyle = won ? "#2bff88" : "#ff7a7a";
    g.fillText((won ? "+" : "−") + usd(r.amountUsd), W / 2, 738);
    g.font = "500 40px 'Space Grotesk', system-ui, sans-serif"; g.fillStyle = "#b9c2e0";
    const eth = (+E.formatEther(r.amountWei)).toFixed(4) + " ETH";
    g.fillText(won ? eth + " · 1.8× payout" : eth + " · " + r.label, W / 2, 802);
    g.font = "700 30px 'Press Start 2P', monospace"; g.fillStyle = "#ffcf3f";
    g.fillText("COIN LANDED " + r.side, W / 2, 884);
    g.font = "500 34px 'Space Grotesk', system-ui, sans-serif"; g.fillStyle = "#7f8bb0";
    g.fillText("Provably on-chain · Sepolia testnet · play money", W / 2, 980);
    g.fillStyle = "#39e7ff";
    g.fillText("tv-crypto-flip.onrender.com", W / 2, 1030);
  }
  async function shareResultCard() {
    if (!lastResult) return;
    try { await document.fonts.ready; } catch {}
    const cv = document.createElement("canvas");
    drawShareCard(cv);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) return toast("Couldn't make the card — try again.", "err");
    const file = new File([blob], "crypto-tv-flip.png", { type: "image/png" });
    const text = (lastResult.won
      ? "I just won " + usd(lastResult.amountUsd) + " flipping ETH on Crypto TV Flip! 🪙📺"
      : "Took an L flipping ETH on Crypto TV Flip 🪙📺 — get me back")
      + " " + CANONICAL_URL;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "crypto-tv-flip.png"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    try { await navigator.clipboard.writeText(text); toast("Card saved 📸 + caption copied", "ok"); }
    catch { toast("Card saved 📸", "ok"); }
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
  }
  // Live preview under the create-room stake slider so it's obvious both players
  // match the stake, and where the pot / winnings / 10% cut land.
  function updateCreateBreakdown() {
    const el = $("create-breakdown"); if (!el) return;
    const v = +$("bet-input").value;
    const pot = v * 2, fee = pot * 0.1, win = pot - fee;
    el.innerHTML = "Both stake " + usd(v) + " → pot <strong>" + usd(pot) +
      "</strong> · winner gets <strong>" + usd(win) + "</strong> · house keeps " + usd(fee) + " (10%)";
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
    if (window.Chiptune) window.Chiptune.start(), syncSoundBtn();
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
      // Show Host tools to the contract owner OR the locked house wallet — so the
      // house can always reach "Start a fresh game" even on a game someone else deployed.
      if (eq(account, ownerAddr) || eq(account, ART.defaultTreasury)) $("host-tools").hidden = false;
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

  async function refreshHostPanel() {
    const card = $("host-stats-card");
    if (!card) return;
    const isHost = account && hostTreasury && eq(account, hostTreasury);
    card.classList.toggle("hidden", !isHost);
    if (!isHost || !read || !chainOK) return;
    try {
      const [fees, games, wagered, bankroll, bal, rooms] = await Promise.all([
        read.totalFeesCollected(), read.totalGamesPlayed(), read.totalWagered(),
        read.houseBankroll(), read.balances(account), recentRooms(150),
      ]);
      const gamesN = Number(games);
      const holdings = bankroll + bal; // ALL the house's money in the contract
      const nowSec = Math.floor(Date.now() / 1000);
      const periodSec = HS_PERIOD_SEC[hostPeriod] ?? 86400;

      // Sum the house's results over the period from settled games:
      //  rake  = 10% of every pot (credited to your balance, all game types)
      //  table = vs-house gamble: win +0.8·bet, loss −bet (bankroll swing)
      let pFees = 0n, pTable = 0n, pGames = 0, pWagered = 0n;
      for (const r of rooms) {
        if (Number(r.status) !== 2) continue; // settled only
        if (periodSec && Number(r.settledAt) < nowSec - periodSec) continue;
        const bet = r.betAmount;
        pFees += (bet * 2n) / 10n;
        if (r.isHouseGame) pTable += eq(r.winner, hostTreasury) ? (bet * 8n) / 10n : -bet;
        pGames += 1;
        pWagered += bet * 2n;
      }
      const pGrand = pFees + pTable;

      $("hs-period-label").textContent = "Grand total · " + (HS_PERIOD_LABEL[hostPeriod] || "last 24h");
      const pe = $("hs-profit-today");
      pe.textContent = signedUsd(pGrand);
      pe.style.color = pGrand < 0n ? "#ff7a7a" : "#34e39b";
      $("hs-profit-sub").textContent = pGames + " game" + (pGames === 1 ? "" : "s") + " · " + usdOf(pWagered) + " wagered";
      $("hs-period-fees").textContent = signedUsd(pFees);
      $("hs-period-table").textContent = signedUsd(pTable);
      $("hs-fees-total").textContent = usdOf(fees);
      $("hs-games-total").textContent = games.toString();
      $("hs-volume-total").textContent = usdOf(wagered);
      $("hs-take").textContent = (wagered > 0n ? Number((fees * 10000n) / wagered) / 100 : 0).toFixed(1) + "%";
      $("hs-avg").textContent = gamesN > 0 ? usdOf(wagered / (2n * games)) : "$0";
      $("hs-bankroll").textContent = usdOf(bankroll);
      $("hs-balance").textContent = usdOf(holdings); // unified "house funds" = bankroll + balance
    } catch {}
  }

  // Warn when the connected wallet is the house itself (you'd be on both sides).
  function updateHouseWalletBanner() {
    const el = $("house-wallet-banner");
    if (!el) return;
    const isHouse = account && hostTreasury && eq(account, hostTreasury);
    el.classList.toggle("hidden", !isHouse);
  }

  async function startGameUI() {
    renderWallet();
    wireEvents();
    connectWS();
    updateHouseWalletBanner();
    loadHostHistory();
    await refreshAll();
    seedHostHistory(); // backfill host-table flips from logs (async, best-effort)
    checkDailyStreak();
    renderInvite();
    { const r = $("registry-target"); if (r && !r.value && deployment.address) r.value = deployment.address; }
    TV.idle("Deposit ETH, then create or join a room");
    $("bankroll").hidden = false;
    $("play-house").hidden = false;
    $("maxbet-hint").textContent = "· $10–$" + betCapUsd().toLocaleString();
    setupHouseSlider();
  }

  function renderWallet() {
    $("connect-btn").classList.add("hidden");
    $("connect-btn").classList.remove("cta-pulse");
    $("disconnect-btn").classList.remove("hidden");
    const chip = $("wallet-chip");
    chip.classList.remove("hidden");
    $("wallet-addr").textContent = short(account);
    blockies(account, 8, 4, $("wallet-avatar"));
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
  function showHostSetup() { $("host-setup").hidden = false; }
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
      // 6M covers the now-larger contract (flip + host tables + dice); Sepolia
      // blocks are 30M so there's ample headroom (a too-low limit = failed deploy).
      const c = await factory.deploy(houseWallet, { gasLimit: 6_000_000n });
      await c.waitForDeployment();
      const addr = await c.getAddress();
      deployment = { address: addr, chainId: Number(net.chainId) };
      saveStored(deployment);
      contract = c.connect(signer);
      read = new E.Contract(addr, ABI, provider);
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
      toast("Funding the house… confirm in MetaMask");
      const value = usdToWei(v);
      const tx = await contract.fundHouse({ value, gasLimit: await estGas("fundHouse", [], { value }, 150_000n) });
      await tx.wait();
      toast("House funded with " + usd(v), "ok");
      refreshHouse();
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
      "This mints a fresh contract on-chain (the latest version). Your balance stays " +
      "in the OLD game — use 'Withdraw all' first if you want it back.\n\n" +
      "When it finishes you'll get the new contract address to copy — send it over and " +
      "the live site will be pointed at it for everyone."
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
  window.__onTvReveal = unlockReveal;

  async function refreshBalances() {
    try {
      const [gb, wb] = await Promise.all([read.balances(account), provider.getBalance(account)]);
      if (!revealLock) $("game-balance").textContent = usdOf(gb); // hold until the result is revealed
      $("wallet-balance").textContent = usdOf(wb);
      walletWei = wb;
      syncDepositSlider();
    } catch {}
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
        hint.innerHTML = 'No test ETH? <a href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noopener">Get free Sepolia ETH ↗</a>';
      } else {
        hint.textContent = walletWei > 0n
          ? "Max ≈ " + usd(weiToUsd(depositableWei())) + " (a little ETH kept for gas)"
          : "Slide all the way to deposit your wallet max";
      }
    }
    setSliderUsd("deposit-input");
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
    try {
      toast("Confirm the deposit in MetaMask…");
      const tx = await contract.deposit({ value, gasLimit: await estGas("deposit", [], { value }, 130_000n) });
      await tx.wait();
      toast("Deposited " + usd(weiToUsd(value)), "ok");
      refreshBalances();
    } catch (e) { txErr(e); }
  }

  async function withdrawAll() {
    if (!ready()) return;
    try {
      toast("Confirm the withdrawal…");
      const tx = await contract.withdrawAll();
      await tx.wait();
      toast("Withdrawn to your wallet", "ok");
      refreshBalances();
    } catch (e) { txErr(e); }
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
      unlockReveal();
      TV.idle("Deposit ETH, then create or join a room");
      txErr(e);
    }
  }

  // Clicking "Flip vs House" opens the bet-confirmation modal (drag-chosen stake).
  async function playHouse() {
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
    openBetModal({ kind: "house", bet: bet, heads: sideOf("house-side") });
  }

  async function doPlayHouse(bet, wantsHeads) {
    // Instant feedback: spin the coin + show the "confirm in wallet" banner the
    // moment they accept, so the wait for the wallet popup isn't a dead screen.
    lastRevealed = null;
    activeRoomId = null;
    lockReveal();
    TV.startFlip({ p1: account, p2: "HOUSE", p1Heads: wantsHeads });
    tvPending(true);
    toast("Sending your bet… confirm in your wallet", "ok");
    try {
      // Learn the room id up-front so the result reveal can't race ahead of us.
      let predicted;
      try {
        predicted = await contract.playHouse.staticCall(bet, wantsHeads);
      } catch (e) {
        tvPending(false); unlockReveal(); TV.idle("Deposit ETH, then create or join a room");
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
      unlockReveal();
      TV.idle("Deposit ETH, then create or join a room");
      txErr(e);
    }
  }

  async function refreshHouse() {
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
      $("pt-sub").textContent = "Flip against " + short(hr.creator) + "'s bank — you're HEADS. The host keeps 10%.";
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
    doPlayTable(currentTable.id, bet, sideOf("table-side"));
  }

  async function doPlayTable(id, bet, wantsHeads) {
    activeRoomId = null; lastRevealed = null;
    lockReveal();
    TV.startFlip({ p1: account, p2: "HOST", p1Heads: wantsHeads });
    tvPending(true);
    toast("Sending your bet… confirm in your wallet", "ok");
    try {
      let predicted;
      try { predicted = await contract.playHostRoom.staticCall(id, bet, wantsHeads); }
      catch (e) { tvPending(false); unlockReveal(); TV.idle("Deposit ETH, then create or join a room"); return txErr(e); }
      const tx = await contract.playHostRoom(id, bet, wantsHeads, { gasLimit: 500000n });
      const rcpt = await tx.wait();
      tvPending(false);
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "HostFlip");
      const playerWon = ev ? ev.args.playerWon : predicted;
      const betAmt = ev ? ev.args.betAmount : bet;
      const rv = flipReveal(betAmt, playerWon);
      const coinHeads = playerWon ? wantsHeads : !wantsHeads; // the coin's actual face
      setLastResult({ won: playerWon, side: coinHeads ? "HEADS" : "TAILS", amountUsd: rv.amountUsd, amountWei: rv.amountWei, betWei: betAmt, label: "Host table" });
      if (playerWon && window.WinScenes) WinScenes.play({ amountUsd: weiToUsd(rv.netWei), side: coinHeads ? "HEADS" : "TAILS" });
      TV.revealResult({
        side: coinHeads ? "HEADS" : "TAILS",
        youWon: playerWon,
        role: "participant",
        amountUsd: playerWon ? weiToUsd(rv.netWei) : rv.amountUsd,
        tier: rv.tier,
        sub: playerWon ? "YOU WON! Net profit shown — your stake came back too (10% to host)" : "You lost your stake — it went to the host",
      });
      addHostGame({ label: "Host table", won: playerWon, amount: rv.amountWei.toString(), net: rv.netWei.toString(), ts: Math.floor(Date.now() / 1000), tx: rcpt.hash });
      refreshBalances(); refreshTableInfo(); refreshPlayers(); refreshMyHistory();
    } catch (e) {
      tvPending(false);
      unlockReveal();
      TV.idle("Deposit ETH, then create or join a room");
      txErr(e);
    }
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
  const HARD_MAX_USD = 500;
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
    const fee = (pot * 1000n) / 10000n;
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
    if (d.accepted) {
      toast("Host accepted! Joining at " + usdOf(BigInt(d.amount)) + "…", "ok");
      read.getRoom(d.roomId).then((r) => doJoinRoom(String(d.roomId), r, BigInt(d.amount)));
    } else {
      toast("Host denied — pick another amount and propose again", "err");
      read.getRoom(d.roomId).then((r) => { if (Number(r.status) === 0) joinRoom(String(d.roomId), r); });
    }
    myProposal = null;
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
        if (youWon && window.WinScenes) WinScenes.play({ amountUsd: weiToUsd(rv.netWei), side });
        TV.revealResult({
          side,
          youWon,
          role: "participant",
          amountUsd: youWon ? weiToUsd(rv.netWei) : rv.amountUsd,
          tier: rv.tier,
          sub: youWon ? "YOU WON! Net profit shown — your stake came back too (10% to house)" : "You lost your stake — the pot went to the other side",
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
  function renderChatLine(from, text) {
    const log = $("chat-log");
    const isHost = hostTreasury && eq(from, hostTreasury);
    const sys = log.querySelector(".chat-sys");
    if (sys) sys.remove();
    const line = document.createElement("div");
    line.className = "chat-line " + (isHost ? "host" : "visitor");
    const h = document.createElement("span");
    h.className = "chat-handle";
    h.textContent = short(from) + (isHost ? "(host)" : "") + ":";
    const t = document.createElement("span");
    t.className = "chat-text";
    t.textContent = " " + text;
    line.appendChild(h); line.appendChild(t);
    log.appendChild(line);
    while (log.children.length > 80) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
  function sendChat() {
    const inp = $("chat-input");
    const text = inp.value.trim();
    if (!text) return;
    if (!account) return toast("Connect a wallet to chat", "err");
    wsSend({ type: "chat", text: text });
    inp.value = "";
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
  };
  function txErr(e) {
    console.error(e);
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
      const bet = r.betAmount, pot = bet * 2n, netWin = pot - pot / 10n - bet;
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
        read.getRoom(id).then((r) => TV.startFlip({ p1: r.player1, p2: r.player2, p1Heads: r.creatorHeads }));
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
    try {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen = () => { wsTries = 0; wsSend({ type: "hello", address: account }); };
      ws.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (d.type === "players") { wsPlayers = d.players || []; renderRoster(); }
        else if (d.type === "rooms-updated" || d.type === "flip") { refreshRooms(); refreshPlayers(); reconcile(); }
        else if (d.type === "chat") renderChatLine(d.from, d.text);
        else if (d.type === "bet-proposal") handleProposal(d);
        else if (d.type === "bet-response") handleProposalResponse(d);
      };
      // Retry a few times, then give up (e.g. static host with no chat server).
      ws.onclose = () => { if (wsTries++ < 5) setTimeout(connectWS, 2500); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    } catch (e) { console.warn("ws unavailable", e); }
  }
  function wsSend(obj) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch {} }

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
      li.className = "lb-item" + (mine ? " me" : "");
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
      li.className = "player-item";
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
        const pot = a.betAmount * 2n;
        const payout = pot - pot / 10n;
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
        const pot = r.betAmount * 2n;
        const payout = pot - pot / 10n;
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
  function syncSoundBtn() {
    const on = window.Chiptune && window.Chiptune.isOn();
    const btn = $("sound-btn");
    btn.textContent = on ? "🔊 Music: On" : "🔇 Music: Off";
    btn.classList.toggle("btn-primary", on);
    btn.classList.toggle("btn-ghost", !on);
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
    $("raise-max-btn").onclick = raiseMaxBet;
    $("fund-house-btn").onclick = fundHouseTool;
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
    $("withdraw-btn").onclick = withdrawAll;
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
    $("deposit-input").oninput = () => setSliderUsd("deposit-input");
    $("host-bank").oninput = () => setSliderUsd("host-bank");
    $("table-bet").oninput = () => setSliderUsd("table-bet");
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
    // ---- Keyboard hotkeys (skip while typing) ----
    document.addEventListener("keydown", (e) => {
      const el = e.target, tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const betOpen = !$("bet-modal").classList.contains("hidden");
      if (k === "escape") { closeBetModal(); $("help-modal").classList.add("hidden"); $("nego-modal").classList.add("hidden"); return; }
      if (k === " " || k === "enter") {
        e.preventDefault();
        if (betOpen) $("bet-accept").click();            // confirm the open bet
        else if (!$("play-house").hidden) $("play-house-btn").click(); // flip vs house
        return;
      }
      if (betOpen) return;
      if (k === "h") setHotSide(true);
      else if (k === "t") setHotSide(false);
      else if (k === "+" || k === "=" || k === "arrowup") { e.preventDefault(); stepHouseBet(5); }
      else if (k === "-" || k === "_" || k === "arrowdown") { e.preventDefault(); stepHouseBet(-5); }
    });
    $("help-btn").onclick = () => $("help-modal").classList.remove("hidden");
    $("help-close").onclick = () => $("help-modal").classList.add("hidden");
    $("help-modal").onclick = (e) => { if (e.target === $("help-modal")) $("help-modal").classList.add("hidden"); };
    $("sound-btn").onclick = () => {
      if (!window.Chiptune) return;
      const on = window.Chiptune.toggle();
      userMutedMusic = !on;
      syncSoundBtn();
    };

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

  window.addEventListener("DOMContentLoaded", () => {
    TV.init();
    wireUI();
    syncSoundBtn();
    setupSliders();
    setupReadOnly();
    renderInvite();
    // Register the PWA service worker (after load, best-effort).
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => { try { navigator.serviceWorker.register("sw.js"); } catch (e) {} });
    }
    // Start the music on the first tap/touch (mobile + desktop block autoplay
    // until a user gesture). Skips if the user has explicitly muted.
    // Fire on the COMPLETED gesture (touchend/click) — iOS won't unlock audio on
    // touchstart. Persistent so each tap re-kicks until it actually plays.
    const armMusic = () => {
      if (userMutedMusic || !window.Chiptune) return;
      window.Chiptune.start(); // resumes + (re)starts; safe to call repeatedly
      syncSoundBtn();
    };
    ["touchend", "click", "keydown"].forEach((ev) =>
      window.addEventListener(ev, armMusic, { passive: true })
    );
    // Live ETH→USD price: fetch now, refresh labels, and re-poll every 60s.
    fetchEthUsd().then(() => { setupSliders(); if (read && chainOK) { refreshBalances(); refreshStats(); refreshHouse(); refreshRooms(); } });
    setInterval(() => { if (document.hidden) return; fetchEthUsd().then(() => { setupSliders(); if (read && chainOK) { refreshBalances(); refreshStats(); refreshHouse(); refreshRooms(); } }); }, 60000);
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
