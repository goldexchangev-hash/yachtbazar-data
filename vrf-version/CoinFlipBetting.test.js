const { expect } = require("chai");
const { ethers } = require("hardhat");

// Mock VRF constructor params.
const BASE_FEE = 100000000000000000n;
const GAS_PRICE = 1000000000n;
const WEI_PER_UNIT_LINK = 4000000000000000n;
const KEY_HASH = "0x" + "ab".repeat(32);

async function deployFixture() {
  const [deployer, treasury, alice, bob] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
  const mock = await Mock.deploy(BASE_FEE, GAS_PRICE, WEI_PER_UNIT_LINK);
  await mock.waitForDeployment();

  const subTx = await mock.createSubscription();
  const rcpt = await subTx.wait();
  const subId = rcpt.logs
    .map((l) => {
      try {
        return mock.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "SubscriptionCreated").args.subId;

  await mock.fundSubscription(subId, ethers.parseEther("1000"));

  const Game = await ethers.getContractFactory("CoinFlipBetting");
  const game = await Game.deploy(await mock.getAddress(), KEY_HASH, subId, treasury.address);
  await game.waitForDeployment();

  await mock.addConsumer(subId, await game.getAddress());

  return { game, mock, deployer, treasury, alice, bob };
}

// Force a flip outcome: even => heads (player1 wins), odd => tails (player2 wins).
async function settle(mock, game, requestId, even) {
  const word = even ? 2n : 3n;
  await mock.fulfillRandomWordsWithOverride(requestId, await game.getAddress(), [word]);
}

async function reqId(tx, game) {
  const rcpt = await tx.wait();
  return rcpt.logs
    .map((l) => { try { return game.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "FlipRequested").args.requestId;
}

describe("CoinFlipBetting", function () {
  it("ETH-only: deposit, bet, settle, withdraw with a 10% house fee", async function () {
    const { game, mock, treasury, alice, bob } = await deployFixture();
    const bet = ethers.parseEther("0.01");

    await game.connect(alice).deposit({ value: bet });
    await game.connect(bob).deposit({ value: bet });

    // Alice creates, Bob joins -> a flip is requested.
    await game.connect(alice).createRoom(bet, "Test Room");
    const joinTx = await game.connect(bob).joinRoom(1);
    const joinRcpt = await joinTx.wait();
    const reqEvent = joinRcpt.logs
      .map((l) => {
        try {
          return game.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "FlipRequested");
    const requestId = reqEvent.args.requestId;

    // Force "heads" => player1 (Alice) wins.
    await settle(mock, game, requestId, true);

    const room = await game.getRoom(1);
    expect(room.status).to.equal(2); // Settled
    expect(room.winner).to.equal(alice.address);
    expect(room.headsWon).to.equal(true);

    const pot = bet * 2n;
    const fee = (pot * 1000n) / 10000n; // 10%
    const payout = pot - fee;

    expect(await game.balances(alice.address)).to.equal(payout);
    expect(await game.balances(bob.address)).to.equal(0n);
    expect(await game.balances(treasury.address)).to.equal(fee);
    expect(await game.totalFeesCollected()).to.equal(fee);
    expect(await game.totalGamesPlayed()).to.equal(1n);

    // Alice can withdraw her winnings as real ETH.
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await game.connect(alice).withdrawAll();
    const r = await tx.wait();
    const gas = r.gasUsed * r.gasPrice;
    const after = await ethers.provider.getBalance(alice.address);
    expect(after).to.equal(before + payout - gas);
  });

  it("pays player2 when the coin lands tails", async function () {
    const { game, mock, bob, alice } = await deployFixture();
    const bet = ethers.parseEther("0.02");
    await game.connect(alice).deposit({ value: bet });
    await game.connect(bob).deposit({ value: bet });
    await game.connect(alice).createRoom(bet, "Tails Test");
    const rcpt = await (await game.connect(bob).joinRoom(1)).wait();
    const requestId = rcpt.logs
      .map((l) => {
        try {
          return game.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "FlipRequested").args.requestId;

    await settle(mock, game, requestId, false); // odd => tails => player2 (Bob)
    const room = await game.getRoom(1);
    expect(room.winner).to.equal(bob.address);
  });

  it("enforces the max bet and lets the owner change it", async function () {
    const { game, deployer, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("1") });

    await expect(
      game.connect(alice).createRoom(ethers.parseEther("0.05"), "Too big")
    ).to.be.revertedWithCustomError(game, "BetTooHigh");

    await game.connect(deployer).setMaxBet(ethers.parseEther("0.1"));
    await expect(game.connect(alice).createRoom(ethers.parseEther("0.05"), "OK now")).to.not.be.reverted;
  });

  it("refunds the creator when a room is cancelled", async function () {
    const { game, alice } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(alice).deposit({ value: bet });
    await game.connect(alice).createRoom(bet, "Cancel me");
    expect(await game.balances(alice.address)).to.equal(0n);
    await game.connect(alice).cancelRoom(1);
    expect(await game.balances(alice.address)).to.equal(bet);
  });

  it("blocks joining your own room and over-betting your balance", async function () {
    const { game, alice, bob } = await deployFixture();
    const bet = ethers.parseEther("0.01");
    await game.connect(alice).deposit({ value: bet });
    await game.connect(alice).createRoom(bet, "Solo");
    await expect(game.connect(alice).joinRoom(1)).to.be.revertedWithCustomError(
      game,
      "CannotJoinOwnRoom"
    );
    await expect(game.connect(bob).joinRoom(1)).to.be.revertedWithCustomError(
      game,
      "InsufficientBalance"
    );
  });

  it("rejects dust bets below the minimum", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.01") });
    await expect(game.connect(alice).createRoom(1000n, "dust")).to.be.revertedWithCustomError(game, "BetTooSmall");
  });

  it("creator can renegotiate the room bet up and down (escrow adjusts)", async function () {
    const { game, alice } = await deployFixture();
    await game.connect(alice).deposit({ value: ethers.parseEther("0.03") });
    await game.connect(alice).createRoom(ethers.parseEther("0.01"), "Nego");
    // balance after escrowing 0.01 => 0.02 left
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.02"));
    // raise to 0.025 -> pulls extra 0.015 -> 0.005 left
    await game.connect(alice).updateRoomBet(1, ethers.parseEther("0.025"));
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.005"));
    expect((await game.getRoom(1)).betAmount).to.equal(ethers.parseEther("0.025"));
    // lower to 0.005 -> refunds 0.02 -> 0.025 left
    await game.connect(alice).updateRoomBet(1, ethers.parseEther("0.005"));
    expect(await game.balances(alice.address)).to.equal(ethers.parseEther("0.025"));
    // only the creator, only while open, only <= maxBet
    await expect(game.connect(alice).updateRoomBet(1, ethers.parseEther("1"))).to.be.revertedWithCustomError(game, "BetTooHigh");
  });

  it("runs many games in parallel (host custom room + several vs-house at once)", async function () {
    const { game, mock, deployer, treasury } = await deployFixture();
    const signers = await ethers.getSigners();
    const [, , alice, bob, carol, dave] = signers;
    const bet = ethers.parseEther("0.01");

    await game.connect(deployer).fundHouse({ value: ethers.parseEther("1") });
    for (const p of [alice, bob, carol, dave, treasury]) {
      await game.connect(p).deposit({ value: ethers.parseEther("0.05") });
    }

    // The host (treasury) opens their OWN custom room while also being the house.
    await game.connect(treasury).createRoom(bet, "Host's room"); // room 1 (open)

    // Three players flip the house at the same time — independent rooms.
    const rA = await reqId(await game.connect(alice).playHouse(bet), game); // room 2
    const rB = await reqId(await game.connect(bob).playHouse(bet), game); // room 3
    const rC = await reqId(await game.connect(carol).playHouse(bet), game); // room 4

    // Meanwhile dave joins the host's custom room.
    const rHost = await reqId(await game.connect(dave).joinRoom(1), game); // room 1 flips

    // All four are mid-flip simultaneously; settle them out of order.
    await settle(mock, game, rC, true); // carol beats the house
    await settle(mock, game, rHost, false); // host room: tails => dave (player2) wins
    await settle(mock, game, rA, false); // house beats alice
    await settle(mock, game, rB, true); // bob beats the house

    for (const id of [1, 2, 3, 4]) {
      expect(Number((await game.getRoom(id)).status)).to.equal(2); // all Settled
    }
    expect(await game.totalGamesPlayed()).to.equal(4n);
    // dave won the host's room (pot 0.02 - 10% = 0.018) on top of his 0.04 left
    expect(await game.balances(dave.address)).to.equal(ethers.parseEther("0.058"));
  });

  describe("play vs house", function () {
    async function houseFixture() {
      const fx = await deployFixture();
      // deployer is the owner; fund the house bankroll
      await fx.game.connect(fx.deployer).fundHouse({ value: ethers.parseEther("1") });
      return fx;
    }

    async function requestIdFrom(tx, game) {
      const rcpt = await tx.wait();
      return rcpt.logs
        .map((l) => {
          try {
            return game.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "FlipRequested").args.requestId;
    }

    it("only the owner can fund the house", async function () {
      const { game, alice } = await deployFixture();
      await expect(game.connect(alice).fundHouse({ value: 1n })).to.be.reverted;
    });

    it("user beats the house: paid from bankroll, 10% fee to treasury", async function () {
      const { game, mock, treasury, alice } = await houseFixture();
      const bet = ethers.parseEther("0.01");
      await game.connect(alice).deposit({ value: bet });

      const requestId = await requestIdFrom(await game.connect(alice).playHouse(bet), game);
      await settle(mock, game, requestId, true); // heads => player1 (alice) wins

      const pot = bet * 2n;
      const fee = (pot * 1000n) / 10000n;
      const payout = pot - fee;
      expect(await game.balances(alice.address)).to.equal(payout);
      expect(await game.balances(treasury.address)).to.equal(fee);
      expect(await game.houseBankroll()).to.equal(ethers.parseEther("1") - bet);
    });

    it("house wins: bankroll refilled, fee still to treasury, user gets nothing", async function () {
      const { game, mock, treasury, alice } = await houseFixture();
      const bet = ethers.parseEther("0.01");
      await game.connect(alice).deposit({ value: bet });

      const requestId = await requestIdFrom(await game.connect(alice).playHouse(bet), game);
      await settle(mock, game, requestId, false); // tails => house (player2) wins

      const pot = bet * 2n;
      const fee = (pot * 1000n) / 10000n;
      const payout = pot - fee;
      expect(await game.balances(alice.address)).to.equal(0n);
      expect(await game.balances(treasury.address)).to.equal(fee);
      expect(await game.houseBankroll()).to.equal(ethers.parseEther("1") - bet + payout);
    });

    it("reverts when the house bankroll can't cover the bet", async function () {
      const { game, alice } = await deployFixture(); // no house funding
      const bet = ethers.parseEther("0.01");
      await game.connect(alice).deposit({ value: bet });
      await expect(game.connect(alice).playHouse(bet)).to.be.revertedWithCustomError(
        game,
        "HouseBankrollLow"
      );
    });

    it("owner can withdraw unused house bankroll", async function () {
      const { game, deployer } = await houseFixture();
      await expect(game.connect(deployer).withdrawHouse(ethers.parseEther("0.5"))).to.not.be.reverted;
      expect(await game.houseBankroll()).to.equal(ethers.parseEther("0.5"));
    });
  });
});
