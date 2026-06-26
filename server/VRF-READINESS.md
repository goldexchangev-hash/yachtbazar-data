# Blackjack — VRF / on-chain readiness

The engine is **server-authoritative** today (the server owns the shoe, deals,
validates, settles in-memory demo balances). Going live with real crypto means
moving the *randomness* and *settlement* on-chain. The engine was built with two
clean seams so that swap is a drop-in, not a rewrite.

## The two seams

### 1. `randomness` — where the per-round random word comes from
`attachBlackjack({ randomness })`. A provider exposes:

```js
randomness = {
  name: "chainlink-vrf",
  begin(shoeId) {
    // returns { serverSeed, commit, proof }
    // serverSeed = the random word (hex); commit = on-chain commitment / request id;
    // proof = the VRF proof bytes (verifiable on-chain)
  }
}
```

**Default (off-chain, today):** `name:"commit-reveal"` — generates a 32-byte
`serverSeed`, publishes `commit = SHA256(serverSeed)` *before* any bet, reveals
`serverSeed` after the round. Combined with every seat's `clientSeed`, the house
cannot change the shoe after seeing bets, and anyone can recompute it.

**Chainlink VRF:** `begin()` requests a VRF word for the round and returns it as
`serverSeed` plus the `proof`. Nothing else in the engine changes — the shoe is
still `shuffle(serverSeed, clientSeeds, shoeId, decks)`.

### 2. `makeShoe` — how the shoe is derived from the word
`attachBlackjack({ makeShoe })`, default `BlackjackShuffle.shuffle`. Deterministic
Fisher-Yates over a canonical 312-card deck, each swap index from
`HMAC_SHA256(serverSeed, shoeId:clientSeeds:i)`. Reproducible from public inputs.

## What the reveal already carries
`bj:reveal` broadcasts everything an independent (or on-chain) verifier needs:
`serverSeed` (the word), `commit`, `clientSeeds` (seat-ordered), `shoeId`,
`decks`, `source`, and `proof`. The browser fairness panel uses exactly these to
recompute the shoe (`BlackjackShuffle.verify`).

## Going-live flow (VRF + on-chain settlement)

1. **Lock bets.** Players' wagers move into escrow (contract), not the in-memory
   bank. Each player contributes a `clientSeed`.
2. **Request randomness.** On `endBetting`, the VRF provider requests a word for
   `shoeId` (the request tx is the public commitment — no word exists yet, so the
   house cannot have pre-computed the shoe).
3. **Fulfillment.** Chainlink returns `{ word, proof }`. Set `serverSeed = word`;
   derive the shoe via `makeShoe`. Play proceeds exactly as now.
4. **Settle on-chain.** The contract **re-derives the shoe** from
   `(word, clientSeeds, shoeId, decks)`, replays the recorded action log, and
   **validates every payout itself** — it must never trust a server- or
   client-reported outcome. Payouts: win 2×, blackjack 2.5× (3:2), push 1×,
   surrender 0.5×, insurance 3× the side bet on dealer BJ.

## Porting the rules on-chain
`public/blackjack-rules.js` and `public/blackjack-shuffle.js` are **pure and
isomorphic** — they are the spec to reimplement in Solidity (or to run in a
verifier/zk circuit). Keep them the single source of truth: the contract's
hand-value, dealer-S17, and settlement math must match these byte-for-byte, and
the shoe derivation must match `shuffle()`.

## Pre-launch security checklist
- [ ] Bets escrow on-chain before the shoe word exists; refund path on room close.
- [ ] Contract re-derives the shoe from the VRF word + client seeds and validates
      payouts — server is a relay, not a trusted oracle, for money.
- [ ] Action log per hand is recorded/committed so settlement is replayable.
- [ ] Per-connection wallet is authenticated (signature), not a guest id, for real money.
- [ ] Rate-limit intents; cap MAX_ROOMS; graceful-shutdown escrow refund.
- [ ] Reconnect/resume so a dropped player isn't auto-stood mid-hand (or auto-stand is acceptable & disclosed).
- [ ] Remove any debug/test hooks (`makeShoe` stacked-deck injection is test-only).

## Status today
Provably-fair (commit-reveal), deterministic reproducible shoe, full reveal
payload, and the `randomness`/`makeShoe` seams are **in place**. What remains for
live is the on-chain escrow + VRF provider + Solidity settlement — none of which
require changing the game engine's structure.
