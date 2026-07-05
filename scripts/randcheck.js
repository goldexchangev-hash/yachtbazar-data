// Empirical randomness / operational check for CoinFlipBetting.
// Runs many vs-house flips on a fresh local chain and tallies the coin's
// landed side + win outcomes. Expect ~50/50 heads/tails and a long-run house
// profit of ~10% of total wagered (the rake). Also asserts every flip settles.
//
//   npx hardhat run scripts/randcheck.js
const { ethers } = require("hardhat");

async function main() {
  const N = 600;                       // number of flips
  const bet = ethers.parseEther("0.01");
  const [deployer, treasury, alice] = await ethers.getSigners();

  const Game = await ethers.getContractFactory("CoinFlipBetting");
  const game = await Game.deploy(treasury.address);
  await game.waitForDeployment();

  await (await game.connect(deployer).fundHouse({ value: ethers.parseEther("50") })).wait();
  await (await game.connect(alice).deposit({ value: ethers.parseEther("20") })).wait();

  let heads = 0, tails = 0, playerWins = 0, houseWins = 0, settled = 0;
  const iface = game.interface;
  const bankStart = await game.houseBankroll();

  for (let i = 0; i < N; i++) {
    // alice keeps a fresh balance topped up so she never runs dry
    const gb = await game.balances(alice.address);
    if (gb < bet) await (await game.connect(alice).deposit({ value: ethers.parseEther("20") })).wait();

    const wantsHeads = i % 2 === 0; // alternate the chosen side to be fair
    const rcpt = await (await game.connect(alice).playHouse(bet, wantsHeads)).wait();
    const ev = rcpt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } })
                        .find((p) => p && p.name === "FlipSettled");
    if (!ev) throw new Error(`flip ${i} did not settle (no FlipSettled event)`);
    settled++;
    const landedHeads = ev.args.headsWon;
    landedHeads ? heads++ : tails++;
    const playerWon = landedHeads === wantsHeads;
    playerWon ? playerWins++ : houseWins++;
  }

  const bankEnd = await game.houseBankroll();
  const balEnd = await game.balances(treasury.address);
  const totalBets = bet * BigInt(N);             // the player's stake each flip
  const houseNet = (bankEnd + balEnd) - bankStart; // change in total house holdings
  const expected = totalBets / 10n;              // house edge = +10% of each bet
  const pct = (n) => ((n / N) * 100).toFixed(1) + "%";

  console.log(`\nRan ${settled}/${N} flips — every one settled: ${settled === N ? "✅" : "❌"}`);
  console.log(`Coin landed:  HEADS ${heads} (${pct(heads)})   TAILS ${tails} (${pct(tails)})`);
  console.log(`Outcomes:     player won ${playerWins} (${pct(playerWins)})   house won ${houseWins} (${pct(houseWins)})`);
  console.log(`Total bets:   ${ethers.formatEther(totalBets)} ETH`);
  console.log(`House net P/L: ${ethers.formatEther(houseNet)} ETH  (expected ≈ +10% of bets = ${ethers.formatEther(expected)} ETH)`);
  const headsPct = (heads / N) * 100;
  console.log(`\nFairness: heads share ${headsPct.toFixed(1)}% — ${Math.abs(headsPct - 50) < 6 ? "within normal range of 50/50 ✅" : "outside expected band ⚠️"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
