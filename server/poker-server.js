/* ============================================================
   poker-server.js — SERVER-AUTHORITATIVE No-Limit Texas Hold'em core.

   THE AUDIT'S CRITICAL-5: today the entire deck + every player's hole cards
   live in the browser (public/poker-engine.js runs client-side vs bots), so a
   modified client can read undealt cards and opponents' holes. This module moves
   the deck, the deal, the betting state machine, the showdown evaluation, and the
   bot decisions to the SERVER, and exposes a per-client SNAPSHOT that reveals ONLY
   the viewer's hole cards — never another seat's holes and never the undealt stub.

   RULES SOURCE OF TRUTH (mirrored exactly, byte-for-byte logic):
     • public/poker-engine.js — 5-of-7 hand evaluation (score5/evaluate),
       side-pot construction from committedTotal, the betting state machine
       (blinds, streets, the short-all-in-does-not-reopen rule, odd-chip award
       clockwise from the button). This file re-implements that SAME logic so the
       server is the authority and the client engine becomes a pure renderer.
     • public/poker-bots.js — the heuristic decide() (preflop/postflop strength,
       pot-odds, sizing, bluff frequency) is reproduced so server-run bots behave
       identically to the client bots players are used to.

   SHUFFLE — PROVABLY FAIR, NOT Math.random:
     The browser engine uses a CSPRNG (secureShuffle) the player can't verify.
     Here the deck is a deterministic Fisher–Yates keyed by the committed server
     seed via server/provablyfair.js (HMAC float stream), exactly like
     public/blackjack-shuffle.js's shoe. commit = SHA256(serverSeed) is published
     at hand start (BEFORE any card is seen by anyone); serverSeed is revealed at
     hand end so anyone re-derives the whole deal. No Chainlink VRF.

   PUBLIC MODULE API:
     const Poker = require("./poker-server.js");
     const t = Poker.createTable({ smallBlind, bigBlind, seats });
     Poker.sit(t, { id, name, isBot, stack, aggression });   // seat a player
     Poker.startHand(t [, { buttonIndex }]);                  // commit + deal
     Poker.act(t, playerId, type, amount);                    // a human acts
     Poker.advance(t);                                        // drive bots / runout
     Poker.snapshotFor(t, viewerId);                          // MASKED view
     // at hand end the snapshot carries { commit, serverSeed } for client verify.

   SELF-TEST (node server/poker-server.js):
     • deal + showdown are deterministic from a seed and re-derivable;
     • snapshotFor(X) never contains another player's hole cards or the stub;
     • a full multi-player hand plays to showdown with bots;
     • the hand evaluator + side pots match a battery of fixed cases.
   ============================================================ */
"use strict";

const PF = require("./provablyfair.js");

/* =========================================================================
   1. CARDS + DETERMINISTIC PROVABLY-FAIR SHUFFLE
   ========================================================================= */

const SUITS = ["♠", "♥", "♦", "♣"]; // ♠ ♥ ♦ ♣
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
function rankLabel(r) { return RANK_LABEL[r] || String(r); }
function cardLabel(c) { return rankLabel(c.rank) + SUITS[c.suit]; }

// Canonical ordered 52-card deck. rank 2..14 (J=11,Q=12,K=13,A=14), suit 0..3.
function makeDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ rank: r, suit: s });
  return d;
}

// Deterministic Fisher–Yates over the canonical deck, driven by the committed
// PF float stream. Identical scheme to public/blackjack-shuffle.js's shoe:
//   swap index j for position i comes from float[i] in the (serverSeed,clientSeed,nonce)
//   stream. Pure function of the committed seed → fully re-derivable from the reveal.
// We request all (deck.length-1) floats up front in ONE stream so the mapping is
// stable and verifiable.
function provablyFairDeck(serverSeed, clientSeed, nonce) {
  const deck = makeDeck();
  const n = deck.length; // 52
  // need a float for each i from n-1 down to 1 → (n-1) floats
  const stream = PF.floats(serverSeed, clientSeed, nonce, n);
  let k = 0;
  for (let i = n - 1; i >= 1; i--) {
    const f = stream[k++];
    const j = Math.floor(f * (i + 1)); // [0, i]
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

/* =========================================================================
   2. HAND EVALUATION  (mirror of poker-engine.js score5/evaluate/categoryName)
   ========================================================================= */

const CAT = { HIGH: 1, PAIR: 2, TWO_PAIR: 3, TRIPS: 4, STRAIGHT: 5, FLUSH: 6, FULL: 7, QUADS: 8, STRAIGHT_FLUSH: 9 };

// Comparable numeric score for an exact 5-card hand. Encodes (category, tb1..tb5)
// in base-16 so a plain > comparison ranks hands. (poker-engine.js:56-92)
function score5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const uniq = Array.from(new Set(ranks)).sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // wheel A-2-3-4-5
  }

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.keys(counts)
    .map((r) => ({ rank: +r, n: counts[r] }))
    .sort((a, b) => (b.n - a.n) || (b.rank - a.rank));
  const shape = groups.map((g) => g.n).join("");
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

function categoryName(sevenCards) {
  let best = 0;
  for (const five of combinations(sevenCards, 5)) {
    const s = score5(five);
    if (s > best) best = s;
  }
  const cat = Math.floor(best / Math.pow(16, 5));
  const names = { 1: "High card", 2: "Pair", 3: "Two pair", 4: "Three of a kind", 5: "Straight", 6: "Flush", 7: "Full house", 8: "Four of a kind", 9: "Straight flush" };
  return names[cat] || "—";
}

/* =========================================================================
   3. SIDE POTS  (mirror of poker-engine.js buildPots)
   ========================================================================= */

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

/* =========================================================================
   4. BOT DECISION  (mirror of poker-bots.js decide / preflop / postflop)

   The bot sees ONLY the masked snapshot for its own seat (its own holes are
   revealed; everyone else's are hidden — exactly what a human client gets), so a
   server-run bot cannot peek any more than a human could. It uses the SAME PF
   stream as the rest of the hand for its random choices, so even bot decisions
   are re-derivable from the reveal.
   ========================================================================= */

function botPreflopStrength(hole) {
  const r = hole.map((c) => c.rank).sort((a, b) => b - a);
  const suited = hole[0].suit === hole[1].suit;
  const gap = r[0] - r[1];
  let s;
  if (r[0] === r[1]) {
    s = 0.50 + ((r[0] - 2) / 12) * 0.50;
  } else {
    s = ((r[0] - 2) / 12) * 0.42 + ((r[1] - 2) / 12) * 0.20;
    if (suited) s += 0.08;
    if (gap === 1) s += 0.06; else if (gap === 2) s += 0.03;
    if (r[0] === 14) s += 0.04;
  }
  return Math.max(0, Math.min(1, s));
}

const CAT_BASE = { 1: 0.10, 2: 0.30, 3: 0.50, 4: 0.62, 5: 0.72, 6: 0.80, 7: 0.90, 8: 0.97, 9: 1.0 };
function botPostflopStrength(hole, board) {
  const seven = hole.concat(board);
  let best = 0;
  for (const five of combinations(seven, 5)) { const s = score5(five); if (s > best) best = s; }
  const cat = Math.floor(best / Math.pow(16, 5));
  let s = CAT_BASE[cat] || 0.1;
  const tb = best - cat * Math.pow(16, 5);
  s += (tb / Math.pow(16, 5)) * 0.06;
  return Math.max(0, Math.min(1, s));
}

function clampTarget(t, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(t))); }

// snap = masked snapshot (from snapshotFor(botId)); legal = legalActions(botId).
// opts: { aggression?:0..1, rng?:fn } → returns { type, amount? }
function botDecide(snap, legal, opts) {
  opts = opts || {};
  const rng = opts.rng || Math.random;
  const aggro = opts.aggression != null ? opts.aggression : 0.5;
  const me = snap.players.find((p) => p.id === snap.toActId);
  const hole = me && me.hole; // the bot can see ONLY its own cards in its own snapshot
  if (!hole) return { type: legal.canCheck ? "check" : "fold" };

  const street = snap.street;
  let strength = street === "preflop" ? botPreflopStrength(hole) : botPostflopStrength(hole, snap.board);
  strength += (rng() - 0.5) * 0.10;
  strength = Math.max(0, Math.min(1, strength));

  const pot = Math.max(1, snap.pot);
  const toCall = legal.toCall || 0;
  const bb = snap.minRaise || 1;

  function aggressiveTarget(frac) {
    if (legal.canBet) {
      const base = me.committedStreet + Math.round(pot * frac);
      return { type: "bet", amount: clampTarget(base, legal.minBet + me.committedStreet, legal.maxRaiseTo) };
    }
    if (legal.canRaise) {
      const base = snap.currentBet + Math.round(pot * frac);
      return { type: "raise", amount: clampTarget(base, legal.minRaiseTo, legal.maxRaiseTo) };
    }
    return null;
  }

  if (toCall === 0) {
    const betWant = strength > (0.62 - aggro * 0.12);
    const bluff = rng() < 0.06 * aggro;
    if ((betWant || bluff) && (legal.canBet || legal.canRaise)) {
      const frac = strength > 0.85 ? 0.85 : strength > 0.7 ? 0.66 : 0.5;
      const a = aggressiveTarget(frac);
      if (a) return a;
    }
    return { type: "check" };
  }

  const potOdds = toCall / (pot + toCall);

  if (strength > (0.84 - aggro * 0.08) && legal.canRaise && rng() < 0.55 + aggro * 0.25) {
    const a = aggressiveTarget(strength > 0.92 ? 1.0 : 0.7);
    if (a) return a;
  }
  if (strength >= potOdds + 0.04) return { type: "call" };
  if (toCall <= bb * 1.5 && rng() < 0.5 && strength > 0.18) return { type: "call" };
  if (legal.canRaise && rng() < 0.04 * aggro) { const a = aggressiveTarget(0.6); if (a) return a; }
  return legal.canCheck ? { type: "check" } : { type: "fold" };
}

/* =========================================================================
   5. THE HAND — server-authoritative betting state machine
      (mirror of poker-engine.js PokerHand, deck swapped for PF deal)
   ========================================================================= */

// players: clockwise SEAT order, [{ id, name, isBot, stack, aggression?, seat? }]
// opts: { smallBlind, bigBlind, buttonIndex, serverSeed, clientSeed, nonce, rakeBps, rakeCapBb }
function ServerHand(opts) {
  this.sb = opts.smallBlind;
  this.bb = opts.bigBlind;
  // RAKE (spec §5.3): a % of each RAKED pot, capped, NO-FLOP-NO-DROP. Deducted in _finish before
  // the pot is awarded → the only chip-sink (keeps Σstacks_after = Σstacks_before − rake, exact).
  // Defaults to 0 so a hand built without rake params (existing tests) is unraked. The house/creator
  // 50/50 SPLIT + the seated-creator-earns-nothing routing (H6) live at the TABLE layer, which reads
  // this.rake — the engine is table-agnostic and only computes+deducts the total.
  this.rakeBps = Math.max(0, Math.min(500, Math.round(opts.rakeBps || 0))); // house-clamped 0..5% even here (defence in depth)
  this.rakeCapChips = (opts.rakeCapBb != null && opts.rakeCapBb >= 0) ? Math.round(opts.rakeCapBb * this.bb) : Infinity;
  this.rake = 0; // total rake taken this hand (set in _finish)

  // PROVABLY-FAIR deal: commit published before any card is touched.
  this.serverSeed = opts.serverSeed;
  this.commit = PF.commitHash(this.serverSeed);
  this.clientSeed = opts.clientSeed == null ? "" : String(opts.clientSeed);
  this.nonce = opts.nonce == null ? 0 : opts.nonce;

  this.players = opts.players.map((p, i) => ({
    id: p.id, name: p.name || p.id, seat: p.seat != null ? p.seat : i,
    isBot: !!p.isBot, aggression: p.aggression != null ? p.aggression : 0.5,
    stack: p.stack, hole: [],
    folded: false, allIn: false, committedStreet: 0, committedTotal: 0,
    acted: false, mayRaise: true, sittingOut: !!p.sittingOut,
  })).filter((p) => p.stack > 0 && !p.sittingOut);

  this.n = this.players.length;
  this.button = ((opts.buttonIndex || 0) % this.n + this.n) % this.n;
  this.deck = provablyFairDeck(this.serverSeed, this.clientSeed, this.nonce);
  this.di = 0;
  this.board = [];
  this.street = "preflop";
  this.currentBet = 0;
  this.minRaise = this.bb;
  this.toAct = -1;
  this.done = false;
  this.pots = [];
  this.payouts = {};
  this.deltas = {};
  this.shown = {};
  this.winners = [];
  this.log = [];
  // botDecisionNonce: bot RNG draws come from the SAME committed seed so bot
  // choices are also re-derivable. We advance a per-decision sub-nonce.
  this._botSeq = 0;
}

ServerHand.prototype._draw = function () { return this.deck[this.di++]; };
ServerHand.prototype._activeInHand = function () { return this.players.filter((p) => !p.folded); };
ServerHand.prototype._canActPlayers = function () { return this.players.filter((p) => !p.folded && !p.allIn); };

ServerHand.prototype._next = function (idx, pred) {
  for (let k = 1; k <= this.n; k++) {
    const j = (idx + k) % this.n;
    if (pred(this.players[j], j)) return j;
  }
  return -1;
};

ServerHand.prototype.start = function () {
  const heads = this.n === 2;
  const sbIdx = heads ? this.button : this._next(this.button, () => true);
  const bbIdx = this._next(sbIdx, () => true);
  this._postBlind(sbIdx, this.sb);
  this._postBlind(bbIdx, this.bb);
  this.currentBet = this.bb;
  this.minRaise = this.bb;
  for (let r = 0; r < 2; r++) {
    let j = sbIdx;
    for (let c = 0; c < this.n; c++) { this.players[j].hole.push(this._draw()); j = (j + 1) % this.n; }
  }
  this.toAct = heads ? sbIdx : this._next(bbIdx, (p) => !p.folded && !p.allIn);
  this.bbIdx = bbIdx;
  this.log.push("hand dealt (commit " + this.commit.slice(0, 12) + "…)");
  this._maybeAutoResolve();
  return this;
};

ServerHand.prototype._postBlind = function (idx, amt) {
  const p = this.players[idx];
  const put = Math.min(amt, p.stack);
  p.stack -= put; p.committedStreet += put; p.committedTotal += put;
  if (p.stack === 0) p.allIn = true;
};

// What may the given player legally do right now? (server-authoritative gate)
ServerHand.prototype.legalActions = function (id) {
  const p = this.players.find((x) => x.id === id);
  if (!p || this.done || this.players[this.toAct].id !== id) return { yourTurn: false };
  const toCall = Math.max(0, this.currentBet - p.committedStreet);
  const maxRaiseTo = p.committedStreet + p.stack;
  const minRaiseTo = this.currentBet + this.minRaise;
  const canRaise = p.mayRaise && p.stack > toCall && maxRaiseTo > this.currentBet;
  return {
    yourTurn: true, toCall: toCall, canCheck: toCall === 0, canCall: toCall > 0,
    callAmount: Math.min(toCall, p.stack),
    canBet: this.currentBet === 0 && p.stack > 0,
    minBet: Math.min(this.bb, p.stack),
    canRaise: canRaise, minRaiseTo: Math.min(minRaiseTo, maxRaiseTo), maxRaiseTo: maxRaiseTo,
    stack: p.stack, committed: p.committedStreet,
  };
};

// Apply an action for the player whose turn it is. Throws on any illegal intent —
// the SERVER is the only validator; a tampered client cannot bypass these checks.
ServerHand.prototype.act = function (id, type, amount) {
  if (this.done) return this;
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
    const maxTo = p.committedStreet + p.stack;
    if (target > maxTo) target = maxTo;
    const isAllIn = target === maxTo;
    const prevBet = this.currentBet;
    if (target < prevBet && !isAllIn) throw new Error("raise below current bet");
    if (this.currentBet === 0) {
      if (!isAllIn && target < Math.min(this.bb, maxTo)) throw new Error("bet below min");
    } else {
      const minLegal = prevBet + this.minRaise;
      if (!isAllIn && target < minLegal) throw new Error("raise below min");
    }
    const put = target - p.committedStreet;
    this._put(p, put);
    const increment = this.currentBet - prevBet;
    const fullRaise = increment >= this.minRaise && this.currentBet > prevBet;
    if (this.currentBet > prevBet) {
      if (fullRaise) {
        this.minRaise = increment;
        for (const q of this.players) if (!q.folded && !q.allIn && q !== p) { q.acted = false; q.mayRaise = true; }
      } else {
        // short all-in: does NOT reopen raising for players who already acted
        for (const q of this.players) if (!q.folded && !q.allIn && q !== p && q.acted) q.mayRaise = false;
      }
    }
    p.acted = true;
    this.log.push(p.name + (type === "bet" ? " bets " : " raises to ") + this.currentBet + (p.allIn ? " (all-in)" : ""));
  } else {
    throw new Error("unknown action " + type);
  }

  this._advance();
  return this;
};

ServerHand.prototype._put = function (p, amt) {
  amt = Math.min(amt, p.stack);
  p.stack -= amt; p.committedStreet += amt; p.committedTotal += amt;
  if (p.committedStreet > this.currentBet) this.currentBet = p.committedStreet;
  if (p.stack === 0) p.allIn = true;
};

ServerHand.prototype._settled = function (p) {
  if (p.folded || p.allIn) return true;
  return p.acted && p.committedStreet === this.currentBet;
};

ServerHand.prototype._advance = function () {
  if (this._activeInHand().length === 1) { this._finish(); return; }
  const nxt = this._next(this.toAct, (p) => !p.folded && !p.allIn && !this._settled(p));
  if (nxt !== -1) { this.toAct = nxt; this._maybeAutoResolve(); return; }
  this._closeStreet();
};

ServerHand.prototype._maybeAutoResolve = function () {
  if (this._canActPlayers().length <= 1) {
    const owing = this.players.filter((p) => !p.folded && !p.allIn && p.committedStreet < this.currentBet);
    if (owing.length === 0) this._runOut();
  }
};

ServerHand.prototype._closeStreet = function () {
  for (const p of this.players) { p.committedStreet = 0; p.acted = false; p.mayRaise = true; }
  this.currentBet = 0; this.minRaise = this.bb;
  if (this.street === "preflop") { this._deal("flop"); }
  else if (this.street === "flop") { this._deal("turn"); }
  else if (this.street === "turn") { this._deal("river"); }
  else { this._showdown(); return; }
  this.toAct = this._next(this.button, (p) => !p.folded && !p.allIn);
  if (this.toAct === -1) { this._runOut(); return; }
  this.log.push("— " + this.street + " —");
  this._maybeAutoResolve();
};

ServerHand.prototype._deal = function (street) {
  this.di++; // burn — keeps the deal indexing identical to a live shoe
  if (street === "flop") { this.board.push(this._draw(), this._draw(), this._draw()); }
  else { this.board.push(this._draw()); }
  this.street = street;
};

ServerHand.prototype._runOut = function () {
  while (this.board.length < 5 && this._activeInHand().length > 1) {
    if (this.street === "preflop") this._deal("flop");
    else if (this.street === "flop") this._deal("turn");
    else if (this.street === "turn") this._deal("river");
    else break;
  }
  if (this._activeInHand().length === 1) this._finish();
  else this._showdown();
};

ServerHand.prototype._showdown = function () {
  this.street = "showdown";
  const live = this._activeInHand();
  for (const p of live) this.shown[p.id] = { hole: p.hole.slice(), cat: categoryName(p.hole.concat(this.board)) };
  this._finish();
};

ServerHand.prototype._finish = function () {
  const pots = buildPots(this.players.map((p) => ({ id: p.id, committedTotal: p.committedTotal, folded: p.folded })));
  this.pots = pots;
  const startStack = {};
  for (const p of this.players) { this.payouts[p.id] = 0; startStack[p.id] = p.committedTotal + p.stack; }

  // RAKE (spec §5.3): NO-FLOP-NO-DROP — only a hand that saw a flop is raked. Computed on the TOTAL
  // pot, capped, then deducted off the top of the pots (main pot first) BEFORE any award. Rake is the
  // ONLY chip that leaves the pots un-awarded → the sink that makes Σstacks_after = Σstacks_before − rake.
  const flopSeen = this.board.length >= 3;
  let totalPot = 0; for (const pot of pots) totalPot += pot.amount;
  this.rake = (flopSeen && this.rakeBps > 0)
    ? Math.min(Math.round(totalPot * this.rakeBps / 10000), this.rakeCapChips)
    : 0;
  if (this.rake > totalPot) this.rake = totalPot; // never rake more than the pot (cap sanity)
  let rakeLeft = this.rake;
  for (const pot of pots) { if (rakeLeft <= 0) break; const take = Math.min(rakeLeft, pot.amount); pot.amount -= take; rakeLeft -= take; }

  const live = this._activeInHand();
  const scoreById = {};
  if (live.length === 1) {
    scoreById[live[0].id] = 1; // uncontested — no cards shown
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
  for (const p of this.players) { p.stack += this.payouts[p.id]; this.deltas[p.id] = p.stack - startStack[p.id]; }
  this.done = true;
  this.log.push("hand complete — reveal " + this.serverSeed.slice(0, 12) + "…");
};

ServerHand.prototype._clockwiseFromButton = function (ids) {
  const set = new Set(ids);
  const out = [];
  for (let k = 1; k <= this.n; k++) {
    const j = (this.button + k) % this.n;
    if (set.has(this.players[j].id)) out.push(this.players[j].id);
  }
  return out;
};

/* ---- THE PER-CLIENT MASKED SNAPSHOT ---------------------------------------
   This is the security boundary. snapshotFor(viewerId) reveals ONLY:
     • the board (public),
     • the viewer's OWN hole cards (or, after the hand is over, every player who
       reached showdown — exactly what is shown face-up at a real table),
     • public state (stacks, commitments, who's to act, pots, log).
   It NEVER contains:
     • another live player's hole cards,
     • the undealt deck / stub (this.deck is not exposed at all).
   The serverSeed is included ONLY once the hand is done (reveal), alongside the
   commit, so the client can re-derive + verify the entire deal.
---------------------------------------------------------------------------- */
ServerHand.prototype.snapshotFor = function (viewerId) {
  const revealHand = this.done; // at hand end, showdown players reveal
  return {
    street: this.street,
    board: this.board.slice(),
    currentBet: this.currentBet,
    minRaise: this.minRaise,
    pot: this.players.reduce((s, p) => s + p.committedTotal, 0),
    button: this.button,
    toAct: this.toAct,
    toActId: (this.toAct >= 0 && !this.done) ? this.players[this.toAct].id : null,
    done: this.done,
    pots: this.pots,
    winners: this.winners || [],
    deltas: this.done ? this.deltas : {},
    shown: this.done ? this.shown : {},
    commit: this.commit,
    // REVEAL: only after the hand is over. While live, the secret seed is withheld
    // so the deck cannot be re-derived to peek opponents' holes or the stub.
    serverSeed: this.done ? this.serverSeed : null,
    clientSeed: this.clientSeed,
    nonce: this.nonce,
    players: this.players.map((p) => {
      let hole = null;
      if (revealHand && this.shown[p.id]) hole = this.shown[p.id].hole; // shown at showdown
      else if (viewerId != null && p.id === viewerId) hole = p.hole;     // your own cards
      // else: HIDDEN — another player's live holes are never serialized.
      return {
        id: p.id, name: p.name, seat: p.seat, isBot: p.isBot, stack: p.stack,
        committedStreet: p.committedStreet, committedTotal: p.committedTotal,
        folded: p.folded, allIn: p.allIn,
        hole: hole, hasCards: p.hole.length > 0,
        cat: (revealHand && this.shown[p.id]) ? this.shown[p.id].cat : null,
      };
    }),
    log: this.log.slice(-10),
  };
};

/* =========================================================================
   6. TABLE — thin orchestration over a hand (sit / startHand / act / advance)
   ========================================================================= */

function createTable(opts) {
  opts = opts || {};
  return {
    smallBlind: opts.smallBlind || 1,
    bigBlind: opts.bigBlind || 2,
    maxSeats: opts.seats || 9,
    seats: [],          // [{ id, name, isBot, stack, aggression }]
    button: opts.buttonIndex != null ? opts.buttonIndex : 0,
    hand: null,         // current ServerHand or null between hands
    nonce: 0,           // increments per hand → independent verifiable rounds
    clientSeed: opts.clientSeed || "",
    rakeBps: opts.rakeBps || 0,                                   // spec §5.3 — 0 = unraked (demo/tests); house-clamped 100..500 at the RoomManager layer
    rakeCapBb: opts.rakeCapBb != null ? opts.rakeCapBb : Infinity, // cap in big blinds (default: uncapped when unset)
  };
}

// Seat a player (human or bot). Returns the seat record.
function sit(table, player) {
  if (table.seats.length >= table.maxSeats) throw new Error("table full");
  if (table.seats.some((s) => s.id === player.id)) throw new Error("already seated");
  const seat = {
    id: player.id,
    name: player.name || player.id,
    isBot: !!player.isBot,
    stack: player.stack != null ? player.stack : 1000,
    aggression: player.aggression != null ? player.aggression : 0.5,
    clientSeed: player.clientSeed == null ? "" : String(player.clientSeed), // v5 #35: carry the player's PF seed (sit() dropped it → startHand always got "")
  };
  table.seats.push(seat);
  return seat;
}

// Begin a hand: fresh committed PF seed, deal, post blinds. Returns the snapshot
// payload's commit so the lobby/clients can publish it BEFORE play.
function startHand(table, opts) {
  opts = opts || {};
  const dealt = table.seats.filter((s) => s.stack > 0);
  if (dealt.length < 2) throw new Error("need 2+ players with chips");
  const round = PF.newRound(); // { serverSeed, commit }
  table.nonce++;
  const buttonIndex = opts.buttonIndex != null ? opts.buttonIndex : table.button;
  // combine each seated player's optional client seed so the order/commit is fixed
  const clientSeed = opts.clientSeed != null ? opts.clientSeed
    : (table.clientSeed || dealt.map((s) => s.clientSeed || "").join("|"));
  const hand = new ServerHand({
    smallBlind: table.smallBlind, bigBlind: table.bigBlind,
    buttonIndex: buttonIndex, players: dealt,
    serverSeed: round.serverSeed, clientSeed: clientSeed, nonce: table.nonce,
    rakeBps: table.rakeBps, rakeCapBb: table.rakeCapBb, // spec §5.3 — thread the table's raked-pot config into the hand
  });
  hand.start();
  table.hand = hand;
  table.commit = hand.commit;
  return hand;
}

// A human (or any external) action, fully validated server-side.
function act(table, playerId, type, amount) {
  if (!table.hand) throw new Error("no hand in progress");
  return table.hand.act(playerId, type, amount);
}

// Drive the hand forward: while the player to act is a BOT, decide + apply using
// the masked snapshot for THAT bot (so the bot only sees its own cards). Returns
// the number of bot actions taken. Bot RNG is seeded off the committed PF stream
// so even bot decisions are re-derivable from the reveal.
function advance(table) {
  const hand = table.hand;
  if (!hand) return 0;
  let steps = 0, guard = 0;
  while (!hand.done && guard++ < 1000) {
    const toActId = (hand.toAct >= 0) ? hand.players[hand.toAct].id : null;
    if (toActId == null) break;
    const seat = hand.players[hand.toAct];
    if (!seat.isBot) break; // a human owes the next action
    const snap = hand.snapshotFor(toActId);
    const legal = hand.legalActions(toActId);
    if (!legal.yourTurn) break;
    // Deterministic, re-derivable bot RNG: a dedicated PF float stream keyed by
    // the committed seed + this bot's decision index (own sub-nonce space).
    const idx = hand._botSeq++;
    let fcursor = 0;
    const rng = () => PF.floats(hand.serverSeed, "bot:" + toActId, (hand.nonce * 100000) + idx, ++fcursor)[fcursor - 1];
    const decision = botDecide(snap, legal, { aggression: seat.aggression, rng: rng });
    hand.act(toActId, decision.type, decision.amount);
    steps++;
  }
  return steps;
}

// Convenience: the masked snapshot for a viewer (null = pure spectator view).
function snapshotFor(table, viewerId) {
  if (!table.hand) return null;
  return table.hand.snapshotFor(viewerId);
}

// Verify a revealed hand: recompute the commit and re-derive the exact deck.
function verifyHand(commit, serverSeed, clientSeed, nonce) {
  const ok = PF.verify(commit, serverSeed);
  const deck = ok ? provablyFairDeck(serverSeed, clientSeed == null ? "" : String(clientSeed), nonce == null ? 0 : nonce) : null;
  return { ok: ok, deck: deck };
}

module.exports = {
  // table API
  createTable, sit, startHand, act, advance, snapshotFor, verifyHand,
  // core (exported for tests / server reuse)
  ServerHand, provablyFairDeck, makeDeck,
  score5, evaluate, categoryName, combinations, buildPots,
  botDecide, cardLabel, rankLabel, CAT,
};

/* ====================================================================
   CLI SELF-TEST:  node server/poker-server.js
   ==================================================================== */
if (require.main === module) {
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };
  const C = (rank, suit) => ({ rank: rank, suit: suit }); // suit 0..3

  /* ---- 1. hand evaluator battery (vs poker-engine.js semantics) ---- */
  const sf = score5([C(10, 0), C(11, 0), C(12, 0), C(13, 0), C(14, 0)]); // royal straight flush
  const quads = score5([C(9, 0), C(9, 1), C(9, 2), C(9, 3), C(2, 0)]);
  const boat = score5([C(8, 0), C(8, 1), C(8, 2), C(3, 0), C(3, 1)]);
  const flush = score5([C(2, 1), C(5, 1), C(9, 1), C(11, 1), C(13, 1)]);
  const wheel = score5([C(14, 0), C(2, 1), C(3, 2), C(4, 3), C(5, 0)]); // A-2-3-4-5 straight
  const twoPair = score5([C(10, 0), C(10, 1), C(4, 2), C(4, 3), C(13, 0)]);
  eq("ranking: SF > quads > boat > flush", sf > quads && quads > boat && boat > flush);
  eq("wheel is a 5-high straight (beats two pair)", wheel > twoPair);
  eq("flush beats the wheel straight", flush > wheel);

  // best-5-of-7
  const seven = [C(14, 0), C(14, 1), C(14, 2), C(13, 0), C(13, 1), C(2, 2), C(3, 3)];
  eq("evaluate 7 finds aces-full-of-kings", categoryName(seven) === "Full house");

  /* ---- 2. deterministic, re-derivable deal ---- */
  const round = PF.newRound();
  const seedDeck = provablyFairDeck(round.serverSeed, "tableX", 1);
  const seedDeck2 = provablyFairDeck(round.serverSeed, "tableX", 1);
  eq("deck deterministic for (seed,client,nonce)", JSON.stringify(seedDeck) === JSON.stringify(seedDeck2));
  eq("deck differs for a different nonce", JSON.stringify(seedDeck) !== JSON.stringify(provablyFairDeck(round.serverSeed, "tableX", 2)));
  eq("deck is a full 52-card permutation", (() => {
    if (seedDeck.length !== 52) return false;
    const set = new Set(seedDeck.map((c) => c.rank + "-" + c.suit));
    return set.size === 52;
  })());
  const v = verifyHand(round.commit, round.serverSeed, "tableX", 1);
  eq("verifyHand re-derives the exact deck from the reveal", v.ok && JSON.stringify(v.deck) === JSON.stringify(seedDeck));
  eq("verifyHand rejects a tampered seed", !verifyHand(round.commit, round.serverSeed + "ff", "tableX", 1).ok);

  /* ---- 3. SNAPSHOT MASKING — the security property ---- */
  {
    const t = createTable({ smallBlind: 1, bigBlind: 2, seats: 6 });
    sit(t, { id: "you", name: "You", isBot: false, stack: 200 });
    sit(t, { id: "b1", name: "Bot1", isBot: true, stack: 200, aggression: 0.6 });
    sit(t, { id: "b2", name: "Bot2", isBot: true, stack: 200, aggression: 0.4 });
    startHand(t, { buttonIndex: 0 });

    const snap = snapshotFor(t, "you");
    const me = snap.players.find((p) => p.id === "you");
    const others = snap.players.filter((p) => p.id !== "you");
    eq("snapshot reveals the viewer's own hole cards", !!me.hole && me.hole.length === 2);
    eq("snapshot hides EVERY other player's hole cards", others.every((p) => p.hole === null && p.hasCards));
    // the undealt stub must never be serialized anywhere in the snapshot
    const json = JSON.stringify(snap);
    eq("snapshot never contains the deck/stub", !("deck" in snap) && json.indexOf("\"di\"") === -1);
    // while the hand is live, the secret seed is withheld (can't re-derive opp holes)
    eq("serverSeed withheld until hand end", snap.serverSeed === null && typeof snap.commit === "string");
    // a spectator (null viewer) sees no live holes at all
    const spec = snapshotFor(t, null);
    eq("spectator sees zero live hole cards", spec.players.every((p) => p.hole === null));
  }

  /* ---- 4. a full multi-player hand plays to showdown ---- */
  {
    const seeds = [12345, 777, 999, 4242, 88, 1, 2, 3];
    let reachedShowdownOrDone = 0, conserved = 0, trials = 40;
    for (let i = 0; i < trials; i++) {
      const t = createTable({ smallBlind: 5, bigBlind: 10, seats: 6 });
      sit(t, { id: "human", name: "Human", isBot: true, stack: 1000, aggression: 0.5 }); // bot-driven for the auto-play test
      sit(t, { id: "b1", name: "Bot1", isBot: true, stack: 1000, aggression: 0.7 });
      sit(t, { id: "b2", name: "Bot2", isBot: true, stack: 1000, aggression: 0.3 });
      sit(t, { id: "b3", name: "Bot3", isBot: true, stack: 1000, aggression: 0.55 });
      const before = t.seats.reduce((a, s) => a + s.stack, 0);
      startHand(t, { buttonIndex: i % 4 });
      advance(t); // all bots → runs to completion
      const h = t.hand;
      if (h.done) reachedShowdownOrDone++;
      // chip conservation: every chip in == every chip out (stacks after payouts)
      const after = h.players.reduce((a, p) => a + p.stack, 0);
      if (after === before) conserved++;
    }
    eq("all " + trials + " auto-played hands reach completion", reachedShowdownOrDone === trials);
    eq("chips are conserved in every hand (no chips created/destroyed)", conserved === trials);
  }

  /* ---- 5. determinism end-to-end: same seed → identical hand ---- */
  {
    function playFixed() {
      const t = createTable({ smallBlind: 5, bigBlind: 10, seats: 4 });
      sit(t, { id: "a", isBot: true, stack: 500, aggression: 0.5 });
      sit(t, { id: "b", isBot: true, stack: 500, aggression: 0.5 });
      sit(t, { id: "c", isBot: true, stack: 500, aggression: 0.5 });
      // inject a fixed seed by overriding nonce + clientSeed via startHand opts,
      // but PF.newRound() is random — so build the hand directly with a known seed.
      const SEED = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const hand = new ServerHand({
        smallBlind: 5, bigBlind: 10, buttonIndex: 0, players: t.seats,
        serverSeed: SEED, clientSeed: "fixed", nonce: 1,
      });
      hand.start();
      t.hand = hand; t.nonce = 1;
      advance(t);
      return hand;
    }
    const h1 = playFixed(), h2 = playFixed();
    const sig = (h) => JSON.stringify({
      board: h.board, deltas: h.deltas, winners: h.winners,
      shown: Object.keys(h.shown).sort().map((k) => [k, h.shown[k].hole]),
    });
    eq("same fixed seed → byte-identical hand result (deal+bots+showdown)", sig(h1) === sig(h2));
  }

  /* ---- 6. illegal action rejection (server is the only validator) ---- */
  {
    const t = createTable({ smallBlind: 1, bigBlind: 2, seats: 3 });
    sit(t, { id: "x", isBot: false, stack: 100 });
    sit(t, { id: "y", isBot: false, stack: 100 });
    sit(t, { id: "z", isBot: false, stack: 100 });
    startHand(t, { buttonIndex: 0 });
    const wrong = t.hand.players.find((p, i) => i !== t.hand.toAct).id;
    let threw = false;
    try { act(t, wrong, "call"); } catch (e) { threw = true; }
    eq("acting out of turn is rejected", threw);
    const toActId = t.hand.players[t.hand.toAct].id;
    let threw2 = false;
    try { act(t, toActId, "check"); } catch (e) { threw2 = true; } // facing the BB → can't check preflop UTG
    eq("illegal check facing a bet is rejected", threw2);
  }

  /* ---- 7. RAKE (spec §5.3): no-flop-no-drop, %-with-cap, exact chip-sink conservation ---- */
  {
    const RAKE_BPS = 500, CAP_BB = 3, BB = 10, CAP = CAP_BB * BB; // 5%, 3bb cap = 30 chips
    // drive every to-act seat to the cheapest legal continue (check, else call) → check/limp down
    const checkDown = (t) => { let g = 0; const h = t.hand; while (!h.done && g++ < 200) { const p = h.players[h.toAct]; const toCall = h.currentBet - p.committedStreet; act(t, p.id, toCall > 0 ? "call" : "check"); } };

    // (a) limped, checked-down heads-up pot = 20 chips, sees a flop → rake = min(round(20·5%),30) = 1
    {
      const t = createTable({ smallBlind: 5, bigBlind: BB, seats: 2, rakeBps: RAKE_BPS, rakeCapBb: CAP_BB });
      sit(t, { id: "a", isBot: false, stack: 500 }); sit(t, { id: "b", isBot: false, stack: 500 });
      const before = t.seats.reduce((a, s) => a + s.stack, 0);
      startHand(t, { buttonIndex: 0 }); checkDown(t);
      const h = t.hand, after = h.players.reduce((a, p) => a + p.stack, 0);
      eq("rake: limped pot sees a flop and is raked exactly 1 (5% of 20)", h.board.length >= 3 && h.rake === 1);
      eq("rake: chips conserved with rake as the only sink (limped)", after === before - h.rake);
    }
    // (b) all-in preflop heads-up → board RUNS OUT (flop seen) → pot 2000 → rake = 30 (CAP binds)
    {
      const t = createTable({ smallBlind: 5, bigBlind: BB, seats: 2, rakeBps: RAKE_BPS, rakeCapBb: CAP_BB });
      sit(t, { id: "a", isBot: false, stack: 1000 }); sit(t, { id: "b", isBot: false, stack: 1000 });
      const before = t.seats.reduce((a, s) => a + s.stack, 0);
      startHand(t, { buttonIndex: 0 });
      const h = t.hand;
      act(t, h.players[h.toAct].id, "allin");        // first to act shoves 1000
      if (!h.done) act(t, h.players[h.toAct].id, "call"); // the other calls all-in → run-out + showdown
      const after = h.players.reduce((a, p) => a + p.stack, 0);
      eq("rake: all-in run-out is raked at the 3bb CAP (30, not 5%·2000=100)", h.board.length >= 3 && h.rake === CAP);
      eq("rake: chips conserved with rake as the only sink (all-in cap)", after === before - h.rake);
    }
    // (c) NO-FLOP-NO-DROP: everyone folds to the BB preflop → no flop → ZERO rake
    {
      const t = createTable({ smallBlind: 5, bigBlind: BB, seats: 3, rakeBps: RAKE_BPS, rakeCapBb: CAP_BB });
      sit(t, { id: "a", isBot: false, stack: 500 }); sit(t, { id: "b", isBot: false, stack: 500 }); sit(t, { id: "c", isBot: false, stack: 500 });
      const before = t.seats.reduce((a, s) => a + s.stack, 0);
      startHand(t, { buttonIndex: 0 });
      const h = t.hand; let g = 0;
      while (!h.done && g++ < 20) act(t, h.players[h.toAct].id, "fold");
      const after = h.players.reduce((a, p) => a + p.stack, 0);
      eq("rake: no-flop-no-drop — a preflop fold-around pays ZERO rake", h.done && h.board.length < 3 && h.rake === 0);
      eq("rake: no-flop hand fully conserves chips (nothing skimmed)", after === before);
    }
    // (d) SWEEP: 60 bot hands — rake is ALWAYS exactly min(5%·grossPot, cap) with no-flop-no-drop, and the only sink
    {
      let trials = 60, conserved = 0, formula = 0;
      for (let i = 0; i < trials; i++) {
        const t = createTable({ smallBlind: 5, bigBlind: BB, seats: 6, rakeBps: RAKE_BPS, rakeCapBb: CAP_BB });
        for (let s = 0; s < 4; s++) sit(t, { id: "p" + s, isBot: true, stack: 1000, aggression: 0.3 + s * 0.15 });
        const before = t.seats.reduce((a, s) => a + s.stack, 0);
        startHand(t, { buttonIndex: i % 4 }); advance(t);
        const h = t.hand, after = h.players.reduce((a, p) => a + p.stack, 0);
        const grossPot = h.players.reduce((a, p) => a + p.committedTotal, 0);
        const expected = (h.board.length >= 3 && grossPot > 0) ? Math.min(Math.round(grossPot * RAKE_BPS / 10000), CAP) : 0;
        if (after === before - h.rake) conserved++;
        if (h.rake === expected) formula++;
      }
      eq("rake sweep: chips conserved with rake as the only sink in all 60 hands", conserved === trials);
      eq("rake sweep: rake == min(5%·pot, 3bb) with no-flop-no-drop in all 60 hands", formula === trials);
    }
  }

  console.log(ok ? "\nSELF-TEST OK — server-authoritative poker core is deterministic, verifiable, and leak-free (+ rake: no-flop-no-drop, %-with-cap, exact chip-sink)." : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
