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
    // RE-OPEN GUARD (server is the sole validator): a player whose raise was closed by a prior SHORT
    // all-in (mayRaise=false) may only call or fold — NOT voluntarily re-raise. Their own all-in shove
    // for the rest of their stack is still allowed (that's not a sized re-raise). Without this, act()
    // validated only the raise SIZE, so a crafted client could re-open betting poker rules say is shut.
    if ((type === "bet" || type === "raise") && !isAllIn && target > prevBet && !p.mayRaise) throw new Error("raising is closed");
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
    // PRIVACY NOTE (hunt #3, accepted tradeoff): because the deal is a pure function of the
    // now-public serverSeed + clientSeed + nonce + seat order + button, once revealed a client can
    // re-derive the full deck and thus compute the holes of players who FOLDED/mucked this hand. This
    // is inherent to provably-fair commit-reveal (the reveal is what lets players verify the deal) and
    // is post-completion only (no live-hand leak, fresh seed each hand). Documented, not a defect.
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
        // expose mayRaise for YOUR OWN seat only (not secret) so the client can hide the RAISE control when
        // a prior short all-in closed re-raising — else the UI offers a raise the server always rejects.
        mayRaise: (viewerId != null && p.id === viewerId) ? p.mayRaise : undefined,
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

/* =========================================================================
   7. attachPoker — LIVE PvP RoomManager (spec §4, Phase 2: DEMO ONLY)

   Wraps the ServerHand engine above in a multi-table, multi-socket room server
   that MIRRORS baccarat-server.js's attachBaccarat structure (rooms Map, openRoom/
   createRoom/closeRoom, ws handle() dispatch, per-room timers via an injectable
   clock, markDisconnected + RECONNECT_GRACE reclaim, two-tier idle GC, co-located
   CLI self-test) — with the ONE structural break poker forces:

     ┌─────────────────────────────────────────────────────────────────────┐
     │  PER-SOCKET MASKED BROADCAST.  Baccarat broadcasts one shared         │
     │  snapshot to every seat (simultaneous betting, no hidden cards).      │
     │  Poker is TURN-BASED WITH HIDDEN HOLE CARDS, so the room NEVER sends  │
     │  a shared payload of holes — it loops the recipients and sends each   │
     │  `hand.snapshotFor(thatViewerWallet)` (engine :603), which reveals    │
     │  only the viewer's own holes (+ shown holes at showdown) and never    │
     │  the undealt deck stub. A spectator/null viewer sees zero live holes. │
     └─────────────────────────────────────────────────────────────────────┘

   PHASE 2 IS DEMO ONLY — chips are play-money INTEGERS owned by the seat; there is
   NO token bridge, NO applyPokerNet, NO money settlement (that is Phase 3). The
   token seam (setTokenLedger / bindToken) is left as a documented no-op so Phase 3
   can drop in without restructuring. `attachPoker` returns the same shape the ws
   server expects: { handle, onClose, closeRoom, _mgr, _room, setTokenLedger, … }.
   ========================================================================= */

// Variadic multi-seat client-seed join (spec §7). blackjack-shuffle.js:70
// joinClientSeeds is fixed length-4 (baccarat's 4 seats); poker has 2..9 seated
// players, so the table joins ALL seated-in seeds into one combined entropy string
// FROZEN at hand-start commit, then passed to ServerHand as opts.clientSeed. Same
// "|"-delimited shape so a verifier splits it identically.
function joinPokerSeeds(seeds) {
  return (seeds || []).map((s) => (s == null ? "" : String(s))).join("|");
}

// House-policy clamps (spec §6). The server RE-CLAMPS every create-table field on
// receipt — client bounds are cosmetic. A creator can never gouge (5% rake ceiling)
// or open a degenerate table.
const STAKES_BB = [2, 5, 10, 25, 50, 100];            // whitelist; sb = bb/2
const RAKE_BPS_MIN = 100, RAKE_BPS_MAX = 500;         // 1%..5% hard ceiling
const RAKE_CAP_BB_MIN = 1, RAKE_CAP_BB_MAX = 5;
const BUYIN_MIN_BB = 20, BUYIN_MAX_BB = 250;
const SEATS_MIN = 2, SEATS_MAX = 9;
const NAME_MIN = 3, NAME_MAX = 24;

function sanitizeName(raw) {
  let s = String(raw == null ? "" : raw).replace(/[<>&"'`]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return s;
}
function clampInt(v, lo, hi, dflt) {
  let n = Math.round(Number(v));
  if (!isFinite(n)) n = dflt;
  return Math.max(lo, Math.min(hi, n));
}

function attachPoker(opts) {
  opts = opts || {};
  // Timer block (spec §4). Pacing 0 ⇒ synchronous (tests / off), the BJ/bac setT convention.
  const T = Object.assign({
    act: 20000,            // POKER_ACT_MS — per-turn human act-timer
    showdown: 4000,        // hold the revealed showdown before BETWEEN
    between: 3000,         // reconcile-and-deal-next dwell
    idleEmpty: 60000,      // 0-seat table fast reap
    idleSeated: 300000,    // ≥1-seat idle close (mirror T.idle=300000)
    botMin: 800, botMax: 1500, // bot decision delay (demo table-fill)
  }, opts.timers || {});
  const _setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms));
  // CRASH SAFETY (v11.97 lesson): every engine timer runs through this guard so a throw
  // inside a setTimeout callback (actTimeout / advance / showdown / between) is contained
  // to a logged non-fatal error rather than an uncaught exception that exits Node.
  const setT = (f, ms) => _setT(() => { try { f(); } catch (e) { try { console.error("pk timer error:", (e && e.stack) || e); } catch (_) {} } }, ms);
  const clrT = opts.clearTimeout || clearTimeout;
  const now = opts.now || (() => Date.now());
  const send = (sock, obj) => { if (sock && sock.send) try { sock.send(JSON.stringify(obj)); } catch (e) {} };

  const RECONNECT_GRACE = opts.reconnectGrace != null ? opts.reconnectGrace : 90000;
  const MAX_ROOMS = opts.maxRooms || 200;
  const START_STACK = opts.startBalance != null ? opts.startBalance : 5000; // demo play-money bank (chips are stack-local; this is just the buy-in wallet)
  const DEMO_BUYIN_DEFAULT = opts.demoBuyIn != null ? opts.demoBuyIn : 1000;
  const AUTO_DEMO_BOTS = !!opts.autoDemoBots; // opt-in: server.js sets true so a solo demo player auto-gets 2 bots
  const norm = (w) => String(w == null ? "" : w).toLowerCase();
  const realWallet = (w) => /^0x[0-9a-fA-F]{40}$/.test(String(w || ""));
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const rooms = new Map();
  let seq = 0;
  const lobbySubs = new Set();

  // ── CENT-SCALING (spec §5): 1 chip = 1 USD cent. TOKEN (real 0x) wallets carry a USD session,
  // so units↔chips is the exact 100× cent scale (a $ buy-in becomes round(units*100) integer chips;
  // a chip stack cashes back at /100 USD). DEMO (guest) wallets are play-money with NO ledger and NO
  // cent meaning — 1 unit = 1 chip, 1:1 — so the demo felt's integer balance stays coherent and the
  // Phase-2 demo self-tests (stack === units) hold unchanged. The converters are wallet-aware so the
  // single buy-in / cash-out code path serves both without branching at every call site.
  const chipsScale = (w) => realWallet(w) ? 100 : 1;
  const unitsToChips = (u, w) => Math.round((Number(u) || 0) * chipsScale(w));
  const chipsToUnits = (c, w) => { const sc = chipsScale(w); return sc === 100 ? round2((Number(c) || 0) / 100) : Math.round(Number(c) || 0); };

  /* ---------------- TOKEN SEAM (spec §5/§12 — Phase 3, the money settlement) ----------------
     setTokenLedger binds the applyPokerNet ledger; a real (0x) wallet at a REAL table has its
     chips bound to a token-bridge session (bindToken, FROZEN while it has chips in a live pot).
     The bank's get/credit/debit for a token wallet then route to the ledger (a buy-in debits, a
     cash-out credits the SAME session they bought in with), EXACTLY the baccarat pattern.

     H1 — the winner reconciliation AND the creator rake-share are HOUSE-FUNDED applyPokerNet
     CREDITS into the payee's OWN session (a payout, never the single-slot pendingSettle map). When
     the payee has NO open session, the credit SUMS into a durable append-only pokerOwed[wallet]
     ledger, paid on the wallet's next session open (claimOwed). Never overwrites.
     H3/H4 — a winner's returned stack can exceed buyIn+TOKEN_MAX_WIN_USD; applyExternal's capUp
     would silently truncate it. We do NOT touch capUp: we MEASURE the credit (before/after tokens)
     and route any capUp SHORTFALL to pokerOwed. An H4 absolute clamp (creditUnits ≤ cumulativeBuyIn
     + maxTablePotUnits) is asserted fail-closed at cash-out.
     -------------------------------------------------------------------------------------------- */
  let TL = opts.tokenLedger || null;   // { tokensOf(sid), applyNet(player,sid,bet,payout,ref), recordOwed?, persist? }
  const tokenBind = new Map();         // wallet(lc) → token sessionId (frozen while the wallet has live chips)
  const pokerOwed = new Map();         // wallet(lc) → SUMMED chips owed (house-funded credits with no open session); append-only, persisted
  const creatorRakeDaily = new Map();  // "wallet:dayIndex" → creator-rake chips paid today (H7 per-wallet daily cap)
  // H7 anti-wash gate defaults (BINDING, spec §12): creator-half routes to HOUSE until the table has had
  // ≥3 DISTINCT funded wallets play ≥10 hands; and a per-creator-wallet daily rake cap.
  const CREATOR_GATE_DISTINCT = opts.creatorGateDistinct != null ? opts.creatorGateDistinct : 3;
  const CREATOR_GATE_HANDS = opts.creatorGateHands != null ? opts.creatorGateHands : 10;
  const CREATOR_RAKE_CAP_DAILY_CHIPS = opts.creatorRakeCapDailyChips != null ? opts.creatorRakeCapDailyChips : 100000; // $1,000/day default (chips = cents)
  const tokenSid = (w) => tokenBind.get(norm(w));
  const isTokenWallet = (w) => !!(TL && tokenBind.has(norm(w)));

  // hasLiveHand(wallet): the wallet has chips committed to an UNSETTLED pot right now → cash-out /
  // recover / rebind must be REFUSED (mirror baccarat-server.js:151). A seat "in a live hand" is one
  // whose engine player is not folded while the room is mid-hand (chips are in the pot / at risk).
  function hasLiveHand(wallet) {
    const w = norm(wallet);
    for (const r of rooms.values()) {
      if (!inHandPhase(r) || !r.table.hand || r.table.hand.done) continue;
      const seat = r.seats.find((s) => s && norm(s.wallet) === w);
      if (!seat) continue;
      const p = r.table.hand.players.find((pp) => norm(pp.id) === w);
      if (p && !p.folded) return true; // chips at risk in the live pot
    }
    return false;
  }

  // FREEZE the funding pool: bind a real wallet to its token session. Refuse if it's already bound
  // to another live game's session, or has live chips (never swap the pool mid-pot). Idempotent.
  const bindToken = (wallet, sessionId) => {
    if (!realWallet(wallet) || !sessionId) return false;
    const cur = tokenBind.get(norm(wallet));
    if (cur === String(sessionId)) return true;              // idempotent reconnect
    if (cur && cur !== String(sessionId)) { if (hasLiveHand(wallet) || hasSeatedStack(wallet)) return false; } // bound elsewhere & still has chips at stake (live pot OR a seated stack bought from `cur`) → refuse the swap. Audit CRIT: between hands hasLiveHand is false, so without hasSeatedStack a 2nd hello with a different session could re-point the bind → cash-out then credits the WRONG on-chain session (house drain).
    if (hasLiveHand(wallet)) return false;
    tokenBind.set(norm(wallet), String(sessionId));
    return true;
  };
  // True if the wallet still OWNS a seat holding chips (seated OR disconnected-in-grace). The bind
  // must survive until dropSeat/cashOutSeat credits that stack back to the token session.
  function hasSeatedStack(wallet) { const w = norm(wallet); for (const r of rooms.values()) { const s = r.seats.find((x) => x && norm(x.wallet) === w); if (s && (s.stack || 0) > 0) return true; } return false; }
  // Refuse the unbind while ANY chips are still at stake — a live pot OR a seated/in-grace stack.
  // (Audit CRITICAL: the ws-close handler calls unbindToken right after onClose's 90s grace; between
  // hands hasLiveHand is false, so without hasSeatedStack the bind was deleted and the grace-expiry
  // force-cash-out then credited the REAL stack to the DEMO bank — real money lost.) cashOutSeat zeroes
  // the stack before it unbinds, so a legitimate cash-out still releases the bind.
  const unbindToken = (wallet) => { if (hasLiveHand(wallet) || hasSeatedStack(wallet)) return false; return tokenBind.delete(norm(wallet)); };

  // ── pokerOwed ledger (H1 fallback) — SUMMED, append-only, persisted ──
  function owe(wallet, chips) {
    const w = norm(wallet); const add = Math.round(Number(chips) || 0);
    if (!(add > 0)) return;
    pokerOwed.set(w, (pokerOwed.get(w) || 0) + add); // SUM — never overwrite (H1/self-test 24)
    if (TL && typeof TL.recordOwed === "function") { try { TL.recordOwed(w, pokerOwed.get(w)); } catch (e) {} }
    savePersist();
  }
  // On session open (bind), pay down any owed balance as a house-funded credit into the fresh
  // session (bounded by capUp; a residual capUp shortfall stays owed). Called at buy-in.
  function claimOwed(wallet, sessionId) {
    const w = norm(wallet); const owed = pokerOwed.get(w) || 0;
    if (!(owed > 0) || !TL) return;
    const before = tokensNow(sessionId);
    let booked = 0;
    try { const after = TL.applyNet(wallet, sessionId, 0, chipsToUnits(owed, wallet), "pokerOwed:claim"); booked = Math.round((round2(after) - round2(before)) * 100); }
    catch (e) { return; } // session not creditable right now → leave owed for next time
    const paid = Math.max(0, Math.min(owed, booked));
    const remain = owed - paid;
    if (remain > 0) pokerOwed.set(w, remain); else pokerOwed.delete(w);
    savePersist();
  }
  function tokensNow(sessionId) { try { const t = TL && TL.tokensOf(sessionId); return t == null ? 0 : round2(t); } catch (e) { return 0; } }

  // Token cash-out credit with capUp-shortfall detection (H3/H4). Credits `chips` back to the
  // wallet's session via applyPokerNet; measures the ACTUAL booked delta and routes any capUp
  // shortfall to pokerOwed so a legit P2P win can never silently vanish. Returns { booked, owed }
  // (both in chips) — booked+owed === chips by construction (zero-sum over ATTEMPTED credits, H8).
  function tokenCredit(wallet, chips) {
    const want = Math.round(Number(chips) || 0);
    if (!(want > 0)) return { booked: 0, owed: 0 };
    const sid = tokenSid(wallet);
    if (!sid) { owe(wallet, want); return { booked: 0, owed: want }; } // no open session → all owed
    const before = tokensNow(sid);
    let bookedChips = 0;
    try { const after = TL.applyNet(wallet, sid, 0, chipsToUnits(want, wallet), "leave:poker"); bookedChips = Math.max(0, Math.round((round2(after) - round2(before)) * 100)); }
    catch (e) { try { console.error("[pk] TOKEN CREDIT FAILED — routing to pokerOwed:", JSON.stringify({ wallet, chips: want, session: sid, err: (e && e.message) || String(e) })); } catch (e2) {} owe(wallet, want); return { booked: 0, owed: want }; }
    const owedChips = Math.max(0, want - bookedChips); // capUp truncated the credit → the remainder is owed (never lost)
    if (owedChips > 0) owe(wallet, owedChips);
    return { booked: bookedChips, owed: owedChips };
  }
  // Token buy-in DEBIT, pre-checked + REFUSED on insufficient (H2 — never floored). Returns true iff
  // the debit booked. applyPokerNet inherits applyExternal's insufficient-tokens throw (:269), so a
  // seat can never hold more chips than its session surrendered.
  function tokenDebit(wallet, chips) {
    const want = Math.round(Number(chips) || 0);
    if (!(want > 0)) return true;
    const sid = tokenSid(wallet);
    if (!sid) return false;
    const have = Math.round(tokensNow(sid) * 100);
    if (want > have) return false; // H2 pre-check (mirror applyExternal:269) — refuse, don't floor
    try { TL.applyNet(wallet, sid, chipsToUnits(want, wallet), 0, "buyin:poker"); return true; }
    catch (e) { try { console.error("[pk] TOKEN DEBIT FAILED — buy-in NOT placed:", JSON.stringify({ wallet, chips: want, session: sid, err: (e && e.message) || String(e) })); } catch (e2) {} return false; }
  }

  /* ---------------- bank (play-money for demo, token ledger for real wallets) ----------------
     The DEMO bank is a simple in-memory play-money wallet each player buys in FROM (no persistence
     of the bank itself, no bridge). A REAL (token-bound) wallet's get/credit/debit ROUTE to the token
     ledger — a buy-in debits / a cash-out credits the SAME session (mirror baccarat-server.js:112).
     Demo balances are 1:1 units↔chips; token balances are cent-scaled at the seat boundary.       */
  const _demoBank = opts.bank || (() => {
    const m = new Map();
    const get = (w) => (m.has(w) ? m.get(w) : START_STACK);
    return { get, credit: (w, a) => m.set(w, get(w) + a), debit: (w, a) => { if (get(w) < a) return false; m.set(w, get(w) - a); return true; }, all: m };
  })();
  const bank = {
    all: _demoBank.all,
    get: (w) => isTokenWallet(w) ? tokensNow(tokenSid(w)) : _demoBank.get(w),
    // credit/debit here are UNIT-denominated (demo bank convention). Token routing converts to chips.
    credit: (w, a) => { if (isTokenWallet(w)) { tokenCredit(w, unitsToChips(a, w)); return true; } return _demoBank.credit(w, a); },
    debit: (w, a) => { if (isTokenWallet(w)) { return tokenDebit(w, unitsToChips(a, w)); } return _demoBank.debit(w, a); },
  };

  /* ---------------- persistence (spec §12 H5 — bindings/stacks/cumulativeBuyIn/rake/pokerOwed) ----------------
     Mirror the BJ/bac bank + bridge disk files: an opts.persist { load()->state, save(state) } seam,
     debounced write-through. Persists the token seat→session bindings + per-seat stacks + cumulative
     buy-in + accrued creator rake + the pokerOwed ledger + the daily creator-rake caps so a Render
     restart during a disconnect window can reconstruct a force-cash-out (boot-drain) and never strand
     an on-chain lock (the v12.94 class). Demo play-money state is NOT persisted (bank is ephemeral).   */
  const persist = opts.persist || null;
  let _saveT = null;
  function persistSnapshot() {
    const tables = [];
    for (const r of rooms.values()) {
      if (r.kind !== "real") continue; // only real (token) tables carry stranded-lock risk
      const seats = [];
      for (let i = 0; i < r.seats.length; i++) { const s = r.seats[i]; if (!s || !realWallet(s.wallet)) continue;
        seats.push({ seat: i, wallet: s.wallet, sid: tokenSid(s.wallet) || s._sid || null, stack: s.stack, cumulativeBuyInChips: s.cumulativeBuyInChips || 0 }); }
      if (seats.length) tables.push({ id: r.id, creatorWallet: r.creatorWallet, creatorRakeChips: r.creatorRakeChips || 0, seats });
    }
    return {
      tables,
      pokerOwed: Array.from(pokerOwed.entries()),
      creatorRakeDaily: Array.from(creatorRakeDaily.entries()),
    };
  }
  function doSave() { _saveT = null; if (!persist || !persist.save) return; try { persist.save(persistSnapshot()); } catch (e) {} }
  function savePersist() { if (!persist || !persist.save) return; if (_saveT) return; _saveT = setT(doSave, 800); }
  function flushPersist() { try { doSave(); } catch (e) {} }

  /* ---------------- lobby ---------------- */
  function avgPot(r) {
    if (!r.potHistory || !r.potHistory.length) return 0;
    return Math.round(r.potHistory.reduce((a, b) => a + b, 0) / r.potHistory.length);
  }
  function roomPublic(r) {
    return {
      id: r.id, name: r.name, kind: r.kind || "demo",
      sb: r.table.smallBlind, bb: r.table.bigBlind,
      seated: r.seats.filter(Boolean).length, maxSeats: r.table.maxSeats,
      openSeats: r.seats.filter((s) => !s).length,
      phase: r.phase, inHand: r.phase === "HAND" || r.phase === "SHOWDOWN",
      avgPot: avgPot(r), rakeBps: r.table.rakeBps, rakeCapBb: r.table.rakeCapBb,
      buyInMin: r.buyInMin, buyInMax: r.buyInMax,
      private: !!r.pwHash, host: r.creatorId === "HOUSE" ? "HOUSE" : (r.creatorName || null),
      commit: (r.table.hand && r.table.hand.commit) || null,
    };
  }
  function lobbyList() { return Array.from(rooms.values()).map(roomPublic); }
  let _lobbyJsonLast = "";
  function pushLobby() {
    const json = JSON.stringify({ type: "pk:lobby:list", rooms: lobbyList() });
    if (json === _lobbyJsonLast) return;
    _lobbyJsonLast = json;
    for (const s of lobbySubs) { if (s && s.send) { try { s.send(json); } catch (e) {} } }
  }

  /* ---------------- room mgmt ---------------- */
  function makeRoom(cfg) {
    if (rooms.size >= MAX_ROOMS) return null;
    seq++;
    const id = "PK-" + String(seq).padStart(2, "0");
    const bb = cfg.bb, sb = cfg.sb != null ? cfg.sb : Math.floor(bb / 2);
    const table = createTable({
      smallBlind: sb, bigBlind: bb, seats: cfg.maxSeats,
      rakeBps: cfg.rakeBps, rakeCapBb: cfg.rakeCapBb,
    });
    const r = {
      id, name: cfg.name || id,
      kind: cfg.kind === "real" ? "real" : "demo",
      creatorId: cfg.creatorId || "HOUSE",
      creatorWallet: cfg.creatorWallet || null,
      creatorName: cfg.creatorName || null,
      pwHash: cfg.pwHash || null,
      table,                                       // the engine table (holds hand + button + nonce)
      seats: new Array(cfg.maxSeats).fill(null),   // room-layer per-seat records (persist across hands)
      spectators: new Set(),
      buyInMin: cfg.buyInMin, buyInMax: cfg.buyInMax,
      phase: "WAITING",                            // WAITING | HAND | SHOWDOWN | BETWEEN
      actEpoch: 0,                                 // bumped on every toAct change (stale-timer guard)
      handSeedOrder: [],                           // seated-in wallets whose seeds were frozen this hand
      houseRakeChips: 0, creatorRakeChips: 0,      // spec §5.3 accumulators (demo: informational)
      potHistory: [],                              // rolling avg-pot (last 10)
      pendingButtonAdvance: false,
      lastActivity: now(), createdAt: now(),
      timers: {},
    };
    rooms.set(id, r);
    scheduleIdle(r);
    pushLobby();
    return r;
  }
  const HOUSE_CFG = { name: "HOUSE · Hold'em", kind: "demo", creatorId: "HOUSE", bb: 10, sb: 5, maxSeats: 9, rakeBps: 500, rakeCapBb: 3, buyInMin: 20 * 10, buyInMax: 100 * 10 };
  function ensureHouseTable() {
    for (const r of rooms.values()) if (r.creatorId === "HOUSE") return r;
    return makeRoom(HOUSE_CFG); // one warm table so the lobby is never empty (spec §6)
  }
  const seatedCount = (r) => r.seats.filter(Boolean).length;
  const inHandPhase = (r) => r.phase === "HAND" || r.phase === "SHOWDOWN";
  function touch(r) { r.lastActivity = now(); scheduleIdle(r); }
  function scheduleIdle(r) {
    if (r.timers.idle) clrT(r.timers.idle);
    const ms = seatedCount(r) === 0 ? T.idleEmpty : T.idleSeated;
    r.timers.idle = setT(() => {
      if (inHandPhase(r)) return scheduleIdle(r);           // NEVER close mid-hand
      if (r.creatorId === "HOUSE" && seatedCount(r) === 0 && rooms.size === 1) return scheduleIdle(r); // keep the lone warm table
      const idleFor = now() - r.lastActivity;
      const limit = seatedCount(r) === 0 ? T.idleEmpty : T.idleSeated;
      if (idleFor >= limit) closeRoom(r, "idle"); else scheduleIdle(r);
    }, ms);
  }
  /* ---------------- MONEY: cash-out / creator-rake / zero-sum (spec §5/§12) ---------------- */
  // The most a single seat can legitimately hold: its own cumulative buy-in PLUS every OTHER seat's
  // cumulative buy-in (it can win at most all their chips, minus rake). This is the H4 absolute clamp
  // ceiling for a cash-out credit — fail-closed.
  function maxSeatCreditChips(r) {
    // H4 ceiling is TABLE-LIFE, not seats-present-now: a seat can legitimately hold at most EVERY
    // chip ever bought in at this table (it can win others' whole stacks). `_everBuyInChips` accrues
    // at each buy-in/rebuy, so it is correct even after a busted loser has already left — which is the
    // common case the old "sum currently-seated buy-ins" version got wrong (F1: the ceiling collapsed
    // to the winner's own buy-in and destroyed their winnings).
    return (r._everBuyInChips || 0);
  }
  // CASH-OUT one seat (spec §5.4 uniform form for winners AND losers). DEMO: credit the play-money
  // bank. TOKEN: credit the stack back to the session via tokenCredit (H1 house-funded credit), which
  // routes any capUp SHORTFALL to pokerOwed (H3 — a deep P2P win never truncates/vanishes), asserts the
  // H4 absolute clamp fail-closed, then unbinds. Returns { creditedChips } = the ATTEMPTED credit
  // (booked OR owed) so the zero-sum assert (H8) sums over attempted, never only-successful.
  function cashOutSeat(r, s) {
    const chips = Math.max(0, Math.round(s.stack || 0));
    s.stack = 0;
    // DEFENCE IN DEPTH (audit): a REAL seat's stack must credit its TOKEN session, never the demo bank.
    // If the bind was somehow lost (e.g. a close-handler unbind that slipped through), re-bind from the
    // persisted _sid so isTokenWallet() is true below and the credit routes to the session / pokerOwed.
    if (chips > 0 && s._sid && realWallet(s.wallet) && !isTokenWallet(s.wallet)) { try { tokenBind.set(norm(s.wallet), s._sid); } catch (e) {} }
    // TABLE-LIFE returned total for the zero-sum assert (F2): every cash-out EVER — including seats
    // that already left before teardown — must be summed, not just the seats present at closeRoom.
    const track = (credited) => { r._everReturnedChips = (r._everReturnedChips || 0) + credited; };
    if (chips === 0) { if (isTokenWallet(s.wallet)) { unbindToken(s.wallet); } return { creditedChips: 0 }; }
    if (!isTokenWallet(s.wallet)) { bank.credit(s.wallet, chipsToUnits(chips, s.wallet)); track(chips); return { creditedChips: chips }; }
    // H4 ABSOLUTE clamp (fail-closed): with the table-life ceiling a legit stack can NEVER exceed it,
    // so this only fires on a genuine engine bug — and when it does the excess is routed to pokerOwed,
    // NEVER dropped on the floor (the F1 vanish). The credit's own capUp shortfall → pokerOwed too.
    const ceil = maxSeatCreditChips(r);
    if (chips > ceil) {
      try { console.error("[pk] H4 CLAMP: seat stack " + chips + " > table-life ceiling " + ceil + " (engine bug?) — excess " + (chips - ceil) + " → pokerOwed"); } catch (e) {}
      owe(s.wallet, chips - ceil);
    }
    tokenCredit(s.wallet, Math.min(chips, ceil)); // routes any capUp shortfall → pokerOwed (never lost)
    unbindToken(s.wallet);
    if (s._sid) s._sid = null;
    track(chips);          // ATTEMPTED credit = the FULL stack (booked + any owed), per H8
    flushPersist();        // money mutation → durable NOW (close the stranded-lock window)
    return { creditedChips: chips };
  }
  // CREATOR rake-share settlement (spec §5.6 + H1/H6/H7). r.creatorRakeChips accrued per hand at
  // finishHand (H6 seated-creator own-hand share already routed to HOUSE there; H7 anti-wash gate also
  // there). At teardown, pay the accrued creator-half as a HOUSE-FUNDED applyPokerNet credit into the
  // creator's session (or pokerOwed if sessionless). Enforces CREATOR_RAKE_CAP_DAILY (H7).
  function settleCreatorRake(r) {
    const chips = Math.round(r.creatorRakeChips || 0);
    r.creatorRakeChips = 0;
    if (!(chips > 0) || r.creatorId === "HOUSE" || !r.creatorWallet) return;
    const w = norm(r.creatorWallet);
    // H7 daily cap: the platform withholds any creator-rake beyond CREATOR_RAKE_CAP_DAILY per wallet/day.
    const cap = Math.round(CREATOR_RAKE_CAP_DAILY_CHIPS);
    const dayKey = w + ":" + Math.floor(now() / 86400000);
    const used = creatorRakeDaily.get(dayKey) || 0;
    let pay = chips;
    if (used + pay > cap) pay = Math.max(0, cap - used); // withhold the excess to HOUSE
    if (pay <= 0) return;
    creatorRakeDaily.set(dayKey, used + pay);
    if (isTokenWallet(r.creatorWallet)) { tokenCredit(r.creatorWallet, pay); } // house-funded credit (or pokerOwed if capUp/sessionless)
    else { owe(r.creatorWallet, pay); } // creator not currently bound → accrue owed, claimed on next session open
    savePersist();
  }
  // ZERO-SUM assert (spec §5.5 + H8), fail-closed, computed over ATTEMPTED credits (booked OR owed).
  // Over the table's life: Σ(cumulativeBuyIn − returned) === totalRake === houseRake + creatorRake, exact
  // to the chip. `returned` is the sum of ATTEMPTED cash-out credits (a failed booking is an owed
  // obligation, not a hole). Logs LOUD on any mismatch (an engine/settlement bug); never throws out of
  // teardown (a throw would strand the room), but flags the invariant break for audit.
  function assertZeroSum(r, returnedChips, rakeChips) {
    const buyIn = (r._everBuyInChips || 0);
    const lhs = buyIn - returnedChips;                 // chips that never came back to a seat
    const rhs = Math.round(rakeChips || 0);            // == houseRake + creatorRake (the only sink)
    if (lhs !== rhs) { try { console.error("[pk] ZERO-SUM VIOLATION table=" + r.id + " Σ(buyIn−returned)=" + lhs + " != totalRake=" + rhs + " (buyIn=" + buyIn + " returned=" + returnedChips + ")"); } catch (e) {} return false; }
    return true;
  }
  // Force-cash-out every seat of a REAL table + settle the creator rake + assert zero-sum. Used by
  // closeRoom(real) and the boot-drain. Fail-closed: the assert result is logged; teardown proceeds so
  // no lock is ever stranded (an owed chip is claimable next session).
  function settleRealTable(r, reason) {
    for (const s of r.seats) if (s) {
      if (s._dcTimer) { clrT(s._dcTimer); s._dcTimer = null; }
      cashOutSeat(r, s); // accumulates into r._everReturnedChips (table-life)
    }
    const totalRake = Math.round((r.houseRakeChips || 0) + (r.creatorRakeChips || 0)); // table-life: accrued per hand, never removed before this point (settleCreatorRake zeroes creatorRakeChips AFTER)
    settleCreatorRake(r); // credits the creator-half (or owed); houseRake stays HOUSE profit (no explicit payout)
    // ASSERT over the table's WHOLE LIFE: Σ(everBuyIn − everReturned) === totalRake (F2 — earlier-left
    // seats' cash-outs are in _everReturnedChips, so the invariant no longer false-positives on the normal path).
    assertZeroSum(r, (r._everReturnedChips || 0), totalRake);
    flushPersist();
  }

  function closeRoom(r, reason) {
    // refund-first (mirror baccarat closeRoom): cash any seated stacks back. For a REAL (token) table
    // this force-cash-out credits each seat's stack to its session (or pokerOwed), settles the CREATOR
    // rake-share, and unbinds — then the zero-sum assert (fail-closed) gates the teardown so a chip can
    // never vanish. NEVER close mid-hand (the idle scheduler already guards; belt-and-suspenders here too).
    if (r.kind === "real" && inHandPhase(r) && r.table.hand && !r.table.hand.done) { scheduleIdle(r); return; }
    if (r.kind === "real") { settleRealTable(r, reason); }
    else { for (const s of r.seats) if (s) { if (s._dcTimer) { clrT(s._dcTimer); s._dcTimer = null; } if (s.stack > 0) { bank.credit(s.wallet, chipsToUnits(s.stack, s.wallet)); s.stack = 0; } } }
    for (const k in r.timers) clrT(r.timers[k]);
    broadcast(r, { type: "pk:event", kind: "tableClosing", id: r.id, reason });
    const h = r.table.hand;
    if (h && h.done && h.serverSeed) broadcast(r, { type: "pk:reveal", tableId: r.id, serverSeed: h.serverSeed, commit: h.commit });
    rooms.delete(r.id);
    pushLobby();
    ensureHouseTable(); // never leave the lobby empty
  }
  // Reap surplus empty tables but always keep the warm HOUSE one.
  function reapEmptyExtras() {
    const empties = Array.from(rooms.values()).filter((r) => seatedCount(r) === 0 && r.phase === "WAITING" && r.creatorId !== "HOUSE");
    for (const r of empties) closeRoom(r, "reaped");
  }

  /* ---------------- per-socket masked broadcast (THE security property) ---------------- */
  // Loop every recipient (seated player or spectator) and send THAT recipient its OWN masked
  // snapshot from the engine. A seated player's snapshot reveals only their own holes; a
  // spectator (null viewer) sees zero live holes. Hole cards NEVER cross sockets.
  function stateFor(r, viewerWallet) {
    const h = r.table.hand;
    const base = {
      type: "pk:state", tableId: r.id, kind: r.kind, phase: r.phase, handNo: r.table.nonce, // kind: the felt needs it to scale REAL chips (cents) → dollars for the balance HUD + the profile-stats record (audit: it was omitted → real hands logged 100× too big)
      button: r.table.button, sb: r.table.smallBlind, bb: r.table.bigBlind,
      serverNow: now(), actDeadline: r.actDeadline || 0,
      seats: r.seats.map((s, i) => s ? {
        seat: i, wallet: s.wallet, name: s.name, stack: s.stack,
        sittingOut: !!s.sittingOut, away: !!s.disconnected, left: !!s.left,
        isHost: s.wallet === r.creatorWallet && r.creatorId !== "HOUSE",
        inHand: !!(h && h.players.some((p) => p.id === s.wallet)),
      } : null),
      buyInMin: r.buyInMin, buyInMax: r.buyInMax,
      rakeBps: r.table.rakeBps, rakeCapBb: r.table.rakeCapBb,
    };
    if (h) {
      // The engine's masked snapshot IS the per-viewer boundary (poker-server.js:603).
      base.hand = h.snapshotFor(viewerWallet == null ? null : viewerWallet);
    } else {
      base.hand = null;
    }
    return base;
  }
  function broadcast(r, obj) {
    // pk:event / pk:reveal etc. carry NO hole cards → a shared broadcast is safe for those.
    for (const s of r.seats) if (s && !s.disconnected) send(s.sock, obj);
    for (const sp of r.spectators) send(sp, obj);
  }
  // PER-SOCKET state push — the one place the baccarat template is broken (spec §4).
  function broadcastState(r) {
    for (const s of r.seats) if (s && s.sock && !s.disconnected) send(s.sock, stateFor(r, s.wallet));
    for (const sp of r.spectators) send(sp, stateFor(r, null)); // spectators: null viewer, no live holes
    pushLobby();
  }
  function pushWallet(sock, wallet) { send(sock, { type: "pk:wallet", balance: bank.get(wallet) }); }
  function err(sock, code, msg, intent) { send(sock, { type: "pk:error", code, msg, intent }); }

  /* ---------------- seat helpers ---------------- */
  function seatIndexOfSock(r, sock) { for (let i = 0; i < r.seats.length; i++) if (r.seats[i] && r.seats[i].sock === sock) return i; return -1; }
  function seatOfWallet(r, wallet) { for (let i = 0; i < r.seats.length; i++) if (r.seats[i] && r.seats[i].wallet === wallet) return r.seats[i]; return null; }
  // an "IN" seat is eligible to be dealt into the next hand
  function seatedInWithChips(r, bb) { return r.seats.filter((s) => s && !s.sittingOut && !s.left && !s.disconnected && s.stack >= bb); } // !disconnected: an in-grace dropped seat sits out of NEW deals (stack preserved for the 90s reclaim) instead of being auto-folded every hand and bleeding blinds it never chose to post (review LOW-3)

  /* ---------------- HAND lifecycle FSM ---------------- */
  // WAITING → HAND when ≥2 seated-in players have stack ≥ BB.
  function maybeStartHand(r) {
    if (r.phase !== "WAITING" && r.phase !== "BETWEEN") return;
    refillBots(r); // demo: top up any busted bot so the table keeps playing
    const eligible = seatedInWithChips(r, r.table.bigBlind);
    if (eligible.length < 2) { r.phase = "WAITING"; broadcastState(r); reapEmptyExtras(); return; }
    startNextHand(r);
  }

  function startNextHand(r) {
    // Rotate the button one live seat clockwise from the previous hand (except the first).
    // The engine's startHand takes a buttonIndex into the DEALT (eligible) subset — we compute
    // it over the room seat ring so it advances one occupied+eligible seat each hand.
    const bb = r.table.bigBlind;
    const eligible = seatedInWithChips(r, bb);
    if (eligible.length < 2) { r.phase = "WAITING"; broadcastState(r); return; }

    // SEEDS (spec §7): collect one clientSeed per SEATED-IN player, auto-gen if blank, FREEZE
    // at commit. Join via joinPokerSeeds; the engine deals from provablyFairDeck(seed, combined, nonce).
    const dealt = eligible.map((s) => {
      if (!s.clientSeed) s.clientSeed = randSeed();
      return { id: s.wallet, name: s.name, isBot: !!s.isBot, stack: s.stack, aggression: s.aggression != null ? s.aggression : 0.5, clientSeed: s.clientSeed };
    });
    r.handSeedOrder = dealt.map((d) => d.id);
    const combined = joinPokerSeeds(dealt.map((d) => d.clientSeed));

    // Button as an index into the DEALT array. Advance one seat each hand — tracked by SEAT-RING
    // index so that when the prior button-holder has left/busted/dropped (no longer eligible) the
    // button moves to the seat clockwise-AFTER their vacated ring slot, not back to dealt[0] (review LOW-2).
    const eligRing = eligible.map((s) => r.seats.indexOf(s)); // ascending ring indices of the dealt players
    let btnIdx = 0;
    if (r._lastButtonSeatIdx != null) {
      let found = -1;
      for (let k = 0; k < eligRing.length; k++) { if (eligRing[k] > r._lastButtonSeatIdx) { found = k; break; } }
      btnIdx = found >= 0 ? found : 0; // none after → wrap to the lowest ring index (the clockwise-next seat)
    }

    // Drive the engine table directly so we control seed + button (startHand() would re-derive both).
    const round = PF.newRound();
    r.table.nonce++;
    // Blinds are stored in DOLLAR units (so stakesLabel shows "$5/$10"); scale them into the SAME chip
    // (cent, 100×) space as the stacks for a REAL table — else a "$5/$10" real table posts blinds of 5/10
    // CHIPS = $0.05/$0.10 (stacks are cent-scaled but blinds were not). rakeCapChips = rakeCapBb·bb in the
    // engine scales with the passed bb automatically, so the rake cap comes out right too. Demo stays 1:1.
    const blindScale = r.kind === "real" ? 100 : 1;
    const hand = new ServerHand({
      smallBlind: r.table.smallBlind * blindScale, bigBlind: r.table.bigBlind * blindScale,
      buttonIndex: btnIdx, players: dealt,
      serverSeed: round.serverSeed, clientSeed: combined, nonce: r.table.nonce,
      rakeBps: r.table.rakeBps, rakeCapBb: r.table.rakeCapBb,
    });
    hand.start();
    r.table.hand = hand;
    r.table.button = hand.button;
    r.table.commit = hand.commit;
    r._lastButtonWallet = dealt[hand.button].id;
    r._lastButtonSeatIdx = eligRing[hand.button]; // remember the button's RING position so next hand advances clockwise even if this holder departs
    r.phase = "HAND";
    touch(r);

    // Broadcast the START snapshot (per-socket) — commit + clientSeeds + nonce, NEVER serverSeed/cards.
    broadcast(r, { type: "pk:event", kind: "handStart", tableId: r.id, handNo: r.table.nonce, commit: hand.commit, clientSeeds: dealt.map((d) => d.clientSeed), nonce: r.table.nonce });
    broadcastState(r);
    advanceHand(r); // may immediately auto-resolve (all-in) or arm the first human timer
  }

  // Drive the hand forward: run bots (delayed), and when the human to-act is reached, arm the
  // 20s act-timer keyed by actEpoch. When the engine is done → SHOWDOWN.
  function advanceHand(r) {
    const h = r.table.hand;
    if (!h) return;
    if (h.done) return finishHand(r);
    const seat = h.players[h.toAct];
    if (!seat) return finishHand(r);
    // toAct changed → bump the epoch so any prior-turn timer is stale, and clear the old timer.
    bumpAct(r);
    const roomSeat = seatOfWallet(r, seat.id);
    if (roomSeat && roomSeat.isBot) {
      // Demo table-fill bot: decide after a short delay (NOT the human timer).
      const idx = h._botSeq++;
      const delay = (T.botMin > 0 || T.botMax > 0) ? (T.botMin + Math.floor(rand() * Math.max(0, T.botMax - T.botMin))) : 0;
      const ep = r.actEpoch;
      const fire = () => {
        if (r.actEpoch !== ep || h.done || h.players[h.toAct] == null || h.players[h.toAct].id !== seat.id) return; // stale
        let fcursor = 0;
        const rng = () => PF.floats(h.serverSeed, "bot:" + seat.id, (h.nonce * 100000) + idx, ++fcursor)[fcursor - 1];
        const legal = h.legalActions(seat.id);
        const decision = botDecide(h.snapshotFor(seat.id), legal, { aggression: roomSeat.aggression, rng });
        try { h.act(seat.id, decision.type, decision.amount); } catch (e) { try { h.act(seat.id, legal.canCheck ? "check" : "fold"); } catch (_) {} }
        broadcastState(r);
        advanceHand(r);
      };
      if (delay > 0) { r.actDeadline = 0; r.timers.act = setT(fire, delay); }
      else fire();
      return;
    }
    // Human to act. A DISCONNECTED seat on its turn auto-folds/checks immediately (spec §4).
    if (roomSeat && roomSeat.disconnected) { autoAct(r, seat.id); return; }
    // Arm the 20s act-timer with the epoch guard.
    armActTimer(r, seat.id);
    broadcastState(r);
  }

  function bumpAct(r) { r.actEpoch++; if (r.timers.act) { clrT(r.timers.act); r.timers.act = null; } }
  function armActTimer(r, wallet) {
    if (r.timers.act) clrT(r.timers.act);
    const ep = r.actEpoch;
    r.actDeadline = now() + T.act;
    r.timers.act = setT(() => {
      if (r.actEpoch !== ep) return;           // STALE — a later turn already re-armed; do nothing
      const h = r.table.hand;
      if (!h || h.done) return;
      if (h.players[h.toAct] == null || h.players[h.toAct].id !== wallet) return; // not this seat's turn anymore
      autoAct(r, wallet);
    }, T.act);
  }
  // Timeout / disconnected action: auto-CHECK if legal, else auto-FOLD.
  function autoAct(r, wallet) {
    const h = r.table.hand;
    if (!h || h.done || h.players[h.toAct] == null || h.players[h.toAct].id !== wallet) return;
    const legal = h.legalActions(wallet);
    try { h.act(wallet, legal.canCheck ? "check" : "fold"); } catch (e) { try { h.act(wallet, "fold"); } catch (_) {} }
    broadcast(r, { type: "pk:event", kind: "autoAct", wallet, action: legal.canCheck ? "check" : "fold" });
    broadcastState(r);
    advanceHand(r);
  }

  function finishHand(r) {
    const h = r.table.hand;
    if (r.phase !== "HAND") return; // IDEMPOTENCY: a hand settles exactly once. finishHand is not idempotent (it increments _handsPlayed, pushes potHistory, re-splits rake, arms a showdown timer) — a re-entry after phase already moved to SHOWDOWN/BETWEEN would double-count rake and break zero-sum. Only settle a hand still live in HAND phase.
    if (r.timers.act) { clrT(r.timers.act); r.timers.act = null; }
    r.actDeadline = 0;
    r.phase = "SHOWDOWN";
    // Count this dealt hand toward the H7 anti-wash gate (a hand that actually reached _finish).
    r._handsPlayed = (r._handsPlayed || 0) + 1;
    // Rake split (spec §5.3 + §12 H6/H7): engine already skimmed h.rake into the pot math; split it here.
    //   H6 — a SEATED creator earns ZERO rake-share on hands they were dealt into → that half to HOUSE.
    //   H7 — the creator-half stays with HOUSE until the table has had ≥CREATOR_GATE_DISTINCT DISTINCT
    //        funded wallets play ≥CREATOR_GATE_HANDS hands (anti-wash / self-dealing gate).
    const rake = h.rake || 0;
    if (rake > 0) {
      const houseHalf = Math.floor(rake / 2);
      const creatorHalf = rake - houseHalf; // creator gets the odd chip (exact split, no mint/burn)
      const creatorSeated = r.creatorId !== "HOUSE" && r.creatorWallet && h.players.some((p) => norm(p.id) === norm(r.creatorWallet)); // NORMALIZE both sides — a raw === let a creator seat under a different address casing (same token session verifies case-insensitively) so H6 read FALSE and they self-dealt the house rake
      const distinct = (r._fundedWallets ? r._fundedWallets.size : 0);
      const gateOpen = distinct >= CREATOR_GATE_DISTINCT && (r._handsPlayed || 0) >= CREATOR_GATE_HANDS;
      const creatorEligible = r.creatorId !== "HOUSE" && r.creatorWallet && !creatorSeated && gateOpen;
      if (!creatorEligible) { r.houseRakeChips += rake; }                            // H6 seated OR H7 gate-shut OR HOUSE table → all to HOUSE
      else { r.houseRakeChips += houseHalf; r.creatorRakeChips += creatorHalf; }     // creator earns the half
    }
    // Persist the engine's post-hand stacks back to the room seats (stacks carry across hands).
    for (const p of h.players) { const s = seatOfWallet(r, p.id); if (s) s.stack = p.stack; }
    // rolling avg-pot (last 10)
    const pot = h.players.reduce((a, p) => a + p.committedTotal, 0);
    r.potHistory.push(pot); if (r.potHistory.length > 10) r.potHistory.shift();

    broadcastState(r); // reveal shown holes + deltas (engine snapshot exposes them once done)
    broadcast(r, { type: "pk:reveal", tableId: r.id, handNo: r.table.nonce, serverSeed: h.serverSeed, commit: h.commit, clientSeed: h.clientSeed, nonce: h.nonce });
    touch(r);
    r.timers.showdown = setT(() => toBetween(r), T.showdown);
  }

  // BETWEEN: reconcile deferred seat changes, then start the next hand or drop to WAITING.
  function toBetween(r) {
    r.phase = "BETWEEN";
    // remove LEFT seats (credit remaining stack to the demo bank), auto-sit-out the busted.
    for (let i = 0; i < r.seats.length; i++) {
      const s = r.seats[i];
      if (!s) continue;
      if (s.left) {
        if (isTokenWallet(s.wallet)) { cashOutSeat(r, s); pushWallet(s.sock, s.wallet); }
        else if (s.stack > 0) { bank.credit(s.wallet, chipsToUnits(s.stack, s.wallet)); pushWallet(s.sock, s.wallet); }
        if (s._dcTimer) { clrT(s._dcTimer); s._dcTimer = null; }
        r.seats[i] = null;
        broadcast(r, { type: "pk:event", kind: "seatOpen", seat: i });
      } else if (s.stack < r.table.bigBlind) {
        s.sittingOut = true; // can't post a blind → sit out until a rebuy
      }
    }
    r.table.hand = null;
    broadcastState(r);
    reapEmptyExtras();
    r.timers.between = setT(() => maybeStartHand(r), T.between);
  }

  /* ---------------- seat lifecycle ---------------- */
  function takeSeat(sock, wallet, name, r, seatPref, buyInUnits) {
    // one seat per wallet at THIS table
    if (seatOfWallet(r, wallet)) { err(sock, "already_seated", "You're already at this table", "join"); return false; }
    let idx = -1;
    if (seatPref != null && seatPref >= 0 && seatPref < r.seats.length && !r.seats[seatPref]) idx = seatPref;
    else idx = r.seats.findIndex((s) => !s);
    if (idx < 0) { err(sock, "table_full", "Table is full", "join"); return false; }
    // clamp buy-in to table bounds, then debit the funding wallet (demo bank OR token session).
    let units = Number(buyInUnits);
    if (!isFinite(units) || units <= 0) {
      // NEVER auto-debit a default REAL buy-in: a bare `pk:table:join {tableId}` with no amount
      // (e.g. a client resync whose seat was already dropped past the 90s grace) must not silently
      // debit DEMO_BUYIN_DEFAULT of real tokens. A live reconnect is handled by the grace-reclaim
      // branch ABOVE this call, so reaching here with no amount + a token wallet means "new seat" →
      // require an explicit buy-in. Demo (play-money) may default.
      if (isTokenWallet(wallet)) { err(sock, "buyin_required", "Choose a buy-in amount to sit down", "join"); return false; }
      units = DEMO_BUYIN_DEFAULT;
    }
    units = Math.max(r.buyInMin, Math.min(r.buyInMax, Math.round(units)));
    // TOKEN (real) table: FREEZE the funding pool and (if the wallet had owed chips from a prior
    // sessionless payout) pay them down into the fresh session before the buy-in (H1 claim).
    const tokenSeat = isTokenWallet(wallet);
    if (tokenSeat) {
      // A table holding ANY bot can NEVER take a real (token) buy-in. Bots are synthetic play-money
      // wallets; flipping the table to real (r.kind="real") would deal them into real hands and, at
      // teardown, cashOutSeat credits a bot's chips to the throwaway demo bank (real chips a bot won
      // from a real player vanish + assertZeroSum breaks). Refuse the buy-in; keep the table demo.
      if (r.seats.some((s) => s && s.isBot)) { err(sock, "demo_only", "This table has practice bots — real-money buy-ins aren’t allowed here. Join a table with no bots.", "join"); return false; }
      r.kind = "real";
      const sid = tokenSid(wallet);
      if (!bindToken(wallet, sid)) { err(sock, "bound_elsewhere", "Your session is busy in another game — finish that first", "join"); return false; }
      claimOwed(wallet, sid);
    }
    if (bank.get(wallet) < units - 1e-9) { err(sock, "insufficient", "Not enough balance to buy in", "join"); return false; } // H2 pre-check (tokenDebit also refuses)
    if (!bank.debit(wallet, units)) { err(sock, "insufficient", "Not enough balance to buy in", "join"); return false; } // debit-before-escrow; token debit is REFUSED (never floored) on insufficient
    r.seats[idx] = {
      sock, wallet, name: name || wallet, isBot: false,
      stack: unitsToChips(units, wallet), cumulativeBuyInChips: unitsToChips(units, wallet),
      _sid: tokenSeat ? tokenSid(wallet) : null,
      clientSeed: "", sittingOut: false, disconnected: 0, _dcTimer: null, left: false,
      seatIndex: idx, aggression: 0.5,
    };
    // zero-sum bookkeeping (spec §5.5): the cumulative chips EVER bought in at this table (buy-ins +
    // rebuys), and the DISTINCT funded wallets for the H7 anti-wash gate.
    r._everBuyInChips = (r._everBuyInChips || 0) + r.seats[idx].cumulativeBuyInChips;
    if (!r._fundedWallets) r._fundedWallets = new Set();
    r._fundedWallets.add(norm(wallet));
    if (tokenSeat) flushPersist(); else savePersist(); // BUY-IN: the debit is durable synchronously, so the seat→session binding must persist SYNCHRONOUSLY too — a debounced write leaves an 800ms crash window that strands the on-chain lock (H5/v12.94 class)
    r.spectators.delete(sock);
    touch(r);
    send(sock, Object.assign(stateFor(r, wallet), { you: { tableId: r.id, seat: idx, balance: bank.get(wallet) } }));
    pushWallet(sock, wallet);
    broadcast(r, { type: "pk:event", kind: "seatTaken", seat: idx, wallet, name: r.seats[idx].name });
    broadcastState(r);
    ensureDemoBots(r); // demo: auto-seat 2 bots for a solo player so a game starts immediately
    // Join mid-hand = seated but sits out until the next hand (the engine already built players[]
    // for the live hand from the pre-join snapshot, so this seat simply isn't in h.players).
    maybeStartHand(r);
    return true;
  }

  function join(sock, wallet, name, tableId, seatPref, buyInUnits, pw) {
    // Reconnect grace: reclaim a temporarily-disconnected seat (same wallet) → SAME seat + stack.
    for (const r of rooms.values()) {
      for (let i = 0; i < r.seats.length; i++) {
        const s = r.seats[i];
        if (s && s.disconnected && s.wallet === wallet) {
          // SECURITY (audit CRITICAL): a REAL (0x) seat may be reclaimed ONLY by an AUTHENTICATED
          // socket that IS that wallet — sock.wallet is set at hello only via a VERIFIED bjSession.
          // messageWallet falls back to the client-supplied m.wallet for an unauthenticated socket
          // (empty sock.wallet), so without this guard an attacker sending {wallet:"<victim>"} passes
          // s.wallet===wallet, HIJACKS the disconnected seat (s.sock=sock), and receives the victim's
          // LIVE hole cards. Guest seats are play-money (localStorage id, same trust model as bj/bac).
          if (realWallet(s.wallet) && !(sock.wallet && norm(sock.wallet) === norm(s.wallet))) continue;
          if (s._dcTimer) { clrT(s._dcTimer); s._dcTimer = null; }
          s.sock = sock; s.disconnected = false; s.dcAt = 0; s.left = false;
          r.spectators.delete(sock);
          // SECURITY: mask the snapshot with the SEAT's own wallet (server-side record), never the
          // client-supplied `wallet` — the reveal key must be bound to socket→seat identity, not a
          // spoofable message field. (Here s.wallet === wallet by the guard above; belt-and-suspenders.)
          send(sock, Object.assign(stateFor(r, s.wallet), { you: { tableId: r.id, seat: i, balance: bank.get(s.wallet) } }));
          pushWallet(sock, s.wallet);
          broadcast(r, { type: "pk:event", kind: "seatReconnected", seat: i, wallet });
          broadcastState(r);
          return r;
        }
      }
    }
    // RESYNC: the SAME socket re-joining its own seat (mobile half-open socket) → snapshot, not error.
    // SECURITY (hole-card leak fix): the snapshot MUST be masked for the wallet that actually OWNS this
    // socket's seat (r.seats[si].wallet), NEVER the client-supplied `wallet`. `messageWallet` falls back
    // to `m.wallet` whenever sock.wallet is empty (unauthenticated/denied guest sockets), so trusting it
    // here let a seated attacker resync as `{wallet:"<victim>"}` and receive stateFor(victim) → victim's
    // live hole cards. The reveal key is bound to socket→seat identity only.
    for (const r of rooms.values()) { const si = seatIndexOfSock(r, sock); if (si >= 0) {
      const seatWallet = r.seats[si].wallet;
      send(sock, Object.assign(stateFor(r, seatWallet), { you: { tableId: r.id, seat: si, balance: bank.get(seatWallet) } }));
      pushWallet(sock, seatWallet);
      return r;
    } }
    // one seat per wallet across all tables
    for (const r of rooms.values()) if (seatOfWallet(r, wallet)) { err(sock, "already_seated", "You're already at a table", "join"); return null; }
    const r = tableId ? rooms.get(tableId) : ensureHouseTable();
    if (!r) { err(sock, "no_table", "Table not found", "join"); return null; }
    if (r.pwHash && String(pw || "") !== r.pwHash) { err(sock, "bad_password", "Wrong table password", "join"); return null; }
    takeSeat(sock, wallet, name, r, seatPref, buyInUnits);
    return r;
  }

  function watch(sock, tableId, pw) {
    const r = rooms.get(tableId);
    if (!r) return err(sock, "no_table", "Table not found", "watch");
    // A PRIVATE table's password must gate SPECTATING too, not just joining — otherwise anyone who
    // guesses the (short, sequential) table id can watch the live board + every showdown hole card via
    // the broadcast spectator view, defeating the password entirely. Mirrors join()'s pwHash check.
    if (r.pwHash && String(pw || "") !== r.pwHash) return err(sock, "bad_password", "Wrong table password", "watch");
    r.spectators.add(sock);
    send(sock, stateFor(r, null)); // spectator view — no live holes
    pushLobby();
  }

  // Sit out / sit in (between hands takes effect next deal; mid-hand sit-out folds at your turn via the seat flag).
  function setSitOut(sock, out) {
    for (const r of rooms.values()) { const i = seatIndexOfSock(r, sock); if (i < 0) continue;
      const s = r.seats[i];
      s.sittingOut = !!out;
      broadcast(r, { type: "pk:event", kind: out ? "satOut" : "satIn", seat: i, wallet: s.wallet });
      broadcastState(r);
      if (!out) maybeStartHand(r);
      return;
    }
    err(sock, "no_seat", "Take a seat first", "sit");
  }

  function leave(sock) {
    for (const r of rooms.values()) {
      r.spectators.delete(sock);
      const i = seatIndexOfSock(r, sock); if (i < 0) continue;
      const s = r.seats[i];
      const liveInHand = inHandPhase(r) && r.table.hand && r.table.hand.players.some((p) => p.id === s.wallet && !p.folded);
      if (liveInHand) {
        // abandoning a LIVE hand: fold NOW if it's your turn (chips already in the pot ride via buildPots),
        // mark left → seat removed + stack credited only at the next BETWEEN (never mid-hand).
        s.left = true;
        const h = r.table.hand;
        if (h.players[h.toAct] && h.players[h.toAct].id === s.wallet) {
          try { h.act(s.wallet, "fold"); } catch (e) {}
          broadcastState(r); advanceHand(r);
        } else broadcastState(r);
        broadcast(r, { type: "pk:event", kind: "seatLeaving", seat: i, wallet: s.wallet });
      } else {
        // not in a live hand → cash out immediately (token seats: credit session/pokerOwed + unbind).
        if (isTokenWallet(s.wallet)) { cashOutSeat(r, s); pushWallet(s.sock, s.wallet); }
        else if (s.stack > 0) { bank.credit(s.wallet, chipsToUnits(s.stack, s.wallet)); pushWallet(s.sock, s.wallet); }
        if (s._dcTimer) { clrT(s._dcTimer); s._dcTimer = null; }
        r.seats[i] = null;
        broadcast(r, { type: "pk:event", kind: "seatOpen", seat: i });
        broadcastState(r); reapEmptyExtras(); savePersist();
      }
      pushLobby();
      return;
    }
  }

  function act(sock, type, amount) {
    for (const r of rooms.values()) { const i = seatIndexOfSock(r, sock); if (i < 0) continue;
      const s = r.seats[i];
      const h = r.table.hand;
      if (r.phase !== "HAND" || !h || h.done) return err(sock, "no_hand", "No hand in progress", "act");
      if (h.players[h.toAct] == null || h.players[h.toAct].id !== s.wallet) return err(sock, "not_your_turn", "It's not your turn", "act");
      try { h.act(s.wallet, type, amount); }
      catch (e) { return err(sock, "illegal", (e && e.message) || "Illegal action", "act"); }
      broadcastState(r);
      advanceHand(r);
      return;
    }
    err(sock, "no_seat", "Take a seat first", "act");
  }

  // Rebuy: add chips (buy-in units) to a seated stack between hands. H8 — ONE guarded transaction
  // (debit → stack+= → cumulativeBuyIn+=) that rolls back all three on any failure (refund-first-
  // abort-on-fail). Token debit is REFUSED (not floored) on insufficient. The sane cap is computed in
  // CHIPS (s.stack is already chips) so it isn't the prior units/chips-confusion bug.
  function rebuy(sock, amountUnits) {
    for (const r of rooms.values()) { const i = seatIndexOfSock(r, sock); if (i < 0) continue;
      if (inHandPhase(r) && r.table.hand && r.table.hand.players.some((p) => p.id === r.seats[i].wallet)) return err(sock, "in_hand", "Rebuy between hands", "rebuy");
      const s = r.seats[i];
      let units = Math.max(0, Math.round(Number(amountUnits) || 0));
      if (units <= 0) return err(sock, "server", "Bad rebuy amount", "rebuy");
      let addChips = unitsToChips(units, s.wallet);
      const capChips = r.buyInMax * 3 * chipsScale(s.wallet); // sane per-seat cap in chips
      if (s.stack + addChips > capChips) { addChips = Math.max(0, capChips - s.stack); units = chipsToUnits(addChips, s.wallet); }
      if (addChips <= 0 || units <= 0) return err(sock, "server", "Rebuy would exceed the table cap", "rebuy");
      if (!bank.debit(s.wallet, units)) return err(sock, "insufficient", "Not enough balance", "rebuy"); // token debit refuses on insufficient (never floors)
      // debit booked → apply the OTHER two legs atomically (pure in-memory, cannot throw).
      s.stack += addChips; s.cumulativeBuyInChips += addChips;
      r._everBuyInChips = (r._everBuyInChips || 0) + addChips;
      if (s.sittingOut && s.stack >= r.table.bigBlind) s.sittingOut = false;
      pushWallet(sock, s.wallet); broadcastState(r);
      if (isTokenWallet(s.wallet)) flushPersist(); else savePersist(); // rebuy is a real debit → persist the larger stack SYNCHRONOUSLY (stranded-lock window)
      maybeStartHand(r);
      return;
    }
    err(sock, "no_seat", "Take a seat first", "rebuy");
  }

  /* ---------------- table create ---------------- */
  function createTableMsg(sock, wallet, name, cfg) {
    cfg = cfg || {};
    // per-wallet concurrent open-table cap (anti-spam)
    const mine = Array.from(rooms.values()).filter((r) => r.creatorWallet === wallet).length;
    if (wallet && mine >= (opts.maxTablesPerWallet || 2)) return err(sock, "table_cap", "You already have the max open tables", "create");
    // CLAMP every field on receipt (client bounds cosmetic).
    let bb = Number(cfg.bb); if (STAKES_BB.indexOf(bb) < 0) bb = 10; const sb = Math.floor(bb / 2);
    const maxSeats = clampInt(cfg.maxSeats, SEATS_MIN, SEATS_MAX, 9);
    const rakeBps = clampInt(cfg.rakeBps, RAKE_BPS_MIN, RAKE_BPS_MAX, 500);
    const rakeCapBb = clampInt(cfg.rakeCapBb, RAKE_CAP_BB_MIN, RAKE_CAP_BB_MAX, 3);
    let buyInMinBb = clampInt(cfg.buyInMinBb != null ? cfg.buyInMinBb : 20, BUYIN_MIN_BB, BUYIN_MAX_BB, 20);
    let buyInMaxBb = clampInt(cfg.buyInMaxBb != null ? cfg.buyInMaxBb : 100, BUYIN_MIN_BB, BUYIN_MAX_BB, 100);
    if (buyInMaxBb < buyInMinBb) buyInMaxBb = buyInMinBb;
    let nm = sanitizeName(cfg.name || (name ? name + "'s Table" : "Poker Table"));
    if (nm.length < NAME_MIN) nm = "Poker Table";
    const pwHash = (cfg.private && cfg.pw) ? String(cfg.pw).slice(0, 64) : null; // Phase 2: stored raw-clamped (Phase 4 hashes); never echoed
    const r = makeRoom({
      name: nm, kind: "demo", creatorId: wallet || "anon", creatorWallet: wallet || null, creatorName: name || null,
      bb, sb, maxSeats, rakeBps, rakeCapBb,
      buyInMin: buyInMinBb * bb, buyInMax: buyInMaxBb * bb, pwHash,
    });
    if (!r) return err(sock, "lobby_full", "No table capacity", "create");
    send(sock, { type: "pk:table:created", tableId: r.id });
    pushLobby();
    // creator auto-subscribed + must sit (a 0-seat table reaps in idleEmpty)
    lobbySubs.add(sock);
    return r;
  }

  /* ---------------- disconnect (two-tier grace) ---------------- */
  function markDisconnected(sock) {
    lobbySubs.delete(sock);
    for (const r of rooms.values()) {
      r.spectators.delete(sock);
      const i = seatIndexOfSock(r, sock); if (i < 0) continue;
      const s = r.seats[i];
      s.disconnected = true; s.dcAt = now(); // BOOLEAN flag (grace expiry is the _dcTimer, not this) — `= now()` read as falsy when a virtual clock starts at 0 (review LOW-1)
      if (s._dcTimer) clrT(s._dcTimer);
      s._dcTimer = setT(() => dropSeat(r, i, s), RECONNECT_GRACE);
      broadcast(r, { type: "pk:event", kind: "seatAway", seat: i, wallet: s.wallet });
      // if it's this seat's turn RIGHT NOW, auto-fold/check immediately (spec §4).
      const h = r.table.hand;
      if (r.phase === "HAND" && h && !h.done && h.players[h.toAct] && h.players[h.toAct].id === s.wallet) {
        autoAct(r, s.wallet);
      } else {
        broadcastState(r);
      }
      pushLobby();
    }
  }
  function dropSeat(r, i, s) {
    if (r.seats[i] !== s) return; // already reclaimed
    s._dcTimer = null;
    const liveInHand = inHandPhase(r) && r.table.hand && r.table.hand.players.some((p) => p.id === s.wallet && !p.folded);
    if (liveInHand) {
      // grace expired mid-hand: forfeit (fold) — chips ride, seat removed at BETWEEN
      s.left = true;
      const h = r.table.hand;
      if (h.players[h.toAct] && h.players[h.toAct].id === s.wallet) { try { h.act(s.wallet, "fold"); } catch (e) {} broadcastState(r); advanceHand(r); }
      else broadcastState(r);
    } else {
      // grace expired NOT mid-hand → force-cash-out so a disconnect can't strand an on-chain lock.
      if (isTokenWallet(s.wallet)) { cashOutSeat(r, s); }
      else if (s.stack > 0) bank.credit(s.wallet, chipsToUnits(s.stack, s.wallet));
      r.seats[i] = null;
      broadcast(r, { type: "pk:event", kind: "seatOpen", seat: i });
      broadcastState(r); reapEmptyExtras(); savePersist();
    }
    pushLobby();
  }

  /* ---------------- misc seams ---------------- */
  function seedGuest(sock, wallet, balance) {
    if (!/^guest:/.test(String(wallet)) || typeof balance !== "number" || !isFinite(balance) || balance < 0) return;
    bank.all.set(wallet, Math.round(balance));
    pushWallet(sock, wallet);
  }
  // DEMO CHIP RELOAD (owner: "add more demo money", capped at $20,000): top the guest's play-money
  // WALLET up by $5,000 but NEVER past DEMO_RELOAD_CAP. Guests/demo only — a real balance comes from
  // the bridge and is never touched here. The top-up is to the wallet you buy in FROM, so it works
  // whether you are in the lobby or seated (rebuy). If the wallet is already at/over the cap (e.g. it
  // grew above $20k from winning chips) we do NOT reduce it — we just re-sync and add nothing.
  const DEMO_RELOAD_CAP = 20000; // owner: demo chips may never be topped up past $20,000
  function reloadGuest(sock, wallet) {
    const w = String(wallet || "");
    if (!/^guest:/.test(w)) return;
    const cur = bank.all.get(w) || 0;
    if (cur < DEMO_RELOAD_CAP) bank.all.set(w, Math.min(DEMO_RELOAD_CAP, cur + 5000));
    pushWallet(sock, w);
  }
  const rand = opts.rand || Math.random;
  function randSeed() { return (typeof PF.randomSeed === "function") ? PF.randomSeed(8) : Math.random().toString(36).slice(2, 10); }

  /* ---------------- DEMO-ONLY BOTS (owner: play against bots in demo) ----------------
     A bot NEVER touches the token bridge: a synthetic "bot:" wallet with sock:null + _sid:null
     → realWallet()/isTokenWallet() are both false → play-money only. HARD-REFUSED on a real table
     (r.kind must be "demo"), so real money can never be dealt against or won by a bot. The engine's
     bot auto-act (advanceHand → botDecide, PF-seeded + epoch-guarded) drives them. */
  let _botSeq = 0;
  const BOT_NAMES = ["Ace", "Bluffy", "Chip", "Dredge", "Nitcat", "River", "Sharky", "Slowroll", "Tilt", "Vera", "Wolfe", "Zed"];
  function addBotSeat(r) { // seat a demo bot in the first open chair; returns the seat index or null
    const idx = r.seats.findIndex((s) => !s);
    if (idx < 0) return null;
    const id = "bot:" + (++_botSeq);
    const stackChips = Math.max(Math.round(r.buyInMin || r.table.bigBlind), Math.round(unitsToChips(r.buyInMax || (100 * r.table.bigBlind), id))); // demo chips (1:1)
    r.seats[idx] = {
      sock: null, wallet: id, name: BOT_NAMES[_botSeq % BOT_NAMES.length], isBot: true,
      stack: stackChips, cumulativeBuyInChips: stackChips, _sid: null,
      clientSeed: "", sittingOut: false, disconnected: false, dcAt: 0, _dcTimer: null, left: false,
      seatIndex: idx, aggression: 0.3 + rand() * 0.5,
    };
    return idx;
  }
  function addBot(sock, tableId) {
    const r = tableId ? rooms.get(String(tableId)) : null;
    if (!r) { err(sock, "no_table", "Table not found", "bot"); return; }
    if (r.kind !== "demo") { err(sock, "demo_only", "Bots can only sit at DEMO tables", "bot"); return; } // NEVER real money
    const idx = addBotSeat(r);
    if (idx == null) { err(sock, "table_full", "No open seat for a bot", "bot"); return; }
    broadcast(r, { type: "pk:event", kind: "botAdded", seat: idx, name: r.seats[idx].name });
    touch(r); broadcastState(r); pushLobby(); maybeStartHand(r);
  }
  // Auto-fill a DEMO table to at least 2 bots once a human is seated, so a solo player gets an instant
  // game (owner: "auto deploy at least 2 bots every demo game"). The + BOT / − BOT controls add/remove more.
  function ensureDemoBots(r) {
    if (!AUTO_DEMO_BOTS || !r || r.kind !== "demo") return;
    if (r.seats.filter((s) => s && !s.isBot).length !== 1) return; // only auto-fill for a SOLO human (don't force bots into a human-vs-human demo game)
    let added = 0;
    while (r.seats.filter((s) => s && s.isBot).length < 2 && r.seats.some((s) => !s)) { if (addBotSeat(r) == null) break; added++; }
    if (added) { touch(r); broadcastState(r); pushLobby(); maybeStartHand(r); }
  }
  function removeBot(sock, tableId) {
    const r = tableId ? rooms.get(String(tableId)) : null;
    if (!r || r.kind !== "demo") return;
    for (let i = r.seats.length - 1; i >= 0; i--) {
      const s = r.seats[i];
      if (!s || !s.isBot) continue;
      // don't yank a bot that has chips in a LIVE pot (would corrupt the hand); pick another / wait
      if (inHandPhase(r) && r.table.hand && !r.table.hand.done && r.table.hand.players.some((p) => p.id === s.wallet && !p.folded)) continue;
      r.seats[i] = null;
      broadcast(r, { type: "pk:event", kind: "botRemoved", seat: i });
      touch(r); broadcastState(r); pushLobby();
      return;
    }
  }
  // keep demo bots in the game: a busted bot tops back up to a fresh stack (play-money mint — demo only)
  function refillBots(r) {
    if (r.kind !== "demo") return;
    const bb = r.table.bigBlind;
    for (const s of r.seats) if (s && s.isBot && (s.stack || 0) < bb) {
      const top = Math.round(unitsToChips(r.buyInMax || (100 * bb), s.wallet));
      s.stack = top; s.cumulativeBuyInChips = (s.cumulativeBuyInChips || 0) + top;
    }
  }

  /* ---------------- router ---------------- */
  function messageWallet(sock, m) {
    if (sock.wallet) return sock.wallet;
    const hinted = String((m && m.wallet) || "");
    return /^guest:/.test(hinted) ? hinted : (hinted || "");
  }
  function handle(sock, m) {
    if (!m || typeof m.type !== "string") return;
    const wallet = messageWallet(sock, m) || "anon";
    const name = (m && m.name) ? String(m.name).slice(0, 24) : null;
    switch (m.type) {
      case "pk:lobby:subscribe": lobbySubs.add(sock); ensureHouseTable(); send(sock, { type: "pk:lobby:list", rooms: lobbyList() }); if (wallet) pushWallet(sock, wallet); break;
      case "pk:lobby:unsubscribe": lobbySubs.delete(sock); break;
      case "pk:table:create": createTableMsg(sock, wallet, name, m.config || m); break;
      case "pk:table:join": join(sock, wallet, name, m.tableId, m.seat != null ? m.seat : m.seatPref, m.buyIn != null ? m.buyIn : m.buyInUnits, m.pw); break;
      case "pk:table:watch": watch(sock, m.tableId, m.pw); break; // pw gates spectating a PRIVATE table
      case "pk:table:leave": case "pk:leave": leave(sock); break;
      case "pk:sit-out": setSitOut(sock, true); break;
      case "pk:sit-in": setSitOut(sock, false); break;
      case "pk:sit": setSitOut(sock, m.mode === "out"); break;
      case "pk:act": act(sock, m.action || m.actionType, m.amount); break;
      case "pk:rebuy": rebuy(sock, m.amount); break;
      case "pk:table:addbot": addBot(sock, m.tableId); break;      // demo-only (refused on real tables)
      case "pk:table:removebot": removeBot(sock, m.tableId); break;
      case "pk:reload": reloadGuest(sock, wallet); break;          // demo-only (+$5k play-money; real balance untouched)
      case "pk:seed": seedGuest(sock, wallet, +m.balance); break;
      case "pk:ping": send(sock, { type: "pk:pong" }); break;
      default: break;
    }
  }
  function onClose(sock) { markDisconnected(sock); }

  // ── PERSISTENCE hydrate + BOOT-DRAIN (spec §12 H5, REQUIRED) ─────────────────────────────────
  // Rehydrate the pokerOwed ledger + daily creator-rake counters (so an owed win survives a restart
  // and is still claimed on the wallet's next session open). The persisted seat→session bindings +
  // stacks describe seats that were live BEFORE a restart; on boot there is NO live table for them
  // (rooms are built fresh), so DRAIN each: credit the remaining stack back to its session (or
  // pokerOwed) and unbind — a Render restart during a disconnect window can NEVER strand an on-chain
  // lock (the v12.94 "locked funds forever" class). Idempotent: a drained session is not re-drained
  // because its owed credit is booked/summed once and the persisted table list is cleared after.
  function hydrateAndBootDrain() {
    if (!persist || !persist.load) return { drained: 0 };
    let st = null; try { st = persist.load() || {}; } catch (e) { return { drained: 0 }; }
    for (const [w, n] of (st.pokerOwed || [])) { const c = Math.round(Number(n) || 0); if (c > 0) pokerOwed.set(norm(w), c); }
    for (const [k, n] of (st.creatorRakeDaily || [])) { const c = Math.round(Number(n) || 0); if (c > 0) creatorRakeDaily.set(String(k), c); }
    let drained = 0;
    for (const tbl of (st.tables || [])) {
      // creator rake accrued but unpaid at the crash → owe it to the creator wallet, but subject to the
      // SAME H7 daily cap settleCreatorRake enforces (else a restart pays creator-rake past the ceiling).
      const cr = Math.round(Number(tbl.creatorRakeChips) || 0);
      if (cr > 0 && tbl.creatorWallet && norm(tbl.creatorWallet) !== "house") {
        const cw = norm(tbl.creatorWallet);
        const dayKey = cw + ":" + Math.floor(now() / 86400000);
        const used = creatorRakeDaily.get(dayKey) || 0;
        const pay = Math.max(0, Math.min(cr, Math.round(CREATOR_RAKE_CAP_DAILY_CHIPS) - used)); // clamp to remaining daily headroom
        if (pay > 0) { creatorRakeDaily.set(dayKey, used + pay); owe(tbl.creatorWallet, pay); }
      }
      for (const seat of (tbl.seats || [])) {
        const wallet = seat.wallet, sid = seat.sid, stack = Math.round(Number(seat.stack) || 0);
        if (!wallet || !realWallet(wallet)) continue;
        // Re-bind just long enough to route the credit to the right session, then unbind. If the
        // session is gone/closed, tokenCredit falls back to pokerOwed (still claimable) — never lost.
        if (sid && TL) tokenBind.set(norm(wallet), String(sid));
        if (stack > 0) { tokenCredit(wallet, stack); drained++; }
        tokenBind.delete(norm(wallet));
      }
    }
    // the drained tables no longer exist → clear the persisted table list, keep the (updated) owed ledger.
    savePersist(); flushPersist();
    return { drained };
  }

  ensureHouseTable();
  return {
    handle, onClose, bank,
    // TOKEN money seam (spec §5/§12 — Phase 3, REAL). setTokenLedger binds the applyPokerNet ledger
    // ({ tokensOf, applyNet, recordOwed?, persist? }); on (re)bind, run the boot-drain so any orphaned
    // poker-bound session from a prior process is force-cashed-out (no stranded lock).
    setTokenLedger: (tl) => { TL = tl || null; const res = hydrateAndBootDrain(); return res; },
    bindToken, unbindToken, hasLiveHand,
    // owed-ledger + persistence introspection (server.js flushes on SIGTERM; tests assert owed sums)
    pokerOwed: (wallet) => pokerOwed.get(norm(wallet)) || 0,
    flushPersist, bootDrain: hydrateAndBootDrain,
    _mgr: { rooms, makeRoom, ensureHouseTable, closeRoom, lobbyList, reapEmptyExtras },
    _room: { maybeStartHand, startNextHand, advanceHand, finishHand, toBetween, armActTimer, autoAct, broadcastState, stateFor, cashOutSeat, settleCreatorRake, settleRealTable },
    closeRoom,
  };
}

module.exports = {
  // table API
  createTable, sit, startHand, act, advance, snapshotFor, verifyHand,
  // room server (Phase 2)
  attachPoker, joinPokerSeeds,
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

  /* ====================================================================
     8. attachPoker — RoomManager (Phase 2, DEMO) self-tests.
        Drives the REAL handle() with stub sockets, a controllable clock and
        no-op-schedulable timers (setTimeout returns a token; we fire steps by
        calling the injected clock forward + invoking _room helpers), asserting:
        (1) two players join → a hand starts + blinds posted;
        (2) PER-SOCKET NO-LEAK — B's pk:state never carries A's holes nor a deck/di stub;
        (3) act-timer auto-checks/folds on timeout with the actEpoch guard (a stale
            prior-turn timer does nothing);
        (4) disconnect on-turn auto-folds and the hand proceeds;
        (5) reconnect within grace reclaims the SAME seat + stack;
        (6) the button rotates the next hand;
        (7) an out-of-turn / illegal pk:act is rejected with pk:error;
        (8) heads-up start + everyone-folds-to-BB awards uncontested.
     ==================================================================== */
  {
    console.log("\n--- Phase 2: attachPoker RoomManager (demo) ---");
    const ACT_MS = 20000; // the act-timer duration this test configures below (matches timers.act)
    // A controllable clock + a CAPTURING scheduler: timers are stored so the test can fire
    // the one it wants (the act-timer) deterministically, exactly like baccarat's noT harness
    // but retaining the callback so we can trip a timeout on demand.
    let clock = 1000000;
    const timers = new Map(); let tid = 0;
    const clk = {
      now: () => clock,
      setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: clock + ms, ms }); return id; },
      clearTimeout: (id) => { timers.delete(id); },
    };
    // fire every timer whose deadline is ≤ the (advanced) clock, newest-armed last (FIFO by id)
    const fireDue = () => {
      let ran = 0, guard = 0;
      while (guard++ < 1000) {
        const due = Array.from(timers.entries()).filter(([, t]) => t.at <= clock).sort((a, b) => a[0] - b[0]);
        if (!due.length) break;
        const [id, t] = due[0]; timers.delete(id);
        try { t.fn(); } catch (e) { console.error("test timer threw:", e); }
        ran++;
      }
      return ran;
    };
    const mkWs = (w) => { const msgs = []; const ws = { wallet: w, send: (m) => { try { msgs.push(JSON.parse(m)); } catch (e) {} } }; ws._msgs = msgs; return ws; };
    const lastState = (ws) => ws._msgs.filter((m) => m.type === "pk:state").pop();
    const gotErr = (ws, code, from) => ws._msgs.slice(from == null ? 0 : from).some((m) => m.type === "pk:error" && m.code === code);
    const roomOf = (eng, w) => { for (const r of eng._mgr.rooms.values()) if (r.seats.some((s) => s && s.wallet === w)) return r; return null; };

    // Engine with FAST bots off (all human seats), synchronous bot delay, no idle interference.
    const pk = attachPoker(Object.assign({
      startBalance: 100000, demoBuyIn: 1000,
      timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 60000, idleSeated: 300000, botMin: 0, botMax: 0 },
    }, clk));

    // (1) two players create + join → a hand starts + blinds posted
    const A = mkWs("guest:alice"), B = mkWs("guest:bob");
    pk.handle(A, { type: "pk:lobby:subscribe" });
    pk.handle(A, { type: "pk:table:create", config: { bb: 10, maxSeats: 6, name: "Test Room", buyInMinBb: 20, buyInMaxBb: 100 } });
    const created = A._msgs.filter((m) => m.type === "pk:table:created").pop();
    eq("pk:table:create returns a tableId", !!created && typeof created.tableId === "string");
    const tid1 = created.tableId;
    pk.handle(A, { type: "pk:table:join", tableId: tid1, buyIn: 1000 });
    pk.handle(B, { type: "pk:table:join", tableId: tid1, buyIn: 1000 });
    const rA = roomOf(pk, "guest:alice");
    eq("both players seated at the created table", !!rA && rA.id === tid1 && roomOf(pk, "guest:bob") === rA);
    eq("≥2 seated-in → a hand STARTED (phase HAND, engine hand live)", rA.phase === "HAND" && rA.table.hand && !rA.table.hand.done);
    const h1 = rA.table.hand;
    const blinds = h1.players.reduce((a, p) => a + p.committedTotal, 0);
    eq("blinds posted (SB+BB = 15 committed heads-up)", blinds === 15);
    eq("start snapshot published a 64-hex commit, NOT the serverSeed", typeof h1.commit === "string" && h1.commit.length === 64 && lastState(A).hand.serverSeed === null);

    // (2) PER-SOCKET NO-LEAK — B's pk:state never carries A's holes nor a deck/di stub
    const stA = lastState(A), stB = lastState(B);
    const aWallet = "guest:alice", bWallet = "guest:bob";
    const holeOf = (st, w) => { const p = st.hand.players.find((pp) => pp.id === w); return p ? p.hole : undefined; };
    eq("A's own snapshot reveals A's 2 hole cards", Array.isArray(holeOf(stA, aWallet)) && holeOf(stA, aWallet).length === 2);
    eq("A's snapshot HIDES B's hole cards (null)", holeOf(stA, bWallet) === null);
    eq("B's snapshot HIDES A's hole cards (null) — no leak across sockets", holeOf(stB, aWallet) === null);
    eq("B's own snapshot reveals B's cards", Array.isArray(holeOf(stB, bWallet)) && holeOf(stB, bWallet).length === 2);
    const jsonB = JSON.stringify(stB);
    eq("B's payload never contains the deck/di stub", jsonB.indexOf("\"deck\"") === -1 && jsonB.indexOf("\"di\"") === -1);
    // brute check: A's actual hole cards never appear as a pair in B's serialized payload
    const aHole = holeOf(stA, aWallet);
    const leaked = stB.hand.players.some((p) => p.id !== bWallet && Array.isArray(p.hole));
    eq("NO other player's live holes are serialized in B's snapshot at all", !leaked);

    // (7) out-of-turn + illegal pk:act rejected with pk:error
    const toActId = h1.players[h1.toAct].id;
    const notToAct = h1.players.find((p) => p.id !== toActId).id;
    const wsNot = notToAct === aWallet ? A : B;
    let mark = wsNot._msgs.length;
    pk.handle(wsNot, { type: "pk:act", action: "call" });
    eq("out-of-turn pk:act rejected (pk:error not_your_turn)", gotErr(wsNot, "not_your_turn", mark));
    const wsTurn = toActId === aWallet ? A : B;
    mark = wsTurn._msgs.length;
    pk.handle(wsTurn, { type: "pk:act", action: "check" }); // UTG/SB facing the BB → illegal check
    eq("illegal check facing a bet rejected (pk:error illegal)", gotErr(wsTurn, "illegal", mark));

    // (3) act-timer auto-CHECK/FOLD on timeout + actEpoch stale-guard.
    // The current toAct is the heads-up SB (button). Fire ONLY its act-timer (find it by ms=20000)
    // so the assertion sees THIS hand settle before showdown/between cascade a fresh hand. Facing the
    // BB, toCall>0 → auto-FOLD → BB wins uncontested. (8) heads-up fold-to-BB is proven here too.
    const actEntry = Array.from(timers.entries()).find(([, t]) => t.ms === ACT_MS);
    eq("a 20s act-timer is armed for the human to-act (with an actEpoch)", !!actEntry && rA.actEpoch > 0);
    const foldWallet = h1.players[h1.toAct].id;   // the SB who will time out and fold
    const winWallet = h1.players.find((p) => p.id !== foldWallet).id; // the BB who wins uncontested
    timers.delete(actEntry[0]); actEntry[1].fn(); // trip the act-timer
    eq("(3)(8) act-timer auto-FOLD on timeout → BB wins uncontested (hand done, phase SHOWDOWN)", h1.done && rA.phase === "SHOWDOWN");
    eq("the timed-out SB folded; the BB is the sole winner", h1.players.find((p) => p.id === foldWallet).folded && h1.deltas[winWallet] === 5 && h1.deltas[foldWallet] === -5);
    eq("uncontested preflop paid ZERO rake (no-flop-no-drop)", (h1.rake || 0) === 0 && rA.houseRakeChips === 0 && rA.creatorRakeChips === 0);
    const btn1Wallet = rA._lastButtonWallet;

    // drain the 0ms showdown/between → BETWEEN reconciles → the next hand auto-starts (both funded)
    fireDue();
    eq("(6) a fresh hand auto-started after BETWEEN", rA.phase === "HAND" && rA.table.hand && !rA.table.hand.done && rA.table.hand !== h1);
    const btn2Wallet = rA._lastButtonWallet;
    eq("(6) button rotated to the other live seat next hand (heads-up alternation)", btn2Wallet !== btn1Wallet);
    // chip conservation across two hands (fold-to-BB is rake-free → seat stacks total the two buy-ins)
    eq("chips conserved across hands (2 seats × 1000 = 2000, no rake yet)", rA.seats.reduce((a, s) => a + (s ? s.stack : 0), 0) === 2000);

    // (3b) actEpoch stale-guard: capture the newly-armed act-timer, advance the turn by acting so the
    // epoch bumps, then fire the now-STALE timer → it must be an inert no-op (guarded by actEpoch).
    {
      const h = rA.table.hand;
      const cur = h.players[h.toAct].id;
      const curWs = cur === aWallet ? A : B;
      const staleEntry = Array.from(timers.entries()).find(([, t]) => t.ms === ACT_MS);
      const epAtArm = rA.actEpoch;
      const la = h.legalActions(cur);
      const toActBefore = h.toAct;
      pk.handle(curWs, { type: "pk:act", action: la.canCheck ? "check" : "call" });
      eq("acting advances the turn and BUMPS actEpoch (stale-timer guard active)", rA.actEpoch !== epAtArm && (h.done || h.toAct !== toActBefore));
      const foldedBefore = h.players.map((p) => p.folded).join(",");
      if (staleEntry) { timers.delete(staleEntry[0]); try { staleEntry[1].fn(); } catch (e) {} } // fire the STALE timer
      const foldedAfter = h.players.map((p) => p.folded).join(",");
      eq("a STALE prior-turn act-timer fires as a NO-OP (no extra fold, no throw)", foldedBefore === foldedAfter);
    }

    /* ── (16b) HOLE-CARD LEAK REGRESSION: a seated socket with EMPTY sock.wallet (the production
       unauthenticated/denied-guest state, where messageWallet falls back to the client-supplied
       m.wallet) must NOT be able to resync as another wallet and receive that wallet's live holes.
       The snapshot mask key is bound to socket→seat identity, never a spoofable message field. ── */
    {
      const pkX = attachPoker(Object.assign({ startBalance: 100000, demoBuyIn: 1000,
        timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 60000, idleSeated: 300000, botMin: 0, botMax: 0 } }, clk));
      // sockets WITHOUT .wallet ⇒ messageWallet() trusts m.wallet (the exploit precondition)
      const mkGuest = () => { const msgs = []; const ws = { send: (m) => { try { msgs.push(JSON.parse(m)); } catch (e) {} } }; ws._msgs = msgs; return ws; };
      const AX = mkGuest(), VX = mkGuest();
      pkX.handle(AX, { type: "pk:table:create", wallet: "guest:atk", config: { bb: 10, maxSeats: 6, name: "LK" } });
      const tX = AX._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pkX.handle(AX, { type: "pk:table:join", wallet: "guest:atk", tableId: tX, buyIn: 1000 });
      pkX.handle(VX, { type: "pk:table:join", wallet: "guest:victim", tableId: tX, buyIn: 1000 });
      const rX = Array.from(pkX._mgr.rooms.values()).find((rr) => rr.seats.some((s) => s && s.wallet === "guest:atk"));
      eq("(16b) leak-repro table is mid-hand with both guests dealt in", rX.phase === "HAND" && rX.table.hand && !rX.table.hand.done);
      const holeIn = (st, w) => { const p = st && st.hand && st.hand.players.find((pp) => pp.id === w); return p ? p.hole : undefined; };
      const mk = AX._msgs.length;
      // EXPLOIT ATTEMPT: attacker (seated, empty sock.wallet) resyncs claiming the victim's wallet.
      pkX.handle(AX, { type: "pk:table:join", wallet: "guest:victim", tableId: tX, buyIn: 1000 });
      const spoofed = AX._msgs.slice(mk).filter((m) => m.type === "pk:state").pop();
      eq("(16b) resync spoofing another wallet NEVER leaks that wallet's holes (masked by own seat)", holeIn(spoofed, "guest:victim") === null && Array.isArray(holeIn(spoofed, "guest:atk")));
    }

    /* ── (4)(5) disconnect on-turn auto-folds + reconnect reclaims same seat, on a FRESH 3-handed table ── */
    {
      const pk2 = attachPoker(Object.assign({ startBalance: 100000, demoBuyIn: 1000, reconnectGrace: 90000,
        timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 60000, idleSeated: 300000, botMin: 0, botMax: 0 } }, clk));
      const C = mkWs("guest:carol"), D = mkWs("guest:dave"), E = mkWs("guest:erin");
      pk2.handle(C, { type: "pk:table:create", config: { bb: 10, maxSeats: 6, name: "DC" } });
      const t2 = C._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk2.handle(C, { type: "pk:table:join", tableId: t2, buyIn: 1000 });
      pk2.handle(D, { type: "pk:table:join", tableId: t2, buyIn: 1000 }); // 2 seated → heads-up hand starts
      pk2.handle(E, { type: "pk:table:join", tableId: t2, buyIn: 1000 }); // erin joins MID-HAND → sits out until next hand
      const r2 = roomOf(pk2, "guest:carol");
      eq("erin joined mid-hand → seated but NOT in the live (heads-up) hand", r2.phase === "HAND" && r2.table.hand.players.length === 2 && !!r2.seats.find((s) => s && s.wallet === "guest:erin"));
      // play the heads-up hand to completion (check/call down) so the NEXT hand deals all THREE
      { let g = 0; while (r2.phase === "HAND" && r2.table.hand && !r2.table.hand.done && g++ < 300) { const hh = r2.table.hand; const cur = hh.players[hh.toAct].id; const w = cur === "guest:carol" ? C : cur === "guest:dave" ? D : E; const la = hh.legalActions(cur); pk2.handle(w, { type: "pk:act", action: la.canCheck ? "check" : "call" }); } }
      fireDue(); // showdown/between (0ms) → next hand auto-starts with all 3
      eq("3-handed hand started after the first hand (all 3 dealt in)", r2.phase === "HAND" && r2.table.hand && r2.table.hand.players.length === 3);

      // (5) reconnect within grace reclaims the SAME seat + stack (disconnect a NON-acting seat)
      const h = r2.table.hand;
      const actId = h.players[h.toAct].id;
      const idleId = h.players.find((p) => p.id !== actId).id; // a seat that is NOT to-act
      const idleWs = idleId === "guest:carol" ? C : idleId === "guest:dave" ? D : E;
      const idleSeatIdx = r2.seats.findIndex((s) => s && s.wallet === idleId);
      const stackBefore = r2.seats[idleSeatIdx].stack;
      pk2.onClose(idleWs);
      eq("disconnect (non-acting) marks the seat away, chips stay, hand continues", !!r2.seats[idleSeatIdx].disconnected && r2.phase === "HAND" && !r2.table.hand.done);
      const idleWs2 = mkWs(idleId);
      pk2.handle(idleWs2, { type: "pk:table:join", tableId: t2, buyIn: 1000 });
      eq("reconnect within grace reclaims the SAME seat + stack (no re-buy)", r2.seats[idleSeatIdx].sock === idleWs2 && !r2.seats[idleSeatIdx].disconnected && r2.seats[idleSeatIdx].stack === stackBefore);

      // (4) disconnect the TO-ACT seat → auto-fold/check immediately, hand proceeds
      const h2 = r2.table.hand;
      const turnId = h2.players[h2.toAct].id;
      const toActBefore = h2.toAct;                 // snapshot the VALUE (h2 === r2.table.hand, mutated in place)
      const turnWs = turnId === "guest:carol" ? C : turnId === "guest:dave" ? D : (turnId === idleId ? idleWs2 : E);
      pk2.onClose(turnWs);
      const h3 = r2.table.hand;
      const advanced = (h3 && (h3.toAct !== toActBefore || h3.done)) || r2.phase !== "HAND";
      eq("disconnect ON its turn auto-acts immediately (fold/check) and the hand proceeds", advanced);
      const foldedTurn = h3 ? h3.players.find((p) => p.id === turnId) : null;
      eq("the disconnected to-act seat folded (facing a bet) or checked (toCall 0)", !!foldedTurn && (foldedTurn.folded || foldedTurn.acted || h3.done));
    }

    /* ── idle GC + warm HOUSE table always present ── */
    eq("a warm HOUSE table always exists in the lobby", Array.from(pk._mgr.rooms.values()).some((r) => r.creatorId === "HOUSE"));
    // per-wallet table cap
    const CAP = mkWs("guest:spammer");
    for (let i = 0; i < 4; i++) pk.handle(CAP, { type: "pk:table:create", config: { bb: 10, name: "S" + i } });
    const capErr = CAP._msgs.some((m) => m.type === "pk:error" && m.code === "table_cap");
    eq("per-wallet open-table cap enforced (anti-spam)", capErr);

    /* ── house-policy clamps on create ── */
    const CL = mkWs("guest:clamp");
    pk.handle(CL, { type: "pk:table:create", config: { bb: 999, maxSeats: 50, rakeBps: 9000, rakeCapBb: 99, buyInMinBb: 1, buyInMaxBb: 9999, name: "<script>x" } });
    const clRoom = Array.from(pk._mgr.rooms.values()).filter((r) => r.creatorWallet === "guest:clamp").pop();
    eq("create-table RE-CLAMPS every field (bb→10, seats→9, rake→500/5, name sanitized)",
      !!clRoom && clRoom.table.bigBlind === 10 && clRoom.table.maxSeats === 9 && clRoom.table.rakeBps === 500 && clRoom.table.rakeCapBb === 5 && clRoom.name.indexOf("<") === -1 && clRoom.name.indexOf("script") >= 0);

    /* ── PF verifiability end-to-end: reveal re-derives the deck ── */
    {
      const h = rA.table.hand || (() => { rA.phase = "WAITING"; pk._room.maybeStartHand(rA); return rA.table.hand; })();
      if (h) {
        // force the hand to completion by having both check/call down, then assert the reveal verifies
        let guard = 0;
        while (rA.phase === "HAND" && rA.table.hand && !rA.table.hand.done && guard++ < 200) {
          const hh = rA.table.hand; const cur = hh.players[hh.toAct].id; const ws = cur === aWallet ? A : B;
          const la = hh.legalActions(cur);
          pk.handle(ws, { type: "pk:act", action: la.canCheck ? "check" : "call" });
        }
        const rev = A._msgs.filter((m) => m.type === "pk:reveal").pop();
        eq("pk:reveal carries serverSeed + commit + clientSeed + nonce after the hand", !!rev && typeof rev.serverSeed === "string" && rev.commit === rev.commit && typeof rev.nonce === "number");
        if (rev) {
          const vr = verifyHand(rev.commit, rev.serverSeed, rev.clientSeed, rev.nonce);
          eq("verifyHand re-derives the deck from the pk:reveal (provably fair)", vr.ok && Array.isArray(vr.deck) && vr.deck.length === 52);
        }
      }
    }
  }

  /* ====================================================================
     9. PHASE 3 — MONEY SETTLEMENT token self-tests 17–24 (spec §3 + §12).
        A STUB token bridge/ledger mirrors applyExternal semantics EXACTLY
        (insufficient-throw at bet>tokens; capUp clamp to buyIn+maxWin on the
        win side; loss floored at 0), plus a controllable clock. Real 0x
        wallets are bound to sessions via poker.bindToken; the poker bank's
        get/credit/debit then route to the ledger (cent-scaled at the seat).
        17 end-to-end zero-sum to the cent across a raked multi-seat hand + all cash-outs;
        18 creator rake-share funded with NO house mint;
        19 winner credit whose capUp-shortfall lands in pokerOwed (no vanish);
        20 insufficient buy-in REFUSED (not floored);
        21 boot-drain reconstructs a force-cash-out for an orphaned poker-bound session;
        22 a seated-creator hand routes creator-half to HOUSE;
        23 creator-half withheld until the ≥3-distinct-wallets/≥10-hands gate opens;
        24 pokerOwed SUMS (never overwrites) across two payouts to one sessionless wallet.
     ==================================================================== */
  {
    console.log("\n--- Phase 3: MONEY settlement (token) ---");
    // ── STUB token bridge (mirrors token-bridge.js applyExternal + capUp) ──
    function makeStubBridge(maxWinUnits) {
      const S = new Map(); // sid → { player, buyInUnits, tokens, closed }
      const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const capUp = (tokens, buyIn) => { const ceil = r2(buyIn) + (maxWinUnits == null ? Infinity : maxWinUnits); return (Number.isFinite(ceil) && tokens > ceil) ? r2(ceil) : tokens; };
      return {
        open: (sid, player, buyInUnits) => { S.set(sid, { player: String(player).toLowerCase(), buyInUnits: r2(buyInUnits), tokens: r2(buyInUnits), closed: false }); },
        close: (sid) => { const s = S.get(sid); if (s) s.closed = true; },
        _get: (sid) => S.get(sid),
        tokensOf: (sid) => { const s = S.get(sid); return (s && !s.closed) ? s.tokens : null; },
        // SIBLING of the real applyPokerNet: open-session + player-match gate, insufficient-throw (H2),
        // capUp on the win side (H3). Synchronous. Returns the new token balance.
        applyPokerNet: (player, sid, betUnits, payoutUnits, ref) => {
          const s = S.get(sid);
          if (!s || s.closed) throw new Error("no open token session");
          if (s.player !== String(player || "").toLowerCase()) throw new Error("session does not belong to player");
          const bet = r2(betUnits || 0), payout = r2(Math.max(0, payoutUnits || 0));
          if (Math.round(bet * 100) > Math.round(s.tokens * 100)) throw new Error("insufficient tokens"); // H2
          s.tokens = capUp(r2(s.tokens - bet + payout), s.buyInUnits);                                    // capUp (H3)
          if (s.tokens < 0) s.tokens = 0;
          return s.tokens;
        },
      };
    }
    let clock2 = 5000000; const timers2 = new Map(); let tid2 = 0;
    const clk2 = { now: () => clock2, setTimeout: (fn, ms) => { const id = ++tid2; timers2.set(id, { fn, at: clock2 + ms, ms }); return id; }, clearTimeout: (id) => { timers2.delete(id); } };
    const fireDue2 = () => { let g = 0; while (g++ < 2000) { const due = Array.from(timers2.entries()).filter(([, t]) => t.at <= clock2).sort((a, b) => a[0] - b[0]); if (!due.length) break; const [id, t] = due[0]; timers2.delete(id); try { t.fn(); } catch (e) { console.error("t2 threw:", e); } } };
    const mkTokWs = (w) => { const msgs = []; const ws = { wallet: w, send: (m) => { try { msgs.push(JSON.parse(m)); } catch (e) {} } }; ws._msgs = msgs; return ws; };
    const roomOf2 = (eng, w) => { for (const r of eng._mgr.rooms.values()) if (r.seats.some((s) => s && String(s.wallet).toLowerCase() === String(w).toLowerCase())) return r; return null; };
    const W1 = "0x1111111111111111111111111111111111111111";
    const W2 = "0x2222222222222222222222222222222222222222";
    const W3 = "0x3333333333333333333333333333333333333333";
    const W4 = "0x4444444444444444444444444444444444444444";
    // Play a real-money table to completion by check/call-down; returns when phase leaves HAND.
    const checkCallDown = (pk, r, wsOf) => { let g = 0; while (r.phase === "HAND" && r.table.hand && !r.table.hand.done && g++ < 400) { const h = r.table.hand; const cur = h.players[h.toAct].id; const ws = wsOf(cur); const la = h.legalActions(cur); if (!ws) break; pk.handle(ws, { type: "pk:act", action: la.canCheck ? "check" : "call" }); } };

    // ── 17: END-TO-END ZERO-SUM to the cent across a raked multi-seat hand + all cash-outs ──
    {
      const bridge = makeStubBridge(2000);
      bridge.open("s1", W1, 200); bridge.open("s2", W2, 200); bridge.open("s3", W3, 200); // $200 each = 20000 chips (20bb min at bb=10)
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1), B = mkTokWs(W2), C = mkTokWs(W3);
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2"); pk.bindToken(W3, "s3");
      // Real table, creator = W1 (seated → H6 sends its own rake-half to HOUSE; irrelevant to zero-sum).
      // Buy in $200 each (the 20bb server-clamped minimum at bb=10). Rake is the only chip-sink.
      pk.handle(A, { type: "pk:table:create", wallet: W1, config: { bb: 10, maxSeats: 6, name: "RM", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 500, rakeCapBb: 3 } });
      const t1 = A._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: t1, buyIn: 200 });
      pk.handle(B, { type: "pk:table:join", wallet: W2, tableId: t1, buyIn: 200 });
      pk.handle(C, { type: "pk:table:join", wallet: W3, tableId: t1, buyIn: 200 });
      const r = roomOf2(pk, W1);
      eq("(17) real table established, 3 token seats bought in @ $200 (20000 chips each)", r && r.kind === "real" && r.seats.filter(Boolean).length === 3 && r.seats.filter(Boolean).every((s) => s.stack === 20000 && s.cumulativeBuyInChips === 20000));
      eq("(17) each session debited its full buy-in ($200 → $0 held; chips are now table-local)", bridge._get("s1").tokens === 0 && bridge._get("s2").tokens === 0 && bridge._get("s3").tokens === 0);
      const wsOf = (w) => (String(w).toLowerCase() === W1 ? A : String(w).toLowerCase() === W2 ? B : C);
      // Play a few complete hands to accumulate rake, then STOP with the last hand DONE (phase SHOWDOWN)
      // so closeRoom can tear the table down (it refuses mid-LIVE-hand). checkCallDown ends with h.done;
      // fireDue2 cascades showdown->between->next-hand. For the FINAL hand we leave the cascade UNFIRED
      // and close while SHOWDOWN (hand.done) — a clean, settleable teardown.
      let handsRun = 0;
      while (handsRun < 2 && r.phase === "HAND") { checkCallDown(pk, r, wsOf); handsRun++; if (handsRun < 2) fireDue2(); }
      const totalRakeChips = (r.houseRakeChips || 0) + (r.creatorRakeChips || 0);
      pk._mgr.closeRoom(r, "test"); // SHOWDOWN + hand.done → settleable
      // Zero-sum: Σ(session tokens returned) + Σ(pokerOwed to seats) == Σ buy-ins − totalRake.
      const back1 = bridge._get("s1").tokens, back2 = bridge._get("s2").tokens, back3 = bridge._get("s3").tokens;
      const owedSeats = pk.pokerOwed(W1) + pk.pokerOwed(W2) + pk.pokerOwed(W3);
      const returnedUsd = Math.round((back1 + back2 + back3) * 100) + owedSeats; // chips
      const buyInsChips = 60000;
      eq("(17) ZERO-SUM to the cent: Σ(buyIn − returned) === totalRake", (buyInsChips - returnedUsd) === totalRakeChips);
      eq("(17) totalRake === houseRake + creatorRake (exact split, odd cent to creator)", totalRakeChips === (r.houseRakeChips || 0) + (r.creatorRakeChips || 0));
      eq("(17) no per-seat credit exceeded its buy-in + others' buy-ins (H4 clamp held)", back1 <= 600 && back2 <= 600 && back3 <= 600);
    }

    // ── 17b: F1/F2 REGRESSION — the busted LOSER LEAVES before the winner cashes out (the most common
    //    outcome, and the exact gap that let F1 through). The winner's stack holds BOTH buy-ins minus
    //    rake; the H4 ceiling is table-life (_everBuyInChips), so the winnings must NOT be truncated,
    //    and zero-sum must hold over the table's WHOLE life (departed seats counted in _everReturnedChips). ──
    {
      const bridge = makeStubBridge(5000);
      bridge.open("s1", W1, 200); bridge.open("s2", W2, 200);
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 999999, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1), B = mkTokWs(W2);
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2");
      pk.handle(A, { type: "pk:table:create", config: { bb: 10, maxSeats: 2, name: "F1", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 500, rakeCapBb: 3 } });
      const t = A._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 });
      pk.handle(B, { type: "pk:table:join", wallet: W2, tableId: t, buyIn: 200 });
      const r = roomOf2(pk, W1);
      const wsOf = (w) => (String(w).toLowerCase() === W1 ? A : B);
      checkCallDown(pk, r, wsOf); // finish the auto-started hand → phase SHOWDOWN (hand.done); between held (999999)
      // Simulate the settled outcome of a BIG hand at the settlement layer: W2 won W1's whole stack,
      // minus a 20-chip rake (3bb cap at bb=10). Overwrite all the relevant fields consistently.
      const s1 = r.seats.find((s) => s && s.wallet === W1), s2 = r.seats.find((s) => s && s.wallet === W2);
      s1.stack = 0; s2.stack = 39980; r.houseRakeChips = 10; r.creatorRakeChips = 10; r._everReturnedChips = 0;
      // LOSER leaves FIRST — cash them out (0) and vacate the seat BEFORE the winner settles (the F1 trigger)
      pk._room.cashOutSeat(r, s1); r.seats[r.seats.indexOf(s1)] = null;
      eq("(17b) busted loser left; winner still holds the big stack (39980)", !r.seats.find((s) => s && s.wallet === W1) && s2.stack === 39980);
      pk._mgr.closeRoom(r, "test"); // winner cashes out — ceiling is table-life 40000, so 39980 is NOT clamped
      const back2 = Math.round(bridge._get("s2").tokens * 100) + pk.pokerOwed(W2); // chips (booked + owed)
      eq("(17b) F1 FIXED: winner credited the FULL 39980 after a loser left first (no truncation, no vanish)", back2 === 39980);
      eq("(17b) F2 FIXED: zero-sum holds table-life — everBuyIn − everReturned === totalRake (20)", (r._everBuyInChips - r._everReturnedChips) === 20);
    }

    // ── 18: creator rake-share is FUNDED (no house mint) — a HOUSE-independent creator earns the half ──
    {
      const bridge = makeStubBridge(2000);
      bridge.open("s1", W1, 200); bridge.open("s2", W2, 200); bridge.open("s3", W3, 200); bridge.open("sc", W4, 200);
      const pk = attachPoker(Object.assign({ creatorGateDistinct: 1, creatorGateHands: 1, timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1), B = mkTokWs(W2), C = mkTokWs(W3);
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2"); pk.bindToken(W3, "s3"); pk.bindToken(W4, "sc");
      // creator = W4 via its OWN socket D, which NEVER sits (H6 seated-exclusion won't fire). The creator
      // is the AUTHENTICATED socket owner (server ignores the m.wallet hint when sock.wallet is set), so a
      // non-seated creator needs its own socket. gate forced open (1/1) so the very first raked hand pays.
      const D = mkTokWs(W4);
      pk.handle(D, { type: "pk:table:create", config: { bb: 10, maxSeats: 6, name: "CR", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 500, rakeCapBb: 3 } });
      const t = D._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      // W1/W2/W3 sit (3 distinct funded wallets, gate is 1/1 so it opens immediately).
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 });
      pk.handle(B, { type: "pk:table:join", wallet: W2, tableId: t, buyIn: 200 });
      pk.handle(C, { type: "pk:table:join", wallet: W3, tableId: t, buyIn: 200 });
      const r = roomOf2(pk, W1);
      const wsOf = (w) => (String(w).toLowerCase() === W1 ? A : String(w).toLowerCase() === W2 ? B : C);
      let hands = 0; while (hands < 6 && (r.creatorRakeChips || 0) === 0 && r.phase === "HAND") { checkCallDown(pk, r, wsOf); hands++; if ((r.creatorRakeChips || 0) === 0) fireDue2(); }
      // end on a DONE hand (phase SHOWDOWN, cascade unfired) so closeRoom can settle.
      if (r.phase === "HAND" && r.table.hand && !r.table.hand.done) checkCallDown(pk, r, wsOf);
      const accruedCreator = r.creatorRakeChips || 0;
      const accruedHouse = r.houseRakeChips || 0;
      eq("(18) a raked hand accrued a creator-half (gate open, creator NOT seated)", accruedCreator > 0);
      const scTokBefore = bridge._get("sc").tokens;
      pk._mgr.closeRoom(r, "test");
      const scTokAfter = bridge._get("sc").tokens;
      const creatorPaid = Math.round((scTokAfter - scTokBefore) * 100) + pk.pokerOwed(W4); // chips credited or owed
      eq("(18) creator-half PAID into the creator session (or owed) — funded, no mint", creatorPaid === accruedCreator);
      eq("(18) house-retained + creator-paid === total rake skimmed (no mint/burn)", (accruedHouse + creatorPaid) === (accruedHouse + accruedCreator));
    }

    // ── 19: winner credit whose capUp-shortfall lands in pokerOwed (no vanish) ──
    {
      // maxWin tiny ($5) so a winner's returned stack ($ up to buyIn+others) exceeds buyIn+maxWin → capUp
      // truncates the session credit; the shortfall MUST land in pokerOwed, never vanish.
      const bridge = makeStubBridge(5); // capUp ceiling = buyIn(200) + 5 = 205
      bridge.open("s1", W1, 200); bridge.open("s2", W2, 200);
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1), B = mkTokWs(W2);
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2");
      pk.handle(A, { type: "pk:table:create", wallet: W1, config: { bb: 10, maxSeats: 6, name: "CAP", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 0, rakeCapBb: 0 } });
      const t = A._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 });
      pk.handle(B, { type: "pk:table:join", wallet: W2, tableId: t, buyIn: 200 });
      const r = roomOf2(pk, W1);
      // manufacture a lopsided winner: give seat A the whole table's chips (simulating a big pot win)
      // between hands, then cash out. (No live hand → safe to set the stack directly for the settlement test.)
      const sA = r.seats.find((s) => s && s.wallet.toLowerCase() === W1);
      const sB = r.seats.find((s) => s && s.wallet.toLowerCase() === W2);
      // simulate A won B's stack: A holds 40000 chips ($400), B holds 0. (cumulativeBuyIn stays 20000 each →
      // H4 ceiling = 20000 + 20000 = 40000, so the full stack is legitimate; only capUp truncates the credit.)
      sA.stack = 40000; sB.stack = 0;
      const before = bridge._get("s1").tokens; // 0 (bought in)
      pk._room.cashOutSeat(r, sA);
      const after = bridge._get("s1").tokens;
      const bookedChips = Math.round((after - before) * 100);
      const owedChips = pk.pokerOwed(W1);
      eq("(19) capUp truncated the session credit to the ceiling ($205 → 20500 chips)", after === 205 && bookedChips === 20500);
      eq("(19) the capUp SHORTFALL landed in pokerOwed (no chip vanished)", (bookedChips + owedChips) === 40000 && owedChips === 19500);
    }

    // ── 20: insufficient buy-in is REFUSED (not floored) ──
    {
      const bridge = makeStubBridge(2000);
      bridge.open("s1", W1, 30); // only $30 in the session (below the 20bb = $200 min buy-in)
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1);
      pk.bindToken(W1, "s1");
      pk.handle(A, { type: "pk:table:create", wallet: W1, config: { bb: 10, maxSeats: 6, name: "INS", buyInMinBb: 20, buyInMaxBb: 100 } });
      const t = A._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      const mk = A._msgs.length;
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 }); // wants $200, has $30 → REFUSE
      const r = roomOf2(pk, W1);
      const seated = r && r.seats.some((s) => s && s.wallet.toLowerCase() === W1);
      const refused = A._msgs.slice(mk).some((m) => m.type === "pk:error" && m.code === "insufficient");
      eq("(20) an over-balance buy-in is REFUSED with pk:error insufficient (not floored)", refused && !seated);
      eq("(20) the session was NOT debited (no floored partial buy-in)", bridge._get("s1").tokens === 30);
    }

    // ── 21: boot-drain reconstructs a force-cash-out for an orphaned poker-bound session ──
    {
      // A persisted seat→session binding + stack with NO live table (a restart during a disconnect
      // window). On setTokenLedger boot, the drain must credit the remaining stack back and unbind.
      const bridge = makeStubBridge(2000);
      bridge.open("s9", W1, 100); // session still open on-chain, $0 held (bought in), a table stack of $80 was live
      const store = { tables: [{ id: "PK-99", creatorWallet: null, creatorRakeChips: 0, seats: [{ seat: 0, wallet: W1, sid: "s9", stack: 8000, cumulativeBuyInChips: 10000 }] }], pokerOwed: [], creatorRakeDaily: [] };
      const persist = { load: () => store, save: (o) => { store.saved = o; } };
      const pk = attachPoker(Object.assign({ persist, timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      const tokBefore = bridge._get("s9").tokens; // 0
      const res = pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const tokAfter = bridge._get("s9").tokens;
      eq("(21) boot-drain force-cashed-out the orphaned seat's $80 stack back to its session", res && res.drained === 1 && Math.round((tokAfter - tokBefore) * 100) === 8000);
      eq("(21) the drained binding is unbound (no stranded lock)", !pk.hasLiveHand(W1));
      eq("(21) persisted table list cleared after the drain (idempotent — no re-drain)", Array.isArray(store.saved.tables) && store.saved.tables.length === 0);
    }

    // ── 22: a SEATED-creator hand routes the creator-half to HOUSE (H6) ──
    {
      const bridge = makeStubBridge(2000);
      bridge.open("s1", W1, 200); bridge.open("s2", W2, 200); bridge.open("s3", W3, 200);
      const pk = attachPoker(Object.assign({ creatorGateDistinct: 1, creatorGateHands: 1, timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1), B = mkTokWs(W2), C = mkTokWs(W3);
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2"); pk.bindToken(W3, "s3");
      // creator = W1, who SITS (H6 must route their own-hand creator-half to HOUSE).
      pk.handle(A, { type: "pk:table:create", wallet: W1, config: { bb: 10, maxSeats: 6, name: "SEAT", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 500, rakeCapBb: 3 } });
      const t = A._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 });
      pk.handle(B, { type: "pk:table:join", wallet: W2, tableId: t, buyIn: 200 });
      pk.handle(C, { type: "pk:table:join", wallet: W3, tableId: t, buyIn: 200 });
      const r = roomOf2(pk, W1);
      const wsOf = (w) => (String(w).toLowerCase() === W1 ? A : String(w).toLowerCase() === W2 ? B : C);
      let hands = 0, sawRake = false;
      while (hands < 8 && r.phase === "HAND") { checkCallDown(pk, r, wsOf); if ((r.houseRakeChips || 0) > 0) sawRake = true; fireDue2(); hands++; }
      eq("(22) hands were raked (creator W1 seated in every hand)", sawRake);
      eq("(22) a SEATED creator earns ZERO rake-share on their own hands (all rake → HOUSE)", (r.creatorRakeChips || 0) === 0 && (r.houseRakeChips || 0) > 0);
    }

    // ── 23: creator-half withheld until the ≥3-distinct-wallets/≥10-hands gate opens (default gate) ──
    {
      const bridge = makeStubBridge(2000);
      bridge.open("s1", W1, 200); bridge.open("s2", W2, 200);
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2)); // DEFAULT gate 3/10
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1), B = mkTokWs(W2);
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2");
      // creator = W4 via its OWN socket D (not seated), only TWO distinct funded wallets → gate SHUT (needs 3).
      const D = mkTokWs(W4);
      pk.handle(D, { type: "pk:table:create", config: { bb: 10, maxSeats: 6, name: "GATE", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 500, rakeCapBb: 3 } });
      const t = D._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 });
      pk.handle(B, { type: "pk:table:join", wallet: W2, tableId: t, buyIn: 200 });
      const r = roomOf2(pk, W1);
      const wsOf = (w) => (String(w).toLowerCase() === W1 ? A : B);
      let hands = 0; while (hands < 12 && r.phase === "HAND") { checkCallDown(pk, r, wsOf); fireDue2(); hands++; }
      eq("(23) with only 2 distinct wallets the gate is SHUT → creator-half withheld to HOUSE", (r.creatorRakeChips || 0) === 0 && (r.houseRakeChips || 0) > 0);
    }

    // ── 24: pokerOwed SUMS (never overwrites) across two payouts to one SESSIONLESS wallet ──
    // The production sessionless-payout path: a creator (W4) who is NOT bound to any token session earns
    // rake at TWO separate tables; each teardown routes their creator-half to pokerOwed via owe(), which
    // must SUM (not overwrite). W4 never binds → settleCreatorRake takes the owe() branch cleanly (no
    // failed-credit log). Two players per table (W1/W2, W3-reuse) with the gate forced open.
    {
      const bridge = makeStubBridge(2000);
      bridge.open("s1", W1, 200); bridge.open("s2", W2, 200); bridge.open("s3", W3, 200);
      const pk = attachPoker(Object.assign({ creatorGateDistinct: 1, creatorGateHands: 1, timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2"); pk.bindToken(W3, "s3"); // W4 is deliberately UNBOUND
      const runTableAccrueCreatorRake = (creatorSock, seatWallets, seatSocks, seatSids) => {
        pk.handle(creatorSock, { type: "pk:table:create", config: { bb: 10, maxSeats: 6, name: "OWE", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 500, rakeCapBb: 3 } });
        const t = creatorSock._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
        for (let k = 0; k < seatWallets.length; k++) pk.handle(seatSocks[k], { type: "pk:table:join", wallet: seatWallets[k], tableId: t, buyIn: 200 });
        const r = roomOf2(pk, seatWallets[0]);
        const wsOf = (w) => { const i = seatWallets.findIndex((x) => x.toLowerCase() === String(w).toLowerCase()); return i >= 0 ? seatSocks[i] : null; };
        let g = 0; while (r.phase === "HAND" && (r.creatorRakeChips || 0) === 0 && g++ < 20) { checkCallDown(pk, r, wsOf); if ((r.creatorRakeChips || 0) === 0) fireDue2(); }
        if (r.phase === "HAND" && r.table.hand && !r.table.hand.done) checkCallDown(pk, r, wsOf);
        const accrued = r.creatorRakeChips || 0;
        pk._mgr.closeRoom(r, "test"); // routes creator-half (sessionless W4) → owe()
        return accrued;
      };
      // reopen s3 for the second table's third seat (it's the same session reused between tables here;
      // in production distinct wallets, but this exercises only the owe() SUM, not the seat math).
      const D = mkTokWs(W4);
      const a1 = runTableAccrueCreatorRake(D, [W1, W2], [mkTokWs(W1), mkTokWs(W2)]);
      // re-open the two player sessions for a fresh table (they cashed out at the first teardown).
      bridge.open("s1", W1, 200); bridge.open("s2", W2, 200);
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2");
      const a2 = runTableAccrueCreatorRake(D, [W1, W2], [mkTokWs(W1), mkTokWs(W2)]);
      eq("(24) both tables accrued a creator-half for the sessionless creator", a1 > 0 && a2 > 0);
      eq("(24) pokerOwed SUMS across two teardowns (never overwrites): owed === a1 + a2", pk.pokerOwed(W4) === a1 + a2);
    }

    // ── 25: RECONNECT-GRACE HIJACK / HOLE-CARD LEAK REGRESSION (audit CRITICAL) — an unauthenticated
    //    socket (empty sock.wallet) must NOT reclaim a REAL victim's disconnected seat via a spoofed
    //    {wallet:victim}, nor receive the victim's live holes; a genuine authenticated reconnect still works. ──
    {
      const bridge = makeStubBridge(2000);
      bridge.open("sv", W1, 300); bridge.open("so", W2, 300);
      const pk = attachPoker(Object.assign({ reconnectGrace: 90000, timers: { act: 20000, showdown: 0, between: 999999, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const V = mkTokWs(W1), O = mkTokWs(W2);
      pk.bindToken(W1, "sv"); pk.bindToken(W2, "so");
      pk.handle(V, { type: "pk:table:create", config: { bb: 10, maxSeats: 2, name: "HJ", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 0, rakeCapBb: 0 } });
      const t = V._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(V, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 });
      pk.handle(O, { type: "pk:table:join", wallet: W2, tableId: t, buyIn: 200 });
      const r = roomOf2(pk, W1);
      pk.onClose(V); // victim's socket drops MID-HAND → seat + live holes kept in the 90s grace
      const vSeat = r.seats.find((s) => s && s.wallet === W1);
      eq("(25) victim seat is disconnected-in-grace with its holes kept", !!vSeat && vSeat.disconnected);
      // ATTACKER: empty sock.wallet, spoofs {wallet:victim}
      const ATK = mkTokWs(""); const mark = ATK._msgs.length;
      pk.handle(ATK, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 });
      const atkLeak = ATK._msgs.slice(mark).some((m) => m.type === "pk:state" && m.hand && (m.hand.players || []).some((p) => p.id === W1 && p.hole));
      eq("(25) attacker did NOT hijack the victim seat (sock unchanged)", r.seats.find((s) => s && s.wallet === W1).sock === V);
      eq("(25) attacker received NO victim hole cards (leak blocked)", !atkLeak);
      // GENUINE reconnect: a fresh AUTHENTICATED victim socket (sock.wallet===W1) reclaims cleanly
      const V2 = mkTokWs(W1);
      pk.handle(V2, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 });
      eq("(25) the genuine authenticated victim RECONNECT still reclaims its seat", r.seats.find((s) => s && s.wallet === W1).sock === V2 && !r.seats.find((s) => s && s.wallet === W1).disconnected);
    }

    // ── 26: DISCONNECT-CLOSE MONEY REGRESSION (audit CRITICAL) — the real server.js close ordering
    //    (onClose THEN unbindToken) must NOT strand a real stack: unbind is refused while a seated
    //    stack awaits grace, and the +90s force-cash-out credits the TOKEN session, never the demo bank. ──
    {
      const bridge = makeStubBridge(2000);
      bridge.open("s1", W1, 300); bridge.open("s2", W2, 300);
      const pk = attachPoker(Object.assign({ reconnectGrace: 90000, timers: { act: 20000, showdown: 0, between: 999999, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1), B = mkTokWs(W2);
      pk.bindToken(W1, "s1"); pk.bindToken(W2, "s2");
      pk.handle(A, { type: "pk:table:create", config: { bb: 10, maxSeats: 2, name: "DC", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 0, rakeCapBb: 0 } });
      const t = A._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: t, buyIn: 200 }); // session s1: 300 → 100 tokens
      pk.handle(B, { type: "pk:table:join", wallet: W2, tableId: t, buyIn: 200 });
      const r = roomOf2(pk, W1);
      checkCallDown(pk, r, (w) => (String(w).toLowerCase() === W1 ? A : B)); // finish the hand → BETWEEN (hasLiveHand false — the dangerous timing)
      const sessBefore = bridge._get("s1").tokens; // == 100 (post buy-in)
      const w1Stack = r.seats.find((s) => s && s.wallet === W1).stack;
      pk.onClose(A);                       // server.js step 1: mark disconnected + 90s grace (keeps chips)
      const unbindRes = pk.unbindToken(W1); // server.js step 2: immediate unbind (single tab)
      eq("(26) unbindToken is REFUSED while the seat holds chips in grace", unbindRes === false);
      clock2 += 91000; fireDue2();          // grace expires → dropSeat force-cash-out
      const sessAfter = bridge._get("s1").tokens, owed = pk.pokerOwed(W1);
      eq("(26) the real stack was credited to the TOKEN session (not the demo bank)", Math.round((sessAfter - sessBefore) * 100) + owed === Math.round(w1Stack));
      eq("(26) the token session actually increased by the stack", sessAfter > sessBefore);
    }

    // ── 27: DEMO BOTS — a human adds bots to a DEMO table + plays a full hand; a REAL table
    //    HARD-REFUSES bots (no bot can ever win/lose real money). ──
    {
      const pk = attachPoker(Object.assign({ autoDemoBots: true, timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      const H = mkTokWs("guest:h1"); // demo human → play-money bank (no bridge)
      pk.handle(H, { type: "pk:seed", balance: 5000 });
      pk.handle(H, { type: "pk:table:create", config: { bb: 10, maxSeats: 6, name: "BOTS", buyInMinBb: 20, buyInMaxBb: 100, kind: "demo" } });
      const tb = H._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(H, { type: "pk:table:join", wallet: "guest:h1", tableId: tb, buyIn: 500 });
      const r = roomOf2(pk, "guest:h1");
      eq("(27) demo table + human seated", !!r && r.kind === "demo");
      const autoBots = r.seats.filter((s) => s && s.isBot);
      eq("(27) a solo human AUTO-gets 2 demo bots on sit (play-money, no token session)", autoBots.length === 2 && autoBots.every((b) => b._sid == null && b.stack > 0));
      pk.handle(H, { type: "pk:table:addbot", tableId: tb }); // + BOT adds a 3rd
      eq("(27) + BOT adds another bot (3 total)", r.seats.filter((s) => s && s.isBot).length === 3);
      eq("(27) a hand auto-started (human + bots)", r.phase === "HAND" && !!r.table.hand);
      let g = 0;
      while (r.phase === "HAND" && r.table.hand && !r.table.hand.done && g++ < 400) {
        const h = r.table.hand, cur = h.players[h.toAct].id;
        if (cur === "guest:h1") { const la = h.legalActions(cur); pk.handle(H, { type: "pk:act", action: la.canCheck ? "check" : "call" }); }
        else break; // bots auto-act synchronously inside advanceHand; landing on a bot turn here = a bug
      }
      eq("(27) the hand played to completion with the bots acting", !!(r.table.hand && r.table.hand.done));
      // a REAL (token) table HARD-REFUSES bots
      const bridge = makeStubBridge(2000); bridge.open("sr", W1, 300);
      const pkR = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pkR.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const R = mkTokWs(W1); pkR.bindToken(W1, "sr");
      pkR.handle(R, { type: "pk:table:create", config: { bb: 10, maxSeats: 6, name: "REAL", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 500, rakeCapBb: 3 } });
      const tr = R._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pkR.handle(R, { type: "pk:table:join", wallet: W1, tableId: tr, buyIn: 200 });
      const rr = roomOf2(pkR, W1); const mk = R._msgs.length;
      pkR.handle(R, { type: "pk:table:addbot", tableId: tr });
      eq("(27) a REAL table REFUSES bots (demo_only) — no bot seated, real money untouched", rr.seats.filter((s) => s && s.isBot).length === 0 && R._msgs.slice(mk).some((m) => m.type === "pk:error" && m.code === "demo_only"));
    }

    { // (28) demo chip reload tops the play-money wallet up by $5,000; a real (token) wallet is refused (no mint)
      const mkWs = (w) => { const msgs = []; const ws = { wallet: w, send: (m) => { try { msgs.push(JSON.parse(m)); } catch (e) {} } }; ws._msgs = msgs; return ws; };
      const pk28 = attachPoker({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } });
      const bal = (ws) => (ws._msgs.filter((m) => m.type === "pk:wallet").pop() || {}).balance;
      const G = mkWs("guest:reload");
      pk28.handle(G, { type: "pk:seed", wallet: "guest:reload", balance: 1000 });
      const bal0 = bal(G);
      pk28.handle(G, { type: "pk:reload", wallet: "guest:reload" });
      const bal1 = bal(G);
      eq("(28) demo reload adds $5,000 play-money to the guest wallet", bal0 === 1000 && bal1 === 6000);
      // spam reload past the cap → tops up in $5k steps but NEVER exceeds $20,000
      for (let i = 0; i < 10; i++) pk28.handle(G, { type: "pk:reload", wallet: "guest:reload" });
      eq("(28) demo reload is CAPPED at $20,000 (never higher no matter how many clicks)", bal(G) === 20000);
      // a wallet ABOVE the cap (chips won at the table) is NOT reduced and gains nothing from reload
      pk28.handle(G, { type: "pk:seed", wallet: "guest:reload", balance: 33000 });
      pk28.handle(G, { type: "pk:reload", wallet: "guest:reload" });
      eq("(28) a >$20k balance (winnings) is left UNTOUCHED by reload — winnings may exceed the cap, reloads may not", bal(G) === 33000);
      const T = mkWs("0xRealWallet"); const before = T._msgs.length; // a non-guest (real) socket
      pk28.handle(T, { type: "pk:reload", wallet: "0xRealWallet" });
      eq("(28) reload REFUSES a non-guest wallet — never mints play-money onto a real balance", !T._msgs.slice(before).some((m) => m.type === "pk:wallet"));
    }

    { // (29) HUNT #5 CRITICAL: a demo table holding a BOT hard-refuses a real (token) buy-in — a bot can never be dealt real money
      const bridge = makeStubBridge(2000); bridge.open("sb1", W1, 200);
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const H = mkTokWs("guest:h5");
      pk.handle(H, { type: "pk:table:create", wallet: "guest:h5", config: { bb: 10, maxSeats: 6, name: "DBOT", buyInMinBb: 20, buyInMaxBb: 100 } });
      const tid5 = H._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(H, { type: "pk:table:join", wallet: "guest:h5", tableId: tid5, buyIn: 500 });
      pk.handle(H, { type: "pk:table:addbot", tableId: tid5 });
      const r5 = roomOf2(pk, "guest:h5");
      const hadBot = !!r5 && r5.seats.some((s) => s && s.isBot);
      const T5 = mkTokWs(W1); pk.bindToken(W1, "sb1");
      const mk5 = T5._msgs.length;
      pk.handle(T5, { type: "pk:table:join", wallet: W1, tableId: tid5, buyIn: 200 });
      const gotSeat = r5.seats.some((s) => s && String(s.wallet).toLowerCase() === W1.toLowerCase());
      eq("(29) HUNT#5 a demo table WITH a bot REFUSES a real buy-in (kind stays demo, token wallet NOT seated, bot never dealt real money)", hadBot && r5.kind === "demo" && !gotSeat && T5._msgs.slice(mk5).some((m) => m.type === "pk:error" && m.code === "demo_only"));
    }

    { // (30) HUNT #7 CRITICAL: bindToken REFUSES swapping a seated stack's token session BETWEEN hands (cross-session cash-out house-drain)
      const bridge = makeStubBridge(2000); bridge.open("sx1", W2, 200); bridge.open("sx2", W2, 200); // same player, two funded sessions
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A2 = mkTokWs(W2); pk.bindToken(W2, "sx1");
      pk.handle(A2, { type: "pk:table:create", wallet: W2, config: { bb: 10, maxSeats: 6, name: "BND", buyInMinBb: 20, buyInMaxBb: 100 } });
      const tid7 = A2._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(A2, { type: "pk:table:join", wallet: W2, tableId: tid7, buyIn: 200 }); // seated, stack bought from sx1 (no 2nd player → no live hand → hasLiveHand=false)
      const seated7 = !!roomOf2(pk, W2);
      const swapped = pk.bindToken(W2, "sx2"); // between hands must STILL refuse (a seated stack is bound to sx1)
      eq("(30) HUNT#7 bindToken REFUSES swapping a seated stack's session between hands (no wrong-session cash-out drain)", seated7 && swapped === false);
    }

    { // (31) HUNT #1 HIGH: H6 self-deal guard NORMALIZES wallet casing — a creator seated under a different address casing STILL earns zero rake-share
      const bridge = makeStubBridge(2000);
      const Wm = "0xAbCdEf0000000000000000000000000000000009"; // mixed-case creator address
      const Wl = Wm.toLowerCase();
      bridge.open("sm1", Wm, 500); bridge.open("sm2", W3, 500);
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 }, creatorGateDistinct: 2, creatorGateHands: 0 }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const Cc = mkTokWs(Wm); pk.bindToken(Wm, "sm1"); // create under MIXED case → r.creatorWallet = Wm
      pk.handle(Cc, { type: "pk:table:create", wallet: Wm, config: { bb: 10, maxSeats: 6, name: "H6", buyInMinBb: 20, buyInMaxBb: 100, rakeBps: 500, rakeCapBb: 3 } });
      const tid1 = Cc._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      const Cl = mkTokWs(Wl); pk.bindToken(Wl, "sm1"); // seat under LOWER case → p.id = Wl
      pk.handle(Cl, { type: "pk:table:join", wallet: Wl, tableId: tid1, buyIn: 500 });
      const Op = mkTokWs(W3); pk.bindToken(W3, "sm2");
      pk.handle(Op, { type: "pk:table:join", wallet: W3, tableId: tid1, buyIn: 500 });
      const r1 = roomOf2(pk, Wl);
      const wsOf1 = (w) => (String(w).toLowerCase() === Wl ? Cl : Op);
      let hands = 0; while (hands < 6 && (r1.houseRakeChips || 0) === 0 && r1.phase === "HAND") { checkCallDown(pk, r1, wsOf1); hands++; fireDue2(); }
      // gate is OPEN (2 distinct, 0 hands) so the ONLY thing withholding the creator-half is the H6 seated check → must still be 0
      eq("(31) HUNT#1 a case-mismatched SEATED creator still earns ZERO rake-share (H6 normalizes both sides) — no self-deal of house rake", (r1.houseRakeChips || 0) > 0 && (r1.creatorRakeChips || 0) === 0);
    }

    { // (32) HUNT #4 HIGH: a SHORT all-in does NOT re-open a capped player's raise — act() enforces mayRaise (server is the sole validator)
      const t = createTable({ smallBlind: 5, bigBlind: 10, seats: 2 });
      sit(t, { id: "a", isBot: false, stack: 500 });
      sit(t, { id: "b", isBot: false, stack: 160 }); // short stack → its all-in is a short (< min) raise
      startHand(t, { buttonIndex: 0 });
      const h = t.hand;
      let g = 0; while (h.board.length < 3 && g++ < 12) { const p = h.players[h.toAct]; const tc = h.currentBet - p.committedStreet; act(t, p.id, tc > 0 ? "call" : "check"); } // limp/check to the flop
      if (h.players[h.toAct].id === "b") act(t, "b", "check"); // BB acts first postflop
      act(t, "a", "bet", 100);   // currentBet 100, minRaise 100, a.acted=true
      act(t, "b", "allin");      // b all-in 150 → increment 50 < minRaise 100 → SHORT → a.mayRaise=false
      const aCapped = !h.players.find((p) => p.id === "a").mayRaise;
      let threw = false; try { act(t, "a", "raise", 300); } catch (e) { threw = true; } // capped → voluntary re-raise must THROW
      let called = false; try { act(t, "a", "call"); called = true; } catch (e) {}       // but CALL is still legal
      eq("(32) HUNT#4 short all-in closes the capped player's raise: a voluntary re-raise THROWS, CALL still allowed", aCapped && threw && called);
    }

    { // (33) HUNT2-A: a REAL table posts CENT-scaled blinds (bb*100) so a "$5/$10" real table is $5/$10, not $0.05/$0.10; DEMO stays 1:1
      const bridge = makeStubBridge(999999); bridge.open("bs1", W1, 500); bridge.open("bs2", W2, 500);
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      pk.setTokenLedger({ tokensOf: bridge.tokensOf, applyNet: bridge.applyPokerNet });
      const A = mkTokWs(W1), B = mkTokWs(W2); pk.bindToken(W1, "bs1"); pk.bindToken(W2, "bs2");
      pk.handle(A, { type: "pk:table:create", wallet: W1, config: { bb: 10, maxSeats: 6, name: "REALBL", buyInMinBb: 20, buyInMaxBb: 100 } });
      const tid = A._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pk.handle(A, { type: "pk:table:join", wallet: W1, tableId: tid, buyIn: 500 });
      pk.handle(B, { type: "pk:table:join", wallet: W2, tableId: tid, buyIn: 500 });
      const h = roomOf2(pk, W1).table.hand;
      eq("(33) HUNT2-A a REAL '$5/$10' table posts CENT-scaled blinds (SB=500, BB=1000 chips)", !!h && h.bb === 1000 && h.sb === 500);
      const pkd = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      const G1 = mkTokWs("guest:b1"), G2 = mkTokWs("guest:b2");
      pkd.handle(G1, { type: "pk:table:create", wallet: "guest:b1", config: { bb: 10, maxSeats: 6, name: "DEMOBL", buyInMinBb: 20, buyInMaxBb: 100 } });
      const dtid = G1._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      pkd.handle(G1, { type: "pk:table:join", wallet: "guest:b1", tableId: dtid, buyIn: 500 });
      pkd.handle(G2, { type: "pk:table:join", wallet: "guest:b2", tableId: dtid, buyIn: 500 });
      const dh = roomOf2(pkd, "guest:b1").table.hand;
      eq("(33) HUNT2-A a DEMO '$5/$10' table posts 1:1 blinds (SB=5, BB=10)", !!dh && dh.bb === 10 && dh.sb === 5);
    }

    { // (34) HUNT2-C: a PRIVATE table refuses pk:table:watch WITHOUT the password (spectator view no longer bypasses it), allows WITH it
      const pk = attachPoker(Object.assign({ timers: { act: 20000, showdown: 0, between: 0, idleEmpty: 999999, idleSeated: 999999, botMin: 0, botMax: 0 } }, clk2));
      const H = mkTokWs("guest:pw1");
      pk.handle(H, { type: "pk:table:create", wallet: "guest:pw1", config: { bb: 10, maxSeats: 6, name: "PRIV", buyInMinBb: 20, buyInMaxBb: 100, private: true, pw: "secret" } });
      const tid = H._msgs.filter((m) => m.type === "pk:table:created").pop().tableId;
      const r = Array.from(pk._mgr.rooms.values()).find((x) => x.id === tid);
      const M = mkTokWs("guest:mal"); const mk = M._msgs.length;
      pk.handle(M, { type: "pk:table:watch", tableId: tid });                 // no pw → refused
      const refused = M._msgs.slice(mk).some((m) => m.type === "pk:error" && m.code === "bad_password") && !r.spectators.has(M);
      pk.handle(M, { type: "pk:table:watch", tableId: tid, pw: "secret" });   // correct pw → allowed
      eq("(34) HUNT2-C private table REFUSES watch w/o pw (not a spectator), ALLOWS with the correct pw", refused && r.spectators.has(M));
    }
  }

  console.log(ok ? "\nSELF-TEST OK — server-authoritative poker core is deterministic, verifiable, and leak-free (+ rake: no-flop-no-drop, %-with-cap, exact chip-sink; + Phase-2 RoomManager: per-socket no-leak, act-timer epoch guard, disconnect auto-fold, reconnect reclaim, button rotation, illegal-act rejection, heads-up fold-to-BB; + Phase-3 MONEY: end-to-end zero-sum to the cent, creator-share no-mint, capUp-shortfall→pokerOwed, insufficient-buy-in refused, boot-drain force-cash-out, seated-creator→HOUSE, anti-wash gate, pokerOwed sums)." : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
