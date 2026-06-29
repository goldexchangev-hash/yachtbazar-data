/* ============================================================
   token-bridge.js — game-agnostic SERVER-AUTHORITATIVE token ledger.

   This is the core of "connect wallet → your sETH becomes tokens you play every
   game with", extended past blackjack. It is engine-agnostic and pure-logic so it
   unit-tests without a chain. NO Chainlink VRF — pure server commit-reveal.

   FLOW (mirrors the blackjack bridge, generalized):
     start(buyIn)  → lock recorded on-chain (verified upstream) becomes `tokens`;
                     the server commits ONE serverSeed (publishes commit) per session.
     play(bet)     → debit bet, run the game's server engine over the COMMITTED seed
                     at an incrementing per-bet nonce, credit the gross payout. Every
                     outcome is re-derivable from (serverSeed, clientSeed, nonce).
     settle()      → net = tokens − buyIn (floored at −buyIn so a player never loses
                     more than they locked); the house SIGNS (player, netWei, nonce,
                     chainId, contract); serverSeed is REVEALED so anyone re-derives
                     and verifies every bet of the session.

   SECURITY: outcomes never come from the client. The client only contributes a
   PUBLIC clientSeed fixed into each bet's derivation (so it can prove the house
   didn't re-roll). The ledger is the single source of truth for the signed net.

   Wire it to Express + the on-chain buy-in verifier in server/server.js behind a
   flag; the live demo games are untouched.
   ============================================================ */
"use strict";

const PF = require("./provablyfair.js");

// ── game registry: only games with a server-authoritative engine may take tokens ──
const ENGINES = {
  coinflip: require("./games/coinflip.js"),
  dice: require("./games/dice.js"),
  dice2: require("./games/dice2.js"),
  crash: require("./games/crash.js"),
  pressure: require("./games/pressure.js"),
  slots: require("./games/slots.js"),
  slots3d: require("./games/slots3d.js"),
};
function games() { return Object.keys(ENGINES); }
function hasGame(g) { return Object.prototype.hasOwnProperty.call(ENGINES, g); }

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {object} opts
 *   signer: { sign(player,netWei,nonce,chainId,contract)->Promise<string>,
 *             recover(player,netWei,nonce,chainId,contract,sig)->string }  (e.g. realmoney.js wrapped)
 *   toWei:  (units)->BigInt    units→wei at the session's locked rate (default: 1 unit = 1 wei, for tests)
 *   persist:{ load()->state, save(state) }   optional durable store
 */
function makeTokenBridge(opts) {
  opts = opts || {};
  const signer = opts.signer || null;
  const toWei = opts.toWei || ((u) => BigInt(Math.round(Number(u) || 0)));
  const persist = opts.persist || null;
  const sessions = new Map();

  function save() { if (persist && persist.save) { try { persist.save({ sessions: Array.from(sessions.values()) }); } catch (e) {} } }
  if (persist && persist.load) { try { const st = persist.load(); for (const s of (st && st.sessions) || []) if (s && s.id) sessions.set(s.id, s); } catch (e) {} }

  // Begin a session. buyInUnits = tokens granted (the on-chain lock, verified upstream).
  function start(o) {
    const player = String(o.player || "").toLowerCase();
    if (!player) throw new Error("player required");
    const buyInUnits = round2(o.buyInUnits);
    if (!(buyInUnits > 0)) throw new Error("buy-in must be positive");
    const rnd = PF.newRound(); // { serverSeed (secret), commit (public) }
    const id = o.sessionId || PF.randomSeed(16);
    const s = {
      id: id, player: player, chainId: Number(o.chainId) || 0, contract: o.contract || "",
      buyInUnits: buyInUnits, tokens: buyInUnits,
      serverSeed: rnd.serverSeed, commit: rnd.commit, settleNonce: o.settleNonce || PF.randomSeed(16),
      betNonce: 0, bets: [], closed: false, settlement: null, startedAt: o.now || 0,
    };
    sessions.set(id, s);
    save();
    // publish commit + session; serverSeed is withheld until settle
    return { sessionId: id, commit: s.commit, tokens: s.tokens, buyInUnits: s.buyInUnits, games: games() };
  }

  // Place ONE bet on a game. Returns the outcome + new token balance.
  function play(o) {
    const s = sessions.get(o.sessionId);
    if (!s) throw new Error("no such session");
    if (s.closed) throw new Error("session is closed");
    if (!hasGame(o.game)) throw new Error("game not token-enabled: " + o.game);
    const bet = round2(o.betUnits);
    if (!(bet > 0)) throw new Error("bet must be positive");
    if (bet > s.tokens + 1e-9) throw new Error("insufficient tokens");

    const nonce = s.betNonce++;                       // unique + fixed per bet → verifiable
    const clientSeed = String(o.clientSeed == null ? "" : o.clientSeed);
    s.tokens = round2(s.tokens - bet);                // debit the stake first
    const res = ENGINES[o.game].play({ serverSeed: s.serverSeed, clientSeed: clientSeed, nonce: nonce, betUnits: bet, params: o.params || {} });
    const payout = round2(Math.max(0, Number(res.payoutUnits) || 0)); // gross back, never negative
    s.tokens = round2(s.tokens + payout);

    const rec = { nonce: nonce, game: o.game, betUnits: bet, params: o.params || {}, clientSeed: clientSeed, payoutUnits: payout, win: !!res.win, multiplier: res.multiplier };
    s.bets.push(rec);
    save();
    return { sessionId: s.id, nonce: nonce, game: o.game, win: rec.win, multiplier: rec.multiplier, payoutUnits: payout, outcome: res.outcome, detail: res.detail, tokens: s.tokens, commit: s.commit };
  }

  // Cash out: compute net, sign it for the contract, reveal the seed.
  async function settle(o) {
    const s = sessions.get(o.sessionId);
    if (!s) throw new Error("no such session");
    if (s.settlement) return s.settlement;            // idempotent
    let netUnits = round2(s.tokens - s.buyInUnits);
    if (netUnits < -s.buyInUnits) netUnits = -s.buyInUnits; // never lose more than locked
    s.closed = true;
    const netWei = toWei(netUnits);
    let signature = null;
    if (signer && signer.sign) signature = await signer.sign(s.player, netWei, s.settleNonce, s.chainId, s.contract);
    s.settlement = {
      sessionId: s.id, player: s.player, netUnits: netUnits, netWei: netWei.toString(),
      nonce: s.settleNonce, chainId: s.chainId, contract: s.contract,
      serverSeedReveal: s.serverSeed, commit: s.commit, betCount: s.bets.length, signature: signature,
    };
    save();
    return s.settlement;
  }

  // Independent re-derivation (what an auditor / the fairness panel runs after reveal):
  // replays every bet from the revealed seed and checks the recorded payouts + commit.
  function rederive(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("no such session");
    const commitOk = PF.verify(s.commit, s.serverSeed);
    let allMatch = true; let ledger = s.buyInUnits;
    for (const b of s.bets) {
      const res = ENGINES[b.game].play({ serverSeed: s.serverSeed, clientSeed: b.clientSeed, nonce: b.nonce, betUnits: b.betUnits, params: b.params });
      const payout = round2(Math.max(0, Number(res.payoutUnits) || 0));
      if (Math.abs(payout - b.payoutUnits) > 1e-9) allMatch = false;
      ledger = round2(ledger - b.betUnits + payout);
    }
    return { commitOk: commitOk, payoutsMatch: allMatch, ledgerMatches: Math.abs(ledger - s.tokens) < 1e-6, finalTokens: s.tokens };
  }

  function session(id) { return sessions.get(id) || null; }

  return { start, play, settle, rederive, session, games, hasGame, _sessions: sessions };
}

module.exports = { makeTokenBridge, games, hasGame, ENGINES };

/* ---------------- CLI self-test: node server/token-bridge.js ---------------- */
if (require.main === module) {
  const { ethers } = require("ethers");
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

  (async () => {
    // local test signer mirroring server/realmoney.js's digest exactly
    const wallet = ethers.Wallet.createRandom();
    const settlementHash = (player, net, nonce, chainId, contractAddr) =>
      ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [player, net, nonce, chainId, contractAddr]);
    const signer = {
      sign: async (player, net, nonce, chainId, contractAddr) => wallet.signMessage(ethers.getBytes(settlementHash(player, BigInt(net), BigInt("0x" + Buffer.from(String(nonce)).toString("hex").slice(0, 12) || "0"), chainId, contractAddr))),
    };
    // simpler: use a numeric nonce for the digest
    const NONCE = 123456n;
    const signer2 = { sign: async (player, net, _n, chainId, contractAddr) => wallet.signMessage(ethers.getBytes(settlementHash(player, BigInt(net), NONCE, chainId, contractAddr))) };

    const player = "0x2F4BEF94550C29c497b999B86b758F9771F7aB39";
    const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
    const tb = makeTokenBridge({ signer: signer2, toWei: (u) => BigInt(Math.round(u * 1e6)) }); // 1 unit = 1e6 wei (test scale)

    // games are registered
    eq("7 games token-enabled (" + tb.games().join(",") + ")", tb.games().length === 7);

    // start a big session so we can measure RTP without running dry
    const st = tb.start({ player, chainId: 11155111, contract, buyInUnits: 5_000_000, settleNonce: NONCE });
    eq("start publishes a commit", /^[0-9a-f]{64}$/.test(st.commit));
    eq("tokens granted == buy-in", st.tokens === 5_000_000);

    // play a long coinflip run and measure RTP through the LEDGER
    let wagered = 0, returned = 0;
    for (let i = 0; i < 300000; i++) {
      const side = i % 2;
      const r = tb.play({ sessionId: st.sessionId, game: "coinflip", betUnits: 1, params: { side }, clientSeed: "c" + (i % 97) });
      wagered += 1; returned += r.payoutUnits;
    }
    const rtp = returned / wagered;
    eq("coinflip RTP through the ledger ~97% (got " + (rtp * 100).toFixed(2) + "%)", Math.abs(rtp - 0.97) < 0.01);

    // mixed games keep the ledger exact
    tb.play({ sessionId: st.sessionId, game: "dice", betUnits: 10, params: { target: 5000, over: true }, clientSeed: "x" });
    tb.play({ sessionId: st.sessionId, game: "crash", betUnits: 10, params: { cashOutAt: 2 }, clientSeed: "y" });
    tb.play({ sessionId: st.sessionId, game: "slots", betUnits: 10, params: {}, clientSeed: "z" });

    // can't overbet / unknown game / non-positive
    let threw = 0; try { tb.play({ sessionId: st.sessionId, game: "poker", betUnits: 1 }); } catch (e) { threw++; }
    try { tb.play({ sessionId: st.sessionId, game: "coinflip", betUnits: -5 }); } catch (e) { threw++; }
    try { tb.play({ sessionId: st.sessionId, game: "coinflip", betUnits: 1e12 }); } catch (e) { threw++; }
    eq("rejects unknown game / negative / over-bet", threw === 3);

    // provably-fair re-derivation matches the whole ledger
    const rd = tb.rederive(st.sessionId);
    eq("commit verifies against revealed seed", rd.commitOk);
    eq("every bet re-derives to the same payout", rd.payoutsMatch);
    eq("ledger reconciles to final tokens", rd.ledgerMatches);

    // settle signs a recoverable net + reveals the seed
    const stl = await tb.settle({ sessionId: st.sessionId });
    const rec = ethers.verifyMessage(ethers.getBytes(settlementHash(player, BigInt(stl.netWei), NONCE, 11155111, contract)), stl.signature);
    eq("settlement signature recovers to the house signer", rec === wallet.address);
    eq("net never below −buyIn", stl.netUnits >= -5_000_000);
    eq("settle reveals the serverSeed", stl.serverSeedReveal && PF.verify(stl.commit, stl.serverSeedReveal));
    eq("settle is idempotent", (await tb.settle({ sessionId: st.sessionId })).signature === stl.signature);

    console.log(ok ? "\nSELF-TEST OK — token bridge: buy-in → provably-fair play → signed, verifiable settle." : "\nSELF-TEST FAILED");
    process.exit(ok ? 0 : 1);
  })().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
}
