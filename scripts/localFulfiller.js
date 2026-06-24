/**
 * Local-only helper. On a public testnet the real Chainlink oracle fulfils VRF
 * requests automatically — but on your local Hardhat node nobody does, so this
 * watcher plays the oracle: whenever the game emits FlipRequested, it tells the
 * mock coordinator to fulfil that request, which makes the flip resolve.
 *
 * Run it in a separate terminal alongside `npm run chain`:
 *     npm run fulfill:local
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const deploymentPath = path.join(__dirname, "..", "public", "deployment.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("public/deployment.json not found — run `npm run deploy:local` first.");
  }
  const { address, vrfCoordinator } = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  const game = await ethers.getContractAt("CoinFlipBetting", address);
  const mock = await ethers.getContractAt("VRFCoordinatorV2_5Mock", vrfCoordinator);

  console.log("🎲 Local VRF fulfiller running.");
  console.log(`   game:        ${address}`);
  console.log(`   coordinator: ${vrfCoordinator}`);
  console.log("   Waiting for flips...\n");

  game.on(game.getEvent("FlipRequested"), async (roomId, requestId) => {
    try {
      console.log(`→ Flip requested for room ${roomId} (request ${requestId}). Fulfilling...`);
      const tx = await mock.fulfillRandomWords(requestId, address);
      await tx.wait();
      console.log(`✅ Room ${roomId} settled.\n`);
    } catch (e) {
      console.error(`✖ Failed to fulfil room ${roomId}:`, e.message);
    }
  });

  // Keep the process alive.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
