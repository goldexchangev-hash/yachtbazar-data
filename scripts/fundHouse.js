/**
 * Top up the house bankroll on the deployed contract (any network).
 * The house bankroll is what funds the house's side of "play vs house" games.
 *
 *   AMOUNT=2 npm run fundhouse:local      (local)
 *   AMOUNT=0.2 npx hardhat run scripts/fundHouse.js --network sepolia
 *
 * Must be run by the contract owner (the deployer wallet).
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const deploymentPath = path.join(__dirname, "..", "public", "deployment.json");
  const { address } = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const amount = ethers.parseEther(process.env.AMOUNT || "1");

  const game = await ethers.getContractAt("CoinFlipBetting", address);
  console.log(`Funding house bankroll with ${ethers.formatEther(amount)} ETH...`);
  const tx = await game.fundHouse({ value: amount });
  await tx.wait();
  const bankroll = await game.houseBankroll();
  console.log(`✅ House bankroll is now ${ethers.formatEther(bankroll)} ETH`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
