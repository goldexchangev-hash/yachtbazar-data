# Crypto TV — Bug Hunt v4 (Pass 7)

**Baseline:** live **v12.55** (`?v=1255`, `ctf-v12.55`) on deploy branch `claude/ethereum-betting-game-vrf-2dq50k` @ `25409f1`  
**Prior audit:** Pass 6 / v3 on v12.50 (`CursorBugHunt-v3/REPORT.md`)  
**Method:** Branch from deploy → confirm version in `public/sw.js` → full probe gate → 8-stream read-only audit → regression crosswalk vs v3 FIXES LANDED → fresh numbering below.

---

## Executive summary

**v3 Waves 0–4 + v12.55 adversarial remediations held.** Full probe gate green on committed v12.55. Claude's adversarial review (40 SOLID / 0 regressions) matches our regression pass — no Wave 0–4 rollbacks found.

**Pass 7 adds 23 actionable findings** (#1–#23 below): mostly **client liveness/UX** and **one symmetric money-path gap** (inverse of v3 #1). **No new Critical** security headers or WS→BJ bypass regressions.

**Owner-only unchanged:** V2 deploy (#4 v3), `eth_call` (#5), wallet E2E, fee/RNG policy (#29/#42/#43).

---

## Probe gate (v12.55 — all green except new v4 gap probes)

| Probe | Result |
|-------|--------|
| `CursorBugHunt-v2/crash-reserve-probe.js` | ✅ OK |
| `CursorBugHunt-v2/crash-liveness-probe.js` | ✅ OK |
| `CursorBugHunt-v2/adversarial-suite-v2.js` | ✅ 0 findings |
| `CursorBugHunt-v3/crash-bj-interleave-probe.js` | ✅ OK (v3 #1 held) |
| `CursorBugHunt-v3/security-headers-probe.js` | ✅ 7/7 |
| `CursorBugHunt-v3/wave1-auth-probe.js` | ✅ 11/11 |
| `CursorBugHunt-v3/wave2-money-probe.js` | ✅ OK (#13 loss-escape held) |
| `CursorBugHunt/settlement-math-probe.js` | ⚠ stale #204–#209 (documented; real code micro-precision) |
| `CursorBugHunt/slots3d-parity-probe.js` | ✅ token path 0 mismatch (demo HMAC grid known) |
| Server self-tests (5 modules) | ✅ all OK |
| `npm test` | ✅ 33 passing |
| `npx hardhat test test/pass4-exploits.test.js` | ✅ 7/7 |
| **`CursorBugHunt-v4/crash-bj-inverse-probe.js`** | ❌ **FAIL** (v4 #1 — gap confirmed) |
| **`CursorBugHunt-v4/verify-rederive-crash-probe.js`** | ✅ mid-round open entry fails verify; post-settle OK |

**Obsolete:** `CursorBugHunt/repro-crash-nonce-desync.js`, sub-cent scenarios in `settlement-math-probe.js`.

---

## v3 regression crosswalk (v12.55)

| v3 # | Title | v12.55 |
|------|-------|--------|
| 1 | WS `cr:start` vs BJ guard | ✅ **FIXED** v12.51 — `crash-rounds-ws.js:91`, `server.js:253` |
| 2 | Security headers | ✅ **FIXED** v12.51 — `server.js:32-49` |
| 3 | WS hello spoof | 📋 **Non-bug** (money-safe; rate-limited) |
| 4 | V2 not deployed | ⏸ **OWNER-ONLY** |
| 5 | `eth_call` leak | ⏸ **OWNER-ONLY** |
| 6 | BJ `applyNet` silent | ⚠ **PARTIAL** — main settle surfaces `credit_failed`; insurance/refund paths still silent (v4 #9) |
| 7 | `tokenSlots` lock | ✅ **FIXED** v12.51 |
| 8 | Plane switch balance | 📋 **Non-bug** (epoch guard correct) |
| 9–12, 22 | Auth / rate limits | ✅ **FIXED** v12.52 |
| 10 | Release replay | ✅ **FIXED** v12.52 |
| 13 | doRelease limbo | ✅ **FIXED** v12.53 |
| 14 | Insurance 12s wait | ⚠ **PARTIAL** — deal-phase abandon still stalls (v4 #12) |
| 15–19, 25, 47 | Client crash/BJ UX | ✅ **FIXED** v12.53 |
| 24 | postMessage `*` | ✅ **FIXED** v12.53 + v12.55 `bjCmd`; receivers still lack `e.origin` (v4 #8) |
| 26, 39–40, 50, 52 | Ops/polish | ✅ **FIXED** v12.54 |
| 27–28, 31 | Contract source | ✅ source v12.54; **#28 zero-guard** also in v12.55 tests; **await owner deploy** |
| 16–17, 30, 33–38, 41–46, 48–54 | Medium/low / closed | 📋 documented non-bugs, cosmetic, or stale probes — see v3 table |

**v12.55-specific:** `#24` `bjCmd` postMessage same-origin (`app.js:3637`); `#28` `setActiveGame(0)` guard (`GameRegistry.sol`, `GameRegistry.test.js`).

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Exploit / total breakage / major security gap |
| **High** | Real-money desync, auth bypass, or systematic loss |
| **Medium** | Reliability, DoS, UX money confusion |
| **Low** | Polish, demo-only, cosmetic |

---

## Pass 7 findings (#1–#23)

### High

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **1** | **Inverse liveness gap: BJ debits during live crash round** | `token-http.js:828-833`, `token-bridge.js:171-188` | v3 #1 blocked WS `cr:start` during BJ; **HTTP crash guards do not block BJ**. `applyBlackjackNet` → `applyExternal` runs while `liveCrashSession` is true → interleaved nonces/debits on the same session. **Repro:** `CursorBugHunt-v4/crash-bj-inverse-probe.js` (FAIL on v12.55). **Fix:** `if (liveCrashSession(sessionId)) throw …` in `applyBlackjackNet`. |
| **2** | **Lazy-load `setActive(true)` without channel guard** | `app.js:2357,2430,2519,2580,2669,2750,2801` | `ensure*Ready().then()` activates canvas even if user switched channels during load. Reef **`auto` stays latched** on `setActive(false)` (`fishtable.js:914-916`) → off-screen token bets possible. **Fix:** `if (currentGame !== "reef") return` before every post-load `setActive(true)`; mirror Fish Shooter teardown on Reef deactivate. |
| **3** | **Fish token burst-fire — parallel server bets** | `fishtable.js:330-335,375`; `fishshooter.js:386-393,430` | Token mode skips local debit on `_fire`; rapid auto/tap queues parallel `TokenMode.bet()` before balance gate updates. **Carried from v1/v3** — still open on v12.55. |

### Medium

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **4** | **`verifyRederive` fails on open `crashRound` entries** | `token-bridge.js:259-275` | Mid-round ledger rows (`kind:"crashRound", open:true`, empty `params`) replay via `ENGINES.play` without `cashOutAt` → PF verify false-fails until `resolveReserved` rewrites the entry. Post-settle OK. **Repro:** `verify-rederive-crash-probe.js` (open-entry check). |
| **5** | **Unclean restart orphans persisted crash reservations** | `token-bridge.js:345-347`; `crash-rounds.js:37-38,144` | `reserve()` persists `open:true` crashRound to disk; `activeBySession`/timers are RAM-only. SIGKILL (not SIGTERM `drain()`) → new `cr:start` can stack while prior stake forfeited. Rare ops edge; player-favorable loss only if they would have won. |
| **6** | **Unbounded `clientSeed` on WS `cr:start`** | `crash-rounds-ws.js:99`; `provablyfair.js:44-48` | No length cap; multi-MB seed → synchronous HMAC CPU DoS per message (WS rate limit slows, doesn't cap payload). |
| **7** | **BJ iframe asset version split** | `app.js:3474`; `blackjack.html:16,96-103` | Shell at `?v=1255`; iframe loads `blackjack.html?v=1238` with inner `?v=1197/1198` — post-deploy bridge/felt skew risk. |
| **8** | **postMessage receivers omit `e.origin` check** | `app.js:3399+`; `blackjack.html:135-136`; `blackjack-ui.js:466,472` | Senders fixed (#24); receivers validate `e.source` only. Full same-origin hardening needs `e.origin === location.origin`. Low live risk (iframe is same-origin). |
| **9** | **`applyNet` failure only surfaced on main hand settle** | `blackjack-server.js:212,329,552,617,639` vs `467-470` | Insurance wins, room-close refunds, leave/drop refunds, re-bet refunds, cancelBet can fail token credit silently. v3 #6 partial. |
| **10** | **Iframe reload paths bypass `bjDockLive`** | `app.js:3456-3474,3548-3549,3721` | Token `bjReload()` guarded; legacy bridge reload + `ensureBlackjackReady` hash-drift + `renderBjDock` self-heal still tear down iframe mid-hand. v3 #25 partial. |
| **11** | **Reef Treasure Chest animation ≠ server payout** | `fishtable.js:596+` | Balance authoritative via `r.tokens`; chest uses local RNG pop. v3 #16 cosmetic — still open. |
| **12** | **Insurance stall if abandon during `dealing`** | `blackjack-server.js:303-305,560-565` | v3 #34 fixed insurance for leave/drop in insurance phase; abandoning during deal still leaves `insuranceDecided=false` → full 12s wait. v3 #14 partial. |

### Low

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **13** | **`applyExternal` sub-cent overbet tolerance** | `token-bridge.js:180` | v3 #41 fixed `play()`/`reserve()` to integer cents; BJ bridge path still `bet > s.tokens + 1e-9`. |
| **14** | **`resolveReserved` no closed-session guard** | `token-bridge.js:353-355` | Unlike `play()` line 114; late timer on improper close could mutate closed session (defense-in-depth). |
| **15** | **`cr:cashout` missing `roundId` → misleading error** | `crash-rounds-ws.js:112-116` | `"already crashed"` masks validation failures. |
| **16** | **`gcClosed()` skips limbo sessions** | `token-bridge.js:78-86` | `closed=true`, `settlement=null` (#13 retry path) never pruned → memory growth. |
| **17** | **`syncTokenGameBalances()` clobbers fish reveal hold** | `app.js:3042-3044` | Unconditional HUD sync races 480ms win-reveal delay on fish channels. |
| **18** | **Reef no background-tab pause** | `fishtable.js:858` vs `fishshooter.js:954-957` | Ticker/auto can run in background tab. v3 #195. |
| **19** | **Buy-in min confirmations defaults to 1** | `server.js:236`; `token-http.js:80-93` | Thin reorg window before `usedBuyIns` persisted; mitigated by `batchWrite`. |
| **20** | **Hidden Sky Swoop still in betbar maps** | `app.js:352-355,3922`; `index.html:183` | Stale `localStorage` restore shows betbar for unreachable channel. |
| **21** | **Plane/Pressure cancel leaves stale canvas balance** | `plane-ui.js:384-407`; `pressure-ui.js:286-299` | Display-only; ledger resyncs via `app.js:2410-2411`. |
| **22** | **BJ debit `applyNet` failure silent in logs** | `blackjack-server.js:126` | Credit path logs; debit catch returns false with no log. |
| **23** | **`bj:insurance` silent drop on no-seat socket** | `blackjack-server.js:717-721` | No `bj:error` feedback. |

---

## Owner-only (neither AI — do not count as code regressions)

| v3 ref | Item |
|--------|------|
| **#4** | Deploy `CoinFlipBettingV2` + registry pointer |
| **#5** | Commit-reveal / VRF migration (until then: EOA `eth_call` risk) |
| **#31** | Regenerate `public/contract.js` atomically with V2 deploy |
| **#29** | Fee-accounting policy across game types |
| **#42–43** | `prevrandao` RNG; `_betGuard` vs smart accounts |
| — | Wallet E2E smoke on Sepolia |

---

## Remediation plan (Pass 7 waves)

### Wave A — Money symmetry (P0)

| Step | # | Action |
|------|---|--------|
| A1 | **1** | `liveCrashSession(sessionId)` guard in `applyBlackjackNet`. Probe: `crash-bj-inverse-probe.js` → green. |
| A2 | **13** | Integer-cent check in `applyExternal` (mirror `play()`). |

### Wave B — Client liveness

| Step | # | Action |
|------|---|--------|
| B1 | **2** | Channel guard before all lazy-load `setActive(true)`; Reef teardown parity with Fish Shooter. |
| B2 | **3** | Token fish in-flight cap / optimistic local debit. |
| B3 | **7** | Bump BJ iframe + inner assets to build `?v=`. |
| B4 | **10** | Extend `bjDockLive` to all iframe reload triggers. |

### Wave C — PF / ops

| Step | # | Action |
|------|---|--------|
| C1 | **4** | `verifyRederive`: treat `kind:"crashRound"` like external until resolved, or require `params.cashOutAt`. |
| C2 | **5–6** | Startup replay of open crashRound from disk OR refuse new start; cap `clientSeed` length. |
| C3 | **9,12** | Surface token credit failures on all BJ refund paths; fix deal-phase insurance abandon. |

---

## Rules for fix agents

- Coordinate via **`AGENTS.md`** on deploy branch.
- **Do NOT re-file** v3 Wave 0–4 fixes without regression proof (`git show HEAD:<file>`).
- Probe-gate every money-path fix; bump `?v=` / `ctf-v12.XX` on public changes.
- Use **Pass 7 # numbers** from this report for v4 work.

---

*End Pass 7. Handoff prompt: `CursorBugHunt-v4/CLAUDE-PROMPT.txt`*
