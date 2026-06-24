// poker-bots.js — pure heuristic decision function for the "house" opponents.
// No DOM/Node deps. decide() returns a LEGAL action given the masked state the
// bot can see. Deliberately simple: hand-strength + pot-odds + a little noise
// and occasional bluffing. Good enough to feel alive without pretending to be a
// solver. Reuses the engine's evaluator for made-hand strength.
(function (root, factory) {
  const api = factory(typeof require === "function" ? require("./poker-engine.js") : (root.Poker));
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PokerBots = api;
})(typeof self !== "undefined" ? self : this, function (Poker) {
  "use strict";

  // Preflop strength in [0,1] from two hole cards (rough but reasonable).
  function preflop(hole) {
    const r = hole.map((c) => c.rank).sort((a, b) => b - a);
    const suited = hole[0].suit === hole[1].suit;
    const gap = r[0] - r[1];
    let s;
    if (r[0] === r[1]) {
      s = 0.50 + ((r[0] - 2) / 12) * 0.50;          // pair: 22≈.50 → AA≈1.0
    } else {
      s = ((r[0] - 2) / 12) * 0.42 + ((r[1] - 2) / 12) * 0.20;
      if (suited) s += 0.08;
      if (gap === 1) s += 0.06; else if (gap === 2) s += 0.03; // connectors
      if (r[0] === 14) s += 0.04;                    // ace high kicker
    }
    return Math.max(0, Math.min(1, s));
  }

  // Postflop strength in [0,1] from the bot's best made hand category.
  const CAT_BASE = { 1: 0.10, 2: 0.30, 3: 0.50, 4: 0.62, 5: 0.72, 6: 0.80, 7: 0.90, 8: 0.97, 9: 1.0 };
  function postflop(hole, board) {
    const seven = hole.concat(board);
    let best = 0;
    for (const five of Poker.combinations(seven, 5)) { const s = Poker.score5(five); if (s > best) best = s; }
    const cat = Math.floor(best / Math.pow(16, 5));
    let s = CAT_BASE[cat] || 0.1;
    // small kicker nudge so AK-high beats 72-high among same category
    const tb = best - cat * Math.pow(16, 5);
    s += (tb / Math.pow(16, 5)) * 0.06;
    return Math.max(0, Math.min(1, s));
  }

  function clampTarget(t, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(t))); }

  // state: masked snapshot from hand.state(botId). legal: hand.legalActions(botId).
  // opts: { aggression?:0..1, rng?:fn }  -> returns { type, amount? }
  function decide(state, legal, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    const aggro = opts.aggression != null ? opts.aggression : 0.5;
    const me = state.players.find((p) => p.id === state.toActId);
    const hole = me && me.hole; // the bot can see its own cards
    if (!hole) return { type: legal.canCheck ? "check" : "fold" };

    const street = state.street;
    let strength = street === "preflop" ? preflop(hole) : postflop(hole, state.board);
    strength += (rng() - 0.5) * 0.10;                 // perception noise
    strength = Math.max(0, Math.min(1, strength));

    const pot = Math.max(1, state.pot);
    const toCall = legal.toCall || 0;
    const bb = state.minRaise || 1;

    // helper to size a bet/raise as a fraction of the pot
    function aggressiveTarget(frac) {
      if (legal.canBet) {
        const base = me.committedStreet + Math.round(pot * frac);
        return { type: "bet", amount: clampTarget(base, legal.minBet + me.committedStreet, legal.maxRaiseTo) };
      }
      if (legal.canRaise) {
        const base = state.currentBet + Math.round(pot * frac);
        return { type: "raise", amount: clampTarget(base, legal.minRaiseTo, legal.maxRaiseTo) };
      }
      return null;
    }

    // No bet to call: check or take the lead.
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

    // Facing a bet: pot odds + strength.
    const potOdds = toCall / (pot + toCall);

    // strong → raise for value
    if (strength > (0.84 - aggro * 0.08) && (legal.canRaise) && rng() < 0.55 + aggro * 0.25) {
      const a = aggressiveTarget(strength > 0.92 ? 1.0 : 0.7);
      if (a) return a;
    }
    // priced-in call
    if (strength >= potOdds + 0.04) return { type: "call" };
    // cheap call (small bet, draw-ish)
    if (toCall <= bb * 1.5 && rng() < 0.5 && strength > 0.18) return { type: "call" };
    // occasional bluff raise
    if (legal.canRaise && rng() < 0.04 * aggro) { const a = aggressiveTarget(0.6); if (a) return a; }
    // otherwise give up
    return legal.canCheck ? { type: "check" } : { type: "fold" };
  }

  return { decide, preflop, postflop };
});
