const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GameRegistry", function () {
  it("points to the active game and only the owner can flip it", async function () {
    const [deployer, owner, gameA, gameB, mallory] = await ethers.getSigners();
    const Reg = await ethers.getContractFactory("GameRegistry");
    const reg = await Reg.deploy(owner.address, gameA.address);
    await reg.waitForDeployment();

    expect(await reg.owner()).to.equal(owner.address);
    expect(await reg.activeGame()).to.equal(gameA.address);

    // a stranger cannot flip it
    await expect(reg.connect(mallory).setActiveGame(gameB.address)).to.be.revertedWithCustomError(reg, "NotOwner");

    // the owner flips it in one tx -> whole site resolves the new address
    await expect(reg.connect(owner).setActiveGame(gameB.address))
      .to.emit(reg, "ActiveGameSet").withArgs(gameB.address, owner.address);
    expect(await reg.activeGame()).to.equal(gameB.address);

    // owner can hand off ownership
    await reg.connect(owner).transferOwner(deployer.address);
    expect(await reg.owner()).to.equal(deployer.address);
    await expect(reg.connect(owner).setActiveGame(gameA.address)).to.be.revertedWithCustomError(reg, "NotOwner");
  });
});
