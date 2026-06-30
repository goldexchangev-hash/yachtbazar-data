# Cursor Bug Hunt — Crypto TV (v12.39)

**Date:** 2026-06-30 (expanded pass)  
**Site audited:** https://tv-crypto-flip.onrender.com  
**Branch:** `claude/ethereum-betting-game-vrf-2dq50k` @ `09b1d18` (v12.39)  
**Build:** `?v=1239`, `ctf-v12.39`

---

## Methodology (second pass)

Four parallel deep audits plus live repro:

| Pass | Scope |
|------|--------|
| Money paths | `token-bridge.js`, `token-http.js`, crash-rounds, blackjack-server, settle/release races |
| All game clients | `app.js`, every canvas game, `tv.js`, token-mode, session restore |
| Server security | WS hub auth, input validation, persistence, env flags, buy-in replay |
| Tests + repro | `npm test`, all module self-tests, adversarial nonce script |

**Repro script (confirmed):** `node CursorBugHunt/repro-crash-nonce-desync.js` — exits 1 when pacing nonce ≠ settlement nonce.

---

## Executive summary

All automated tests pass (`npm test` 22/22; module self-tests OK), but **self-tests do not cover adversarial interleaving**. The token crash-round WebSocket path (Plane CH14, Balloon Pop CH13) has **three chained critical bugs**: nonce desync, unstaked rounds, and settle-before-play ordering. A **buy-in txHash replay race** on `/api/token/start` can grant double tokens from one on-chain deposit.

Client-side, token mode is inconsistently wired: affordability guards, `spendableUsd()`, and Plane mode switching still lean on on-chain `gameWei` in several paths. Demo/play-money games diverge from the header balance when a wallet is connected.

**35 findings** below, ordered by severity.

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Exploitable fund loss, double-credit, or provably broken fairness |
| **High** | Broken token UX, orphaned server state, latent security if feature enabled |
| **Medium** | Desync, reliability, DoS, or economic edge cases |
| **Low** | Polish, cache/version skew, demo-only gaps |

---

## Findings (most severe → least)

### 1. Critical — Crash rounds: nonce desync (peek vs settle) **[REPRODUCED]**

**Games:** Plane (CH14), Balloon Pop (CH13), Sky Swoop via `CrashRounds` WS  
**Not affected:** CH11 Crash (instant HTTP `TokenMode.bet`)

**Files:** `server/crash-rounds.js:41-54,95-102`, `server/token-bridge.js:110-138,292-301`

**Issue:** `startRound()` calls `pointPeek()` at `betNonce` N without reserving N. Interleaved `/api/token/play` advances the nonce. `_resolve()` → `bridge.play()` settles at N+k with a different crash point than animation pacing.

**Repro:** `node CursorBugHunt/repro-crash-nonce-desync.js`

**Fix:** Pin nonce + reserve stake at `cr:start`; or call `play()` at round start with display-only deferral.

---

### 2. Critical — Crash rounds: stake not reserved; bust may not debit

**Files:** `server/crash-rounds.js:95-102`, `server/token-http.js:379,423`, `server/server.js:164`

**Issue:** Stake debited only at bust in `_resolve()`. `hasLiveExternal()` checks blackjack only — not active crash rounds. Player can drain balance or settle/release mid-round; `play()` throws without recording loss.

**Combined exploit:** Buy in 100 tokens → start Plane round bet 100 → spend 60 on fish → bust → `insufficient tokens` → **40 tokens of loss avoided**.

**Fix:** Debit/reserve at `cr:start`; extend `liveExternal()` to crash rounds.

---

### 3. Critical — Settle/release allowed during live WS crash round

**Files:** `server/token-http.js:377-389,421-437`, `server/crash-rounds.js:95-102`

**Issue:** `doSettle`/`doRelease` only block on `hasLiveHand` (blackjack). Closing session mid-flight causes `_resolve()` → `play()` to throw `"session is closed"` with same loss-escape behavior as #2.

**Fix:** `if (crashRounds.hasActive(sessionId)) throw` before settle/release.

---

### 4. Critical — Buy-in txHash replay race (double session / double tokens)

**Files:** `server/token-http.js:275-313,340-368`  
**Contrast:** `server/bridge-server.js:240-241` uses `pendingBuyIns` — token HTTP does not.

**Issue:** `doStart`/`doTopUp` check `usedBuyIns`, then **await slow RPC** `verifyBuyIn()`, then add txHash. Two concurrent requests with the **same** `txHash` can both pass the check and grant two sessions from one buy-in.

**Fix:** Add `pendingBuyIns` set (mark before RPC) or wrap `doStart`/`doTopUp` in `withPlayerLock`.

---

### 5. Critical — Plane stays in demo/real mode after token buy-in

**Files:** `public/app.js:640,3001-3005`, `public/plane-ui.js:340-389,489-508`

**Issue:** `TokenMode.onChange` → `syncTokenGameBalances()` updates balance but **not** `planeGame.setMode("token")`. Entering Plane before buy-in leaves demo/real logic running while HUD shows token balance. Demo mode debits locally without server round.

**Repro:** Open Plane (demo) → buy token session → launch without re-entering channel.

**Fix:** On token session open: `planeGame.setMode("token")` (+ pressure); reverse on cash-out.

---

### 6. High — `_resolve()` marks settled before `play()` succeeds

**File:** `server/crash-rounds.js:95-107`

**Issue:** `round.settled = true` and `activeBySession.delete()` before `bridge.play()`. Failed `play()` orphans round; bust timer can throw uncaught (`server/server.js:185`).

**Fix:** Try/catch with rollback; commit only after successful `play()` (mirror blackjack `setT`).

---

### 7. High — No balance check at `cr:start`

**Files:** `server/crash-rounds-ws.js:81-101`, `server/crash-rounds.js:41-47`

**Issue:** Round starts after auth only — no token balance read. `betUnits=100` with 5 tokens runs until `_resolve()` fails.

**Fix:** Verify `session.tokens >= betUnits` and reserve at start.

---

### 8. High — HTTP instant crash + WS live crash on same session

**Files:** `public/app.js:3242-3253`, `server/crash-rounds.js:38-44`

**Issue:** CH11 Crash uses HTTP `TokenMode.bet("crash")`. Plane/Balloon use WS `CrashRounds`. HTTP bets during active WS round advance nonce (#1) and spend unreserved stake (#2). Only second WS start is blocked.

**Fix:** Reject `/api/token/play` while `activeBySession.has(sessionId)`.

---

### 9. High — Token affordability gated on `gameWei` (not token balance)

**Files:** `public/app.js`  
- `diceReadouts`: ~1925  
- `twoDiceReadouts`: ~2025  
- `crashReadouts`: ~2136  
- `slotsReadouts`: ~2230  
- `spendableUsd()`: ~317-319 (ignores tokens except play-money game list)

**Issue:** Roll/spin buttons disabled when `stakeWei > gameWei` even with funded token session. `spendableUsd()` returns `gameWei` for non-demo games — ½/2×/Max quick-bet wrong in token mode.

**Fix:** If `TokenMode.active()`, use `TokenMode.tokens()` for all affordability checks.

---

### 10. High — Plane balance poll overwrites token HUD

**File:** `public/app.js:1349-1357` (12s `refreshBalances`)

**Issue:** `planeGame.setBalance(weiToUsd(gameWei))` with no `TokenMode.active()` guard. Clobbers token balance synced by `syncTokenGameBalances()`.

---

### 11. High — Fish / Reef optimistic fire (unbounded in-flight bets)

**Files:** `public/fishshooter.js:374-441`, `public/fishtable.js:322-335`, `public/token-client.js:130-137`

**Issue:** Token shots fire async without local debit or in-flight cap. Rapid clicks exceed balance before server rejects. Fish Shooter manual taps bypass cooldown.

**Fix:** Optimistic debit + rollback on error, or cap in-flight count.

---

### 12. High — Out-of-order token responses corrupt displayed balance

**Files:** `public/token-client.js:136`, `public/fishshooter.js:430-431`

**Issue:** Each `play` response sets `this.tokens = r.tokens` unconditionally. Stale response can overwrite newer lower balance (last-write-wins).

**Fix:** Monotonic sequence or ignore stale responses.

---

### 13. High — Plane / Pressure optimistic local debit before server ack

**Files:** `public/plane-ui.js:350-352`, `public/pressure-ui.js:242`, `public/crash-rounds-client.js:85`

**Issue:** Client debits stake before `cr:start` ack. WS timeout refunds locally while server may have started round → relaunch blocked or double-spend attempt.

---

### 14. High — CrashRounds singleton blocks all crash-family launches

**Files:** `public/crash-rounds-client.js:74-75,97-103`, `public/app.js:4476-4481`

**Issue:** One global `CrashRounds` for plane + balloon. `start()` rejects if `live`. Slow/disconnected round holds lock up to 120s — no token crash launch anywhere.

---

### 15. High — Sky Swoop: in-flight round frozen on channel leave

**Files:** `public/swoop3d.js:299-300,399-409,524-533`, `public/app.js:3079-3093`

**Issue:** `launch()` debits stake. `setActive(false)` pauses `_update` (`if (!this._active) return`) without refund. `demoReset()` restarts plane/pressure/slots/fish but **not** swoop. Stake locked until user returns.

---

### 16. High — Wallet connected + play-money games: header vs canvas balance diverge

**Files:** `public/app.js:3052-3074,2936-2942,2507-2511`

**Issue:** After `exitDemo()`, Gem Vault / Balloon / Reef / Fish Shooter use `demoUsd` but `#game-balance` shows on-chain `gameWei`. User sizes bets from wrong number.

---

### 17. High — Gem Vault token: no final `r.tokens` resync after spin/bonus

**Files:** `public/slots3d.js:281-314,381-404`

**Issue:** `_spinToken` debits locally and replays wins via client `E.evaluate`, assuming byte-for-byte server parity. Only resets to `TM.tokens()` on **error**. Rounding/bonus drift leaves HUD ≠ ledger until next bet.

**Fix:** Apply `r.tokens` at end of spin and `_endBonus`.

---

### 18. High — `doStart` lacks per-player mutex (concurrent dual sessions)

**Files:** `server/token-http.js:275-313`, `server/token-bridge.js:88-108`

**Issue:** `withPlayerLock` protects settle/release but not `doStart`. Two concurrent starts with different txHashes can both pass `openByPlayer.has()` before either sets it.

**Fix:** Wrap `doStart`/`doTopUp` in `withPlayerLock`.

---

### 19. High — Poker hole cards client-side (latent)

**Files:** `public/poker-ui.js`, `server/poker-server.js` (unwired in `server.js`)

**Issue:** Deck and opponent holes in browser. `poker-server.js` exists with masking but never attached. Exploitable if poker enabled for real money.

---

### 20. High — WebSocket `hello` allows address impersonation (chat/presence)

**File:** `server/server.js:269-299`

**Issue:** Any connection sends `hello` with arbitrary `address` — no signature. Used for chat, bet proposals, player counts. Blackjack spending is gated separately; social layer is not.

---

### 21. Medium — Channel switch during token plane round — promise resolves off-channel

**Files:** `public/plane-ui.js:364-388,455-468`, `public/pressure-ui.js:254-261`

**Issue:** `setActive(false)` triggers cash-out but `_tokenEpoch` not bumped. `.then` handler can update state/messages on wrong channel.

---

### 22. Medium — `switchGame` unlocks balance before TV animation ends

**Files:** `public/app.js:3297-3301`, `public/tv.js:586-587`

**Issue:** Intentional anti-freeze, but switching during dice/crash/flip reveal unlocks balance while old animation may still show.

---

### 23. Medium — On-chain bets refresh balance before TV reveal completes

**Files:** `public/app.js` — `doPlayDice`, `doPlayTwoDice`, `doPlayCrash`, `doPlaySlots`

**Issue:** `refreshBalances()` called immediately after starting async `TV.reveal*`. `revealLock` holds display but `gameWei` cache updates instantly.

---

### 24. Medium — Gem Vault token spin reveals balance before reel animation

**File:** `public/slots3d.js:286-287`

**Issue:** Local balance debited and HUD updated before reels land (related to #17).

---

### 25. Medium — Blackjack token session binding fragile on client

**Files:** `public/app.js:3393-3478`, `public/blackjack.html`

**Issue:** v12.39 `&r=` nonce reload helps. Stale iframe / “Lock credits” UX still possible. Server-side OK when session matches.

---

### 26. Medium — Blackjack iframe version skew (split-brain deploy)

| Asset | Version |
|-------|---------|
| Shell / lazy loads | `1239` |
| Blackjack iframe (`app.js`) | `1238` |
| Felt scripts (`blackjack.html`) | `1197–1198` |

**Risk:** Shell at 1239 loads felt JS at 1197 — protocol/UX bugs after deploy.

---

### 27. Medium — BETBAR enrolled but no slider mapping

**File:** `public/app.js` — `BETBAR_GAMES` includes `fishshooter`, `swoop`; `BETBAR_SL` has no entries for them.

---

### 28. Medium — Dice / Dice#2 TV layer desync on page reload

**File:** `public/app.js` (session restore)

**Issue:** Restore calls `ensureDice3dReady()` but not always `TV.changeChannel()` — inconsistent TV idle state.

---

### 29. Medium — Unguarded `.classList` in TV reveal paths

**File:** `public/tv.js`

**Issue:** Reveal paths can call `.classList` on null layer if not mounted — throws mid-animation.

---

### 30. Medium — Guest blackjack / BJ bank persist failures silent

**Files:** `server/server.js:66-68`, `server/token-bridge.js:69`

**Issue:** `bjPersist.save` swallows errors. Token persist logs throttled failures. Restart can lose guest balances quietly.

---

### 31. Medium — Unbounded `clientSeed` on `/api/token/play` (CPU DoS)

**Files:** `server/token-bridge.js:121`, `server/token-http.js:321`

**Issue:** No max length on `clientSeed`. Megabyte seeds burn HMAC CPU per play.

**Fix:** Cap at ~256 bytes.

---

### 32. Medium — No rate limit on buy-in / RPC-heavy endpoints

**Files:** `server/token-http.js:628-634`

**Issue:** `/api/token/play` has token bucket (30/s). `/start`, `/topup`, `/release` have no per-IP limit. Each start = multiple RPC calls (12s timeout).

---

### 33. Medium — WS chat/broadcast spam (no rate limit)

**File:** `server/server.js:221-225,309-319`

**Issue:** Any `hello` client can flood 240-char chat to all connections.

---

### 34. Medium — Reef `power` param not clamped (unlike fishshooter)

**Files:** `server/games/reef.js:135`, `server/games/fishshooter.js:168-170`

**Issue:** Fishshooter clamps power 1..2; reef accepts arbitrary power affecting kill probability.

---

### 35. Medium — Pressure void below 1.20× returns full stake

**File:** `server/games/pressure.js:109-119`

**Issue:** Targets below `MIN_CASHOUT` refund stake (net 0). Minor EV skew vs 3% edge on intentional plays.

---

### 36. Medium — Multi-instance token ledger (if horizontally scaled)

**Files:** `server/token-http.js:258-273`, `server/token-bridge.js:67`

**Issue:** In-memory ledger + per-process rate limits. Multiple workers without sticky sessions → balance races.

---

### 37. Medium — `/api/token/house-state` exposes aggregate exposure (no auth)

**File:** `server/token-http.js:554-577`

**Issue:** Open sessions, locked wei, unrealized P&L readable by anyone when bridge enabled.

---

### 38. Medium — Poker pool uses `gameWei` only (ignores token mode)

**Files:** `public/app.js:3699-3710`, `public/poker-ui.js`

**Issue:** If poker re-enabled, buy-ins pull ETH credits not tokens during token session.

---

### 39. Low — Fish / Fish Shooter min bet $1 vs $10 elsewhere

**Files:** `public/fishtable.js`, `public/fishshooter.js`

---

### 40. Low — Sky Swoop demo-only; max $1000 vs shell $500 cap

**File:** `public/swoop3d.js` — no token path; `MAX_BET` higher than `HARD_MAX_USD`.

---

### 41. Low — Plane engine default 3% house edge vs server 1%

**Files:** `public/plane-engine.js`, `public/plane-ui.js` defaults vs `app.js` `CRASH_EDGE=0.01`

**Issue:** Wrong only if Plane constructed without app opts (standalone/demo path).

---

### 42. Low — Legacy Crypto Reels (CH12) orphaned in code

**Files:** `public/app.js:2212-2927`, `public/tv.js:721-747` — no channel in `index.html`.

---

### 43. Low — WS crash `cr:start`/`cr:cashout` unrate-limited

**File:** `server/crash-rounds-ws.js:73-116`

---

### 44. Low — Session bearer in query string (`GET /api/token/session?sessionToken=…`)

**Files:** `server/token-http.js:627`, `public/token-client.js:80,96` — browser history / proxy logs.

---

### 45. Low — Service worker registered without cache-bust

**File:** `public/app.js:5243` — `"sw.js"` unversioned.

---

### 46. Low — SW cache-first on `?v=` assets → split-brain deploys

**File:** `public/sw.js` — stale `app.js?v=1239` can serve alongside fresh HTML referencing `?v=1240`.

---

### 47. Low — Experimental blackjack bridge weaker persistence

**File:** `server/bridge-server.js:40-48` — no fsync/readback vs `writeJsonAtomic`; `BRIDGE_STATE_FILE` not in `render.yaml`.

---

### 48. Low — Invalid fish target debits stake for zero payout

**Files:** `server/games/fishshooter.js:178-187`, `server/games/reef.js:139-147` — UX footgun.

---

## Per-game test matrix

| Game / CH | Demo | On-chain | Token | Tests | Status |
|-----------|------|----------|-------|-------|--------|
| Coin Flip CH10 | ✓ | ✓ | ✓ | CoinFlipBetting.test | OK |
| Dice CH15 | ✓ | ✓ | ⚠ | Registry | UI #9 |
| Dice#2 CH16 | ✓ | ✓ | ⚠ | Registry | UI #9 |
| Crash CH11 instant | ✓ | ✓ | ⚠ | token-bridge | OK server; UI #9; interleave #8 |
| Plane CH14 | ✓ | — | 🔴 | crash-rounds self-test | #1–#8, #5, #10, #13–#14 |
| Balloon CH13 | ✓ | — | 🔴 | crash-rounds self-test | #1–#8, #13–#14 |
| Gem Vault CH17 | ✓ | ✓ | ⚠ | slots3d engine | #17, #24 |
| Blackjack CH18 | ✓ | — | ⚠ | blackjack-server | #25–#26 |
| Poker | ✓ | — | — | poker-engine (client) | #19, #38 latent |
| Reef / Fish Table | ✓ | — | ⚠ | reef engine | #11, #34, #39 |
| Fish Shooter | ✓ | — | ⚠ | fishshooter engine | #11, #12, #27, #39 |
| Sky Swoop | ✓ | — | — | none | #15, #40 |
| Crypto Reels CH12 | dead | — | — | none | #42 orphaned |
| Plinko | — | on-chain only | — | none | not in client |

---

## Bet limit / house edge inconsistencies

| Layer | Min | Max | Edge | Notes |
|-------|-----|-----|------|-------|
| On-chain contract | 0.0001 ETH | 1 ETH | Flip 3%, Dice 2%, Crash 1% | Authoritative |
| Client shell | $10 | $500 | Crash 1% | `HARD_MAX_USD` |
| Plane (via app) | $10 | $500 | 1% | Correct |
| Plane engine default | $10 | — | **3%** | If no opts |
| Pressure / Balloon | $10 | $500 | 3% | Aligned |
| Gem Vault 3D | $10 | $500 | ~5% | Server RTP ~94.5% |
| Reef / Fish | **$1** | $50 | ~15% RTP/shot | Outlier min |
| Fish Shooter power | — | ×2 cap | — | Reef allows ×7 |
| Sky Swoop | $10 | **$1000** | 1% | Exceeds shell cap |
| Blackjack | $10 | balance/5 | — | Server `minBet: 10` |

---

## Test coverage gaps

| Area | Covered | Gap |
|------|---------|-----|
| Hardhat contracts | 22 tests | No server integration |
| Token bridge self-test | 36 checks | No txHash concurrent start |
| Token HTTP self-test | 50 checks | No crash-round interleave |
| Crash rounds self-test | 8 checks | **No nonce pin, stake reserve, parallel bet** |
| Crash rounds WS | 11 checks | No adversarial interleave |
| Client (`app.js`, games) | **none** | Token UI, mode switch, Swoop |
| `server.js` WS hub | **none** | hello impersonation, chat flood |
| `bridge-server.js` | **none** | Off by default |
| `poker-server.js` | self-test only | Not in npm test |
| E2E / browser | **none** | SW, deploy skew, wallet flows |
| Adversarial repro | `CursorBugHunt/repro-crash-nonce-desync.js` | **Confirms #1** |

---

## Commands run (all passed except adversarial repro)

```bash
npm test                                    # 22 passing
node server/token-bridge.js                 # SELF-TEST OK
node server/token-http.js                   # SELF-TEST OK
node server/blackjack-server.js             # SELF-TEST OK
node server/crash-rounds.js                 # SELF-TEST OK (happy path only)
node server/crash-rounds-ws.js              # SELF-TEST OK
node public/token-client.js                 # SELF-TEST OK
node CursorBugHunt/repro-crash-nonce-desync.js  # exit 1 — BUG REPRODUCED
```

---

## Recommended fix priority

| P | Items | Action |
|---|-------|--------|
| **P0** | #1–#4 | Crash: pin nonce, reserve stake, transactional `_resolve`, block settle during rounds; `pendingBuyIns` + `withPlayerLock` on start |
| **P0** | #5 | `setMode("token")` on buy-in for plane/pressure |
| **P1** | #6–#8, #18 | Balance check at start; block HTTP play during WS round; start mutex |
| **P1** | #9–#12 | Token-aware UI; in-flight bet caps; monotonic balance |
| **P2** | #13–#17, #21–#29 | Client desync, Swoop refund, slots resync, version sync |
| **P2** | #31–#37 | Rate limits, input caps, reef power clamp |
| **P3** | #39–#48 | Polish, cache, demo gaps |

---

## Well-hardened areas (no new issues)

- Buy-in cross-session drain guard (`eventLocked`)
- Loss-escape / `pendingSettle` with per-player mutex on settle/release
- Transactional engine-first bet reject in `play()`
- Settle idempotency (`if (s.settlement) return`)
- Blackjack real-wallet auth + token bind/freeze mid-hand
- Atomic JSON persist for token/BJ on mounted disk
- Crash WS cash-out ownership check
- ServerSeed never leaked pre-settle

---

## Audit agents (parallel passes)

1. Money paths & token bridge / crash-rounds  
2. All game clients & bet surfaces  
3. Server security, WS, persistence, buy-in  
4. Tests, repro scripts, bet-limit audit  

Report consolidated in this directory for handoff.
