const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GameRegistry #28 — address(0) guard probe", function () {
  it("reverts on transferOwner(address(0))", async function () {
    const [deployer, owner, game] = await ethers.getSigners();
    const Reg = await ethers.getContractFactory("GameRegistry");
    const reg = await Reg.deploy(owner.address, game.address);
    await reg.waitForDeployment();

    // Attempt to transfer to address(0) — should revert
    await expect(
      reg.connect(owner).transferOwner(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(reg, "InvalidAddress");

    // Owner should still be the original
    expect(await reg.owner()).to.equal(owner.address);
  });

  it("allows transfer to a valid non-zero address", async function () {
    const [deployer, owner, game, newOwner] = await ethers.getSigners();
    const Reg = await ethers.getContractFactory("GameRegistry");
    const reg = await Reg.deploy(owner.address, game.address);
    await reg.waitForDeployment();

    await reg.connect(owner).transferOwner(newOwner.address);
    expect(await reg.owner()).to.equal(newOwner.address);
  });
});
