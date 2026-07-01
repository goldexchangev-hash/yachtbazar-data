# Cursor Bug Hunt v3 — Crypto TV (v12.50) — Pass 6

**Date:** 2026-06-30  
**Site:** https://tv-crypto-flip.onrender.com  
**Branch:** `claude/ethereum-betting-game-vrf-2dq50k` @ `8e3c196`  
**Build:** `?v=1250`, `ctf-v12.50`  
**Prior audits:** `CursorBugHunt/REPORT.md` (v1), `CursorBugHunt-v2/REPORT.md` (v2)  
**Coordination:** `AGENTS.md` (Claude ⇄ Cursor hub on deploy branch)

---

## Methodology — Pass 6 (deepest scan to date)

| Stream | Agents / tools | Scope |
|--------|----------------|-------|
| **0** | Version check | Live `?v=1250` vs repo; `AGENTS.md` crosswalk |
| **1** | Money paths | `token-bridge`, `token-http`, `crash-rounds`, persist, recover |
| **2** | Blackjack deep-dive | `blackjack-server`, token bind, dealing-leave, applyNet |
| **3** | Client + all games | `app.js`, all game UIs, channel lifecycle, token UX |
| **4** | Contracts + on-chain | `contract.js`, staticCall removal, V2 deploy gap, `pass4-exploits` |
| **5** | Chaos + persistence | batchWrite, SIGTERM drain, obligation branches |
| **6** | PvP / wallet / ops | WS relay, rate limits, security headers, admin APIs |
| **7** | Live site probe | Fetch live assets; drift vs repo |
| **8** | Regression crosswalk | Re-verify v1/v2 fixes on **committed** code (`git show HEAD:`) |

**Rule (from AGENTS.md):** Verify against committed code, not agent working trees. Hunt agents read-only.

### Probe gate (v12.50 run)

```bash
node CursorBugHunt-v2/crash-reserve-probe.js          # PASS
node CursorBugHunt-v2/crash-liveness-probe.js         # PASS
node CursorBugHunt-v2/adversarial-suite-v2.js       # PASS (0 findings)
node CursorBugHunt-v3/crash-bj-interleave-probe.js    # FAIL — #1 reproduced
node CursorBugHunt/settlement-math-probe.js           # 6 hits — STALE sub-cent math (#52)
node CursorBugHunt/slots3d-parity-probe.js            # evaluate OK; demo grid deriv differs
node server/token-bridge.js && node server/token-http.js && node server/crash-rounds.js
npm test                                              # 29/29 pass
npx hardhat test test/pass4-exploits.test.js          # 6/7 pass (1 flaky crash assert)
```

**Obsolete probes:** `CursorBugHunt/repro-crash-nonce-desync.js`, v1 adversarial crash sections — test old `pointPeek+play` API.

---

## Executive summary

**~58 active findings** (#1–#58). v12.50 closed the major v1/v2 money-path wave (reserve, txHash races, recover, client Wave 3). **Probe gate is green** except the new WS/BJ gap.

### Top risks (new or still open)

1. **#1 — `cr:start` WebSocket bypasses live-blackjack guard** — HTTP `doPlay` blocked; WS crash start is not. Can drain token pool mid-hand → BJ stuck.
2. **#2 — No HTTP security headers** — CSP, HSTS, frame denial missing; clickjacking / XSS amplification.
3. **#3 — WS `hello` identity spoofing** — any address without signature; chat/presence impersonation.
4. **#4 — V2 contract not deployed** — production still V1 `bjLocked` global; artifact has `_betGuard` but not per-session locks.
5. **#5 — On-chain `eth_call` cherry-pick** — client staticCall removed; contract still returns outcomes to EOAs.
6. **#6 — BJ `applyNet` failure not surfaced** — token win logged server-side, client shows win, ledger may not credit.
7. **#7 — `tokenSlots` concurrent bets** — `lockReveal()` after await; double-click fires parallel stakes.
8. **#8 — Plane↔Pressure channel switch** — epoch guard drops `cr:result` balance sync.

### Verified fixed (do not re-file without regression proof)

Reserve/nonce-pin, txHash races, recover loss-escape, crash liveness on HTTP, SIGTERM drain, sub-cent settle, staticCall removed from app.js, client Wave 3 (#11–#14), Wave 0 hotfixes (#204, #193), `contract.js` `_betGuard`/`paused` regen. See **Regression crosswalk** below.

---

## ✅ v3 FIXES LANDED (Claude, v12.51 → v12.54)

Every finding below was VERIFIED against committed code (read-only agent pass + `git show HEAD:`) before fixing.
Money-path fixes are probe-gated. Deploys are incremental (one version per wave) — full probe gate green after each.

| Wave / ver | Findings | Status |
|------------|----------|--------|
| **0 — v12.51** | #1 WS cr:start vs live-BJ gate, #2 HTTP security headers, #7 tokenSlots lock-before-bet | ✅ shipped + live; `crash-bj-interleave-probe.js`, `security-headers-probe.js` green |
| **1 — v12.52** | #10 release expiry anti-replay, #11 per-IP rate limit, #12 doSettle verify-first, #20 owner-authed house-state, #21 session POST, #48 verifySession !closed, #9/#22 WS rate limit, #32 fault-drain, #36 two-tab unbind, #37/#38 dual-source ETH/USD, #41 integer-cent overbet | ✅ shipped + live; `wave1-auth-probe.js` (11 checks) green |
| **2 — v12.53** | #6 BJ applyNet→client, #13 doRelease signer-outage limbo (loss-escape closed), #34 dropSeat insurance, #15 revealLock cleanup, #18 crash-family switch cancel, #19 resume() tri-state, #24 postMessage origin, #25 bjReload mid-hand guard, #47 pressure round-scoped token flag | ✅ shipped + live; `wave2-money-probe.js` (#13) green |
| **4 — v12.54** | #17 dead reef chain-budget, #26 betbar fishshooter/swoop, #39 lazy `?v=` synced, #40 share CH16–19, #50 de-flaked 3 on-chain PoCs, #52 stale probe banner | ✅ shipped + live |
| **3 — (source)** | #28 GameRegistry zero-guard, #27 PvP `forceCloseStaleRoom` + test | ✅ source committed (hardhat 32/32 green); **awaits owner V2 deploy** — artifact NOT regenerated (#31) |

**Verified non-bugs (documented, no change):** #3 (display-spoof — money-safe, rate-limited), #8 (plane epoch guard correct — pre-guard balance write would reintroduce a stale-write race), #14/#30/#33/#46/#51/#53/#54 (stale / already-fixed / false-positive), #16 (cosmetic — balance authoritative), #23 (drain is player-favorable + safe), #44 (dice independent to ~2⁻²⁵¹), #45 (instant-settle is intentional design).

**OWNER-ONLY (deploy / wallet — neither AI can do):** #4 deploy `CoinFlipBettingV2` (+ regen artifact + registry pointer, atomically per #31), #5 commit-reveal/VRF migration, #29 fee-accounting policy, #42/#43 RNG & EOA-guard strategic calls, wallet E2E smoke-test.

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Exploit / total breakage / major security gap |
| **High** | Real-money desync, auth bypass surface, or systematic loss |
| **Medium** | Reliability, DoS, UX money confusion |
| **Low** | Polish, demo-only, cosmetic, owner-only |

---

## All findings (most severe → least)

### Critical

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **1** | **`cr:start` WS bypasses `liveExternal` BJ guard** | `crash-rounds-ws.js:81-101`, `server.js:222` | HTTP `doPlay`/`doTopUp` refuse during live BJ hand; WS `start()` calls `rounds.startRound()` with no `liveExternal` check. `reserve()` debits crash stake mid-hand → `applyExternal` throws → hand stuck. **Repro:** `CursorBugHunt-v3/crash-bj-interleave-probe.js` |
| **2** | **No HTTP security headers** | `server/server.js:29-38` | No CSP, HSTS, `X-Frame-Options`, `nosniff`. Wallet origin vulnerable to clickjacking and injected script if any asset compromised. |

### High

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **3** | WS `hello` accepts any address without proof | `server/server.js:344-374` | Spoof wallet in chat, player roster, bet-proposal attribution. BJ money paths use bearer tokens (safe); social/engineering risk high. |
| **4** | V2 per-session locks not deployed | `contract.js`, `CoinFlipBettingV2.sol` | ABI still V1 `bjLocked`/`settleBlackjack`. Cross-session drain PoC in `pass4-exploits.test.js`. Owner registry deploy required. |
| **5** | On-chain outcome readable via `eth_call` (EOA) | `CoinFlipBetting.sol`, tests | Client previews removed (v12.50); contract return values still simulate-able. `_betGuard` blocks contracts only. |
| **6** | BJ token credit silently dropped on `applyNet` throw | `blackjack-server.js:109-117` | Server logs error; client shows win; token bar unchanged. AGENTS.md still lists open. |
| **7** | `tokenSlots` concurrent bets — lock after await | `app.js:3301-3309` | `lockReveal()` runs after `TokenMode.bet()` returns; rapid clicks fire parallel HTTP plays. |
| **8** | Plane↔Pressure switch drops `cr:result` balance sync | `plane-ui.js:365`, `app.js:2406` | Epoch bump on channel leave causes `.then` to ignore authoritative `res.tokens`. |
| **9** | No WS per-connection rate limit — broadcast DoS | `server/server.js:296-420` | Flood `hello`/`chat`/`rooms-updated` → O(clients²) deliveries + RPC storms on clients. |
| **10** | `release` signature has no session/nonce/expiry | `token-http.js:47-62,493` | Signed message is only player+contract+chainId; replayable to force mid-game recover. |
| **11** | No per-IP rate limit on RPC-heavy HTTP endpoints | `token-http.js:799+` | `/start`, `/release`, `/topup` each await chain RPC; easy event-loop saturation. |
| **12** | `doSettle` probes session before signature verify | `token-http.js:450-455` | Enumeration: existence/ownership errors before auth failure. |

### Medium

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **13** | `doRelease` limbo: `closed=true`, `settlement=null` → net=0 path | `token-http.js:508-537` | Signer throw mid-`settle()` leaves session closed without settlement; may fall through to orphan release. Rare (signer reliable). |
| **14** | Leave during deal → full 12s insurance wait | `blackjack-server.js:300-305` | Left seats reset `insuranceDecided=false`; timer must expire even if only one player remains. |
| **15** | `tokenFlip` `revealLock` not cleared on stale TV sequence | `app.js:1719-1729` | Channel switch during reveal blocks other token games up to 20s. |
| **16** | Reef token Treasure Chest shows local RNG prizes ≠ server total | `fishtable.js:596+` | Balance authoritative; animation misleading. |
| **17** | `reef.js` dead `SPLASH_TARGET_BUDGET.chain` — roster parity gap | `reef.js:51`, `fishtable.js:433` | Server never awards chain splash budget if client has chain fish. |
| **18** | Plane→Pressure: `CrashRounds.live` blocks next launch ~1s | `app.js:3358`, `crash-rounds-client.js:75` | No `cancel()` between crash-family channels; first bet on new channel fails. |
| **19** | `refreshTokens()` ignores `resume()===false` | `token-mode.js:244` | After server restart, stale session shows old balance until next bet fails. |
| **20** | `/api/token/house-state` unauthenticated | `token-http.js:797` | Exposes open session count, locked wei, house P&L. |
| **21** | Session bearer in query string | `token-http.js:790` | `GET /api/token/session?sessionToken=…` logged/cached. |
| **22** | Chat / bet-proposal / lobby relay floods | `server.js:384+`, `blackjack-server.js:746` | No sender rate limits; unbounded `lobbySubs`. |
| **23** | SIGTERM drain settles at current multiplier not crash point | `crash-rounds.js:drain`, `server.js:249` | Redeploy during live losing rounds may credit wins above crash point (house EV leak on deploy). |
| **24** | `postMessage(..., "*")` to BJ iframe | `app.js:3389+` | Cross-origin iframe could receive balance/commands. |
| **25** | `bjReload()` force-reloads token BJ iframe mid-hand | `app.js:3490` | No liveness check; abandons turn via disconnect grace. |
| **26** | Fish Shooter mobile betbar gap | `app.js:162-163` | `fishshooter` in `BETBAR_GAMES` but not `BETBAR_SL` → blank mobile strip. |
| **27** | PvP rooms no creator-independent timeout | `CoinFlipBetting.sol` | Abandoned room escrow locked (v1 #147). |
| **28** | `GameRegistry.transferOwner` single-step, no zero guard | `GameRegistry.sol:31-35` | Typo can brick registry. |
| **29** | `totalFeesCollected` inconsistent across game types | `CoinFlipBetting.sol` | Host tables under-count; dice uses expected edge not realized fees. |
| **30** | Demo slots3d grid ≠ server PF stream | engines | Token mode OK on shared grids; demo verify panel false-fails. |
| **31** | V2 ABI cutover risk if registry updated without artifact regen | `contract.js` | `startSession` vs `blackjackBuyIn` selector mismatch would brick BJ. |

### Low

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **32** | `uncaughtException` flushes but doesn't drain crash rounds | `server.js:240` | Unlike SIGTERM path; reserved stakes may mis-settle on crash-kill. |
| **33** | `bjPersist.load/save` silent swallow | `server.js:89-90` | Guest bank only; inconsistent with token store hardening. |
| **34** | `dropSeat()` vs `leave()` insurance asymmetry | `blackjack-server.js:591` | Grace-expire path doesn't set `insuranceDecided`. |
| **35** | Non-wallet `hello` → shared `"anon"` play-money seat | `server.js:344`, `blackjack-server.js:748` | Play-money only. |
| **36** | Second WS tab `unbindToken` on first tab close | `server.js:413-419` | Delinks token session from BJ until re-hello. |
| **37** | CoinGecko outage blocks all buy-ins | `server.js:199-203` | No `ETH_USD` in `render.yaml` fallback. |
| **38** | ETH/USD split: client Coinbase vs server CoinGecko | `app.js`, `server.js` | Minor grant discrepancy under volatility. |
| **39** | Lazy game scripts at `?v=1243–1249` not `1250` | `app.js:2692+` | Safe after SW cache bust; fragile on next patch without token bump. |
| **40** | `SHARE_GAME` missing CH 16–19 | `app.js:162` | Win share card shows generic branding. |
| **41** | `play()` 1e-9 overbet tolerance | `token-bridge.js:118` | Sub-cent accounting leak. |
| **42** | `prevrandao` RNG / no VRF on prod | contracts | Acknowledged; validator bias surface. |
| **43** | `_betGuard` breaks ERC-4337 smart accounts | contracts | `msg.sender != tx.origin`. |
| **44** | Two-dice correlated from single hash word | `CoinFlipBetting.sol:898` | Marginals uniform; joint not independent. |
| **45** | Token crash CH-11 instant-only (no live WS cash-out) | `app.js:3288` | Unlike plane/pressure server-paced rounds. |
| **46** | Auto-fire overkill at power=2 lowers realized fish RTP | `fishshooter.js` | Not surfaced to players. |
| **47** | `pressure-ui` demo `_resolve` fallthrough if `TokenMode.active()` flickers | `pressure-ui.js:466` | Edge display glitch. |
| **48** | `verifySession` returns closed sessions | `token-http.js:727` | Opaque `cr:error` after crash-window. |
| **49** | Sky Swoop hidden from nav (intentional) | `app.js:3318` | Code present; no regression. |
| **50** | `pass4-exploits` crash profit assert flaky | `test/pass4-exploits.test.js:93` | Intermittent CI failure. |

### Closed / verified OK

| # | Note |
|---|------|
| **51** | Crash RTP >100% Monte Carlo — false positive (`crash-rtp-probe.js`) |
| **52** | `settlement-math-probe.js` sub-cent #204/#205 — **stale probe math**; real code uses micro-precision (`token-bridge.js:195-215`) |
| **53** | Slots3d `evaluate()` parity on server grids — 0/10k (`slots3d-parity-probe.js`) |
| **54** | Two-tab `/play` nonce race — **false positive** (Node serializes sync handlers per AGENTS.md) |

---

## Regression crosswalk (v1/v2 → v12.50)

| Area | v12.50 |
|------|--------|
| Crash reserve / nonce pin (#1-2 v1) | **FIXED** — `token-bridge.js:326-369` |
| txHash races (#4-5, #139) | **FIXED** — `pendingBuyIns`, `withPlayerLock`, `batchWrite` |
| Recover loss-escape (#140, #215) | **FIXED** — 3-branch `doRelease` + `findSettledSessionForPlayer` |
| HTTP crash liveness (#3, #15) | **FIXED** — `liveCrashSession` on doPlay/settle/release |
| **WS crash liveness vs BJ** | **FIXED v12.51 (#1)** — `liveExternal` gate in `crash-rounds-ws.js:91`, wired `server.js:222`; probe green |
| doPlay/doTopUp during BJ (#10 v2) | **FIXED** — `liveExternal` on HTTP |
| Client Wave 3 (#11-14 v2) | **FIXED** — guards, play-seq, bonus defer |
| staticCall in app.js (#3 v2) | **FIXED** — direct submit + receipt parse |
| staticCall on-chain (#5) | **STILL OPEN** — contract returns values |
| V2 deploy (#4 v2) | **STILL OPEN** — owner action |
| `_idlePrompt` (#204), slots stuck (#193) | **FIXED** |
| `contract.js` `_betGuard` | **FIXED in artifact**; V2 locks not in artifact |

---

## Per-game matrix (v12.50)

| Game / CH | Token | On-chain | Pass 6 top issue |
|-----------|-------|----------|------------------|
| Plane CH14 | ✓ WS | — | #8 channel switch balance |
| Balloon CH13 | ✓ WS | — | same |
| Crash CH11 | ✓ HTTP instant | ⚠ #5 | No live WS path |
| Gem Vault CH15 | ✓ | ⚠ #5 | Lazy `?v=1248` |
| Blackjack CH16 | ✓ bridge | bridge | #1 WS+BJ, #6 applyNet |
| Fish Shooter CH19 | ✓ | — | #26 betbar |
| Reef CH17 | ✓ | — | #16-17 display/RTP |
| Dice/Crash on-chain | — | ⚠ #5 | eth_call |

---

## Master remediation plan (Waves 0–6)

### Wave 0 — P0 money/security  ✅ LANDED v12.51 (Claude, 2026-06-30)

| Step | # | Action | Status |
|------|---|--------|--------|
| 0A | **1** | Inject `liveExternal` into `makeCrashWs`; gate `start()` same as HTTP doPlay. Probe: `crash-bj-interleave-probe.js` green. | ✅ **FIXED** — gate `crash-rounds-ws.js:91`, wired `server.js:222`. Probe was failing on a **stale socket stub** (read `obj.type` on a JSON *string*); fixed the probe to parse the wire format (matches `defaultSend` + the file's own self-test stub). Both assertions green. |
| 0B | **2** | Add security headers middleware (helmet or manual CSP/HSTS/frame deny). | ✅ **FIXED** — manual middleware `server.js:32-49`: `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, CSP `frame-ancestors 'self'` (NO `script-src` — wallet-safe), HSTS, `x-powered-by` off. New `security-headers-probe.js` (boots real server) green 7/7. |
| 0C | **7** | Move `lockReveal()` before `TokenMode.bet()` in `tokenSlots`. | ✅ **FIXED** — `app.js` `tokenSlots()`: `lockReveal()` now BEFORE both awaits (mirrors `tokenDice2`/`tokenCrash`); `unlockReveal()` on both catch paths so a load/bet error can't freeze the channel. |

> **Probe gate at v12.51 (all green):** `crash-bj-interleave-probe.js`, `security-headers-probe.js`, `crash-reserve-probe.js`, `crash-liveness-probe.js`, `adversarial-suite-v2.js` (0 findings), 5 server self-tests, `slots3d-parity-probe.js` (exit 0 — 0 money-path mismatches; only the known demo-grid HMAC/PF Medium, token mode unaffected). v1/v2 fixes verified held — **no regressions**.

### Wave 1 — Auth / rate limits

| Step | # | Action |
|------|---|--------|
| 1A | **9-12, 22** | WS + HTTP rate limits; `doSettle` auth-first ordering. |
| 1B | **10** | Bind `release` signature to sessionId or nonce+TTL. |
| 1C | **3** | Signed WS hello or restrict chat to verified sessions. |

### Wave 2 — Client crash/BJ UX

| Step | # | Action |
|------|---|--------|
| 2A | **8, 18** | On crash-family channel switch: await `cr:result` or call `CrashRounds.cancel()` + reconcile from server. |
| 2B | **6** | Surface `applyNet` failures to client (`bj:error` + token resync). |
| 2C | **15, 19, 25** | revealLock cleanup; resume false → clear session; bjReload guard. |

### Wave 3 — Contracts (owner)

| Step | # | Action |
|------|---|--------|
| 3A | **4, 31** | Deploy V2; regen artifact; registry pointer update in one PR. |
| 3B | **5** | Long-term: commit-reveal/VRF; document EOA eth_call risk until then. |

### Wave 4 — Ops / polish

| Step | # | Action |
|------|---|--------|
| 4A | **20-21, 37** | Auth house-state; POST session resume; `ETH_USD` env on Render. |
| 4B | **26, 39-40** | Betbar/share housekeeping; bump lazy `?v=` to build version. |
| 4C | **52** | Rewrite or retire stale sub-cent scenarios in `settlement-math-probe.js`. |

---

## Rules for fix agents

- Coordinate via **`AGENTS.md`** on deploy branch (consensus agreed).
- Never weaken recover loss-escape (`cursor/AUDIT-NOTES.md`).
- Probe-gate every money-path fix.
- Bump `?v=`, `ctf-v12.XX` on public changes; note in `cursor/HANDOFF.md`.
- Use **# numbers from this report** for Pass 6.

---

*End Pass 6. Handoff prompt: `CursorBugHunt-v3/CLAUDE-PROMPT.txt`*
