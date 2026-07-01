// poker-engine.js — pure, environment-agnostic No-Limit Texas Hold'em engine.
// No DOM, no Node-only APIs (uses globalThis.crypto, present in browsers and Node 18+).
// The SAME file runs client-side (Phase 1, vs bots) and server-side (Phase 2, multiplayer).
//
// Source of truth: the TDA / Robert's Rules spec researched for this project.
// The two areas engines usually botch are implemented deliberately:
//   - side pots are built ONCE from each player's committedTotal (never an incremental int)
//   - an all-in that is LESS than a full raise does NOT reopen action to players who already acted
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.Poker = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- cards -------------------------------------------------------------
  // rank: 2..14 (J=11,Q=12,K=13,A=14, A also = 1 for the wheel). suit: 0..3.
  const SUITS = ["♠", "♥", "♦", "♣"];
  const RANKS = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  function rankLabel(r) { return RANKS[r] || String(r); }
  function cardLabel(c) { return rankLabel(c.rank) + SUITS[c.suit]; }

  function makeDeck() {
    const d = [];
    for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ rank: r, suit: s });
    return d;
  }

  // CSPRNG Fisher–Yates (unbiased). Falls back to Math.random only if no crypto.
  function secureShuffle(deck) {
    const a = deck.slice();
    const rnd = (n) => {
      const g = (typeof globalThis !== "undefined" && globalThis.crypto) ? globalThis.crypto : null;
      if (g && g.getRandomValues) {
        // rejection sampling for an unbiased [0,n)
        const max = Math.floor(0x100000000 / n) * n;
        const buf = new Uint32Array(1);
        let x;
        do { g.getRandomValues(buf); x = buf[0]; } while (x >= max);
        return x % n;
      }
      return Math.floor(Math.random() * n);
    };
    for (let i = a.length - 1; i > 0; i--) {
      const j = rnd(i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---- 5-card evaluation -------------------------------------------------
  // Returns a comparable numeric score; bigger = better. Encodes
  // (category, tiebreak1..tiebreak5) in base-16 so plain > comparison works.
  const CAT = { HIGH: 1, PAIR: 2, TWO_PAIR: 3, TRIPS: 4, STRAIGHT: 5, FLUSH: 6, FULL: 7, QUADS: 8, STRAIGHT_FLUSH: 9 };

  function score5(cards) {
    const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
    const suits = cards.map((c) => c.suit);
    const isFlush = suits.every((s) => s === suits[0]);

    // straight detection (with wheel A-2-3-4-5 where A counts low)
    const uniq = Array.from(new Set(ranks)).sort((a, b) => b - a);
    let straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // wheel
    }

    // rank frequency buckets, ordered by (count desc, rank desc)
    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    const groups = Object.keys(counts)
      .map((r) => ({ rank: +r, n: counts[r] }))
      .sort((a, b) => (b.n - a.n) || (b.rank - a.rank));
    const shape = groups.map((g) => g.n).join(""); // e.g. "32","41","221"
    const kick = groups.map((g) => g.rank);

    let cat, tb;
    if (straightHigh && isFlush) { cat = CAT.STRAIGHT_FLUSH; tb = [straightHigh]; }
    else if (shape === "41") { cat = CAT.QUADS; tb = kick; }
    else if (shape === "32") { cat = CAT.FULL; tb = kick; }
    else if (isFlush) { cat = CAT.FLUSH; tb = ranks; }
    else if (straightHigh) { cat = CAT.STRAIGHT; tb = [straightHigh]; }
    else if (shape === "311") { cat = CAT.TRIPS; tb = kick; }
    else if (shape === "221") { cat = CAT.TWO_PAIR; tb = kick; }
    else if (shape === "2111") { cat = CAT.PAIR; tb = kick; }
    else { cat = CAT.HIGH; tb = ranks; }

    let s = cat;
    for (let i = 0; i < 5; i++) s = s * 16 + (tb[i] || 0);
    return s;
  }

  function combinations(arr, k) {
    const res = [];
    const n = arr.length;
    const idx = Array.from({ length: k }, (_, i) => i);
    while (true) {
      res.push(idx.map((i) => arr[i]));
      let i = k - 1;
      while (i >= 0 && idx[i] === n - k + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
    return res;
  }

  // best 5-of-7 score
  function evaluate(sevenCards) {
    let best = 0;
    for (const five of combinations(sevenCards, 5)) {
      const s = score5(five);
      if (s > best) best = s;
    }
    return best;
  }

  // Human-readable category for a 7-card hand (for UI labels).
  function categoryName(sevenCards) {
    let best = 0, bestFive = null;
    for (const five of combinations(sevenCards, 5)) {
      const s = score5(five);
      if (s > best) { best = s; bestFive = five; }
    }
    const cat = Math.floor(best / Math.pow(16, 5));
    const names = { 1: "High card", 2: "Pair", 3: "Two pair", 4: "Three of a kind", 5: "Straight", 6: "Flush", 7: "Full house", 8: "Four of a kind", 9: "Straight flush" };
    return names[cat] || "—";
  }

  // ---- side pots ---------------------------------------------------------
  // Build main + side pots from each player's committedTotal. Folded players'
  // chips stay as dead money but they're excluded from every eligible set.
  // players: [{ id, committedTotal, folded }]
  function buildPots(players) {
    const contrib = {};
    for (const p of players) if (p.committedTotal > 0) contrib[p.id] = p.committedTotal;
    const foldedById = {};
    for (const p of players) foldedById[p.id] = p.folded;

    const pots = [];
    let guard = 0;
    while (Object.values(contrib).some((c) => c > 0)) {
      if (++guard > 1000) break;
      const positive = Object.values(contrib).filter((c) => c > 0);
      const level = Math.min.apply(null, positive);
      let amount = 0;
      const eligible = [];
      for (const id of Object.keys(contrib)) {
        if (contrib[id] > 0) {
          amount += level;
          contrib[id] -= level;
          if (!foldedById[id]) eligible.push(id);
        }
      }
      // merge with previous pot if the eligible set is identical (tidy display)
      const prev = pots[pots.length - 1];
      if (prev && sameSet(prev.eligible, eligible)) prev.amount += amount;
      else pots.push({ amount: amount, eligible: eligible });
    }
    return pots;
  }
  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    return b.every((x) => sa.has(x));
  }

  // ---- the betting state machine ----------------------------------------
  // A single hand of No-Limit Hold'em. Players are given in clockwise SEAT
  // order; buttonIndex points into that array. The engine auto-posts blinds,
  // deals, advances streets, and runs showdown. The caller drives whose turn
  // it is by calling act(); for bots the caller loops while toAct is a bot.
  //
  // player action types: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'
  function PokerHand(opts) {
    this.sb = opts.smallBlind;
    this.bb = opts.bigBlind;
    this.onEvent = opts.onEvent || function () {};
    // working player records (only those dealt in)
    this.players = opts.players.map((p, i) => ({
      id: p.id, name: p.name || p.id, seat: p.seat != null ? p.seat : i,
      isBot: !!p.isBot, stack: p.stack, hole: [],
      folded: false, allIn: false, committedStreet: 0, committedTotal: 0,
      acted: false, mayRaise: true, sittingOut: !!p.sittingOut,
    })).filter((p) => p.stack > 0 && !p.sittingOut);
    this.n = this.players.length;
    this.button = opts.buttonIndex % this.n;
    this.deck = secureShuffle(makeDeck());
    this.di = 0;
    this.board = [];
    this.street = "preflop";
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.toAct = -1;
    this.done = false;
    this.pots = [];
    this.payouts = {};   // id -> chips returned (winnings + returned stake)
    this.deltas = {};    // id -> net change vs start of hand
    this.shown = {};     // id -> { hole, cat } revealed at showdown
    this.log = [];
  }

  PokerHand.prototype._draw = function () { return this.deck[this.di++]; };
  PokerHand.prototype._activeInHand = function () { return this.players.filter((p) => !p.folded); };
  PokerHand.prototype._canActPlayers = function () { return this.players.filter((p) => !p.folded && !p.allIn); };

  // next seat clockwise from idx (exclusive) matching pred
  PokerHand.prototype._next = function (idx, pred) {
    for (let k = 1; k <= this.n; k++) {
      const j = (idx + k) % this.n;
      if (pred(this.players[j], j)) return j;
    }
    return -1;
  };

  PokerHand.prototype.start = function () {
    const heads = this.n === 2;
    // Blinds. Heads-up: button is the small blind.
    const sbIdx = heads ? this.button : this._next(this.button, () => true);
    const bbIdx = this._next(sbIdx, () => true);
    this._postBlind(sbIdx, this.sb);
    this._postBlind(bbIdx, this.bb);
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    // deal 2 hole cards, one at a time from SB
    for (let r = 0; r < 2; r++) {
      let j = sbIdx;
      for (let c = 0; c < this.n; c++) { this.players[j].hole.push(this._draw()); j = (j + 1) % this.n; }
    }
    // first to act preflop = left of BB (heads-up: the button/SB acts first)
    this.toAct = heads ? sbIdx : this._next(bbIdx, (p) => !p.folded && !p.allIn);
    this.bbIdx = bbIdx; // for the BB option
    this._emit("hand-start");
    this._maybeAutoResolve();
    return this.state();
  };

  PokerHand.prototype._postBlind = function (idx, amt) {
    const p = this.players[idx];
    const put = Math.min(amt, p.stack);
    p.stack -= put; p.committedStreet += put; p.committedTotal += put;
    if (p.stack === 0) p.allIn = true;
    // blinds are forced, not voluntary: the blind posters have NOT "acted"
  };

  // What may the given player legally do right now?
  PokerHand.prototype.legalActions = function (id) {
    const p = this.players.find((x) => x.id === id);
    if (!p || this.done || this.players[this.toAct].id !== id) return { yourTurn: false };
    const toCall = Math.max(0, this.currentBet - p.committedStreet);
    const canCheck = toCall === 0;
    const canCall = toCall > 0;
    const callAmount = Math.min(toCall, p.stack);
    // raising
    const maxRaiseTo = p.committedStreet + p.stack; // all-in total
    const minRaiseTo = this.currentBet + this.minRaise;
    const canRaise = p.mayRaise && p.stack > toCall && maxRaiseTo > this.currentBet;
    return {
      yourTurn: true, toCall, canCheck, canCall, callAmount,
      canBet: this.currentBet === 0 && p.stack > 0,
      minBet: Math.min(this.bb, p.stack),
      canRaise, minRaiseTo: Math.min(minRaiseTo, maxRaiseTo), maxRaiseTo,
      stack: p.stack, committed: p.committedStreet,
    };
  };

  // Apply an action for the player whose turn it is.
  PokerHand.prototype.act = function (id, type, amount) {
    if (this.done) return this.state();
    const idx = this.toAct;
    const p = this.players[idx];
    if (!p || p.id !== id) throw new Error("not your turn");
    const la = this.legalActions(id);
    const toCall = la.toCall;

    if (type === "fold") {
      p.folded = true; p.acted = true;
      this.log.push(p.name + " folds");
    } else if (type === "check") {
      if (toCall !== 0) throw new Error("cannot check facing a bet");
      p.acted = true; this.log.push(p.name + " checks");
    } else if (type === "call") {
      const put = Math.min(toCall, p.stack);
      this._put(p, put); p.acted = true;
      this.log.push(p.name + (p.allIn ? " calls all-in " : " calls ") + put);
    } else if (type === "bet" || type === "raise" || type === "allin") {
      let target;
      if (type === "allin") target = p.committedStreet + p.stack;
      else target = amount;
      // clamp to a legal total
      const maxTo = p.committedStreet + p.stack;
      if (target > maxTo) target = maxTo;
      const isAllIn = target === maxTo;
      const prevBet = this.currentBet;
      // must be at least a call unless it's an all-in for less
      if (target < prevBet && !isAllIn) throw new Error("raise below current bet");
      if (this.currentBet === 0) {
        // opening bet
        if (!isAllIn && target < Math.min(this.bb, maxTo)) throw new Error("bet below min");
      } else {
        const minLegal = prevBet + this.minRaise;
        if (!isAllIn && target < minLegal) throw new Error("raise below min");
      }
      const put = target - p.committedStreet;
      this._put(p, put);
      const increment = this.currentBet - prevBet; // how much the high went up
      const fullRaise = increment >= this.minRaise && this.currentBet > prevBet;
      if (this.currentBet > prevBet) {
        if (fullRaise) {
          this.minRaise = increment;
          // a full raise reopens the action: everyone else may act AND raise again
          for (const q of this.players) if (!q.folded && !q.allIn && q !== p) { q.acted = false; q.mayRaise = true; }
        } else {
          // short all-in: does NOT reopen raising for players who already acted.
          // They must still call/fold (handled via committedStreet < currentBet),
          // but lose the right to re-raise; min-raise size is unchanged.
          for (const q of this.players) if (!q.folded && !q.allIn && q !== p && q.acted) q.mayRaise = false;
        }
      }
      p.acted = true;
      this.log.push(p.name + (type === "bet" ? " bets " : " raises to ") + this.currentBet + (p.allIn ? " (all-in)" : ""));
    } else {
      throw new Error("unknown action " + type);
    }

    this._emit("action", { id: p.id, type: type });
    this._advance();
    return this.state();
  };

  PokerHand.prototype._put = function (p, amt) {
    amt = Math.min(amt, p.stack);
    p.stack -= amt; p.committedStreet += amt; p.committedTotal += amt;
    if (p.committedStreet > this.currentBet) this.currentBet = p.committedStreet;
    if (p.stack === 0) p.allIn = true;
  };

  // settled = no further action owed this round
  PokerHand.prototype._settled = function (p) {
    if (p.folded || p.allIn) return true;
    return p.acted && p.committedStreet === this.currentBet;
  };

  PokerHand.prototype._advance = function () {
    // hand ends immediately if only one player remains
    if (this._activeInHand().length === 1) { this._finish(); return; }
    // find next player who still owes action
    const nxt = this._next(this.toAct, (p) => !p.folded && !p.allIn && !this._settled(p));
    if (nxt !== -1) { this.toAct = nxt; this._maybeAutoResolve(); return; }
    // betting round complete → collect, advance street
    this._closeStreet();
  };

  // If everyone who can still act is already settled (e.g. all-in), run it out.
  PokerHand.prototype._maybeAutoResolve = function () {
    if (this._canActPlayers().length <= 1) {
      // nobody (or one) can act — but if that one still owes a call, let them act
      const owing = this.players.filter((p) => !p.folded && !p.allIn && p.committedStreet < this.currentBet);
      if (owing.length === 0) this._runOut();
    }
  };

  PokerHand.prototype._closeStreet = function () {
    for (const p of this.players) { p.committedStreet = 0; p.acted = false; p.mayRaise = true; }
    this.currentBet = 0; this.minRaise = this.bb;
    if (this.street === "preflop") { this._deal("flop"); }
    else if (this.street === "flop") { this._deal("turn"); }
    else if (this.street === "turn") { this._deal("river"); }
    else { this._showdown(); return; }
    // first to act postflop = first active player left of the button
    this.toAct = this._next(this.button, (p) => !p.folded && !p.allIn);
    if (this.toAct === -1) { this._runOut(); return; }
    this._emit("street", { street: this.street });
    this._maybeAutoResolve();
  };

  PokerHand.prototype._deal = function (street) {
    this.di++; // burn
    if (street === "flop") { this.board.push(this._draw(), this._draw(), this._draw()); }
    else { this.board.push(this._draw()); }
    this.street = street;
  };

  // No more betting possible: deal any remaining streets, then showdown.
  PokerHand.prototype._runOut = function () {
    while (this.board.length < 5 && this._activeInHand().length > 1) {
      if (this.street === "preflop") this._deal("flop");
      else if (this.street === "flop") this._deal("turn");
      else if (this.street === "turn") this._deal("river");
      else break;
    }
    if (this._activeInHand().length === 1) this._finish();
    else this._showdown();
  };

  PokerHand.prototype._showdown = function () {
    this.street = "showdown";
    const live = this._activeInHand();
    for (const p of live) this.shown[p.id] = { hole: p.hole.slice(), cat: categoryName(p.hole.concat(this.board)) };
    this._finish();
  };

  // Build pots, award winners, compute payouts + deltas.
  PokerHand.prototype._finish = function () {
    const pots = buildPots(this.players.map((p) => ({ id: p.id, committedTotal: p.committedTotal, folded: p.folded })));
    this.pots = pots;
    const startStack = {};
    for (const p of this.players) { this.payouts[p.id] = 0; startStack[p.id] = p.committedTotal + p.stack; }

    const live = this._activeInHand();
    const scoreById = {};
    if (live.length === 1) {
      // uncontested — winner takes everything, no cards shown
      scoreById[live[0].id] = 1;
    } else {
      for (const p of live) scoreById[p.id] = evaluate(p.hole.concat(this.board));
    }

    this.winners = [];
    for (let pi = 0; pi < pots.length; pi++) {
      const pot = pots[pi];
      const contenders = pot.eligible.filter((id) => scoreById[id] != null);
      if (contenders.length === 0) continue;
      let best = -1, winners = [];
      for (const id of contenders) {
        const s = scoreById[id];
        if (s > best) { best = s; winners = [id]; }
        else if (s === best) winners.push(id);
      }
      // split, odd chip(s) clockwise from the button
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      const ordered = this._clockwiseFromButton(winners);
      for (const id of ordered) {
        let amt = share;
        if (odd > 0) { amt += 1; odd--; }
        this.payouts[id] += amt;
      }
      this.winners.push({ pot: pi, amount: pot.amount, ids: winners });
    }
    // apply payouts to stacks; compute deltas vs hand start
    for (const p of this.players) { p.stack += this.payouts[p.id]; this.deltas[p.id] = p.stack - startStack[p.id]; }
    this.done = true;
    this._emit("done");
  };

  PokerHand.prototype._clockwiseFromButton = function (ids) {
    const set = new Set(ids);
    const out = [];
    for (let k = 1; k <= this.n; k++) {
      const j = (this.button + k) % this.n;
      if (set.has(this.players[j].id)) out.push(this.players[j].id);
    }
    return out;
  };

  PokerHand.prototype._emit = function (type, data) { try { this.onEvent(Object.assign({ type: type }, data || {}), this); } catch (e) {} };

  // Snapshot for rendering. `viewerId` hides other players' hole cards.
  PokerHand.prototype.state = function (viewerId) {
    return {
      street: this.street, board: this.board.slice(), currentBet: this.currentBet,
      minRaise: this.minRaise, pot: this.players.reduce((s, p) => s + p.committedTotal, 0),
      button: this.button, toAct: this.toAct, toActId: this.toAct >= 0 && !this.done ? this.players[this.toAct].id : null,
      done: this.done, pots: this.pots, winners: this.winners || [], deltas: this.deltas, shown: this.shown,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, seat: p.seat, isBot: p.isBot, stack: p.stack,
        committedStreet: p.committedStreet, committedTotal: p.committedTotal,
        folded: p.folded, allIn: p.allIn,
        hole: (this.done && this.shown[p.id]) ? this.shown[p.id].hole : (viewerId && p.id === viewerId ? p.hole : null),
        hasCards: p.hole.length > 0,
      })),
      log: this.log.slice(-8),
    };
  };

  return {
    CAT, makeDeck, secureShuffle, score5, evaluate, categoryName,
    buildPots, combinations, cardLabel, rankLabel, PokerHand,
  };
});
