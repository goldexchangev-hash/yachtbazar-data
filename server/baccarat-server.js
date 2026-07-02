/* ============================================================
   baccarat-server.js — server-authoritative multiplayer PUNTO BANCO room engine.
   Cloned from blackjack-server.js (the audited template) with ALL turn machinery
   deleted — baccarat has ZERO player decisions after betting. The server owns the
   committed shoe, deals both communal hands by the fixed tableau, validates every
   betting intent, runs the timers, and is the only writer of balances. Clients
   send intents and render snapshots.

   Round loop: idle → betting(15s) → dealing (P1,B1,P2,B2 paced) → reveal (third-
   card tableau via ../public/baccarat-rules.js, paced with a revealHold suspense
   beat) → settle (zoneReturnMult per seat per zone) → between → betting.

   Betting is ADDITIVE chip-tap semantics (spec §5): bac:bet:add debits escrow
   immediately, bac:bet:undo pops the last chip LIFO (a rebet pops as one unit),
   bac:bet:clear refunds all (rate-limited), bac:bet:rebet replays the last
   completed bet map atomically. One seat may never back BOTH Player and Banker
   (bac:error both_sides); Tie combines freely.

   Plug into the existing ws server:
     const bac = attachBaccarat({ startBalance: 5000 });
     wss.on('connection', (sock) => sock.on('message', (raw) => {
       let m; try { m = JSON.parse(raw); } catch { return; }
       if (typeof m.type === 'string' && m.type.startsWith('bac:')) bac.handle(sock, m);
     }));
   ============================================================ */
(function (root) {
  "use strict";
  const Rules = (typeof require !== "undefined") ? require("../public/baccarat-rules.js") : root.BaccaratRules;
  const Shuffle = (typeof require !== "undefined") ? require("../public/blackjack-shuffle.js") : root.BlackjackShuffle;

  function makeBank(start, persist) {
    const realWallet = (w) => /^0x[0-9a-fA-F]{40}$/.test(String(w || ""));
    const m = new Map();
    // DURABILITY: persist GUEST (play-money) balances out of process so a crash / deploy / idle
    // spin-down can't wipe a player's grown balance. Real (0x) wallets are bridged on-chain — never
    // persisted here. Write-through is debounced; every balance mutation routes through m.set.
    let saveT = null;
    const doSave = () => { saveT = null; if (!persist || !persist.save) return; try { const o = {}; for (const [k, v] of m) if (/^guest:/.test(k)) o[k] = v; persist.save(o); } catch (e) {} };
    const scheduleSave = () => { if (!persist || !persist.save || saveT) return; saveT = setTimeout(doSave, 800); };
    const rawSet = m.set.bind(m);
    m.set = (k, v) => { const out = rawSet(k, v); if (/^guest:/.test(String(k))) scheduleSave(); return out; };
    if (persist && persist.load) { try { const data = persist.load() || {}; for (const k in data) { const v = data[k]; if (/^guest:/.test(k) && typeof v === "number" && isFinite(v) && v >= 0) rawSet(k, Math.round(v * 100) / 100); } } catch (e) {} }
    const DEFAULT_GUEST = (start == null ? 5000 : start);
    // v6 #7 (BJ lesson, kept): get() is READ-ONLY — it must NOT vivify a new entry. A client could
    // loop bac:lobby:subscribe with random `guest:<rnd>` ids (pushWallet → get) with no hello and
    // balloon the map + bank file without bound (memory/disk DoS). The entry is created ONLY on a
    // real balance MUTATION (credit/debit/seed → m.set → persist), so only wallets that actually
    // PLAYED are persisted. Reads return the default without touching the map.
    const get = (w) => m.has(w) ? m.get(w) : (realWallet(w) ? 0 : DEFAULT_GUEST);
    return { get, all: m, flush: doSave, credit: (w, a) => m.set(w, Math.round((get(w) + a) * 100) / 100), debit: (w, a) => { if (get(w) < a) return false; m.set(w, Math.round((get(w) - a) * 100) / 100); return true; } };
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  // shared GUEST play-money caps (BJ v6 #1 pattern: seedGuest enforces the SAME ceiling as topUp)
  const GUEST_TOPUP_MAX = 5000, GUEST_BAL_CAP = 25000, GUEST_TOPUP_COOLDOWN = 3000;
  const MAX_EMPTY_WINDOWS = 3;   // after this many consecutive no-bet betting windows, drop the table to idle instead of re-arming forever
  const HISTORY_MAX = 90;        // Big Road window — last 90 coup outcomes ("P"/"B"/"T") per room (spec R5)
  const ZONES = ["player", "banker", "tie"];
  const zoneLabel = (z) => z === "player" ? "Player" : z === "banker" ? "Banker" : "Tie";

  function attachBaccarat(opts) {
    opts = opts || {};
    const config = Object.assign({}, Rules.DEFAULT_CONFIG, opts.config || {});
    // Timer block (spec R14). Pacing 0 ⇒ synchronous (tests / off), the BJ setT convention.
    // between is the TOTAL post-settle dwell; resultHold is the RESULT-display portion of it —
    // settle holds resultHold, then a short "between" sweep (between − resultHold), then betting
    // (matches the §3 choreography: 3.8s result + 0.7s sweep).
    const T = Object.assign({ betting: 15000, idle: 300000, between: 4500, dealPace: 450, revealHold: 700, revealPace: 650, resultHold: 3800 }, opts.timers || {});
    const bank = opts.bank || makeBank(opts.startBalance, opts.persist);
    const MAX_ROOMS = opts.maxRooms || 50;
    const _setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
    // CRASH SAFETY: every engine timer runs through this guard. server.js only try/catches the
    // SYNCHRONOUS handle(); a throw inside a setTimeout callback (dealStep/revealStep/settle/
    // between) would be an UNCAUGHT exception → Node process exit → the in-memory bank wiped.
    // This contains any such throw to a logged, non-fatal error (the v11.97 lesson).
    const setT = (f, ms) => _setT(() => { try { f(); } catch (e) { try { console.error("bac timer error:", (e && e.stack) || e); } catch (_) {} } }, ms);
    const clrT = opts.clearTimeout || clearTimeout;
    const now = opts.now || (() => Date.now());
    const makeShoe = opts.makeShoe || Shuffle.shuffle; // injectable for deterministic tests
    // Randomness provider seam — identical to blackjack. DEFAULT = local commit-reveal:
    // publish commit = SHA256(serverSeed) before bets, reveal serverSeed after settle.
    const randomness = opts.randomness || { name: "commit-reveal", begin: function () { const ss = Shuffle.randomSeed(32); return { serverSeed: ss, commit: Shuffle.commitHash(ss), proof: null }; } };
    const send = (sock, obj) => { if (sock && sock.send) try { sock.send(JSON.stringify(obj)); } catch (e) {} };

    const rooms = new Map(); let seq = 0; const lobbySubs = new Set();
    const norm = (w) => String(w || "").toLowerCase();
    const realWallet = (w) => /^0x[0-9a-fA-F]{40}$/.test(String(w || ""));

    // Per-zone stake caps (spec §5.4): zoneMax = floor(TOKEN_MAX_WIN_USD / net payout mult) —
    // Player $2000, Banker $2000 (clamped from $2105 for symmetry), Tie $250 at the default $2000
    // max win. Per-coup house exposure is exactly bounded at bet time.
    const MAX_WIN_USD = (() => { let v = +(opts.maxWinUsd != null ? opts.maxWinUsd : ((typeof process !== "undefined" && process.env && process.env.TOKEN_MAX_WIN_USD) || 2000)); if (!isFinite(v) || v <= 0) v = 2000; return v; })();
    const ZONE_MAX = {
      player: Math.floor(MAX_WIN_USD),
      banker: Math.floor(MAX_WIN_USD),
      tie: Math.max(config.minBet, Math.floor(MAX_WIN_USD / (config.tiePays || 8))),
    };

    const seatStake = (s) => !s ? 0 : r2((s.bets.player || 0) + (s.bets.banker || 0) + (s.bets.tie || 0));
    const inRound = (s) => !!(s && seatStake(s) > 0);

    // ── TOKEN-FUNDED tables: a real wallet's chips ARE their token-bridge session ──────────────────
    // When a player sits at a real-money table, their wallet is bound to their token session; the bank's
    // get/credit/debit for that wallet then route to the token ledger (a bet debits / a win credits the
    // SAME tokens they bought in with — no separate "lock credits" step, cash-out via the hardened token
    // settle). All money flows (addBet/undo/clear/rebet, settle, room-close refunds) go through
    // bank.get/credit/debit, so wrapping just those three covers every path. TL is late-bound from server.js.
    let TL = opts.tokenLedger || null;          // { tokensOf(sid), applyNet(player, sid, bet, payout) } — applyNet = tokenSvc.applyBaccaratNet (game:"baccarat")
    const tokenBind = new Map();                // wallet(lc) → token sessionId
    const tokenSid = (w) => tokenBind.get(norm(w));
    const isTokenWallet = (w) => !!(TL && tokenBind.has(norm(w)));
    {
      const _get = bank.get, _credit = bank.credit, _debit = bank.debit;
      bank.get = (w) => { if (isTokenWallet(w)) { const t = TL.tokensOf(tokenSid(w)); return t == null ? 0 : r2(t); } return _get(w); };
      bank.credit = (w, a) => {
        if (isTokenWallet(w)) {
          // A token credit (a payout / refund) should NEVER silently vanish on a real-money table. If applyNet
          // throws (session closed/settled) log loudly so a lost credit is diagnosable. By construction this is
          // unreachable for a settled session (hasLiveHand blocks the token settle while any seat is live).
          // Also RETURN a success flag so the settle path can surface a (theoretical) failed payout to the
          // player instead of showing a phantom win (BJ #6 pattern).
          let okCredit = true;
          try { TL.applyNet(w, tokenSid(w), 0, r2(a)); }
          catch (e) { okCredit = false; try { console.error("[bac] TOKEN CREDIT FAILED — payout NOT booked:", JSON.stringify({ wallet: w, amount: r2(a), session: tokenSid(w), err: (e && e.message) || String(e) })); } catch (e2) {} }
          return okCredit;
        }
        return _credit(w, a);
      };
      bank.debit = (w, a) => {
        if (isTokenWallet(w)) {
          if (bank.get(w) < r2(a) - 1e-9) return false;
          try { TL.applyNet(w, tokenSid(w), r2(a), 0); } catch (e) { try { console.error("[bac] TOKEN DEBIT FAILED — bet NOT placed:", JSON.stringify({ wallet: w, amount: r2(a), session: tokenSid(w), err: (e && e.message) || String(e) })); } catch (e2) {} return false; }
          return true;
        }
        return _debit(w, a);
      };
    }
    // IMMUTABILITY: the funding pool must not change during a live coup, or a bet's debit and the round's
    // credit could route to different sessions (over-credit the on-chain session, or lose a win to a dropped
    // binding). So bind/unbind are REFUSED while the wallet has a live bet — the binding is frozen from the
    // moment a chip lands until the coup settles. Returns true on success.
    const bindToken = (wallet, sessionId) => {
      if (!realWallet(wallet) || !sessionId) return false;
      if (tokenBind.get(norm(wallet)) === String(sessionId)) return true; // already bound to this session (idempotent reconnect)
      if (hasLiveHand(wallet)) return false; // never swap the funding pool mid-round
      tokenBind.set(norm(wallet), String(sessionId));
      return true;
    };
    const unbindToken = (wallet) => { if (hasLiveHand(wallet)) return false; return tokenBind.delete(norm(wallet)); };
    // A player has a live bet (cash-out must be refused) iff any of their seats has chips committed
    // to an unsettled coup — used by the token bridge's settle/recover guard (OR'd with blackjack's).
    const hasLiveHand = (wallet) => {
      const w = norm(wallet);
      for (const r of rooms.values()) for (const s of r.seats) if (s && norm(s.wallet) === w && !s.settled && seatStake(s) > 0) return true;
      return false;
    };
    // STRICTER predicate: true only once the coup is actually DEALING/REVEALING (not merely a chip placed
    // in the betting window). Used by the TOKEN top-up guard so a player can add funds between rounds /
    // during betting, while a top-up mid-coup is still refused.
    const hasDealtHand = (wallet) => {
      const w = norm(wallet);
      for (const r of rooms.values()) for (const s of r.seats)
        if (s && norm(s.wallet) === w && !s.settled && seatStake(s) > 0 && r.phase !== "idle" && r.phase !== "betting") return true;
      return false;
    };
    const draw = (r) => {
      // Shoe exhausted mid-round → reshuffle a fresh shoe so draw() NEVER returns undefined.
      // Unreachable with an 8-deck shoe (a coup uses ≤6 cards) — belt-and-suspenders, BJ verbatim.
      if (!r.shoe || r.pos >= r.shoe.length) {
        const seeds = r.seats.map((s) => inRound(s) ? (s.clientSeed || "") : "");
        r.shoe = makeShoe(r.serverSeed, Shuffle.joinClientSeeds(seeds), String(r.shoeId) + ":x" + r.pos, config.decks); r.pos = 0;
      }
      return r.shoe[r.pos++];
    };

    /* ---------------- lobby ---------------- */
    function roomPublic(r) {
      return { id: r.id, name: r.name, seated: r.seats.filter(Boolean).length, openSeats: r.seats.filter((s) => !s).length,
        phase: r.phase, inProgress: r.phase !== "idle" && r.phase !== "betting", minBet: config.minBet,
        kind: r.kind || null, // "real" | "demo" — so the lobby can label/segregate (an empty room = either)
        tableBet: r.seats.reduce((a, s) => a + seatStake(s), 0), spectators: r.spectators.size, commit: r.commit };
    }
    function lobbyList() { return Array.from(rooms.values()).map(roomPublic); }
    let _lobbyJsonLast = "";
    function pushLobby() {
      const json = JSON.stringify({ type: "bac:lobby:list", rooms: lobbyList() });
      if (json === _lobbyJsonLast) return; // broadcastState fires per dealt card — skip byte-identical lists
      _lobbyJsonLast = json;
      for (const s of lobbySubs) { if (s && s.send) { try { s.send(json); } catch (e) {} } }
    }

    /* ---------------- room mgmt ---------------- */
    const NAMES = ["MONTE CARLO", "MACAU", "HAVANA", "RIVIERA", "BIARRITZ", "SINGAPORE", "NASSAU", "DEAUVILLE"];
    function createRoom() {
      if (rooms.size >= MAX_ROOMS) return null;
      seq++; const id = "BAC-" + String(seq).padStart(2, "0");
      const r = { id, name: id + " · " + NAMES[(seq - 1) % NAMES.length], seats: [null, null, null, null], spectators: new Set(),
        phase: "idle", shoe: [], pos: 0, playerCards: [], bankerCards: [], outcome: null, history: [],
        commit: "", serverSeed: "", shoeId: "", deadline: 0,
        lastActivity: now(), handNumber: 0, version: 0, full: false, timers: {},
        kind: null }; // "real" (token-funded) | "demo" (play-money) — established by the first player; real and
                      // demo players must NEVER share a shoe (clientSeed entropy + one lobby, two banks).
      rooms.set(id, r); scheduleIdle(r); pushLobby(); return r;
    }
    const seatedCount = (r) => r.seats.filter(Boolean).length;
    // REAL money on baccarat = the token bridge ONLY (the legacy on-chain bridge path is deliberately
    // omitted — spec §8; if the owner ever revives it, it stays BJ-only). Everyone else is DEMO.
    const isRealMoney = (wallet) => isTokenWallet(wallet);
    const playerKind = (wallet) => (isRealMoney(wallet) ? "real" : "demo");
    // An OPEN seat in a room of the right kind (an EMPTY room takes either kind; its kind is set on the first sit).
    function openRoom(kind) {
      for (const r of rooms.values()) {
        if (r.full || !r.seats.some((s) => !s)) continue;
        const established = seatedCount(r) > 0 ? (r.kind || null) : null; // empty room ⇒ kind-agnostic
        if (established === null || established === kind) return r;
      }
      return createRoom();
    }
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
      for (const s of r.seats) if (s) { if (s._dcTimer) { clrT(s._dcTimer); s._dcTimer = null; } const refund = seatStake(s); if (refund > 0 && !s.settled) { bank.credit(s.wallet, refund); s.bets = { player: 0, banker: 0, tie: 0 }; s.chipStack = []; pushWallet(s.sock, s.wallet); } }
      for (const k in r.timers) clrT(r.timers[k]);
      broadcast(r, { type: "bac:event", kind: "roomClosing", id: r.id, reason });
      if (r.serverSeed) broadcast(r, { type: "bac:reveal", roomId: r.id, serverSeed: r.serverSeed, commit: r.commit });
      rooms.delete(r.id); pushLobby();
      if (rooms.size === 0) createRoom(); // never leave the lobby empty — always keep one warm table
    }

    /* ---------------- broadcast / snapshot ---------------- */
    function broadcast(r, obj) { for (const s of r.seats) if (s) send(s.sock, obj); for (const sp of r.spectators) send(sp, obj); }
    function pushWallet(sock, wallet) { send(sock, { type: "bac:wallet", balance: bank.get(wallet) }); }
    function seatView(s) { if (!s) return null;
      return { wallet: s.wallet, bets: { player: s.bets.player || 0, banker: s.bets.banker || 0, tie: s.bets.tie || 0 },
        bet: seatStake(s), left: !!s.left, away: !!s.disconnected, settled: !!s.settled,
        result: s.result || null, lastBets: s.lastBets || null }; }
    function snapshot(r) {
      // No hidden cards in baccarat — pacing IS the reveal; both hands are always face-up.
      return { type: "bac:room:snapshot", roomId: r.id, phase: r.phase, deadline: r.deadline, serverNow: now(), version: ++r.version,
        seats: r.seats.map(seatView),
        player: { cards: r.playerCards, total: Rules.handTotal(r.playerCards) },
        banker: { cards: r.bankerCards, total: Rules.handTotal(r.bankerCards) },
        outcome: (r.phase === "settle" || r.phase === "between") ? r.outcome : null,
        history: r.history, commit: r.commit, handNumber: r.handNumber,
        betMin: config.minBet, zoneMax: ZONE_MAX };
    }
    function broadcastState(r) { broadcast(r, snapshot(r)); pushLobby(); }

    /* ---------------- round loop ---------------- */
    function startBetting(r) {
      // drop anyone who abandoned the prior coup (their zones already settled on merits)
      for (let i = 0; i < 4; i++) { const s = r.seats[i]; if (s && s.left) { r.seats[i] = null; r.full = false; broadcast(r, { type: "bac:event", kind: "seatOpen", seat: i }); } }
      if (!r.seats.some(Boolean)) { r.phase = "idle"; broadcastState(r); reapEmptyExtras(); return; }
      r.phase = "betting"; r.handNumber++;
      r.playerCards = []; r.bankerCards = []; r.outcome = null;
      r.shoeId = r.id + ":" + r.handNumber;
      const rnd = randomness.begin(r.shoeId);
      r.serverSeed = rnd.serverSeed; r.commit = rnd.commit; r.proof = rnd.proof || null; // commit published in snapshots BEFORE any bet
      for (const s of r.seats) if (s) { s.bets = { player: 0, banker: 0, tie: 0 }; s.chipStack = []; s.result = null; s.settled = false; s.left = false; s.clientSeed = ""; } // s.lastBets survives (REBET)
      r.deadline = now() + T.betting;
      // no touch() here — opening a window isn't player activity; abandoned tables still idle-close.
      armBetting(r, T.betting);
      broadcastState(r);
    }
    // Arm the betting timer with a generation token so a stale timer that was re-armed or
    // cancelled can never fire endBetting twice (BJ verbatim).
    function armBetting(r, ms) {
      clrT(r.timers.betting);
      const ep = (r.bettingEpoch = (r.bettingEpoch || 0) + 1);
      r.timers.betting = setT(() => { if (r.bettingEpoch === ep) endBetting(r); }, ms);
    }
    function endBetting(r) {
      clrT(r.timers.betting); r.bettingEpoch = (r.bettingEpoch || 0) + 1; // invalidate any queued betting timer
      const active = r.seats.filter(inRound);
      if (active.length === 0) {
        // nobody bet this window. Re-arm a few times for a returning player, but don't spin forever —
        // after MAX_EMPTY_WINDOWS consecutive empty windows drop to idle and let the normal idle-close
        // reap the table. The counter resets on any dealt coup or when we go idle.
        if (r.seats.some(Boolean) && (r.emptyWindows = (r.emptyWindows || 0) + 1) < MAX_EMPTY_WINDOWS) return startBetting(r);
        r.phase = "idle"; r.emptyWindows = 0; broadcastState(r); reapEmptyExtras(); return;
      }
      r.emptyWindows = 0; // a coup is dealing → reset the empty-window counter
      deal(r);
    }
    function deal(r) {
      r.phase = "dealing";
      const seatSeeds = r.seats.map((s) => inRound(s) ? (s.clientSeed || "") : "");
      r.shoe = makeShoe(r.serverSeed, Shuffle.joinClientSeeds(seatSeeds), r.shoeId, config.decks); r.pos = 0;
      r.playerCards = []; r.bankerCards = []; r.outcome = null;
      // DEAL ORDER CONVENTION (must match baccarat-rules.js runTableau + the PF verifier):
      //   P1 = shoe[0], B1 = shoe[1], P2 = shoe[2], B2 = shoe[3], then player 3rd, then banker 3rd.
      r._dealQ = ["player", "banker", "player", "banker"];
      if (T.dealPace > 0) { r.timers.deal = setT(() => dealStep(r), T.dealPace); } // suspenseful, card by card
      else { while (r._dealQ.length) dealOne(r); finishDeal(r); }                  // synchronous (tests / pacing off)
    }
    function dealOne(r) { const side = r._dealQ.shift(); (side === "player" ? r.playerCards : r.bankerCards).push(draw(r)); }
    function dealStep(r) {
      if (r.phase !== "dealing") return;
      dealOne(r); broadcastState(r);
      if (r._dealQ.length) r.timers.deal = setT(() => dealStep(r), T.dealPace);
      else finishDeal(r);
    }
    function finishDeal(r) {
      broadcast(r, { type: "bac:event", kind: "deal", roomId: r.id });
      beginReveal(r);
    }
    // REVEAL phase — the third-card tableau. baccarat-rules.js is the single source of truth for
    // every draw decision; the engine just draws in shoe order and paces the drama.
    function beginReveal(r) {
      r.phase = "reveal"; r._revealStage = 0;
      broadcastState(r);
      const paced = T.revealHold > 0 || T.revealPace > 0;
      if (paced) r.timers.reveal = setT(() => revealStep(r), T.revealHold); // suspense beat before the first tableau step (or the NATURAL flash)
      else revealStep(r);
    }
    // One tableau step: stage 0 = the player's third-card decision, stage 1 = the banker's, then
    // settle. Each drawn card broadcasts its own snapshot; when paced, every third card is preceded
    // by a T.revealHold suspense beat ("PLAYER DRAWS…") and followed by its T.revealPace flip before
    // the next step (the banker's third is the deciding-card beat).
    function revealStep(r) {
      if (r.phase !== "reveal") return;
      const paced = T.revealHold > 0 || T.revealPace > 0;
      const next = (ms) => { if (paced) r.timers.reveal = setT(() => revealStep(r), ms); else revealStep(r); };
      const P = r.playerCards, B = r.bankerCards;
      if (r._revealStage === 0) {
        // naturals freeze BOTH hands — no third cards (the pre-step hold was the NATURAL beat)
        if (Rules.isNatural(P) || Rules.isNatural(B)) return settle(r);
        r._revealStage = 1;
        if (Rules.playerDraws(Rules.handTotal(P))) {
          P.push(draw(r)); broadcastState(r);
          return next(T.revealPace + T.revealHold);  // flip lands, then the banker suspense hold
        }
        return next(T.revealHold);                    // "PLAYER STANDS ON n" caption beat
      }
      if (r._revealStage === 1) {
        r._revealStage = 2;
        const p3v = P.length > 2 ? Rules.cardValue(P[2].rank) : null; // the matrix uses the third card's VALUE (null when the player stood)
        if (Rules.bankerDraws(Rules.handTotal(B), p3v)) {
          B.push(draw(r)); broadcastState(r);
          return next(T.revealPace);                  // let the deciding-card flip land, then the result
        }
        return next(0);
      }
      settle(r);
    }
    function settle(r) {
      r.phase = "settle";
      const oc = Rules.outcome(r.playerCards, r.bankerCards); // { winner, playerTotal, bankerTotal }
      r.outcome = oc;
      r.history = r.history.concat(oc.winner === "player" ? "P" : oc.winner === "banker" ? "B" : "T").slice(-HISTORY_MAX);
      const perSeat = [];
      for (let i = 0; i < 4; i++) { const s = r.seats[i]; if (!inRound(s)) continue;
        let net = 0; const zones = {};
        for (const z of ZONES) { const bet = s.bets[z]; if (!(bet > 0)) continue;
          const mult = Rules.zoneReturnMult(z, oc.winner, config); // tie 9× / push 1× / player 2× / banker 1.95× / lose 0
          const payout = r2(bet * mult);
          if (payout > 0) {
            const credited = bank.credit(s.wallet, payout);
            // a token payout that failed to book (closed session mid-settle — unreachable by construction,
            // but never let it vanish silently) → tell the player so they can contact support (BJ #6).
            if (credited === false) { try { err(s.sock, "credit_failed", "Your payout couldn't be credited — please contact support (your locked funds are safe).", "settle"); } catch (e) {} }
          }
          zones[z] = { bet, payout, delta: r2(payout - bet) };
          net = r2(net + payout - bet);
        }
        s.lastBets = { player: s.bets.player || 0, banker: s.bets.banker || 0, tie: s.bets.tie || 0 }; // REBET map — survives reconnect (lives on the seat)
        s.result = { zones, net }; s.settled = true; pushWallet(s.sock, s.wallet);
        perSeat.push({ seat: i, wallet: s.wallet, zones, net });
      }
      broadcastState(r);
      broadcast(r, { type: "bac:settle", roomId: r.id, outcome: oc, perSeat });
      broadcast(r, { type: "bac:reveal", roomId: r.id, serverSeed: r.serverSeed, commit: r.commit, shoeId: r.shoeId,
        clientSeeds: r.seats.map((s) => inRound(s) ? (s.clientSeed || "") : ""), decks: config.decks,
        source: randomness.name || "commit-reveal", proof: r.proof || null });
      touch(r);
      // RESULT beat: hold the settled tableau for resultHold, flip to a short "between" sweep
      // (losing chips clear, road mark pops), then open the next betting window. between is the
      // TOTAL post-settle dwell, so the sweep lasts (between − resultHold).
      r.timers.between = setT(() => {
        if (r.phase !== "settle") return;
        r.phase = "between"; broadcastState(r);
        r.timers.between = setT(() => {
          if (r.phase !== "between") return;
          if (r.seats.some(Boolean)) startBetting(r); else { r.phase = "idle"; broadcastState(r); }
        }, Math.max(0, T.between - T.resultHold));
      }, Math.max(0, Math.min(T.resultHold, T.between)));
    }

    /* ---------------- intents ---------------- */
    function seatOf(r, sock) { for (let i = 0; i < 4; i++) if (r.seats[i] && r.seats[i].sock === sock) return i; return -1; }
    function err(sock, code, msg, intent) { send(sock, { type: "bac:error", code, msg, intent }); }

    function join(sock, wallet, roomId, seatPref) {
      // Reconnect grace: if this wallet has a seat that's only temporarily disconnected
      // (the player backgrounded the app / lost signal), reclaim that EXACT seat + bets
      // instead of taking a new one. Keeps you at the table across an app switch.
      for (const room of rooms.values()) {
        for (let i = 0; i < 4; i++) {
          const s = room.seats[i];
          if (s && s.disconnected && s.wallet === wallet) {
            if (s._dcTimer) { clrT(s._dcTimer); s._dcTimer = null; }
            s.sock = sock; s.disconnected = 0; s.left = false;
            room.spectators.delete(sock);
            send(sock, Object.assign(snapshot(room), { you: { roomId: room.id, seat: i, balance: bank.get(wallet) } }));
            pushWallet(sock, wallet);
            broadcast(room, { type: "bac:event", kind: "seatReconnected", seat: i, wallet });
            broadcastState(room); pushLobby();
            return room;
          }
        }
      }
      // RESUME/RESYNC: the SAME socket re-joining its OWN seat (mobile app-switch on a half-open
      // socket). Not a second seat — re-send the CURRENT snapshot so the felt recovers the live
      // phase. Read-only, never disturbs a live coup. The per-WALLET guard below still rejects a
      // DIFFERENT socket with the same wallet (a real second tab/device).
      for (const rr of rooms.values()) { const si = seatOf(rr, sock); if (si >= 0) {
        send(sock, Object.assign(snapshot(rr), { you: { roomId: rr.id, seat: si, balance: bank.get(wallet) } }));
        pushWallet(sock, wallet);
        return rr;
      } }
      // One seat per WALLET across all tables (two tabs / stale socket can't double-seat).
      for (const rr of rooms.values()) for (const st of rr.seats) if (st && st.wallet === wallet) return err(sock, "already_seated", "You're already at a table", "join");
      // KIND SEGREGATION: real-money (token) players and demo (play-money) players never share a table.
      const kind = playerKind(wallet);
      let r = roomId ? rooms.get(roomId) : null;
      // A specific table (e.g. a shared link) of a DIFFERENT kind can't be joined — fall through to a
      // correct-kind table instead of seating a real player at a demo shoe (or vice-versa).
      if (r && seatedCount(r) > 0 && r.kind && r.kind !== kind) {
        send(sock, { type: "bac:event", kind: "kindMismatch", wanted: kind, tableKind: r.kind });
        r = null;
      }
      if (!r) r = openRoom(kind); if (!r) return err(sock, "lobby_full", "No tables available");
      if (r.seats.some((s) => s && s.wallet === wallet)) return err(sock, "already_seated", "One seat per table", "join");
      let idx = -1;
      if (seatPref != null && !r.seats[seatPref]) idx = seatPref; else idx = r.seats.findIndex((s) => !s);
      if (idx < 0) return err(sock, "table_full", "Table is full", "join");
      r.kind = kind; // first player establishes (or re-affirms) the table kind; an empty room takes either
      r.seats[idx] = { sock, wallet, clientSeed: "", settled: false, left: false, disconnected: 0,
        bets: { player: 0, banker: 0, tie: 0 }, chipStack: [], _chipSeq: 0, lastBets: null, result: null };
      r.spectators.delete(sock);
      if (r.seats.filter(Boolean).length === 4) { r.full = true; createRoom(); }
      touch(r);
      send(sock, Object.assign(snapshot(r), { you: { roomId: r.id, seat: idx, balance: bank.get(wallet) } }));
      pushWallet(sock, wallet);
      broadcast(r, { type: "bac:event", kind: "seatTaken", seat: idx, wallet });
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
          const refund = seatStake(s);
          if (refund > 0) { bank.credit(s.wallet, refund); pushWallet(s.sock, s.wallet); } // refund the un-dealt chips
          r.seats[i] = null; r.full = false;
          broadcast(r, { type: "bac:event", kind: "seatOpen", seat: i });
          broadcastState(r); reapEmptyExtras();
        } else {
          // abandoning a LIVE coup: the chips ride and settle on their merits (a winning zone still
          // pays), then the seat is dropped at the next startBetting. No turn machinery to unwind —
          // baccarat has zero decisions after betting.
          s.left = true;
          broadcast(r, { type: "bac:event", kind: "seatLeaving", seat: i, wallet: s.wallet });
          broadcastState(r);
        }
        pushLobby();
      }
    }
    // A socket dropped (often a mobile app-switch). DON'T free the seat right away — reserve it for
    // a grace window so the player reclaims it on reconnect. A disconnected bettor's zones simply
    // ride and settle on merits (there is no turn to auto-stand); if the grace expires, the seat is
    // dropped for real.
    const RECONNECT_GRACE = 90000;
    function markDisconnected(sock) {
      lobbySubs.delete(sock);
      for (const r of rooms.values()) {
        r.spectators.delete(sock);
        const i = seatOf(r, sock); if (i < 0) continue;
        const s = r.seats[i];
        s.disconnected = now();
        if (s._dcTimer) clrT(s._dcTimer);
        s._dcTimer = setT(() => dropSeat(r, i, s), RECONNECT_GRACE);
        broadcast(r, { type: "bac:event", kind: "seatAway", seat: i, wallet: s.wallet });
        broadcastState(r); pushLobby();
      }
    }
    function dropSeat(r, i, s) {
      if (r.seats[i] !== s) return; // already reclaimed or replaced
      s._dcTimer = null;
      if (r.phase === "betting" || r.phase === "idle") {
        const refund = seatStake(s);
        if (refund > 0) bank.credit(s.wallet, refund); // refund the un-dealt chips
        r.seats[i] = null; r.full = false;
        // Hardening: the seat is gone and no coup is live → drop any lingering token binding so a later
        // out-of-band token settle can't leave a stale wallet→session entry (inert today; defense-in-depth).
        try { if (s.wallet && !hasLiveHand(s.wallet)) unbindToken(s.wallet); } catch (e) {}
        broadcast(r, { type: "bac:event", kind: "seatOpen", seat: i });
        broadcastState(r); reapEmptyExtras();
      } else {
        s.left = true;
        broadcast(r, { type: "bac:event", kind: "seatLeaving", seat: i, wallet: s.wallet });
        broadcastState(r);
      }
      pushLobby();
    }
    // Everyone seated has chips in — hold a short "no more bets" grace so a misclick can still be
    // undone, then deal automatically (BJ pattern). With additive chip betting this must only ever
    // SHORTEN the window: an extra chip tap can never push the deadline back out (no
    // infinite-extension grief).
    function fastForwardIfAllBet(r) {
      const seated = r.seats.filter(Boolean);
      if (!seated.length || !seated.every((x) => seatStake(x) > 0)) return;
      const target = now() + 3000;
      if (target < r.deadline) { r.deadline = target; armBetting(r, 3000); }
    }
    // ADDITIVE chip-tap bet (spec §5.2): validate zone → refuse both-sides → clamp to the zone cap
    // (graceful partial fill) → enforce the min → debit-before-escrow → push onto the LIFO chip stack.
    function addBet(sock, zone, amountUsd, clientSeed) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        // A SEATED player's chip WAKES an idle table (3 empty windows parked it) — without this,
        // the dead-table trap: controls say "waiting" forever until some OTHER player joins.
        if (r.phase === "idle") startBetting(r);
        if (r.phase !== "betting") return err(sock, "bets_closed", "Betting is closed", "bet");
        const s = r.seats[i];
        if (ZONES.indexOf(zone) < 0) return err(sock, "server", "Unknown bet zone", "bet");
        // one seat can never back BOTH Player and Banker (pure commission burn, R11); Tie combines freely
        if ((zone === "player" && s.bets.banker > 0) || (zone === "banker" && s.bets.player > 0))
          return err(sock, "both_sides", "Pick a side — Player and Banker can't both be backed", "bet");
        let amt = r2(+amountUsd);
        if (!isFinite(amt) || amt <= 0) return err(sock, "server", "Bad bet amount", "bet");
        const headroom = r2(ZONE_MAX[zone] - s.bets[zone]);
        if (headroom <= 0) return err(sock, "zone_max", zoneLabel(zone) + " max is $" + ZONE_MAX[zone], "bet");
        if (amt > headroom) amt = headroom; // partial-chip fill to the legal max (spec §5.2)
        // min bet: the smallest chip is $10, but the server still validates — the zone's TOTAL stake
        // must reach minBet (a partial fill on an already-funded zone may be smaller than $10).
        if (r2(s.bets[zone] + amt) < config.minBet) return err(sock, "min_bet", "Minimum bet is $" + config.minBet, "bet");
        if (!bank.debit(s.wallet, amt)) return err(sock, "insufficient", "Not enough balance", "bet"); // debit-before-escrow
        s.bets[zone] = r2(s.bets[zone] + amt);
        s.chipStack.push({ zone, amt, g: ++s._chipSeq });                        // one undo unit per tap
        if (!s.clientSeed) s.clientSeed = String(clientSeed || Shuffle.randomSeed(8)); // captured at (first) bet time
        touch(r);
        fastForwardIfAllBet(r);
        pushWallet(sock, s.wallet); broadcastState(r);
        return;
      }
      err(sock, "no_seat", "Take a seat first", "bet");
    }
    // UNDO pops the last chip LIFO across zones; a rebet was ONE action, so its chips share a group
    // id and pop as one unit. Empty stack = silent no-op ack (fresh snapshot, no error).
    function undoBet(sock) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        if (r.phase !== "betting") return err(sock, "bets_closed", "Too late to change the bet", "bet");
        const s = r.seats[i], st = s.chipStack || [];
        if (!st.length) { send(sock, snapshot(r)); return; }
        const gid = st[st.length - 1].g;
        let n = 0, total = 0;
        for (let k = st.length - 1; k >= 0 && st[k].g === gid; k--) { n++; total = r2(total + st[k].amt); }
        const ok = bank.credit(s.wallet, total); // refund FIRST — a failed token refund must not zero the escrow (BJ #9)
        if (ok === false) return err(sock, "credit_failed", "Couldn't refund that chip right now — try again in a moment.", "bet");
        for (let k = 0; k < n; k++) { const e = st.pop(); s.bets[e.zone] = r2(Math.max(0, s.bets[e.zone] - e.amt)); }
        // if the undo leaves NO chips on the whole table, give the full window back (anti-grief mirror
        // of BJ cancelBet: while others still have chips in, the running deadline stands)
        if (!r.seats.some((x) => x && seatStake(x) > 0)) { r.deadline = now() + T.betting; armBetting(r, T.betting); }
        touch(r); pushWallet(sock, s.wallet); broadcastState(r);
        return;
      }
      err(sock, "no_seat", "Take a seat first", "bet");
    }
    // CLEAR refunds every zone at once. Rate-limited per seat (BJ cancelBet pattern) so a player
    // can't spam clear/re-add to churn the table.
    function clearBets(sock) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        if (r.phase !== "betting") return err(sock, "bets_closed", "Too late to clear the bet", "bet");
        const s = r.seats[i];
        if (s._lastClear && now() - s._lastClear < 2000) return;
        const total = seatStake(s);
        if (!(total > 0)) { send(sock, snapshot(r)); return; } // nothing to clear — silent ack
        const ok = bank.credit(s.wallet, total); // refund first, abort on failure (BJ #9)
        if (ok === false) return err(sock, "credit_failed", "Couldn't refund your bets right now — try again in a moment.", "bet");
        s.bets = { player: 0, banker: 0, tie: 0 }; s.chipStack = [];
        s._lastClear = now();
        if (!r.seats.some((x) => x && seatStake(x) > 0)) { r.deadline = now() + T.betting; armBetting(r, T.betting); }
        touch(r); pushWallet(sock, s.wallet); broadcastState(r);
        return;
      }
      err(sock, "no_seat", "Take a seat first", "bet");
    }
    // REBET replays the seat's last completed bet map (×1 or ×2) as ONE atomic action: every zone is
    // validated against its cap first (a partially-illegal rebet is wholly rejected), one debit, and
    // the whole placement shares one undo group.
    function rebet(sock, mult) {
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i < 0) continue;
        if (r.phase === "idle") startBetting(r); // REBET is the fastest "go again" — it too wakes a parked table
        if (r.phase !== "betting") return err(sock, "bets_closed", "Betting is closed", "bet");
        const s = r.seats[i];
        const m = (+mult === 2) ? 2 : 1;
        if (seatStake(s) > 0) return err(sock, "server", "Clear your bets before rebetting", "bet"); // rebet is an empty-felt shortcut only
        const last = s.lastBets;
        const lastTotal = last ? r2((last.player || 0) + (last.banker || 0) + (last.tie || 0)) : 0;
        if (!(lastTotal > 0)) return err(sock, "server", "No previous bet to repeat", "bet");
        const want = {};
        for (const z of ZONES) { const a = r2((last[z] || 0) * m); if (a > 0) { if (a > ZONE_MAX[z]) return err(sock, "zone_max", zoneLabel(z) + " max is $" + ZONE_MAX[z], "bet"); want[z] = a; } }
        const total = r2(lastTotal * m);
        if (!bank.debit(s.wallet, total)) return err(sock, "insufficient", "Not enough balance for $" + total, "bet"); // one atomic debit
        const gid = ++s._chipSeq; // the whole rebet is ONE undo unit
        for (const z of ZONES) if (want[z]) { s.bets[z] = r2(s.bets[z] + want[z]); s.chipStack.push({ zone: z, amt: want[z], g: gid }); }
        if (!s.clientSeed) s.clientSeed = Shuffle.randomSeed(8);
        touch(r); fastForwardIfAllBet(r);
        pushWallet(sock, s.wallet); broadcastState(r);
        return;
      }
      err(sock, "no_seat", "Take a seat first", "bet");
    }
    // Guest play-money reload BETWEEN coups only — baccarat has no mid-coup affordance (no
    // double/split), so a top-up while the coup is dealing/revealing/settling is refused.
    function topUp(sock, amount) {
      const w = sock.wallet || "";
      if (!/^guest:/.test(w)) return; // guests only (play money)
      for (const r of rooms.values()) { const i = seatOf(r, sock); if (i >= 0 && r.phase !== "betting" && r.phase !== "idle") return; }
      const nowMs = now();
      if (sock._lastGuestTopUp && nowMs - sock._lastGuestTopUp < GUEST_TOPUP_COOLDOWN) return;
      let amt = r2(Math.max(0, Math.min(GUEST_TOPUP_MAX, +amount || 0)));
      if (amt <= 0) return;
      let cur = 0; try { cur = bank.get(w) || 0; } catch (e) {}
      amt = r2(Math.min(amt, Math.max(0, GUEST_BAL_CAP - cur))); // never let top-ups push past the standing cap
      if (amt <= 0) return;
      sock._lastGuestTopUp = nowMs;
      bank.credit(w, amt); pushWallet(sock, w);
      for (const r of rooms.values()) { if (seatOf(r, sock) >= 0) { broadcastState(r); break; } }
    }
    // DEMO ONLY: keep a guest's table balance in sync with the site's play-money demo balance (the
    // single balance the player sees). Never applies to real (0x) wallets — their funds live on the
    // token ledger — and never mid-coup (only when idle or pre-bet). Exact-set is intentional and
    // demo-scoped (BJ v12.88 decision — do NOT "harden" back to raise-only).
    function seedGuest(sock, amount) {
      const w = sock.wallet || "";
      if (!/^guest:/.test(w) || typeof amount !== "number" || !isFinite(amount) || amount < 0) return;
      for (const r of rooms.values()) {
        const i = seatOf(r, sock);
        // Never mid-coup: block if any chip is escrowed OR the coup is live. ALLOW "idle" + "betting"
        // (pre-bet) — a fresh table sits "idle", and the entry-seed must land then, not be dropped.
        if (i >= 0) { const s = r.seats[i]; if (s && (seatStake(s) > 0 || (r.phase !== "betting" && r.phase !== "idle"))) return; }
      }
      const nowMsS = now();
      if (sock._lastGuestSeed && nowMsS - sock._lastGuestSeed < GUEST_TOPUP_COOLDOWN) return;
      const target = r2(Math.min(GUEST_BAL_CAP, amount));
      if (target === bank.get(w)) return; // already in sync — don't churn the persist
      sock._lastGuestSeed = nowMsS;
      bank.all.set(w, target);
      pushWallet(sock, w);
      for (const r of rooms.values()) { if (seatOf(r, sock) >= 0) { broadcastState(r); break; } }
    }

    /* ---------------- router ---------------- */
    function messageWallet(sock, m) {
      if (sock.wallet) return sock.wallet;
      const hinted = String((m && m.wallet) || "");
      return /^guest:/.test(hinted) ? hinted : "";
    }
    function authStillValid(sock) {
      const w = sock && sock.wallet;
      if (!realWallet(w)) return true;
      // TOKEN-ONLY real money on baccarat (no legacy bridge path — spec §8). The binding is frozen
      // for the life of a coup (bindToken/unbindToken refuse while hasLiveHand), so it can't be
      // swapped between a bet's debit and the coup's credit.
      // NOTE: unlike the BJ engine this NEVER mutates sock.wallet — the socket identity is shared
      // with the blackjack engine (one hello), and a baccarat denial must not strip an identity
      // that blackjack (e.g. its legacy-bridge path) still honors.
      return isTokenWallet(w);
    }
    function authBypassType(type) {
      return type === "bac:lobby:subscribe" || type === "bac:lobby:unsubscribe" || type === "bac:room:watch" || type === "bac:room:leave";
    }
    function handle(sock, m) {
      if ((!authStillValid(sock) || sock.bjAuthDenied) && !authBypassType(m.type)) {
        return err(sock, "auth_required", "Lock casino credits before joining with this wallet", "join");
      }
      const wallet = messageWallet(sock, m);
      switch (m.type) {
        // Identity is the CONNECTION's trusted wallet (stamped by the transport at hello), never
        // the client-supplied m.wallet — so the engine is self-enforcing if reused.
        case "bac:lobby:subscribe": { lobbySubs.add(sock); if (rooms.size === 0) createRoom(); send(sock, { type: "bac:lobby:list", rooms: lobbyList() }); if (wallet) pushWallet(sock, wallet); break; }
        case "bac:lobby:unsubscribe": lobbySubs.delete(sock); break;
        case "bac:room:join": join(sock, wallet || "anon", m.roomId, m.seatPref); break;
        case "bac:room:watch": watch(sock, m.roomId); break;
        case "bac:room:leave": leave(sock); break;
        case "bac:bet:add": addBet(sock, m.zone, m.amountUsd, m.clientSeed); break;
        case "bac:bet:undo": undoBet(sock); break;
        case "bac:bet:clear": clearBets(sock); break;
        case "bac:bet:rebet": rebet(sock, m.mult); break;
        case "bac:seed": seedGuest(sock, +m.balance); break;
        case "bac:topup": topUp(sock, +m.amount); break;
        default: break;
      }
    }
    function onClose(sock) { markDisconnected(sock); } // keep the seat reserved through a grace so a reconnect reclaims it

    createRoom();
    return { handle, onClose, bank, config,
      // Token-funded tables (the real-money path): bind a wallet to its token session, route its chips
      // to the token ledger, and report a live coup so the token bridge can refuse a mid-round cash-out.
      setTokenLedger: (tl) => { TL = tl || null; },
      bindToken, unbindToken, hasLiveHand, hasDealtHand, isTokenWallet,
      _mgr: { rooms, openRoom, createRoom, closeRoom, lobbyList },
      _room: { startBetting, endBetting, deal, dealStep, finishDeal, beginReveal, revealStep, settle, snapshot } };
  }

  const API = { attachBaccarat, makeBank };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.BaccaratServer = API;

  /* ============================================================
     CLI SELF-TEST — node server/baccarat-server.js
     Drives the REAL handle() path (BJ self-test pattern) with stub sockets,
     a controllable clock, no-op timers and scripted shoes: chip escrow
     add/undo/clear/rebet, both_sides + min-bet + zoneMax partial fill,
     exact settle nets for player/banker/tie/push against fixed shoes, PF
     end-to-end determinism, paced choreography (deal order + tableau),
     leave/disconnect flows, kind segregation, seedGuest mirror, and the
     token-ledger contract (frozen binding, same-session credit, rows
     stamped game:"baccarat").
     ============================================================ */
  if (typeof require !== "undefined" && require.main === module) {
    let ok = true;
    const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };
    const card = (str) => ({ rank: str.slice(0, -1), suit: str.slice(-1) });
    const mkShoe = (s) => s.trim().split(/\s+/).map(card);
    const mkWs = (w) => { const msgs = []; const ws = { wallet: w, bjToken: "bearer", send: (m) => { try { msgs.push(JSON.parse(m)); } catch (e) {} } }; ws._msgs = msgs; return ws; };
    const gotErr = (ws, code, from) => ws._msgs.slice(from == null ? 0 : from).some((m) => m.type === "bac:error" && m.code === code);
    const cardsEq = (a, b) => a.length === b.length && a.every((c, i) => c && b[i] && c.rank === b[i].rank && c.suit === b[i].suit);
    const stakeOf = (s) => !s ? 0 : Math.round(((s.bets.player || 0) + (s.bets.banker || 0) + (s.bets.tie || 0)) * 100) / 100;

    let clock = 1000000;
    let scriptShoe = null; // when set, makeShoe returns this fixed shoe (crafted tableau vectors)
    const scriptedMakeShoe = (ss, cc, id, decks) => (scriptShoe ? scriptShoe.slice() : Shuffle.shuffle(ss, cc, id, decks));
    const noT = { setTimeout: () => 0, clearTimeout: () => {}, now: () => clock };
    const roomOf = (eng, w) => { for (const r of eng._mgr.rooms.values()) if (r.seats.some((s) => s && s.wallet === w)) return r; return null; };
    const seatOfW = (r, w) => r.seats.find((s) => s && s.wallet === w);

    /* ───── ENGINE A: sync pacing, scripted shoes — escrow + settle + lifecycle ───── */
    const bac = attachBaccarat(Object.assign({ maxWinUsd: 2000, timers: { dealPace: 0, revealHold: 0, revealPace: 0, resultHold: 0, between: 0 }, makeShoe: scriptedMakeShoe }, noT));
    const A = mkWs("guest:alice"), B = mkWs("guest:bob");
    bac.handle(A, { type: "bac:lobby:subscribe" });
    bac.handle(A, { type: "bac:room:join" });
    bac.handle(B, { type: "bac:room:join" });
    const r1 = roomOf(bac, "guest:alice");
    eq("join opens a betting window", !!r1 && r1.phase === "betting" && roomOf(bac, "guest:bob") === r1);
    eq("commit published BEFORE any bet (64-hex in the snapshot)", typeof r1.commit === "string" && r1.commit.length === 64);

    // ── additive chip adds + LIFO undo + clear (escrow conservation) ──
    const sa = () => seatOfW(r1, "guest:alice"), sb = () => seatOfW(r1, "guest:bob");
    bac.handle(A, { type: "bac:bet:add", zone: "player", amountUsd: 100, clientSeed: "seedA" });
    eq("chip add debits escrow immediately (5000 → 4900)", bac.bank.get("guest:alice") === 4900);
    bac.handle(A, { type: "bac:bet:add", zone: "tie", amountUsd: 10 });
    bac.handle(A, { type: "bac:bet:add", zone: "player", amountUsd: 25 });
    eq("adds are ADDITIVE and stack across zones (player 125, tie 10)", sa().bets.player === 125 && sa().bets.tie === 10 && bac.bank.get("guest:alice") === 4865);
    bac.handle(A, { type: "bac:bet:undo" });
    eq("UNDO pops the last chip LIFO (player back to 100, +$25 refund)", sa().bets.player === 100 && bac.bank.get("guest:alice") === 4890);
    bac.handle(A, { type: "bac:bet:undo" });
    eq("UNDO walks back across zones (tie removed)", sa().bets.tie === 0 && bac.bank.get("guest:alice") === 4900);
    bac.handle(A, { type: "bac:bet:undo" });
    eq("escrow conserved after full walk-back (→ 5000)", sa().bets.player === 0 && bac.bank.get("guest:alice") === 5000);
    const errCount0 = A._msgs.filter((m) => m.type === "bac:error").length;
    bac.handle(A, { type: "bac:bet:undo" });
    eq("empty-stack undo is a SILENT no-op (ack, no error)", A._msgs.filter((m) => m.type === "bac:error").length === errCount0 && bac.bank.get("guest:alice") === 5000);

    // ── both_sides refusal (either order); tie combines freely ──
    bac.handle(A, { type: "bac:bet:add", zone: "player", amountUsd: 25 });
    let mark = A._msgs.length;
    bac.handle(A, { type: "bac:bet:add", zone: "banker", amountUsd: 25 });
    eq("player→banker on one seat REFUSED (both_sides, no debit)", gotErr(A, "both_sides", mark) && sa().bets.banker === 0 && bac.bank.get("guest:alice") === 4975);
    bac.handle(A, { type: "bac:bet:add", zone: "tie", amountUsd: 10 });
    eq("tie combines freely with a side", sa().bets.tie === 10 && bac.bank.get("guest:alice") === 4965);
    bac.handle(B, { type: "bac:bet:add", zone: "banker", amountUsd: 20 });
    mark = B._msgs.length;
    bac.handle(B, { type: "bac:bet:add", zone: "player", amountUsd: 10 });
    eq("banker→player on one seat REFUSED too", gotErr(B, "both_sides", mark) && sb().bets.player === 0 && bac.bank.get("guest:bob") === 4980);
    bac.handle(B, { type: "bac:bet:undo" });

    // ── min bet + zoneMax partial fill ──
    mark = B._msgs.length;
    bac.handle(B, { type: "bac:bet:add", zone: "banker", amountUsd: 5 });
    eq("min-bet enforced ($10 floor, no debit)", gotErr(B, "min_bet", mark) && sb().bets.banker === 0 && bac.bank.get("guest:bob") === 5000);
    bac.handle(B, { type: "bac:bet:add", zone: "tie", amountUsd: 240 });
    bac.handle(B, { type: "bac:bet:add", zone: "tie", amountUsd: 25 });
    eq("zoneMax PARTIAL-CHIP fill (tie 240 + $25 chip → clamped to the $250 cap)", sb().bets.tie === 250 && bac.bank.get("guest:bob") === 4750);
    mark = B._msgs.length;
    bac.handle(B, { type: "bac:bet:add", zone: "tie", amountUsd: 10 });
    eq("tie at the $250 cap refuses further chips (zone_max)", gotErr(B, "zone_max", mark) && sb().bets.tie === 250);
    bac.handle(B, { type: "bac:bet:clear" });
    eq("CLEAR refunds every zone (bob → 5000)", stakeOf(sb()) === 0 && bac.bank.get("guest:bob") === 5000);
    bac.handle(B, { type: "bac:bet:add", zone: "banker", amountUsd: 50 });
    bac.handle(B, { type: "bac:bet:clear" }); // within 2s of the last clear → rate-limited, ignored
    eq("clear is RATE-LIMITED (2s) — chips stay", sb().bets.banker === 50 && bac.bank.get("guest:bob") === 4950);
    clock += 2500;
    bac.handle(B, { type: "bac:bet:clear" });
    eq("clear works again after the cooldown", stakeOf(sb()) === 0 && bac.bank.get("guest:bob") === 5000);
    clock += 2500;
    bac.handle(A, { type: "bac:bet:clear" });
    eq("alice cleared to a clean slate", stakeOf(sa()) === 0 && bac.bank.get("guest:alice") === 5000);

    // ── all-bet fast-forward: only ever SHORTENS the window ──
    clock += 3000;
    bac.handle(A, { type: "bac:bet:add", zone: "player", amountUsd: 100 });
    bac.handle(B, { type: "bac:bet:add", zone: "banker", amountUsd: 50 });
    eq("all-bet fast-forward shortens the deadline to ≤3s", r1.deadline - clock <= 3000 && r1.deadline > clock);
    const dl = r1.deadline; clock += 1000;
    bac.handle(A, { type: "bac:bet:add", zone: "tie", amountUsd: 10 });
    eq("an extra chip tap never EXTENDS the no-more-bets grace", r1.deadline === dl);

    // ── ROUND 1: player natural 9 vs banker 5 (T1) — exact nets ──
    // alice: player 100 (+100) + tie 10 (−10) → net +90; bob: banker 50 → net −50
    scriptShoe = mkShoe("4H 2S 5D 3C");
    bac._room.endBetting(r1);
    eq("sync round runs deal→reveal→settle (phase settle)", r1.phase === "settle");
    eq("outcome: player natural 9 over 5, no third cards", r1.outcome && r1.outcome.winner === "player" && r1.outcome.playerTotal === 9 && r1.outcome.bankerTotal === 5 && r1.playerCards.length === 2 && r1.bankerCards.length === 2);
    let stl = A._msgs.filter((m) => m.type === "bac:settle").pop();
    const seatNet = (st, w) => { const e = (st.perSeat || []).find((x) => x.wallet === w); return e ? e.net : null; };
    eq("bac:settle perSeat nets exact (alice +90, bob −50)", !!stl && seatNet(stl, "guest:alice") === 90 && seatNet(stl, "guest:bob") === -50);
    eq("bank deltas equal the nets exactly (5090 / 4950)", bac.bank.get("guest:alice") === 5090 && bac.bank.get("guest:bob") === 4950);
    const az = (stl.perSeat || []).find((x) => x.wallet === "guest:alice").zones;
    eq("zone detail: player {100→200,+100}, tie {10→0,−10}", az.player.payout === 200 && az.player.delta === 100 && az.tie.payout === 0 && az.tie.delta === -10);
    eq("history appended 'P'", r1.history.length === 1 && r1.history[0] === "P");
    eq("hasLiveHand false once settled", bac.hasLiveHand("guest:alice") === false);

    // ── ROUND 2: banker natural 9 vs 8 (T2) — 0.95 commission exact cents ──
    bac._room.startBetting(r1);
    eq("next window re-opens betting with zones reset", r1.phase === "betting" && stakeOf(sa()) === 0);
    bac.handle(A, { type: "bac:bet:add", zone: "banker", amountUsd: 100 });
    bac.handle(B, { type: "bac:bet:add", zone: "banker", amountUsd: 15 });
    scriptShoe = mkShoe("3D 4S 5C 5H");
    bac._room.endBetting(r1);
    stl = A._msgs.filter((m) => m.type === "bac:settle").pop();
    eq("banker $100 win pays 195 (net +95); $15 pays 29.25 (net +14.25)", seatNet(stl, "guest:alice") === 95 && seatNet(stl, "guest:bob") === 14.25);
    eq("bank deltas exact (5185 / 4964.25)", bac.bank.get("guest:alice") === 5185 && bac.bank.get("guest:bob") === 4964.25);
    eq("history P,B", r1.history.join("") === "PB");

    // ── ROUND 3: tie 8/8 (T3) — tie pays 9×, P/B PUSH ──
    bac._room.startBetting(r1);
    bac.handle(A, { type: "bac:bet:add", zone: "banker", amountUsd: 50 });
    bac.handle(A, { type: "bac:bet:add", zone: "tie", amountUsd: 10 });
    bac.handle(B, { type: "bac:bet:add", zone: "player", amountUsd: 100 });
    scriptShoe = mkShoe("KD TS 8C 8H");
    bac._room.endBetting(r1);
    stl = A._msgs.filter((m) => m.type === "bac:settle").pop();
    eq("tie coup: tie $10 → payout 90 (net +80 with banker pushing)", seatNet(stl, "guest:alice") === 80);
    const azt = (stl.perSeat || []).find((x) => x.wallet === "guest:alice").zones;
    eq("banker zone PUSHES on tie {50→50, 0}", azt.banker.payout === 50 && azt.banker.delta === 0);
    eq("player zone PUSHES on tie (bob net 0)", seatNet(stl, "guest:bob") === 0);
    eq("bank deltas exact (5265 / 4964.25)", bac.bank.get("guest:alice") === 5265 && bac.bank.get("guest:bob") === 4964.25);
    eq("history P,B,T", r1.history.join("") === "PBT");

    // ── REBET: atomic multi-zone replay, ×1 / ×2, one undo unit ──
    bac._room.startBetting(r1);
    eq("lastBets survives into the next window (banker 50 + tie 10)", sa().lastBets && sa().lastBets.banker === 50 && sa().lastBets.tie === 10);
    bac.handle(A, { type: "bac:bet:rebet", mult: 1 });
    eq("REBET ×1 replays the map atomically (banker 50, tie 10; −$60)", sa().bets.banker === 50 && sa().bets.tie === 10 && bac.bank.get("guest:alice") === 5205);
    bac.handle(A, { type: "bac:bet:undo" });
    eq("UNDO of a rebet pops the WHOLE rebet as one unit (+$60)", stakeOf(sa()) === 0 && bac.bank.get("guest:alice") === 5265);
    bac.handle(A, { type: "bac:bet:rebet", mult: 2 });
    eq("REBET ×2 doubles every zone (banker 100, tie 20; −$120)", sa().bets.banker === 100 && sa().bets.tie === 20 && bac.bank.get("guest:alice") === 5145);
    mark = A._msgs.length;
    bac.handle(A, { type: "bac:bet:rebet", mult: 1 });
    eq("rebet refused while chips are down (empty-felt shortcut only)", gotErr(A, "server", mark) && bac.bank.get("guest:alice") === 5145);
    clock += 2500;
    bac.handle(A, { type: "bac:bet:clear" });
    eq("cleared back (→ 5265)", bac.bank.get("guest:alice") === 5265);
    const savedLast = sa().lastBets; sa().lastBets = { player: 0, banker: 0, tie: 200 };
    mark = A._msgs.length;
    bac.handle(A, { type: "bac:bet:rebet", mult: 2 });
    eq("rebet ×2 breaching a zone cap is WHOLLY rejected (tie 400 > 250, no debit)", gotErr(A, "zone_max", mark) && stakeOf(sa()) === 0 && bac.bank.get("guest:alice") === 5265);
    sa().lastBets = savedLast;

    // ── snapshot shape ──
    const snap = A._msgs.filter((m) => m.type === "bac:room:snapshot").pop();
    eq("snapshot shape: player/banker totals, history, betMin, zoneMax {2000,2000,250}",
      !!snap && snap.player && snap.banker && typeof snap.player.total === "number" && Array.isArray(snap.history) &&
      snap.betMin === 10 && snap.zoneMax && snap.zoneMax.player === 2000 && snap.zoneMax.banker === 2000 && snap.zoneMax.tie === 250);

    // ── leave during betting refunds ──
    const L = mkWs("guest:leaver");
    bac.handle(L, { type: "bac:room:join" });
    bac.handle(L, { type: "bac:bet:add", zone: "banker", amountUsd: 100 });
    eq("leaver escrowed (4900)", bac.bank.get("guest:leaver") === 4900);
    bac.handle(L, { type: "bac:room:leave" });
    eq("leave during betting REFUNDS the escrow and frees the seat", bac.bank.get("guest:leaver") === 5000 && !seatOfW(r1, "guest:leaver"));

    // ── disconnect-grace reclaim (seat + bets returned) ──
    bac.handle(B, { type: "bac:bet:add", zone: "banker", amountUsd: 25 });
    const bIdx = r1.seats.findIndex((s) => s && s.wallet === "guest:bob");
    bac.onClose(B);
    eq("disconnect marks the seat away (grace, chips stay escrowed)", !!r1.seats[bIdx].disconnected && r1.seats[bIdx].bets.banker === 25);
    const B2 = mkWs("guest:bob");
    bac.handle(B2, { type: "bac:room:join" });
    eq("reconnect within grace reclaims the SAME seat + bets", r1.seats[bIdx].sock === B2 && !r1.seats[bIdx].disconnected && r1.seats[bIdx].bets.banker === 25 && bac.bank.get("guest:bob") === 4939.25);
    // same-socket resync (mobile half-open socket) → snapshot, never already_seated
    const before2 = B2._msgs.length;
    bac.handle(B2, { type: "bac:room:join" });
    const resnap = B2._msgs.slice(before2).find((m) => m.type === "bac:room:snapshot");
    eq("same-socket re-join RESYNCS (snapshot with you.seat, not already_seated)", !!resnap && resnap.you && typeof resnap.you.seat === "number" && !B2._msgs.slice(before2).some((m) => m.type === "bac:error" && m.code === "already_seated"));
    const B3 = mkWs("guest:bob");
    bac.handle(B3, { type: "bac:room:join" });
    eq("a 2nd socket with the same wallet is still rejected (multi-tab guard)", gotErr(B3, "already_seated"));

    // ── empty betting windows → idle; join during idle re-opens betting ──
    bac.handle(B2, { type: "bac:bet:undo" }); // refund bob's 25 so startBetting can't eat escrow
    eq("bob back to whole (4964.25)", bac.bank.get("guest:bob") === 4964.25);
    bac._room.startBetting(r1);
    bac._room.endBetting(r1); bac._room.endBetting(r1);
    eq("empty windows re-arm (still betting after 2)", r1.phase === "betting");
    bac._room.endBetting(r1);
    eq("3rd consecutive empty window drops the table to IDLE", r1.phase === "idle");
    const J = mkWs("guest:idlejoiner");
    bac.handle(J, { type: "bac:room:join" });
    eq("a join during idle starts a fresh betting window", r1.phase === "betting");

    // ── history is capped at the last 90 outcomes ──
    r1.history = new Array(90).fill("B");
    bac.handle(A, { type: "bac:bet:add", zone: "player", amountUsd: 10 });
    scriptShoe = mkShoe("4H 2S 5D 3C");
    bac._room.endBetting(r1);
    eq("history keeps the last 90 outcomes (window slides)", r1.history.length === 90 && r1.history[89] === "P" && r1.history[0] === "B");

    // ── seedGuest demo mirror + guest topUp ──
    bac._room.startBetting(r1); // fresh betting window (seeds are refused mid-coup)
    const S = mkWs("guest:seedtest");
    bac.handle(S, { type: "bac:room:join" }); // lands in a demo room (r1 or a fresh one), phase betting/idle
    S._lastGuestSeed = 0; bac.handle(S, { type: "bac:seed", balance: 250 });
    eq("bac:seed sets the guest bank exactly (→ 250)", bac.bank.get("guest:seedtest") === 250);
    S._lastGuestSeed = 0; bac.handle(S, { type: "bac:seed", balance: 80 });
    eq("bac:seed LOWERS to mirror a demoUsd that dropped (→ 80)", bac.bank.get("guest:seedtest") === 80);
    S._lastGuestSeed = 0; bac.handle(S, { type: "bac:seed", balance: 9e9 });
    eq("bac:seed clamps to GUEST_BAL_CAP (25000)", bac.bank.get("guest:seedtest") === 25000);
    S._lastGuestSeed = 0; bac.handle(S, { type: "bac:seed", balance: 100 });
    bac.handle(S, { type: "bac:seed", balance: 5000 }); // within the 3s cooldown → ignored
    eq("bac:seed cooldown blocks a rapid 2nd seed (stays 100)", bac.bank.get("guest:seedtest") === 100);
    bac.handle(S, { type: "bac:bet:add", zone: "player", amountUsd: 50 });
    S._lastGuestSeed = 0; bac.handle(S, { type: "bac:seed", balance: 9999 });
    eq("bac:seed refused while chips are escrowed (stays 50)", bac.bank.get("guest:seedtest") === 50);
    bac.handle(S, { type: "bac:bet:undo" });
    S._lastGuestTopUp = 0; bac.handle(S, { type: "bac:topup", amount: 1000 });
    eq("guest top-up credits during betting (100 → 1100)", bac.bank.get("guest:seedtest") === 1100);

    /* ───── ENGINE P: paced timers (no-op scheduler) — choreography + hasDealtHand + ride-on-merits ───── */
    scriptShoe = mkShoe("AC 2S AD AS 4H 9H"); // T16: P=A,A,4→6 · B=2,A,9→2 · both third cards · PLAYER wins
    const bp = attachBaccarat(Object.assign({ maxWinUsd: 2000, timers: { dealPace: 450, revealHold: 700, revealPace: 650 }, makeShoe: scriptedMakeShoe }, noT));
    const P1 = mkWs("guest:paced");
    bp.handle(P1, { type: "bac:room:join" });
    bp.handle(P1, { type: "bac:bet:add", zone: "player", amountUsd: 100 });
    const rp = roomOf(bp, "guest:paced");
    eq("hasLiveHand true / hasDealtHand FALSE during the betting window", bp.hasLiveHand("guest:paced") === true && bp.hasDealtHand("guest:paced") === false);
    bp._room.endBetting(rp);
    eq("paced deal: phase dealing, cards timer-driven (none yet)", rp.phase === "dealing" && rp.playerCards.length === 0 && rp.bankerCards.length === 0);
    eq("hasDealtHand TRUE once the coup is dealing (token top-up gate)", bp.hasDealtHand("guest:paced") === true);
    const g0 = bp.bank.get("guest:paced");
    bp.handle(P1, { type: "bac:seed", balance: 9999 });
    eq("bac:seed refused mid-coup", bp.bank.get("guest:paced") === g0);
    P1._lastGuestTopUp = 0; bp.handle(P1, { type: "bac:topup", amount: 1000 });
    eq("guest top-up refused mid-coup", bp.bank.get("guest:paced") === g0);
    bp._room.dealStep(rp); bp._room.dealStep(rp); bp._room.dealStep(rp);
    eq("deal order P1,B1,P2 (3 paced steps)", rp.playerCards.length === 2 && rp.bankerCards.length === 1);
    bp.handle(P1, { type: "bac:room:leave" }); // abandon MID-COUP — chips must ride and settle on merits
    eq("leave mid-coup marks the seat left; chips ride", rp.seats.some((s) => s && s.left) && bp.hasLiveHand("guest:paced") === true);
    bp._room.dealStep(rp);
    eq("4th card → reveal phase (third-card tableau begins)", rp.phase === "reveal" && rp.bankerCards.length === 2);
    bp._room.revealStep(rp);
    eq("tableau step 1: player third card (A,A,4 → 6)", rp.playerCards.length === 3 && Rules.handTotal(rp.playerCards) === 6);
    bp._room.revealStep(rp);
    eq("tableau step 2: banker third card (banker 3 draws vs 4)", rp.bankerCards.length === 3 && Rules.handTotal(rp.bankerCards) === 2);
    bp._room.revealStep(rp);
    eq("tableau step 3: settle — player 6 over 2", rp.phase === "settle" && rp.outcome && rp.outcome.winner === "player" && rp.outcome.playerTotal === 6 && rp.outcome.bankerTotal === 2);
    eq("the LEAVER's winning zone still PAID (settles on merits: 4900 + 200)", bp.bank.get("guest:paced") === 5100);
    bp._room.startBetting(rp);
    eq("left seat dropped at the next window (empty table → idle)", rp.phase === "idle" && rp.seats.every((s) => !s));

    /* ───── ENGINE B: real shuffle, fixed seed — PF end-to-end determinism ───── */
    scriptShoe = null;
    const fixedSeed = "0f3a55e6c1d24b78900112233445566778899aabbccddeeff00112233445566";
    const be = attachBaccarat(Object.assign({ maxWinUsd: 2000, timers: { dealPace: 0, revealHold: 0, revealPace: 0 },
      randomness: { name: "test-fixed", begin: () => ({ serverSeed: fixedSeed, commit: Shuffle.commitHash(fixedSeed), proof: null }) } }, noT));
    const PW = mkWs("guest:pf");
    be.handle(PW, { type: "bac:room:join" });
    be.handle(PW, { type: "bac:bet:add", zone: "player", amountUsd: 50, clientSeed: "pfseed" });
    const rb = roomOf(be, "guest:pf");
    be._room.endBetting(rb);
    const rev = PW._msgs.filter((m) => m.type === "bac:reveal").pop();
    eq("bac:reveal carries serverSeed/commit/shoeId/clientSeeds/decks/source", !!rev && rev.serverSeed === fixedSeed && rev.commit === Shuffle.commitHash(fixedSeed) && Array.isArray(rev.clientSeeds) && rev.clientSeeds.indexOf("pfseed") >= 0 && rev.decks === 8 && !!rev.source);
    const v = Shuffle.verify(rev.serverSeed, rev.commit, rev.clientSeeds, rev.shoeId, rev.decks);
    eq("commit verifies against the revealed serverSeed", v.hashOk === true);
    const replay = Rules.runTableau(v.shoe);
    eq("PF DETERMINISM — runTableau(Shuffle.verify(...).shoe) equals the dealt round exactly",
      cardsEq(replay.player, rb.playerCards) && cardsEq(replay.banker, rb.bankerCards) &&
      replay.winner === rb.outcome.winner && replay.playerTotal === rb.outcome.playerTotal && replay.bankerTotal === rb.outcome.bankerTotal);

    /* ───── ENGINE T: token ledger — frozen binding, same-session money, game:"baccarat" rows, segregation ───── */
    const player = "0x2F4BEF94550C29c497b999B86b758F9771F7aB39";
    const sess = { S1: { player: player, tokens: 1000, rows: [] } };
    const TL = {
      tokensOf: (sid) => (sess[sid] ? sess[sid].tokens : null),
      applyNet: (p, sid, bet, payout) => {
        const s = sess[sid]; if (!s) throw new Error("no open token session");
        if (s.player.toLowerCase() !== String(p).toLowerCase()) throw new Error("wrong player");
        if (bet > s.tokens) throw new Error("insufficient");
        s.tokens = Math.round((s.tokens - bet + payout) * 100) / 100;
        s.rows.push({ kind: "external", game: "baccarat", betUnits: bet, payoutUnits: payout }); // what token-http applyBaccaratNet stamps
        return s.tokens;
      },
    };
    const bt = attachBaccarat(Object.assign({ tokenLedger: TL, maxWinUsd: 2000, timers: { dealPace: 0, revealHold: 0, revealPace: 0 }, makeShoe: scriptedMakeShoe }, noT));
    eq("bind a token wallet succeeds", bt.bindToken(player, "S1") === true);
    const TW = mkWs(player);
    bt.handle(TW, { type: "bac:room:join" });
    eq("token-bound wallet seats (authStillValid allows a bound wallet)", !!roomOf(bt, player));
    bt.handle(TW, { type: "bac:bet:add", zone: "banker", amountUsd: 100, clientSeed: "t" });
    eq("a zone add debits the TOKEN session (1000 → 900)", TL.tokensOf("S1") === 900);
    eq("hasLiveHand true once any zone >0 (cash-out gate)", bt.hasLiveHand(player) === true);
    eq("bindToken FROZEN mid-round (can't swap the funding pool)", bt.bindToken(player, "S2") === false);
    eq("unbindToken FROZEN mid-round (win can't be diverted)", bt.unbindToken(player) === false);
    scriptShoe = mkShoe("3D 4S 5C 5H"); // T2: banker natural 9 — banker $100 pays 195
    bt._room.endBetting(roomOf(bt, player));
    eq("settle credits the SAME frozen session (900 + 195 = 1095)", TL.tokensOf("S1") === 1095);
    eq("every ledger row is stamped game:'baccarat'", sess.S1.rows.length === 2 && sess.S1.rows.every((rw) => rw.game === "baccarat"));
    eq("hasLiveHand false after settle (cash-out unblocked)", bt.hasLiveHand(player) === false);
    eq("unbind allowed again between rounds", bt.unbindToken(player) === true && bt.bindToken(player, "S1") === true);
    // failed token credit is SURFACED, never a silent phantom win
    const rt = roomOf(bt, player);
    bt._room.startBetting(rt);
    bt.handle(TW, { type: "bac:bet:add", zone: "banker", amountUsd: 50 });
    eq("re-bet debits (1095 → 1045)", TL.tokensOf("S1") === 1045);
    const savedSess = sess.S1; delete sess.S1; // simulate a closed session mid-settle (unreachable by construction)
    mark = TW._msgs.length;
    scriptShoe = mkShoe("3D 4S 5C 5H");
    bt._room.endBetting(rt);
    eq("a failed token payout is SURFACED to the player (credit_failed)", gotErr(TW, "credit_failed", mark));
    sess.S1 = savedSess;
    // an UNBOUND real wallet can't sit/bet — and the deny must NOT strip the shared socket identity
    const UW = mkWs("0x1111111111111111111111111111111111111111");
    bt.handle(UW, { type: "bac:room:join" });
    eq("an UNBOUND real wallet is denied (auth_required, no seat)", gotErr(UW, "auth_required") && !roomOf(bt, "0x1111111111111111111111111111111111111111"));
    eq("the deny does NOT strip sock.wallet (identity shared with the BJ engine)", UW.wallet === "0x1111111111111111111111111111111111111111");
    // kind segregation: real (token) and demo (guest) players NEVER share a table
    const GW = mkWs("guest:demo1");
    bt.handle(GW, { type: "bac:room:join" });
    const realRoom = roomOf(bt, player), demoRoom = roomOf(bt, "guest:demo1");
    eq("real + demo players are seated at DIFFERENT tables", !!realRoom && !!demoRoom && realRoom !== demoRoom);
    eq("real table kind=real, guest table kind=demo", realRoom.kind === "real" && demoRoom.kind === "demo");
    const GW2 = mkWs("guest:demo2");
    bt.handle(GW2, { type: "bac:room:join", roomId: realRoom.id });
    const g2Room = roomOf(bt, "guest:demo2");
    eq("a guest opening a real-money table link is REDIRECTED to a demo table", !!g2Room && g2Room.id !== realRoom.id && g2Room.kind === "demo");
    const player2 = "0x3333333333333333333333333333333333333333"; sess.S3 = { player: player2, tokens: 500, rows: [] }; bt.bindToken(player2, "S3");
    bt.handle(mkWs(player2), { type: "bac:room:join" });
    eq("a 2nd real player joins a real-kind table", (roomOf(bt, player2) || {}).kind === "real");
    // a guest is untouched by the token ledger
    eq("a guest plays on the play-money bank (token ledger untouched)", !bt.isTokenWallet("guest:demo1") && bt.bank.get("guest:demo1") === 5000);

    console.log(ok ? "\nSELF-TEST OK — baccarat engine: chip escrow (add/undo/clear/rebet), exact settle math (P/B/tie/push), PF determinism, paced tableau choreography, ride-on-merits, kind segregation, frozen token funding pool."
                   : "\nSELF-TEST FAILED");
    process.exit(ok ? 0 : 1);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
