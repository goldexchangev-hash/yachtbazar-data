# Crypto TV — Bug Hunt v15 (Pass 18 — Scans 101–200)

**Baseline:** live **v12.91** (`?v=1291`, `ctf-v12.91`)  
**Prior audit:** Pass 17 / v14 — scans 1–100  
**Method:** **100 parallel focused scans** (max agents, 10×10 batches) + probe gate + code verification  
**Cumulative:** **200 scans** across v13 + v14 + v15

---

## Executive summary

**Money ledger: 1 NEW Critical server bug (Scan 114 doSettle loss-escape) + 1 prior High (M1 orphan cap-at-1000×).** Pass 18 adds **4 NEW High client**, **1 NEW Critical server**, **15+ NEW Med/Low**.

| Metric | Count |
|--------|-------|
| Scans run (this pass) | **100** (101–200) |
| Cumulative scans | **200** |
| Scans CLEAN / FIXED | 62 |
| Scans OPEN (carry-forward) | 28 |
| Scans NEW finding | **22** |

Top **NEW** items this pass:
1. **Scan 114 — `doSettle` on closed session clears `openByPlayer` for a live session** (loss-escape)
2. **Scan 107 — `token-bridge` `save()` silently swallows persist failures** (memory/disk divergence)
3. **Scan 176 — Fish Shooter token bonus double-credit** after channel leave + session expiry
4. **Scan 173 — Pressure `_tick` misses `_roundToken` guard** (phantom pop at 0×)
5. **Scan 188 — WS hello wallet/guest impersonation** (presence + chat)

---

## 100-scan matrix (101–200)

| Scan | Focus | Verdict | Sev | NEW |
|------|--------|---------|-----|-----|
| 101 | reserve() TOCTOU | CLEAN | — | no |
| 102 | resolveReserved idempotency | CLEAN | — | no |
| 103 | applyExternal orphan not self-healing | OPEN | Low | **yes** |
| 104 | topUp during live round | CLEAN | — | no |
| 105 | settle during open crashRound | OPEN | Low–Med | ext |
| 106 | gcClosed tombstone | CLEAN | — | no |
| 107 | **`save()` silent persist fail** | **BUG** | Med | **yes** |
| 108 | ENGINES alias crash/plane/swoop | CLEAN | — | no |
| 109 | clampPayout reef/slots | CLEAN | — | no |
| 110 | play() nonce monotonicity | CLEAN | — | no |
| 111 | doStart chain validation | CLEAN | — | no |
| 112 | doPlay liveCrashSession fail-open | OPEN | Low | no |
| 113 | doTopUp liveExternalDealt | CLEAN | — | no |
| 114 | **`doSettle` closed-session loss-escape** | **BUG** | **Crit** | **yes** |
| 115 | doRelease / recover race | CLEAN | — | no |
| 116 | bearer persistence | OPEN | Med | ext→114 |
| 117 | admin routes auth | CLEAN | — | no |
| 118 | house-state exposure | CLEAN | — | no |
| 119 | flushPersist shutdown | CLEAN | — | no |
| 120 | self-test gap (114) | OPEN | High | **yes** |
| 121 | reserve before cr:started | CLEAN | — | no |
| 122 | autoTarget below floor | CLEAN | — | no |
| 123 | timer bust vs manual cashout | CLEAN | — | no |
| 124 | `_resolve` bust ledger-throw orphan | **BUG** | Med | **yes** |
| 125 | drain() pressure floor | CLEAN | — | no |
| 126 | ws onClose detached socket | CLEAN | — | no |
| 127 | cr:resume multi-tab | CLEAN | — | no |
| 128 | cr:cashout after bust timer | CLEAN | — | no |
| 129 | client cancel channel switch | CLEAN | — | no |
| 130 | roundMs vs CR_ROUND_TIMEOUT | CLEAN | — | no |
| 131 | takeInsurance debit fail | CLEAN | — | no |
| 132 | closeInsurance credit_failed phantom | OPEN | Med | no (v14 57) |
| 133 | split/double token afford | MITIGATED | — | no |
| 134 | surrender payout math | CLEAN | — | no |
| 135 | dealer peek edge | CLEAN | — | no |
| 136 | guest seat hijack | OPEN | Med | no |
| 137 | bridgeClear during live hand | CLEAN | — | no |
| 138 | token BJ vs demo isolation | CLEAN | — | no |
| 139 | shoe commit-reveal | CLEAN | — | no |
| 140 | WS rate limit / seed cap | CLEAN | — | no |
| 141 | coinflip determinism | CLEAN | — | no |
| 142 | dice over param coercion | CLEAN | — | no |
| 143 | dice2 independence | CLEAN | — | no |
| 144 | reef payout cap | CLEAN | — | no |
| 145 | fishshooter multiplier on miss | **BUG** | Low | **yes** |
| 146 | slots classic RTP | CLEAN | — | no |
| 147 | slots3d bonus retrigger / cap | OPEN | Med | ext |
| 148 | pressure deriveBurst cap | CLEAN | — | no |
| 149 | crashPointOf CPU / orphan comment | CLEAN | — | ext→M1 |
| 150 | cross-engine params injection | CLEAN | — | no |
| 151 | client.resume vs gone | CLEAN | — | no |
| 152 | buyIn double-click | CLEAN | — | no |
| 153 | syncTokens vs syncBalance | OPEN | Low | no |
| 154 | lockReveal / barHold | CLEAN | — | no |
| 155 | **multi-tab localStorage overwrite** | **BUG** | Med | **yes** |
| 156 | tokenAuthMessage replay | CLEAN | — | no |
| 157 | settleBlackjack client path | CLEAN | — | no |
| 158 | applyExternal client visibility | OPEN | Low | no |
| 159 | _betError throttle | CLEAN | — | no |
| 160 | **Recover vs resumePending race** | **BUG** | Med | **yes** |
| 161 | **localStorage deployment no isAddress** | **BUG** | Med | **yes** |
| 162 | chain switch mid-session | OPEN | Med | ext |
| 163 | enterDemo/exitDemo swoop gap | **BUG** | Low | **yes** |
| 164 | reconcile() double-reveal | **BUG** | Med | **yes** |
| 165 | activeRoomId F5 | KNOWN | — | no |
| 166 | shareBase poisoned contract | OPEN | Low | ext→161 |
| 167 | adminRelease auth | CLEAN | — | no |
| 168 | profile/BJ innerHTML XSS | **BUG** | Low–Med | ext |
| 169 | modal focus trap | **BUG** | Low | **yes** |
| 170 | sw.js vendor cache | OPEN | Low–Med | ext |
| 171 | **plane CR_ROUND_TIMEOUT refresh race** | **BUG** | High | **yes** |
| 172 | **plane setActive pending TX _realBusy** | **BUG** | High | **yes** |
| 173 | **pressure _tick _roundToken miss** | **BUG** | High | **yes** |
| 174 | pressure demo/token parity | CLEAN | — | no |
| 175 | fishtable token .then no _active | **BUG** | Med | **yes** |
| 176 | **fishshooter bonus double-credit** | **BUG** | High | **yes** |
| 177 | crash-ui busy/mounted latch | **BUG** | Low | **yes** |
| 178 | PlaneFeed frozen token mode | **BUG** | Med | **yes** |
| 179 | fishtable AUTO/LOCK DOM desync | **BUG** | Med | ext |
| 180 | crash-ui rAF after hide | **BUG** | Low | **yes** |
| 181 | **slots3d spin stale .then race** | **BUG** | Med | **yes** |
| 182 | slots3d bonus replay fidelity | OPEN | Low | ext |
| 183 | slots3d PF verify wrong seed | **BUG** | Low | **yes** |
| 184 | swoop3d no token path | OPEN | Med | ext |
| 185 | poker-ui botBank mint | **BUG** | Med | **yes** |
| 186 | poker-server dead / no auth | OPEN | Med | **yes** |
| 187 | **chat cleanChat no HTML strip** | **BUG** | Med | **yes** |
| 188 | **WS hello wallet impersonation** | **BUG** | High | **yes** |
| 189 | presence oracle broadcast | OPEN | Med | ext→188 |
| 190 | SIGTERM drain ordering | CLEAN | Low | ext |
| 191 | V2 settleSession CEI / no test | OPEN | Low/Crit | ext |
| 192 | V2 digest mismatch (undeployed) | OPEN | Crit | ext |
| 193 | lockFunds V1 vs V2 | OPEN | Med | no |
| 194 | cancelRoom refund race | CLEAN | — | no |
| 195 | treasury withdraw asymmetry | OPEN | Med | **yes** |
| 196 | sw.js cache strategy | CLEAN | — | no |
| 197 | provablyfair HMAC CPU | OPEN | Low | no |
| 198 | test coverage gaps (V2) | OPEN | High | ext |
| 199 | applyExternal orphan BJ block | OPEN | Med | ext→103 |
| 200 | v2–v14 regression checklist | OPEN | — | no |

---

## NEW consolidated findings (Pass 18)

### Critical — Server money

#### #1 — `doSettle` on closed session clears live `openByPlayer` (loss-escape)
**Scan:** 114, 120 · **Files:** `server/token-http.js:510–542`  
**Issue:** No `s.closed` guard. Re-calling `doSettle` with an **already-settled** session ID is idempotent in the bridge but still runs `openByPlayer.delete(player)` unconditionally — wiping the slot for a **different open session B**. `recordObligation` may overwrite with a consumed stale settlement, enabling cross-session lock reclaim / loss escape per the v1 `bjLocked` accumulator model.

**Fix:** `if (s.closed && s.settlement) throw bad()` OR only `openByPlayer.delete` when `openByPlayer.get(player) === s.id`.

**Probe:** `CursorBugHunt-v15/dosettle-closed-session-probe.js`

---

### High — Server + client

#### #2 — M1 carry-forward: orphan cap-at-1000× (v13 Scan 46)
Still open. Scans 149, 199 confirm root cause unchanged.

#### #3 — Fish Shooter token bonus double-credit (Scan 176)
**Files:** `public/fishshooter.js:436–459, 669–686`  
**Issue:** Off-channel `.then` re-arms bonus; if token session expired on re-entry, `_updateBonusFinale` uses demo `balance += fz.won` while server already credited bonus.

#### #4 — Pressure `_tick` phantom pop (Scan 173)
**Files:** `public/pressure-ui.js:335–347 vs 363–374`  
**Issue:** #47 fix applied to `_release` but `_tick` still uses live `_tokenActive()`. Session drop mid-inflation → local pop at 0× on server-managed round.

#### #5 — Plane CR_ROUND_TIMEOUT refresh race (Scan 171)
**Files:** `public/plane-ui.js:384–408`  
**Issue:** `_startTokenIdle()` bumps epoch before `refreshTokens`; relaunch before refresh completes → stale pre-debit balance written mid-flight.

#### #6 — Plane pending real TX orphan (Scan 172)
**Files:** `public/plane-ui.js:291–307, 481–500`  
**Issue:** `setActive(false)` during pending wallet TX bumps epoch → `.then` bails without clearing `_realBusy` → LAUNCH stuck.

#### #7 — WS hello wallet/guest impersonation (Scan 188)
**Files:** `server/server.js:496–504`  
**Issue:** Format-only `0x` / `guest:` check — no signature. Chat + presence spoofable (money path `ws.wallet` still protected).

---

### Medium

#### #8 — Silent `save()` failure (Scan 107)
**File:** `server/token-bridge.js:99` — swallow-all catch on persist → restart restores stale balance (house drain or player loss).

**Probe:** `CursorBugHunt-v15/bridge-save-silent-probe.js`

#### #9 — `_resolve` bust ledger-throw session lockout (Scan 124)
**File:** `server/crash-rounds.js:138–144` — no RAM cleanup on bust timer ledger throw; session blocked until restart.

#### #10 — Multi-tab localStorage session overwrite (Scan 155)
**File:** `public/token-mode.js:42–45` — Tab B buy-in overwrites Tab A session key.

#### #11 — Recover `resumePending` race (Scan 160)
**File:** `public/app.js:3130–3143` — stale `resumePending` check before `await read.bjLocked`.

#### #12 — localStorage deployment no `isAddress` (Scan 161)
**File:** `public/app.js:30–31` — URL param validated; localStorage branch is not.

#### #13 — slots3d stale spin `.then` (Scan 181)
**File:** `public/slots3d.js` — no spin generation counter; off-channel cancel + re-spin race.

**Probe:** `CursorBugHunt-v15/slots3d-spin-gen-probe.js`

#### #14 — reconcile() double-reveal (Scan 164)
**File:** `public/app.js:4295–4329` — non-atomic `lastRevealed` guard.

#### #15 — chat HTML not stripped (Scan 187)
**File:** `server/server.js` `cleanChat()` — stored XSS via chat history.

#### #16 — fishtable/fishshooter off-channel `.then` (Scans 175–176)
Missing `_active` / epoch guards on token bet callbacks.

#### #17 — applyExternal orphan not self-healing (Scan 103, 199)
**File:** `server/token-bridge.js:239` — unlike `play()`/`reserve()`, no `finalizeOrphanRounds`.

#### #18 — fishshooter multiplier on miss (Scan 145)
**File:** `server/games/fishshooter.js:197` — audit integrity vs reef.js.

---

## Master bug registry (200 scans — v10 through v15)

### Wave 0 — Ship first

| ID | Source | Issue | Sev |
|----|--------|-------|-----|
| **S1** | v15 Scan 114 | doSettle closed-session re-call clears live openByPlayer | **Critical** |
| **M1** | v13 Scan 46 | Orphan finalize `cashOutAt:1e9` → 1000× at cap | **High** |
| **C1** | v15 Scan 176 | Fish Shooter bonus double-credit | **High** |
| **C2** | v15 Scan 173 | Pressure _tick phantom pop | **High** |
| **C3** | v15 Scan 171–172 | Plane timeout refresh + pending TX stuck | **High** |
| **C4** | v14 Scan 64 | Pressure early-bank orphan trap | Med–High |
| C5 | v12 #1–3 | Ack timeout, recover race, cr:error race | High |

### Wave 1 — Reliability + audit

| ID | Issue |
|----|-------|
| R1 | v15 Scan 107 silent save() |
| R2 | v15 Scan 124 crash _resolve lockout |
| R3 | v15 Scan 103/199 applyExternal orphan heal |
| R4 | v14 M2 verifyRederive cap assurance |
| R5 | v13 U1–U2 refreshTokens, play seq |

### Wave 2 — Security + UX

| ID | Issue |
|----|-------|
| X1 | v15 Scan 188 WS impersonation |
| X2 | v15 Scan 187 chat XSS |
| X3 | v14 Scan 89 + v15 Scan 161 contract poisoning |
| X4 | v15 Scan 155 multi-tab session |
| X5 | v14 Scan 82 WS bridge disabled gate |

---

## Probe gate (v12.91)

| Probe | Result |
|-------|--------|
| v2–v14 full gate | ✅ |
| v13 orphan-cap-win | ❌ M1 |
| v14 pressure-early-bank | ❌ C4 |
| **v15 dosettle-closed-session** | ❌ S1 |
| **v15 bridge-save-silent** | ❌ R1 |
| **v15 slots3d-spin-gen** | ❌ Scan 181 |
| npm test | ✅ 22/22 Hardhat |

---

## Hunt comparison (cumulative)

| Pass | Scans | New Crit/High money | New High client |
|------|-------|---------------------|-----------------|
| v13 | 50 | 1 (M1) | 0 |
| v14 | 50 | 0 | 0 (+ C4 Med–High) |
| **v15** | **100** | **1 (S1)** | **4** |
| **Total** | **200** | **2 server Crit/High** | **7+ client High** |

---

## Rules

- Full probe gate after fixes; v15 probes must invert where applicable.
- Bump `?v=1292` on public changes.
- V2 contract fixes (192–198) are **not production-reachable** until deploy + signing path updated.
