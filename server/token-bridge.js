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

// mega-hunt: BRIDGE-LEVEL payout cap (defense-in-depth against the reef/slots/pressure class — an engine that
// over-credits vs the DEBITED stake). Every engine payout is bounded to a GENEROUS per-game multiple of the
// stake, set well ABOVE each game's real sampled max (coinflip 1.9x, dice 98x, dice2 35x, slots 126x, slots3d
// 188x, crash/pressure ≤1000x, fish/reef ~760x with the bonus tail) so it can NEVER clip a legit win — but a
// mispriced/exploited engine can never drain past the ceiling. Applied identically in play + resolveReserved +
// verifyRederive so the ledger stays re-derivable. Firing this is an exceptional event = a bug/exploit → log loud.
const PAYOUT_CAP = { coinflip: 10, dice: 300, dice2: 150, slots: 600, slots3d: 600, crash: 1100, plane: 1100, swoop: 1100, pressure: 1100, fishshooter: 2500, reef: 2500 };
const PAYOUT_CAP_DEFAULT = 2500;
function clampPayout(game, betUnits, payout) {
  const b = Number(betUnits) || 0;
  if (!(b > 0) || !Number.isFinite(payout)) return payout; // no stake to scale / non-finite handled by caller
  const cap = (PAYOUT_CAP[game] || PAYOUT_CAP_DEFAULT) * b;
  if (payout > cap) { try { console.error("PAYOUT_CAP_HIT game=" + game + " bet=" + b + " payout=" + payout + " -> capped " + cap + " (engine bug/exploit?)"); } catch (e) {} return round2(cap); }
  return payout;
}

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

  // v6 #14: MAX-WIN cap (protects a finite house bankroll from a stuck settle — the settle pays lockedWei+netWei
  // and netWei scales with the session net, so an uncapped big win could exceed the on-chain house float and
  // become UNCLAIMABLE). We cap the session UPSIDE at accrual: s.tokens can never exceed buyInUnits + maxWinUnits,
  // so the DISPLAY never shows more than is payable (no clawback at cash-out) and the signed net is bounded.
  // Applied identically at every token-mutation site AND in verifyRederive (ledger stays re-derivable). Losses are
  // never touched. maxWinUnits is USD-denominated (tokens are). Set via TOKEN_MAX_WIN_USD; raise it as the house
  // grows (a very large value effectively disables the cap). capUp() only clamps the win side.
  const maxWinUnits = (Number(opts.maxWinUnits) > 0) ? Number(opts.maxWinUnits) : Infinity;
  function capUp(tokens, buyInUnits) {
    const ceil = round2(Number(buyInUnits) || 0) + maxWinUnits;
    if (Number.isFinite(ceil) && tokens > ceil) return round2(ceil);
    return tokens;
  }

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
    let dropped = 0, compacted = 0;
    for (const s of sessions.values()) {
      if (!s || !((Number(s.createdAt) || 0) > 0) || !(Number(s.createdAt) < cutoff)) continue;
      // (a) a settled session past its TTL. Prune a WIN or PUSH (net>=0) — on-chain bjNonceUsed + txHash guard a
      // re-claim. But KEEP a LOSS (net<0): it is the durable in-memory evidence the loss-escape guards read —
      // recover's branch (2b) findSettledSessionForPlayer AND the doStart stranded-lock auto-claim — to refuse
      // forgiving a WITHHELD loss. Pruning it (the prior behaviour) let a recover/auto-claim 24h+ after a loss
      // fall through to a net=0 reclaim of the still-locked principal, ESCAPING the loss (reopens #13). pendingSettle
      // is the primary persisted guard; keeping the losing session is belt-and-suspenders against a crash-window
      // loss of that obligation (#209/#215). Losses are bounded per player, so memory stays bounded.
      if (s.settlement) {
        let winOrPush = true; try { winOrPush = BigInt(String(s.settlement.netWei || "0")) >= 0n; } catch (e) {}
        if (winOrPush) { sessions.delete(s.id); dropped++; }
        // v6 #6: a KEPT losing session is retained ONLY as loss-escape evidence. The guards read settlement.
        // netWei/nonce/signature (+ s.closed/chainId/contract) — NEVER s.bets (verified: no external reader, no
        // live endpoint re-derives a settled session). COMPACT it to a tombstone: drop the growing bets[] ledger
        // (and the now-redundant serverSeed — settlement.serverSeedReveal holds it) so a busy player's retained
        // losses can't balloon the map + persisted file without bound. The loss-escape record + idempotent settle
        // are untouched. (Was: keep the whole session forever → unbounded growth, v6 #6.)
        else if (Array.isArray(s.bets) && s.bets.length) { s.bets = []; s.serverSeed = undefined; s.tombstoned = true; compacted++; }
        continue;
      }
      // (b) v4 #16: a LIMBO session (closed, no settlement — the #13 signer-outage path) past its TTL. ONLY prune
      // it when it's net=ZERO (tokens == buyInUnits): pruning a LOSING limbo would let a later recover() fall
      // through to the net=0 orphan branch and FORGIVE the loss (reopening the loss-escape #13 closed); pruning a
      // WINNING limbo would silently forfeit the player's unclaimed winnings. A net=0 limbo is equivalent to the
      // orphan path either way, so dropping it is harmless and bounds memory for the benign case.
      if (s.closed && !s.settlement && Math.round((Number(s.tokens) || 0) * 100) === Math.round((Number(s.buyInUnits) || 0) * 100)) { sessions.delete(s.id); dropped++; }
    }
    if (dropped || compacted) save(); // v6 #6: persist tombstone compactions too so the shrunk file lands on disk
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
    finalizeOrphanRounds(s, s.betNonce); // v8 #4: self-heal an orphaned crashRound (bust) so it can't linger blocking BJ or stack a reservation
    const bet = round2(o.betUnits);
    if (!(bet > 0)) throw new Error("bet must be positive");
    // #41: integer-cent overbet check (no float-epsilon tolerance) — mirrors reserve()'s hardened test so
    // a bet can never slip a sub-cent over the balance. Both bet and tokens are already round2'd to cents,
    // so this is exact and never false-rejects a legitimate all-in.
    if (Math.round(bet * 100) > Math.round(s.tokens * 100)) throw new Error("insufficient tokens");

    const nonce = s.betNonce;                          // PEEK — don't burn the nonce until the bet commits
    const clientSeed = String(o.clientSeed == null ? "" : o.clientSeed);
    // TRANSACTIONAL: run the engine FIRST with NO state mutation. If it throws (e.g. an
    // invalid dice line — the contract would revert) or returns a non-finite payout, we
    // bail WITHOUT debiting the stake or burning the nonce — the bet is simply rejected,
    // exactly like an on-chain revert. (Was: debit-then-run, which lost the stake on a throw.)
    let res;
    try { res = ENGINES[o.game].play({ serverSeed: s.serverSeed, clientSeed: clientSeed, nonce: nonce, betUnits: bet, params: o.params || {} }); }
    catch (e) { throw new Error("bet rejected: " + (e && e.message ? e.message : e)); }
    let payout = round2(Math.max(0, Number(res && res.payoutUnits)));
    if (!Number.isFinite(payout)) throw new Error("bet rejected: engine produced a non-finite payout");
    payout = clampPayout(o.game, bet, payout); // bridge-level backstop: never credit past the per-game ceiling

    // Commit atomically now that the result is valid: burn the nonce + move tokens together.
    s.betNonce = nonce + 1;
    s.tokens = capUp(round2(s.tokens - bet + payout), s.buyInUnits); // v6 #14: bound the session win side to the max-win ceiling
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
    // v4 #1 (inverse of v3 #1): refuse a blackjack debit/credit while a server-paced crash round is LIVE on
    // this session. The round RESERVED + debited its stake (an open `crashRound` ledger entry) and a pending
    // resolveReserved will credit it; interleaving a blackjack bet breaks the one-money-activity-at-a-time
    // invariant. This is a bridge-LOCAL check (the open marker lives in s.bets) so it holds for every caller —
    // including applyBlackjackNet — and even survives a restart (an orphaned open round still blocks until
    // it's drained). Mirror of: cr:start refuses during a live BJ hand.
    if (s.bets.some(function (b) { return b && b.kind === "crashRound" && b.open; })) throw new Error("finish your live crash round before settling blackjack");
    const bet = round2(o.betUnits || 0);
    const payout = round2(Math.max(0, o.payoutUnits || 0));
    if (!(bet >= 0) || !Number.isFinite(bet)) throw new Error("invalid external bet");
    if (!Number.isFinite(payout)) throw new Error("invalid external payout");
    // v4 #13: integer-cent overbet check (no float-epsilon) — mirrors play()/reserve(); both bet and tokens
    // are round2'd to cents so this is exact and never false-rejects a legitimate all-in.
    if (Math.round(bet * 100) > Math.round(s.tokens * 100)) throw new Error("insufficient tokens");
    const nonce = s.betNonce;
    s.betNonce = nonce + 1;                              // external entries advance the nonce (contiguous ledger)
    s.tokens = capUp(round2(s.tokens - bet + payout), s.buyInUnits); // v6 #14: bound the win side (blackjack too)
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
    // Cents-rounded figure for DISPLAY/ledger only. The SIGNED wei is derived from the un-rounded net
    // below so a sub-cent loss can't vanish (#21/#204).
    let netUnits = round2(s.tokens - s.buyInUnits);
    if (netUnits < -s.buyInUnits) netUnits = -s.buyInUnits; // never lose more than locked
    s.closed = true;
    // Net→wei PINNED to the exact on-chain locked wei (audit Critical-3): integer math
    //   netWei = lockedWei * netMicro / buyInMicro,  floored at -lockedWei
    // Computed from the UN-rounded net at MICRO (1e6) precision so a sub-cent LOSS does NOT round to 0
    // and hand back the full lock (#21/#204/#205). The division is floored TOWARD THE HOUSE (toward −∞
    // on a loss) so rounding can never favor the player; the loss is still bounded at −lockedWei.
    // Falls back to the injectable toWei (tests with no lockedWei).
    let netWei;
    if (s.lockedWei != null) {
      const lockedWei = BigInt(s.lockedWei);
      let rawNet = s.tokens - s.buyInUnits;
      if (!Number.isFinite(rawNet)) rawNet = 0;
      if (rawNet < -s.buyInUnits) rawNet = -s.buyInUnits; // never lose more than locked
      const netMicro = BigInt(Math.round(rawNet * 1e6));
      const buyInMicro = BigInt(Math.round(s.buyInUnits * 1e6));
      if (buyInMicro > 0n) {
        const num = lockedWei * netMicro;
        netWei = num / buyInMicro;                                  // BigInt division truncates toward zero
        if (num < 0n && (num % buyInMicro) !== 0n) netWei -= 1n;    // floor toward −∞ on a loss → favor the house, never the player
      } else netWei = 0n;
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
        ledger = capUp(round2(ledger - round2(b.betUnits) + round2(Math.max(0, b.payoutUnits))), buyInUnits); // v6 #14: same win-cap as the live ledger so a capped session re-derives exactly
        continue;
      }
      if (b.kind === "crashRound" && b.open) {
        // v4 #4: a RESERVED-but-unresolved crash round — its cashOutAt isn't known yet (the stake was debited at
        // reserve; resolveReserved later rewrites this entry with the final params.cashOutAt + payout). Re-deriving
        // it NOW (empty params) would false-fail mid-round. Trust the recorded provisional bet/payout (payout=0
        // pre-resolve) like an external entry until it's finalized. A RESOLVED crashRound (open:false, has
        // params.cashOutAt) falls through and re-derives exactly below.
        ledger = capUp(round2(ledger - round2(b.betUnits) + round2(Math.max(0, b.payoutUnits))), buyInUnits); // v6 #14: same win-cap as the live ledger so a capped session re-derives exactly
        continue;
      }
      if (!hasGame(b.game)) { payoutsMatch = false; continue; }
      const res = ENGINES[b.game].play({ serverSeed: revealedSeed, clientSeed: b.clientSeed, nonce: b.nonce, betUnits: b.betUnits, params: b.params });
      const payout = clampPayout(b.game, b.betUnits, round2(Math.max(0, Number(res && res.payoutUnits) || 0))); // same cap as play() so a capped payout re-derives to the same value
      if (Math.abs(payout - round2(b.payoutUnits)) > 1e-9) payoutsMatch = false;
      ledger = capUp(round2(ledger - round2(b.betUnits) + payout), buyInUnits); // v6 #14: same win-cap as play()
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

  // ── server-paced rounds (crash family): RESERVE then RESOLVE at a PINNED nonce ──
  // A live round (crash-rounds.js) must (a) reserve the stake up front so a concurrent drain can't
  // dodge a loss (#2), and (b) PIN+BURN the nonce so an interleaved play() can't move the round's
  // crash point out from under the animation (#1). reserve() does both atomically:
  //   • balance-check (integer-cent) + DEBIT the full stake now,
  //   • PIN the current betNonce, derive THIS round's point at it, then BURN it (betNonce++),
  //   • record a provisional bet entry (kind:"crashRound", open:true) holding the stake.
  // The point is computed at the pinned nonce, so resolveReserved() — which runs the real engine
  // play() at the SAME nonce+clientSeed — always agrees with the paced curve.
  function reserve(o) {
    const s = sessions.get(o && o.sessionId);
    if (!s) throw new Error("no such session");
    if (s.closed) throw new Error("session is closed");
    const game = String((o && o.game) || "crash");
    if (!hasGame(game)) throw new Error("game not token-enabled: " + game);
    finalizeOrphanRounds(s, s.betNonce); // v8 #4: bust any orphaned open crashRound BEFORE debiting a new one → no double-debit after a SIGKILL the boot drain missed
    const bet = round2(o.betUnits);
    if (!(bet > 0)) throw new Error("bet must be positive");
    if (Math.round(bet * 100) > Math.round(s.tokens * 100)) throw new Error("insufficient tokens"); // integer-cent (no float-epsilon overbet)
    const clientSeed = String(o.clientSeed == null ? "" : o.clientSeed);
    const nonce = s.betNonce;                 // PIN this nonce for the whole round
    const point = (game === "pressure")
      ? ENGINES.pressure.deriveBurst(s.serverSeed, clientSeed, nonce)
      : ENGINES.crash.crashPointOf(s.serverSeed, clientSeed, nonce);
    s.betNonce = nonce + 1;                    // BURN the nonce — an interleaved play() now gets nonce+1
    s.tokens = round2(s.tokens - bet);         // DEBIT the stake up front
    const rec = { nonce: nonce, kind: "crashRound", game: game, betUnits: bet, params: {}, clientSeed: clientSeed, payoutUnits: 0, win: false, multiplier: 0, open: true };
    s.bets.push(rec);
    s._noOpenCrashRound = false; // v8 #4: a live open round now exists → the next reserve/play must re-check for an orphan
    save();
    return { sessionId: s.id, nonce: nonce, point: point, crashPoint: point, betUnits: bet, tokens: s.tokens };
  }
  // Finalize a reserved round at its PINNED nonce: run the real engine play() at that nonce+clientSeed
  // with the round's actual cashOutAt, CREDIT the gross payout (the stake was already debited at
  // reserve), and rewrite the provisional entry to its final, re-derivable form. Idempotent per nonce.
  function resolveReserved(o) {
    const s = sessions.get(o && o.sessionId);
    if (!s) throw new Error("no such session");
    const nonce = Number(o && o.nonce);
    const rec = s.bets.find((b) => b && b.kind === "crashRound" && Number(b.nonce) === nonce);
    if (!rec) throw new Error("no reserved round at nonce " + nonce);
    if (!rec.open) return { sessionId: s.id, nonce: nonce, win: rec.win, payoutUnits: rec.payoutUnits, multiplier: rec.multiplier, tokens: s.tokens }; // already resolved (idempotent — safe even if the session later closed)
    // v4 #14: defense-in-depth — refuse to mutate a CLOSED session (a late timer firing after an improper
    // close shouldn't credit tokens into a settled/closed session). Placed AFTER the idempotent return so a
    // duplicate resolve of an already-finalized round still returns cleanly. (The live-round guards on
    // settle/recover normally prevent a session closing under an open round; this is the backstop.)
    if (s.closed) throw new Error("session is closed");
    const cashOutAt = Number(o && o.cashOutAt);
    const params = { cashOutAt: cashOutAt };
    const res = ENGINES[rec.game].play({ serverSeed: s.serverSeed, clientSeed: rec.clientSeed, nonce: nonce, betUnits: rec.betUnits, params: params });
    let payout = round2(Math.max(0, Number(res && res.payoutUnits)));
    if (!Number.isFinite(payout)) throw new Error("resolve rejected: non-finite payout");
    payout = clampPayout(rec.game, rec.betUnits, payout); // bridge-level backstop on the crash-round payout too
    s.tokens = capUp(round2(s.tokens + payout), s.buyInUnits); // v6 #14: bound the win side (crash rounds too)
    rec.open = false; rec.params = params; rec.payoutUnits = payout; rec.win = !!res.win; rec.multiplier = res.multiplier;
    rec.outcome = res.outcome;                // persist {crashPoint,...} so the ledger entry exposes the settled point (audit + paced==ledger check)
    save();
    return { sessionId: s.id, nonce: nonce, game: rec.game, win: rec.win, multiplier: rec.multiplier, payoutUnits: payout, outcome: res.outcome, tokens: s.tokens };
  }

  // v8 #4: DRAIN-ON-DETECT backstop. A durable open:true crashRound means a prior round was interrupted (SIGKILL)
  // with its stake already debited at reserve() — and the RAM activeBySession guard that normally blocks a 2nd live
  // round is EMPTY after a restart. If the boot drainOrphanReservations() couldn't clear it (e.g. a resolveReserved
  // throw across a deploy), a fresh reserve()/play() must NOT stack a second live round (that DOUBLE-DEBITS). Finalize
  // the orphan as a BUST here (deterministic + re-derivable; the stake stays gone as the interrupted loss — identical
  // semantics to drainOrphanReservations, and house-safe: a SIGKILL can't refund a losing round) BEFORE proceeding.
  // This SELF-HEALS — unlike a hard throw, which would refuse the session FOREVER if the orphan never drains (a
  // permanent strand). Only soft-throws a RETRYABLE error if an orphan genuinely can't finalize. `exceptNonce` skips
  // the entry a caller is about to create (defensive). Single-threaded bridge (/play + WS serialize) → no async here.
  function finalizeOrphanRounds(s, exceptNonce) {
    // O(1) HOT PATH: once a session has no open crashRound we set _noOpenCrashRound; only reserve() (which opens
    // a round) clears it. This keeps play()/reserve() O(1) on the hot path — a heavy session accumulates tens of
    // thousands of bets, and re-scanning bets[] on EVERY call would be O(n²). The scan runs only when an open round
    // might actually exist: the FIRST call after a load (the boot-orphan case — the flag is absent on the rehydrated
    // session) or right after a reserve() (a live round that the RAM activeBySession guard already knows about; if
    // reserve/play is even reached, RAM says no round is live, so any open ledger round is a genuine orphan).
    if (!s || !s.bets || s._noOpenCrashRound) return;
    for (const b of s.bets) {
      if (b && b.kind === "crashRound" && b.open && Number(b.nonce) !== Number(exceptNonce)) {
        try { resolveReserved({ sessionId: s.id, nonce: b.nonce, cashOutAt: 1e9 }); }
        catch (e) { throw new Error("a previous crash round is still finalizing — try again in a moment"); } // leaves the flag unset → next retry re-scans
      }
    }
    s._noOpenCrashRound = true; // every open crashRound (bar the guarded nonce) is finalized → skip the scan until the next reserve()
  }

  // v4 #5: a SIGKILL (not the graceful SIGTERM crash-rounds drain) can leave a crashRound RESERVED on disk
  // (open:true) with NO live timer to resolve it. On the next boot those orphans would (a) block blackjack on
  // that session forever (the #1 applyExternal guard) and (b) let a NEW cr:start stack a 2nd reservation. Call
  // this once at startup: resolve each orphan as a BUST (cashOutAt huge → crashPoint < it → payout 0). The stake
  // was already debited at reserve, so a bust just FINALIZES the interrupted round — deterministic + re-derivable
  // (the recorded cashOutAt replays to payout 0). Best-effort; never throws.
  function drainOrphanReservations() {
    let drained = 0;
    for (const s of sessions.values()) {
      if (!s || s.closed) continue;
      for (const rec of (s.bets || [])) {
        if (rec && rec.kind === "crashRound" && rec.open) {
          try { resolveReserved({ sessionId: s.id, nonce: rec.nonce, cashOutAt: 1e9 }); drained++; } catch (e) {}
        }
      }
    }
    return drained;
  }

  return { start, play, applyExternal, topUp, settle, rederive, verifyRederive, session, games, hasGame, pointPeek, crashPointPeek, reserve, resolveReserved, drainOrphanReservations, gcClosed, _sessions: sessions };
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

    // v6 #6: a settled LOSS is KEPT (loss-escape evidence) but COMPACTED to a tombstone — bets[] dropped, the
    // settlement (netWei/nonce/signature) retained. Bounds the map/file growth from the v12.66 loss-keeping.
    const lb = makeTokenBridge({ signer: signer2, settledTtlMs: 1, toWei: (u) => BigInt(Math.round(u * 1e6)) });
    const ls = lb.start({ player, chainId: 1, contract, buyInUnits: 100, lockedWei: (1n * 10n ** 18n).toString(), settleNonce: NONCE }).sessionId;
    lb.applyExternal({ sessionId: ls, game: "blackjack", betUnits: 100, payoutUnits: 0, ref: "bustloss" }); // deterministic LOSS → tokens 0, net −100
    await lb.settle({ sessionId: ls });
    eq("the losing session settled net<0", BigInt(lb.session(ls).settlement.netWei) < 0n);
    lb.session(ls).createdAt = 1; // force past the 1ms TTL
    const d2 = lb.gcClosed();
    const lAfter = lb.session(ls);
    eq("GC KEEPS a settled LOSS (loss-escape evidence, not pruned)", !!lAfter && d2 === 0 && !!lAfter.settlement);
    eq("GC COMPACTS the kept loss (bets[] dropped, tombstoned)", lAfter.bets.length === 0 && lAfter.tombstoned === true);

    // settle signs a recoverable net + reveals the seed
    const stl = await tb.settle({ sessionId: st.sessionId });
    const rec = ethers.verifyMessage(ethers.getBytes(settlementHash(player, BigInt(stl.netWei), NONCE, 11155111, contract)), stl.signature);
    eq("settlement signature recovers to the house signer", rec === wallet.address);
    eq("net never below −buyIn", stl.netUnits >= -5_000_000);
    eq("settle reveals the serverSeed", stl.serverSeedReveal && PF.verify(stl.commit, stl.serverSeedReveal));
    eq("settle is idempotent", (await tb.settle({ sessionId: st.sessionId })).signature === stl.signature);

    // ── v6 #14: MAX-WIN cap — bounds the session UPSIDE so the settle can't exceed the house; ledger stays exact ──
    const cap = makeTokenBridge({ signer: signer2, maxWinUnits: 500, toWei: (u) => BigInt(Math.round(u * 1e6)) });
    const cs2 = cap.start({ player, chainId: 1, contract, buyInUnits: 100, settleNonce: NONCE });
    cap.applyExternal({ sessionId: cs2.sessionId, game: "blackjack", betUnits: 10, payoutUnits: 100000, ref: "jackpot" }); // huge win → capped
    eq("max-win cap bounds s.tokens at buyIn+cap (100+500)", cap.session(cs2.sessionId).tokens === 600);
    const crd = cap.rederive(cs2.sessionId);
    eq("capped session still re-derives exactly (ledger == capped tokens)", crd.ledgerMatches && crd.ok);
    cap.applyExternal({ sessionId: cs2.sessionId, game: "blackjack", betUnits: 50, payoutUnits: 0, ref: "loss" }); // a loss AFTER the cap still reduces tokens
    eq("max-win cap never touches the loss side", cap.session(cs2.sessionId).tokens === 550);
    const cstl = await cap.settle({ sessionId: cs2.sessionId });
    eq("capped session settles (net bounded to the cap)", cstl.netUnits === 450); // 550 − 100 buyIn

    // ── v8 #4: DRAIN-ON-DETECT — an orphaned open crashRound (SIGKILL that the boot drain missed) must NOT let a
    //    fresh reserve()/play() stack a 2nd live round (double-debit); it is bust-finalized first. A NORMAL
    //    sequential round is NOT falsely blocked, and an un-finalizable orphan soft-throws a RETRYABLE error
    //    (self-heals) rather than permanently stranding the session. ──
    const ob = makeTokenBridge({ signer: signer2, toWei: (u) => BigInt(Math.round(u * 1e6)) });
    const os = ob.start({ player, chainId: 1, contract, buyInUnits: 1000 }).sessionId;
    const oTok0 = ob.session(os).tokens;
    ob.reserve({ sessionId: os, game: "crash", betUnits: 40, clientSeed: "a" }); // stake debited, open:true
    eq("reserve debits the stake", ob.session(os).tokens === round2(oTok0 - 40));
    eq("orphan crashRound is still open (SIGKILL: never resolved, boot drain skipped)", ob.session(os).bets.filter((b) => b.kind === "crashRound" && b.open).length === 1);
    const oTokBefore2 = ob.session(os).tokens;
    const r2 = ob.reserve({ sessionId: os, game: "crash", betUnits: 40, clientSeed: "b" }); // must bust the orphan FIRST
    eq("second reserve leaves only ONE open round (the new one) — no stacked live round", ob.session(os).bets.filter((b) => b.kind === "crashRound" && b.open).length === 1);
    eq("second reserve debits ONE new stake only (no double-debit; orphan stake stays a loss)", ob.session(os).tokens === round2(oTokBefore2 - 40));
    eq("the orphan was finalized to a BUST (open:false, payout 0)", ob.session(os).bets.filter((b) => b.kind === "crashRound" && !b.open && b.payoutUnits === 0).length === 1);
    ob.resolveReserved({ sessionId: os, nonce: r2.nonce, cashOutAt: 1e9 }); // settle r2 normally (bust)
    let seqOk = 1; try { ob.reserve({ sessionId: os, game: "crash", betUnits: 40, clientSeed: "c" }); } catch (e) { seqOk = 0; }
    eq("a normally-settled round does NOT block the next reserve", seqOk === 1);
    ob.play({ sessionId: os, game: "coinflip", betUnits: 5, params: { side: 0 }, clientSeed: "d" }); // play() self-heals the lingering orphan (round c) too
    eq("play() also drains a lingering orphan (no open crashRound remains)", ob.session(os).bets.filter((b) => b.kind === "crashRound" && b.open).length === 0);
    // Un-finalizable orphan (unknown engine) → RETRYABLE soft-throw, session NOT closed (no permanent strand).
    const fb = makeTokenBridge({ signer: signer2, toWei: (u) => BigInt(Math.round(u * 1e6)) });
    const fs = fb.start({ player, chainId: 1, contract, buyInUnits: 100 }).sessionId;
    fb.reserve({ sessionId: fs, game: "crash", betUnits: 10, clientSeed: "x" });
    fb.session(fs).bets.find((b) => b.kind === "crashRound" && b.open).game = "___nope___"; // corrupt → resolveReserved throws
    let ftMsg = ""; try { fb.reserve({ sessionId: fs, game: "crash", betUnits: 10, clientSeed: "y" }); } catch (e) { ftMsg = e.message; }
    eq("un-finalizable orphan → RETRYABLE error (not a permanent 'already live' strand)", /try again in a moment/.test(ftMsg));
    eq("session is NOT closed after the retryable throw (self-heals on retry)", !fb.session(fs).closed);

    console.log(ok ? "\nSELF-TEST OK — token bridge: buy-in → provably-fair play → signed, verifiable settle." : "\nSELF-TEST FAILED");
    process.exit(ok ? 0 : 1);
  })().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
}
