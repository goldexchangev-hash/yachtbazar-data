const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

function hostFlip(rcpt, game) {
  const ev = rcpt.logs
    .map((l) => { try { return game.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "HostFlip");
  return ev.args;
}

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
    await game.connect(alice).createRoom(bet, "PvP", true);
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

  it("honors the creator's chosen side (player1 wins iff the coin matches their pick)", async function () {
    const { game, alice, bob } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(alice).deposit({ value: bet });
    await game.connect(bob).deposit({ value: bet });
    await game.connect(alice).createRoom(bet, "Tails", false); // alice picks TAILS
    const res = await result(await game.connect(bob).joinRoom(1), game);
    // res.headsWon = did the coin land heads. Alice chose tails → she wins only
    // when the coin is NOT heads; bob (player2) holds the opposite side.
    expect(res.winner === alice.address).to.equal(!res.headsWon);
    expect(res.winner === bob.address).to.equal(res.headsWon);
  });

  it("vs house: fee to treasury, bankroll moves correctly either way", async function () {
    const { game, deployer, treasury, alice } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    await game.connect(alice).deposit({ value: bet });

    const res = await result(await game.connect(alice).playHouse(bet, true), game);
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
    await expect(game.connect(alice).createRoom(1000n, "dust", true)).to.be.revertedWithCustomError(game, "BetTooSmall");
    // default maxBet is 1 ETH, so 2 ETH is over the cap
    await expect(game.connect(alice).createRoom(ethers.parseEther("2"), "big", true)).to.be.revertedWithCustomError(game, "BetTooHigh");
    await game.connect(deployer).setMaxBet(ethers.parseEther("0.5"));
    await expect(game.connect(alice).createRoom(ethers.parseEther("0.5"), "ok", true)).to.not.be.reverted;
  });

  it("refunds on cancel; blocks self-join and over-betting", async function () {
    const { game, alice, bob } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(alice).deposit({ value: bet });
    await game.connect(alice).createRoom(bet, "Cancel", true);
    expect(await game.balances(alice.address)).to.equal(0n);
    await game.connect(alice).cancelRoom(1);
    expect(await game.balances(alice.address)).to.equal(bet);

    await game.connect(alice).createRoom(bet, "Solo", true); // room 2, escrows bet again? need balance
    // alice has `bet` again from refund; createRoom escrows it
    await expect(game.connect(alice).joinRoom(2)).to.be.revertedWithCustomError(game, "CannotJoinOwnRoom");
    await expect(game.connect(bob).joinRoom(2)).to.be.revertedWithCustomError(game, "InsufficientBalance");
  });

  it("creator renegotiates the room bet up and down", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.03") });
    await game.connect(alice).createRoom(ethers.parseEther("0.01"), "Nego", true);
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
    await game.connect(treasury).createRoom(bet, "Host's room", true); // room 1
    await game.connect(alice).playHouse(bet, true); // room 2
    await game.connect(bob).playHouse(bet, true); // room 3
    await game.connect(carol).playHouse(bet, true); // room 4
    await game.connect(dave).joinRoom(1); // settles room 1

    for (const id of [1, 2, 3, 4]) expect((await game.getRoom(id)).status).to.equal(2);
    expect(await game.totalGamesPlayed()).to.equal(4n);
    expect(await game.totalWagered()).to.equal(bet * 8n);
  });

  // ----------------------------- Host tables ----------------------------- //

  it("host table: create escrows the bank and lists as open", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.2") });
    await game.connect(alice).createHostRoom(ethers.parseEther("0.15"), "Alice's Table"); // id 1
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.05"));
    const open = await game.getOpenHostRooms();
    expect(open.length).to.equal(1);
    expect(open[0].creator).to.equal(alice.address);
    expect(open[0].bank).to.equal(ethers.parseEther("0.15"));
    expect(open[0].open).to.equal(true);
  });

  it("host table: player flips vs the bank; 10% rake splits 50/50 platform/host; ETH conserved", async function () {
    const { game, treasury, alice, bob } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(alice).deposit({ value: ethers.parseEther("0.1") });
    await game.connect(bob).deposit({ value: bet });
    await game.connect(alice).createHostRoom(ethers.parseEther("0.1"), "T"); // id 1, alice balance -> 0

    const args = hostFlip(await (await game.connect(bob).playHostRoom(1, bet, true)).wait(), game);
    const pot = bet * 2n, fee = pot / 10n, payout = pot - fee;
    expect(args.fee).to.equal(fee);
    expect(args.player).to.equal(bob.address);

    // the 10% rake is split 50/50: half to the platform (treasury), half to the host
    const platformCut = fee / 2n, hostCut = fee - platformCut;
    expect(await game.balances(treasury.address)).to.equal(platformCut);
    expect(await game.balances(alice.address)).to.equal(hostCut);
    const hr = await game.getHostRoom(1);
    if (args.playerWon) {
      expect(args.payout).to.equal(payout);
      expect(await game.balances(bob.address)).to.equal(payout);
      expect(hr.bank).to.equal(ethers.parseEther("0.1") - bet); // lost its matched stake
    } else {
      expect(await game.balances(bob.address)).to.equal(0n);
      expect(hr.bank).to.equal(ethers.parseEther("0.1") - bet + payout); // won it back
    }
    expect(hr.gamesPlayed).to.equal(1n);
    expect(await game.totalWagered()).to.equal(pot);
  });

  it("host table: can't play your own table; bet can't exceed the bank", async function () {
    const { game, alice, bob } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.05") });
    await game.connect(alice).createHostRoom(ethers.parseEther("0.02"), "T"); // bank 0.02
    await expect(game.connect(alice).playHostRoom(1, ethers.parseEther("0.01"), true)).to.be.revertedWithCustomError(game, "CannotPlayOwnTable");
    await game.connect(bob).deposit({ value: ethers.parseEther("0.05") });
    await expect(game.connect(bob).playHostRoom(1, ethers.parseEther("0.03"), true)).to.be.revertedWithCustomError(game, "BankTooLow");
  });

  it("host table: creator closes anytime and is refunded; double close reverts", async function () {
    const { game, alice, bob } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.1") });
    await game.connect(alice).createHostRoom(ethers.parseEther("0.1"), "T"); // id 1
    await expect(game.connect(bob).closeHostRoom(1)).to.be.revertedWithCustomError(game, "HostRoomStillActive");
    await game.connect(alice).closeHostRoom(1);
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.1")); // bank refunded
    expect((await game.getHostRoom(1)).open).to.equal(false);
    await expect(game.connect(alice).closeHostRoom(1)).to.be.revertedWithCustomError(game, "HostRoomNotOpen");
  });

  it("host table: anyone can close + refund the creator after the idle timeout", async function () {
    const { game, alice, bob } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.1") });
    await game.connect(alice).createHostRoom(ethers.parseEther("0.1"), "T"); // id 1
    await time.increase(301); // > HOST_TIMEOUT (5 min)
    await game.connect(bob).closeHostRoom(1); // a stranger can now reclaim it for the creator
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.1"));
    expect((await game.getHostRoom(1)).open).to.equal(false);
  });
});
