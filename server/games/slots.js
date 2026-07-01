/* ============================================================
   server/games/slots.js — server-authoritative engine for "Crypto Reels" (CH12).

   Mirrors the EXACT math the client ships in public/slots.js. Two code paths live
   in the client:

     • buildStrip()/spinOutcome()  — a cosmetic "physical reel strip" used only by
       the standalone toy for the spinning animation (Math.random, decorative).
     • simulate()  (public/slots.js:799-814)  — the REAL outcome model the channel /
       on-chain path scores against: it rolls 15 INDEPENDENT weighted cells straight
       from weightedPool() and scores them with the production paytable + 9 paylines.

   The deployed RTP is therefore the simulate() model, NOT the strip. We reproduce
   simulate() exactly: 15 i.i.d. weighted-pool draws, the same 9 paylines, the same
   wild/scatter rules, the same paytable. Measured RTP ≈ 90.78% (the honest figure
   the client itself annotates at slots.js:46 "(~90% RTP)"; the file header's "~95%"
   is aspirational and does NOT match the shipped numbers — we mirror the SHIPPED
   numbers, per the house rule "do not invent new odds").

   Every random draw comes from the committed provably-fair float stream — no
   Math.random — so each cell is server-committed + player-verifiable.

   Mapping client → engine units:
     client totalBet (USD)  == betUnits   (the stake; 1 unit = $1)
     client lineBet         == betUnits / LINES.length      (9 lines)
     client scatter pay     == scatterMult × totalBet  == scatterMult × betUnits
     client line pay        == lineMult × lineBet
   payoutUnits is the GROSS returned to the player (0 on a loss); net = payout - bet.

   Source citations (all public/slots.js):
     SYM weights + paytable ............ lines 37-47
     9 paylines LINES .................. lines 50-60
     evalLine (wild/scatter/3+) ........ lines 332-355
     scatter "anywhere, ×total bet" .... lines 374-384, 811-812
     simulate() 15-cell i.i.d. model ... lines 799-814
   ============================================================ */
"use strict";

const PF = require("../provablyfair.js"); // from server/games/ -> server/provablyfair.js

/* ── Symbols: index = symbol id (0..8). weight + per-count paytable, verbatim from
   public/slots.js:37-47. pay[count] is the multiple for 3/4/5-of-a-kind (indices
   0-2 unused). Total weight = 22+18+16+13+10+7+5+5+4 = 100. ── */
const SYM = [
  { key: "cherry",  weight: 22, pay: [0, 0, 0, 5,  12,  30] },
  { key: "bell",    weight: 18, pay: [0, 0, 0, 5,  16,  42] },
  { key: "star",    weight: 16, pay: [0, 0, 0, 9,  23,  68] },
  { key: "cash",    weight: 13, pay: [0, 0, 0, 13, 42,  115] },
  { key: "eth",     weight: 10, pay: [0, 0, 0, 20, 65,  190] },
  { key: "btc",     weight: 7,  pay: [0, 0, 0, 35, 110, 350] },
  { key: "seven",   weight: 5,  pay: [0, 0, 0, 55, 225, 700] },
  { key: "wild",    weight: 5,  pay: [0, 0, 0, 100, 450, 2500] },
  { key: "scatter", weight: 4,  pay: [0, 0, 0, 4,  22,  120] }, // ×TOTAL bet, anywhere
];

const REELS = 5, ROWS = 3;
const WILD = 7, SCATTER = 8;

// 9 paylines as [row per reel] (row 0 = top … 2 = bottom). public/slots.js:50-60.
const LINES = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
];

// Reusable weight array for PF.pick — index i has weight SYM[i].weight.
const WEIGHTS = SYM.map(function (s) { return s.weight; });

const RTP = 0.9078; // measured (see self-test); the shipped simulate() model.

/* evalLine — verbatim port of public/slots.js:332-355.
   Left-to-right from reel 0; wild substitutes for the pay symbol; scatter never
   starts/forms a line; needs 3+ in a row. Returns { paySym, count, mult } or null. */
function evalLine(grid, line) {
  const first = grid[0][line[0]];
  if (first === SCATTER) return null;
  let pay = first;
  if (pay === WILD) {
    for (let r = 1; r < REELS; r++) {
      const s = grid[r][line[r]];
      if (s !== WILD) { pay = s; break; }
    }
  }
  if (pay === SCATTER) return null; // all-wild reel that resolved to scatter — no pay
  let count = 0;
  for (let r = 0; r < REELS; r++) {
    const s = grid[r][line[r]];
    if (s === pay || s === WILD) count++;
    else break;
  }
  if (count < 3) return null;
  const mult = SYM[pay].pay[count];
  if (!mult) return null;
  return { paySym: pay, count: count, mult: mult };
}

/* Roll a 5×3 grid of 15 INDEPENDENT weighted cells from the float stream.
   Mirrors simulate() (public/slots.js:801-805) which does
   `pool[(Math.random()*pool.length)|0]` per cell — i.e. one weighted pick per cell.
   We consume one float per cell via PF.pick, in column-major order (reel, then row),
   matching the client's nested-loop order. grid[reel][row]. */
function rollGrid(serverSeed, clientSeed, nonce) {
  const grid = [];
  let k = 0;
  for (let i = 0; i < REELS; i++) {
    const col = [];
    for (let r = 0; r < ROWS; r++) {
      col.push(PF.pick(serverSeed, clientSeed, nonce, WEIGHTS, k));
      k++;
    }
    grid.push(col);
  }
  return grid;
}

/* Score a grid in LINE-BET multiples (line wins) + TOTAL-BET multiples (scatter).
   Returns { lineMultTotal, scatterMult, wins:[...], scatterCount }.
   - lineMultTotal: sum of SYM[pay].pay[count] over all 9 lines (×lineBet later).
   - scatterMult:   SYM[SCATTER].pay[min(5,count)] when count>=3 (×totalBet later). */
function scoreGrid(grid) {
  let lineMultTotal = 0;
  const wins = [];
  for (let li = 0; li < LINES.length; li++) {
    const w = evalLine(grid, LINES[li]);
    if (w) {
      lineMultTotal += w.mult;
      wins.push({ line: li, paySym: SYM[w.paySym].key, count: w.count, mult: w.mult });
    }
  }
  // Scatter pays anywhere on the 5×3 grid when 3+ present (public/slots.js:374-384).
  let scatterCount = 0;
  for (let i = 0; i < REELS; i++)
    for (let r = 0; r < ROWS; r++)
      if (grid[i][r] === SCATTER) scatterCount++;
  let scatterMult = 0;
  if (scatterCount >= 3) scatterMult = SYM[SCATTER].pay[Math.min(5, scatterCount)];
  return { lineMultTotal: lineMultTotal, scatterMult: scatterMult, wins: wins, scatterCount: scatterCount };
}

/* play — the pure engine entry point.
   params:
     { lines, betPerLine }  -> stake = lines × betPerLine, lineBet = betPerLine
     { bet }                -> stake = bet, lineBet = bet / LINES.length
     (none)                 -> stake = betUnits, lineBet = betUnits / LINES.length
   In all forms the OUTCOME math is identical (full 9-line all-lines model, exactly
   what the client scores); `lines`/`betPerLine` only re-express the same stake so
   the bridge can label the bet. The client always plays all 9 lines (totalBet =
   lineBet × 9), so we keep lineBet = stake / 9 to match the shipped RTP. */
function play(args) {
  const serverSeed = args.serverSeed;
  const clientSeed = args.clientSeed;
  const nonce = args.nonce;
  const params = args.params || {};

  // mega-hunt CRITICAL (house drain): the stake is ONLY the bridge-DEBITED betUnits — NEVER re-derived from
  // client params. The bridge debits/balance-checks o.betUnits then passes it here as args.betUnits; letting
  // params.bet / params.lines*params.betPerLine override it let a player debit 1 unit but be paid as if the
  // stake were arbitrary (line/scatter payouts scale off betUnits below), and the settle net floor bounds only
  // LOSSES → the inflated positive net is signed and drains the house. Mirror slots3d.js which never overrides.
  let betUnits = Number(args.betUnits);
  if (!(betUnits > 0)) betUnits = 0;

  // lineBet always = stake / 9 (client model: totalBet = lineBet × 9 lines).
  const lineBet = betUnits / LINES.length;

  const grid = rollGrid(serverSeed, clientSeed, nonce);
  const score = scoreGrid(grid);

  // Translate multiples → units. Line wins scale by lineBet; scatter by totalBet.
  const linePay = score.lineMultTotal * lineBet;
  const scatterPay = score.scatterMult * betUnits;
  const payoutUnits = linePay + scatterPay;

  const multiplier = betUnits > 0 ? payoutUnits / betUnits : 0;
  const win = payoutUnits > 0;

  const parts = [];
  for (let i = 0; i < score.wins.length; i++) {
    const w = score.wins[i];
    parts.push("L" + (w.line + 1) + ":" + w.count + "×" + w.paySym + "(" + w.mult + "×)");
  }
  if (score.scatterCount >= 3) parts.push(score.scatterCount + "×scatter(" + score.scatterMult + "× total)");
  const detail = parts.length ? parts.join(", ") : "no win";

  return {
    win: win,
    payoutUnits: payoutUnits,
    multiplier: multiplier,
    outcome: {
      grid: grid,                    // grid[reel][row], symbol ids 0..8
      lineWins: score.wins,
      scatterCount: score.scatterCount,
      scatterMult: score.scatterMult,
      lineMultTotal: score.lineMultTotal,
      lineBet: lineBet,
      betUnits: betUnits,
    },
    detail: detail,
  };
}

module.exports = { play: play, RTP: RTP, SYM: SYM, LINES: LINES, evalLine: evalLine };

/* ---------------- CLI self-test: node server/games/slots.js ---------------- */
if (require.main === module) {
  const ROUNDS = 300000;
  const CLIENT_RTP = 0.9078; // shipped simulate() model (measured below); see header.
  const TOL = 0.008;          // ±0.8%

  // Sanity: total symbol weight should be 100 (matches client comment math).
  const totalW = WEIGHTS.reduce(function (a, b) { return a + b; }, 0);
  console.log("total symbol weight =", totalW, "(expect 100)");

  // One committed seed; vary clientSeed + nonce per round so every draw is a fresh,
  // independently verifiable point of the float stream.
  const round = PF.newRound();
  const serverSeed = round.serverSeed;

  let staked = 0, returned = 0, wins = 0;
  let maxMult = 0, scatterHits = 0;
  const stake = 9; // betUnits = 9 -> lineBet = 1 (exactly the client's unit case)

  for (let n = 0; n < ROUNDS; n++) {
    const clientSeed = "selftest-" + (n % 997); // rotate client seeds
    const res = play({ serverSeed: serverSeed, clientSeed: clientSeed, nonce: n, betUnits: stake });
    staked += stake;
    returned += res.payoutUnits;
    if (res.win) wins++;
    if (res.multiplier > maxMult) maxMult = res.multiplier;
    if (res.outcome.scatterCount >= 3) scatterHits++;
  }

  const measured = returned / staked;
  console.log("rounds            =", ROUNDS);
  console.log("hit frequency     =", (wins / ROUNDS * 100).toFixed(2) + "%");
  console.log("scatter 3+ freq   =", (scatterHits / ROUNDS * 100).toFixed(3) + "%");
  console.log("max multiplier    =", maxMult.toFixed(1) + "×");
  console.log("client RTP (doc)  =", (CLIENT_RTP * 100).toFixed(2) + "%");
  console.log("measured RTP      =", (measured * 100).toFixed(3) + "%");

  // Determinism check: identical inputs reproduce identically.
  const a = play({ serverSeed: serverSeed, clientSeed: "det", nonce: 42, betUnits: 9 });
  const b = play({ serverSeed: serverSeed, clientSeed: "det", nonce: 42, betUnits: 9 });
  const deterministic = JSON.stringify(a) === JSON.stringify(b);
  console.log("deterministic     =", deterministic);

  // mega-hunt: client params must NEVER override the bridge-debited stake (the fixed house-drain). A shot with
  // the SAME betUnits pays IDENTICALLY regardless of any stake-bearing params attached, and betUnits:0 pays 0.
  const g1 = play({ serverSeed: serverSeed, clientSeed: "eq", nonce: 7, betUnits: 9 });
  const g2 = play({ serverSeed: serverSeed, clientSeed: "eq", nonce: 7, betUnits: 9, params: { lines: 9, betPerLine: 1111, bet: 99999 } });
  const g3 = play({ serverSeed: serverSeed, clientSeed: "eq", nonce: 7, betUnits: 0, params: { bet: 99999 } });
  const paramsCantOverride = JSON.stringify(g1) === JSON.stringify(g2) && g3.payoutUnits === 0;
  console.log("params can't override stake =", paramsCantOverride);

  const within = Math.abs(measured - CLIENT_RTP) <= TOL;
  const ok = within && deterministic && paramsCantOverride && totalW === 100;
  console.log(ok
    ? "\nSELF-TEST OK — server RTP within ±0.8% of client, deterministic, params can't inflate the stake."
    : "\nSELF-TEST FAILED" +
      (!within ? " (RTP off by " + (Math.abs(measured - CLIENT_RTP) * 100).toFixed(3) + "%)" : "") +
      (!deterministic ? " (not deterministic)" : "") +
      (!paramsCantOverride ? " (params can override stake — house drain!)" : "") +
      (totalW !== 100 ? " (weight sum != 100)" : ""));
  process.exit(ok ? 0 : 1);
}
