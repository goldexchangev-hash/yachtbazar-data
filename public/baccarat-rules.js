/* ============================================================
   baccarat-rules.js — PURE punto banco (baccarat) rules core. Zero side
   effects, no sockets, no I/O. The single source of truth for the fixed
   drawing tableau + payouts so it can be unit-tested offline and reused by
   BOTH the server room engine and the client fairness verifier (the PF
   panel replays the exact round via runTableau(Shuffle.verify(...).shoe)).

   House configuration (8-deck, standard commission):
     Player pays 1:1 (2.0x return) · Banker pays 19:20 (1.95x return) ·
     Tie pays 8:1 (9.0x return) · on a Tie, Player/Banker bets PUSH (1.0x).
     House edges: Banker 1.06% / Player 1.24% / Tie 14.36%.

   Card values: A=1, 2–9 pip, 10/J/Q/K=0; hand total = sum mod 10; no bust.
   Natural: either hand's FIRST TWO cards total 8/9 → both hands freeze
   (a 3-card 8/9 is NOT a natural).

   DEAL ORDER CONVENTION (must match server engine + fairness verifier):
     P1 = shoe[0], B1 = shoe[1], P2 = shoe[2], B2 = shoe[3],
     then player 3rd = shoe[4] (if drawn), then banker 3rd = next (if drawn).

   Cards are the shuffle module's canonical { rank, suit } objects
   (RANKS/SUITS identical to blackjack-shuffle.js).

   Isomorphic: module.exports in Node, globalThis.BaccaratRules in a browser.
   ============================================================ */
(function (root) {
  "use strict";

  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
  const SUITS = ["S", "H", "D", "C"];

  const DEFAULT_CONFIG = { decks: 8, minBet: 10, commission: 0.05, tiePays: 8, maxSeats: 4 };

  // A=1, 2–9 pip, 10/J/Q/K=0
  function cardValue(rank) { return rank === "A" ? 1 : "TJQK".indexOf(rank) >= 0 ? 0 : parseInt(rank, 10); }

  // sum of card values mod 10 (only the units digit counts; max 9, no busting)
  function handTotal(cards) {
    let t = 0;
    for (const c of cards) { if (!c || c.rank == null) continue; t += cardValue(c.rank); } // skip falsy/short cards so a malformed shoe can never throw
    return t % 10;
  }

  // natural = FIRST TWO cards total 8 or 9 (freezes both hands; 3-card 8/9 is NOT a natural)
  function isNatural(cards) { return cards.length === 2 && handTotal(cards) >= 8; }

  // player: draws on 0–5, stands on 6–7 (naturals handled before this is consulted)
  function playerDraws(playerTotal) { return playerTotal <= 5; }

  // Banker third-card matrix: [banker 2-card total][player third card VALUE] -> 1 = draw.
  // Lookup uses the third card's VALUE (a King third card is column 0).
  // Classic traps: banker 3 stands ONLY vs 8 (vs 9 → DRAWS); banker 6 draws ONLY vs 6/7;
  // banker 0–2 draw even vs a third-card 8.
  const BANKER_DRAWS = [
    /*0*/ [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    /*1*/ [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    /*2*/ [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    /*3*/ [1, 1, 1, 1, 1, 1, 1, 1, 0, 1],   // stands ONLY vs 8 (vs 9 → DRAWS — classic bug)
    /*4*/ [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
    /*5*/ [0, 0, 0, 0, 1, 1, 1, 1, 0, 0],
    /*6*/ [0, 0, 0, 0, 0, 0, 1, 1, 0, 0],
    /*7*/ [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];

  // banker rule. playerThirdValue = the VALUE of the player's third card, or
  // null/undefined if the player stood (then the matrix does NOT apply — the
  // banker plays like the player: draws 0–5, stands 6–7; banker 6 STANDS here
  // where the matrix would draw vs 6/7). Banker 8/9 is a natural, handled
  // before this is ever consulted.
  function bankerDraws(bankerTotal, playerThirdValue) {
    if (playerThirdValue == null) return bankerTotal <= 5;
    const row = BANKER_DRAWS[bankerTotal];
    return row ? !!row[playerThirdValue] : false;
  }

  // Full deterministic round from a shoe array — used by BOTH the server and
  // the fairness verifier. Deal order per the convention in the header:
  // P1=shoe[0], B1=shoe[1], P2=shoe[2], B2=shoe[3], then player 3rd, then banker 3rd.
  function runTableau(shoe) {
    const P = [shoe[0], shoe[2]], B = [shoe[1], shoe[3]];
    let p = 4;
    if (!(isNatural(P) || isNatural(B))) {                 // a natural on EITHER side freezes both hands
      let p3v = null;
      if (playerDraws(handTotal(P))) { P.push(shoe[p++]); p3v = cardValue(P[2].rank); }
      if (bankerDraws(handTotal(B), p3v)) B.push(shoe[p++]);
    }
    const pt = handTotal(P), bt = handTotal(B);
    return {
      player: P, banker: B, playerTotal: pt, bankerTotal: bt,
      winner: pt > bt ? "player" : bt > pt ? "banker" : "tie", used: p,
    };
  }

  // same tail computation from already-dealt cards (higher mod-10 total wins; equal = tie)
  function outcome(playerCards, bankerCards) {
    const pt = handTotal(playerCards), bt = handTotal(bankerCards);
    return { playerTotal: pt, bankerTotal: bt, winner: pt > bt ? "player" : bt > pt ? "banker" : "tie" };
  }

  // Return multiple per unit staked on a zone, given the coup winner.
  //   tie coup:  tie zone → 1+tiePays (9.0x) · player/banker zones PUSH (1.0x)
  //   else:      winning zone → banker 1+(1-commission)=1.95x · player 2.0x · losing zone 0
  function zoneReturnMult(zone, winner, config) {
    const cfg = config || DEFAULT_CONFIG;
    if (winner === "tie") return zone === "tie" ? 1 + cfg.tiePays : 1;
    if (zone === winner) return zone === "banker" ? 1 + (1 - cfg.commission) : 2;
    return 0;
  }

  const API = {
    RANKS, SUITS, DEFAULT_CONFIG, BANKER_DRAWS,
    cardValue, handTotal, isNatural, playerDraws, bankerDraws,
    runTableau, outcome, zoneReturnMult,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.BaccaratRules = API;

  /* ============================================================
     CLI SELF-TEST — node public/baccarat-rules.js
     38 hand-verified tableau vectors (spec §10/§11) + full banker-matrix
     cross-check + value/mod-10 checks + zoneReturnMult settle math +
     deterministic 1M-shoe fuzz vs the exact 8-deck outcome probabilities.
     ============================================================ */
  if (typeof module !== "undefined" && module.exports && typeof require === "function" && require.main === module) {
    (function selfTest() {
      let checks = 0, fails = 0;
      function ok(cond, label) { checks++; if (!cond) { fails++; console.error("FAIL: " + label); } }
      const r2 = (n) => Math.round(n * 100) / 100;
      const card = (s) => ({ rank: s.slice(0, -1), suit: s.slice(-1) });
      const shoe = (s) => s.trim().split(/\s+/).map(card);

      // ---- A. card values + mod-10 totals -------------------------------
      ok(cardValue("A") === 1, "cardValue A=1");
      ok(cardValue("2") === 2 && cardValue("9") === 9, "cardValue pips");
      ok(cardValue("T") === 0 && cardValue("J") === 0 && cardValue("Q") === 0 && cardValue("K") === 0, "cardValue T/J/Q/K=0");
      ok(handTotal(shoe("7S 8H")) === 5, "handTotal 7+8=15 -> 5");
      ok(handTotal(shoe("9S 9H 9D")) === 7, "handTotal 9+9+9=27 -> 7");
      ok(handTotal(shoe("KS QH")) === 0, "handTotal K+Q -> 0");
      ok(handTotal(shoe("7C 6D")) === 3, "handTotal 7+6=13 -> 3");
      ok(handTotal([]) === 0, "handTotal empty -> 0");
      ok(handTotal([null, card("5S")]) === 5, "handTotal skips malformed cards");

      // ---- B. naturals ---------------------------------------------------
      ok(isNatural(shoe("4H 5D")) === true, "natural 9 (2 cards)");
      ok(isNatural(shoe("3D 5C")) === true, "natural 8 (2 cards)");
      ok(isNatural(shoe("4D AS 4C")) === false, "3-card 9 is NOT a natural");
      ok(isNatural(shoe("3S 4D")) === false, "2-card 7 not a natural");

      // ---- C. player rule ------------------------------------------------
      for (let t = 0; t <= 5; t++) ok(playerDraws(t) === true, "player draws on " + t);
      for (let t = 6; t <= 7; t++) ok(playerDraws(t) === false, "player stands on " + t);

      // ---- D. banker matrix — exhaustive cross-check vs the rule text ----
      // (0–2 always draw; 3 stands ONLY vs 8; 4 draws vs 2–7; 5 draws vs 4–7;
      //  6 draws ONLY vs 6/7; 7 never draws; player stood → draw 0–5, stand 6–7.)
      for (let bt = 0; bt <= 7; bt++) {
        for (let v = 0; v <= 9; v++) {
          let want;
          if (bt <= 2) want = 1;
          else if (bt === 3) want = v === 8 ? 0 : 1;
          else if (bt === 4) want = v >= 2 && v <= 7 ? 1 : 0;
          else if (bt === 5) want = v >= 4 && v <= 7 ? 1 : 0;
          else if (bt === 6) want = v === 6 || v === 7 ? 1 : 0;
          else want = 0;
          ok(BANKER_DRAWS[bt][v] === want, "BANKER_DRAWS[" + bt + "][" + v + "] = " + want);
          ok(bankerDraws(bt, v) === !!want, "bankerDraws(" + bt + ", " + v + ") = " + !!want);
        }
        ok(bankerDraws(bt, null) === (bt <= 5), "bankerDraws(" + bt + ", null) player-stood = " + (bt <= 5));
      }
      ok(bankerDraws(3, 9) === true, "TRAP: banker 3 vs third 9 DRAWS");
      ok(bankerDraws(3, 8) === false, "TRAP: banker 3 stands ONLY vs 8");
      ok(bankerDraws(2, 8) === true, "TRAP: banker 0-2 draw even vs third 8");
      ok(bankerDraws(6, null) === false, "TRAP: player stood -> banker 6 STANDS (matrix would draw vs 6/7)");
      ok(bankerDraws(4, 0) === false, "TRAP: value lookup — King third card is column 0 (banker 4 stands)");

      // ---- E. the 38 tableau vectors (spec §10, all hand-verified) -------
      // shoe order: P1 B1 P2 B2 [P3] [B3]
      const V = [
        ["T1", "4H 2S 5D 3C", 9, 5, "player", 4, 2, 2, "natural 9 freezes banker-5"],
        ["T2", "3D 4S 5C 5H", 8, 9, "banker", 4, 2, 2, "natural 9 beats natural 8"],
        ["T3", "KD TS 8C 8H", 8, 8, "tie", 4, 2, 2, "equal naturals tie"],
        ["T4", "KC 8D QD TH", 0, 8, "banker", 4, 2, 2, "one-sided natural freezes BOTH hands (player 0 does NOT draw)"],
        ["T5", "9D 3S KH 4D", 9, 7, "player", 4, 2, 2, "natural vs banker 7 stand"],
        ["T6", "AC KD 5D QS 9C", 6, 9, "banker", 5, 2, 3, "P stood; banker 0 draws"],
        ["T7", "3H 2D 4C 3S AD", 7, 6, "player", 5, 2, 3, "P stood; banker 5 draws"],
        ["T8", "KS 2C 6H 4D", 6, 6, "tie", 4, 2, 2, "P stood; banker 6 STANDS (matrix must not apply)"],
        ["T9", "2S AD 5H 5C", 7, 6, "player", 4, 2, 2, "both stand, 7 beats 6"],
        ["T10", "QD AS 6C 2H 5D", 6, 8, "banker", 5, 2, 3, "P stood; banker 3 draws"],
        ["T11", "KD QD 2C JC 9S 7H", 1, 7, "banker", 6, 3, 3, "banker 0 draws vs third 9; player draw worsens hand"],
        ["T12", "2H AD 3D QS KC 4S", 5, 5, "tie", 6, 3, 3, "value-0 third leaves total unchanged; banker 1 always draws"],
        ["T13", "KH AH JD AC 8D 6D", 8, 8, "tie", 6, 3, 3, "3-card 8 NOT a natural; banker 2 draws even vs third 8"],
        ["T14", "2D QH 2C 3H 8S", 2, 3, "banker", 5, 3, 2, "banker 3 vs third 8 -> STAND (the only banker-3 stand)"],
        ["T15", "3C 3S AH KD 9D 2H", 3, 5, "banker", 6, 3, 3, "banker 3 vs third 9 -> DRAWS (classic bug trap)"],
        ["T16", "AC 2S AD AS 4H 9H", 6, 2, "player", 6, 3, 3, "banker 3 draws vs 4; banker draw worsens hand"],
        ["T17", "5C 3D KS JS QC 6S", 5, 9, "banker", 6, 3, 3, "banker 3 draws vs value-0 third card"],
        ["T18", "5D QC KS 4D AH", 6, 4, "player", 5, 3, 2, "banker 4 vs third 1 -> stand"],
        ["T19", "2C 2D 3H 2H KD", 5, 4, "player", 5, 3, 2, "banker 4 vs FACE-CARD third (value 0) -> stand"],
        ["T20", "AS 4C 2D JD 2H 5S", 5, 9, "banker", 6, 3, 3, "banker 4 lower draw boundary (vs 2)"],
        ["T21", "4D AD KH 3C 7C KS", 1, 4, "banker", 6, 3, 3, "banker 4 upper draw boundary (vs 7); banker third value 0"],
        ["T22", "5H 2S QD 2D 8C", 3, 4, "banker", 5, 3, 2, "banker 4 vs 8 -> stand"],
        ["T23", "4C 4H JH KC 9H", 3, 4, "banker", 5, 3, 2, "banker 4 vs 9 -> stand"],
        ["T38", "TC 2C 5S 2S 6C 9S", 1, 3, "banker", 6, 3, 3, "banker 4 vs 6 -> draw (interior of draw range)"],
        ["T24", "JD 3H AC 2C 4S 4D", 5, 9, "banker", 6, 3, 3, "banker 5 lower draw boundary (vs 4)"],
        ["T25", "KC AH 2H 4S 3D", 5, 5, "tie", 5, 3, 2, "banker 5 vs 3 -> stand; tie after player draw"],
        ["T26", "3S 5C 2H KH 7D 8S", 2, 3, "banker", 6, 3, 3, "banker 5 upper draw boundary (vs 7); both worsened"],
        ["T27", "4C QS KD 5D 9C", 3, 5, "banker", 5, 3, 2, "banker 5 vs 9 -> stand"],
        ["T28", "2D 5H 2S TD QH", 4, 5, "banker", 5, 3, 2, "banker 5 vs value-0 third -> stand"],
        ["T36", "AH 2H 3C 3D 8D", 2, 5, "banker", 5, 3, 2, "banker 5 vs 8 -> stand"],
        ["T29", "KS 4H 4D 2S 6H 3C", 0, 9, "banker", 6, 3, 3, "banker 6 vs 6 -> DRAW; player hits to exactly 0"],
        ["T30", "2C KD AD 6C 7S 5H", 0, 1, "banker", 6, 3, 3, "banker 6 vs 7 -> draw; 1 beats 0"],
        ["T31", "QH AS KC 5H 5D", 5, 6, "banker", 5, 3, 2, "banker 6 vs 5 -> stand (one below draw range)"],
        ["T32", "3D 6D AH QD 8H", 2, 6, "banker", 5, 3, 2, "banker 6 vs 8 -> stand"],
        ["T37", "2H 3D 3S 3H QD", 5, 6, "banker", 5, 3, 2, "banker 6 vs value-0 third -> stand"],
        ["T33", "AC 3C 4H 4S 6D", 1, 7, "banker", 5, 3, 2, "banker 7 never draws"],
        ["T34", "4D JH AS 7C 4C", 9, 7, "player", 5, 3, 2, "3-card 9 NOT a natural but wins on points vs banker 7"],
        ["T35", "2S 4D 2H QS 3H 3S", 7, 7, "tie", 6, 3, 3, "both draw to a tie; banker 4 vs 3 -> draw"],
      ];
      ok(V.length === 38, "38 tableau vectors present");
      for (const [name, s, pt, bt, winner, used, pl, bl, branch] of V) {
        const res = runTableau(shoe(s));
        const good = res.playerTotal === pt && res.bankerTotal === bt && res.winner === winner &&
          res.used === used && res.player.length === pl && res.banker.length === bl;
        ok(good, name + " (" + branch + ") — got P" + res.playerTotal + "/B" + res.bankerTotal + " " +
          res.winner + " used " + res.used + " lens " + res.player.length + "/" + res.banker.length +
          ", want P" + pt + "/B" + bt + " " + winner + " used " + used + " lens " + pl + "/" + bl);
        // outcome() must agree with runTableau's tail computation
        const oc = outcome(res.player, res.banker);
        ok(oc.winner === winner && oc.playerTotal === pt && oc.bankerTotal === bt, name + " outcome() agrees");
      }

      // ---- F. zoneReturnMult settle math ---------------------------------
      const cfg = DEFAULT_CONFIG;
      ok(zoneReturnMult("player", "player", cfg) === 2, "player win -> 2.0x");
      ok(r2(25 * zoneReturnMult("banker", "banker", cfg)) === 48.75, "$25 banker win returns $48.75 total");
      ok(r2(100 * zoneReturnMult("banker", "banker", cfg)) === 195, "$100 banker win returns $195 (net +$95)");
      ok(r2(15 * zoneReturnMult("banker", "banker", cfg)) === 29.25, "$15 banker win returns $29.25 (r2 cents)");
      ok(r2(100 * zoneReturnMult("player", "player", cfg)) === 200, "$100 player win returns $200 (net +$100)");
      ok(zoneReturnMult("tie", "tie", cfg) === 9, "tie win -> 9.0x");
      ok(r2(10 * zoneReturnMult("tie", "tie", cfg)) === 90, "$10 tie win returns $90 (net +$80)");
      ok(zoneReturnMult("player", "tie", cfg) === 1, "tie coup -> player zone PUSH 1.0x");
      ok(zoneReturnMult("banker", "tie", cfg) === 1, "tie coup -> banker zone PUSH 1.0x");
      ok(r2(100 * zoneReturnMult("player", "tie", cfg)) === 100, "tie coup, $100 player -> $100 back (delta 0)");
      ok(zoneReturnMult("player", "banker", cfg) === 0, "losing player zone -> 0");
      ok(zoneReturnMult("banker", "player", cfg) === 0, "losing banker zone -> 0");
      ok(zoneReturnMult("tie", "player", cfg) === 0, "tie zone loses on player win");
      ok(zoneReturnMult("tie", "banker", cfg) === 0, "tie zone loses on banker win");
      ok(zoneReturnMult("banker", "banker") === zoneReturnMult("banker", "banker", cfg), "cfg omitted -> DEFAULT_CONFIG");
      ok(DEFAULT_CONFIG.decks === 8 && DEFAULT_CONFIG.minBet === 10 && DEFAULT_CONFIG.commission === 0.05 &&
        DEFAULT_CONFIG.tiePays === 8 && DEFAULT_CONFIG.maxSeats === 4, "DEFAULT_CONFIG values");

      // ---- G. deterministic fuzz: 1M coups off the top of a fresh 8-deck
      // shoe -> outcome frequencies converge to the exact Wizard-of-Odds
      // 8-deck values (Banker 45.8597% / Player 44.6247% / Tie 9.5156%).
      // Fixed-seed PRNG => bit-for-bit reproducible, never flaky.
      function mulberry32(a) {
        return function () {
          a |= 0; a = (a + 0x6D2B79F5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      const rand = mulberry32(0xBACC21);
      const deck = [];
      for (let d = 0; d < 8; d++) for (const su of SUITS) for (const rk of RANKS) deck.push({ rank: rk, suit: su });
      ok(deck.length === 416, "8-deck shoe = 416 cards");
      const N = 1000000;
      let wb = 0, wp = 0, wt = 0;
      const swaps = [];
      for (let i = 0; i < N; i++) {
        // partial Fisher-Yates: first 6 cards of a uniform full-shoe shuffle
        // (runTableau never uses more than 6), then undo to restore the deck.
        swaps.length = 0;
        for (let k = 0; k < 6; k++) {
          const j = k + Math.floor(rand() * (416 - k));
          if (j !== k) { const tmp = deck[k]; deck[k] = deck[j]; deck[j] = tmp; swaps.push(k, j); }
        }
        const w = runTableau(deck).winner;
        if (w === "banker") wb++; else if (w === "player") wp++; else wt++;
        for (let k = swaps.length - 2; k >= 0; k -= 2) {
          const a = swaps[k], b = swaps[k + 1];
          const tmp = deck[a]; deck[a] = deck[b]; deck[b] = tmp;
        }
      }
      const fb = wb / N, fp = wp / N, ft = wt / N;
      const TOL = 0.002; // ±0.2% absolute (~4σ at 1M samples; deterministic seed)
      ok(Math.abs(fb - 0.458597) < TOL, "fuzz banker freq " + (fb * 100).toFixed(4) + "% ~ 45.8597%");
      ok(Math.abs(fp - 0.446247) < TOL, "fuzz player freq " + (fp * 100).toFixed(4) + "% ~ 44.6247%");
      ok(Math.abs(ft - 0.095156) < TOL, "fuzz tie freq " + (ft * 100).toFixed(4) + "% ~ 9.5156%");
      ok(wb + wp + wt === N, "fuzz outcomes partition");
      ok(deck.length === 416 && deck[0].rank === "A" && deck[0].suit === "S", "deck restored after fuzz");

      if (fails) {
        console.error("SELF-TEST FAILED — " + fails + "/" + checks + " checks failed");
        process.exit(1);
      }
      console.log("SELF-TEST OK — " + checks + " checks (38 tableau vectors, full banker matrix, settle math, " +
        N.toLocaleString() + "-shoe fuzz: B " + (fb * 100).toFixed(2) + "% / P " + (fp * 100).toFixed(2) +
        "% / T " + (ft * 100).toFixed(2) + "%)");
    })();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
