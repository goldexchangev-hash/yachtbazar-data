/* ============================================================
   blackjack-rules.js — PURE blackjack rules core. Zero side effects, no
   sockets, no I/O. The single source of truth for card math + payouts so it
   can be unit-tested offline and reused by the server room engine.

   Recommended fair config (~99.5% RTP under basic strategy):
     6 decks · dealer STANDS on soft 17 (S17) · blackjack pays 3:2 ·
     double on any 2 · double after split · split to 4 hands ·
     split aces get one card · late surrender · dealer peeks on A/10.

   Isomorphic: module.exports in Node, globalThis.BlackjackRules in a browser.
   ============================================================ */
(function (root) {
  "use strict";

  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
  const SUITS = ["S", "H", "D", "C"];

  const DEFAULT_CONFIG = {
    decks: 6, h17: false, bjPays: 1.5, das: true, doa: true,
    surrender: true, peek: true, splitMax: 4, minBet: 10,
  };

  function rankValue(rank) { return rank === "A" ? 11 : "TJQK".indexOf(rank) >= 0 ? 10 : parseInt(rank, 10); }

  // value of a hand: highest total <= 21 using aces as 1 or 11
  function handValue(cards) {
    let total = 0, aces = 0;
    for (const c of cards) { if (!c || c.rank == null) continue; const r = c.rank; if (r === "A") { aces++; total += 11; } else total += rankValue(r); } // skip falsy/short cards so a malformed shoe can never throw
    while (total > 21 && aces > 0) { total -= 10; aces--; }       // demote aces from 11 to 1
    const softAces = aces;                                         // aces still counted as 11
    return {
      total,
      soft: softAces > 0 && total <= 21,
      bust: total > 21,
      blackjack: cards.length === 2 && total === 21,              // natural (2-card 21); caller excludes split hands
    };
  }

  function isPair(cards, config) {
    if (cards.length !== 2) return false;
    const a = cards[0].rank, b = cards[1].rank;
    if (a === b) return true;
    return (rankValue(a) === 10 && rankValue(b) === 10);          // any two 10-values split
  }

  // legal actions for the hand currently on turn.
  // hand: { cards, bet, firstAction, doubled, fromSplit, isAceSplit, hands }
  // opts: { balance, config, numHands }
  function legalActions(hand, opts) {
    opts = opts || {}; const config = opts.config || DEFAULT_CONFIG; const bal = opts.balance == null ? Infinity : opts.balance;
    const hv = handValue(hand.cards);
    if (hv.bust || hand.done || hand.doubled) return [];
    if (hand.isAceSplit && hand.cards.length >= 2) return [];      // split aces get exactly one card → auto-stand
    const out = ["stand"];
    if (hv.total < 21) out.push("hit");
    const first = hand.firstAction && hand.cards.length === 2;
    if (first) {
      // double
      if (config.doa && bal >= hand.bet && (!hand.fromSplit || config.das)) out.push("double");
      // split
      if (isPair(hand.cards, config) && bal >= hand.bet && (opts.numHands || 1) < config.splitMax) {
        const aces = hand.cards[0].rank === "A";
        if (!aces || (opts.numHands || 1) < config.splitMax) out.push("split");
      }
      // late surrender (only the very first decision of the original hand)
      if (config.surrender && !hand.fromSplit) out.push("surrender");
    }
    return out;
  }

  // dealer draws by fixed rule. S17 (default): stand on soft 17. H17: hit soft 17.
  function dealerShouldHit(cards, config) {
    config = config || DEFAULT_CONFIG;
    const hv = handValue(cards);
    if (hv.total < 17) return true;
    if (hv.total === 17 && hv.soft && config.h17) return true;
    return false;
  }

  // settle ONE player hand vs the dealer hand. Returns { outcome, returnMult }
  // where returnMult = total returned per unit of this hand's (possibly doubled) stake.
  //   profit = stake * (returnMult - 1).
  // player.fromSplit excludes a 2-card 21 from the 3:2 natural.
  function settleHand(player, dealer, config) {
    config = config || DEFAULT_CONFIG;
    if (player.surrendered) return { outcome: "surrender", returnMult: 0.5 };
    const p = handValue(player.cards), d = handValue(dealer.cards);
    const pBJ = p.blackjack && !player.fromSplit;
    const dBJ = d.blackjack;
    if (p.bust) return { outcome: "lose", returnMult: 0 };
    if (pBJ && dBJ) return { outcome: "push", returnMult: 1 };
    if (pBJ) return { outcome: "blackjack", returnMult: 1 + config.bjPays };   // 3:2 → 2.5
    if (dBJ) return { outcome: "lose", returnMult: 0 };
    if (d.bust) return { outcome: "win", returnMult: 2 };
    if (p.total > d.total) return { outcome: "win", returnMult: 2 };
    if (p.total === d.total) return { outcome: "push", returnMult: 1 };
    return { outcome: "lose", returnMult: 0 };
  }

  // dealer peeks for blackjack when the upcard (cards[0]) is an Ace or 10-value
  function dealerPeeks(dealerCards, config) {
    config = config || DEFAULT_CONFIG;
    if (!config.peek) return false;
    const up = dealerCards[0]; return up && (up.rank === "A" || rankValue(up.rank) === 10);
  }

  const API = { RANKS, SUITS, DEFAULT_CONFIG, rankValue, handValue, isPair, legalActions, dealerShouldHit, settleHand, dealerPeeks };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.BlackjackRules = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
