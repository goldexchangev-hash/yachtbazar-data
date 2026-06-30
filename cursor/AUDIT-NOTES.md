# Crypto TV — Money-Path Security Model (one page)

Read before changing `server/token-bridge.js`, `server/token-http.js`, or `server/blackjack-server.js`.
These invariants were each hardened through adversarial review (the previous AI ran multi-agent "find a bug → try
to refute it" panels). The self-tests encode them — **keep them green and add to them.**

## The core invariants (do not break)

1. **A player can never lose more than they locked.** `settle()` floors `net` at `−lockedWei`
   (`token-bridge.js`), and the contract reverts if a win exceeds the house bankroll.

2. **One claimable settlement per on-chain lock.** This is the loss-escape defense (v12.34). The server records a
   per-player **obligation** (`pendingSettle`) the instant it signs ANY settlement for a lock, and **re-issues that
   same settlement** (same nonce) on every later recover/settle until the chain consumes it (checked via
   `bjNonceUsed(nonce)`). It never signs a fresh `net=0` while an unconsumed obligation exists. Without this, a
   player could settle a loss off-chain, withhold the broadcast, then "Recover" a `net=0` and reclaim the full
   principal. The re-issue **ignores attacker-supplied `contract`/`chainId`** (gated on the obligation's own nonce).

3. **Per-player mutex.** `withPlayerLock(player, …)` serializes `doSettle` / `doRelease` / `doAdminRelease` so two
   concurrent recovers can't each mint a distinct `net=0`.

4. **Provably fair.** Every token-`play()` bet is re-derivable from the revealed `serverSeed`. The verifier
   (`verifyRederive`) replays every bet and checks the ledger reconciles. Blackjack hands are recorded as
   `kind:"external"` entries that the token verifier counts in the ledger but does NOT re-derive — blackjack's
   fairness comes from its OWN shoe commit-reveal (`bj:reveal`), not the token seed.

5. **Token-funded blackjack — frozen funding pool (v12.36).** A real wallet's blackjack chips ARE its token
   session (`bank.get/credit/debit` route to the token ledger for a bound wallet). The binding is **frozen for the
   life of a hand**: `bindToken`/`unbindToken` refuse while `hasLiveHand(wallet)`, and an unbound real wallet can't
   bet. This guarantees a hand's debit and its win-credit hit the SAME session — without it, a player could bet
   unbound (play-money) then bind mid-hand to credit the on-chain session a win it never staked (over-credit). A
   token cash-out/recover is **refused while a hand is live** (`hasLiveExternal` guard). `applyExternal` bounds
   every adjustment (bet ≤ tokens, payout ≥ 0, tokens never negative).

6. **House-side rescue is safe.** `doAdminRelease` (owner-authed against the contract `owner()`/`treasury()`) signs
   a settlement that returns funds ONLY to the target player — the owner gains nothing, so it can't be abused.

## Reachability facts (so you don't re-discover them the hard way)
- `applyExternal` and `applyBlackjackNet` are **synchronous** — the get-check/debit has no TOCTOU **only while they
  stay synchronous.** If you ever make the token ledger async, re-add a lock or you open a double-spend.
- `settle()` sets `s.closed = true` **synchronously before** its first `await` (the signer), so a concurrent bet on
  a closing session throws `session is closed` — don't reorder this.
- With `ENABLE_TOKEN_BRIDGE` unset, every `/api/token/*` route returns 503, no session is ever minted, and all the
  token branches are dead — guest/demo play is byte-for-byte unaffected.

## Where the audit write-ups live
- Root `AUDIT-2026-06-29.md` — a broad pre-token audit.
- The previous AI's per-feature memory notes: `C:\Users\golde\.claude\projects\C--Users-golde-yacht-marketplace\memory\`
  (`token-recover-loss-escape.md`, `token-funded-blackjack.md`, `crypto-tv-token-mode-build.md`, …).
- Git history: `v12.34` (recover/loss-escape), `v12.36` (token-funded blackjack) commit messages summarize each.
