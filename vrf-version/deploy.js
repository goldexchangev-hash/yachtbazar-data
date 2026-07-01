/**
 * Deploys CoinFlipBetting.
 *
 *  - On the local network (chainId 31337) it first deploys a Chainlink VRF v2.5
 *    *mock*, creates & funds a subscription, deploys the game, and registers it
 *    as a consumer — a fully self-contained local setup.
 *
 *  - On Sepolia it uses the real Chainlink VRF coordinator + your existing
 *    subscription (configured via .env), then tries to add the game as a
 *    consumer if your deployer owns the subscription.
 *
 * After deploying it writes:
 *    public/deployment.json   (address, abi, network metadata)
 *    public/config.js         (same data as a browser-loadable global)
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

// Chainlink VRF v2.5 settings per network.
// Sepolia values are the public Chainlink defaults (see chain.link/docs).
const SEPOLIA = {
  vrfCoordinator: "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B",
  // 500 gwei key hash
  keyHash: "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae",
};

// Mock VRF coordinator constructor params (base fee, gas price, LINK/ETH).
const MOCK_BASE_FEE = 100000000000000000n; // 0.1 LINK
const MOCK_GAS_PRICE = 1000000000n; // 1 gwei
const MOCK_WEI_PER_UNIT_LINK = 4000000000000000n; // 0.004 ETH per LINK

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const isLocal = network.config.chainId === 31337;

  console.log(`\nNetwork:  ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // Treasury = fee recipient + house wallet (the "host" — that's you).
  // Hardcoded to the project owner's wallet; override with TREASURY_ADDRESS.
  const treasury = process.env.TREASURY_ADDRESS || "0x2F4BEF94550C29c497b999B86b758F9771F7aB39";

  let vrfCoordinator, keyHash, subscriptionId;

  if (isLocal) {
    console.log("→ Deploying local Chainlink VRF v2.5 mock...");
    const Mock = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    const mock = await Mock.deploy(MOCK_BASE_FEE, MOCK_GAS_PRICE, MOCK_WEI_PER_UNIT_LINK);
    await mock.waitForDeployment();
    vrfCoordinator = await mock.getAddress();

    const subTx = await mock.createSubscription();
    const subRcpt = await subTx.wait();
    // The SubscriptionCreated event carries the new subId.
    subscriptionId = subRcpt.logs
      .map((l) => {
        try {
          return mock.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "SubscriptionCreated").args.subId;

    await (await mock.fundSubscription(subscriptionId, ethers.parseEther("1000"))).wait();
    keyHash = "0x" + "ab".repeat(32); // any 32-byte value works for the mock

    console.log(`   mock coordinator: ${vrfCoordinator}`);
    console.log(`   subscription id:  ${subscriptionId}`);

    // Deploy the game.
    const game = await deployGame(vrfCoordinator, keyHash, subscriptionId, treasury);
    await (await mock.addConsumer(subscriptionId, await game.getAddress())).wait();
    console.log("   consumer registered with mock subscription.");

    // Pre-fund the house bankroll so visitors can play vs the house instantly.
    const houseFund = ethers.parseEther(process.env.HOUSE_FUND || "5");
    await (await game.fundHouse({ value: houseFund })).wait();
    console.log(`   house bankroll funded with ${ethers.formatEther(houseFund)} ETH.`);

    await writeConfig({ game, network, vrfCoordinator, treasury });
  } else {
    // Public testnet (Sepolia).
    vrfCoordinator = process.env.VRF_COORDINATOR || SEPOLIA.vrfCoordinator;
    keyHash = process.env.KEY_HASH || SEPOLIA.keyHash;
    subscriptionId = process.env.SUBSCRIPTION_ID;
    if (!subscriptionId) {
      throw new Error(
        "SUBSCRIPTION_ID is required for testnet. Create one at https://vrf.chain.link, " +
          "fund it with test LINK, then put the id in your .env."
      );
    }

    const game = await deployGame(vrfCoordinator, keyHash, BigInt(subscriptionId), treasury);

    // Try to auto-register the consumer (works if the deployer owns the sub).
    try {
      const coord = await ethers.getContractAt(
        "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol:IVRFCoordinatorV2Plus",
        vrfCoordinator
      );
      await (await coord.addConsumer(BigInt(subscriptionId), await game.getAddress())).wait();
      console.log("   consumer registered with your VRF subscription.");
    } catch (e) {
      console.log(
        "   ⚠ Could not auto-register the consumer. Add it manually at https://vrf.chain.link:\n" +
          `     consumer = ${await game.getAddress()}`
      );
    }

    await writeConfig({ game, network, vrfCoordinator, treasury });
  }

  console.log("\n✅ Done. Frontend config written to public/deployment.json\n");
}

async function deployGame(vrfCoordinator, keyHash, subscriptionId, treasury) {
  const { ethers } = hre;
  console.log("→ Deploying CoinFlipBetting...");
  const Game = await ethers.getContractFactory("CoinFlipBetting");
  const game = await Game.deploy(vrfCoordinator, keyHash, subscriptionId, treasury);
  await game.waitForDeployment();
  console.log(`   CoinFlipBetting: ${await game.getAddress()}`);
  console.log(`   treasury (fee):  ${treasury}`);
  return game;
}

async function writeConfig({ game, network, vrfCoordinator, treasury }) {
  const address = await game.getAddress();
  const artifact = await hre.artifacts.readArtifact("CoinFlipBetting");
  const data = {
    address,
    chainId: network.config.chainId,
    network: network.name,
    treasury,
    vrfCoordinator,
    abi: artifact.abi,
  };

  const publicDir = path.join(__dirname, "..", "public");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "deployment.json"), JSON.stringify(data, null, 2));
  fs.writeFileSync(
    path.join(publicDir, "config.js"),
    "// AUTO-GENERATED by scripts/deploy.js — do not edit by hand.\n" +
      "window.COINFLIP_CONFIG = " +
      JSON.stringify(data, null, 2) +
      ";\n"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
