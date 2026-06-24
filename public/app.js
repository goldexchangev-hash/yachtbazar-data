/* ============================================================
   app.js — wallet, contract, lobby and the glue that drives the TV.
   ============================================================ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cfg = window.COINFLIP_CONFIG || {};
  const E = window.ethers;

  // ---- state ----
  let provider = null; // ethers BrowserProvider
  let signer = null;
  let account = null;
  let contract = null; // connected to signer
  let read = null; // connected to provider
  let maxBet = 0n;
  let chainOK = false;
  let activeRoomId = null; // a room I'm a participant in, currently live
  let ws = null;
  let inviteRoomId = new URLSearchParams(location.search).get("room");

  const fmt = (wei) => {
    try { return (+E.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 5 }); }
    catch { return "0"; }
  };
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
  const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

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

  const NETWORKS = {
    31337: { chainId: "0x7a69", chainName: "Hardhat Local", rpcUrls: ["http://127.0.0.1:8545"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
    11155111: { chainId: "0xaa36a7", chainName: "Sepolia", rpcUrls: ["https://rpc.sepolia.org"], nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://sepolia.etherscan.io"] },
  };
  const explorerBase = cfg.chainId === 11155111 ? "https://sepolia.etherscan.io/address/" : null;

  // ---------------------------------------------------------- connect
  async function connect() {
    if (!window.ethereum) {
      toast("MetaMask not found — install it to play.", "err");
      window.open("https://metamask.io/download/", "_blank");
      return;
    }
    if (window.Chiptune) window.Chiptune.start(), syncSoundBtn();
    try {
      provider = new E.BrowserProvider(window.ethereum, "any");
      provider.pollingInterval = 2000; // tighter polling for events on injected providers
      await provider.send("eth_requestAccounts", []);
      await ensureNetwork();
      signer = await provider.getSigner();
      account = await signer.getAddress();

      if (!cfg.address) {
        banner("⚠ Contract not deployed yet. Run  npm run deploy:local  (or deploy:sepolia), then reload.", true);
        renderWallet();
        return;
      }
      contract = new E.Contract(cfg.address, cfg.abi, signer);
      read = new E.Contract(cfg.address, cfg.abi, provider);
      maxBet = await read.maxBet();

      renderWallet();
      wireEvents();
      connectWS();
      await refreshAll();
      TV.idle("Deposit ETH, then create or join a room");
      $("bankroll").hidden = false;
      $("play-house").hidden = false;
      $("maxbet-hint").textContent = "· max " + fmt(maxBet) + " ETH";
      setupHouseSlider();
      if (inviteRoomId) handleInvite();
    } catch (err) {
      console.error(err);
      toast(err?.info?.error?.message || err?.shortMessage || "Connection failed", "err");
    }
  }

  async function ensureNetwork() {
    const net = await provider.getNetwork();
    if (Number(net.chainId) === cfg.chainId) { chainOK = true; return; }
    chainOK = false;
    const target = NETWORKS[cfg.chainId];
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target.chainId }] });
    } catch (e) {
      if (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902)) {
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [target] });
      } else {
        throw e;
      }
    }
    // re-create provider on the new chain
    provider = new E.BrowserProvider(window.ethereum, "any");
    provider.pollingInterval = 2000;
    const net2 = await provider.getNetwork();
    chainOK = Number(net2.chainId) === cfg.chainId;
  }

  function renderWallet() {
    $("connect-btn").classList.add("hidden");
    $("connect-btn").classList.remove("cta-pulse");
    const chip = $("wallet-chip");
    chip.classList.remove("hidden");
    $("wallet-addr").textContent = short(account);
    blockies(account, 8, 4, $("wallet-avatar"));
    const nb = $("net-badge");
    nb.classList.remove("hidden");
    nb.classList.toggle("wrong", !chainOK);
    $("net-name").textContent = chainOK ? (cfg.network || "Connected") : "Wrong network";
    if (explorerBase && cfg.address) {
      const a = $("contract-link"); a.href = explorerBase + cfg.address; a.textContent = short(cfg.address);
    } else if (cfg.address) {
      $("contract-link").textContent = short(cfg.address);
    }
  }

  // ---------------------------------------------------------- reads / render
  async function refreshAll() {
    if (!read || !chainOK) return;
    await Promise.all([refreshBalances(), refreshRooms(), refreshStats(), refreshHouse()]);
  }

  async function refreshBalances() {
    try {
      const [gb, wb] = await Promise.all([read.balances(account), provider.getBalance(account)]);
      $("game-balance").textContent = fmt(gb) + " ETH";
      $("wallet-balance").textContent = fmt(wb) + " ETH";
    } catch {}
  }

  async function refreshStats() {
    try {
      const [g, w, f] = await Promise.all([read.totalGamesPlayed(), read.totalWagered(), read.totalFeesCollected()]);
      $("stat-games").textContent = g.toString();
      $("stat-wagered").textContent = fmt(w) + " ETH";
      $("stat-fees").textContent = fmt(f) + " ETH";
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
          `<span class="rbet">${fmt(r.betAmount)} Ξ</span>`;
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
  async function deposit() {
    const v = parseFloat($("deposit-input").value);
    if (!(v > 0)) return toast("Enter an amount to deposit", "err");
    try {
      toast("Confirm the deposit in MetaMask…");
      const tx = await contract.deposit({ value: E.parseEther(String(v)) });
      await tx.wait();
      toast("Deposited " + v + " ETH", "ok");
      refreshBalances();
    } catch (e) { txErr(e); }
  }

  async function withdrawAll() {
    try {
      toast("Confirm the withdrawal…");
      const tx = await contract.withdrawAll();
      await tx.wait();
      toast("Withdrawn to your wallet", "ok");
      refreshBalances();
    } catch (e) { txErr(e); }
  }

  async function createRoom() {
    const name = ($("room-name").value || "Coin Flip").trim();
    const v = parseFloat($("bet-input").value);
    if (!(v > 0)) return toast("Enter a bet amount", "err");
    const bet = E.parseEther(String(v));
    if (bet > maxBet) return toast("Max bet is " + fmt(maxBet) + " ETH", "err");
    try {
      toast("Creating room… confirm in MetaMask");
      const tx = await contract.createRoom(bet, name);
      const rcpt = await tx.wait();
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "RoomCreated");
      const id = ev ? ev.args.roomId.toString() : null;
      toast("Room created!", "ok");
      if (id) showShareLink(id);
      activeRoomId = id;
      TV.waiting({ p1: account, sub: "Share your link · waiting for a challenger" });
      refreshBalances(); refreshRooms();
      wsSend({ type: "rooms-updated", roomId: id });
    } catch (e) { txErr(e); }
  }

  // Clicking "Join" opens the bet-confirmation modal (with an optional raise).
  function joinRoom(id, room) {
    openBetModal({ kind: "join", id: id, room: room, bet: room.betAmount });
  }

  async function doJoinRoom(id, room, bet) {
    try {
      activeRoomId = id;
      lastRevealed = null;
      TV.startFlip({ p1: room ? room.creator : null, p2: account });
      const tx = await contract.joinRoom(id);
      await tx.wait();
      toast("You're in! Flipping…", "ok");
      refreshBalances(); refreshRooms();
      wsSend({ type: "flip", roomId: id });
    } catch (e) {
      activeRoomId = null;
      TV.idle("Deposit ETH, then create or join a room");
      txErr(e);
    }
  }

  // Clicking "Flip vs House" opens the bet-confirmation modal (drag-chosen stake).
  function playHouse() {
    const v = parseFloat($("house-bet").value);
    if (!(v > 0)) return toast("Drag to pick a stake", "err");
    const bet = E.parseEther(String(v));
    if (bet > maxBet) return toast("Max bet is " + fmt(maxBet) + " ETH", "err");
    // The house must be able to match your stake from its bankroll.
    const cap = E.parseEther(String($("house-bet").max || "0"));
    if (bet > cap) return toast("House can only cover " + fmt(cap) + " ETH right now", "err");
    openBetModal({ kind: "house", bet: bet });
  }

  async function doPlayHouse(bet) {
    try {
      // Pre-validate AND learn the room id up-front so the result reveal can't
      // race ahead of us (VRF can settle near-instantly on a local chain).
      let predicted;
      try {
        predicted = await contract.playHouse.staticCall(bet);
      } catch (e) {
        return txErr(e);
      }
      activeRoomId = predicted.toString();
      lastRevealed = null;
      toast("Flipping vs the house… confirm in MetaMask");
      TV.startFlip({ p1: account, p2: "HOUSE" });
      const tx = await contract.playHouse(bet);
      const rcpt = await tx.wait();
      const ev = rcpt.logs.map((l) => safeParse(l)).find((p) => p && p.name === "HouseGameStarted");
      if (ev) activeRoomId = ev.args.roomId.toString();
      refreshBalances(); refreshHouse(); refreshStats();
      wsSend({ type: "flip", roomId: activeRoomId });
    } catch (e) {
      activeRoomId = null;
      TV.idle("Deposit ETH, then create or join a room");
      txErr(e);
    }
  }

  async function refreshHouse() {
    try {
      const b = await read.houseBankroll();
      $("house-bankroll").textContent = fmt(b) + " ETH";
      // House bets can't exceed what the bankroll can match.
      const cap = b < maxBet ? b : maxBet;
      const s = $("house-bet");
      s.max = (+E.formatEther(cap)).toFixed(3);
      if (+s.value > +s.max) { s.value = s.max; $("house-bet-val").textContent = (+s.value).toFixed(3); }
    } catch {}
  }

  function setupHouseSlider() {
    const s = $("house-bet");
    s.min = "0.001";
    s.max = (+E.formatEther(maxBet)).toFixed(3);
    s.step = "0.001";
    if (+s.value > +s.max) s.value = s.max;
    $("house-bet-val").textContent = (+s.value).toFixed(3);
  }

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
      s.min = (+E.formatEther(opts.room.betAmount)).toFixed(3); // can't go below the host's bet
      s.max = (+E.formatEther(maxBet)).toFixed(3);
      s.step = "0.001";
      s.value = (+E.formatEther(opts.bet)).toFixed(3);
    } else {
      raise.classList.add("hidden");
    }
    updateBetModalAmount(opts.bet);
    $("bet-modal").classList.remove("hidden");
  }
  function closeBetModal() { $("bet-modal").classList.add("hidden"); }

  function updateBetModalAmount(bet) {
    if (!pendingBet) return;
    pendingBet.bet = bet;
    const { pot, fee, win } = breakdown(bet);
    $("bd-yourbet").textContent = fmt(bet) + " ETH";
    $("bd-oppbet").textContent = fmt(bet) + " ETH";
    $("bd-pot").textContent = fmt(pot) + " ETH";
    $("bd-fee").textContent = fmt(fee) + " ETH";
    $("bd-win").textContent = fmt(win) + " ETH";
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
    if (p.kind === "house") return doPlayHouse(p.bet);
    if (p.bet > p.room.betAmount) return proposeBet(p.id, p.room, p.bet);
    doJoinRoom(p.id, p.room, p.bet);
  }

  // --- joiner proposes a higher bet; host approves/denies over the socket ---
  function proposeBet(id, room, amount) {
    myProposal = { id: String(id), amount: amount.toString(), room: room };
    toast("Proposed " + fmt(amount) + " ETH to the host — waiting…");
    wsSend({ type: "bet-proposal", roomId: String(id), amount: amount.toString() });
  }

  async function handleProposal(d) {
    try {
      const r = await read.getRoom(d.roomId);
      if (!eq(r.creator, account) || Number(r.status) !== 0) return; // not my room / not open
      pendingProposal = { roomId: String(d.roomId), amount: BigInt(d.amount), proposer: d.from };
      $("nego-text").innerHTML =
        escapeHtml(short(d.from)) + " wants to bet <b>" + fmt(BigInt(d.amount)) +
        " ETH</b> (your room is " + fmt(r.betAmount) + " ETH). Accept to raise the stake for both of you.";
      $("nego-modal").classList.remove("hidden");
    } catch (e) { console.error(e); }
  }

  async function negoAccept() {
    const p = pendingProposal;
    $("nego-modal").classList.add("hidden");
    if (!p) return;
    try {
      toast("Raising the room bet… confirm in MetaMask");
      const tx = await contract.updateRoomBet(p.roomId, p.amount);
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
      toast("Host accepted! Joining at " + fmt(BigInt(d.amount)) + " ETH…", "ok");
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
        TV.revealResult({
          side,
          youWon,
          role: "participant",
          sub: youWon ? "You won the pot (minus 10% house)" : "The other side won · house kept 10%",
        });
        activeRoomId = null;
        refreshBalances(); refreshHouse(); refreshStats(); refreshRooms();
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
    const isHost = cfg.treasury && eq(from, cfg.treasury);
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
  };
  function txErr(e) {
    console.error(e);
    const blob = [e?.revert?.name, e?.shortMessage, e?.reason, e?.info?.error?.message, e?.message]
      .filter(Boolean)
      .join(" ");
    for (const k of Object.keys(FRIENDLY_ERR)) if (blob.includes(k)) return toast(FRIENDLY_ERR[k], "err");
    if (e?.code === "ACTION_REJECTED" || /user (rejected|denied)/i.test(blob))
      return toast("You cancelled the transaction.", "err");
    const m = e?.shortMessage || e?.reason || e?.message || "Transaction failed";
    toast(m.length > 90 ? m.slice(0, 90) + "…" : m, "err");
  }
  function safeParse(log) { try { return contract.interface.parseLog(log); } catch { return null; } }

  // ---------------------------------------------------------- share link
  function shareUrlFor(id) {
    let base = location.origin;
    if (window.__PUBLIC_HOST) {
      const port = location.port ? ":" + location.port : "";
      base = `${location.protocol}//${window.__PUBLIC_HOST}${port}`;
    }
    return `${base}/?room=${id}`;
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
    read.on(read.filters.PlayerJoined(), (roomId) => {
      const id = roomId.toString();
      refreshRooms();
      if (activeRoomId === id) {
        // someone joined MY open room -> start the broadcast for me
        read.getRoom(id).then((r) => TV.startFlip({ p1: r.player1, p2: r.player2 }));
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
  function connectWS() {
    try {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen = () => wsSend({ type: "hello", address: account });
      ws.onmessage = (ev) => {
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (d.type === "players") renderPlayers(d.players || []);
        else if (d.type === "rooms-updated" || d.type === "flip") { refreshRooms(); reconcile(); }
        else if (d.type === "chat") renderChatLine(d.from, d.text);
        else if (d.type === "bet-proposal") handleProposal(d);
        else if (d.type === "bet-response") handleProposalResponse(d);
      };
      ws.onclose = () => setTimeout(connectWS, 2500);
    } catch (e) { console.warn("ws unavailable", e); }
  }
  function wsSend(obj) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch {} }

  function renderPlayers(players) {
    const ul = $("players-list");
    $("players-count").textContent = players.length;
    if (!players.length) { ul.innerHTML = '<li class="empty">No one tuned in yet.</li>'; return; }
    ul.innerHTML = "";
    for (const p of players) {
      const li = document.createElement("li");
      li.className = "player-item";
      const c = document.createElement("canvas");
      blockies(p, 8, 3, c);
      li.appendChild(c);
      const name = document.createElement("span");
      name.className = "pname"; name.textContent = short(p);
      li.appendChild(name);
      if (eq(p, account)) { const you = document.createElement("span"); you.className = "pyou"; you.textContent = "YOU"; li.appendChild(you); }
      ul.appendChild(li);
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

  function wireUI() {
    $("connect-btn").onclick = connect;
    $("deposit-btn").onclick = deposit;
    $("withdraw-btn").onclick = withdrawAll;
    $("create-room-btn").onclick = createRoom;
    $("play-house-btn").onclick = playHouse;
    $("refresh-rooms").onclick = () => refreshRooms();

    // House stake slider (live value)
    $("house-bet").oninput = (e) => ($("house-bet-val").textContent = (+e.target.value).toFixed(3));
    // Join raise slider (live value + recompute pot breakdown)
    $("join-bet").oninput = (e) => {
      const val = (+e.target.value).toFixed(3);
      $("join-bet-val").textContent = val;
      updateBetModalAmount(E.parseEther(val));
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
    $("copy-link-btn").onclick = () => {
      const inp = $("share-link"); inp.select();
      navigator.clipboard?.writeText(inp.value).then(() => toast("Link copied!", "ok"), () => {});
    };
    $("help-btn").onclick = () => $("help-modal").classList.remove("hidden");
    $("help-close").onclick = () => $("help-modal").classList.add("hidden");
    $("help-modal").onclick = (e) => { if (e.target === $("help-modal")) $("help-modal").classList.add("hidden"); };
    $("sound-btn").onclick = () => { if (window.Chiptune) { window.Chiptune.toggle(); syncSoundBtn(); } };

    if (window.ethereum) {
      window.ethereum.on?.("accountsChanged", () => location.reload());
      window.ethereum.on?.("chainChanged", () => location.reload());
    }
    // learn our public share host (if the server was started with PUBLIC_HOST)
    fetch("/api/info").then((r) => r.json()).then((d) => { if (d.publicHost) window.__PUBLIC_HOST = d.publicHost; }).catch(() => {});

    // periodic lobby refresh + TV reveal reconciler (safety net for missed events)
    setInterval(() => {
      if (chainOK && read) { refreshRooms(); refreshBalances(); refreshHouse(); reconcile(); }
    }, 3000);
  }

  // ---------------------------------------------------------- boot
  window.addEventListener("DOMContentLoaded", () => {
    TV.init();
    wireUI();
    syncSoundBtn();
    $("connect-btn").classList.add("cta-pulse");
    const remoteHost = location.hostname && !/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/.test(location.hostname);
    if (!cfg.address) {
      banner("⚠ Contract not deployed yet. Run  npm run deploy:local  then reload this page.", true);
    } else if (cfg.chainId === 31337 && remoteHost) {
      banner(
        "⚠ This game runs on a LOCAL test chain that only works on the host's own computer. " +
          "To play from another device, ask the host to deploy to the Sepolia testnet.",
        true
      );
    }
    if (inviteRoomId) toast("You've been invited to room #" + inviteRoomId + " — connect to join.");
  });
})();
