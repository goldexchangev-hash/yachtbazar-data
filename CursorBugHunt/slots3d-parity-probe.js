#!/usr/bin/env node
"use strict";
/**
 * Pass 5 — Gem Vault 3D client/server math parity probe.
 *
 * Compares public/slots3d-engine.js evaluate() against server/games/slots3d.js
 * play()/evaluate() on 10k server-derived grids, then simulates the token-mode
 * client balance replay (debit stake → credit base E.evaluate → credit server bonus plan).
 *
 * Run: node CursorBugHunt/slots3d-parity-probe.js
 */
const PF = require("../server/provablyfair.js");
const S = require("../server/games/slots3d.js");
const C = require("../public/slots3d-engine.js");
const { makeTokenBridge } = require("../server/token-bridge.js");

const N = 10000;
const BETS = [10, 20, 50, 100, 1.25, 33.33]; // mix of clean + fractional line bets
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const findings = [];
function bug(severity, id, title, detail, evidence) {
  findings.push({ severity, id, title, detail, evidence });
}

function gridsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (!b[r] || a[r].length !== b[r].length) return false;
    for (let row = 0; row < a[r].length; row++) if (a[r][row] !== b[r][row]) return false;
  }
  return true;
}

/** Mirror slots3d.js token replay: debit bet, E.evaluate base, credit server bonus plan. */
function clientTokenBalanceAfter(startTokens, bet, playResult) {
  let balance = round2(startTokens - bet);
  const grid = playResult.outcome.grid;
  const base = C.evaluate(grid, bet);
  if (base.winUsd > 0) balance = round2(balance + base.winUsd);
  const bonus = playResult.outcome.bonus;
  if (bonus && bonus.results) {
    for (const spin of bonus.results) {
      const winUsd = round2(spin.win);
      if (winUsd > 0) balance = round2(balance + winUsd);
    }
  }
  return { balance, baseWinUsd: base.winUsd, base };
}

console.log("=".repeat(72));
console.log("Gem Vault 3D — client/server parity probe (Pass 5)");
console.log("=".repeat(72));
console.log("Client: public/slots3d-engine.js evaluate()");
console.log("Server: server/games/slots3d.js play() / evaluate()");
console.log("Spins:  " + N);
console.log("");

const stats = {
  spins: 0,
  baseEvalMismatch: 0,
  bonusSpinEvalMismatch: 0,
  fullPayoutMismatch: 0,
  demoBonusTotalMismatch: 0,
  demoGridDerivMismatch: 0,
  tokenBalanceMismatch: 0,
  bonusTriggers: 0,
  bonusSpinChecks: 0,
  serverWins: 0,
  clientBaseHigher: 0,
  clientBaseLower: 0,
};

const samples = {
  baseEval: [],
  bonusSpinEval: [],
  fullPayout: [],
  demoBonus: [],
  demoGrid: [],
  tokenBalance: [],
};

for (let i = 0; i < N; i++) {
  const serverSeed = PF.randomSeed(32);
  const clientSeed = "parity-" + Math.floor(Math.random() * 1e9).toString(36);
  const nonce = Math.floor(Math.random() * 1e9);
  const bet = BETS[i % BETS.length];

  const r = S.play({ serverSeed, clientSeed, nonce, betUnits: bet });
  const grid = r.outcome.grid;
  stats.spins++;
  if (r.win) stats.serverWins++;

  const srvEval = S.evaluate(grid, bet);
  const cliEval = C.evaluate(grid, bet);

  // 1) Base evaluate parity on server grid
  if (Math.abs(srvEval.win - cliEval.winUsd) > 1e-9) {
    stats.baseEvalMismatch++;
    if (samples.baseEval.length < 5) {
      samples.baseEval.push({
        i, bet, nonce, clientSeed,
        serverWin: srvEval.win,
        clientWinUsd: cliEval.winUsd,
        delta: round2(cliEval.winUsd - srvEval.win),
        grid: JSON.stringify(grid),
        serverLines: srvEval.lines.length,
        clientLines: cliEval.lines.length,
      });
    }
    if (cliEval.winUsd > srvEval.win) stats.clientBaseHigher++;
    else stats.clientBaseLower++;
  }

  // 2) Full payout: server play vs client base + server bonus total (token replay uses server bonus)
  const clientBaseWin = cliEval.winUsd;
  const bonusTotal = r.outcome.bonus ? r.outcome.bonus.total : 0;
  const clientFull = round2(clientBaseWin + bonusTotal);
  if (Math.abs(r.payoutUnits - clientFull) > 1e-9) {
    stats.fullPayoutMismatch++;
    if (samples.fullPayout.length < 5) {
      samples.fullPayout.push({
        i, bet, serverPayout: r.payoutUnits, clientFull, delta: round2(clientFull - r.payoutUnits),
        serverBase: srvEval.win, clientBase: clientBaseWin, bonusTotal,
      });
    }
  }

  // 3) Bonus spins: evaluate parity on SERVER free-spin grids (token path replays these)
  if (r.outcome.scatter && r.outcome.scatter.count >= 3) {
    stats.bonusTriggers++;
    const sc = r.outcome.scatter.count;
    const srvBonus = r.outcome.bonus;
    if (srvBonus && srvBonus.results) {
      for (const sr of srvBonus.results) {
        stats.bonusSpinChecks++;
        const se = S.evaluate(sr.grid, bet);
        const ce = C.evaluate(sr.grid, bet);
        const cliBonusWin = round2(ce.winUsd * C.FREE_MULT);
        if (Math.abs(se.win - ce.winUsd) > 1e-9 || Math.abs(sr.win - cliBonusWin) > 1e-9) {
          stats.bonusSpinEvalMismatch++;
          if (samples.bonusSpinEval.length < 5) {
            samples.bonusSpinEval.push({
              i, bet, serverWin: se.win, clientWinUsd: ce.winUsd,
              serverBonusWin: sr.win, clientBonusWin: cliBonusWin,
            });
          }
        }
      }
    }
    // Demo-only: client HMAC deriveBonus vs server PF deriveBonus (different grids by design)
    const cliBonus = C.deriveBonus(serverSeed, clientSeed, nonce, bet, sc);
    const srvBonusTotal = srvBonus ? srvBonus.total : 0;
    if (Math.abs(srvBonusTotal - cliBonus.totalUsd) > 1e-9) {
      stats.demoBonusTotalMismatch++;
      if (samples.demoBonus.length < 5) {
        samples.demoBonus.push({
          i, bet, sc, serverBonusTotal: srvBonusTotal, clientBonusTotal: cliBonus.totalUsd,
        });
      }
    }
    const srvG0 = srvBonus && srvBonus.results[0] ? srvBonus.results[0].grid : null;
    const cliG0 = cliBonus.results[0] ? cliBonus.results[0].grid : null;
    if (srvG0 && cliG0 && !gridsEqual(srvG0, cliG0)) {
      stats.demoGridDerivMismatch++;
      if (samples.demoGrid.length < 3) {
        samples.demoGrid.push({ i, bet, sc, note: "free-spin grid[0] differs (HMAC vs PF floats)" });
      }
    }
  }

  // Demo base grid derivation (HMAC) vs server PF grid — informational
  const cliGrid = C.deriveGrid(serverSeed, clientSeed, nonce);
  if (!gridsEqual(grid, cliGrid)) stats.demoGridDerivMismatch++;

  // 4) Per-spin line scatter field sanity (pay vs payUsd — same math, different key)
  if (cliEval.scatter && srvEval.scatter) {
    const sp = srvEval.scatter.pay;
    const cp = cliEval.scatter.payUsd;
    if (Math.abs(sp - cp) > 1e-9) {
      stats.baseEvalMismatch++;
    }
  }
}

// Token-bridge path: 2000 plays through makeTokenBridge
console.log("Token path replay (2000 bridge plays)…");
const tb = makeTokenBridge({});
const st = tb.start({ player: "0xParityProbe", buyInUnits: 500000, chainId: 1, contract: "0x0" });
const sid = st.sessionId;
let tokenPlays = 0;

for (let i = 0; i < 2000; i++) {
  const sess = tb.session(sid);
  if (sess.closed || sess.tokens < 10) break;
  const bet = BETS[i % BETS.length];
  if (bet > sess.tokens) continue;
  const before = sess.tokens;
  const clientSeed = "tok-" + i;
  let r;
  try {
    r = tb.play({ sessionId: sid, game: "slots3d", betUnits: bet, params: {}, clientSeed });
  } catch (e) {
    break;
  }
  tokenPlays++;
  const replay = clientTokenBalanceAfter(before, bet, {
    outcome: r.outcome,
    payoutUnits: r.payoutUnits,
  });
  const expected = round2(before - bet + r.payoutUnits);
  if (Math.abs(replay.balance - r.tokens) > 1e-9 || Math.abs(replay.balance - expected) > 1e-9) {
    stats.tokenBalanceMismatch++;
    if (samples.tokenBalance.length < 5) {
      samples.tokenBalance.push({
        i, bet, before, serverTokens: r.tokens, clientReplay: replay.balance,
        expectedFromPayout: expected, payoutUnits: r.payoutUnits,
        baseWinUsd: replay.baseWinUsd, serverBase: S.evaluate(r.outcome.grid, bet).win,
        bonusTotal: r.outcome.bonus ? r.outcome.bonus.total : 0,
      });
    }
  }
  // Also verify bridge payout matches S.play directly
  const direct = S.play({
    serverSeed: sess.serverSeed,
    clientSeed,
    nonce: r.nonce,
    betUnits: bet,
  });
  if (Math.abs(direct.payoutUnits - r.payoutUnits) > 1e-9) {
    stats.fullPayoutMismatch++;
  }
}

// Exhaustive evaluate on all symbol grids? Skip — use targeted edge grids too.
console.log("Targeted edge grids…");
const edgeGrids = [];
// 5-of-a-kind wild line
edgeGrids.push([[6,6,6],[6,6,6],[6,6,6],[6,6,6],[6,6,6]]);
// all scatter
edgeGrids.push([[7,7,7],[7,7,7],[7,7,7],[7,7,7],[7,7,7]]);
// wild leading, cherry rest on middle line
edgeGrids.push([[6,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]]);
// 2 scatter (no pay)
edgeGrids.push([[7,0,0],[0,0,0],[7,0,0],[0,0,0],[0,0,0]]);
// mixed wild scatter line
edgeGrids.push([[6,7,0],[6,0,0],[6,0,0],[0,0,0],[0,0,0]]);

for (const grid of edgeGrids) {
  for (const bet of [20, 100]) {
    const sw = S.evaluate(grid, bet).win;
    const cw = C.evaluate(grid, bet).winUsd;
    if (Math.abs(sw - cw) > 1e-9) {
      stats.baseEvalMismatch++;
      samples.baseEval.push({ edge: true, bet, serverWin: sw, clientWinUsd: cw, grid: JSON.stringify(grid) });
    }
  }
}

// Report
console.log("");
console.log("── Results ──");
console.log("  Random spins tested     : " + stats.spins);
console.log("  Server winning spins    : " + stats.serverWins + " (" + (100 * stats.serverWins / stats.spins).toFixed(2) + "%)");
console.log("  Free-spins triggers     : " + stats.bonusTriggers);
console.log("  Base evaluate mismatches: " + stats.baseEvalMismatch + (stats.baseEvalMismatch ? " ❌" : " ✅"));
console.log("  Bonus-spin eval checks  : " + stats.bonusSpinChecks);
console.log("  Bonus-spin eval mismatch: " + stats.bonusSpinEvalMismatch + (stats.bonusSpinEvalMismatch ? " ❌" : " ✅"));
console.log("  Full payout mismatches  : " + stats.fullPayoutMismatch + (stats.fullPayoutMismatch ? " ❌" : " ✅"));
console.log("  Token bridge plays      : " + tokenPlays);
console.log("  Token balance mismatches: " + stats.tokenBalanceMismatch + (stats.tokenBalanceMismatch ? " ❌" : " ✅"));
console.log("  Demo grid deriv differs : " + stats.demoGridDerivMismatch + " spins (HMAC vs PF — expected, not evaluate bug)");
console.log("  Demo bonus total differs: " + stats.demoBonusTotalMismatch + " / " + stats.bonusTriggers + " bonus rounds");

const evalParityOk = stats.baseEvalMismatch === 0 && stats.bonusSpinEvalMismatch === 0;
const tokenParityOk = stats.tokenBalanceMismatch === 0 && stats.fullPayoutMismatch === 0;
const parityOk = evalParityOk && tokenParityOk;

console.log("");
console.log("── Verdict ──");
console.log("  evaluate(grid,bet) on server grids : " + (evalParityOk ? "PROVEN PARITY ✅" : "FAIL ❌"));
console.log("  token replay → r.tokens             : " + (tokenParityOk ? "PROVEN PARITY ✅" : "FAIL ❌"));
console.log("  demo deriveGrid/deriveBonus         : " + (stats.demoBonusTotalMismatch === 0 ? "matches" : "DIFFERS (separate RNG paths)"));
console.log("");
console.log(parityOk ? "MATH PARITY OK ✅" : "MATH PARITY FAIL ❌");

function printSamples(label, arr) {
  if (!arr.length) return;
  console.log("\n  " + label + ":");
  arr.forEach((s, j) => console.log("    [" + j + "] " + JSON.stringify(s)));
}
printSamples("Base evaluate mismatches", samples.baseEval);
printSamples("Bonus-spin evaluate mismatches", samples.bonusSpinEval);
printSamples("Full payout mismatches", samples.fullPayout);
printSamples("Token balance mismatches", samples.tokenBalance);
printSamples("Demo bonus total diffs (grid deriv, not evaluate)", samples.demoBonus);

// Bug classification for REPORT — only REAL math bugs, not demo RNG path difference
if (stats.baseEvalMismatch > 0 || stats.bonusSpinEvalMismatch > 0) {
  bug("Critical", "S3D-EVAL-PARITY", "Client evaluate() ≠ server evaluate() on same grid",
    stats.baseEvalMismatch + " base + " + stats.bonusSpinEvalMismatch + " bonus-spin grids differ. "
    + "Token mode replays E.evaluate() — would desync ledger/UI.",
    JSON.stringify(samples.baseEval[0] || samples.bonusSpinEval[0], null, 2));
}
if (stats.tokenBalanceMismatch > 0) {
  bug("High", "S3D-TOKEN-REPLAY", "Token replay balance ≠ r.tokens after server grid replay",
    "Simulated slots3d.js arithmetic diverges from bridge ledger.",
    JSON.stringify(samples.tokenBalance[0], null, 2));
}
if (stats.fullPayoutMismatch > 0) {
  bug("Medium", "S3D-PAYOUT-RECON", "Server payoutUnits ≠ client base + bonus reconstruction",
    "Payout assembly mismatch on server-authoritative path.",
    JSON.stringify(samples.fullPayout[0], null, 2));
}
// Demo grid derivation uses client HMAC vs server PF — documented architectural split
if (stats.demoBonusTotalMismatch > 0 && evalParityOk && tokenParityOk) {
  bug("Medium", "S3D-DEMO-GRID-DERIV", "Demo deriveGrid/deriveBonus uses HMAC; server/token uses PF floats",
    stats.demoBonusTotalMismatch + "/" + stats.bonusTriggers + " bonus rounds differ in total because free-spin "
    + "grids are not byte-identical across RNG paths. evaluate() is identical on the same grid; "
    + "token mode is unaffected (server sends grids). Demo provably-fair verify() uses HMAC path only.",
    JSON.stringify(samples.demoBonus[0], null, 2));
}

if (findings.length) {
  console.log("\n── FINDINGS ──");
  findings.forEach((f) => {
    console.log("\n[" + f.severity + "] " + f.id + " — " + f.title);
    console.log(f.detail);
    if (f.evidence) console.log("Evidence:\n" + f.evidence);
  });
} else {
  console.log("\nNo math parity bugs — evaluate() and token replay are aligned.");
}

process.exit(parityOk ? 0 : 1);
