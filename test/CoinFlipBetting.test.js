const { expect } = require("chai");
const { ethers } = require("hardhat");

async function deployFixture() {
  const [deployer, treasury, alice, bob, carol, dave] = await ethers.getSigners();
  const Game = await ethers.getContractFactory("CoinFlipBetting");
  const game = await Game.deploy(treasury.address);
  await game.waitForDeployment();
  return { game, deployer, treasury, alice, bob, carol, dave };
}

// Pull the FlipSettled result out of a tx receipt.
async function result(tx, game) {
  const rcpt = await tx.wait();
  const ev = rcpt.logs
    .map((l) => { try { return game.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "FlipSettled");
  return { roomId: ev.args.roomId, winner: ev.args.winner, headsWon: ev.args.headsWon, payout: ev.args.payout, fee: ev.args.fee };
}

describe("CoinFlipBetting (prevrandao, no oracle)", function () {
  it("deposits and withdraws pure ETH", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.05") });
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.05"));
    const before = await ethers.provider.getBalance(alice.address);
    const r = await (await game.connect(alice).withdrawAll()).wait();
    const after = await ethers.provider.getBalance(alice.address);
    expect(after).to.equal(before + ethers.parseEther("0.05") - r.gasUsed * r.gasPrice);
  });

  it("PvP flip settles instantly with a 10% fee and conserves ETH", async function () {
    const { game, treasury, alice, bob } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(alice).deposit({ value: bet });
    await game.connect(bob).deposit({ value: bet });
    await game.connect(alice).createRoom(bet, "PvP");
    const res = await result(await game.connect(bob).joinRoom(1), game);

    const pot = bet * 2n;
    const fee = (pot * 1000n) / 10000n;
    const payout = pot - fee;
    expect(res.fee).to.equal(fee);
    expect(res.payout).to.equal(payout);
    expect([alice.address, bob.address]).to.include(res.winner);

    const loser = res.winner === alice.address ? bob.address : alice.address;
    expect(await game.balances(res.winner)).to.equal(payout);
    expect(await game.balances(loser)).to.equal(0n);
    expect(await game.balances(treasury.address)).to.equal(fee);
    // conservation: winnings + fee == both stakes
    expect(payout + fee).to.equal(pot);
    expect((await game.getRoom(1)).status).to.equal(2); // Settled
  });

  it("vs house: fee to treasury, bankroll moves correctly either way", async function () {
    const { game, deployer, treasury, alice } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    await game.connect(alice).deposit({ value: bet });

    const res = await result(await game.connect(alice).playHouse(bet), game);
    const pot = bet * 2n;
    const fee = (pot * 1000n) / 10000n;
    const payout = pot - fee;
    expect(await game.balances(treasury.address)).to.equal(fee);

    if (res.headsWon) {
      // player (alice) won
      expect(res.winner).to.equal(alice.address);
      expect(await game.balances(alice.address)).to.equal(payout);
      expect(await game.houseBankroll()).to.equal(ethers.parseEther("1") - bet);
    } else {
      // house won
      expect(res.winner).to.equal(treasury.address);
      expect(await game.balances(alice.address)).to.equal(0n);
      expect(await game.houseBankroll()).to.equal(ethers.parseEther("1") - bet + payout);
    }
  });

  it("enforces min and max bet; owner can change max", async function () {
    const { game, deployer, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("1") });
    await expect(game.connect(alice).createRoom(1000n, "dust")).to.be.revertedWithCustomError(game, "BetTooSmall");
    await expect(game.connect(alice).createRoom(ethers.parseEther("0.05"), "big")).to.be.revertedWithCustomError(game, "BetTooHigh");
    await game.connect(deployer).setMaxBet(ethers.parseEther("0.1"));
    await expect(game.connect(alice).createRoom(ethers.parseEther("0.05"), "ok")).to.not.be.reverted;
  });

  it("refunds on cancel; blocks self-join and over-betting", async function () {
    const { game, alice, bob } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(alice).deposit({ value: bet });
    await game.connect(alice).createRoom(bet, "Cancel");
    expect(await game.balances(alice.address)).to.equal(0n);
    await game.connect(alice).cancelRoom(1);
    expect(await game.balances(alice.address)).to.equal(bet);

    await game.connect(alice).createRoom(bet, "Solo"); // room 2, escrows bet again? need balance
    // alice has `bet` again from refund; createRoom escrows it
    await expect(game.connect(alice).joinRoom(2)).to.be.revertedWithCustomError(game, "CannotJoinOwnRoom");
    await expect(game.connect(bob).joinRoom(2)).to.be.revertedWithCustomError(game, "InsufficientBalance");
  });

  it("creator renegotiates the room bet up and down", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.03") });
    await game.connect(alice).createRoom(ethers.parseEther("0.01"), "Nego");
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.02"));
    await game.connect(alice).updateRoomBet(1, ethers.parseEther("0.025"));
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.005"));
    await game.connect(alice).updateRoomBet(1, ethers.parseEther("0.005"));
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.025"));
  });

  it("only the owner funds/withdraws the house bankroll", async function () {
    const { game, deployer, alice } = await deployFixture();
    await expect(game.connect(alice).fundHouse({ value: 1n })).to.be.revertedWithCustomError(game, "NotOwner");
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    await game.connect(deployer).withdrawHouse(ethers.parseEther("0.4"));
    expect(await game.houseBankroll()).to.equal(ethers.parseEther("0.6"));
  });

  it("runs many games in parallel (host room + several vs-house)", async function () {
    const { game, deployer, treasury, alice, bob, carol, dave } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    for (const p of [alice, bob, carol, dave, treasury]) {
      await game.connect(p).deposit({ value: ethers.parseEther("0.05") });
    }
    await game.connect(treasury).createRoom(bet, "Host's room"); // room 1
    await game.connect(alice).playHouse(bet); // room 2
    await game.connect(bob).playHouse(bet); // room 3
    await game.connect(carol).playHouse(bet); // room 4
    await game.connect(dave).joinRoom(1); // settles room 1

    for (const id of [1, 2, 3, 4]) expect((await game.getRoom(id)).status).to.equal(2);
    expect(await game.totalGamesPlayed()).to.equal(4n);
    expect(await game.totalWagered()).to.equal(bet * 8n);
  });
});
