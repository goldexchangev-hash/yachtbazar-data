/* ============================================================
   blackjack-server.js — server-authoritative multiplayer blackjack room engine.
   The server owns the shoe, deals, validates every intent, runs the timers, and
   is the only writer of balances. Clients send intents and render snapshots.

   Full player action set: hit, stand, DOUBLE down, SPLIT (to 4 hands; split aces
   get one card; double-after-split), late SURRENDER, and INSURANCE (when the
   dealer shows an Ace). A seat therefore holds 1..4 hands.

   Plug into the existing ws server:
     const bj = attachBlackjack({ startBalance: 5000 });
     wss.on('connection', (sock) => sock.on('message', (raw) => {
       let m; try { m = JSON.parse(raw); } catch { return; }
       if (typeof m.type === 'string' && m.type.startsWith('bj:')) bj.handle(sock, m);
     }));
   ============================================================ */
(function (root) {
  "use strict";
  const Rules = (typeof require !== "undefined") ? require("../public/blackjack-rules.js") : root.BlackjackRules;
  const Shuffle = (typeof require !== "undefined") ? require("../public/blackjack-shuffle.js") : root.BlackjackShuffle;

  function makeBank(start) {
    const m = new Map(); const get = (w) => { if (!m.has(w)) m.set(w, start == null ? 5000 : start); return m.get(w); };
    return { get, all: m, credit: (w, a) => m.set(w, Math.round((get(w) + a) * 100) / 100), debit: (w, a) => { if (get(w) < a) return false; m.set(w, Math.round((get(w) - a) * 100) / 100); return true; } };
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  function newHand(bet, opts) { return Object.assign({ cards: [], bet: bet, done: false, doubled: false, fromSplit: false, isAceSplit: false, surrendered: false, result: null }, opts || {}); }

  function attachBlackjack(opts) {
    opts = opts || {};
    const config = Object.assign({}, Rules.DEFAULT_CONFIG, opts.config || {});
    const T = Object.assign({ betting: 15000, turn: 20000, insurance: 12000, idle: 300000, between: 3500, dealReveal: 0, dealPace: 0, dealerReveal: 0, dealerPace: 0 }, opts.timers || {});
    const bank = opts.bank || makeBank(opts.startBalance);
    const MAX_ROOMS = opts.maxRooms || 50;
    const setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
    const clrT = opts.clearTimeout || clearTimeout;
    const now = opts.now || (() => Date.now());
    const makeShoe = opts.makeShoe || Shuffle.shuffle; // injectable for deterministic tests / VRF-derived shoe
    // Randomness provider seam (see VRF-READINESS.md). DEFAULT = local commit-reveal:
    // publish commit = SHA256(serverSeed) before bets, reveal serverSeed after. To go
    // on-chain, pass a Chainlink-VRF-backed provider whose begin() returns the VRF word
    // as serverSeed plus its on-chain proof — nothing else in the engine changes.
    const randomness = opts.randomness || { name: "commit-reveal", begin: function () { const ss = Shuffle.randomSeed(32); return { serverSeed: ss, commit: Shuffle.commitHash(ss), proof: null }; } };
    const send = (sock, obj) => { if (sock && sock.send) try { sock.send(JSON.stringify(obj)); } catch (e) {} };

    const rooms = new Map(); let seq = 0; const lobbySubs = new Set();

    const inRound = (s) => !!(s && s.baseBet > 0);
    const seatStake = (s) => !s ? 0 : (s.hands && s.hands.length ? s.hands.reduce((a, h) => a + h.bet, 0) : (s.baseBet || 0)) + (s.insurance || 0);
    const draw = (r) => r.shoe[r.pos++];

    /* ---------------- lobby ---------------- */
    function roomPublic(r) {
      return { id: r.id, name: r.name, seated: r.seats.filter(Boolean).length, openSeats: r.seats.filter((s) => !s).length,
        phase: r.phase, inProgress: r.phase !== "idle" && r.phase !== "betting", minBet: config.minBet,
        tableBet: r.seats.reduce((a, s) => a + seatStake(s), 0), spectators: r.spectators.size, commit: r.commit };
    }
    // Show ALL active tables so visitors can find in-progress/full ones to WATCH —
    // not just joinable ones. The lobby card disables JOIN when full; WATCH is always on.
    function lobbyList() { return Array.from(rooms.values()).map(roomPublic); }
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
    function reapEmptyExtras() {
      const empties = Array.from(rooms.values()).filter((r) => r.seats.every((s) => !s) && r.phase === "idle");
      for (let i = 1; i < empties.length; i++) closeRoom(empties[i], "reaped");
    }
    function touch(r) { r.lastActivity = now(); scheduleIdle(r); }
    function scheduleIdle(r) { if (r.timers.idle) clrT(r.timers.idle); r.timers.idle = setT(() => {
      const inHand = r.phase !== "idle" && r.phase !== "betting";
      if (!inHand && now() - r.lastActivity >= T.idle) closeRoom(r, "idle"); else scheduleIdle(r);
    }, T.idle); }
    function closeRoom(r, reason) {
      for (const s of r.seats) if (s) { const refund = seatStake(s); if (refund > 0 && !s.settled) { bank.credit(s.wallet, refund); s.baseBet = 0; s.hands = []; s.insurance = 0; pushWallet(s.sock, s.wallet); } }
      for (const k in r.timers) clrT(r.timers[k]);
      broadcast(r, { type: "bj:event", kind: "roomClosing", id: r.id, reason });
      if (r.serverSeed) broadcast(r, { type: "bj:reveal", roomId: r.id, serverSeed: r.serverSeed, commit: r.commit });
      rooms.delete(r.id); pushLobby();
      if (rooms.size === 0) createRoom(); // never leave the lobby empty — always keep one warm table
    }

    /* ---------------- broadcast / snapshot ---------------- */
    function broadcast(r, obj) { for (const s of r.seats) if (s) send(s.sock, obj); for (const sp of r.spectators) send(sp, obj); }
    function pushWallet(sock, wallet) { send(sock, { type: "bj:wallet", balance: bank.get(wallet) }); }
    function handView(h) { const hv = Rules.handValue(h.cards);
      return { cards: h.cards, total: hv.total, soft: hv.soft, bust: hv.bust, blackjack: hv.blackjack && !h.fromSplit,
        done: !!h.done, doubled: !!h.doubled, fromSplit: !!h.fromSplit, surrendered: !!h.surrendered, bet: h.bet, result: h.result || null }; }
    function seatView(s) { if (!s) return null;
      const ins = s.insurance || (s.insuranceResult && s.insuranceResult.taken ? s.insuranceResult.amount : 0);
      return { wallet: s.wallet, baseBet: s.baseBet || 0, active: s.active == null ? -1 : s.active, insurance: ins, left: !!s.left,
        hands: (s.hands || []).map(handView), bet: seatStake(s) }; }
    function snapshot(r) {
      const showHole = r.phase === "dealer" || r.phase === "settle";
      const dealer = { cards: showHole ? r.dealer : r.dealer.slice(0, 1), total: showHole && r.dealer.length ? Rules.handValue(r.dealer).total : null,
        holeHidden: !showHole && r.dealer.length > 1, upAce: r.dealer.length ? r.dealer[0].rank === "A" : false };
      return { type: "bj:room:snapshot", roomId: r.id, phase: r.phase, deadline: r.deadline, serverNow: now(), version: ++r.version,
        seats: r.seats.map(seatView), dealer, turnIdx: r.turnIdx, commit: r.commit, handNumber: r.handNumber };
    }
    function broadcastState(r) { broadcast(r, snapshot(r)); pushLobby(); }

    /* ---------------- round loop ---------------- */
    function startBetting(r) {
      // drop anyone who abandoned the prior hand (their hands already settled on merits)
      for (let i = 0; i < 4; i++) { const s = r.seats[i]; if (s && s.left) { r.seats[i] = null; r.full = false; broadcast(r, { type: "bj:event", kind: "seatOpen", seat: i }); } }
      if (!r.seats.some(Boolean)) { r.phase = "idle"; broadcastState(r); reapEmptyExtras(); return; }
      r.phase = "betting"; r.handNumber++; r.dealer = []; r.turnIdx = -1;
      r.shoeId = r.id + ":" + r.handNumber;
      const rnd = randomness.begin(r.shoeId);
      r.serverSeed = rnd.serverSeed; r.commit = rnd.commit; r.proof = rnd.proof || null;
      for (const s of r.seats) if (s) { s.baseBet = 0; s.hands = []; s.active = -1; s.insurance = 0; s.insuranceResult = null; s.insuranceDecided = false; s.left = false; s.settled = false; s.clientSeed = ""; }
      r.deadline = now() + T.betting;
      // no touch() here — opening a window isn't player activity; abandoned tables still idle-close.
      r.timers.betting = setT(() => endBetting(r), T.betting);
      broadcastState(r);
    }
    function endBetting(r) {
      clrT(r.timers.betting);
      const active = r.seats.filter(inRound);
      if (active.length === 0) { if (r.seats.some(Boolean)) return startBetting(r); r.phase = "idle"; broadcastState(r); reapEmptyExtras(); return; }
      deal(r);
    }
    function deal(r) {
      r.phase = "dealing";
      const seatSeeds = r.seats.map((s) => inRound(s) ? (s.clientSeed || "") : "");
      r.shoe = makeShoe(r.serverSeed, Shuffle.joinClientSeeds(seatSeeds), r.shoeId, config.decks); r.pos = 0;
      const act = []; for (let i = 0; i < 4; i++) if (inRound(r.seats[i])) act.push(i);
      for (const i of act) { r.seats[i].hands = [newHand(r.seats[i].baseBet)]; r.seats[i].active = 0; }
      r.dealer = [];
      // classic deal order, one card at a time: each seat 1st card, dealer up, each seat 2nd, dealer hole
      const queue = [];
      for (const i of act) queue.push({ seat: i });
      queue.push({ dealer: 1 });
      for (const i of act) queue.push({ seat: i });
      queue.push({ dealer: 1 });
      r._dealQ = queue;
      if (T.dealPace > 0) { r.timers.deal = setT(() => dealStep(r), T.dealReveal || T.dealPace); } // suspenseful, card by card
      else { while (r._dealQ.length) dealOne(r); finishDeal(r); }                                   // synchronous (tests / off)
    }
    function dealOne(r) { const t = r._dealQ.shift(); if (t.dealer) r.dealer.push(draw(r)); else r.seats[t.seat].hands[0].cards.push(draw(r)); }
    function dealStep(r) {
      if (r.phase !== "dealing") return;
      dealOne(r); broadcastState(r);
      if (r._dealQ.length) r.timers.deal = setT(() => dealStep(r), T.dealPace);
      else finishDeal(r);
    }
    function finishDeal(r) {
      const act = []; for (let i = 0; i < 4; i++) if (inRound(r.seats[i])) act.push(i);
      for (const i of act) { if (Rules.handValue(r.seats[i].hands[0].cards).blackjack) r.seats[i].hands[0].done = true; } // naturals stand
      broadcast(r, { type: "bj:event", kind: "deal", roomId: r.id });
      // insurance first (dealer Ace, peek on), then dealer-BJ resolution, then play
      if (config.peek && r.dealer[0].rank === "A") return offerInsurance(r);
      const dealerBJ = Rules.dealerPeeks(r.dealer, config) && Rules.handValue(r.dealer).blackjack;
      if (dealerBJ) { r.phase = "dealer"; return settle(r); }
      beginPlay(r);
    }

    /* ---------------- insurance ---------------- */
    function offerInsurance(r) {
      r.phase = "insurance"; r.deadline = now() + T.insurance;
      for (const s of r.seats) if (inRound(s)) s.insuranceDecided = false;
      r.timers.insurance = setT(() => closeInsurance(r), T.insurance);
      broadcast(r, { type: "bj:insurance:offer", roomId: r.id, deadline: r.deadline, maxFactor: 0.5 });
      broadcastState(r);
    }
    function takeInsurance(r, seatIdx, take) {
      const s = r.seats[seatIdx]; if (!s || r.phase !== "insurance" || !inRound(s) || s.insuranceDecided) return;
      s.insuranceDecided = true;
      if (take) {
        const amt = r2(s.baseBet * 0.5);
        if (bank.get(s.wallet) >= amt) { bank.debit(s.wallet, amt); s.insurance = amt; pushWallet(s.sock, s.wallet); }
      }
      touch(r);
      if (r.seats.filter(inRound).every((x) => x.insuranceDecided)) closeInsurance(r);
      else broadcastState(r);
    }
    function closeInsurance(r) {
      clrT(r.timers.insurance);
      const dealerBJ = Rules.handValue(r.dealer).blackjack;
      for (const s of r.seats) if (inRound(s) && s.insurance > 0) {
        const amount = s.insurance;
        if (dealerBJ) { const win = r2(amount * 3); bank.credit(s.wallet, win); s.insuranceResult = { taken: true, amount, won: true, payout: win }; pushWallet(s.sock, s.wallet); }
        else s.insuranceResult = { taken: true, amount, won: false, payout: 0 };
        s.insurance = 0; // resolved → no longer an in-flight escrow (closeRoom must not refund a lost insurance)
      }
      broadcast(r, { type: "bj:insurance:result", roomId: r.id, dealerBlackjack: dealerBJ });
      if (dealerBJ) { r.phase = "dealer"; return settle(r); }
      beginPlay(r);
    }

    /* ---------------- player turns ---------------- */
    function beginPlay(r) {
      // if every active hand is already resolved (all naturals), go straight to the dealer
      const anyToPlay = r.seats.some((s) => inRound(s) && s.hands.some((h) => !h.done));
      if (!anyToPlay) { dealerPlay(r); return; }
      r.phase = "turns"; r.turnIdx = -1; nextSeat(r);
    }
    function nextSeat(r) {
      let idx = r.turnIdx;
      for (let k = 0; k < 4; k++) { idx++; if (idx > 3) break; const s = r.seats[idx];
        if (inRound(s) && s.hands.some((h) => !h.done)) { r.turnIdx = idx; s.active = s.hands.findIndex((h) => !h.done); return startTurn(r); } }
      r.turnIdx = -1; dealerPlay(r);
    }
    function advanceHand(r) {
      const s = r.seats[r.turnIdx];
      for (let i = s.active + 1; i < s.hands.length; i++) if (!s.hands[i].done) { s.active = i; return startTurn(r); }
      nextSeat(r); // seat fully done
    }
    function startTurn(r) {
      const s = r.seats[r.turnIdx], h = s.hands[s.active];
      if (h.cards.length === 1) {                    // a freshly-split hand: deal its second card now
        h.cards.push(draw(r));
        if (h.isAceSplit) { h.done = true; return advanceHand(r); }          // split aces: one card, done
        if (Rules.handValue(h.cards).total === 21) { h.done = true; return advanceHand(r); } // 21 (not a natural) auto-stands
      }
      const hv = Rules.handValue(h.cards);
      if (hv.bust || hv.total === 21) { h.done = true; return advanceHand(r); }
      const legal = Rules.legalActions(
        { cards: h.cards, bet: h.bet, firstAction: h.cards.length === 2 && !h.doubled, fromSplit: h.fromSplit, isAceSplit: h.isAceSplit, doubled: h.doubled, done: h.done },
        { balance: bank.get(s.wallet), config, numHands: s.hands.length });
      r.deadline = now() + T.turn; touch(r);
      r.timers.turn = setT(() => applyAction(r, r.turnIdx, "stand", true), T.turn);
      broadcast(r, { type: "bj:turn", roomId: r.id, seat: r.turnIdx, hand: s.active, legalActions: legal, deadline: r.deadline });
      broadcastState(r);
    }
    function applyAction(r, seatIdx, action, auto) {
      const s = r.seats[seatIdx];
      if (!s) { if (auto && r.phase === "turns" && r.turnIdx === seatIdx) { clrT(r.timers.turn); nextSeat(r); } return; } // vacated mid-turn → advance, don't strand
      if (r.phase !== "turns" || r.turnIdx !== seatIdx) return;
      const h = s.hands[s.active]; if (!h || h.done) return;
      const legal = Rules.legalActions(
        { cards: h.cards, bet: h.bet, firstAction: h.cards.length === 2 && !h.doubled, fromSplit: h.fromSplit, isAceSplit: h.isAceSplit, doubled: h.doubled, done: h.done },
        { balance: bank.get(s.wallet), config, numHands: s.hands.length });
      if (!auto && legal.indexOf(action) < 0) return err(s.sock, "illegal_action", "That move isn't allowed here", "action");
      clrT(r.timers.turn); touch(r);

      if (action === "hit") {
        h.cards.push(draw(r)); const hv = Rules.handValue(h.cards);
        if (hv.bust) { h.done = true; broadcast(r, { type: "bj:event", kind: "bust", seat: seatIdx, hand: s.active }); advanceHand(r); }
        else if (hv.total === 21) { h.done = true; advanceHand(r); }
        else startTurn(r);
      } else if (action === "stand") {
        h.done = true; advanceHand(r);
      } else if (action === "double") {
        bank.debit(s.wallet, h.bet); h.bet = r2(h.bet * 2); h.doubled = true; pushWallet(s.sock, s.wallet);
        h.cards.push(draw(r)); h.done = true;
        broadcast(r, { type: "bj:event", kind: "double", seat: seatIdx, hand: s.active }); advanceHand(r);
      } else if (action === "surrender") {
        h.surrendered = true; h.done = true; advanceHand(r);
      } else if (action === "split") {
        bank.debit(s.wallet, h.bet); pushWallet(s.sock, s.wallet);
        const isAce = h.cards[0].rank === "A";
        const moved = h.cards.pop();                       // second pair card seeds the new hand
        h.fromSplit = true; h.isAceSplit = isAce;          // the original hand is now a split hand
        const fresh = newHand(h.bet, { fromSplit: true, isAceSplit: isAce, cards: [moved] });
        s.hands.splice(s.active + 1, 0, fresh);
        broadcast(r, { type: "bj:event", kind: "split", seat: seatIdx });
        startTurn(r); // re-enters with the (now 1-card) original hand → deals its 2nd card
      }
    }
    function dealerPlay(r) {
      r.phase = "dealer"; broadcastState(r); // reveal hole
      // dealer only draws if at least one non-surrendered, non-busted hand is live
      const live = r.seats.some((s) => inRound(s) && s.hands.some((h) => !h.surrendered && !Rules.handValue(h.cards).bust));
      if (!live) return settle(r);
      if (T.dealerPace > 0) { r.timers.dealer = setT(() => dealerStep(r), T.dealerReveal || T.dealerPace); return; } // paced: one card at a time, with suspense
      while (Rules.dealerShouldHit(r.dealer, config)) r.dealer.push(draw(r)); // synchronous (pacing off / tests)
      settle(r);
    }
    // one paced dealer draw, then schedule the next — gives the table its suspense
    function dealerStep(r) {
      if (r.phase !== "dealer") return;
      if (Rules.dealerShouldHit(r.dealer, config)) { r.dealer.push(draw(r)); broadcastState(r); r.timers.dealer = setT(() => dealerStep(r), T.dealerPace); }
      else settle(r);
    }
    function settle(r) {
      r.phase = "settle"; const perSeat = [];
      for (let i = 0; i < 4; i++) { const s = r.seats[i]; if (!inRound(s)) continue;
        let net = 0; const handsOut = [];
        for (const h of s.hands) {
          const res = Rules.settleHand({ cards: h.cards, surrendered: h.surrendered, fromSplit: h.fromSplit }, { cards: r.dealer }, config);
          const payout = r2(h.bet * res.returnMult);
          if (payout > 0) bank.credit(s.wallet, payout);
          h.result = { outcome: res.outcome, payout, delta: r2(payout - h.bet) };
          net = r2(net + h.result.delta);
          handsOut.push({ cards: h.cards, total: Rules.handValue(h.cards).total, outcome: res.outcome, payout, delta: h.result.delta, doubled: h.doubled, fromSplit: h.fromSplit, surrendered: h.surrendered });
        }
        const ir = s.insuranceResult;
        if (ir && ir.taken) net = r2(net + (ir.payout || 0) - (ir.amount || 0));
        s.settled = true; pushWallet(s.sock, s.wallet);
        perSeat.push({ seat: i, wallet: s.wallet, hands: handsOut, insurance: (ir && ir.taken) ? { amount: ir.amount, won: !!ir.won, payout: ir.payout || 0 } : null, net });
      }
      broadcastState(r);
      broadcast(r, { type: "bj:settle", roomId: r.id, perSeat, dealerTotal: Rules.handValue(r.dealer).total, dealerBlackjack: Rules.handValue(r.dealer).blackjack });
      broadcast(r, { type: "bj:reveal", roomId: r.id, serverSeed: r.serverSeed, commit: r.commit, shoeId: r.shoeId,
        clientSeeds: r.seats.map((s) => inRound(s) ? (s.clientSeed || "") : ""), decks: config.decks,
        source: randomness.name || "commit-reveal", proof: r.proof || null });
      touch(r);
      r.timers.between = setT(() => { if (r.seats.some(Boolean)) startBetting(r); else { r.phase = "idle"; broadcastState(r); } }, T.between);
    }

    /* ---------------- intents ---------------- */
    function seatOf(r, sock) { for (let i = 0; i < 4; i++) if (r.seats[i] && r.seats[i].sock === sock) return i; return -1; }
    function err(sock, code, msg, intent) { send(sock, { type: "bj:error", code, msg, intent }); }

    function join(sock, wallet, roomId, seatPref) {
      for (const rr of rooms.values()) if (seatOf(rr, sock) >= 0) return err(sock, "already_seated", "Leave your current table first", "join"); // one seat per connection, across all tables
      let r = roomId ? rooms.get(roomId) : openRoom(); if (!r) r = openRoom(); if (!r) return err(sock, "lobby_full", "No tables available");
      if (r.seats.some((s) => s && s.wallet === wallet)) return err(sock, "already_seated", "One seat per table", "join");
      let idx = -1;
      if (seatPref != null && !r.seats[seatPref]) idx = seatPref; else idx = r.seats.findIndex((s) => !s);
      if (idx < 0) return err(sock, "table_full", "Table is full", "join");
      r.seats[idx] = { sock, wallet, baseBet: 0, clientSeed: "", hands: [], active: -1, insurance: 0, settled: false };
      r.spectators.delete(sock);
      if (r.seats.filter(Boolean).length === 4) { r.full = true; createRoom(); }
      touch(r);
      send(sock, Object.assign(snapshot(r), { you: { roomId: r.id, seat: idx, balance: bank.get(wallet) } }));
      pushWallet(sock, wallet);
      broadcast(r, { type: "bj:event", kind: "seatTaken", seat: idx, wallet });
      if (r.phase === "idle") startBetting(r); else broadcastState(r);
      pushLobby(); return r;
    }
    function watch(sock, roomId) { const r = rooms.get(roomId); if (!r) return err(sock, "no_room", "Room not found", "watch"); r.spectators.add(sock); send(sock, snapshot(r)); pushLobby(); }
    function leave(sock) {
      // clear the socket from EVERY room it occupies (seat or spectator), not just the first
      for (const r of rooms.values()) {
        r.spectators.delete(sock);
        const i = seatOf(r, sock); if (i < 0) continue;
        const s = r.seats[i];
        if (r.phase === "betting" || r.phase === "idle") {
          if (s.baseBet > 0) { bank.credit(s.wallet, s.baseBet); pushWallet(s.sock, s.wallet); } // refund the un-dealt bet
          r.seats[i] = null; r.full = false;
          broadcast(r, { type: "bj:event", kind: "seatOpen", seat: i });
          broadcastState(r); reapEmptyExtras();
        } else {
          // abandoning a LIVE hand: stop acting; the dealt hands settle on their merits
          // (a winning hand still pays), then the seat is dropped at the next startBetting.
          // This fixes both the turn-deadlock and the silent escrow forfeiture.
          s.left = true;
          if (s.hands) for (const h of s.hands) h.done = true;
          broadcast(r, { type: "bj:event", kind: "seatLeaving", seat: i, wallet: s.wallet });
          if (r.phase === "turns" && r.turnIdx === i) { clrT(r.timers.turn); nextSeat(r); }
          else if (r.phase === "insurance") { s.insuranceDecided = true; if (r.seats.filter(inRound).every((x) => x.insuranceDecided)) closeInsurance(r); else broadcastState(r); }
          else broadcastState(r);
        }
        pushLobby();
      }
    }
    function placeBet(sock, amountUsd, clientSeed) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        if (r.phase !== "betting") return err(sock, "not_betting", "Betting is closed", "bet");
        const amt = r2(+amountUsd); const s = r.seats[i];
        if (!(amt >= config.minBet)) return err(sock, "min_bet", "Minimum bet is $" + config.minBet, "bet");
        if (bank.get(s.wallet) + (s.baseBet || 0) < amt) return err(sock, "insufficient", "Not enough balance", "bet");
        if (s.baseBet > 0) bank.credit(s.wallet, s.baseBet); // re-bet replaces
        bank.debit(s.wallet, amt); s.baseBet = amt; s.clientSeed = clientSeed || Shuffle.randomSeed(8);
        touch(r); pushWallet(sock, s.wallet); broadcastState(r);
        const seated = r.seats.filter(Boolean);
        if (seated.length && seated.every((x) => x.baseBet > 0)) { clrT(r.timers.betting); endBetting(r); }
        return;
      }
      err(sock, "no_seat", "Take a seat first", "bet");
    }
    function action(sock, act) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        if (r.turnIdx !== i || r.phase !== "turns") return err(sock, "not_your_turn", "Not your turn", "action");
        if (["hit", "stand", "double", "split", "surrender"].indexOf(act) < 0) return err(sock, "bad_action", "Unknown action", "action");
        return applyAction(r, i, act, false);
      }
      err(sock, "no_seat", "You are not seated", "action");
    }
    function insurance(sock, take) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        if (r.phase !== "insurance") return err(sock, "no_insurance", "Insurance is closed", "insurance");
        return takeInsurance(r, i, !!take);
      }
    }

    /* ---------------- router ---------------- */
    function handle(sock, m) {
      switch (m.type) {
        // Identity is the CONNECTION's trusted wallet (stamped by the transport), never
        // the client-supplied m.wallet — so the engine is self-enforcing if reused.
        case "bj:lobby:subscribe": { lobbySubs.add(sock); if (rooms.size === 0) createRoom(); send(sock, { type: "bj:lobby:list", rooms: lobbyList() }); const w = sock.wallet || m.wallet; if (w) pushWallet(sock, w); break; }
        case "bj:lobby:unsubscribe": lobbySubs.delete(sock); break;
        case "bj:room:join": join(sock, sock.wallet || m.wallet || "anon", m.roomId, m.seatPref); break;
        case "bj:room:watch": watch(sock, m.roomId); break;
        case "bj:room:leave": leave(sock); break;
        case "bj:bet:place": placeBet(sock, m.amountUsd, m.clientSeed); break;
        case "bj:action": action(sock, m.action); break;
        case "bj:insurance": insurance(sock, m.take); break;
        default: break;
      }
    }
    function onClose(sock) { lobbySubs.delete(sock); leave(sock); }

    createRoom();
    return { handle, onClose, bank, config,
      _mgr: { rooms, openRoom, createRoom, closeRoom, lobbyList },
      _room: { startBetting, endBetting, deal, applyAction, dealerPlay, settle, snapshot, takeInsurance, closeInsurance } };
  }

  const API = { attachBlackjack, makeBank };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.BlackjackServer = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
