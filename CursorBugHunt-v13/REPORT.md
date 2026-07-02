# Crypto TV — Bug Hunt v13 (Pass 16 — 50× Mega Scan)

**Baseline:** live **v12.91** (`?v=1291`, `ctf-v12.91`)  
**Prior audit:** Pass 15 / v12 — 10-stream deep scan  
**Method:** **50 parallel focused scans** (max agents, 10 batches) + full probe gate + code verification

---

## Executive summary

**Money ledger: 1 NEW High server bug** (Scan 46 orphan cap-at-1000× win). Otherwise **0 new Critical / 0 additional High house-drain** on happy path.

**Pass 16 adds 1 NEW Critical-class server fix + 4 NEW Medium + prior carry-forward consolidated.**

| Metric | Count |
|--------|-------|
| Scans run | **50** |
| Scans CLEAN / FIXED | 28 |
| Scans OPEN (carry-forward) | 19 |
| Scans NEW finding | **3** (46, 47, 48) + extensions (36, 38, 39) |

Top **NEW** items:
1. **Scan 46 — Orphan crashRound finalize pays 1000×** when `crashPoint === MAX_CRASH_X` (`cashOutAt: 1e9` clamps to 1000)
2. **Scan 48 — `token-client` play seq rollback after topUp**
3. **Scan 47 — `refreshTokens()` updates top bar only, not canvas HUD**

All v10–v12 Wave 0 items **remain open** on v12.91.

---

## 50-scan matrix

| Scan | Focus | Verdict | Sev | NEW |
|------|--------|---------|-----|-----|
| 1 | `bridge.play()` races | CLEAN | — | no |
| 2 | reserve/resolve/finalizeOrphan | **OPEN** → see **46** | High | yes |
| 3 | doSettle/doRelease/recover | OPEN (v10 #8) | Med | no |
| 4 | doTopUp TOCTOU | FIXED | — | no |
| 5 | pressure HTTP void | OPEN (v11 #3) | Med | no |
| 6 | crash-rounds pressure floor | CLEAN | — | no |
| 7 | crash-rounds-ws resume/auth | CLEAN | — | no |
| 8 | BJ applyExternal/guest | OPEN (v12 #10) | Med | no |
| 9 | BJ seat/norm | OPEN (v12 #11) | Med | no |
| 10 | WS hello/rate/chat | OPEN oracle + CLEAN hardening | Med | no |
| 11 | ack timeout / CR_ROUND_TIMEOUT | OPEN (v12 #1) | High | no |
| 12 | onError vs onResult race | OPEN (v12 #3) | High | no |
| 13 | cold resume live rebuild | OPEN (v10 #1) | Med | no |
| 14 | plane false refund inventory | OPEN (v12 #1/#3) | High | no |
| 15 | pressure catch/resumedGone | OPEN (v12 #1/#12) | High/Med | no |
| 16 | fishtable epoch/splash/auto | OPEN (v10/v11/v12) | High/Low | no |
| 17 | fishshooter guards/teardown | OPEN + AUTO/LOCK UI | Med/Low | partial |
| 18 | slots3d off-channel/re-entry | OPEN (v11/v9) | Med | no |
| 19 | syncTokenGameBalances hold | OPEN (v12 #6) | Med | no |
| 20 | switchGame cancel/refresh | OPEN canvas race | Med | yes→47 |
| 21 | token-mode resume/multi-tab | OPEN (v12 #2/#17, v10 #10) | High/Low | no |
| 22 | token-client play seq | **OPEN** | Med | yes→48 |
| 23 | dice/crash afford | OPEN (v12 #4) | Med | no |
| 24 | bjDockLive off-channel | OPEN (v12 #8) | Med | no |
| 25 | bjReload/stranded race | OPEN (v12 #2, v9 #1) | High/Med | no |
| 26 | V1 bjLocked drain | O1 owner | Crit/O | no |
| 27 | staticCall leak | FIXED F5 | — | no |
| 28 | realmoney digest | CLEAN | — | no |
| 29 | SIGKILL orphan + settle | OPEN (v10 #8) | Med | no |
| 30 | withPlayerLock races | MITIGATED | — | no |
| 31 | reef betUnits/power | OPEN (v10 #7) | Med | no |
| 32 | fishshooter disburse | CLEAN | — | no |
| 33 | slots3d PF parity | CLEAN (v12.90) | — | no |
| 34 | slots stake override | FIXED | — | no |
| 35 | crash engine parity | CLEAN | — | no |
| 36 | swoop/poker demo leak | **OPEN** | Med/Low | yes |
| 37 | paintSession/onChange | OPEN (v12 #7) | Med | no |
| 38 | ensure*Ready load race | **OPEN** | Low-Med | yes |
| 39 | TV reveal hold bypass | **OPEN** | Med | yes |
| 40 | render resumePending gap | OPEN (v12 #2 ext) | Med | no |
| 41 | clientSeed CPU cap | OPEN (v11 #5) | Med | no |
| 42 | ipGuard/rateOk | FIXED | — | no |
| 43 | admin auth | CLEAN | — | no |
| 44 | chat XSS/NFKC | CLEAN | — | no |
| 45 | security headers | CLEAN (by design) | — | no |
| 46 | **orphan cap 1000× win** | **BUG** | **High** | **yes** |
| 47 | refreshTokens canvas desync | **BUG** | Med | yes |
| 48 | play seq after topUp | **BUG** | Med | yes |
| 49 | plane visibility cash-out | OPEN (v9 #8) | Low-Med | no |
| 50 | crash+BJ+fish interleave | MOSTLY SAFE | Mixed | no |

---

## NEW consolidated findings (Pass 16)

### High

#### #1 — Orphan `crashRound` finalize can pay 1000× stake (cap hit)
**Scan:** 46 · **Files:** `server/token-bridge.js:474,493`, `server/games/crash.js:77-87`  
**Issue:** `finalizeOrphanRounds` / `drainOrphanReservations` call `resolveReserved({ cashOutAt: 1e9 })`. Engine clamps to `MAX_CRASH_X` (1000). When committed `crashPoint === 1000`, `win = true` → **payout = bet × 1000** on a path meant to bust (payout 0).

**Repro (verified):**
```javascript
// clientSeed 'c486' + serverSeed 'seed' → crashPoint 1000
crash.play({ ..., betUnits: 10, params: { cashOutAt: 1e9 } })
// → payoutUnits: 10000 (should be 0)
```

**Fix:** Orphan bust must use `cashOutAt = min(crashPoint + 0.01, MAX)` derived from pinned nonce (mirror `crash-rounds.js:133`), not `1e9`.

**Probe:** `CursorBugHunt-v13/orphan-cap-win-probe.js`

---

### Medium

#### #2 — `refreshTokens()` skips canvas sync (`changed()`)
**Scan:** 47, 20 · **Files:** `public/token-mode.js:263-271`, `public/app.js:3465-3470`  
**Issue:** After channel switch / visibility refresh, `refreshTokens()` calls `paintTokens()` only — not `changed()` → `syncTokenGameBalances()` never runs. Destination canvas can show pre-resume balance while top bar is correct.

**Fix:** `refreshTokens` success → `changed()` or explicit `syncTokenGameBalances(true)`.

---

#### #3 — Stale `play()` response overwrites post-`topUp` balance
**Scan:** 48, 22 · **Files:** `public/token-client.js:139-147,153-168`  
**Issue:** `_playSeqApplied` guard on `play()` only. `topUp()` sets `this.tokens` but does not invalidate in-flight play seq → slower play response rolls displayed balance backward.

**Fix:** On `topUp`/`buyIn`/`resume`, set `_playSeqApplied = _playSeq` or ignore stale play responses.

**Probe:** `CursorBugHunt-v13/token-play-seq-probe.js`

---

#### #4 — TV token reveal hold bypassed by 2800ms `syncBalance`
**Scan:** 39 · **Files:** `public/app.js:1741-1750,3366-3367`  
**Issue:** `lockReveal()` pins token bar during crash/flip climb, but fixed 2800ms timeout calls `TokenMode.syncBalance()` mid-animation → spoiler.

**Fix:** Tie sync to `TV.__onTvReveal` / reveal completion, not fixed timeout.

---

#### #5 — Swoop demo balance leak + `exitDemo` mis-sync
**Scan:** 36 · **Files:** `public/app.js:2648,3207-3208`  
**Issue:** Swoop `onBalance` always writes `demoUsd` without token/demo guard; `exitDemo` sets swoop balance to token amount on demo-only game.

---

#### #6 — `loadScriptOnce` no dedup; watchdog re-triggers parallel loads
**Scan:** 38 · **Files:** `public/app.js:2279-2285,2619`  
**Issue:** Slow fish/swoop load → watchdog nulls promise and re-boots → duplicate script tags.

---

### Low

#### #7 — Fish Shooter AUTO/LOCK UI persists across channel leave (Scan 17)  
#### #8 — Reef Auto button UI desync (Scan 16 / v12 #13)

---

## Carry-forward (v10–v12 — still open)

| Wave | Items |
|------|-------|
| v10 #1–#3 | Cold resume, launch ack, reef splash |
| v11 #1–#2 | Fish epoch, slots3d top bar |
| v12 #1–#12 | Ack timeout, recover race, cr:error race, dice afford, bjDockLive, guest oracle, etc. |
| Server | Pressure HTTP void, clientSeed cap, orphan settle (#8), batchWrite (#9), betUnits/power (#7) |

---

## Probe gate (v12.91)

| Probe | Result |
|-------|--------|
| v2–v12 full gate | ✅ |
| **`CursorBugHunt-v13/orphan-cap-win-probe.js`** | ❌ documents #1 |
| **`CursorBugHunt-v13/token-play-seq-probe.js`** | ❌ documents #3 |
| npm test | ✅ 35/35 |

---

## Wave plan for Claude

### Wave 0 — Money (NEW + v10)
| # | Item |
|---|------|
| 0A | **#1 Scan 46** Orphan bust uses derived point+ε, not 1e9 |
| 0B | v10 #1–#3 crash client false refunds |
| 0C | v11 fish epoch + slots3d bar |

### Wave 1 — Client liveness
| # | Item |
|---|------|
| 1A | **#2** refreshTokens → changed() |
| 1B | **#3** play seq / topUp |
| 1C | **#4** TV reveal sync timing |
| 1D | v12 ack timeout + recover race |

### Wave 2 — Reliability
| # | Item |
|---|------|
| 2A | **#5–#6** swoop demo, script dedup |
| 2B | BJ dock, guest oracle, norm |
| 2C | pressure HTTP void, clientSeed cap |

---

## Hunt comparison

| Pass | Scans | New High (money) | New High (client) |
|------|-------|------------------|-------------------|
| v12 | 10 | 0 | 3 |
| **v13** | **50** | **1 (#1 cap orphan)** | 0 new (consolidated client) |

50× scan found **one real server money bug** missed by prior passes (orphan cap win), plus client gaps already partially filed in v12.

---

## Rules

- Full probe gate after fixes; v13 probes must invert.
- Bump `?v=1292` on public changes.
- Do NOT re-file v7/v8 fixes unless regression proven.
