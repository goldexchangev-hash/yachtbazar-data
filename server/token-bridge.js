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

const crypto = require("crypto");
const PF = require("./provablyfair.js");

// A uint256 nonce as a decimal string (matches the on-chain settle digest key + bridge-server.js).
function uintNonce() { return BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString(); }

// ── game registry: only games with a server-authoritative engine may take tokens ──
const ENGINES = {
  coinflip: require("./games/coinflip.js"),
  dice: require("./games/dice.js"),
  dice2: require("./games/dice2.js"),
  crash: require("./games/crash.js"),
  pressure: require("./games/pressure.js"),
  slots: require("./games/slots.js"),
  slots3d: require("./games/slots3d.js"),
  fishshooter: require("./games/fishshooter.js"), // per-shot micro-bet engine (continuous game)
  reef: require("./games/reef.js"),               // per-shot micro-bet engine (continuous game)
  plane: require("./games/crash.js"),             // Aviator-style climb = the crash mechanic
  swoop: require("./games/crash.js"),             // Sky Swoop biplane = the crash mechanic
};
// NOTE: blackjack + poker are MULTIPLAYER/round-based and run on their own server-authoritative
// engines (blackjack-server.js / poker-server.js), not this single-player per-bet ledger.
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

  // Bound the session map: drop SETTLED sessions long past their cash-out so the map + persisted
  // file don't grow forever. OPEN (unsettled) sessions are NEVER pruned — deleting one would strand
  // its on-chain lock (the serverSeed/nonce would be gone and it could never settle). 24h is well
  // past any settle retry, and the on-chain bjNonceUsed + txHash replay guard stop a double-claim.
  const SETTLED_TTL_MS = Number(opts.settledTtlMs) || 24 * 3600 * 1000;
  function nowMs() { try { return Date.now(); } catch (e) { return 0; } }
  function gcClosed() {
    const cutoff = nowMs() - SETTLED_TTL_MS;
    let dropped = 0;
    for (const s of sessions.values()) {
      if (s && s.settlement && (Number(s.createdAt) || 0) > 0 && Number(s.createdAt) < cutoff) { sessions.delete(s.id); dropped++; }
    }
    if (dropped) save();
    return dropped;
  }

  // Begin a session. buyInUnits = tokens granted (the on-chain lock, verified upstream).
  function start(o) {
    gcClosed(); // opportunistically prune old settled sessions whenever a new one opens
    const player = String(o.player || "").toLowerCase();
    if (!player) throw new Error("player required");
    const buyInUnits = round2(o.buyInUnits);
    if (!(buyInUnits > 0)) throw new Error("buy-in must be positive");
    const rnd = PF.newRound(); // { serverSeed (secret), commit (public) }
    const id = o.sessionId || PF.randomSeed(16);
    const s = {
      id: id, player: player, chainId: Number(o.chainId) || 0, contract: o.contract || "",
      buyInUnits: buyInUnits, tokens: buyInUnits,
      lockedWei: o.lockedWei != null ? BigInt(o.lockedWei).toString() : null, // the EXACT on-chain locked wei this buy-in represents (pins settle net→wei)
      serverSeed: rnd.serverSeed, commit: rnd.commit, settleNonce: o.settleNonce != null ? String(o.settleNonce) : uintNonce(),
      betNonce: 0, bets: [], closed: false, settlement: null, startedAt: o.now || 0, createdAt: nowMs(),
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

    const nonce = s.betNonce;                          // PEEK — don't burn the nonce until the bet commits
    const clientSeed = String(o.clientSeed == null ? "" : o.clientSeed);
    // TRANSACTIONAL: run the engine FIRST with NO state mutation. If it throws (e.g. an
    // invalid dice line — the contract would revert) or returns a non-finite payout, we
    // bail WITHOUT debiting the stake or burning the nonce — the bet is simply rejected,
    // exactly like an on-chain revert. (Was: debit-then-run, which lost the stake on a throw.)
    let res;
    try { res = ENGINES[o.game].play({ serverSeed: s.serverSeed, clientSeed: clientSeed, nonce: nonce, betUnits: bet, params: o.params || {} }); }
    catch (e) { throw new Error("bet rejected: " + (e && e.message ? e.message : e)); }
    const payout = round2(Math.max(0, Number(res && res.payoutUnits)));
    if (!Number.isFinite(payout)) throw new Error("bet rejected: engine produced a non-finite payout");

    // Commit atomically now that the result is valid: burn the nonce + move tokens together.
    s.betNonce = nonce + 1;
    s.tokens = round2(s.tokens - bet + payout);
    const rec = { nonce: nonce, game: o.game, betUnits: bet, params: o.params || {}, clientSeed: clientSeed, payoutUnits: payout, win: !!res.win, multiplier: res.multiplier };
    s.bets.push(rec);
    save();
    return { sessionId: s.id, nonce: nonce, game: o.game, win: rec.win, multiplier: rec.multiplier, payoutUnits: payout, outcome: res.outcome, detail: res.detail, tokens: s.tokens, commit: s.commit };
  }

  // TOP UP an OPEN session: the player locked MORE on-chain (a second blackjackBuyIn, which
  // ACCUMULATES bjLocked) — add it to this session's principal + tokens. Keeping lockedWei AND
  // buyInUnits both reflecting the new total preserves the settle invariant exactly:
  //   netWei = lockedWei_total * (tokens − buyInUnits_total)·100 / (buyInUnits_total·100),
  // floored at −lockedWei_total, so the player still can never lose more than the (now larger)
  // total they locked, and the contract returns bjLocked_total + net at cash-out.
  function topUp(o) {
    const s = sessions.get(o.sessionId);
    if (!s) throw new Error("no such session");
    if (s.closed) throw new Error("session is closed");
    const addUnits = round2(o.addUnits);
    if (!(addUnits > 0)) throw new Error("top-up must be positive");
    s.buyInUnits = round2(s.buyInUnits + addUnits);
    s.tokens = round2(s.tokens + addUnits);
    if (o.addLockedWei != null && s.lockedWei != null) {
      s.lockedWei = (BigInt(s.lockedWei) + BigInt(o.addLockedWei)).toString();
    }
    save();
    return { sessionId: s.id, tokens: s.tokens, buyInUnits: s.buyInUnits, lockedWei: s.lockedWei };
  }

  // Apply an EXTERNAL, house-attested result to a session's tokens — e.g. a multiplayer blackjack hand,
  // whose outcome comes from BLACKJACK's OWN provably-fair shoe (a separate commit-reveal), NOT this
  // bridge's seed. We record it as a ledger entry so the signed settle net stays exact and the ledger
  // still reconciles; the player verifies the hand itself via the game's shoe reveal (carried in `ref`/
  // `shoeCommit`). Trusted, in-process server use only (the game server is the authority on the result).
  // Bounds: betUnits ≥ 0 and ≤ current tokens; payoutUnits ≥ 0; tokens can never go negative.
  function applyExternal(o) {
    const s = sessions.get(o && o.sessionId);
    if (!s) throw new Error("no such session");
    if (s.closed) throw new Error("session is closed");
    if (s.settlement) throw new Error("session already settled");
    const bet = round2(o.betUnits || 0);
    const payout = round2(Math.max(0, o.payoutUnits || 0));
    if (!(bet >= 0) || !Number.isFinite(bet)) throw new Error("invalid external bet");
    if (!Number.isFinite(payout)) throw new Error("invalid external payout");
    if (bet > s.tokens + 1e-9) throw new Error("insufficient tokens");
    const nonce = s.betNonce;
    s.betNonce = nonce + 1;                              // external entries advance the nonce (contiguous ledger)
    s.tokens = round2(s.tokens - bet + payout);
    if (s.tokens < 0) s.tokens = 0;
    const rec = { nonce: nonce, kind: "external", game: String(o.game || "blackjack"), betUnits: bet, payoutUnits: payout, ref: o.ref != null ? String(o.ref) : "", shoeCommit: o.shoeCommit ? String(o.shoeCommit) : "" };
    s.bets.push(rec);
    save();
    return { sessionId: s.id, tokens: s.tokens, nonce: nonce };
  }

  // Cash out: compute net, sign it for the contract, reveal the seed.
  async function settle(o) {
    const s = sessions.get(o.sessionId);
    if (!s) throw new Error("no such session");
    if (s.settlement) return s.settlement;            // idempotent
    let netUnits = round2(s.tokens - s.buyInUnits);
    if (netUnits < -s.buyInUnits) netUnits = -s.buyInUnits; // never lose more than locked
    s.closed = true;
    // Net→wei PINNED to the exact on-chain locked wei (audit Critical-3): integer math
    //   netWei = lockedWei * netCents / buyInCents,  floored at -lockedWei
    // so a rounding/rate drift can't sign a loss bigger than the player actually locked,
    // and the win is bounded by the same ratio. Falls back to the injectable toWei (tests).
    let netWei;
    if (s.lockedWei != null) {
      const lockedWei = BigInt(s.lockedWei);
      const netCents = BigInt(Math.round(netUnits * 100));
      const buyInCents = BigInt(Math.round(s.buyInUnits * 100));
      netWei = buyInCents > 0n ? (lockedWei * netCents) / buyInCents : 0n;
      if (netWei < -lockedWei) netWei = -lockedWei;
    } else {
      netWei = toWei(netUnits);
    }
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

  // PURE verifier — the heart of "anyone can re-check the session from public data".
  // Takes ONLY the inputs an auditor holds after reveal (NO live session memory):
  //   commit            : the published SHA256(serverSeed) from start()
  //   revealedSeed      : the serverSeed disclosed at settle()
  //   orderedBets       : the bet ledger, each { nonce, game, betUnits, params, clientSeed, payoutUnits }
  //   buyInUnits        : tokens granted at start (ledger origin)
  //   claimedFinalTokens: the final token balance the house claims to have signed against
  // Re-runs every bet through its engine off the revealed seed and asserts:
  //   (a) commit == SHA256(revealedSeed),
  //   (b) nonces are the contiguous 0..n-1 sequence (no skipped/duplicated/re-ordered bet),
  //   (c) every replayed payout matches the recorded payout, and
  //   (d) the replayed ledger (buyIn − Σbet + Σpayout) == claimedFinalTokens.
  function verifyRederive(args) {
    args = args || {};
    const commit = args.commit;
    const revealedSeed = args.revealedSeed;
    const orderedBets = Array.isArray(args.orderedBets) ? args.orderedBets : [];
    const buyInUnits = round2(args.buyInUnits);
    const claimedFinalTokens = round2(args.claimedFinalTokens);

    const commitOk = !!(commit && revealedSeed) && PF.verify(commit, revealedSeed);
    let payoutsMatch = true;
    let noncesOk = true;
    let ledger = buyInUnits;
    for (let i = 0; i < orderedBets.length; i++) {
      const b = orderedBets[i];
      if (Number(b.nonce) !== i) noncesOk = false; // contiguous 0..n-1, in order
      if (b.kind === "external") {
        // House-attested external result (e.g. a blackjack hand). It is NOT re-derivable from THIS
        // bridge's seed — its fairness is proven by the game's own shoe commit-reveal (b.shoeCommit/ref).
        // We trust the recorded bet/payout for the ledger sum; the signed net is still bounded by lockedWei
        // at settle, so this can never sign a loss past the lock or a win the contract can't pay.
        ledger = round2(ledger - round2(b.betUnits) + round2(Math.max(0, b.payoutUnits)));
        continue;
      }
      if (!hasGame(b.game)) { payoutsMatch = false; continue; }
      const res = ENGINES[b.game].play({ serverSeed: revealedSeed, clientSeed: b.clientSeed, nonce: b.nonce, betUnits: b.betUnits, params: b.params });
      const payout = round2(Math.max(0, Number(res && res.payoutUnits) || 0));
      if (Math.abs(payout - round2(b.payoutUnits)) > 1e-9) payoutsMatch = false;
      ledger = round2(ledger - round2(b.betUnits) + payout);
    }
    const ledgerMatches = Math.abs(ledger - claimedFinalTokens) < 1e-6;
    return {
      ok: commitOk && payoutsMatch && noncesOk && ledgerMatches,
      commitOk: commitOk, payoutsMatch: payoutsMatch, noncesOk: noncesOk,
      ledgerMatches: ledgerMatches, replayedTokens: ledger, finalTokens: claimedFinalTokens,
    };
  }

  // Independent re-derivation (what an auditor / the fairness panel runs after reveal):
  // a THIN wrapper that lifts a live session's fields and defers to the PURE verifier.
  function rederive(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("no such session");
    return verifyRederive({
      commit: s.commit,
      revealedSeed: s.serverSeed,
      orderedBets: s.bets,
      buyInUnits: s.buyInUnits,
      claimedFinalTokens: s.tokens,
    });
  }

  function session(id) { return sessions.get(id) || null; }

  // Derive the secret bust/pop point for the session's NEXT bet (peek — does not burn the
  // nonce), so a live round-runner can pace the curve. GAME-AWARE: the crash family
  // (crash/plane/swoop) uses the crash engine's crashPointOf; pressure (Balloon Pop) is the
  // SAME inverse-CDF with a 3% edge, exposed as deriveBurst. The eventual play(game, …,
  // clientSeed) at the SAME nonce+clientSeed computes the identical point, so pacing and
  // settlement always agree. Trusted server use only — never expose the point before it busts.
  function pointPeek(o) {
    const s = sessions.get(o && o.sessionId);
    if (!s) throw new Error("no such session");
    if (s.closed) throw new Error("session is closed");
    const clientSeed = String(o.clientSeed == null ? "" : o.clientSeed);
    const game = String((o && o.game) || "crash");
    const point = (game === "pressure")
      ? ENGINES.pressure.deriveBurst(s.serverSeed, clientSeed, s.betNonce)
      : ENGINES.crash.crashPointOf(s.serverSeed, clientSeed, s.betNonce); // crash / plane / swoop
    return { nonce: s.betNonce, point: point, crashPoint: point }; // crashPoint kept for back-compat
  }
  // Back-compat alias (crash family only) — older callers used crashPointPeek.
  function crashPointPeek(o) { return pointPeek(Object.assign({ game: "crash" }, o || {})); }

  return { start, play, applyExternal, topUp, settle, rederive, verifyRederive, session, games, hasGame, pointPeek, crashPointPeek, gcClosed, _sessions: sessions };
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
    eq("11 games token-enabled (" + tb.games().join(",") + ")", tb.games().length === 11);

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

    // TRANSACTIONAL: an invalid bet (bad dice2 line → engine throws) is rejected with NO
    // stake lost and NO nonce burned — mirrors an on-chain revert (was: stake silently eaten).
    const bT = tb.session(st.sessionId).tokens, bN = tb.session(st.sessionId).betNonce;
    let rejected = false; try { tb.play({ sessionId: st.sessionId, game: "dice2", betUnits: 50, params: { target: 99, over: true } }); } catch (e) { rejected = true; }
    const aT = tb.session(st.sessionId).tokens, aN = tb.session(st.sessionId).betNonce;
    eq("invalid bet rejected, no stake lost + nonce intact", rejected && aT === bT && aN === bN);

    // settleNonce default is a uint256 decimal string (contract-compatible), not hex.
    const probe = makeTokenBridge({}).start({ player, chainId: 1, contract, buyInUnits: 1 });
    const ps = makeTokenBridge({}); const psid = ps.start({ player, chainId: 1, contract, buyInUnits: 1 }).sessionId;
    eq("default settleNonce is a uint256 decimal", /^[0-9]+$/.test(ps.session(psid).settleNonce));

    // provably-fair re-derivation matches the whole ledger (thin wrapper over the pure verifier)
    const rd = tb.rederive(st.sessionId);
    eq("commit verifies against revealed seed", rd.commitOk);
    eq("every bet re-derives to the same payout", rd.payoutsMatch);
    eq("ledger reconciles to final tokens", rd.ledgerMatches);
    eq("nonces are the contiguous 0..n-1 sequence", rd.noncesOk);
    eq("rederive aggregate ok flag is true", rd.ok === true);

    // ── PURE verifier: operates ONLY on passed-in args, never live session memory ──
    const live = tb.session(st.sessionId);
    const pureArgs = () => ({ commit: live.commit, revealedSeed: live.serverSeed, orderedBets: live.bets.map((b) => ({ ...b, params: { ...b.params } })), buyInUnits: live.buyInUnits, claimedFinalTokens: live.tokens });
    eq("pure verifier passes on honest args", tb.verifyRederive(pureArgs()).ok === true);

    // tamper: a wrong commit must fail commitOk (and overall ok)
    const aWrongCommit = pureArgs(); aWrongCommit.commit = crypto.createHash("sha256").update("not-the-seed").digest("hex");
    const vWrongCommit = tb.verifyRederive(aWrongCommit);
    eq("pure verifier rejects a forged commit", vWrongCommit.commitOk === false && vWrongCommit.ok === false);

    // tamper: a flipped final-tokens claim must fail ledgerMatches
    const aBadFinal = pureArgs(); aBadFinal.claimedFinalTokens = aBadFinal.claimedFinalTokens + 1000;
    const vBadFinal = tb.verifyRederive(aBadFinal);
    eq("pure verifier rejects an inflated final-tokens claim", vBadFinal.ledgerMatches === false && vBadFinal.ok === false);

    // tamper: a doctored recorded payout must fail payoutsMatch
    const aBadPayout = pureArgs(); aBadPayout.orderedBets[0] = { ...aBadPayout.orderedBets[0], payoutUnits: aBadPayout.orderedBets[0].payoutUnits + 999 };
    eq("pure verifier rejects a doctored recorded payout", tb.verifyRederive(aBadPayout).payoutsMatch === false);

    // tamper: a non-contiguous nonce sequence (skip / re-order) must fail noncesOk
    const aBadNonce = pureArgs(); aBadNonce.orderedBets[1] = { ...aBadNonce.orderedBets[1], nonce: aBadNonce.orderedBets[1].nonce + 5 };
    eq("pure verifier rejects a non-contiguous nonce", tb.verifyRederive(aBadNonce).noncesOk === false);

    // the wrapper truly defers to the pure verifier — same honest result
    const rd2 = tb.rederive(st.sessionId);
    eq("wrapper == pure verifier on the live session", rd2.ok === tb.verifyRederive(pureArgs()).ok && rd2.payoutsMatch && rd2.ledgerMatches);

    // ── EXTERNAL RESULTS (token-funded blackjack): hands adjust the SAME session, ledger stays exact ──
    const xb = makeTokenBridge({ signer: signer2, toWei: (u) => BigInt(Math.round(u * 1e6)) });
    const xs = xb.start({ player, chainId: 11155111, contract, buyInUnits: 1000, lockedWei: (1n * 10n ** 18n).toString(), settleNonce: NONCE });
    xb.play({ sessionId: xs.sessionId, game: "coinflip", betUnits: 10, params: { side: 0 }, clientSeed: "mix" }); // a normal token bet too
    const xTokAfterPlay = xb.session(xs.sessionId).tokens;
    const xWin = xb.applyExternal({ sessionId: xs.sessionId, game: "blackjack", betUnits: 100, payoutUnits: 250, ref: "hand#1", shoeCommit: "deadbeef" }); // blackjack hand: bet 100, won 250
    eq("external result moves tokens by (payout − bet)", xWin.tokens === round2(xTokAfterPlay - 100 + 250));
    const xLoss = xb.applyExternal({ sessionId: xs.sessionId, game: "blackjack", betUnits: 50, payoutUnits: 0, ref: "hand#2" }); // blackjack loss
    eq("external loss debits the stake", xLoss.tokens === round2(xWin.tokens - 50));
    let xOver = 0; try { xb.applyExternal({ sessionId: xs.sessionId, betUnits: 1e9, payoutUnits: 0 }); } catch (e) { xOver = 1; }
    eq("external bet over balance is rejected (no negative tokens)", xOver === 1);
    // the provably-fair verifier still reconciles with mixed token + external entries (external entries
    // aren't re-derived from the seed — their fairness rides the game's own shoe — but the LEDGER is exact)
    const xrd = xb.rederive(xs.sessionId);
    eq("mixed token+external ledger reconciles to final tokens", xrd.ledgerMatches && xrd.noncesOk);
    eq("token bets in a mixed session still re-derive (payouts match)", xrd.payoutsMatch);
    const xstl = await xb.settle({ sessionId: xs.sessionId });
    eq("a session with external results settles, net bounded by lock", BigInt(xstl.netWei) >= -(1n * 10n ** 18n));
    let xClosed = 0; try { xb.applyExternal({ sessionId: xs.sessionId, betUnits: 1, payoutUnits: 0 }); } catch (e) { xClosed = 1; }
    eq("external result rejected after settle (closed session)", xClosed === 1);

    // TOP UP: adds locked principal + tokens to an open session, keeping the settle ratio exact.
    const tu = makeTokenBridge({ signer: signer2, toWei: (u) => BigInt(Math.round(u * 1e6)) });
    const tus = tu.start({ player, chainId: 11155111, contract, buyInUnits: 100, lockedWei: (1n * 10n ** 18n).toString(), settleNonce: NONCE });
    tu.play({ sessionId: tus.sessionId, game: "coinflip", betUnits: 100, params: { side: 0 }, clientSeed: "drain" }); // likely lose toward 0
    const beforeTop = tu.session(tus.sessionId).tokens;
    const topped = tu.topUp({ sessionId: tus.sessionId, addUnits: 250, addLockedWei: (25n * 10n ** 17n).toString() }); // +$250, +2.5 ETH
    eq("top-up adds tokens", topped.tokens === round2(beforeTop + 250));
    eq("top-up adds buyInUnits (settle ratio stays consistent)", tu.session(tus.sessionId).buyInUnits === 350);
    eq("top-up accumulates lockedWei", tu.session(tus.sessionId).lockedWei === ((1n * 10n ** 18n) + (25n * 10n ** 17n)).toString());
    const tstl = await tu.settle({ sessionId: tus.sessionId });
    eq("topped-up session never signs a loss beyond total locked", BigInt(tstl.netWei) >= -((1n * 10n ** 18n) + (25n * 10n ** 17n)));
    let topClosed = 0; try { tu.topUp({ sessionId: tus.sessionId, addUnits: 10 }); } catch (e) { topClosed = 1; }
    eq("top-up rejected after settle (closed session)", topClosed === 1);

    // GC: settled sessions past the TTL are pruned; OPEN sessions are NEVER pruned.
    const gcb = makeTokenBridge({ signer: signer2, settledTtlMs: 1 }); // 1ms TTL → everything settled is instantly old
    const gOpen = gcb.start({ player, chainId: 1, contract, buyInUnits: 100 }).sessionId;
    const gSettled = gcb.start({ player, chainId: 1, contract, buyInUnits: 100, settleNonce: NONCE }).sessionId;
    await gcb.settle({ sessionId: gSettled });
    gcb.session(gSettled).createdAt = 1; // force it well past the 1ms TTL
    const dropped = gcb.gcClosed();
    eq("GC prunes the old settled session", dropped === 1 && !gcb.session(gSettled));
    eq("GC never prunes an OPEN session (would strand its lock)", !!gcb.session(gOpen));

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
