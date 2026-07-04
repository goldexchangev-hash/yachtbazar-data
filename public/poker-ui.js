/* ============================================================
   poker-ui.js — THE FELT (Phase 4). window.PokerUI = a THIN RENDERER of the
   server's per-viewer masked snapshots (pk:state). It holds NO game logic, NO
   deck, and receives NO hole cards for any seat but the viewer (the server sends
   null for other seats' `hole`). Every action is validated server-side; the
   client legality gate below is COSMETIC (it only decides which controls to show).

   Wired via poker-net.js (PokerNet, pk: protocol, hello + heartbeat + resume).
   Visual language matches baccarat (public/baccarat.css tokens): the --pixel
   display font, the neon palette, glowing chips, big cards, quiet losses, and a
   satisfying pot-push win animation. Fullscreen reuses FsUtil (fullscreen-util.js):
   portrait = controls at the bottom, landscape = a right side-rail.

   PUBLIC API (called by app.js):
     PokerUI.init({ wallet, tokenSession, usd, toast, onBalance })  — bind identity
     PokerUI.show()   — reveal #poker-view + connect the socket + subscribe lobby
     PokerUI.hide()   — hide the view (socket kept warm for a fast return)
   ============================================================ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SUIT = ["♠", "♥", "♦", "♣"]; // ♠ ♥ ♦ ♣ (matches poker-server.js SUITS)
  const RANKL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  const rankLabel = (r) => RANKL[r] || String(r);
  const SEATS = 9;                 // ring capacity (casino-standard full ring)
  const FELT_W = 900, FELT_H = 620; // the 9-seat oval is wider than baccarat's 720×540 (see notes)
  const STAKES = [2, 5, 10, 25, 50, 100];

  // ---- identity / config (bound by app.js init) --------------------------
  let cfg = {
    wallet: null, tokenSession: null, // { sessionId, sessionToken } for real-money tables
    usd: (n) => "$" + Math.round(Number(n) || 0),
    toast: (m) => { try { console.log(m); } catch (e) {} },
    onBalance: () => {},              // (units) → let app.js mirror the chip balance
  };
  let net = null;                    // PokerNet
  let mounted = false, shown = false;
  let myWallet = null;               // the identity we render holes for
  let state = null;                  // last pk:state for the table we're at
  let atTableId = null;              // the table our seat/watch is on
  let mySeatIndex = -1;
  let balanceUnits = 0;              // server-authoritative wallet (pk:wallet)
  let lobbyRooms = [];
  let lastServerNow = 0, lastActDeadline = 0, rttSkew = 0; // clock for the turn ring
  let timerRAF = null;
  let prevPhase = null, prevHandNo = null;
  const DEMO_CHIP_CAP = 20000; // owner: the RELOAD button stops at $20k (winnings may exceed it, reloads may not)

  // client-side lobby filters (cosmetic; the server holds the source of truth)
  const filt = { stakes: "all", hideFull: false, hidePrivate: false, kind: "all" };

  /* =========================================================================
     GEOMETRY — the salvaged ellipse seat ring (hero at bottom-center = seat idx 0)
     ========================================================================= */
  function seatPos(i, total) {
    const cx = 50, cy = 51, a = 45, b = 41;
    const ang = (90 - (360 / total) * i) * Math.PI / 180;
    return { left: cx + a * Math.cos(ang), top: cy + b * Math.sin(ang) };
  }
  // Rotate the ring so MY seat sits at the bottom-center; spectators use raw order.
  function ringIndexFor(seatIdx, total) {
    if (mySeatIndex < 0) return seatIdx;
    return ((seatIdx - mySeatIndex) % total + total) % total;
  }

  /* =========================================================================
     CARD ELEMENT (salvaged cardEl) — baccarat-styled face/back
     ========================================================================= */
  function cardEl(card, cls) {
    const d = document.createElement("div");
    if (!card) { d.className = "pkcard back " + (cls || ""); d.innerHTML = '<span class="pk-bk"></span>'; return d; }
    const red = card.suit === 1 || card.suit === 2;
    d.className = "pkcard " + (red ? "red" : "black") + " " + (cls || "");
    d.innerHTML =
      '<span class="pk-corner tl"><b>' + rankLabel(card.rank) + '</b><i>' + SUIT[card.suit] + '</i></span>' +
      '<span class="pk-pip">' + SUIT[card.suit] + '</span>' +
      '<span class="pk-corner br"><b>' + rankLabel(card.rank) + '</b><i>' + SUIT[card.suit] + '</i></span>';
    return d;
  }

  /* =========================================================================
     LEGAL ACTIONS — COSMETIC gate (server re-validates every pk:act).
     Derived from the viewer's own player in the masked snapshot + hand state.
     Mirrors poker-server.js ServerHand.legalActions math.
     ========================================================================= */
  function legalFor(hand) {
    if (!hand || hand.done || hand.toActId == null || hand.toActId !== myWallet) return { yourTurn: false };
    const me = hand.players.find((p) => p.id === myWallet);
    if (!me) return { yourTurn: false };
    const toCall = Math.max(0, hand.currentBet - me.committedStreet);
    const maxRaiseTo = me.committedStreet + me.stack;
    const minRaiseTo = hand.currentBet + hand.minRaise;
    const canRaise = me.stack > toCall && maxRaiseTo > hand.currentBet && me.mayRaise !== false; // mayRaise=false → a prior short all-in closed re-raising; hide RAISE (server would reject it)
    return {
      yourTurn: true, toCall, canCheck: toCall === 0, canCall: toCall > 0,
      callAmount: Math.min(toCall, me.stack),
      canBet: hand.currentBet === 0 && me.stack > 0,
      minBet: Math.min(hand.bb || hand.minRaise || 1, me.stack),
      canRaise, minRaiseTo: Math.min(minRaiseTo, maxRaiseTo), maxRaiseTo,
      committed: me.committedStreet, stack: me.stack, pot: hand.pot,
    };
  }

  /* =========================================================================
     MOUNT — build the static shell once
     ========================================================================= */
  function mount() {
    if (mounted) return;
    buildShell();
    wireStatic();
    mounted = true;
  }

  function buildShell() {
    const view = $("poker-view");
    if (!view) return;
    view.innerHTML =
      // ── LOBBY ──
      '<section class="pk-lobby" id="pk-lobby">' +
        '<div class="pk-lobby-head">' +
          '<div><h2><span class="pk-live-dot"></span>LIVE TABLES</h2>' +
          '<p>Create a table or grab a seat. You host — you earn 50% of your table’s rake.</p></div>' +
          '<div class="pk-lobby-actions">' +
            '<span class="pk-bal" id="pk-bal">$0</span>' +
            '<button class="pk-icon pk-reload" id="pk-reload" hidden title="Add $5,000 play-money chips">+ $5K CHIPS</button>' +
            '<button class="pk-chip pk-create" id="pk-open-create">+ CREATE TABLE</button>' +
          '</div>' +
        '</div>' +
        '<div class="pk-filters" id="pk-filters">' +
          '<label>Stakes <select id="pk-f-stakes"><option value="all">Any</option></select></label>' +
          '<label>Mode <select id="pk-f-kind"><option value="all">Any</option><option value="real">Real</option><option value="demo">Demo</option></select></label>' +
          '<label class="pk-check"><input type="checkbox" id="pk-f-full"> Hide full</label>' +
          '<label class="pk-check"><input type="checkbox" id="pk-f-priv"> Hide private</label>' +
        '</div>' +
        '<div class="pk-tables" id="pk-tables"><p class="pk-empty">Loading tables…</p></div>' +
      '</section>' +
      // ── FELT ──
      '<section class="pk-room" id="pk-room" hidden>' +
        '<div class="pk-room-top">' +
          '<button class="pk-icon" id="pk-back">↩ LOBBY</button>' +
          '<span class="pk-room-name" id="pk-room-name"></span>' +
          '<div class="pk-room-right">' +
            '<span class="pk-bal" id="pk-bal2">$0</span>' +
            '<button class="pk-icon pk-reload" id="pk-reload2" hidden title="Add $5,000 play-money chips">+ $5K</button>' +
            '<button class="pk-icon pk-host-btn" id="pk-host-btn" hidden>⚙ HOST</button>' +
            '<button class="pk-icon" id="pk-fs">⛶</button>' +
          '</div>' +
        '</div>' +
        '<div class="pk-stage-wrap" id="pk-stage-wrap">' +
          '<div class="pk-felt" id="pk-felt">' +
            '<div class="pk-felt-glow"></div>' +
            '<div class="pk-center">' +
              '<div class="pk-board" id="pk-board"></div>' +
              '<div class="pk-pot" id="pk-pot"></div>' +
              '<div class="pk-sidepots" id="pk-sidepots"></div>' +
              '<div class="pk-caption" id="pk-caption"></div>' +
            '</div>' +
            '<div class="pk-seats" id="pk-seats"></div>' +
            '<div class="pk-chipfx" id="pk-chipfx"></div>' +
          '</div>' +
          // hero dock: my hole cards + controls
          '<div class="pk-dock" id="pk-dock">' +
            '<div class="pk-hole" id="pk-hole"></div>' +
            '<div class="pk-controls" id="pk-controls"></div>' +
          '</div>' +
        '</div>' +
      '</section>' +
      // ── CREATE MODAL ──
      '<div class="pk-modal" id="pk-create-modal" hidden><div class="pk-modal-card">' +
        '<h3>Create a table</h3>' +
        '<label class="pk-fld">Name <input id="pk-c-name" maxlength="24" placeholder="My Hold’em Table"></label>' +
        '<label class="pk-fld">Stakes <select id="pk-c-bb"></select></label>' +
        '<div class="pk-fld-row">' +
          '<label class="pk-fld">Min buy-in (bb) <input id="pk-c-minbb" type="number" min="20" max="250" value="20"></label>' +
          '<label class="pk-fld">Max buy-in (bb) <input id="pk-c-maxbb" type="number" min="20" max="250" value="100"></label>' +
        '</div>' +
        '<label class="pk-fld">Max seats <span class="pk-seatval" id="pk-c-seatval">9</span>' +
          '<input id="pk-c-seats" type="range" min="2" max="9" step="1" value="9"></label>' +
        '<label class="pk-fld">Mode <select id="pk-c-kind"><option value="demo">Demo (play money)</option><option value="real">Real (token)</option></select></label>' +
        '<details class="pk-adv"><summary>Advanced</summary>' +
          '<label class="pk-fld">Rake % <button type="button" class="pk-help" data-help="rakepct" aria-label="What is rake?">?</button> <span id="pk-c-rakeval">5.0%</span>' +
            '<input id="pk-c-rake" type="range" min="100" max="500" step="25" value="500"></label>' +
          '<label class="pk-fld">Rake cap (bb) <button type="button" class="pk-help" data-help="rakecap" aria-label="What is the rake cap?">?</button> <input id="pk-c-rakecap" type="number" min="1" max="5" value="3"></label>' +
          '<p class="pk-help-note" id="pk-help-note" hidden></p>' +
          '<p class="pk-rake-note">Every raked pot is split 50 / 50: <b>you (the host) keep half</b>, and <b>the house takes the other half</b> to the platform treasury wallet. You only earn on hands you are not dealt into (after 3+ players).</p>' +
        '</details>' +
        '<label class="pk-check"><input type="checkbox" id="pk-c-priv"> Private table</label>' +
        '<label class="pk-fld pk-pw-fld" id="pk-c-pw-fld" hidden>Password <input id="pk-c-pw" maxlength="64" placeholder="password"></label>' +
        '<div class="pk-modal-btns">' +
          '<button class="pk-icon" id="pk-c-cancel">Cancel</button>' +
          '<button class="pk-chip pk-create" id="pk-c-go">Create &amp; sit</button>' +
        '</div>' +
      '</div></div>' +
      // ── BUY-IN MODAL ──
      '<div class="pk-modal" id="pk-buyin-modal" hidden><div class="pk-modal-card">' +
        '<h3 id="pk-buyin-title">Sit down</h3>' +
        '<p id="pk-buyin-sub">Buy in with your balance.</p>' +
        '<div class="pk-fld pk-pw-fld" id="pk-buyin-pw-fld" hidden><label>Password <input id="pk-buyin-pw" maxlength="64"></label></div>' +
        '<div class="pk-buyin-row"><input id="pk-buyin-range" type="range" min="0" max="100" step="1" value="50"><span class="pk-buyin-amt" id="pk-buyin-amt">$0</span></div>' +
        '<div class="pk-modal-btns">' +
          '<button class="pk-icon" id="pk-buyin-cancel">Cancel</button>' +
          '<button class="pk-chip pk-create" id="pk-buyin-go">Sit &amp; deal</button>' +
        '</div>' +
      '</div></div>' +
      // ── HOST PANEL ──
      '<div class="pk-modal" id="pk-host-modal" hidden><div class="pk-modal-card">' +
        '<h3>Host panel</h3>' +
        '<div class="pk-host-stat"><span>Your rake-share (accrued)</span><b id="pk-host-rake">$0.00</b></div>' +
        '<div class="pk-host-grid" id="pk-host-grid"></div>' +
        '<p class="pk-host-note">You earn 50% of raked pots on hands you are NOT dealt into, after your table has had 3+ players. Paid to your wallet.</p>' +
        '<div class="pk-modal-btns">' +
          '<button class="pk-icon" id="pk-host-close-panel">Close</button>' +
          '<button class="pk-icon pk-danger" id="pk-host-close-table">Close table</button>' +
        '</div>' +
      '</div></div>';

    // static seat frames (rotated in render)
    const seatsEl = $("pk-seats");
    for (let i = 0; i < SEATS; i++) {
      const el = document.createElement("div");
      el.className = "pk-seat is-empty";
      el.dataset.ring = String(i);
      el.innerHTML =
        '<div class="pk-seat-cards"></div>' +
        '<div class="pk-seat-body"><div class="pk-seat-ring"></div>' +
          '<div class="pk-seat-info"><span class="pk-seat-name"></span><span class="pk-seat-stack"></span></div>' +
          '<span class="pk-seat-btn-d">D</span><span class="pk-seat-badge"></span></div>' +
        '<div class="pk-seat-bet"></div>' +
        '<button class="pk-seat-sit">SIT</button>';
      seatsEl.appendChild(el);
    }
    // populate stakes selects
    const fS = $("pk-f-stakes"), cB = $("pk-c-bb");
    STAKES.forEach((bb) => {
      const o1 = document.createElement("option"); o1.value = String(bb); o1.textContent = "$" + (bb / 2) + "/$" + bb; fS.appendChild(o1);
      const o2 = document.createElement("option"); o2.value = String(bb); o2.textContent = "$" + (bb / 2) + "/$" + bb; cB.appendChild(o2);
    });
    cB.value = "10";
  }

  /* =========================================================================
     STATIC WIRING (buttons that don't depend on live state)
     ========================================================================= */
  function wireStatic() {
    $("pk-open-create").onclick = openCreate;
    $("pk-back").onclick = () => { leaveTable(); showLobby(); };
    $("pk-fs").onclick = toggleFs;
    $("pk-host-btn").onclick = openHost;

    // lobby filters
    $("pk-f-stakes").onchange = (e) => { filt.stakes = e.target.value; renderLobby(); };
    $("pk-f-kind").onchange = (e) => { filt.kind = e.target.value; renderLobby(); };
    $("pk-f-full").onchange = (e) => { filt.hideFull = e.target.checked; renderLobby(); };
    $("pk-f-priv").onchange = (e) => { filt.hidePrivate = e.target.checked; renderLobby(); };

    // create modal
    $("pk-c-cancel").onclick = () => { $("pk-create-modal").hidden = true; };
    $("pk-c-seats").oninput = (e) => { $("pk-c-seatval").textContent = e.target.value; };
    $("pk-c-rake").oninput = (e) => { $("pk-c-rakeval").textContent = (e.target.value / 100).toFixed(1) + "%"; };
    $("pk-c-priv").onchange = (e) => { $("pk-c-pw-fld").hidden = !e.target.checked; };
    $("pk-c-go").onclick = submitCreate;

    // demo chip reload (+$5,000 play-money, capped at $20,000) — guests only; the server hard-refuses
    // a real balance and never tops past the cap. Button is disabled at the cap (see paintBalance).
    const reloadDemo = () => {
      if (balanceUnits >= DEMO_CHIP_CAP) { cfg.toast("Demo chips are capped at $20,000", "info"); return; }
      if (net) net.send({ type: "pk:reload" });
      cfg.toast("Demo chips added 💰", "ok");
    };
    if ($("pk-reload")) $("pk-reload").onclick = reloadDemo;
    if ($("pk-reload2")) $("pk-reload2").onclick = reloadDemo;

    // rake "?" help — click to reveal a plain-English explanation, click again to hide
    const HELP = {
      rakepct: "Rake % is the small fee the table takes from each pot that reaches the flop — 5% is the standard online cap. That fee is split 50 / 50 between you (the host) and the house.",
      rakecap: "Rake cap (bb) is the MOST the table can ever take from one pot, measured in big blinds. Example: a cap of 3 on a $1 / $2 table means the fee never tops $6 (3 × the $2 big blind) no matter how big the pot gets — it stops large pots from paying a big flat fee.",
    };
    Array.prototype.forEach.call(document.querySelectorAll("#poker-view .pk-help"), (b) => {
      b.onclick = () => {
        const note = $("pk-help-note"); if (!note) return;
        const key = b.getAttribute("data-help");
        if (note._key === key && !note.hidden) { note.hidden = true; note._key = null; return; }
        note.textContent = HELP[key] || ""; note.hidden = false; note._key = key;
      };
    });

    // buy-in modal
    $("pk-buyin-cancel").onclick = () => { $("pk-buyin-modal").hidden = true; pendingJoin = null; };
    $("pk-buyin-go").onclick = confirmBuyIn;
    $("pk-buyin-range").oninput = (e) => { $("pk-buyin-amt").textContent = cfg.usd(+e.target.value); };

    // host modal
    $("pk-host-close-panel").onclick = () => { $("pk-host-modal").hidden = true; };
    $("pk-host-close-table").onclick = () => {
      if (!confirm("Close this table? Everyone is cashed out.")) return;
      if (net) net.send({ type: "pk:table:leave" }); // creator leaves; server closes when empty/idle
      $("pk-host-modal").hidden = true; leaveTable(); showLobby();
    };

    // fullscreen re-scale on rotate/resize
    try { window.addEventListener("resize", scheduleFit, { passive: true }); } catch (e) { window.addEventListener("resize", scheduleFit); }
    try { window.addEventListener("orientationchange", scheduleFit); } catch (e) {}
  }

  /* =========================================================================
     NET — connect / subscribe / handlers
     ========================================================================= */
  function connect() {
    if (net) return;
    myWallet = (cfg.wallet || guestId());
    const ts = cfg.tokenSession || {};
    net = new window.PokerNet({ wallet: myWallet, bjToken: ts.sessionToken || "", bjSession: ts.sessionId || "" });
    net.on("pk:net", (m) => { if (m.state === "open") { subscribe(); if (atTableId) resync(); } });
    net.on("pk:lobby:list", (m) => { lobbyRooms = m.rooms || []; renderLobby(); });
    net.on("pk:state", (m) => onState(m));
    net.on("pk:wallet", (m) => { if (typeof m.balance === "number") { balanceUnits = m.balance; paintBalance(); } });
    net.on("pk:table:created", (m) => { pendingCreatedSit(m.tableId); });
    net.on("pk:event", (m) => onEvent(m));
    net.on("pk:reveal", (m) => onReveal(m));
    net.on("pk:error", (m) => {
      // A RESYNC join (reconnect on a fresh socket) can RACE the old socket's close: the server still sees
      // our seat as live on the old socket and replies 'already_seated'. That is transient — retry the
      // resync with backoff until the server observes the old socket's FIN and the (wallet-matched, secure)
      // reconnect-grace reclaim takes over. Without this the reconnected socket sits on a frozen felt while
      // the seat auto-folds every turn. (Genuine same-socket resync hits the server RESYNC path, not this.)
      if (m.intent === "join" && m.code === "already_seated" && atTableId && _resyncTries < 5) {
        _resyncTries++; setTimeout(() => { if (atTableId) resync(); }, 700 * _resyncTries); return;
      }
      cfg.toast(m.msg || "Error", "err");
      if (m.intent === "join" || m.intent === "create") { pendingJoin = null; $("pk-buyin-modal").hidden = true; }
      if (m.intent === "act" && state) render(); // act rejected → repaint controls from the last snapshot (the server does NOT re-broadcast on a rejected act; without this the felt shows NO buttons until the 20s auto-act)
    });
  }
  let _resyncTries = 0; // reconnect-collision retry counter; reset once a real snapshot lands (onState)
  function subscribe() { if (net) net.send({ type: "pk:lobby:subscribe" }); }
  let _watchPw = ""; // password captured when watching a private table, replayed on a spectator reconnect
  function resync() {
    if (!net || !atTableId) return;
    // Re-pull our masked snapshot after a reconnect. A SEATED player re-joins (the server RESYNC path is a
    // no-op for their own seat). A SPECTATOR (mySeatIndex<0) must re-WATCH, NOT join — a bare join with no
    // buyIn would default a guest to DEMO_BUYIN_DEFAULT and involuntarily SEAT + charge the watcher.
    if (mySeatIndex < 0) net.send({ type: "pk:table:watch", tableId: atTableId, pw: _watchPw });
    else net.send({ type: "pk:table:join", tableId: atTableId });
  }

  function guestId() {
    try {
      let g = localStorage.getItem("ctf_bj_guest") || localStorage.getItem("pk_guest");
      if (!g) { g = "guest:" + Math.random().toString(36).slice(2, 10); localStorage.setItem("pk_guest", g); }
      return g;
    } catch (e) { return "guest:" + Math.random().toString(36).slice(2, 10); }
  }

  /* =========================================================================
     STATE HANDLING
     ========================================================================= */
  function onState(m) {
    // Only track state for the table we're seated at / watching.
    if (atTableId && m.tableId !== atTableId) return;
    _resyncTries = 0; // a real snapshot landed → the reconnect resynced; reset the collision-retry budget
    if (!atTableId) atTableId = m.tableId;
    if (m.you) { mySeatIndex = m.you.seat; if (typeof m.you.balance === "number") { balanceUnits = m.you.balance; } }
    else {
      // find my seat (seated player) else -1 (spectator)
      mySeatIndex = -1;
      (m.seats || []).forEach((s, i) => { if (s && s.wallet === myWallet) mySeatIndex = i; });
    }
    state = m;
    lastServerNow = m.serverNow || Date.now();
    lastActDeadline = m.actDeadline || 0;
    rttSkew = Date.now() - lastServerNow;
    // pot-push detection + PROFILE STATS: fire ONCE per settled hand (edge-triggered on the first
    // done-snapshot for this handNo). Records the LOCAL seated player's net for the hand — net =
    // deltas[me] (chips), wager = my committedTotal (chips) — via cfg.recordResult. Spectators and
    // players not dealt into this hand (no delta) are skipped, so nothing double-counts.
    if (m.hand && m.hand.done && (prevHandNo !== m.handNo || prevPhase !== "SHOWDOWN")) {
      if (m.hand.winners && m.hand.winners.length) queuePotPush(m.hand);
      try {
        const meP = (m.hand.players || []).find((p) => p.id === myWallet);
        const dChips = m.hand.deltas ? m.hand.deltas[myWallet] : undefined;
        if (meP && typeof dChips === "number" && cfg.recordResult) {
          const isReal = m.kind === "real";
          const toUsd = (chips) => isReal ? Math.round(chips) / 100 : chips; // real chips are cents; demo chips are dollars
          const wagerUsd = toUsd(meP.committedTotal || 0);
          const netUsd = toUsd(dChips);
          if (wagerUsd > 0) cfg.recordResult("poker", isReal ? "token" : "demo", netUsd > 0, wagerUsd, netUsd); // classify by the TABLE kind, not the site-wide toggle

        }
      } catch (e) {}
    }
    prevPhase = m.phase; prevHandNo = m.handNo;
    showRoom();
    render();
    startTimer();
  }

  function onEvent(m) {
    if (m.kind === "tableClosing" && m.id === atTableId) { cfg.toast("Table closed" + (m.reason ? " (" + m.reason + ")" : ""), "err"); leaveTable(); showLobby(); }
  }
  function onReveal(m) { /* PF reveal — cosmetic; the felt trusts the server. Could surface a verify panel later. */ }

  /* =========================================================================
     LOBBY
     ========================================================================= */
  function stakesLabel(r) { return "$" + r.sb + "/$" + r.bb; }
  function renderLobby() {
    const el = $("pk-tables"); if (!el) return;
    let rooms = lobbyRooms.slice();
    if (filt.stakes !== "all") rooms = rooms.filter((r) => String(r.bb) === filt.stakes);
    if (filt.kind !== "all") rooms = rooms.filter((r) => (r.kind || "demo") === filt.kind);
    if (filt.hideFull) rooms = rooms.filter((r) => r.openSeats > 0);
    if (filt.hidePrivate) rooms = rooms.filter((r) => !r.private);
    // default sort: most-filled then highest avg pot
    rooms.sort((a, b) => (b.seated - a.seated) || (b.avgPot - a.avgPot));
    if (!rooms.length) { el.innerHTML = '<p class="pk-empty">No tables match. Create one →</p>'; return; }
    el.innerHTML = "";
    rooms.forEach((r) => el.appendChild(tableCard(r)));
  }
  function tableCard(r) {
    const c = document.createElement("div");
    c.className = "pk-tcard" + (r.inHand ? " live" : "");
    const rakePct = (r.rakeBps / 100).toFixed(1);
    const seatDots = [];
    for (let i = 0; i < r.maxSeats; i++) seatDots.push('<i class="' + (i < r.seated ? "taken" : "open") + '"></i>');
    const full = r.openSeats <= 0;
    c.innerHTML =
      '<div class="pk-tcard-top">' +
        '<span class="pk-tname">' + esc(r.name) + (r.private ? ' <span class="pk-lock">🔒</span>' : '') + '</span>' +
        '<span class="pk-badge ' + (r.kind === "real" ? "real" : "demo") + '">' + (r.kind === "real" ? "REAL" : "DEMO") + '</span>' +
      '</div>' +
      '<div class="pk-tstakes">' + stakesLabel(r) + '</div>' +
      '<div class="pk-tdots">' + seatDots.join("") + '</div>' +
      '<div class="pk-tmeta"><span>' + r.seated + '/' + r.maxSeats + ' seated</span><span>avg pot ' + cfg.usd(potUsd(r, r.avgPot)) + '</span><span>rake ' + rakePct + '%</span></div>' +
      '<div class="pk-tcta">' +
        '<button class="pk-chip pk-join" ' + (full ? "disabled" : "") + '>' + (full ? "FULL" : "JOIN") + '</button>' +
        '<button class="pk-chip pk-watch">WATCH</button>' +
      '</div>';
    c.querySelector(".pk-join").onclick = () => { if (!full) openBuyIn(r); };
    c.querySelector(".pk-watch").onclick = () => watchTable(r);
    return c;
  }
  // avgPot is in CHIPS (cents for real, 1:1 for demo). Convert for display.
  function potUsd(r, chips) { return (r.kind === "real") ? (chips / 100) : chips; }

  /* =========================================================================
     CREATE
     ========================================================================= */
  function openCreate() { $("pk-create-modal").hidden = false; }
  let createdWantSit = null; // { tableId, buyInUnits, kind } captured for the auto-sit after pk:table:created
  function submitCreate() {
    const bb = +$("pk-c-bb").value;
    const kind = $("pk-c-kind").value;
    const cfgMsg = {
      name: $("pk-c-name").value.trim(),
      bb,
      maxSeats: +$("pk-c-seats").value,
      buyInMinBb: +$("pk-c-minbb").value,
      buyInMaxBb: +$("pk-c-maxbb").value,
      rakeBps: +$("pk-c-rake").value,
      rakeCapBb: +$("pk-c-rakecap").value,
      kind,
      private: $("pk-c-priv").checked,
      pw: $("pk-c-priv").checked ? $("pk-c-pw").value : "",
    };
    // sit for min buy-in by default after creation
    createdWantSit = { buyInUnits: cfgMsg.buyInMinBb * bb, kind, pw: cfgMsg.pw };
    if (net) net.send({ type: "pk:table:create", config: cfgMsg });
    $("pk-create-modal").hidden = true;
  }
  function pendingCreatedSit(tableId) {
    if (!createdWantSit) return;
    const s = createdWantSit; createdWantSit = null;
    atTableId = tableId;
    if (net) net.send({ type: "pk:table:join", tableId, buyInUnits: s.buyInUnits, pw: s.pw });
  }

  /* =========================================================================
     BUY-IN + JOIN + WATCH
     ========================================================================= */
  let pendingJoin = null; // { room }
  function openBuyIn(r) {
    const isReal = r.kind === "real";
    // Real tables need an in-game TOKEN balance. A guest, or a connected wallet that hasn't bought in
    // (no token session), has none — guide them to the Wallet tab instead of opening a buy-in they can't
    // fund (the bare "Not enough balance" the owner hit). Demo tables are unaffected.
    if (isReal && !cfg.tokenSession) {
      const connected = /^0x/i.test(String(myWallet || ""));
      cfg.toast(connected ? "Buy in from the 💰 Wallet tab first, then sit at real tables." : "Connect your wallet and buy in (💰 Wallet) to play real-money tables.", "info");
      return;
    }
    pendingJoin = { room: r };
    // buyInMin/buyInMax are already in UNITS (dollars): the server sets them = buyInBb·bb and
    // takeSeat clamps the incoming buyInUnits against them directly. Use them AS units — do NOT run
    // potUsd (its ÷100 is only right for CHIP fields like avgPot/stack). Same for demo (units==chips).
    const minU = r.buyInMin, maxU = r.buyInMax;
    const rng = $("pk-buyin-range");
    rng.min = minU; rng.max = maxU; rng.step = isReal ? 1 : Math.max(1, Math.round((maxU - minU) / 50));
    rng.value = Math.min(maxU, Math.max(minU, Math.round((minU + maxU) / 2)));
    $("pk-buyin-amt").textContent = cfg.usd(+rng.value);
    $("pk-buyin-title").textContent = "Sit at " + r.name;
    $("pk-buyin-sub").textContent = stakesLabel(r) + " · buy in " + cfg.usd(minU) + "–" + cfg.usd(maxU) + (isReal ? " · real (token)" : " · demo");
    $("pk-buyin-pw-fld").hidden = !r.private;
    $("pk-buyin-modal").hidden = false;
  }
  function confirmBuyIn() {
    if (!pendingJoin) { $("pk-buyin-modal").hidden = true; return; }
    const r = pendingJoin.room;
    const units = +$("pk-buyin-range").value;
    const pw = r.private ? ($("pk-buyin-pw").value || "") : "";
    atTableId = r.id;
    if (net) net.send({ type: "pk:table:join", tableId: r.id, buyInUnits: units, pw });
    $("pk-buyin-modal").hidden = true; pendingJoin = null;
  }
  function watchTable(r) {
    // a PRIVATE table now gates spectating on the password too — ask for it (mirrors the join flow)
    let pw = "";
    if (r && r.private) { pw = prompt("This table is private — enter its password to watch:") || ""; if (!pw) return; }
    atTableId = r.id; mySeatIndex = -1; _watchPw = pw; // remember the pw so a spectator reconnect can re-watch
    if (net) net.send({ type: "pk:table:watch", tableId: r.id, pw: pw });
  }
  function leaveTable() {
    if (net && atTableId) net.send({ type: "pk:table:leave" });
    atTableId = null; state = null; mySeatIndex = -1; prevPhase = null; prevHandNo = null;
    stopTimer(); exitFsIfOn();
  }

  /* =========================================================================
     VIEW SWITCH (lobby ↔ room)
     ========================================================================= */
  function showLobby() { $("pk-lobby").hidden = false; $("pk-room").hidden = true; subscribe(); }
  function showRoom() { $("pk-lobby").hidden = true; $("pk-room").hidden = false; }

  /* =========================================================================
     RENDER — the whole felt from `state`
     ========================================================================= */
  function render() {
    if (!state) return;
    const hand = state.hand;
    const isReal = (state && state.kind) ? state.kind === "real" : ((lobbyRooms.find((r) => r.id === atTableId) || {}).kind === "real"); // prefer the AUTHORITATIVE snapshot kind (now always present) so real chip stacks/pot never flash 100× before the lobby list lands
    const toChips = (n) => n; // stacks are already chips
    const money = (chips) => cfg.usd(potUsd({ kind: isReal ? "real" : "demo" }, chips));

    $("pk-room-name").textContent = state && (roomName() || "");
    paintBalance();

    // board
    const board = $("pk-board"); board.innerHTML = "";
    const bcards = hand ? hand.board : [];
    for (let i = 0; i < 5; i++) {
      if (i < bcards.length) board.appendChild(cardEl(bcards[i]));
      else { const e = document.createElement("div"); e.className = "pkcard slot"; board.appendChild(e); }
    }
    // pot
    const pot = $("pk-pot");
    pot.textContent = hand ? ("POT " + money(hand.pot)) : (state.phase === "WAITING" ? "WAITING FOR PLAYERS" : "");
    pot.classList.toggle("empty", !(hand && hand.pot > 0));
    // side pots
    const sp = $("pk-sidepots"); sp.innerHTML = "";
    if (hand && hand.pots && hand.pots.length > 1) {
      hand.pots.forEach((p, i) => { const pill = document.createElement("span"); pill.className = "pk-sp-pill"; pill.textContent = (i === 0 ? "MAIN " : "SIDE " + i + " ") + money(p.amount); sp.appendChild(pill); });
    }
    // caption
    renderCaption(hand, money);

    // seats
    renderSeats(hand, money);
    // hero hole + controls
    renderHole(hand);
    renderControls(hand, money);

    // host button visible only to the creator
    const iAmHost = (state.seats || []).some((s) => s && s.wallet === myWallet && s.isHost);
    $("pk-host-btn").hidden = !iAmHost;

    scheduleFit();
  }

  function roomName() {
    const r = lobbyRooms.find((x) => x.id === atTableId);
    return r ? r.name : (atTableId || "");
  }

  function renderCaption(hand, money) {
    const cap = $("pk-caption");
    if (!hand) { cap.textContent = ""; cap.className = "pk-caption"; return; }
    if (hand.done && hand.winners && hand.winners.length) {
      const names = uniq(hand.winners.flatMap((w) => w.ids)).map(walletName);
      const myD = (hand.deltas && hand.deltas[myWallet]) || 0;
      let t = names.join(", ") + (names.length > 1 ? " split the pot" : " wins");
      if (myD > 0) t += " · you +" + money(myD);
      cap.textContent = t; cap.className = "pk-caption win";
    } else if (state.phase === "SHOWDOWN") { cap.textContent = "Showdown"; cap.className = "pk-caption"; }
    else { cap.textContent = ""; cap.className = "pk-caption"; }
  }

  function renderSeats(hand, money) {
    const total = SEATS;
    const seatEls = $("pk-seats").children;
    // reset all to empty
    for (let k = 0; k < total; k++) seatEls[k].className = "pk-seat is-empty";
    const seats = state.seats || [];
    for (let si = 0; si < seats.length && si < total; si++) {
      const s = seats[si];
      const ring = ringIndexFor(si, total);
      const el = seatEls[ring];
      const pos = seatPos(ring, total);
      el.style.left = pos.left + "%"; el.style.top = pos.top + "%";
      if (!s) {
        // an open seat — offer SIT when I'm not seated and it's a real open slot
        el.className = "pk-seat is-empty" + ((mySeatIndex < 0) ? " joinable" : "");
        const sit = el.querySelector(".pk-seat-sit");
        sit.onclick = () => { const r = lobbyRooms.find((x) => x.id === atTableId); if (r && mySeatIndex < 0) openBuyIn(Object.assign({}, r, { _seatPref: si })); };
        continue;
      }
      const hp = hand ? hand.players.find((p) => p.id === s.wallet) : null;
      el.className = "pk-seat" +
        (s.wallet === myWallet ? " is-hero" : "") +
        (hand && hand.toActId === s.wallet ? " is-active" : "") +
        (hp && hp.folded ? " is-folded" : "") +
        (hp && hp.allIn ? " is-allin" : "") +
        (s.away ? " is-away" : "") +
        (s.sittingOut ? " is-out" : "");
      // dealer button
      const isBtn = hand && hand.players[hand.button] && hand.players[hand.button].id === s.wallet;
      if (isBtn) el.classList.add("has-button");
      el.querySelector(".pk-seat-name").textContent = s.name || short(s.wallet);
      const stackChips = hp ? hp.stack : s.stack;
      el.querySelector(".pk-seat-stack").textContent = money(stackChips);
      const badge = el.querySelector(".pk-seat-badge");
      badge.textContent = (hp && hp.allIn) ? "ALL-IN" : (s.away ? "AWAY" : (s.sittingOut ? "SIT OUT" : ""));
      // current street bet chips
      const bet = el.querySelector(".pk-seat-bet");
      bet.textContent = (hp && hp.committedStreet > 0) ? money(hp.committedStreet) : "";
      // seat cards (never the raw holes of others — server sends null)
      const sc = el.querySelector(".pk-seat-cards"); sc.innerHTML = "";
      if (hp && hp.hasCards && !hp.folded) {
        if (s.wallet === myWallet) { /* shown big in the dock */ }
        else if (hand.done && hp.hole) { hp.hole.forEach((c) => sc.appendChild(cardEl(c, "mini"))); }
        else { sc.appendChild(cardEl(null, "mini")); sc.appendChild(cardEl(null, "mini")); }
      }
      // turn ring drives via CSS var updated by the timer loop
    }
  }

  function renderHole(hand) {
    const hole = $("pk-hole"); hole.innerHTML = "";
    if (!hand) { return; }
    const me = hand.players.find((p) => p.id === myWallet);
    if (me && me.hole) { me.hole.forEach((c) => hole.appendChild(cardEl(c, "big"))); }
    if (me && me.cat && hand.done) { const t = document.createElement("div"); t.className = "pk-hole-cat"; t.textContent = me.cat; hole.appendChild(t); }
  }

  function renderControls(hand, money) {
    const c = $("pk-controls"); c.innerHTML = "";
    // If I'm not seated: watching → show SIT prompt / seated but hand not mine → status
    if (mySeatIndex < 0) {
      const r = lobbyRooms.find((x) => x.id === atTableId);
      if (r && r.openSeats > 0) { const b = mkBtn("TAKE A SEAT", "sit", () => openBuyIn(r)); c.appendChild(b); }
      else { const s = document.createElement("span"); s.className = "pk-ctl-msg"; s.textContent = "Spectating"; c.appendChild(s); }
      return;
    }
    const seat = (state.seats || [])[mySeatIndex];
    const legal = legalFor(hand);
    if (!legal.yourTurn) {
      // between turns: offer sit-out / rebuy when out of chips / leave
      const msg = document.createElement("span"); msg.className = "pk-ctl-msg";
      // seat.stack is in CHIPS (cents for a real table); state.bb is the DOLLAR big blind — scale it to chips
      // so a real short stack correctly triggers the rebuy affordance (was a 100× mismatch → never fired).
      const bbChips = (state.bb || 0) * (state.kind === "real" ? 100 : 1);
      if (seat && seat.stack < bbChips && !inLiveHand(hand)) msg.textContent = "Out of chips — rebuy to keep playing";
      else if (hand && !hand.done) msg.textContent = waitingName(hand);
      else msg.textContent = state.phase === "WAITING" ? "Waiting for players…" : "";
      c.appendChild(msg);
      // secondary row
      const row = document.createElement("div"); row.className = "pk-ctl-row2";
      if (seat && !inLiveHand(hand)) {
        if (seat.stack < bbChips) row.appendChild(mkBtn("REBUY", "raise", openRebuy)); // bbChips = chip-scaled big blind (see above)
        row.appendChild(mkBtn(seat.sittingOut ? "SIT IN" : "SIT OUT", "ghost", () => { if (net) net.send({ type: seat.sittingOut ? "pk:sit-in" : "pk:sit-out" }); }));
        row.appendChild(mkBtn("LEAVE", "ghost", () => { leaveTable(); showLobby(); }));
        // DEMO ONLY: fill empty seats with bots so you can play solo (bots never touch real money)
        if (state.kind === "demo") {
          if ((state.seats || []).some((s) => !s)) row.appendChild(mkBtn("+ BOT", "ghost", () => { if (net) net.send({ type: "pk:table:addbot", tableId: atTableId }); }));
          if ((state.seats || []).some((s) => s && String(s.wallet || "").indexOf("bot:") === 0)) row.appendChild(mkBtn("− BOT", "ghost", () => { if (net) net.send({ type: "pk:table:removebot", tableId: atTableId }); }));
        }
      }
      if (row.children.length) c.appendChild(row);
      return;
    }
    // MY TURN — FOLD (fixed left) / CHECK-or-CALL / RAISE slider + presets
    c.appendChild(mkBtn("FOLD", "fold", () => act("fold")));
    if (legal.canCheck) c.appendChild(mkBtn("CHECK", "check", () => act("check")));
    else if (legal.canCall) c.appendChild(mkBtn("CALL " + money(legal.callAmount), "call", () => act("call")));
    if (legal.canBet || legal.canRaise) buildRaise(c, hand, legal, money);
  }

  function buildRaise(c, hand, legal, money) {
    const isBet = legal.canBet;
    const minTo = isBet ? (legal.minBet + legal.committed) : legal.minRaiseTo;
    const maxTo = legal.maxRaiseTo;
    if (maxTo <= (legal.committed + legal.toCall)) return; // nothing to raise beyond a call/all-in
    const wrap = document.createElement("div"); wrap.className = "pk-raise";
    const presets = document.createElement("div"); presets.className = "pk-presets";
    const range = document.createElement("input"); range.type = "range"; range.className = "pk-raise-sl";
    range.min = minTo; range.max = maxTo; range.step = 1;
    const pot = legal.pot;
    range.value = Math.min(maxTo, Math.max(minTo, Math.round(pot * 0.6) + legal.committed));
    const amt = document.createElement("span"); amt.className = "pk-raise-amt";
    const sync = () => { amt.textContent = money(+range.value); };
    range.oninput = sync; sync();
    [["½", 0.5], ["¾", 0.75], ["POT", 1], ["MAX", null]].forEach(([lab, f]) => {
      const b = document.createElement("button"); b.className = "pk-preset"; b.textContent = lab;
      b.onclick = () => {
        let t = f == null ? maxTo : (isBet ? legal.committed : legal.committed + legal.toCall) + Math.round(pot * f);
        range.value = Math.max(minTo, Math.min(maxTo, t)); sync();
      };
      presets.appendChild(b);
    });
    const go = mkBtn(isBet ? "BET" : "RAISE", "raise", () => act(isBet ? "bet" : "raise", +range.value));
    wrap.appendChild(presets);
    const dial = document.createElement("div"); dial.className = "pk-dial"; dial.appendChild(range); dial.appendChild(amt);
    wrap.appendChild(dial); wrap.appendChild(go);
    c.appendChild(wrap);
  }

  function act(type, amount) {
    if (net) net.send({ type: "pk:act", action: type, amount });
    $("pk-controls").innerHTML = ""; // optimistic clear; the next pk:state repaints
  }
  function openRebuy() {
    const r = lobbyRooms.find((x) => x.id === atTableId);
    const minU = r ? r.buyInMin : (state.bb || 1) * 20; // buyInMin is already in UNITS ($) — do NOT run potUsd (it /100s a real table → a 100×-too-small default), mirrors openBuyIn
    const amt = window.prompt("Rebuy amount ($):", String(minU));
    const units = Math.round(Number(amt) || 0);
    if (units > 0 && net) net.send({ type: "pk:rebuy", amount: units });
  }

  /* =========================================================================
     POT-PUSH ANIMATION — chips slide from the pot to the winner seat(s)
     ========================================================================= */
  const pushQ = [];
  function queuePotPush(hand) {
    pushQ.push(hand.winners.map((w) => ({ ids: w.ids.slice(), amount: w.amount })));
    setTimeout(runPotPush, 60); // let the DOM settle after render
  }
  function runPotPush() {
    const job = pushQ.shift(); if (!job) return;
    const fx = $("pk-chipfx"); if (!fx) return;
    const feltRect = $("pk-felt").getBoundingClientRect();
    const potEl = $("pk-pot"); const pr = potEl.getBoundingClientRect();
    const from = { x: pr.left + pr.width / 2 - feltRect.left, y: pr.top + pr.height / 2 - feltRect.top };
    job.forEach((w) => {
      w.ids.forEach((id) => {
        // locate the winner's seat element
        const seats = state.seats || []; let si = -1;
        for (let i = 0; i < seats.length; i++) if (seats[i] && seats[i].wallet === id) { si = i; break; }
        if (si < 0) return;
        const ring = ringIndexFor(si, SEATS);
        const seatEl = $("pk-seats").children[ring];
        const sr = seatEl.getBoundingClientRect();
        const to = { x: sr.left + sr.width / 2 - feltRect.left, y: sr.top + sr.height / 2 - feltRect.top };
        // WIN MOMENT: gold-halo the winner seat + float a "+$" pill up over it (the satisfying payoff)
        seatEl.classList.add("is-winner");
        setTimeout(() => { try { seatEl.classList.remove("is-winner"); } catch (e) {} }, 2400);
        try {
          const isReal = state && state.kind === "real";
          const share = Math.round(w.amount / Math.max(1, w.ids.length));
          const pill = document.createElement("div"); pill.className = "pk-winpill";
          pill.textContent = "+" + cfg.usd(isReal ? Math.round(share) / 100 : share);
          pill.style.left = to.x + "px"; pill.style.top = to.y + "px";
          fx.appendChild(pill);
          requestAnimationFrame(() => pill.classList.add("show"));
          setTimeout(() => { try { fx.removeChild(pill); } catch (e) {} }, 2050);
        } catch (e) {}
        for (let n = 0; n < 6; n++) {
          const chip = document.createElement("div"); chip.className = "pk-fxchip";
          chip.style.left = from.x + "px"; chip.style.top = from.y + "px";
          fx.appendChild(chip);
          const delay = n * 45;
          requestAnimationFrame(() => setTimeout(() => {
            chip.style.transform = "translate(" + (to.x - from.x) + "px," + (to.y - from.y) + "px) scale(.7)";
            chip.style.opacity = "0";
          }, delay));
          setTimeout(() => { try { fx.removeChild(chip); } catch (e) {} }, 700 + delay);
        }
      });
    });
  }

  /* =========================================================================
     TURN TIMER — conic ring from the snapshot deadline (cosmetic)
     ========================================================================= */
  function startTimer() { stopTimer(); tick(); }
  function stopTimer() { if (timerRAF) { cancelAnimationFrame(timerRAF); timerRAF = null; } }
  function tick() {
    const hand = state && state.hand;
    // find the to-act seat ring element and drive its ring var
    const seatsEl = $("pk-seats");
    if (hand && !hand.done && lastActDeadline > 0 && hand.toActId != null) {
      const now = Date.now() - rttSkew;
      const total = 20000; // POKER_ACT_MS (cosmetic; server enforces)
      const left = Math.max(0, lastActDeadline - now);
      const frac = Math.max(0, Math.min(1, left / total));
      const seats = state.seats || []; let si = -1;
      for (let i = 0; i < seats.length; i++) if (seats[i] && seats[i].wallet === hand.toActId) { si = i; break; }
      if (si >= 0) {
        const ring = ringIndexFor(si, SEATS);
        const el = seatsEl.children[ring];
        if (el) el.style.setProperty("--pk-timer", (frac * 360) + "deg");
      }
    }
    // clear stale rings
    for (let k = 0; k < seatsEl.children.length; k++) {
      const el = seatsEl.children[k];
      if (!el.classList.contains("is-active")) el.style.removeProperty("--pk-timer");
    }
    timerRAF = requestAnimationFrame(tick);
  }

  /* =========================================================================
     FULLSCREEN — FsUtil; portrait bottom-controls, landscape right side-rail.
     The felt scales to the box left of the rail (landscape) or to width (portrait).
     ========================================================================= */
  let fsOn = false, fitT = null;
  function toggleFs() {
    if (fsOn) exitFsIfOn();
    else {
      const el = $("pk-stage-wrap"); if (!el || !window.FsUtil) return;
      window.FsUtil.enterFs(el, { skipNative: false, lockOrientation: null }); // poker is portrait-native — do NOT force-rotate
      fsOn = true; document.body.classList.add("pk-fs"); scheduleFit();
    }
  }
  function exitFsIfOn() {
    if (!fsOn) return;
    if (window.FsUtil) window.FsUtil.exitFs();
    fsOn = false; document.body.classList.remove("pk-fs", "pk-fs-landscape", "pk-fs-portrait");
    const felt = $("pk-felt"); if (felt) felt.style.transform = "";
    scheduleFit();
  }
  function scheduleFit() { if (fitT) return; fitT = requestAnimationFrame(() => { fitT = null; fit(); }); }
  function fit() {
    const wrap = $("pk-stage-wrap"), felt = $("pk-felt");
    if (!wrap || !felt) return;
    if (!fsOn) {
      // in-page: scale the fixed felt to the wrap width (never upscale past 1). transform:scale does NOT
      // shrink the felt's 620px LAYOUT box, so we scale from the TOP and set the wrap to the VISUAL height
      // + clip the empty box below — otherwise the unscaled 620px reserves a huge gap that shoves the dock
      // far below the fold (owner: "the menu is way too far down").
      const w = wrap.clientWidth || FELT_W;
      const s = Math.min(1, w / FELT_W);
      felt.style.transformOrigin = "top center";
      felt.style.transform = "scale(" + s + ")";
      // transform:scale does NOT shrink the felt's 620px LAYOUT box, so the hole-cards + controls
      // (siblings BELOW the felt in this wrap) sit at y=620 leaving a huge gap. Pull them up under the
      // VISUAL felt with a negative margin = (visualH − layoutH). NOT overflow:hidden (that clipped the
      // controls entirely — owner saw a blank felt with no buttons).
      felt.style.marginBottom = Math.round(FELT_H * s - FELT_H) + "px";
      wrap.style.overflow = ""; wrap.style.height = "";
      return;
    }
    // fullscreen
    felt.style.transformOrigin = ""; felt.style.marginBottom = ""; wrap.style.overflow = "";
    const landscape = (window.innerWidth || 0) >= (window.innerHeight || 1);
    document.body.classList.toggle("pk-fs-landscape", landscape);
    document.body.classList.toggle("pk-fs-portrait", !landscape);
    wrap.style.height = "";
    const railW = landscape ? Math.min(220, Math.max(150, (window.innerWidth || 0) * 0.18)) : 0;
    const availW = (window.innerWidth || FELT_W) - railW - 12;
    const availH = (window.innerHeight || FELT_H) - (landscape ? 12 : 150);
    const s = Math.min(availW / FELT_W, availH / FELT_H);
    felt.style.transform = "scale(" + s + ")";
  }

  /* =========================================================================
     HOST PANEL
     ========================================================================= */
  function openHost() {
    $("pk-host-modal").hidden = false;
    // Live host figures come from the room card + our seat; rake-share accrual is
    // authoritative server-side (paid to the wallet), so we show what the lobby exposes.
    const r = lobbyRooms.find((x) => x.id === atTableId) || {};
    const isReal = r.kind === "real";
    const grid = $("pk-host-grid");
    grid.innerHTML =
      '<div><span>Seated</span><b>' + (r.seated || 0) + '/' + (r.maxSeats || 0) + '</b></div>' +
      '<div><span>Avg pot</span><b>' + cfg.usd(potUsd(r, r.avgPot || 0)) + '</b></div>' +
      '<div><span>Rake</span><b>' + ((r.rakeBps || 0) / 100).toFixed(1) + '% (cap ' + (r.rakeCapBb || 0) + 'bb)</b></div>' +
      '<div><span>Mode</span><b>' + (isReal ? "REAL" : "DEMO") + '</b></div>';
    // the headline rake number: the server does not stream per-creator accrual in the lobby;
    // it is paid to the wallet on settle. Surface a note instead of a live figure.
    $("pk-host-rake").textContent = "paid to wallet";
  }

  /* =========================================================================
     HELPERS
     ========================================================================= */
  function inLiveHand(hand) { return !!(hand && !hand.done && hand.players.some((p) => p.id === myWallet && !p.folded)); }
  function waitingName(hand) {
    if (!hand || hand.done || hand.toActId == null) return "";
    return (walletName(hand.toActId) || "Opponent") + " to act…";
  }
  function walletName(w) {
    const seats = (state && state.seats) || [];
    for (const s of seats) if (s && s.wallet === w) return s.name || short(w);
    return short(w);
  }
  function short(w) { w = String(w || ""); return /^0x/.test(w) ? (w.slice(0, 6) + "…" + w.slice(-4)) : (w.replace(/^guest:/, "").slice(0, 8) || "Player"); }
  function uniq(a) { return Array.from(new Set(a)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])); }
  function mkBtn(label, cls, fn) { const b = document.createElement("button"); b.className = "pk-btn " + cls; b.textContent = label; b.onclick = fn; return b; }
  function paintBalance() {
    // Prefer the AUTHORITATIVE snapshot kind (mirrors render()) so a real token balance isn't momentarily
    // rounded-to-dollars (losing cents) when a pk:wallet push lands before the lobby list does.
    const isReal = (state && state.kind) ? state.kind === "real" : ((lobbyRooms.find((x) => x.id === atTableId) || {}).kind === "real");
    const disp = isReal ? balanceUnits : Math.round(balanceUnits);
    const t = cfg.usd(disp);
    const b1 = $("pk-bal"), b2 = $("pk-bal2"); if (b1) b1.textContent = t; if (b2) b2.textContent = t;
    // The demo reload is play-money for pure GUESTS only. A CONNECTED wallet (0x identity) plays with real
    // tokens — never show it a "+ $5K demo chips" button; its balance is the in-game token balance (buy in
    // from the Wallet tab). The reload is disabled once AT/OVER $20k — winnings may climb higher, reloads stop.
    const demo = !/^0x/i.test(String(myWallet || cfg.wallet || ""));
    const atCap = Math.round(balanceUnits) >= DEMO_CHIP_CAP;
    [$("pk-reload"), $("pk-reload2")].forEach((rb) => {
      if (!rb) return;
      rb.hidden = !demo;
      rb.disabled = atCap;
      rb.title = atCap ? "Demo chips reload is capped at $20,000" : "Add $5,000 play-money chips (up to $20,000)";
    });
    try { cfg.onBalance(disp); } catch (e) {}
  }

  /* =========================================================================
     PUBLIC API
     ========================================================================= */
  window.PokerUI = {
    mounted: false,
    init(opts) { cfg = Object.assign(cfg, opts || {}); if (opts && opts.wallet != null) myWallet = opts.wallet || guestId(); },
    config(opts) { cfg = Object.assign(cfg, opts || {}); }, // legacy alias
    // Re-bind identity when the wallet / token session changes (e.g. a buy-in created a session, or connect/
    // disconnect). If already connected, the socket is warm with the OLD identity — so on a real change we
    // close + reconnect so the server sees the new session and returns the real in-game balance. Only rebinds
    // from the LOBBY (never yanks a seated player mid-hand — that defers until they leave the table).
    setIdentity(opts) {
      opts = opts || {};
      const newWallet = (opts.wallet != null) ? (opts.wallet || guestId()) : myWallet;
      const newTs = (opts.tokenSession !== undefined) ? (opts.tokenSession || null) : (cfg.tokenSession || null);
      const changed = String(newWallet) !== String(myWallet) || JSON.stringify(newTs) !== JSON.stringify(cfg.tokenSession || null);
      // Refresh only the harmless display cfg always; NEVER swap the IDENTITY (wallet/tokenSession) while
      // SEATED — myWallet drives seat detection + hole rendering + legalFor, so swapping it under a live seat
      // makes the felt think it's spectating and the server auto-folds the seat every turn (v13.69 regression:
      // the old guard deferred only the reconnect, not the myWallet/cfg mutation). Defer the WHOLE swap until
      // we're back in the LOBBY, where the next identity sync applies it + reconnects.
      ["usd", "toast", "recordResult", "onBalance"].forEach((k) => { if (opts[k] !== undefined) cfg[k] = opts[k]; });
      if (changed && !atTableId) {
        cfg.tokenSession = newTs; myWallet = newWallet;
        if (net) { try { net.close(); } catch (e) {} net = null; connect(); }
      }
      try { paintBalance(); } catch (e) {}
    },
    mount() { mount(); this.mounted = true; },
    show() {
      mount(); this.mounted = true;
      const v = $("poker-view"); if (v) v.hidden = false;
      connect();
      if (atTableId) { showRoom(); render(); } else { showLobby(); }
      subscribe(); scheduleFit();
    },
    hide() { const v = $("poker-view"); if (v) v.hidden = true; exitFsIfOn(); stopTimer(); },
    isSeated() { return mySeatIndex >= 0; },
  };
})();
