const { expect } = require("chai");
const { ethers } = require("hardhat");

// v3 #27 — an OPEN PvP room that nobody joins must not lock the creator's escrow forever if the creator
// goes offline. forceCloseStaleRoom lets ANYONE refund the creator after PVP_ROOM_TIMEOUT.
describe("v3 #27 — PvP room creator-independent timeout (forceCloseStaleRoom)", function () {
  async function fix() {
    const [deployer, treasury, alice, bob] = await ethers.getSigners();
    const Game = await ethers.getContractFactory("CoinFlipBettingV2");
    const game = await Game.deploy(treasury.address);
    await game.waitForDeployment();
    return { game, deployer, treasury, alice, bob };
  }
  const BET = ethers.parseEther("0.01");

  it("refuses before the timeout, then ANYONE can close + refund the creator after it", async () => {
    const { game, alice, bob } = await fix();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.1") });
    const balAfterDeposit = await game.balances(alice.address);

    await game.connect(alice).createRoom(BET, "test", true);
    const roomId = 1n;
    // escrow locked: the creator's balance dropped by the bet
    expect(await game.balances(alice.address)).to.equal(balAfterDeposit - BET);

    // before PVP_ROOM_TIMEOUT → a force-close (even by a non-creator) reverts
    await expect(game.connect(bob).forceCloseStaleRoom(roomId)).to.be.revertedWithCustomError(game, "RoomNotStale");

    // advance past 24h
    await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
    await ethers.provider.send("evm_mine", []);

    // a NON-creator can now close it → the CREATOR (not the caller) is refunded the full escrow
    const bobBalBefore = await game.balances(bob.address);
    await game.connect(bob).forceCloseStaleRoom(roomId);
    expect(await game.balances(alice.address)).to.equal(balAfterDeposit); // full refund to the creator
    expect(await game.balances(bob.address)).to.equal(bobBalBefore);       // the caller gains nothing

    // the room is no longer open → a second close reverts
    await expect(game.connect(bob).forceCloseStaleRoom(roomId)).to.be.revertedWithCustomError(game, "RoomNotOpen");
  });

  it("reverts on an unknown room", async () => {
    const { game, bob } = await fix();
    await expect(game.connect(bob).forceCloseStaleRoom(999n)).to.be.revertedWithCustomError(game, "UnknownRoom");
  });

  it("the creator can still cancelRoom at any time (force-close doesn't replace it)", async () => {
    const { game, alice } = await fix();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.1") });
    const bal = await game.balances(alice.address);
    await game.connect(alice).createRoom(BET, "test", true);
    await game.connect(alice).cancelRoom(1n);
    expect(await game.balances(alice.address)).to.equal(bal); // refunded immediately, no wait
  });
});
