/* ============================================================
   blackjack-server.js — server-authoritative multiplayer blackjack room
   engine (MVP: bet -> deal -> hit/stand -> dealer S17 -> settle). The server
   owns the shoe, deals, validates every intent, runs timers, and is the only
   writer of balances. Clients send intents and render broadcast snapshots.

   Plug into the existing ws server:
     const bj = attachBlackjack({ bank });
     wss.on('connection', (sock) => sock.on('message', (raw) => {
       let m; try { m = JSON.parse(raw); } catch { return; }
       if (typeof m.type === 'string' && m.type.startsWith('bj:')) bj.handle(sock, m);
     }));

   MVP defers: double/split/insurance/surrender, multi-round shoe (one shoe
   per round here), reconnect/resume, rate limits. Structured to extend.
   ============================================================ */
(function (root) {
  "use strict";
  // The rules core + provably-fair shoe are ISOMORPHIC and live in public/ so the
  // browser can load them as plain static assets (the fairness panel recomputes the
  // shoe to verify it). The server requires the very same files.
  const Rules = (typeof require !== "undefined") ? require("../public/blackjack-rules.js") : root.BlackjackRules;
  const Shuffle = (typeof require !== "undefined") ? require("../public/blackjack-shuffle.js") : root.BlackjackShuffle;

  function makeBank(start) {
    const m = new Map(); const get = (w) => { if (!m.has(w)) m.set(w, start == null ? 5000 : start); return m.get(w); };
    return { get, all: m, credit: (w, a) => m.set(w, Math.round((get(w) + a) * 100) / 100), debit: (w, a) => { if (get(w) < a) return false; m.set(w, Math.round((get(w) - a) * 100) / 100); return true; } };
  }

  function attachBlackjack(opts) {
    opts = opts || {};
    const config = Object.assign({}, Rules.DEFAULT_CONFIG, opts.config || {});
    const T = Object.assign({ betting: 15000, turn: 20000, idle: 300000, between: 3500 }, opts.timers || {});
    const bank = opts.bank || makeBank(opts.startBalance);
    const MAX_ROOMS = opts.maxRooms || 50;
    const setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
    const clrT = opts.clearTimeout || clearTimeout;
    const now = opts.now || (() => Date.now());
    const send = (sock, obj) => { if (sock && sock.send) try { sock.send(JSON.stringify(obj)); } catch (e) {} };

    const rooms = new Map(); let seq = 0; const lobbySubs = new Set();

    /* ---------------- lobby ---------------- */
    function roomPublic(r) {
      return { id: r.id, name: r.name, seated: r.seats.filter(Boolean).length, openSeats: r.seats.filter((s) => !s).length,
        phase: r.phase, inProgress: r.phase !== "idle" && r.phase !== "betting", minBet: config.minBet,
        tableBet: r.seats.reduce((a, s) => a + (s && s.bet || 0), 0), spectators: r.spectators.size, commit: r.commit };
    }
    function lobbyList() { return Array.from(rooms.values()).filter((r) => !r.full || r.seats.some((s) => !s)).map(roomPublic); }
    function pushLobby() { const list = lobbyList(); for (const s of lobbySubs) send(s, { type: "bj:lobby:list", rooms: list }); }

    /* ---------------- room mgmt ---------------- */
    const NAMES = ["MIAMI", "VEGAS", "MONACO", "TOKYO", "RENO", "MACAU", "ASPEN", "IBIZA"];
    function createRoom() {
      if (rooms.size >= MAX_ROOMS) return null;
      seq++; const id = "TABLE-" + String(seq).padStart(2, "0");
      const r = { id, name: id + " · " + NAMES[(seq - 1) % NAMES.length], seats: [null, null, null, null], spectators: new Set(),
        phase: "idle", shoe: [], pos: 0, dealer: [], commit: "", serverSeed: "", shoeId: "", turnIdx: -1, deadline: 0,
        lastActivity: now(), handNumber: 0, version: 0, full: false, timers: {} };
      rooms.set(id, r); scheduleIdle(r); pushLobby(); return r;
    }
    function openRoom() { for (const r of rooms.values()) if (!r.full && r.seats.some((s) => !s)) return r; return createRoom(); }
    function reapEmptyExtras() { // keep exactly one warm open empty room; reap other empties immediately
      const empties = Array.from(rooms.values()).filter((r) => r.seats.every((s) => !s) && r.phase === "idle");
      for (let i = 1; i < empties.length; i++) closeRoom(empties[i], "reaped");
    }
    function touch(r) { r.lastActivity = now(); scheduleIdle(r); }
    function scheduleIdle(r) { if (r.timers.idle) clrT(r.timers.idle); r.timers.idle = setT(() => {
      const inHand = r.phase !== "idle" && r.phase !== "betting";
      if (!inHand && now() - r.lastActivity >= T.idle) closeRoom(r, "idle");
      else scheduleIdle(r);
    }, T.idle); }
    function closeRoom(r, reason) {
      // refund any escrowed (in-round) bets
      for (const s of r.seats) if (s && s.bet > 0 && !s.settled) { bank.credit(s.wallet, s.bet); s.bet = 0; }
      for (const k in r.timers) clrT(r.timers[k]);
      broadcast(r, { type: "bj:event", kind: "roomClosing", id: r.id, reason });
      if (r.serverSeed) broadcast(r, { type: "bj:reveal", roomId: r.id, serverSeed: r.serverSeed, commit: r.commit });
      rooms.delete(r.id); pushLobby();
    }

    /* ---------------- broadcast / snapshot ---------------- */
    function broadcast(r, obj) { for (const s of r.seats) if (s) send(s.sock, obj); for (const sp of r.spectators) send(sp, obj); }
    function seatView(s) { if (!s) return null; const hv = s.cards.length ? Rules.handValue(s.cards) : null;
      return { wallet: s.wallet, bet: s.bet, cards: s.cards, total: hv && hv.total, soft: hv && hv.soft, bust: hv && hv.bust, blackjack: hv && hv.blackjack, done: !!s.done, result: s.result || null }; }
    function snapshot(r) {
      const showHole = r.phase === "dealer" || r.phase === "settle";
      const dealer = { cards: showHole ? r.dealer : r.dealer.slice(0, 1), total: showHole && r.dealer.length ? Rules.handValue(r.dealer).total : null, holeHidden: !showHole && r.dealer.length > 1 };
      return { type: "bj:room:snapshot", roomId: r.id, phase: r.phase, deadline: r.deadline, serverNow: now(), version: ++r.version,
        seats: r.seats.map(seatView), dealer, turnIdx: r.turnIdx, commit: r.commit, handNumber: r.handNumber };
    }
    function broadcastState(r) { broadcast(r, snapshot(r)); pushLobby(); }
    function pushWallet(sock, wallet) { send(sock, { type: "bj:wallet", balance: bank.get(wallet) }); }

    /* ---------------- round loop ---------------- */
    function startBetting(r) {
      r.phase = "betting"; r.handNumber++; r.dealer = []; r.turnIdx = -1;
      r.serverSeed = Shuffle.randomSeed(32); r.commit = Shuffle.commitHash(r.serverSeed); r.shoeId = r.id + ":" + r.handNumber;
      for (const s of r.seats) if (s) { s.bet = 0; s.cards = []; s.done = false; s.result = null; s.settled = false; s.clientSeed = ""; }
      r.deadline = now() + T.betting;
      // NOTE: deliberately no touch() here — opening a betting window is not player
      // activity. Only a real join/bet/action refreshes the idle clock, so a table
      // of seated-but-idle players still auto-closes at T.idle instead of looping forever.
      r.timers.betting = setT(() => endBetting(r), T.betting);
      broadcastState(r);
    }
    function endBetting(r) {
      clrT(r.timers.betting);
      const active = r.seats.filter((s) => s && s.bet > 0);
      if (active.length === 0) {
        // nobody bet this window — keep cycling for still-seated players, else go idle
        if (r.seats.some(Boolean)) return startBetting(r);
        r.phase = "idle"; broadcastState(r); reapEmptyExtras(); return;
      }
      deal(r);
    }
    function deal(r) {
      r.phase = "dealing";
      const seatSeeds = r.seats.map((s) => (s && s.bet > 0) ? (s.clientSeed || "") : "");
      r.shoe = Shuffle.shuffle(r.serverSeed, Shuffle.joinClientSeeds(seatSeeds), r.shoeId, config.decks); r.pos = 0;
      const active = []; for (let i = 0; i < 4; i++) if (r.seats[i] && r.seats[i].bet > 0) active.push(i);
      for (const i of active) r.seats[i].cards = [r.shoe[r.pos++]];   // first card each
      r.dealer = [r.shoe[r.pos++]];                                    // dealer upcard
      for (const i of active) r.seats[i].cards.push(r.shoe[r.pos++]);  // second card each
      r.dealer.push(r.shoe[r.pos++]);                                  // dealer hole
      // dealer peek + player naturals
      const dealerBJ = Rules.dealerPeeks(r.dealer, config) && Rules.handValue(r.dealer).blackjack;
      for (const i of active) { const hv = Rules.handValue(r.seats[i].cards); if (hv.blackjack) r.seats[i].done = true; }
      broadcast(r, { type: "bj:event", kind: "deal", roomId: r.id });
      if (dealerBJ) { r.phase = "dealer"; return settle(r); }
      r.phase = "turns"; r.turnIdx = -1; nextTurn(r);
    }
    function activeIdxs(r) { const a = []; for (let i = 0; i < 4; i++) if (r.seats[i] && r.seats[i].bet > 0) a.push(i); return a; }
    function nextTurn(r) {
      const a = activeIdxs(r);
      let start = r.turnIdx;
      for (let k = 0; k < 4; k++) { start++; if (start > 3) break; const s = r.seats[start];
        if (s && s.bet > 0 && !s.done) { r.turnIdx = start; return startTurn(r); } }
      // no one left to act
      r.turnIdx = -1; dealerPlay(r);
    }
    function startTurn(r) {
      const s = r.seats[r.turnIdx];
      const legal = Rules.legalActions({ cards: s.cards, bet: s.bet, firstAction: s.cards.length === 2 }, { balance: bank.get(s.wallet), config, numHands: 1 })
        .filter((x) => x === "hit" || x === "stand"); // MVP
      r.deadline = now() + T.turn; touch(r);
      r.timers.turn = setT(() => { applyAction(r, r.turnIdx, "stand", true); }, T.turn);
      broadcast(r, { type: "bj:turn", roomId: r.id, seat: r.turnIdx, legalActions: legal, deadline: r.deadline });
      broadcastState(r);
    }
    function applyAction(r, seatIdx, action, auto) {
      const s = r.seats[seatIdx]; if (!s || r.phase !== "turns" || r.turnIdx !== seatIdx || s.done) return;
      clrT(r.timers.turn); touch(r);
      if (action === "hit") {
        s.cards.push(r.shoe[r.pos++]); const hv = Rules.handValue(s.cards);
        if (hv.bust) { s.done = true; broadcast(r, { type: "bj:event", kind: "bust", seat: seatIdx }); nextTurn(r); }
        else if (hv.total === 21) { s.done = true; nextTurn(r); }
        else { startTurn(r); }
      } else { // stand
        s.done = true; nextTurn(r);
      }
    }
    function dealerPlay(r) {
      r.phase = "dealer"; broadcastState(r); // reveal hole
      while (Rules.dealerShouldHit(r.dealer, config)) r.dealer.push(r.shoe[r.pos++]);
      settle(r);
    }
    function settle(r) {
      r.phase = "settle"; const dealer = { cards: r.dealer }; const perSeat = [];
      for (let i = 0; i < 4; i++) { const s = r.seats[i]; if (!s || !(s.bet > 0)) continue;
        const res = Rules.settleHand({ cards: s.cards }, dealer, config); const payout = Math.round(s.bet * res.returnMult * 100) / 100;
        if (payout > 0) bank.credit(s.wallet, payout); s.settled = true;
        s.result = { outcome: res.outcome, payout, delta: Math.round((payout - s.bet) * 100) / 100 };
        perSeat.push({ seat: i, wallet: s.wallet, cards: s.cards, total: Rules.handValue(s.cards).total, outcome: res.outcome, payout, delta: s.result.delta });
        pushWallet(s.sock, s.wallet);
      }
      broadcastState(r);
      broadcast(r, { type: "bj:settle", roomId: r.id, perSeat, dealerTotal: Rules.handValue(r.dealer).total });
      broadcast(r, { type: "bj:reveal", roomId: r.id, serverSeed: r.serverSeed, commit: r.commit, shoeId: r.shoeId,
        clientSeeds: r.seats.map((s) => (s && s.bet > 0) ? (s.clientSeed || "") : ""), decks: config.decks });
      touch(r);
      r.timers.between = setT(() => { if (r.seats.some(Boolean)) startBetting(r); else { r.phase = "idle"; broadcastState(r); } }, T.between);
    }

    /* ---------------- intents ---------------- */
    function seatOf(r, sock) { for (let i = 0; i < 4; i++) if (r.seats[i] && r.seats[i].sock === sock) return i; return -1; }
    function err(sock, code, msg, intent) { send(sock, { type: "bj:error", code, msg, intent }); }

    function join(sock, wallet, roomId, seatPref) {
      let r = roomId ? rooms.get(roomId) : openRoom(); if (!r) r = openRoom(); if (!r) return err(sock, "lobby_full", "No tables available");
      if (r.seats.some((s) => s && s.wallet === wallet)) return err(sock, "already_seated", "One seat per table", "join");
      let idx = -1;
      if (seatPref != null && !r.seats[seatPref]) idx = seatPref; else idx = r.seats.findIndex((s) => !s);
      if (idx < 0) return err(sock, "table_full", "Table is full", "join");
      r.seats[idx] = { sock, wallet, bet: 0, clientSeed: "", cards: [], done: false, result: null, settled: false };
      r.spectators.delete(sock);
      const seated = r.seats.filter(Boolean).length;
      if (seated === 4) { r.full = true; createRoom(); }      // create-when-full: always a warm table
      touch(r);
      send(sock, Object.assign(snapshot(r), { you: { roomId: r.id, seat: idx, balance: bank.get(wallet) } }));
      pushWallet(sock, wallet);
      broadcast(r, { type: "bj:event", kind: "seatTaken", seat: idx, wallet });
      if (r.phase === "idle") startBetting(r); else broadcastState(r);
      pushLobby(); return r;
    }
    function watch(sock, roomId) { const r = rooms.get(roomId); if (!r) return err(sock, "no_room", "Room not found", "watch"); r.spectators.add(sock); send(sock, snapshot(r)); pushLobby(); }
    function leave(sock) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i >= 0) {
        const s = r.seats[i]; if (s.bet > 0 && !s.settled && r.phase === "betting") { bank.credit(s.wallet, s.bet); pushWallet(s.sock, s.wallet); }
        r.seats[i] = null; r.full = false; broadcast(r, { type: "bj:event", kind: "seatOpen", seat: i });
        if (r.seats.every((x) => !x) && r.phase !== "idle") { /* let round finish; reap when idle */ }
        broadcastState(r); reapEmptyExtras(); pushLobby(); return;
      } r.spectators.delete(sock); }
    }
    function placeBet(sock, amountUsd, clientSeed) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        if (r.phase !== "betting") return err(sock, "not_betting", "Betting is closed", "bet");
        const amt = Math.round((+amountUsd) * 100) / 100;
        if (!(amt >= config.minBet)) return err(sock, "min_bet", "Minimum bet is $" + config.minBet, "bet");
        if (bank.get(r.seats[i].wallet) < amt) return err(sock, "insufficient", "Not enough balance", "bet");
        if (r.seats[i].bet > 0) bank.credit(r.seats[i].wallet, r.seats[i].bet); // re-bet replaces
        bank.debit(r.seats[i].wallet, amt); r.seats[i].bet = amt; r.seats[i].clientSeed = clientSeed || Shuffle.randomSeed(8);
        touch(r); pushWallet(sock, r.seats[i].wallet); broadcastState(r);
        // deal early once everyone seated is in — no reason to burn the rest of the window
        var seated = r.seats.filter(Boolean);
        if (seated.length && seated.every((s) => s.bet > 0)) { clrT(r.timers.betting); endBetting(r); }
        return;
      }
      err(sock, "no_seat", "Take a seat first", "bet");
    }
    function action(sock, act) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        if (r.turnIdx !== i || r.phase !== "turns") return err(sock, "not_your_turn", "Not your turn", "action");
        if (act !== "hit" && act !== "stand") return err(sock, "bad_action", "Unsupported action (MVP)", "action");
        return applyAction(r, i, act, false);
      }
      err(sock, "no_seat", "You are not seated", "action");
    }

    /* ---------------- router ---------------- */
    function handle(sock, m) {
      switch (m.type) {
        case "bj:lobby:subscribe": lobbySubs.add(sock); send(sock, { type: "bj:lobby:list", rooms: lobbyList() }); if (m.wallet) pushWallet(sock, m.wallet); break;
        case "bj:lobby:unsubscribe": lobbySubs.delete(sock); break;
        case "bj:room:join": join(sock, m.wallet || (sock.wallet) || "anon", m.roomId, m.seatPref); break;
        case "bj:room:watch": watch(sock, m.roomId); break;
        case "bj:room:leave": leave(sock); break;
        case "bj:bet:place": placeBet(sock, m.amountUsd, m.clientSeed); break;
        case "bj:action": action(sock, m.action); break;
        default: break;
      }
    }
    function onClose(sock) { lobbySubs.delete(sock); leave(sock); }

    // ensure one warm open table exists
    createRoom();
    return { handle, onClose, bank, config,
      _mgr: { rooms, openRoom, createRoom, closeRoom, lobbyList },
      _room: { startBetting, endBetting, deal, applyAction, dealerPlay, settle, snapshot } };
  }

  const API = { attachBlackjack, makeBank };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.BlackjackServer = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
