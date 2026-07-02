# Crypto TV — Bug Hunt v12 (Pass 15 — 10× Deep Scan)

**Baseline:** live **v12.91** (`?v=1291`, `ctf-v12.91`)  
**Prior audit:** Pass 14 / v11 — fish epoch, slots3d bar sync  
**Method:** **10 parallel adversarial streams** (server money, crash client, fish/slots, BJ/auth, token/demo, contracts, concurrency, settle/recover, cross-game parity, v2–v11 regression) + full probe gate

---

## Executive summary

**Money ledger: still 0 new Critical / 0 new High house-drain** on server happy path (6th consecutive clean pass).

**Pass 15 finds 3 new High + 9 new Medium + 5 Low** (#1–#17). Ten-stream scan surfaced **crash ack-timeout false refunds**, **token TV dice/crash liveness**, and **BJ dock guard desync** — angles v10/v11 did not cover.

Top new risks:
1. **Lost `cr:started` / ack timeout → false “stake not taken” + plane local refund** while server reserved (#1)
2. **Token session active but TV dice/crash buttons disabled** (`gameWei` gate) (#4)
3. **Recover UI races `TokenMode.init` resume** (#2)

v10 Wave 0 + v11 Wave 1 items **remain open** on v12.91.

---

## Probe gate (v12.91)

| Probe | Result |
|-------|--------|
| v2–v11 full gate | ✅ |
| **`CursorBugHunt-v12/crash-ack-timeout-probe.js`** | ❌ documents #1 |
| **`CursorBugHunt-v12/stranded-resume-race-probe.js`** | ❌ documents #2 |
| **`CursorBugHunt-v12/dice-token-afford-probe.js`** | ❌ documents #4 |
| **`CursorBugHunt-v12/bj-dock-stale-probe.js`** | ❌ documents #8 |
| npm test | ✅ 35/35 |

---

## Pass 15 NEW findings

### High

#### #1 — Ack timeout / lost `cr:started` → false refund while server debited
**Files:** `server/crash-rounds.js:64`, `server/crash-rounds-ws.js:100-112`, `public/crash-rounds-client.js:98`, `public/plane-ui.js:405-407`, `public/pressure-ui.js:302-303`  
**Issue:** `bridge.reserve()` debits **before** `cr:started` is sent. If `cr:started` is dropped, the 12s ack timer fires with *“Your stake was not taken”*. Plane `.catch` **locally refunds `+stake`** (line 405-407). Pressure resets to `TM.tokens()` (pre-debit cache). Server still has live round → **HUD lies**, LAUNCH trap.

**Contrast:** `CR_ROUND_TIMEOUT` (line 115) correctly treats stake as taken; ack timeout does not.

**Repro:**
1. Token Plane/Balloon Pop, LAUNCH.
2. Drop inbound `cr:started` only (network filter / proxy).
3. Wait ~12s → canvas shows pre-debit balance; token bar shows debited amount after refresh.
4. LAUNCH again → `"a crash round is already live"`.

**Fix:** Treat ack-timeout like `CR_ROUND_TIMEOUT`: `refreshTokens()`, never local refund; optionally `cr:resume` with session creds.  
**Probe:** `CursorBugHunt-v12/crash-ack-timeout-probe.js`

---

#### #2 — Stranded “Recover” races `TokenMode.init` session resume
**Files:** `public/app.js:639-643,875-882`, `public/token-mode.js:56-63`, `public/app.js:3130-3135`  
**Issue:** `startGameUI()` → `checkStrandedLock()` runs **before** `TokenMode.init()` and before async `client.resume()` completes. With `bjLocked > 0` and `TokenMode.active() === false`, Recover UI appears. User can force-settle a **live** open session while resume is in flight.

**Repro:**
1. Token buy-in, reload page.
2. Reconnect wallet quickly.
3. Recover banner visible while resume pending → tap Recover → session closed server-side.

**Fix:** Await resume (or set `resumePending`) before `checkStrandedLock`; suppress Recover when `localStorage` session exists and resume not finished.  
**Probe:** `CursorBugHunt-v12/stranded-resume-race-probe.js`

---

#### #3 — `cr:error` “already crashed” races `cr:result` → plane false refund
**Files:** `public/crash-rounds-client.js:147-162`, `public/plane-ui.js:405-407`  
**Issue:** `onError` and `onResult` both require `live`; first wins. Late CASH OUT after server bust → `cr:error` → plane refunds stake; delayed `cr:result` dropped (`!live`).

**Repro:** Manual token Plane, tap CASH OUT after bust before `cr:result` arrives → false refund flash.

**Fix:** Ignore cashout errors when `live.roundId` set; never refund post-`cr:started` errors.

---

### Medium

#### #4 — TV dice/crash/twodice buttons gated on `gameWei`, not token balance
**Files:** `public/app.js:1947`, `:2047`, `:2158`; contrast `:317-318` `spendableUsd()`  
**Issue:** After buy-in, `gameWei ≈ 0` but `TokenMode.tokens() > 0`. Readouts disable Roll/Launch; `play*Click()` would route to token path but button is dead.

**Repro:** Buy in, stay on Crash channel, try Launch → disabled + “deposit first” hint.

**Fix:** Affordability via `spendableUsd()` / token branch in readouts; refresh readouts in `syncTokenGameBalances`.  
**Probe:** `CursorBugHunt-v12/dice-token-afford-probe.js`

---

#### #5 — Cold resume must **rebuild** `live`, not only send `cr:resume`
**Files:** `public/crash-rounds-client.js:111-112,147-148,176-177`  
**Status:** Extends v10 #1 — implementation trap  
**Issue:** Even if `app.js` sends `cr:resume` after F5, `onStarted`/`onNoRound`/`onResult` bail when `!live`. No animation, no cash-out, no `.then`.

**Fix:** `resumeCold()` creates pending `live` + channel `onTick` before WS frame.

---

#### #6 — `syncTokenGameBalances` hold requires on-channel → off-channel win spoiler
**Files:** `public/app.js:3101-3115`, `:2598`, `:2768`  
**Issue:** `onS3d` / `onFishChan` require `currentGame ===` that channel. Leave mid-spin/bonus/chest → next `onChange` calls `setBalance(tokens())` and spoils animation. Fish re-entry `ensure*Ready` also dumps full balance.

**Fix:** Hold when `g._spinning || g._bonus || g._awaitingServer || g._chest || g._frenzy > 0` regardless of `currentGame`.

---

#### #7 — Token `onChange(true)` never re-anchors session tracker
**Files:** `public/app.js:643`, `:2999-3010`, `:3056-3125`  
**Issue:** Buy-in/top-up/cash-out call `onChange(true)` → `syncTokenGameBalances` but never `paintSession(true)`. Top-ups counted as wins in session stats.

**Fix:** `paintSession(!!force)` from token `onChange`.

---

#### #8 — Off-channel `bj:dock` ignored → stale `bjDockLive`
**Files:** `public/app.js:3932-3938`, `:3829`, `:3574`, `:3621`  
**Issue:** `renderBjDock` (sets `bjDockLive`) only when `currentGame === "blackjack"`. Hand finishes off-channel → `placed:0` never received → false “Finish the current hand” on reload.

**Fix:** Always update `bjDockLive` from `bj:dock`; reset on channel leave.  
**Probe:** `CursorBugHunt-v12/bj-dock-stale-probe.js`

---

#### #9 — `_emitDockError` forces `placed:0` while server hand may be live
**Files:** `public/blackjack-ui.js:483-487`, `public/app.js:3829`  
**Issue:** Auth error dock snapshot clears `placed` → parent `bjDockLive=false` → iframe heal may drop WS mid-hand.

**Fix:** Don't zero `placed` on auth errors; or parent queries server exposure.

---

#### #10 — Pre-hello guest balance oracle
**Files:** `server/blackjack-server.js:802-806,834`, `server/server.js:482-485`  
**Status:** Extends v10 #5 hijack surface  
**Issue:** `bj:lobby:subscribe` allowed before hello; `messageWallet` trusts `m.wallet` → `pushWallet` leaks victim demo balance.

**Repro:** WS connect, no hello → `{ type:"bj:lobby:subscribe", wallet:"guest:VICTIM" }` → `{ balance: N }`.

**Fix:** Pin guest at hello only; reject subscribe without `sock.wallet`.

---

#### #11 — Wallet `norm()` gaps on exposure paths (beyond join)
**Files:** `server/blackjack-server.js:60,743,757,780` vs `157-158`  
**Status:** Extends v10 #6  
**Issue:** Same EOA two casings → two seats / wrong `openExposure`.

---

#### #12 — Pressure `resumedGone` shows “POP at 0.00x”
**Files:** `public/pressure-ui.js:308-318`, `public/crash-rounds-client.js:176-182`  
**Status:** v9 #2 plane parity gap  
**Fix:** Dedicated offline-bust message (not `crashPoint || 0`).

---

### Low

#### #13 — Reef Auto-fire UI desync after channel leave (`fishtable.js:946-950` vs `966`)  
#### #14 — Fish Shooter `auto` persists across channel switch (`fishshooter.js:1052-1058`)  
#### #15 — Swoop `onBalance` writes `demoUsd` without token guard (`app.js:2648`)  
#### #16 — `demoReset()` skips `swoopGame` (`app.js:3213-3227`)  
#### #17 — `TokenMode.cashOut()` failure skips resync (`token-mode.js:232-234`)

---

## Carry-forward (v10/v11 — still open)

| Ref | Item |
|-----|------|
| v10 #1–#3 | Cold resume, launch ack, reef splash |
| v11 #1–#2 | Fish epoch, slots3d top bar |
| v11 #3, #5 | Pressure HTTP void, clientSeed cap |
| v10 #5–#9 | Guest hijack, wallet norm (join), orphan settle, batchWrite, multi-tab |
| v9 #1 | bjReload → `demoUsd` |

Server money paths: **no new Critical/High drain** (10-stream server audit confirmed).

---

## Owner-only (unchanged)

O1 V2 deploy · O2 staticCall cherry-pick · O3 contract F1/F2 redeploy

---

## Wave plan for Claude

### Wave 0 — v10 High (if not shipped)
0A Cold resume · 0B Launch ack · 0C Reef splash

### Wave 1 — Pass 15 High
| # | Item |
|---|------|
| 1A | **#1** Ack timeout = CR_ROUND_TIMEOUT semantics + no local refund |
| 1B | **#2** Resume-before-stranded / suppress Recover during resume |
| 1C | **#3** cr:error vs cr:result race guard |

### Wave 2 — Pass 15 Medium
| # | Item |
|---|------|
| 2A | **#4+#7** Token dice/crash afford + session tracker |
| 2B | **#5+#6** Cold resume live rebuild + off-channel hold |
| 2C | **#8+#9+#10+#11** BJ dock + guest oracle + norm |
| 2D | v11 fish epoch + slots3d bar |

### Wave 3 — Polish
v11 pressure HTTP void, clientSeed cap, #12–#17

---

## Hunt comparison

| Pass | Streams | New High | Money C/H |
|------|---------|----------|-----------|
| v11 | 5 | 1 | 0 |
| **v12** | **10** | **3** | **0** |

10× scan found **real High client/liveness** (crash ack-timeout refund, token TV afford, recover race) without reopening ledger Critical/High.

---

## Rules

- Full probe gate after fixes; v12 probes must invert to PASS.
- Bump `?v=1292` on public changes.
- Do NOT re-file v7/v8 money fixes unless regression proven.
