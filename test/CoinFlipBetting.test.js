const { expect } = require("chai");
const { ethers } = require("hardhat");

function settlementHash(player, net, nonce, chainId, contract) {
  return ethers.solidityPackedKeccak256(
    ["address", "int256", "uint256", "uint256", "address"],
    [player, net, nonce, chainId, contract]
  );
}
async function signSettlement(signer, player, net, nonce, chainId, contract) {
  const h = settlementHash(player, net, nonce, chainId, contract);
  return signer.signMessage(ethers.getBytes(h));
}

async function deployFixture() {
  const [deployer, treasury, alice, bob, carol, dave] = await ethers.getSigners();
  const Game = await ethers.getContractFactory("CoinFlipBetting");
  const game = await Game.deploy(treasury.address);
  await game.waitForDeployment();
  return { game, deployer, treasury, alice, bob, carol, dave, addr: await game.getAddress() };
}

// F5 retirement: the on-chain block-randomness games (coin flip, PvP rooms, host tables, dice, two-dice,
// crash, slots) were DELETED. What remains — and what this suite covers — is the money path the off-chain
// server commit-reveal bridge needs: pure-ETH escrow, the owner house bankroll, and house-signed blackjack.
describe("CoinFlipBetting (escrow + house-signed blackjack, games retired)", function () {
  it("deposits and withdraws pure ETH", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.05") });
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.05"));
    const before = await ethers.provider.getBalance(alice.address);
    const r = await (await game.connect(alice).withdrawAll()).wait();
    const after = await ethers.provider.getBalance(alice.address);
    expect(after).to.equal(before + ethers.parseEther("0.05") - r.gasUsed * r.gasPrice);
  });

  it("partial withdraw leaves the remainder; over-withdraw reverts", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.05") });
    await game.connect(alice).withdraw(ethers.parseEther("0.02"));
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.03"));
    await expect(game.connect(alice).withdraw(ethers.parseEther("0.1"))).to.be.revertedWithCustomError(game, "InsufficientBalance");
  });

  it("receive() credits a plain ETH transfer to the sender's balance", async function () {
    const { game, alice, addr } = await deployFixture();
    await alice.sendTransaction({ to: addr, value: ethers.parseEther("0.01") });
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.01"));
  });

  it("owner-only max bet; enforces the MIN_BET floor on the setter", async function () {
    const { game, deployer, alice } = await deployFixture();
    await expect(game.connect(alice).setMaxBet(ethers.parseEther("2"))).to.be.revertedWithCustomError(game, "NotOwner");
    await expect(game.connect(deployer).setMaxBet(1n)).to.be.revertedWithCustomError(game, "BetTooSmall");
    await game.connect(deployer).setMaxBet(ethers.parseEther("0.5"));
    expect(await game.maxBet()).to.equal(ethers.parseEther("0.5"));
  });

  it("only the owner funds/withdraws the house bankroll", async function () {
    const { game, deployer, alice } = await deployFixture();
    await expect(game.connect(alice).fundHouse({ value: 1n })).to.be.revertedWithCustomError(game, "NotOwner");
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    await game.connect(deployer).withdrawHouse(ethers.parseEther("0.4"));
    expect(await game.houseBankroll()).to.equal(ethers.parseEther("0.6"));
    await expect(game.connect(deployer).withdrawHouse(ethers.parseEther("1"))).to.be.revertedWithCustomError(game, "HouseBankrollLow");
  });

  it("blackjack buy-in locks from the balance; can't lock more than you have", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.2") });
    await game.connect(alice).blackjackBuyIn(ethers.parseEther("0.1"));
    expect(await game.bjLocked(alice.address)).to.equal(ethers.parseEther("0.1"));
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.1"));
    await expect(game.connect(alice).blackjackBuyIn(ethers.parseEther("0.2"))).to.be.revertedWithCustomError(game, "InsufficientBalance");
  });

  it("house-signed settle: a WIN pays locked + net from the bankroll", async function () {
    const { game, deployer, alice, addr } = await deployFixture();
    const signer = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: signer.address, value: ethers.parseEther("1") });
    await game.connect(deployer).setBlackjackSigner(signer.address);
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    await game.connect(alice).deposit({ value: ethers.parseEther("0.3") });
    await game.connect(alice).blackjackBuyIn(ethers.parseEther("0.1"));

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const win = ethers.parseEther("0.05");
    const sig = await signSettlement(signer, alice.address, win, 1n, chainId, addr);
    await game.settleBlackjack(alice.address, win, 1, sig);

    expect(await game.bjLocked(alice.address)).to.equal(0n);
    // 0.2 unlocked balance + (0.1 locked + 0.05 win) returned = 0.35
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.35"));
    expect(await game.houseBankroll()).to.equal(ethers.parseEther("0.95"));
  });

  it("settle rejects an unauthorized signer and a replayed nonce", async function () {
    const { game, deployer, alice, addr } = await deployFixture();
    const signer = ethers.Wallet.createRandom().connect(ethers.provider);
    const impostor = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: signer.address, value: ethers.parseEther("1") });
    await game.connect(deployer).setBlackjackSigner(signer.address);
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    await game.connect(alice).deposit({ value: ethers.parseEther("0.3") });
    await game.connect(alice).blackjackBuyIn(ethers.parseEther("0.1"));

    const chainId = (await ethers.provider.getNetwork()).chainId;
    // wrong signer → rejected
    const bad = await signSettlement(impostor, alice.address, 0n, 5n, chainId, addr);
    await expect(game.settleBlackjack(alice.address, 0, 5, bad)).to.be.reverted;
    // valid settle consumes the nonce; replay is rejected
    const good = await signSettlement(signer, alice.address, 0n, 5n, chainId, addr);
    await game.settleBlackjack(alice.address, 0, 5, good);
    await expect(game.settleBlackjack(alice.address, 0, 5, good)).to.be.reverted;
  });
});
