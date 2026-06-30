# Cursor Bug Hunt v2 — Crypto TV (v12.46)

**Date:** 2026-06-30  
**Site:** https://tv-crypto-flip.onrender.com  
**Branch:** `claude/ethereum-betting-game-vrf-2dq50k` @ `04cfa7f`  
**Build:** `?v=1246`, `ctf-v12.46`  
**Prior audit:** `CursorBugHunt/REPORT.md` (v12.39, ~230 findings)

---

## Methodology

Full re-audit of v12.46 — same scope as v1, fresh findings numbering.

| Pass | Scope | Tools |
|------|-------|-------|
| **1** | Money paths | `token-bridge.js`, `token-http.js`, `crash-rounds.js`, `server.js` code review |
| **2** | Games + client | `app.js`, `token-mode.js`, all game UIs, channel lifecycle |
| **3** | Contracts + on-chain | `CoinFlipBetting.sol`, `contract.js`, `pass4-exploits.test.js` |
| **4** | Adversarial + concurrency | `CursorBugHunt-v2/*.js`, legacy `CursorBugHunt/*.js` where applicable |
| **5** | V1 crosswalk + live diff | Compare v1 #1–#230 against v12.46; probe obsolete vs current APIs |

### Scripts (run from repo root)

```bash
# v2 probes (v12.46-aware)
node CursorBugHunt-v2/crash-reserve-probe.js      # BLOCKER until reserve() lands in token-bridge
node CursorBugHunt-v2/crash-liveness-probe.js     # #3/#15 guards — PASS on v12.46
node CursorBugHunt-v2/adversarial-suite-v2.js

# Carried forward from v1 (still valid on v12.46)
node CursorBugHunt/settlement-math-probe.js
node CursorBugHunt/slots3d-parity-probe.js
node CursorBugHunt/crash-rtp-probe.js
node CursorBugHunt/fork-staticCall-poc.js

# Server self-tests
node server/token-bridge.js && node server/token-http.js && node server/crash-rounds.js && node server/crash-rounds-ws.js

# On-chain PoCs
npx hardhat test test/pass4-exploits.test.js
npm test
```

**Obsolete (do not use for v12.46 crash verdict):** `CursorBugHunt/repro-crash-nonce-desync.js`, v1 adversarial §3a/3b — they test `pointPeek`+deferred `play()`, not `reserve`/`resolveReserved`.

---

## Executive summary

**~45 active findings** in v2 (#1–#45). v12.46 closed most of the v1 money-path wave (txHash races, persist split, recover loss-escape, Wave 0 hotfixes) but introduced a **critical integration gap**:

### Top risks (v12.46)

1. **🔴 `bridge.reserve` / `bridge.resolveReserved` missing from `token-bridge.js`** — `crash-rounds.js` calls them; real bridge does not export them. **All token crash/plane/swoop/pressure rounds fail at `cr:start`.** Self-tests pass because stubs inject fake `reserve`.
2. **🔴 Stale `public/contract.js`** — browser deploy lacks `_betGuard`, `paused`, V2 per-session locks.
3. **🔴 On-chain `staticCall` cherry-pick** — dice/crash/hostRoom outcomes readable before submit (EOA).
4. **🟠 `doPlay` during live blackjack** — no `liveExternal` guard on instant HTTP bets.
5. **🟠 Client balance desync** — `refreshBalances()` poll, out-of-order token responses, CrashRounds singleton.

### What v12.46 fixed (from v1)

Wave 0: **#204** Balloon `_idlePrompt` recursion, **#193** slots spin stuck.  
Wave 1 partial: **#3/#15/#141** crash liveness + SIGTERM drain (**guards PASS**; rounds still broken without reserve).  
Wave 2: **#4/#5/#16/#139/#140/#145/#215/#142/#143/#144/#216/#217**, **#9** plane token mode, **#222** ethUsd cold-start gate.

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Exploitable fund loss, total feature breakage, or fairness break |
| **High** | Broken real-money UX, latent exploit, orphaned state |
| **Medium** | Desync, reliability, DoS, verification broken |
| **Low** | Polish, demo-only, cosmetic |

---

## All findings (most severe → least)

### Critical

| # | Title | Files | Summary | Status |
|---|-------|-------|---------|--------|
| **1** | **`reserve`/`resolveReserved` missing — crash token path dead** | `crash-rounds.js:56,120`, `token-bridge.js:306` | `makeCrashRounds` calls `bridge.reserve()` / `bridge.resolveReserved()` but `makeTokenBridge()` only exports `play`, `pointPeek`, etc. Integration test: `TypeError: bridge.reserve is not a function`. Every `cr:start` → `cr:error`. | **REPRODUCED** |
| **2** | Stale `contract.js` — no `_betGuard` / `paused` / V2 sessions | `contract.js`, `CoinFlipBetting.sol`, `CoinFlipBettingV2.sol` | ABI lacks `ContractCaller`, `Paused`, `startSession`. UI deploy uses pre-patch bytecode. | **STILL OPEN** |
| **3** | On-chain instant games leak outcome via `staticCall` | `CoinFlipBetting.sol`, `app.js` | `playDice`/`playCrash`/`playHostRoom` return `won`/roll before TX. EOA cherry-picks wins. `pass4-exploits.test.js` 7/7 pass. | **STILL OPEN** |
| **4** | V1 `bjLocked` cross-session principal release | `contract.js`, `CoinFlipBetting.sol` | Global `bjLocked`; one `settleBlackjack` zeros entire lock. V2 fix exists but not in artifact. | **STILL OPEN in artifact** |

### High

| # | Title | Files | Summary | Status |
|---|-------|-------|---------|--------|
| **5** | `doPlay` allowed during live blackjack hand | `token-http.js:375-385` | `liveCrashSession` checked; **`liveExternal` not checked**. Instant coinflip/dice during BJ desyncs ledger vs hand. | **REPRODUCED** |
| **6** | Token BJ winnings silently dropped | `blackjack-server.js:113-115` | `applyNet` failure logged, not surfaced; payout unbooked. | **STILL OPEN** |
| **7** | `playHostRoom.staticCall` before submit | `app.js:1847-1853` | Client reads `playerWon` from simulate; template for cherry-pick UX. | **STILL OPEN** |
| **8** | `gasleft()` only partial staticCall mitigation | `CoinFlipBetting.sol:568`, `pass4-exploits.test.js` | Some rolls match between staticCall and TX; adversary can tune gas. | **STILL OPEN** |
| **9** | Revert-drain guard in source, not in artifact | `CoinFlipBetting.sol:47-50`, `contract.js` | `_betGuard` works in Hardhat; absent from shipped `contract.js`. | **FIXED source / OPEN artifact** |

### Medium

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **10** | Top-up allowed mid-blackjack hand | `token-http.js:402-439` | No `liveExternal` on `doTopUp`; changes affordance mid-hand. |
| **11** | Plane balance poll overwrites token HUD | `app.js:1358`, `5349` | `refreshBalances()` sets `planeGame.setBalance(weiToUsd(gb))` without `!TokenMode.active()` guard. 60s interval. |
| **12** | CrashRounds singleton blocks crash-family | `app.js:4573`, `crash-rounds-client.js:75` | One global instance; stuck round blocks plane+balloon 12–120s. |
| **13** | Out-of-order token responses corrupt balance | `token-client.js:136` | Last response wins; fish/reef rapid fire can show stale inflated balance. |
| **14** | Slots3D bonus prematurely updates token bar | `slots3d.js:421` | `syncBalance()` before `if (this._bonus)` — top bar shows final total on first free spin. |
| **15** | PvP/host rooms never idle-timeout | `CoinFlipBetting.sol` | Escrow locked if host abandons (v1 #147). |
| **16** | `GameRegistry.transferOwner` single-step | `GameRegistry.sol:31-35` | No two-step accept; typo = irrecoverable. |
| **17** | `totalFeesCollected` undercounts host rake | `CoinFlipBetting.sol:708-711` | Host tables only count platform half. |
| **18** | `/api/token/house-state` unauthenticated | `token-http.js:789` | Aggregate locked wei + session count public. |
| **19** | Session bearer in query string | `token-http.js:790` | `GET /api/token/session?sessionToken=…` logged/cached. |
| **20** | `bjPersist.save` silent swallow | `server.js:90` | Disk-full on guest BJ bank invisible. |
| **21** | Sub-cent losses → `netWei=0` | `token-bridge.js:193,203`, `settlement-math-probe.js` | `round2(-0.004)=0` escapes tiny losses. |
| **22** | `weiToUsd` precision for huge wei | `settlement-math-probe.js` | Values above `MAX_SAFE_INTEGER` lose precision. |
| **23** | Demo slots3d grid ≠ server grid | `slots3d-engine.js` vs `games/slots3d.js` | Demo PF verify false-fails; token mode OK on shared grids (#218). |
| **24** | Compromised house signer unbounded net | `CoinFlipBetting.sol`, `realmoney.js` | Signed net bounded only by bankroll check. |
| **25** | `prevrandao` RNG (no VRF on prod path) | `CoinFlipBetting.sol`, `config.js` | Validator-influenced entropy. |

### Low

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **26** | Optimistic debit before `cr:start` ack | `plane-ui.js:352`, `pressure-ui.js:268` | Refund on timeout while server may hold reservation (when #1 fixed). |
| **27** | Slots3D `_finishBonusNow` inflates display balance | `slots3d.js:513-517` | Display-only in token mode. |
| **28** | `verifySession` returns closed sessions | `token-http.js:727-731` | Opaque `cr:error` after crash-window. |
| **29** | `uncaughtException` keeps process alive | `server.js:240` | Now flushes stores; may serve corrupt state. |
| **30** | `play()` 1e-9 overbet tolerance | `token-bridge.js:118` | Sub-cent accounting leak. |
| **31** | `gcClosed` skips `createdAt=0` | `token-bridge.js:82` | Edge TTL prune miss. |
| **32** | PF verify UI uses demo schemes | `plane-ui.js`, `pressure-ui.js`, `slots3d.js` | Token games need `provablyfair.js` stream. |
| **33** | Plane demo RNG ≠ token server RNG | `plane-engine.js` vs `games/crash.js` | Demo 3% vs server 1%. |
| **34** | Cross-tab token ghost sessions | `token-mode.js` | No `storage` listener. |
| **35** | BJ iframe loads before token resume | `app.js` | Stale `#bjtoken` race (v1 #30). |
| **36** | False stranded-lock before resume | `app.js` | `checkStrandedLock` before `TokenMode.init` (v1 #31). |
| **37** | Sky Swoop frozen on channel leave | `swoop3d.js` | v1 #23 — not re-verified this pass. |
| **38** | Fish/Reef unbounded in-flight shots | `fishshooter.js`, `fishtable.js` | v1 #19 — not re-verified this pass. |
| **39** | Crypto Reels CH12 dead / Plinko unwired | `app.js` | v1 #101, #137. |
| **40** | `bjNonceUsed` replays as `InsufficientBalance` | `CoinFlipBetting.sol:474` | Misleading error in V1 artifact. |
| **41** | Unset blackjack signer reverts `NotOwner` | `CoinFlipBetting.sol:473` | Wrong diagnostic. |
| **42** | Legacy v1 probes give false crash alarms | `CursorBugHunt/repro-crash-nonce-desync.js` | Tests obsolete API — use v2 probes. |
| **43** | Crash RTP >100% Monte Carlo | — | **CLOSED** false positive (`crash-rtp-probe.js`). |
| **44** | Slots3d `evaluate()` parity on shared grids | — | **PROVEN OK** 0/10k (`slots3d-parity-probe.js`). |
| **45** | Token replay lands on `r.tokens` | — | **PROVEN OK** (v1 #218). |

---

## V1 crosswalk (selected)

| v1 # | v12.46 status | v2 # / note |
|------|---------------|-------------|
| 1–2, 13–14 | **Designed fixed, NOT FUNCTIONAL** | **#1** — reserve missing on real bridge |
| 3, 15 | **FIXED** | `crash-liveness-probe.js` PASS |
| 4–5, 16, 139 | **FIXED** | `withPlayerLock`, `pendingBuyIns`, `batchWrite` |
| 140, 145, 215 | **FIXED** | `doRelease` 3-branch + closed-session re-issue |
| 141 | **Designed fixed, NOT FUNCTIONAL** | `drainCrashRounds()` wired; moot until #1 |
| 142–144 | **FIXED** | `loadJsonStoreOrThrow`, `flushAllStores` |
| 9, 204, 193 | **FIXED** | Wave 0 hotfixes in v12.45–46 |
| 6–8, 147 | **STILL OPEN** | **#2–#4, #9** |
| 10–12, 34 | **STILL OPEN** | **#5–#6, #10** |
| 17–18, 20–22 | **PARTIAL / OPEN** | **#11–#13, #26** |
| 136 | **CLOSED** | **#43** |
| 218 | **PROVEN OK** | **#44–#45** |

---

## Per-game matrix (v12.46)

| Game / CH | Token path | On-chain | v2 top issues |
|-----------|------------|----------|---------------|
| Plane CH14 | 🔴 **broken** (#1) | — | reserve missing; #11 poll |
| Balloon CH13 | 🔴 **broken** (#1) | — | same |
| Crash CH11 | HTTP OK | ⚠ #3 | WS crash broken (#1) |
| Gem Vault CH17 | ✓ | ⚠ #3 | #14 bonus bar; #193 fixed |
| Blackjack CH18 | ✓ bridge | bridge | #5–#6, #10 |
| Dice CH15/16 | ✓ HTTP | ⚠ #3 | staticCall |
| Fish/Reef | ✓ | — | #13, #38 |
| Sky Swoop | 🔴 WS | — | #1, #37 |
| Host/PvP flip | on-chain | ⚠ #3, #7 | #15 |

---

## Probe results (this run)

| Probe | Result |
|-------|--------|
| `crash-reserve-probe.js` | **FAIL** — `reserve`/`resolveReserved` undefined |
| `crash-liveness-probe.js` | **PASS** — doPlay/doSettle blocked during live round |
| `adversarial-suite-v2.js` | **FAIL** — RESERVE-MISSING + BJ-PLAY-INTERLEAVE |
| `settlement-math-probe.js` | 6 sub-cent / rounding findings (#21–#22 range) |
| `slots3d-parity-probe.js` | evaluate OK; demo grid deriv differs (#23) |
| `crash-rtp-probe.js` | #136 closed |
| `pass4-exploits.test.js` | **7/7 pass** — staticCall PoCs confirmed |
| Server self-tests | **ALL PASS** (stubs hide #1) |

---

## Master remediation plan (v12.46 → v12.47)

### Wave 0 — Unblock crash token path (P0)

| Step | Finding | Action |
|------|---------|--------|
| **0A** | **#1** | Implement `reserve()` + `resolveReserved()` in `token-bridge.js`: pin nonce, debit stake, record pending reservation; finalize payout at pinned nonce; idempotent `resolveReserved`; export on return object. Mirror stub in `crash-rounds.js` self-test. |
| **0B** | **#1** | Run `crash-reserve-probe.js` until green; update `token-bridge.js` self-test with reserve round-trip. |
| **0C** | **#42** | Mark v1 crash probes obsolete in `CursorBugHunt/REPORT.md` header. |

### Wave 1 — Blackjack + instant play guards

| Step | Finding | Action |
|------|---------|--------|
| **1A** | **#5** | `doPlay`: `if (liveExternal(player)) throw` (mirror `doSettle`). |
| **1B** | **#10** | `doTopUp`: same guard. |
| **1C** | **#6** | Propagate `applyNet` failures to client / retry queue. |

### Wave 2 — Contracts + artifact

| Step | Finding | Action |
|------|---------|--------|
| **2A** | **#2, #9** | `npm run compile && npm run artifact`; regen `contract.js` from V2 + `_betGuard`. |
| **2B** | **#3, #7** | Remove client `staticCall` previews; parse receipts. Document EOA cherry-pick risk until bridge-only settlement. |
| **2C** | **#4** | Deploy V2 per-session locks to production registry. |

### Wave 3 — Client balance + UX

| Step | Finding | Action |
|------|---------|--------|
| **3A** | **#11** | Guard `refreshBalances()` plane write with `!TokenMode.active()`. |
| **3B** | **#13** | Monotonic sequence on `token-client` responses. |
| **3C** | **#12** | Per-channel `CrashRounds` or explicit cancel on switch. |
| **3D** | **#14** | Defer `syncBalance()` until bonus completes. |

### Wave 4 — Ops + polish

| Step | Finding | Action |
|------|---------|--------|
| **4A** | **#18–#19** | Auth-gate house-state; POST session resume. |
| **4B** | **#20–#21** | Log bj persist failures; tighten sub-cent settle floor. |
| **4C** | **#32–#33** | Demo PF labels; token verify panel. |

---

## Rules for fix agents

- **Do not weaken** recover loss-escape (`cursor/AUDIT-NOTES.md`).
- Bump `?v=1247`, `ctf-v12.47`, note in `cursor/HANDOFF.md` on user-facing deploys.
- **#1 is the blocker** — nothing else in the crash family matters until `reserve` ships in `token-bridge.js`.
- Use **v2 probe paths** under `CursorBugHunt-v2/` for verification.

---

*End of v2 report. Prior audit: `CursorBugHunt/REPORT.md`. Handoff prompt: `CursorBugHunt-v2/CLAUDE-PROMPT.md`.*
