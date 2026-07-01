/* ============================================================
   server/games/slots3d.js — SERVER-AUTHORITATIVE engine for
   "GEM VAULT 3D" (Crypto TV channel 15).

   Mirrors the client math in public/slots3d-engine.js EXACTLY:
     • 8 symbols, WILD (id 6) substitutes for all but SCATTER (id 7)
     • 5×3 grid, 20 fixed paylines
     • Per-line paytable PAY[sym][count-3]   (public/slots3d-engine.js:94-102)
     • Scatter-anywhere paytable SCATTER_PAY  (public/slots3d-engine.js:104)
     • Per-reel weighted strips WEIGHTS       (public/slots3d-engine.js:120-127)
       built into flat STRIPS via the SAME deterministic Fisher–Yates LCG
       shuffle                                (public/slots3d-engine.js:128-139)
     • Left-to-right line evaluation w/ WILD substitution + scatter anywhere
                                              (public/slots3d-engine.js:159-182)
     • Free-spins bonus: 3/4/5 vaults → 8/12/20 spins, ×2 each, deterministic
                                              (public/slots3d-engine.js:190-204)

   The CLIENT keys its grid off its own HMAC(serverSeed, clientSeed:nonce).
   This SERVER engine instead derives every reel stop + every free-spin grid
   from the shared commit-reveal float stream in server/provablyfair.js, so
   ALL randomness is server-committed + player-verifiable through ONE engine.
   The symbol DISTRIBUTION is identical (each reel stop is uniform over a
   length-43 strip in both), so the modeled RTP is unchanged (~94.5% total).

   Pure function — exports { play, RTP }.   1 unit = $1.
   ============================================================ */
"use strict";

const PF = require("../provablyfair.js"); // server/provablyfair.js

/* ---------------- theme: symbols + paytable (ported verbatim) ---------------- */
const WILD = 6, SCATTER = 7;

// Payout per matching LINE (multiples of the per-line bet): index [3,4,5 of a kind].
const PAY = {
  0: [3, 7, 18],       // cherry
  1: [4, 12, 30],      // bell
  2: [7, 18, 58],      // star
  3: [12, 36, 115],    // lucky 7
  4: [21, 73, 231],    // gold bar
  5: [36, 145, 580],   // diamond
  6: [58, 231, 1154],  // wild line
};
// scatter pays × TOTAL bet for 3/4/5 anywhere
const SCATTER_PAY = { 3: 3, 4: 15, 5: 73 };

// 20 fixed paylines over a 5×3 grid (rows: 0 top, 1 middle, 2 bottom).
const LINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 0, 0], [2, 2, 1, 2, 2], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1],
  [1, 0, 1, 0, 1], [1, 2, 1, 2, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
  [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [1, 1, 0, 1, 1], [1, 1, 2, 1, 1],
  [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [0, 2, 0, 2, 0],
];

// Per-reel weighted strips: cherry,bell,star,seven,bar,diamond,wild,scatter
const WEIGHTS = [
  [10, 9, 7, 6, 4, 3, 2, 2],
  [10, 9, 7, 6, 4, 3, 2, 2],
  [10, 9, 8, 6, 4, 2, 2, 2],
  [10, 9, 7, 6, 4, 3, 2, 2],
  [10, 9, 7, 6, 4, 3, 2, 2],
];
// Flat strips + the EXACT same fixed-LCG Fisher–Yates shuffle as the client,
// so each reel's strip (and thus its symbol probabilities) is byte-identical.
const STRIPS = WEIGHTS.map((w) => {
  const strip = [];
  for (let sym = 0; sym < w.length; sym++) for (let n = 0; n < w[sym]; n++) strip.push(sym);
  let seed = 0x9e3779b9 ^ (strip.length * 2654435761);
  for (let i = strip.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1); const t = strip[i]; strip[i] = strip[j]; strip[j] = t;
  }
  return strip;
});

/* ---------------- grid derivation (server: PF float stream) ---------------- */
// One reel stop per reel from the PF float stream. Client uses uint32 % len
// (uniform over the strip); PF gives a float in [0,1) → floor(f*len) is the
// SAME uniform distribution, so symbol odds match exactly. We consume 5
// consecutive floats (one per reel) from (serverSeed, clientSeed, nonce).
function deriveGrid(serverSeed, clientSeed, nonce) {
  const f = PF.floats(serverSeed, clientSeed, nonce, 5);
  const grid = [[], [], [], [], []];
  for (let r = 0; r < 5; r++) {
    const strip = STRIPS[r], L = strip.length;
    const stop = Math.floor(f[r] * L) % L;
    for (let row = 0; row < 3; row++) grid[r][row] = strip[(stop + row) % L];
  }
  return grid; // grid[reel][row]
}

/* ---------------- evaluation (ported verbatim) ---------------- */
function evaluate(grid, totalBet) {
  const lineBet = (totalBet || 0) / LINES.length;
  let win = 0; const wins = [];
  for (let li = 0; li < LINES.length; li++) {
    const rows = LINES[li];
    const first = grid[0][rows[0]];
    let target = first;
    if (target === WILD) { for (let r = 1; r < 5; r++) { const s = grid[r][rows[r]]; if (s !== WILD) { target = s; break; } } }
    if (target === SCATTER) continue; // scatter never pays on a line
    let count = 0;
    for (let r = 0; r < 5; r++) { const s = grid[r][rows[r]]; if (s === target || s === WILD) count++; else break; }
    if (count >= 3 && PAY[target]) {
      const mult = PAY[target][count - 3];
      if (mult > 0) { const p = mult * lineBet; win += p; wins.push({ line: li, sym: target, count: count, pay: p, rows: rows.slice() }); }
    }
  }
  // scatter anywhere
  let sc = 0; const scCells = [];
  for (let r = 0; r < 5; r++) for (let row = 0; row < 3; row++) if (grid[r][row] === SCATTER) { sc++; scCells.push([r, row]); }
  let scatterPay = 0;
  if (sc >= 3) { scatterPay = (SCATTER_PAY[Math.min(5, sc)] || 0) * (totalBet || 0); win += scatterPay; }
  return {
    win: Math.round(win * 100) / 100,
    lines: wins,
    scatter: sc >= 3 ? { count: sc, pay: scatterPay, cells: scCells } : null,
  };
}

/* ---------------- free-spins bonus (ported verbatim) ---------------- */
const FREE_SPINS = { 3: 8, 4: 12, 5: 20 };
const FREE_MULT = 2;
function freeSpinsFor(scatterCount) { return FREE_SPINS[Math.min(5, scatterCount | 0)] || 0; }
function deriveBonus(serverSeed, clientSeed, nonce, totalBet, scatterCount) {
  const spins = freeSpinsFor(scatterCount);
  const results = []; let total = 0;
  for (let i = 0; i < spins; i++) {
    // distinct, deterministic sub-nonce per free spin (mirrors client's
    // nonce + ":free:" + i) so every free grid is independently verifiable.
    const grid = deriveGrid(serverSeed, clientSeed, String(nonce) + ":free:" + i);
    const r = evaluate(grid, totalBet);
    const winUnits = Math.round(r.win * FREE_MULT * 100) / 100;
    total += winUnits;
    results.push({ grid: grid, lines: r.lines, scatter: r.scatter, base: r.win, win: winUnits });
  }
  return { spins: spins, mult: FREE_MULT, results: results, total: Math.round(total * 100) / 100 };
}

/* ============================================================
   play() — the server-authoritative contract.
   betUnits  = total stake for the spin (already debited; 1 unit = $1).
   params    = { } (slots take no extra params; bet is the stake).
   Returns GROSS payoutUnits the player gets back (0 on a pure loss).
   ============================================================ */
function play(args) {
  args = args || {};
  const serverSeed = args.serverSeed;
  const clientSeed = args.clientSeed;
  const nonce = args.nonce;
  const betUnits = Number(args.betUnits) || 0;

  const grid = deriveGrid(serverSeed, clientSeed, nonce);
  const base = evaluate(grid, betUnits);

  let bonus = null;
  let payoutUnits = base.win;
  if (base.scatter && base.scatter.count >= 3 && freeSpinsFor(base.scatter.count) > 0) {
    bonus = deriveBonus(serverSeed, clientSeed, nonce, betUnits, base.scatter.count);
    payoutUnits += bonus.total;
  }
  payoutUnits = Math.round(payoutUnits * 100) / 100;

  const multiplier = betUnits > 0 ? Math.round((payoutUnits / betUnits) * 1e6) / 1e6 : 0;
  const win = payoutUnits > 0;

  let detail = "spin#" + String(nonce) + " base=" + base.win.toFixed(2);
  if (bonus) detail += " +bonus(" + bonus.spins + " free ×" + bonus.mult + ")=" + bonus.total.toFixed(2);
  detail += " → payout=" + payoutUnits.toFixed(2) + " (" + multiplier.toFixed(2) + "×)";

  return {
    win: win,
    payoutUnits: payoutUnits,
    multiplier: multiplier,
    outcome: {
      grid: grid,
      baseWin: base.win, // the AUTHORITATIVE base-reel win (excl. free-spin bonus). The client must DISPLAY this,
                         // not re-derive it from the grid — server grids come from PF.floats while the client's
                         // own E.evaluate keys off HMAC, so a re-derivation can disagree (win-sound-on-a-loss /
                         // a real win shown as $0.00 with no credit). Tokens are credited from payoutUnits below.
      lines: base.lines,
      scatter: base.scatter,
      bonus: bonus, // null unless free spins triggered
    },
    detail: detail,
  };
}

const RTP = 0.95; // client-documented target (public/slots3d-engine.js:118 — "~95%")

module.exports = {
  play: play,
  RTP: RTP,
  // exposed for verification / reuse
  PAY: PAY, SCATTER_PAY: SCATTER_PAY, LINES: LINES, STRIPS: STRIPS,
  WILD: WILD, SCATTER: SCATTER, FREE_SPINS: FREE_SPINS, FREE_MULT: FREE_MULT,
  deriveGrid: deriveGrid, evaluate: evaluate, deriveBonus: deriveBonus, freeSpinsFor: freeSpinsFor,
};

/* ============================================================
   CLI self-test:  node server/games/slots3d.js
   Monte-Carlo ~300k spins with random client seeds + nonces off freshly
   committed server seeds; print measured RTP and assert it is within
   ~0.8% of the client's documented ~95% (and matches the client engine,
   which itself measures ~94.5% over the same sample size).
   ============================================================ */
if (require.main === module) {
  // The free-spins bonus is rare + high-magnitude, so a single 300k batch is
  // noisy (±~0.4%). We run BATCHES of 300k and average — the documented target
  // is ~95% (public/slots3d-engine.js:118) and the pooled mean must land within
  // ±0.8% of it. Total spins ≈ 1.5M keeps the estimate tight.
  const BATCH = 300000, BATCHES = 5;
  const N = BATCH * BATCHES;
  const BET = 20; // $20 stake — divisible by 20 lines, like the live game
  let totalReturned = 0;
  let wins = 0, bonusTriggers = 0, biggest = 0;
  const batchRTPs = [];

  for (let b = 0; b < BATCHES; b++) {
    let batchRet = 0;
    for (let i = 0; i < BATCH; i++) {
      const serverSeed = PF.randomSeed(32);
      const clientSeed = "cs-" + Math.floor(Math.random() * 1e9).toString(36);
      const nonce = Math.floor(Math.random() * 1e9);
      const r = play({ serverSeed: serverSeed, clientSeed: clientSeed, nonce: nonce, betUnits: BET });
      batchRet += r.payoutUnits;
      if (r.win) wins++;
      if (r.outcome.bonus) bonusTriggers++;
      if (r.multiplier > biggest) biggest = r.multiplier;
    }
    totalReturned += batchRet;
    batchRTPs.push(batchRet / (BATCH * BET));
  }

  const measuredRTP = totalReturned / (N * BET);
  const targetRTP = 0.95;  // client-documented target (~95%)
  const tol = 0.008;       // ±0.8%
  const within = Math.abs(measuredRTP - targetRTP) <= tol;

  console.log("Gem Vault 3D (slots3d) — server engine self-test");
  console.log("  spins              : " + N + " (" + BATCHES + "×" + BATCH + ") @ bet " + BET + " units");
  console.log("  hit rate           : " + (100 * wins / N).toFixed(2) + "%");
  console.log("  free-spins trigger : " + (100 * bonusTriggers / N).toFixed(3) + "% of spins");
  console.log("  biggest payout     : " + biggest.toFixed(2) + "×");
  console.log("  per-batch RTP      : " + batchRTPs.map((x) => (100 * x).toFixed(2) + "%").join(", "));
  console.log("  pooled RTP         : " + (100 * measuredRTP).toFixed(2) + "%");
  console.log("  client target RTP  : " + (100 * targetRTP).toFixed(2) + "% (±" + (100 * tol).toFixed(1) + "%)");
  console.log(within ? "  PARITY OK ✅" : "  PARITY FAIL ❌");

  // sanity: a forced verifiable example re-derives identically
  const s = PF.newRound();
  const a = play({ serverSeed: s.serverSeed, clientSeed: "demo", nonce: 1, betUnits: BET });
  const b = play({ serverSeed: s.serverSeed, clientSeed: "demo", nonce: 1, betUnits: BET });
  const deterministic = JSON.stringify(a.outcome.grid) === JSON.stringify(b.outcome.grid) && a.payoutUnits === b.payoutUnits;
  console.log("  deterministic re-derive: " + (deterministic ? "ok" : "FAIL"));

  if (!within || !deterministic) process.exit(1);
  process.exit(0);
}
