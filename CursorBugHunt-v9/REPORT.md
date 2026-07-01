# Crypto TV — Bug Hunt v9 (Pass 12)

**Baseline:** live **v12.91** (`?v=1291`, `ctf-v12.91`) @ `960ac76` on `claude/ethereum-betting-game-vrf-2dq50k`  
**Prior audit:** Pass 11 / v8 on v12.85 — Claude shipped **v12.86–v12.91** (v8 fixes, slots3d PF, demo unify, crash #94 resume, contract F1/F2 source)  
**Method:** **4-stream max-agent audit** → v8 regression → 2 money sweeps → probe gate

---

## Executive summary

**Money ledger: 0 new Critical, 0 new High** (third consecutive clean pass after v7/v8 fixes).

**v8 regression:** 3/4 FIXED, 1 PARTIAL (#3 top-bar only). **v7 #8 slots3d PF FIXED** (v12.90).

**Pass 12 finds 10 actionable items** (#1–#10): **0 Critical code**, **0 High money**, **6 Medium**, **4 Low**. Plus **3 owner-only** (V2 deploy, on-chain staticCall, id-squat).

New since v12.85:
- v12.86 landed all v8 Wave 0 + #4 orphan guard
- v12.87–88 BJ mobile-resume + demo balance unify (with **Reload gap**)
- v12.89 Gem Vault gross-win display
- v12.90 slots3d PF parity
- v12.91 crash disconnect-resume (#94) — money-safe
- c2bb824 contract F1/F2 source prep (owner deploy pending)

---

## Probe gate (v12.91)

| Probe | Result |
|-------|--------|
| v2 crash-reserve / liveness / adversarial | ✅ |
| v3 BJ-interleave / wave1 / wave2 | ✅ |
| v4 inverse / orphan-drain | ✅ |
| v5 pending-settle-key | ✅ |
| v6 plane-token-stuck | ✅ |
| v7 pressure-drain | ✅ |
| v8 pressure-leave-stuck | ✅ fix verified |
| **`CursorBugHunt-v9/bj-reload-demo-probe.js`** | ❌ documents #1 |
| npm test | ✅ 33/33 |

---

## v8 regression (v12.85 → v12.91)

| # | Item | Status | Landed |
|---|------|--------|--------|
| 1 | Pressure leave stuck | **FIXED** | v12.86 `pressure-ui.js:489-500` |
| 2 | Token bar desync | **FIXED** | v12.86 `app.js:3461-3464` (`refreshTokens` on channel switch) |
| 3 | Slots `_awaitingServer` leave | **PARTIAL** | v12.86 — spin HUD fixed; **top 🪙 bar** still gaps off-channel |
| 4 | Crash orphan double-debit | **FIXED** | v12.86 `finalizeOrphanRounds()` in `token-bridge.js:464-478` |
| v7 #8 | slots3d PF parity | **FIXED** | v12.90 `slots3d-engine.js:146-160` mirrors server `PF.floats` |

---

## Pass 12 findings — with fix suggestions for Claude

### Medium

#### #1 — Demo BJ ⟳ Reload still seeds `BJ_START` ($5,000), not unified `demoUsd`
**Files:** `public/app.js:3608-3612` vs `3496` (bjFramePost uses `demoUsd`)  
**Issue:** v12.88 unified demo balance for `bjFramePost`, but guest **Reload** still posts hard-coded `BJ_START`. Guest with e.g. $8,200 from Gem Vault taps Reload → felt drops to $5,000 while site bar unchanged until next dock emit. Toast at `5123` still says "$1,000".

**Fix for Claude:**
```javascript
// bjReload ~3611:
if (f && f.contentWindow) try {
  f.contentWindow.postMessage({ type: "bj:seed", balance: Math.round(demoUsd * 100) / 100 }, location.origin);
} catch (e) {}
// Fix toast copy to match actual amount
```
**Probe:** `CursorBugHunt-v9/bj-reload-demo-probe.js`

---

#### #2 — Plane `cr:noround` (#94 offline bust) shows `undefined` crash multiplier
**Files:** `public/plane-ui.js:372-374`, `public/crash-rounds-client.js:176-182`  
**Issue:** When round settled while offline, `onNoRound` resolves `{ busted: true, resumedGone: true }` with **no `crashPoint`**. Plane calls `res.crashPoint.toFixed(2)` → "undefinedx". Balance eventually corrects via `refreshTokens`; UX broken.

**Fix for Claude:**
```javascript
// plane-ui.js token .then bust branch:
if (res.busted) {
  if (res.resumedGone) {
    this._msg("Round ended while you were away — stake lost.", "lose");
    this.r.crash(0, true);
  } else {
    const cp = res.crashPoint || 0;
    this.r.crash(cp, cp <= 1.01);
    this._msg("✈️ Flew away @ " + cp.toFixed(2) + "x — lost " + this._usd(stake), "lose");
  }
}
```

---

#### #3 — Gem Vault `setBalance()` no in-flight guard → win spoiler on re-entry
**Files:** `public/slots3d.js:760`, `public/app.js:2537`  
**Issue:** v8 #3 fixed leave-during-await HUD; `syncTokenGameBalances` holds on-channel during bonus/spin. **`ensureSlots3dReady()` always calls `setBalance(TokenMode.tokens())`** on re-entry with no guard — server may have credited win while user was off-channel → HUD jumps to final total before reels settle.

**Fix for Claude:**
```javascript
// slots3d.js setBalance:
if (this._spinning || this._awaitingServer || this._bonus) return;

// ensureSlots3dReady ~2537: skip setBalance if in-flight flags set
```

---

#### #4 — `bjDockLive` too narrow — token felt self-heal can tear mid-hand
**Files:** `public/app.js:3829,3835-3838`  
**Issue:** `bjDockLive = placed > 0 || mode === "turn"` omits `insurance`, `dealing`, `dealer`, `settle`. Edge snapshots can clear `placed` while chips committed → self-heal strips iframe → disconnect grace auto-stand.

**Fix for Claude:**
```javascript
bjDockLive = !!(s && (
  s.placed > 0 || s.mode === "turn" || s.mode === "insurance" ||
  s.mode === "dealing" || s.mode === "dealer"
));
```

---

#### #5 — Unified demo re-seed on every BJ re-activation can overwrite table bank
**Files:** `public/app.js:3496`, `server/blackjack-server.js:714-738`  
**Issue:** Every `bjFramePost(true)` re-sends `bj:seed` with current `demoUsd`. Player leaves BJ (table $6,000), plays another demo game (bar → $4,000), re-enters BJ → seed **lowers** felt to $4,000. Surprising "chips vanished" UX.

**Fix for Claude:** Seed only on **first** felt load; on re-entry sync felt→bar via dock, not bar→felt. Or seed `Math.max(demoUsd, serverBank)` when rejoining.

---

#### #6 — Settle/recover can close session with open `crashRound` ledger marker
**Files:** `server/token-http.js:512-513`, `server/token-bridge.js:258-298`  
**Issue:** `doSettle`/`doRelease` gate on RAM `liveCrashSession()` only. SIGKILL orphan survives boot drain (`catch {}`) → player settles while `open:true crashRound` in `bets[]`. Tokens usually correct; would-be win forfeited; BJ blocked via `applyExternal` (#7).

**Fix for Claude:** Before `bridge.settle()`, call `finalizeOrphanRounds(s, -1)` or refuse settle while open crashRound exists.

---

### Low

#### #7 — Token BJ hard-blocked by ledger orphan (companion to #6)
**Files:** `server/token-bridge.js:239`, `server/token-http.js:900-905`  
**Fix:** Self-heal orphan in `applyExternal` when `!liveCrashSession` but open marker exists (same as v12.86 `finalizeOrphanRounds`).

---

#### #8 — Plane lacks visibility cash-out; Balloon Pop has it
**Files:** `public/pressure-ui.js:147` vs no equivalent in `plane-ui.js`  
**Issue:** Background tab on Plane manual token round keeps climbing until bust; Pressure auto-banks on hide. UX parity gap, not money bug.

---

#### #9 — Cache-bust drift: `pressure-ui.js` / `slots3d.js` still `?v=1283`
**Files:** `public/app.js:2319,2508` vs site `?v=1291`  
**Issue:** Stale CDN/browser cache risk for two bundles. Bump to `1291` on next public change.

---

#### #10 — Repo hygiene: unresolved merge conflict markers
**Files:** `AGENTS.md` (was conflicted at audit time)  
**Fix:** Resolve and keep single coordination log.

---

## v12.91 feature review — #94 crash disconnect-resume

| Invariant | Verdict |
|-----------|---------|
| No crashPoint leak on resume | ✅ `liveView()` omits point |
| Server-clock cashout cap | ✅ `crash-rounds.js:115` |
| No double-settle / double-debit | ✅ idempotent `_resolve` + same nonce |
| Offline bust = loss | ✅ `cr:noround` → bust resolve |
| Auth-gated resume | ✅ `crash-rounds-ws.js:140-150` |

**Client gap:** Plane #2 `undefined` crashPoint on `resumedGone` — cosmetic only.

---

## Owner-only (not code regressions)

| Ref | Sev | Item |
|-----|-----|------|
| O1 | Critical | V2 deploy gap — full stack still V1 `settleBlackjack`; cross-session lock drain (`test/pass4-exploits.test.js:144-185`) |
| O2 | High | On-chain staticCall cherry-pick on direct-bet games (mitigated by server-bridge path) |
| O3 | High | `startSession` id-squat DoS when V2 deployed without server binding |

**Contract source prep (c2bb824):** F1 EIP-2 low-s + F2 over-loss docstrings landed in source; **owner must redeploy** for live effect.

---

## Wave plan for Claude

### Wave 0 — Player-visible (ship first)
| # | Item |
|---|------|
| 0A | **#1** bjReload → `demoUsd` + probe green |
| 0B | **#2** Plane `resumedGone` safe message |
| 0C | **#3** slots3d setBalance in-flight guard |

### Wave 1 — Reliability
| # | Item |
|---|------|
| 1A | **#4** Widen `bjDockLive` |
| 1B | **#5** Demo re-seed policy (first-load only) |
| 1C | **#6–7** Orphan finalize before settle / applyExternal |

### Wave 2 — Polish
| # | Item |
|---|------|
| 2A | **#8–10** visibility parity, cache bump, hygiene |

---

## Hunt status

| Pass | Baseline | Critical money | High money | New actionable |
|------|----------|----------------|------------|----------------|
| v7 | v12.82 | 1 | 5 | 25 |
| v8 | v12.85 | 0 | 0 | 4 High client |
| **v9** | **v12.91** | **0** | **0** | **6 Med + 4 Low** |

Money Critical/High remains clean. Remaining work is demo UX, #94 plane copy, slots reveal hold, and orphan edge-case liveness.

---

## Rules

- **Do NOT re-file** v7/v8 Critical/High unless regression proven.
- Run full probe gate after fixes.
- Bump `?v=1292` on public changes.
