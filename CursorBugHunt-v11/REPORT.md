# Crypto TV — Bug Hunt v11 (Pass 14 — Harder Scan II)

**Baseline:** live **v12.91** (`?v=1291`, `ctf-v12.91`) @ deploy branch  
**Prior audit:** Pass 13 / v10 on v12.91 — 17 findings, 3 new High client/liveness  
**Method:** **5-stream adversarial audit** (fish epoch parity, slots3d off-channel sync, server HTTP edge cases, settle/recover deep paths, v10 regression sweep) + full probe gate

---

## Executive summary

**Money ledger: still 0 new Critical / 0 new High house-drain** on server happy path (5th consecutive clean pass).

**Pass 14 finds 1 new High + 5 new Medium + 3 Low** (#1–#9), plus **v10 carry-forward** (#10–#17). Focus is **cross-game guard parity** (fish vs plane/pressure) and **off-channel token HUD sync** gaps v10 did not cover.

Top new risks:
1. **Fish/Reef late token `.then` re-arms bonus off-channel** — no `_tokenEpoch` guard (#1)
2. **Gem Vault off-channel spin skips top token bar sync** (#2)
3. **Pressure HTTP void still bypasses round-runner floor** — pre-existing edge drain (#3, verified open)

v10 Wave 0 items (#94 cold resume, launch ack race, reef splash) **remain open** on v12.91.

---

## Probe gate (v12.91)

| Probe | Result |
|-------|--------|
| v2–v10 full gate | ✅ |
| **`CursorBugHunt-v11/fish-token-epoch-probe.js`** | ❌ documents #1 |
| **`CursorBugHunt-v11/slots3d-offchannel-bar-probe.js`** | ❌ documents #2 |
| npm test | ✅ 35/35 |

---

## Pass 14 findings — with fix suggestions for Claude

### High

#### #1 — Fish/Reef token bet `.then` missing epoch guard (off-channel bonus re-arm)
**Files:** `public/fishtable.js:384-394`, `public/fishshooter.js:439-459`, contrast `public/plane-ui.js:349-365`, `public/pressure-ui.js:274-287`  
**Issue:** Plane and Balloon Pop bump `_realEpoch` / `_tokenEpoch` on channel leave and bail in async `.then/.catch` when superseded. Reef and Fish Shooter **do not**. A token bet in flight that returns after `setActive(false)` still runs `_startTokenBonus`, updates balance, and may leave `_frenzy > 0` / `_chest` active while `_active === false` and the ticker is stopped. Re-entering the channel surfaces a surprise bonus/frenzy with inconsistent HUD.

**Repro (Reef):**
1. Token mode, shoot a bonus-trigger fish.
2. Switch to Gem Vault before the HTTP bet returns.
3. Late `.then` fires → `_startTokenBonus` / `_startFrenzy` while off-channel.
4. Return to Reef → unexpected frenzy UI; top bar may disagree with canvas.

**Repro (Fish Shooter):** Same at `fishshooter.js:453` (Fish Shooter calls `_teardownRounds` on leave but does not invalidate in-flight `.then`).

**Fix for Claude:**
```javascript
// fishtable.js + fishshooter.js — mirror pressure-ui.js:
// 1) this._tokenEpoch = 0 in constructor
// 2) on setActive(false): this._tokenEpoch = (this._tokenEpoch || 0) + 1;
// 3) in TokenMode.bet(...).then/.catch:
const epoch = this._tokenEpoch;
// ...
if (epoch !== self._tokenEpoch || !self._active) { /* optional: paintTokens only */ return; }
```
**Probe:** `CursorBugHunt-v11/fish-token-epoch-probe.js`

---

### Medium

#### #2 — Gem Vault off-channel token spin skips top token bar sync
**Files:** `public/slots3d.js:304-307` vs `public/fishtable.js:393`  
**Issue:** When a token spin resolves off-channel, the `.then` branch updates canvas `balance` and `_renderHud()` but never calls `TokenMode.paintTokens()` or `syncBalance()`. Reef/fish already sync the top bar on the same beat. Server ledger is correct; **top token bar lies** until another sync path runs.

**Repro:**
1. Token mode, Gem Vault, SPIN.
2. Switch channel before grid returns.
3. Top bar shows pre-spin balance; canvas (if visible) or re-entry HUD shows server truth.

**Fix:** In the `!self._active` branch after `self.balance = TM.tokens()`:
```javascript
if (root.TokenMode && root.TokenMode.paintTokens) root.TokenMode.paintTokens();
```
**Probe:** `CursorBugHunt-v11/slots3d-offchannel-bar-probe.js`

---

#### #3 — Pressure HTTP `/play` void window still bypasses round-runner (edge drain)
**Files:** `server/games/pressure.js:109-119`, `server/token-http.js:416-429`  
**Status:** **Pre-existing** (`CursorBugHunt/REPORT.md` #62); **verified still open on v12.91**  
**Issue:** WS Balloon Pop uses `cr:start` → `crash-rounds.js` with `gameFloor(pressure)=1.20`. HTTP `doPlay(game=pressure)` calls `pressure.play()` directly; `cashOutAt < 1.20` **refunds full stake** (100% RTP on filtered plays). UI path is safe; **direct API abuse** drains ~3% house edge on pressure handle.

**Fix:** Reject `game=pressure` on HTTP `doPlay`, OR treat sub-1.20× as bust (payout 0), OR route through `crash-rounds` reserve/resolve.

---

#### #4 — Gem Vault `setActive(false)` during `_awaitingServer` can flash pre-debit HUD
**Files:** `public/slots3d.js:286-287,747-752`  
**Issue:** `_spinToken` debits canvas mirror immediately; `TokenMode.bet` is async. Leaving during the round-trip sets `balance = TokenMode.tokens()` **before** server debit lands → brief inflated HUD (~100–500ms) until `.then` reconciles. v8 #3 fixed steady-state off-channel; this is the **transient window**.

**Fix:** On `_awaitingServer` leave, keep showing `balance - bet` until `.then`, or skip `setBalance` until bet resolves.

---

#### #5 — HTTP `clientSeed` still uncapped (CPU DoS)
**Files:** `server/token-http.js:416-428`, `server/token-bridge.js:180`, contrast `server/crash-rounds-ws.js:97`  
**Status:** Pre-existing (#58); verified open  
**Issue:** WS crash caps seeds at 256 chars; HTTP `doPlay` and `bridge.play()` accept unbounded `clientSeed` → synchronous HMAC over multi-MB strings per request.

**Fix:** Cap `clientSeed.length <= 256` in `doPlay` and `bridge.play()`.

---

#### #6 — `demoSyncBalance()` ReferenceError on `paintSession(force)`
**Files:** `public/app.js:3037-3039`  
**Status:** v10 #4 carry-forward  
**Issue:** `force` is undefined → strict-mode `ReferenceError`, swallowed → demo session tracker freezes.

**Fix:** Remove `force` or add parameter `demoSyncBalance(reanchor)`.

---

### Low

#### #7 — Fish games `setBalance` missing mid-round guard (plane/pressure parity)
**Files:** `public/fishtable.js:953`, `public/fishshooter.js:1061` vs `public/plane-ui.js:515-519`  
**Issue:** `syncTokenGameBalances` hold can be clobbered off-channel during `_tokenRevealUntil`. Display timing only.

---

#### #8 — BJ Reload toast says "$1,000" but `BJ_START` is $5,000
**Files:** `public/app.js:5123`, `BJ_START=5000` at `:3506`  
**Issue:** Misleading toast after guest reload.

---

#### #9 — `bjReload` guest seed still uses `BJ_START` not unified `demoUsd`
**Files:** `public/app.js:3611` vs `bjFramePost` at `:3496`  
**Status:** v9 #1 / v10 #13 carry-forward  
**Probe:** `CursorBugHunt-v9/bj-reload-demo-probe.js`

---

## v10 carry-forward (still open — do not re-file as new)

| v10 | Item | Status |
|-----|------|--------|
| #1 | Cold crash resume (`live=null` after F5) | OPEN |
| #2 | Launch ack window channel switch | OPEN |
| #3 | Reef token bomb/chain splash client-kill | OPEN |
| #4–#12 | Guest hijack, wallet norm, fish betUnits, orphan settle, multi-tab, etc. | OPEN |
| #13 | v9 deferred (BJ reload, plane UX, slots3d re-entry, bjDockLive) | OPEN |

Pass 14 **does not regress** v10 fixes; probe gate green on v2–v9.

---

## Owner-only (unchanged)

| Ref | Item |
|-----|------|
| O1 | V2 deploy / cross-session `bjLocked` drain |
| O2 | On-chain staticCall cherry-pick |
| O3 | Contract F1/F2 redeploy (source c2bb824) |

---

## Wave plan for Claude

### Wave 0 — v10 High (ship first if not already done)
| # | Item |
|---|------|
| 0A | v10 #1 Cold crash resume + fix plane false refund |
| 0B | v10 #2 Defer token-flying until `cr:started` |
| 0C | v10 #3 Reef splash/chain visual-only guard |

### Wave 1 — Pass 14 new
| # | Item |
|---|------|
| 1A | **#1** Fish/Reef `_tokenEpoch` guard + probe green |
| 1B | **#2** slots3d off-channel `paintTokens` + probe green |
| 1C | **#3** Block or fix pressure HTTP void |
| 1D | **#5** Cap HTTP `clientSeed` length |

### Wave 2 — Reliability + v10 Medium
| # | Item |
|---|------|
| 2A | **#4–#6**, v10 #4–#9 |
| 2B | v9 continuity (#9), **#7–#8** polish |

---

## Hunt comparison

| Pass | Method | New High | Money Critical/High |
|------|--------|----------|---------------------|
| v10 | 4-stream adversarial + concurrency | 3 | 0 |
| **v11** | **5-stream + cross-game parity sweep** | **1** | **0** |

Harder scan II found **real guard-parity gaps** in fish/slots3d without reopening money Critical/High on ledger.

---

## Rules

- Run full probe gate; v11 probes must PASS (invert) after Wave 1.
- Bump `?v=1292` on public changes.
- Do NOT re-file v7/v8 money fixes unless regression proven with `git show HEAD:<file>`.
