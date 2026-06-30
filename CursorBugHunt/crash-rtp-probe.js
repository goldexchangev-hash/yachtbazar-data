#!/usr/bin/env node
"use strict";
/**
 * Crash RTP probe — resolves REPORT.md #136 (Monte Carlo crash RTP >100%).
 *
 * Methodology:
 *   1. Fixed cashOutAt strategy (constant target) — isolates engine math from strategy mix.
 *   2. Large sample (500k+) — variance of measured RTP scales as O(1/sqrt(N)).
 *   3. Compare measured RTP to theoretical 99% (1 - CRASH_EDGE).
 *   4. Replicate adversarial-suite.js measure() cycling targets to test false-positive hypothesis.
 *
 * Run: node CursorBugHunt/crash-rtp-probe.js
 */
const PF = require("../server/provablyfair.js");
const crash = require("../server/games/crash.js");

const THEORETICAL_RTP = crash.RTP; // 0.99
const LARGE_N = 500000;
const SUITE_N = 80000; // matches adversarial-suite.js SAMPLES
const SUITE_THRESHOLD = 1.001; // adversarial-suite flags rtp > 1.001

function measureFixed(serverSeed, cashOutAt, n) {
  let wagered = 0;
  let returned = 0;
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const r = crash.play({
      serverSeed,
      clientSeed: "fixed-" + (i % 997),
      nonce: i,
      betUnits: 1,
      params: { cashOutAt },
    });
    wagered += 1;
    returned += r.payoutUnits;
    if (r.win) wins++;
  }
  return {
    cashOutAt,
    n,
    wagered,
    returned,
    wins,
    rtp: returned / wagered,
    winRate: wins / n,
  };
}

/** Exact replica of adversarial-suite.js scanGameEconomics measure() for crash. */
function measureSuiteStyle(serverSeed, n) {
  const crashT = [1.01, 1.5, 2, 5, 10, 100];
  const lines = crashT.map((t) => ({ bet: 1, t }));
  let wagered = 0;
  let returned = 0;
  for (let i = 0; i < n; i++) {
    const line = lines[i % lines.length];
    const r = crash.play({
      serverSeed,
      clientSeed: "e",
      nonce: i,
      betUnits: 1,
      params: { cashOutAt: line.t },
    });
    wagered += line.bet;
    returned += r.payoutUnits;
  }
  return {
    n,
    targets: crashT,
    wagered,
    returned,
    rtp: returned / wagered,
    perTarget: crashT.map((t) => {
      const perN = Math.floor(n / crashT.length);
      return measureFixed(serverSeed, t, perN);
    }),
  };
}

/** Normal-approx 95% CI half-width for RTP (bet=1, payout 0 or M). */
function rtpCiHalfWidth(winRate, avgPayoutOnWin, n) {
  // Var(return) = E[R^2] - E[R]^2; RBankroll = M with prob p, else 0.
  const p = winRate;
  const m = avgPayoutOnWin;
  const mean = p * m;
  const varR = p * m * m - mean * mean;
  const se = Math.sqrt(Math.max(0, varR) / n);
  return 1.96 * se;
}

function fmtPct(x) {
  return (x * 100).toFixed(4) + "%";
}

function section(title) {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function main() {
  const { serverSeed } = PF.newRound();
  console.log("Crash RTP probe — REPORT.md #136");
  console.log("Theoretical RTP (any valid cashOutAt): " + fmtPct(THEORETICAL_RTP));
  console.log("serverSeed (committed): " + serverSeed.slice(0, 16) + "...");

  section("1. Fixed strategy — cashOutAt = 2.00x, N = " + LARGE_N.toLocaleString());
  const fixed2 = measureFixed(serverSeed, 2.0, LARGE_N);
  const ci2 = rtpCiHalfWidth(fixed2.winRate, 2.0, LARGE_N);
  const err2 = fixed2.rtp - THEORETICAL_RTP;
  console.log("  measured RTP     : " + fmtPct(fixed2.rtp));
  console.log("  theoretical RTP  : " + fmtPct(THEORETICAL_RTP));
  console.log("  delta            : " + (err2 >= 0 ? "+" : "") + (err2 * 100).toFixed(4) + " pp");
  console.log("  win rate         : " + fmtPct(fixed2.winRate) + " (expect ~49.50%)");
  console.log("  95% CI half-width: ±" + (ci2 * 100).toFixed(4) + " pp");
  console.log("  |delta| <= CI    : " + (Math.abs(err2) <= ci2 ? "yes (within noise)" : "NO — outside 95% CI"));

  section("2. Fixed strategy sweep — multiple targets, N = 100k each");
  const sweepTargets = [1.01, 1.5, 2, 5, 10, 100];
  let sweepMaxDelta = 0;
  let sweepFlagged = false;
  for (const t of sweepTargets) {
    const r = measureFixed(serverSeed, t, 100000);
    const delta = r.rtp - THEORETICAL_RTP;
    const ci = rtpCiHalfWidth(r.winRate, t, 100000);
    const flag = r.rtp > SUITE_THRESHOLD ? " ** >100.1% **" : "";
    if (r.rtp > SUITE_THRESHOLD) sweepFlagged = true;
    sweepMaxDelta = Math.max(sweepMaxDelta, Math.abs(delta));
    console.log(
      "  target " + t.toFixed(2).padStart(6) + "x  RTP=" + fmtPct(r.rtp) +
      "  delta=" + (delta >= 0 ? "+" : "") + (delta * 100).toFixed(3) + "pp" +
      "  CI±" + (ci * 100).toFixed(3) + "pp" + flag
    );
  }

  section("3. Adversarial-suite replica — cycling targets, N = " + SUITE_N.toLocaleString());
  const suite = measureSuiteStyle(serverSeed, SUITE_N);
  const suiteDelta = suite.rtp - THEORETICAL_RTP;
  const suiteFlag = suite.rtp > SUITE_THRESHOLD;
  console.log("  cycling targets  : [" + suite.targets.join(", ") + "]");
  console.log("  measured RTP     : " + fmtPct(suite.rtp));
  console.log("  delta vs 99%     : " + (suiteDelta >= 0 ? "+" : "") + (suiteDelta * 100).toFixed(4) + " pp");
  console.log("  suite threshold  : >" + fmtPct(SUITE_THRESHOLD) + " → " + (suiteFlag ? "WOULD FLAG" : "pass"));
  console.log("  per-target breakdown (equal sub-samples):");
  for (const pt of suite.perTarget) {
    console.log("    " + pt.cashOutAt.toFixed(2) + "x  RTP=" + fmtPct(pt.rtp) + "  wins=" + pt.wins + "/" + pt.n);
  }

  section("4. Multi-seed variance — 20 independent suite-style runs @ 80k");
  let seedFlags = 0;
  let seedMaxRtp = 0;
  const seedRtps = [];
  for (let s = 0; s < 20; s++) {
    const { serverSeed: ss } = PF.newRound();
    const r = measureSuiteStyle(ss, SUITE_N);
    seedRtps.push(r.rtp);
    seedMaxRtp = Math.max(seedMaxRtp, r.rtp);
    if (r.rtp > SUITE_THRESHOLD) seedFlags++;
    console.log("  seed " + String(s + 1).padStart(2) + "  RTP=" + fmtPct(r.rtp) + (r.rtp > SUITE_THRESHOLD ? " ** FLAG **" : ""));
  }
  seedRtps.sort((a, b) => a - b);
  const median = seedRtps[Math.floor(seedRtps.length / 2)];
  console.log("  flagged runs     : " + seedFlags + " / 20");
  console.log("  max RTP observed : " + fmtPct(seedMaxRtp));
  console.log("  median RTP       : " + fmtPct(median));

  section("VERDICT — #136");
  const fixedOk = Math.abs(err2) <= 0.005; // 0.5pp tolerance at 500k
  const exploitLikely = fixed2.rtp > SUITE_THRESHOLD && sweepFlagged;
  const falsePositiveLikely = fixedOk && !exploitLikely && (suiteFlag || seedFlags > 0);

  if (exploitLikely) {
    console.log("  [Critical] Engine RTP consistently >100% with fixed strategy.");
    console.log("  Evidence: fixed 2.0x RTP=" + fmtPct(fixed2.rtp) + " at N=" + LARGE_N);
    process.exit(1);
  }

  if (falsePositiveLikely) {
    console.log("  [Closed — false positive] Cycling-target Monte Carlo at 80k can exceed 100.1%");
    console.log("  by sampling variance alone; fixed-strategy 500k run confirms ~99% RTP.");
    console.log("  Fixed 2.0x: " + fmtPct(fixed2.rtp) + " (delta " + (err2 * 100).toFixed(3) + "pp)");
    console.log("  Suite replica this seed: " + fmtPct(suite.rtp) + (suiteFlag ? " (would flag)" : ""));
    console.log("  Multi-seed: " + seedFlags + "/20 runs would flag at 80k threshold");
    process.exit(0);
  }

  console.log("  [Inconclusive] Results ambiguous — review raw numbers above.");
  process.exit(2);
}

main();
