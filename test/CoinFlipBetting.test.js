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
    // the 10% rake now flows into the house bankroll, not the treasury balance
    expect(await game.balances(treasury.address)).to.equal(0n);
    expect(await game.houseBankroll()).to.equal(fee);
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

  it("vs house: rake into bankroll, bankroll moves correctly either way", async function () {
    const { game, deployer, treasury, alice } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    await game.connect(alice).deposit({ value: bet });

    const res = await result(await game.connect(alice).playHouse(bet, true), game);
    const pot = bet * 2n;
    const fee = (pot * 1000n) / 10000n;
    const payout = pot - fee;
    // rake goes to the bankroll now, so the treasury balance stays empty
    expect(await game.balances(treasury.address)).to.equal(0n);

    if (res.headsWon) {
      // player (alice) won — bankroll = funded − matched stake + rake
      expect(res.winner).to.equal(alice.address);
      expect(await game.balances(alice.address)).to.equal(payout);
      expect(await game.houseBankroll()).to.equal(ethers.parseEther("1") - bet + fee);
    } else {
      // house won — bankroll also reclaims the payout
      expect(res.winner).to.equal(treasury.address);
      expect(await game.balances(alice.address)).to.equal(0n);
      expect(await game.houseBankroll()).to.equal(ethers.parseEther("1") - bet + fee + payout);
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

    // the 10% rake is split 50/50: the platform half flows into the house bankroll,
    // the host half stays in the host creator's balance
    const platformCut = fee / 2n, hostCut = fee - platformCut;
    expect(await game.balances(treasury.address)).to.equal(0n);
    expect(await game.houseBankroll()).to.equal(platformCut);
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

  it("open-set: getOpenRooms tracks only currently-open rooms (cancel + settle prune it)", async function () {
    const { game, alice, bob } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(alice).deposit({ value: ethers.parseEther("0.1") });
    await game.connect(bob).deposit({ value: ethers.parseEther("0.1") });

    await game.connect(alice).createRoom(bet, "A", true); // room 1
    await game.connect(alice).createRoom(bet, "B", true); // room 2
    expect((await game.getOpenRooms()).length).to.equal(2);
    expect(await game.openRoomsOf(alice.address)).to.equal(2n);

    await game.connect(alice).cancelRoom(1); // cancel prunes
    expect((await game.getOpenRooms()).length).to.equal(1);
    expect(await game.openRoomsOf(alice.address)).to.equal(1n);

    await game.connect(bob).joinRoom(2); // settle prunes
    expect((await game.getOpenRooms()).length).to.equal(0);
    expect(await game.openRoomsOf(alice.address)).to.equal(0n);

    // vs-house games settle atomically and never pollute the open set
    await game.connect(alice).deposit({ value: bet });
    // (no house bankroll funded here — just assert the open set stays empty after a cancel cycle)
    expect((await game.getOpenRooms()).length).to.equal(0);
  });

  it("anti-spam: caps simultaneously-open rooms per address", async function () {
    const { game, alice } = await deployFixture();
    const bet = ethers.parseEther("0.001");
    await game.connect(alice).deposit({ value: ethers.parseEther("1") });
    const MAX = Number(await game.MAX_OPEN_PER_ADDRESS());
    for (let i = 0; i < MAX; i++) await game.connect(alice).createRoom(bet, "r", true);
    await expect(game.connect(alice).createRoom(bet, "over", true)).to.be.revertedWithCustomError(game, "TooManyOpen");
    // cancelling one frees a slot again
    await game.connect(alice).cancelRoom(1);
    await expect(game.connect(alice).createRoom(bet, "ok", true)).to.not.be.reverted;
  });

  it("open-set: host tables prune from getOpenHostRooms on close", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.5") });
    await game.connect(alice).createHostRoom(ethers.parseEther("0.1"), "T1");
    await game.connect(alice).createHostRoom(ethers.parseEther("0.1"), "T2");
    expect((await game.getOpenHostRooms()).length).to.equal(2);
    expect(await game.openTablesOf(alice.address)).to.equal(2n);
    await game.connect(alice).closeHostRoom(1);
    expect((await game.getOpenHostRooms()).length).to.equal(1);
    expect(await game.openTablesOf(alice.address)).to.equal(1n);
  });

  function diceEvent(rcpt, game) {
    const ev = rcpt.logs.map((l) => { try { return game.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "DiceRolled");
    return ev.args;
  }

  it("dice: multiplier math + payout/bankroll accounting (win and loss)", async function () {
    const { game, deployer, treasury, alice } = await deployFixture();
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("10") });
    await game.connect(alice).deposit({ value: ethers.parseEther("1") });
    const bet = ethers.parseEther("0.05");
    const bankStart = await game.houseBankroll();
    const balStart = await game.balances(alice.address);

    // UNDER 5000 → 5000 win-outcomes (50%), edge 2% → 1.96x = 19600 bps
    const a = diceEvent(await (await game.connect(alice).playDice(bet, 5000, false)).wait(), game);
    expect(a.multiplierBps).to.equal(19600n); // (10000-200)*10000/5000
    const payout = (bet * a.multiplierBps) / 10000n;
    const maxProfit = payout - bet;
    if (a.won) {
      expect(a.roll).to.be.lessThan(5000);
      expect(await game.balances(alice.address)).to.equal(balStart - bet + payout);
      expect(await game.houseBankroll()).to.equal(bankStart - maxProfit);
    } else {
      expect(a.roll).to.be.greaterThanOrEqual(5000);
      expect(await game.balances(alice.address)).to.equal(balStart - bet);
      expect(await game.houseBankroll()).to.equal(bankStart + bet);
    }
    // conservation: contract ETH == sum balances + bankroll
    const code = await ethers.provider.getBalance(await game.getAddress());
    expect(code).to.equal((await game.balances(alice.address)) + (await game.houseBankroll()) + (await game.balances(treasury.address)));
  });

  it("dice: multiplier equals (10000-edge)*10000/winOutcomes", async function () {
    const { game, deployer, alice } = await deployFixture();
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("50") });
    await game.connect(alice).deposit({ value: ethers.parseEther("1") });
    const bet = ethers.parseEther("0.01");
    // UNDER 2500 (25%) → (9800*10000)/2500 = 39200 bps = 3.92x
    const a = diceEvent(await (await game.connect(alice).playDice(bet, 2500, false)).wait(), game);
    expect(a.multiplierBps).to.equal(39200n);
    // OVER 8000 → winOutcomes 1999 → (9800*10000)/1999 = 49024 bps
    const b = diceEvent(await (await game.connect(alice).playDice(bet, 8000, true)).wait(), game);
    expect(b.winOutcomes ?? b.multiplierBps).to.equal(49024n); // multiplierBps
  });

  it("dice: enforces target bounds and bankroll cap", async function () {
    const { game, deployer, alice } = await deployFixture();
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    await game.connect(alice).deposit({ value: ethers.parseEther("1") });
    const bet = ethers.parseEther("0.01");
    // winOutcomes 50 (<100 min) → reject
    await expect(game.connect(alice).playDice(bet, 50, false)).to.be.revertedWithCustomError(game, "DiceBadTarget");
    // winOutcomes 9950 (>9900 max) → reject
    await expect(game.connect(alice).playDice(bet, 9950, false)).to.be.revertedWithCustomError(game, "DiceBadTarget");
    // a 98x bet whose max-profit exceeds 1% of a small bankroll → reject
    await expect(game.connect(alice).playDice(ethers.parseEther("0.5"), 100, false)).to.be.revertedWithCustomError(game, "HouseBankrollLow");
  });

  it("dice: owner sets edge (capped); getRecentDice returns history", async function () {
    const { game, deployer, alice, bob } = await deployFixture();
    await game.connect(deployer).fundHouse({ value: ethers.parseEther("20") });
    await game.connect(alice).deposit({ value: ethers.parseEther("1") });
    await expect(game.connect(bob).setDiceEdge(300)).to.be.revertedWithCustomError(game, "NotOwner");
    await expect(game.connect(deployer).setDiceEdge(2000)).to.be.revertedWithCustomError(game, "DiceEdgeTooHigh");
    await game.connect(deployer).setDiceEdge(100); // 1%
    const a = diceEvent(await (await game.connect(alice).playDice(ethers.parseEther("0.01"), 5000, false)).wait(), game);
    expect(a.multiplierBps).to.equal(19800n); // (10000-100)*10000/5000
    expect(await game.diceCount()).to.equal(1n);
    expect((await game.getRecentDice(10)).length).to.equal(1);
  });
});
