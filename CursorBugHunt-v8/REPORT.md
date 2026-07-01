# Crypto TV — Bug Hunt v8 (Pass 11)

**Baseline:** live **v12.85** (`?v=1285`, `ctf-v12.85`) @ `5985d43` on `claude/ethereum-betting-game-vrf-2dq50k`  
**Prior audit:** Pass 10 / v7 on v12.82 — Claude shipped **v12.83–v12.85** (all v7 Critical/High money fixes + safe LOWs)  
**Method:** v7 regression crosswalk → **4-stream deep audit** → **2 money sweeps** → probe gate

---

## Executive summary

**Pass 11 verdict: CLEAN on money Critical/High.** No new house-drain, double-spend, or stake-theft paths found.

**v7 regression:** 1 Critical + 5 High **FIXED**; 1 High **PARTIAL** (#8 slots3d PF panel — transparency only, no miscredit).

**Pass 11 finds 4 High client/reliability items** (#1–#4): **0 Critical**, **4 High**, **0 new Medium money bugs**. Money-path second sweep explicitly signed off.

Top remaining player-visible risks:
1. **Balloon Pop stuck** after leaving mid-token-round (#1)
2. **Token bar desync** when `cr:result` arrives after channel leave (#2)
3. **Gem Vault stale balance** if leaving during `_awaitingServer` (#3)
4. **Persisted crash orphan** can stack reservations if boot drain fails (#4 — edge case)

**Stop condition met:** Two independent money sweeps found **0 Critical / 0 High** on ledger paths. Remaining High items are client UX / edge-case liveness, not systemic house drain.

---

## Probe gate (v12.85)

| Probe | Result |
|-------|--------|
| v2 crash-reserve / liveness / adversarial | ✅ |
| v3 BJ-interleave / wave1 / wave2 | ✅ |
| v4 inverse / orphan-drain | ✅ |
| v5 pending-settle-key | ✅ |
| v6 plane-token-stuck | ✅ fix verified |
| v7 pressure-drain | ✅ fix verified (v12.83) |
| **`CursorBugHunt-v8/pressure-leave-stuck-probe.js`** | ❌ documents #1 |
| npm test | ✅ 33/33 |

---

## v7 regression crosswalk (v12.82 → v12.85)

| # | Item | v7 Sev | Status |
|---|------|--------|--------|
| 3 | pressure `drain()` VOID-refund | Critical | **FIXED** v12.83 |
| 1 | BJ `handBet` / `bjDockLive` | High | **FIXED** v12.84 |
| 2 | BJ reload bypass | High | **FIXED** v12.84 |
| 5 | Reef frenzy instant end | High | **FIXED** v12.84 |
| 6 | Reef pending-cost guard | High | **FIXED** v12.84 |
| 4 | Plane setBalance mid-flight | Medium | **FIXED** v12.84 |
| 8 | slots3d PF verify mismatch | High | **PARTIAL** — money uses server `baseWin`; PF panel still HMAC vs `PF.floats` |
| 7 | Gem Vault bonus HUD hold | Medium | **FIXED** v12.85 |
| 13 | token TV reveal seq guard | Medium | **FIXED** v12.85 |
| 14 | chat NFKC normalize | Medium | **FIXED** v12.85 |
| 18 | BJ cancelBet grief | Low | **FIXED** v12.85 |

**Scorecard:** Critical 1/1 FIXED · High 5/6 FIXED · 1/6 PARTIAL (transparency only)

---

## Money-path sign-off (Pass 11)

Two independent sweeps reviewed: `token-bridge.js`, `token-http.js`, `crash-rounds.js`, all `server/games/*`, blackjack token paths, redeploy drains, params stake override, verifyRederive, gcClosed/tombstones.

| Category | Result |
|----------|--------|
| Critical (house drain / double-spend) | **0 new** |
| High (stake loss without ledger outcome) | **0 new** on happy path; **#4** edge case if boot orphan drain silently fails |
| Regressions vs v7 fixes | **0** |

Confirmed still fixed: pressure drain floor, slots stake-override, reef power clamp, bridge `PAYOUT_CAP`, dice throw parity, BJ↔crash inverse guard.

---

## Pass 11 findings — with fix suggestions for Claude

### High

#### #1 — Balloon Pop stuck after leaving mid-token-round
**Files:** `public/pressure-ui.js:363-369,477-484,282-284`  
**Issue:** `setActive(false)` calls `_release()` for token mode, which only sends `onTokenCashOut()` and **returns without clearing** `pressing` / `state === "inflating"`. Epoch is bumped; `CrashRounds.cancel()` drops the promise; `.then` bails on epoch mismatch **without cleanup**. User returns to Balloon Pop → UI stuck on "TAP TO BANK"; `_press` blocked.

**Contrast:** Plane resets via `_startTokenIdle()` at `plane-ui.js:488-496`.

**Fix for Claude:**
```javascript
// pressure-ui.js setActive(false), after _release / epoch bump:
if (!on && (this.pressing || this.state === "inflating")) {
  this.pressing = false;
  this.state = "armed";
  this._roundToken = false;
  this.r.reset();
  if (this._b3d) this._b3d.reset();
  this._msg(this._idlePrompt());
  this._renderHud();
  try { if (root.TokenMode && root.TokenMode.refreshTokens) root.TokenMode.refreshTokens(); } catch (e) {}
}
```
**Probe:** `CursorBugHunt-v8/pressure-leave-stuck-probe.js`

---

#### #2 — Token bar desync after channel-switch mid crash-family round
**Files:** `public/crash-rounds-client.js:135-142`, `public/app.js:3454-3459`  
**Issue:** Leave during live token round → game calls `onTokenCashOut()` → `switchGame` calls `CrashRounds.cancel()` → `live = null`. When `cr:result` arrives, `onResult` drops it (`if (!live) return`). Server ledger correct; **client `TokenMode.tokens()` stale** until manual refresh.

**Fix for Claude (pick one or combine):**
```javascript
// crash-rounds-client.js onResult — orphan settle hook:
function onResult(msg) {
  if (!live) {
    if (msg.tokens != null && onOrphanSettle) try { onOrphanSettle(msg); } catch (e) {}
    return;
  }
  // ... existing ...
}
// app.js wire onOrphanSettle → TokenMode.syncTokens(msg.tokens)
```
Or: `switchGame` after `CrashRounds.cancel()`, call `TokenMode.refreshTokens()` when token session active.

---

#### #3 — Gem Vault stale token bar if leaving during server round-trip
**Files:** `public/slots3d.js:734-741`, `public/app.js:2537`  
**Issue:** Leaving channel while `_awaitingServer === true` clears spin flags but **does not** re-anchor from `TokenMode.tokens()`. Server may have debited/credited; client cache stays pre-bet until re-entry.

**Fix for Claude:**
```javascript
// slots3d.js setActive(false), _awaitingServer branch:
this._awaitingServer = false; this._spinning = false; this.state = "idle";
if (root.TokenMode && root.TokenMode.active()) {
  this.balance = root.TokenMode.tokens();
  try { root.TokenMode.refreshTokens(); } catch (e) {}
}
this._renderHud(); this._renderSpinBtn();
```

---

#### #4 — Persisted crash orphan can stack reservations (edge case)
**Files:** `server/crash-rounds.js:52`, `server/token-bridge.js:403-422,458-465`, `server/token-http.js:416-422`  
**Issue:** `startRound()` blocks only on **RAM** `activeBySession`, not ledger `open:true crashRound`. Boot `drainOrphanReservations()` usually clears orphans, but failures are swallowed (`catch (e) {}`). If drain no-ops, second `cr:start` debits another stake while first orphan stays open. `doPlay` checks `liveCrashSession()` (RAM only), not ledger open marker (unlike `applyExternal` at `token-bridge.js:238`).

**Exploit scenario:** SIGKILL mid-round → restart → silent orphan drain fail → new crash round → double debited stake, first bet orphaned. Rare; boot drain + orphan-drain-probe cover normal redeploy.

**Fix for Claude:**
```javascript
// In reserve() or startRound(), before debiting:
if (s.bets.some(b => b && b.kind === "crashRound" && b.open))
  throw new Error("pending crash reservation — finish or recover first");
// Mirror in doPlay after liveCrashSession check.
```
Add self-test: persist open crashRound, skip drain, assert second startRound throws.

---

## Deferred (not Critical/High — do not block ship)

| Ref | Item | Note |
|-----|------|------|
| v7 #8 | slots3d PF panel parity | Transparency only; server credits authoritative |
| v5 #2 | pendingSettle player-only key | Single-chain prod + branch 2b backstop |
| v7 #10/#11 | tombstone delete / openByPlayer heal | Claude rejected as unsafe-as-suggested |
| O1–O6 | V2 deploy, VRF, registry | Owner-only |

---

## Wave plan for Claude

### Wave 0 — Client stuck/desync (ship first)
| # | Item |
|---|------|
| 0A | **#1** Pressure leave reset + probe green |
| 0B | **#2** Orphan `cr:result` → sync tokens |
| 0C | **#3** Slots `_awaitingServer` leave sync |

### Wave 1 — Edge-case hardening
| # | Item |
|---|------|
| 1A | **#4** Ledger-open crashRound guard in `reserve()` + `doPlay` |

---

## Hunt termination rationale

Per user request to continue until no Critical/serious bugs:

| Pass | Critical money | High money | High client |
|------|----------------|------------|-------------|
| v7 (v12.82) | 1 (#3 drain) | 5 | — |
| v7 fixes (v12.83–85) | 0 | 0 | — |
| **v8 (v12.85)** | **0** | **0** (1 edge #4) | **4** |

**Next hunt warranted after Wave 0 client fixes land** — not for money Critical/High (currently clean).

---

## Rules

- **Do NOT re-file** v7 Critical/High unless regression proven.
- Run full probe gate; **`pressure-leave-stuck-probe.js` must PASS** after #1.
- Bump `?v=1286` on public changes.
