# Cursor Bug Hunt — Crypto TV (v12.39)

**Date:** 2026-06-30  
**Site audited:** https://tv-crypto-flip.onrender.com  
**Branch:** `claude/ethereum-betting-game-vrf-2dq50k` @ `09b1d18` (v12.39)  
**Method:** Parallel code audits (money paths, all games/bets, client UX, server modules) + automated test suite + module self-tests.

---

## Executive summary

Automated tests all pass (`npm test` 22/22; token-bridge, token-http, blackjack-server, crash-rounds self-tests OK). **The highest-risk issues are in the live crash-round token path** (Plane CH14, Balloon Pop CH13, Sky Swoop WS): nonce desync between round pacing and settlement, and stake not reserved until bust—both can let a player avoid losses or desync animation from payout math. **Token-mode UI gating** still keys off on-chain `gameWei` for Dice/Crash roll buttons and Plane balance polling, blocking or corrupting token play without touching server ledger integrity for most games.

**Games covered:** Coin Flip, Dice, Dice#2, Crash (instant), Plane/Balloon (crash rounds), Gem Vault (slots), Blackjack, Poker (client-only), Reef/Fish Table, Fish Shooter, Sky Swoop (demo), Plinko (on-chain only).

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Direct fund loss, exploitable payout bypass, or provably broken fairness on live token path |
| **High** | Major broken UX on token path, orphaned server state, or security hole if feature enabled |
| **Medium** | Incorrect behavior, desync, or reliability issues affecting play |
| **Low** | Polish, consistency, cache/version, demo-only gaps |

---

## Findings (most severe → least)

### 1. Critical — Crash rounds: nonce desync (peek vs settle)

**Games:** Plane Crash (CH14), Balloon Pop (CH13), Sky Swoop when using `CrashRounds` WebSocket  
**Not affected:** CH11 Crash (uses instant `TokenMode.bet`, not `crash-rounds.js`)

**Files:** `server/crash-rounds.js`, `server/token-bridge.js` (`pointPeek` vs `play`)

**Issue:** On `startRound()`, the server peeks the crash multiplier at the current `betNonce` but does **not** pin/reserve that nonce. If another token bet (`/api/token/play`) runs before the round settles, `betNonce` advances. Settlement calls `bridge.play()` at the **new** nonce, so the bust multiplier shown during the round can differ from the multiplier used to pay.

**Exploit sketch:** Start crash round (peek low bust at nonce N). Place a cheap bet elsewhere to advance to N+1. Cash out on a round paced for a low bust while settlement uses nonce N+1 (potentially higher bust / win).

**Fix direction:** Reserve nonce at round start (increment + store `roundNonce`), or call `play()` at round start and defer only display; block `pointPeek`-only pacing for production token rounds.

---

### 2. Critical — Crash rounds: stake not reserved; bust may not debit

**Games:** Same as #1 (Plane, Balloon Pop, CrashRounds WS)

**Files:** `server/crash-rounds.js`, `server/token-http.js`

**Issue:** Token stake is only debited inside `_resolve()` → `bridge.play()` at bust time. `doSettle` / `doRelease` do not treat active crash rounds as blocking (unlike blackjack `hasLiveExternal`). A player can cash out the token session mid-round or drain balance via parallel bets; on bust, `play()` throws (`insufficient tokens`, `session is closed`) **without recording the loss**.

**Fix direction:** Debit stake at bet placement (or hold/reserve in bridge); reject settle/release while `hasActiveRound(sessionId)`; wrap `_resolve()` in try/catch with recovery like blackjack `setT`.

---

### 3. High — Crash `_resolve()` marks settled before `play()` succeeds

**File:** `server/crash-rounds.js` (~lines 95–107)

**Issue:** Round is marked settled and maps cleared before `bridge.play()`. If `play()` throws, the round is orphaned and timer paths can throw uncaught exceptions. Same class of bug blackjack fixed with `setT` try/catch.

---

### 4. High — Token mode: Dice / Dice#2 / Crash roll buttons gated on `gameWei`

**File:** `public/app.js` — `diceReadouts()`, `twoDiceReadouts()`, `crashReadouts()` (~1921+)

**Issue:** Roll/bet controls require `gameWei >= betAmount` even in token mode. Token balance can be sufficient while buttons stay disabled.

**Fix:** Gate on `TokenMode.active && tokenBal >= cost` OR `gameWei >= cost` (mirror coin flip / slots patterns).

---

### 5. High — Token mode: Plane balance overwritten by `gameWei` poll

**File:** `public/app.js` — `refreshBalances()` (~1349–1357), 12s interval

**Issue:** During token sessions, periodic refresh sets Plane HUD from on-chain `gameWei` instead of token ledger. Does not call `syncTokenGameBalances()`.

**Fix:** Skip on-chain plane sync when `TokenMode.active`; use token balance for CH14/CH13 HUD.

---

### 6. High — Reef / Fish Shooter: optimistic fire without local debit (token)

**Files:** `public/fishtable.js`, `public/fishshooter.js`

**Issue:** Paid shots check balance then fire immediately; local balance is not decremented until the server responds. Rapid clicks can exceed true balance (server may reject; UX shows wrong balance; race on concurrent shots).

**Fix:** Decrement optimistically on fire (rollback on error), or disable fire until prior shot ack.

---

### 7. High — Poker hole cards visible client-side (if poker enabled)

**Files:** `public/poker-ui.js`, `server/poker-server.js` (exists but **not wired** in `server.js`)

**Issue:** Hole cards and deck state live in browser memory. `poker-server.js` is not mounted—poker is not production-safe if enabled without server authority.

**Status:** Latent; not on live money path today.

---

### 8. Medium — Gem Vault token spin updates balance before reel animation

**File:** `public/slots3d.js` — `_spinToken()`

**Issue:** Server result applied to displayed balance immediately; reels animate afterward. Confusing and reveals outcome early.

---

### 9. Medium — Blackjack token session binding fragile on client

**Files:** `public/app.js` (`ensureBlackjackReady`, `renderBjDock`), `public/blackjack.html`

**Issue:** v12.39 added `&r=` nonce reload and `#bjsession=` hash (good). Stale iframe / “Lock credits” UX still possible if user skips reconnect flow. Server-side token blackjack is sound when session matches.

---

### 10. Medium — Blackjack iframe cache version skew

**Files:** `public/app.js` (~3414), `public/blackjack.html`

**Issue:** Shell loads `?v=1239`, iframe may load `v=1238`, felt scripts `v=1197–1198`. Split-brain JS after deploys.

**Fix:** Single `BUILD_VERSION` constant threaded through all blackjack assets.

---

### 11. Medium — BETBAR enrolled but no slider mapping

**File:** `public/app.js` — `BETBAR_GAMES` vs `BETBAR_SL`

**Issue:** Fish Shooter and Sky Swoop listed in BETBAR games but missing from slider map—bet bar may not adjust stakes correctly.

---

### 12. Medium — Dice / Dice#2 TV layer desync on reload

**File:** `public/app.js` (session restore)

**Issue:** Restore calls `ensureDice3dReady()` but not always `TV.changeChannel()` / channel idle—inconsistent TV state after refresh.

---

### 13. Medium — Unguarded DOM access in TV reveal paths

**File:** `public/tv.js`

**Issue:** Some reveal/animation paths call `.classList` on elements that may be null if layer not mounted—can throw mid-animation.

---

### 14. Medium — Guest blackjack persist failures silent

**File:** `server/server.js` (`bjPersist.save`)

**Issue:** Persist errors swallowed vs loud logging on token bridge—harder to diagnose guest session loss.

---

### 15. Medium — Connected wallet + play-money games still use demoUsd

**File:** `public/app.js` — `exitDemo()`

**Issue:** Demo chrome hidden when wallet connected but balance still `demoUsd` for non-token games—confusing “real wallet, play money” UX.

---

### 16. Low — Fish / Fish Shooter min bet $1 vs $10 elsewhere

**Files:** `public/fishtable.js`, `public/fishshooter.js`, bet bar defaults

**Issue:** Inconsistent minimum stake vs other channels.

---

### 17. Low — Sky Swoop demo-only (no token path)

**File:** `public/skyswoop.js`, crash-rounds integration

**Issue:** Documented gap; not exploitable but incomplete product surface.

---

### 18. Low — Legacy experimental blackjack bridge code in app.js

**File:** `public/app.js`

**Issue:** Dead/alternate code paths should stay disabled; clutter and foot-gun if re-enabled without review.

---

### 19. Low — Service worker registered without cache-bust on `sw.js`

**File:** `public/app.js` (SW registration)

**Issue:** Browser may keep old SW; stale asset routing after deploys.

---

### 20. Low — SW cache-first on `?v=` assets → split-brain deploys

**Issue:** Combined with #10/#19, users can load mismatched shell + game scripts until hard refresh.

---

## Per-game test matrix

| Game / channel | Demo | On-chain | Token | Automated tests | Notes |
|----------------|------|----------|-------|-----------------|-------|
| Coin Flip CH10 | ✓ | ✓ | ✓ | `CoinFlipBetting.test.js` | OK |
| Dice CH15 | ✓ | ✓ | ⚠ UI | Registry tests | Roll gated on gameWei (#4) |
| Dice#2 CH16 | ✓ | ✓ | ⚠ UI | Registry tests | Same as Dice |
| Crash CH11 (instant) | ✓ | ✓ | ⚠ UI | token-bridge | Instant path OK; UI #4 |
| Plane CH14 | ✓ | — | 🔴 | crash-rounds self-test | #1 #2 #3 |
| Balloon CH13 | ✓ | — | 🔴 | crash-rounds self-test | #1 #2 #3 |
| Gem Vault CH17 | ✓ | ✓ | ⚠ UX | Manual audit | #8 |
| Blackjack CH18 | ✓ | — | ⚠ UX | blackjack-server self-test | #9 #10 |
| Poker | ✓ | — | — | poker-engine unit | Not server-wired (#7) |
| Reef / Fish Table | ✓ | — | ⚠ | Manual | #6 |
| Fish Shooter | ✓ | — | ⚠ | Manual | #6 #11 |
| Sky Swoop | ✓ demo | — | — | Manual | #17 |
| Plinko | — | ✓ | — | Manual | On-chain only |

Legend: ✓ OK · ⚠ issue · 🔴 critical path bug · — not offered

---

## Commands run (all passed at audit time)

```bash
npm test
node server/token-bridge.js      # SELF-TEST OK
node server/token-http.js        # SELF-TEST OK
node server/blackjack-server.js  # SELF-TEST OK
node server/crash-rounds.js      # SELF-TEST OK
node server/crash-rounds-ws.js   # SELF-TEST OK
node public/token-client.js      # SELF-TEST OK
```

**Note:** Crash-rounds self-tests do not cover interleaved nonce adversarial scenarios (#1).

---

## Recommended fix priority

1. **P0:** Crash rounds nonce pin + stake reserve + `_resolve` error handling (#1–#3)  
2. **P1:** Token UI gating for Dice/Crash + Plane balance poll (#4–#5)  
3. **P1:** Fish shooters optimistic debit (#6)  
4. **P2:** Blackjack version sync, BETBAR mapping, TV null guards (#9–#13)  
5. **P3:** Polish (#14–#20)

---

## Audit agents (parallel)

- Money path & token bridge / crash-rounds / blackjack server  
- All games & bet surfaces (client + registry)  
- Server modules & HTTP/WS handlers  
- Client UX, SW/cache, session restore  

Report consolidated into this file for handoff.
