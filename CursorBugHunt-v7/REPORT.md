# Crypto TV — Bug Hunt v7 (Pass 10)

**Baseline:** live **v12.82** (`?v=1282`, `ctf-v12.82`) @ deploy branch `claude/ethereum-betting-game-vrf-2dq50k`  
**Prior audit:** Pass 9 / v6 on v12.69 — Claude shipped **v12.70–v12.82** (plane stuck, bjDockLive, seedGuest cap, ETH sanity, WS per-IP, Reef power clamp, slots stake-override, bridge payout cap, admin sig expiry, client freeze fixes, tombstone compaction)  
**Method:** Full probe gate → **8-stream deep audit** → v6 regression crosswalk → fresh numbering + **fix suggestions for Claude**

---

## Executive summary

**v6 Wave 0–1 fixes largely held** (24/34 FIXED, 4 PARTIAL, 6 STILL OPEN, **0 REGRESSIONS** on money invariants). Probe gate **13/13 green** (including updated plane probe).

**Pass 10 finds 25 actionable items** (#1–#25): **1 Critical**, **5 High**, **12 Medium**, **7 Low**. Plus **6 owner-only** carry-forward.

Top real-world risks for players:
1. **Pressure `drain()` on redeploy** floors to crash 1.01× not 1.20× → VOID-refund on SIGTERM (#3)
2. **`handBet` never cleared** after BJ hand → `bjDockLive` stuck → token felt won't rebind (#1)
3. **BJ reload paths bypass `bjDockLive`** → mid-hand iframe tear-down (#2)
4. **Reef token frenzy ends instantly** — bonus flash then immediate end (#5)
5. **slots3d PF verify broken** in token mode — client/server derivation diverge (#8)
6. **Plane `setBalance()` mid-flight** can visually "refund" stake (#4)

Every finding below includes a **Fix for Claude** block agents can execute directly.

---

## Probe gate (v12.82)

| Probe | Result |
|-------|--------|
| v2 crash-reserve / liveness / adversarial | ✅ |
| v3 BJ-interleave / headers / wave1 / wave2 | ✅ |
| v4 inverse / verify-rederive / orphan-drain | ✅ |
| v5 pending-settle-key | ✅ (documents deferred composite key) |
| **`CursorBugHunt-v6/plane-token-stuck-probe.js`** | ✅ **FIX VERIFIED** (v6 #2 landed) |
| **`CursorBugHunt-v7/pressure-drain-probe.js`** | ❌ **FAIL** — documents #3 gap |
| npm test + server self-tests | ✅ 33/33 |

---

## v6 regression crosswalk (summary)

| Status | Count | Notes |
|--------|-------|-------|
| **FIXED** | 24 | Plane stuck, seedGuest cap, ETH sanity, WS per-IP, bjDockLive self-heal, ipGuard, tombstone compaction, fish paid-splash, pressure double-tap latch, admin expiry, etc. |
| **PARTIAL** | 4 | #7 guest DoS hardening, #12 Reef burst-fire, #14 fish expDraw tail, #20 stranded lock UI |
| **STILL OPEN** | 6 | #9 crash disconnect bust (by design), #13 slots3d PF, #22 onBalance demoUsd, #30 storeInfo path, #31 usedBuyIns, plus #23 reveal seq (sync only) |
| **REGRESSION** | 0 | Money path invariants hold |

**v5 #2 (pendingSettle player-only key)** remains **PARTIAL** — branch 2b backstop intact.

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Exploit / systematic house drain |
| **High** | Real-money loss, stuck gameplay, or major security |
| **Medium** | Reliability, DoS, UX money confusion |
| **Low** | Polish, demo-only, cosmetic |

---

## Pass 10 findings — with fix suggestions for Claude

### Critical

#### #3 — `crash-rounds.js` `drain()` uses crash 1.01× floor for pressure rounds
**Files:** `server/crash-rounds.js:27-32,173-175`  
**Issue:** `gameFloor()` exists and is used in `cashOut()` / `_resolve()`, but **`drain()` hardcodes `crashEngine.MIN_TARGET_X` (1.01)**. On SIGTERM/redeploy, an in-flight pressure round drained at 1.01–1.19× settles via `pressure.play()` as **VOID refund** (stake returned, net 0) instead of a loss — systematic house drain. Comment at lines 27–31 documents the bug; code not fixed.

**Fix for Claude:**
```javascript
// In drain(), replace line 173:
const floor = gameFloor(round.gameKey);
if (round.gameKey === "pressure") {
  if (m < floor) { outs.push(_resolve(round, 0, true)); continue; }
} else if (m < floor) {
  m = floor;
}
```
Add CLI self-test: start pressure round, drain at m=1.05 → must bust (tokens down), not VOID-refund.  
**Probe:** `CursorBugHunt-v7/pressure-drain-probe.js` → should PASS after fix.

---

### High

#### #1 — `handBet` never cleared → stale `bjDockLive` blocks token felt rebind
**Files:** `public/blackjack-ui.js:89,477-480,228,524`; `public/app.js:3807,3552`  
**Issue:** `handBet` is set on `bj:turn` but **never cleared** on settle or new betting window. After first hand, parent sees `handBet > 0` with `placed=0` → `bjDockLive=true` → `ensureBlackjackReady()` refuses iframe reload → buy-in can't bind `#bjsession` until page reload.

**Fix for Claude:**
```javascript
// blackjack-ui.js _resetRoundVis:
this.handBet = 0; this.legal = []; this.needFunds = [];

// _onSettle (after _clearActWatch):
this.handBet = 0; this.legal = []; this.needFunds = [];

// _emitDock defense-in-depth:
handBet: (isMyTurn ? (this.handBet || 0) : 0),

// app.js renderBjDock — simpler belt-and-suspenders:
bjDockLive = !!(s && (s.placed > 0 || s.mode === "turn"));
```

---

#### #2 — BJ iframe reload paths bypass `bjDockLive` guard
**Files:** `public/app.js:915,3115` vs guarded `3813,3552`  
**Issue:** `renderWallet()` and `syncTokenGameBalances()` call `f.removeAttribute("src")` **before** `ensureBlackjackReady()`, bypassing the entry guard. Mid-hand iframe tear-down → WS disconnect grace → auto-stand.

**Fix for Claude:**
```javascript
// ~915 — delegate to central guard, never drop src directly:
{ const f = $("bj-frame"); if (f && !bjFrameMatchesWallet(f, account) && currentGame === "blackjack") ensureBlackjackReady(); }

// ~3115 — same pattern:
if (currentGame === "blackjack" && account && Date.now() - bjHealAt > 1500) {
  const f = $("bj-frame");
  if (f && f.getAttribute("src") && !bjFrameMatchesWallet(f, account)) {
    bjHealAt = Date.now();
    ensureBlackjackReady();
  }
}
```

---

#### #5 — Reef token frenzy ends instantly when server total ≥ budget
**Files:** `public/fishtable.js:623-624,639`  
**Issue:** On token frenzy start, `_frenzyWon` is set to the **full** `_tokenWaveTotal` (~25× bet). `_frenzyBudget` is also ~25× bet. First `_updateFrenzy` tick sees `_frenzyWon >= _frenzyBudget` → immediate `_finishFrenzy(true)`. Fish Shooter correctly starts at 0 and climbs.

**Fix for Claude:**
```javascript
// _startFrenzy — match fish-shooter:
if (this._tokenActive()) { this._frenzyWon = 0; this._tokenWavePaid = 0; }
// Increment _tokenWavePaid per cosmetic catch during free shots; end when paid >= total or timer expires.
```

---

#### #6 — Reef missing fish-shooter pending-cost guard
**Files:** `public/fishtable.js:330` vs `public/fishshooter.js:391-394`  
**Issue:** Reef only checks `balance < cost` before firing. Token mode debits on **hit**, not fire — rapid tap queues more paid shots than balance covers (server rejects; bad UX).

**Fix for Claude:** Port fish-shooter pending loop into `FishTable.prototype._fire`:
```javascript
if (!free && this._tokenActive()) {
  var pend = 0;
  for (var pi = 0; pi < this.bullets.length; pi++) {
    var pb = this.bullets[pi];
    if (pb && !pb.free && !pb.hit && (pb.cost || 0) > 0) pend += pb.cost;
  }
  if (this.balance < cost + pend) { this._flashBanner("EASY!", "let your shots land", 0xffd23f); return; }
}
```

---

#### #8 — slots3d token/PF verify mismatch (extends v6 #13)
**Files:** `server/games/slots3d.js:83-90`, `public/slots3d-engine.js:153-155`, `public/slots3d.js:702-707`  
**Issue:** Server derives grid via `PF.floats(serverSeed, clientSeed, nonce, 5)`; client uses single HMAC → different grids. Token mode uses local `randomSeed` + local nonce — verify always shows **⚠️ mismatch**. Money path OK (server `baseWin`); PF UI broken.

**Fix for Claude:**
1. Align client `deriveGrid` with server `PF.floats` (shared module preferred).
2. Token mode: show session `commit`; verify post-cash-out with server nonce from bet response.
3. Compare server `outcome.baseWin`, not client re-derive.

---

### Medium

#### #4 — Plane `setBalance()` no in-flight guard during `token-flying`
**Files:** `public/plane-ui.js:515-519`, `public/app.js:3078` vs `public/pressure-ui.js:461-465`  
**Issue:** `TokenMode.onChange` → `syncTokenGameBalances()` always calls `planeGame.setBalance(pbBal)` even mid-flight. Plane locally debits stake at launch; stale server cache can visually "refund" stake. Pressure guards `state === "inflating"`.

**Fix for Claude:**
```javascript
// plane-ui.js setBalance:
if (this.state === "token-flying" || this.state === "flying" || this.state === "takeoff" || this.state === "real-flying") return;

// app.js — mirror pressure pattern:
if (planeGame.state !== "token-flying" && planeGame.state !== "flying" && planeGame.state !== "takeoff") {
  planeGame.setBalance(pbBal);
}
```

---

#### #7 — slots3d bonus reveal-hold missing Gem Vault in `syncTokenGameBalances`
**Files:** `public/app.js:3101-3107`, `public/slots3d.js:424-430`  
**Issue:** Fish games hold HUD during bonus/reveal; Gem Vault (`slots3dGame`) is in the same `forEach` but hold applies only when `onFishChan`. Mid free-spin poll reveals full server-credited total.

**Fix for Claude:**
```javascript
var onS3d = (g === slots3dGame && currentGame === "slots3d");
var inBonus = (onFishChan && (...)) || (onS3d && !!(g._bonus || g._spinning || g._awaitingServer));
var holdingReveal = (onFishChan && (...)) || (onS3d && inBonus);
```

---

#### #9 — `seedGuest` per-call max / cooldown asymmetry vs `topUp`
**Files:** `server/blackjack-server.js:407-413,703-706`  
**Issue:** v6 #1 fixed standing cap (`GUEST_BAL_CAP=25000`). Residual: guest can jump 0→25k in one `bj:seed` (vs $5k/call via `topUp`); no cooldown → `.bj-bank.json` spam.

**Fix for Claude:**
```javascript
function seedGuest(sock, amount) {
  // ... existing guards ...
  if (sock._lastGuestSeed && now() - sock._lastGuestSeed < GUEST_TOPUP_COOLDOWN) return;
  sock._lastGuestSeed = now();
  const cur = bank.get(w);
  const want = r2(Math.max(0, Math.min(GUEST_BAL_CAP, +amount || 0)));
  const delta = r2(Math.min(GUEST_TOPUP_MAX, Math.max(0, want - cur)));
  if (delta <= 0) return;
  bank.all.set(w, r2(Math.min(GUEST_BAL_CAP, cur + delta)));
}
```

---

#### #10 — Loss tombstones kept forever after on-chain nonce consumed
**Files:** `server/token-bridge.js:120-129`, `server/token-http.js:639`  
**Issue:** v6 #6 compacts `bets[]` on win/push GC but **never deletes** settled-loss tombstones after `obligationConsumed()`. Map/file grows without bound per player.

**Fix for Claude:** In `gcClosed` or post-`obligationConsumed`, delete tombstone session when settlement nonce is consumed on-chain and `bjLocked == 0`.

---

#### #11 — net=0 limbo GC orphans `openByPlayer` → blocked buy-in
**Files:** `server/token-bridge.js:137`, `server/token-http.js:344,625`  
**Issue:** Bridge GC deletes net=0 limbo sessions after TTL but HTTP layer doesn't sweep `openByPlayer`. Stale entry blocks `doStart` until manual Recover.

**Fix for Claude:** In `doStart` (inside `withPlayerLock`): if `openByPlayer.has(player)` but `!bridge.session(sid) || (s.closed && !obligation)`, clear stale entry + `saveHttp()`.

---

#### #12 — `dice.js` voids stake on invalid line; `dice2` throws
**Files:** `server/games/dice.js:112-125`, `server/games/dice2.js:83-89`, `server/token-bridge.js:191-195`  
**Issue:** Invalid dice line → void loss (stake consumed). Invalid dice2 → throw (stake preserved). Direct `/play` API bypasses UI clamps.

**Fix for Claude:** Make `dice.js` throw on invalid line (match dice2 contract).

---

#### #13 — `tokenDice`/crash/slots `TV.reveal*` without pre-await `TV._seq` guard
**Files:** `public/app.js:3339-3394` vs `1716-1751` (`tokenFlip`)  
**Issue:** v6 #23 fixed **syncBalance timeout** seq guard only. If player changes channel during `await TokenMode.bet`, late `TV.revealDice/Crash/Slots` still runs and hijacks TV back to old game.

**Fix for Claude:** Mirror `tokenFlip`:
```javascript
lockReveal();
const seq = TV._seq;
let r;
try { r = await TokenMode.bet(...); }
catch (e) { unlockReveal(); if (TV._seq === seq) TV.idle(...); return; }
if (TV._seq !== seq) { unlockReveal(); return; }
TV.revealDice(...);
```

---

#### #14 — Chat Unicode / homoglyph display name spoofing
**Files:** `server/server.js:534-544`, `public/app.js:4306-4325`  
**Issue:** Client-supplied `name` rendered via safe `textContent` but no normalization — Cyrillic homoglyphs can mimic `0x2F4B…aB39`. 👁 reveal mitigates but many users won't use it.

**Fix for Claude:** Server: NFKC + allowlist or strip bidi/ZWSP; optionally ignore client `name` and use server profile store.

---

#### #15 — WS Origin fail-open on missing/malformed Origin
**Files:** `server/server.js:426-436`  
**Issue:** Missing `Origin` → allowed (non-browser). Parse failure → `catch` returns `true`. Intentional for dev but CSWSH risk in prod.

**Fix for Claude:** `WS_STRICT_ORIGIN=1` in prod — reject missing/malformed Origin; keep fail-open only in dev.

---

### Low

#### #16 — `renderFeed` uses `innerHTML` (hygiene)
**Files:** `public/app.js:4547-4569`  
**Issue:** No practical exploit (`who` is hex-derived), but inconsistent with `textContent` elsewhere.

**Fix for Claude:** Build DOM with `createElement` + `textContent`, or pipe `who` through `escapeHtml()`.

---

#### #17 — Admin signature expiry: legacy no-expiry sigs still accepted
**Files:** `server/token-http.js:698-706`  
**Issue:** v12.82 #19 shipped expiry for admin-release/player. When `body.expiry` omitted, legacy sigs verify — captured pre-v12.82 admin sigs replayable until rotated.

**Fix for Claude:** After deprecation window, **require** expiry on admin endpoints; add CI probe for expired/future rejection.

---

#### #18 — BJ `cancelBet` table-delay grief
**Files:** `server/blackjack-server.js:664-668,675-685`  
**Issue:** Cancel resets full 15s betting window even when other seats have bets, delaying table start.

**Fix for Claude:** If other seated players have bets, re-arm 3s grace instead of full 15s; rate-limit cancel per seat (2s).

---

#### #19 — Fish bonus-wave splash still uses client RNG (residual v6 #25)
**Files:** `public/fishshooter.js:547-560`  
**Issue:** Paid token path fixed. During **free bonus waves** (`shot.free`), client `_splashRoll` still drives cosmetic despawn. Payout capped by server — UX/reveal pacing only.

**Fix for Claude:** Token mode: all splash/chain despawn cosmetic-only (like paid path).

---

#### #20 — `onBalance` can overwrite `demoUsd` mid-canvas round (v6 #22)
**Files:** `public/app.js` (TokenMode.onChange handlers)  
**Issue:** Handlers gate on live `TokenMode.active()`, not round-scoped flag — session ending mid-canvas can clobber demo balance display.

**Fix for Claude:** Round-scoped `_demoRoundActive` latch; skip `setBalance` on onChange when latch set.

---

#### #21 — `/api/token/status` leaks raw filesystem path (v6 #30)
**Files:** `server/server.js:195-197`, `server/token-http.js` `storeInfo()`  
**Fix for Claude:** Omit raw path from public `storeInfo()` response.

---

#### #22 — `usedBuyIns` Set grows without compaction (v6 #31)
**Files:** `server/token-http.js:215-250`  
**Fix for Claude:** Rolling 90-day window or cap+LRU on boot; on-chain `bjNonceUsed` is authoritative replay guard.

---

#### #23 — Residual BJ felt hardcodes `ETH_USD=3400` (v6 #29)
**Files:** `public/blackjack-ui.js:15`  
**Fix for Claude:** Parent posts live rate via `bj:rate` postMessage.

---

#### #24 — Empty betting loop spins 5min (v6 #27)
**Files:** `server/blackjack-server.js:271-276`  
**Fix for Claude:** After N empty betting windows → `phase=idle`.

---

#### #25 — PAYOUT_CAP slots3d (600×) — verify bonus tail
**Files:** `server/token-bridge.js:55-67`  
**Issue:** Inline comment says sampled max ~188×; with 20 free spins × 2× multiplier tail could theoretically exceed 600×. Unlikely in practice but worth Monte Carlo verification.

**Fix for Claude:** Run max-multiplier probe on bonus paths; raise cap if measured max + margin exceeds 600×.

---

## Owner-only (neither AI — document, don't count as code regressions)

| Ref | Item | Fix owner action |
|-----|------|------------------|
| O1 | V2 not deployed | Deploy `CoinFlipBettingV2` + rewrite bridge `sessionId` in settlement digest |
| O2 | Bridge signer ≠ V2 `settleSession` | Thread `sessionId` through `realmoney.js` + `token-bridge.settle` |
| O3 | On-chain `eth_call` / prevrandao | Commit-reveal or VRF migration |
| O4 | GameRegistry artifact stale | Regen `public/contract.js` with zero-guard |
| O5 | `render.yaml` deploys feature branch | Pin prod to protected branch |
| O6 | EIP-7702 vs `_betGuard` | Strategic: replace `tx.origin` guard |

---

## Wave plan for Claude agents

### Wave 0 — Money / stuck gameplay (ship first)
| # | Item |
|---|------|
| 0A | **#3** pressure `drain()` floor + probe green |
| 0B | **#1** clear `handBet` / fix `bjDockLive` |
| 0C | **#2** BJ reload paths delegate to `ensureBlackjackReady` |
| 0D | **#5** Reef token frenzy start at 0 |
| 0E | **#6** Reef pending-cost guard |

### Wave 1 — Games / client
| # | Item |
|---|------|
| 1A | **#4** Plane setBalance in-flight guard |
| 1B | **#7** Gem Vault bonus HUD hold |
| 1C | **#13** token TV reveal seq guards |
| 1D | **#8** slots3d PF parity |

### Wave 2 — HTTP / hardening
| # | Item |
|---|------|
| 2A | **#10–12** tombstone prune, openByPlayer heal, dice throw |
| 2B | **#14–15** chat normalization, WS strict origin |
| 2C | **#9,17–25** residual low-priority |

---

## Rules

- **Do NOT re-file** v3–v6 fixes without regression proof (`git show HEAD:<file>`).
- Run full probe gate before/after fixes; **`pressure-drain-probe.js` must PASS** after #3.
- Bump `?v=1283` / `ctf-v12.83` on public changes.
- Log fixes in `AGENTS.md` coordination log.
