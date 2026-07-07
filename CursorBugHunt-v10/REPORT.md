# Crypto TV — Bug Hunt v10 (Pass 13 — Harder Scan)

**Baseline:** live **v12.91** (`?v=1291`, `ctf-v12.91`) @ `960ac76`  
**Prior audit:** Pass 12 / v9 on v12.91 — 10 items, money CLEAN  
**Method:** **4-stream adversarial audit** (concurrency, game engines, client state machines, BJ/WS/auth) + targeted code verification

---

## Executive summary

**Money ledger: still 0 new Critical / 0 new High house-drain** on server happy path.

**Pass 13 finds 3 new High + 10 Medium + 4 Low** (#1–#17). Several are **deeper angles** on v9 deferred items or **#94 resume gaps** not caught in Pass 12.

Top new risks:
1. **Post-refresh crash round trap** — server round live, client `live=null`, LAUNCH fails + false local refund (#1)
2. **Reef token bomb splash** still client-kills collateral fish (Fish Shooter fixed, Reef not) (#3)
3. **Launch ack window channel switch** orphans server round (#2)

---

## Probe gate (v12.91)

| Probe | Result |
|-------|--------|
| v2–v9 full gate | ✅ |
| **`CursorBugHunt-v10/crash-cold-resume-probe.js`** | ❌ documents #1 |
| **`CursorBugHunt-v10/reef-splash-token-probe.js`** | ❌ documents #3 |
| npm test | ✅ 35/35 |

---

## v9 carry-forward (still open — do not re-file as new)

| v9 | Status |
|----|--------|
| #1 BJ Reload `BJ_START` | STILL OPEN |
| #2 Plane `resumedGone` UX | STILL OPEN |
| #3 slots3d re-entry spoiler | STILL OPEN |
| #4–#10 | STILL OPEN / partial |

Pass 13 **deepens** several v9 items (#1, #2, #4, #6–#7) with new repro paths.

---

## Pass 13 findings — with fix suggestions for Claude

### High

#### #1 — Cold resume gap: page refresh during live token crash round
**Files:** `public/crash-rounds-client.js:168-172`, `public/app.js:4719`, `public/plane-ui.js:405-407`  
**Issue:** `#94` resume only runs when in-memory `live` exists. After F5/reopen, `TokenMode` restores session but `CrashRounds.live === null`. Server still has `activeBySession` round (stake reserved). Player taps LAUNCH → server rejects `"a crash round is already live"`. Plane `.catch` **locally refunds stake** (lines 405–407) while server still holds reservation → **HUD lies**, no cash-out until server timer bust (minutes).

**Repro:**
1. Buy in, Plane token round climbing.
2. Hard refresh (session restored from localStorage).
3. LAUNCH → error; Plane balance inflated vs token bar.

**Fix for Claude:**
```javascript
// crash-rounds-client.js — cold resume from session credentials:
function resumeCold(sessionId, sessionToken) {
  if (live) return resume();
  send({ type: "cr:resume", sessionId, sessionToken });
  // handle cr:started → rebuild live OR cr:noround → refreshTokens
}

// app.js: after TokenMode.init resume OK + ws.onopen:
if (TokenMode.active()) CrashRounds.resumeCold(session.sessionId, session.sessionToken);

// plane-ui.js: on "already live" error, call resumeCold — NEVER local refund
```
**Probe:** `CursorBugHunt-v10/crash-cold-resume-probe.js`

---

#### #2 — Channel switch during launch ack window orphans server round
**Files:** `public/plane-ui.js:348-353`, `public/app.js:3452-3464`, `public/crash-rounds-client.js:145`  
**Issue:** Plane sets `state=token-flying` and debits locally **before** `cr:started` assigns `roundId`. Switch channel in ~1s window → `cashOut()` no-op (no `roundId`) → `cancel()` drops `live` → late `cr:started` ignored. Same trap as #1.

**Fix:** Defer local debit/`token-flying` until `cr:started`; OR send server abort on cancel without roundId; OR treat as #1 cold resume on return.

---

#### #3 — Reef token bomb/chain splash still client-authoritative
**Files:** `public/fishtable.js:456-469` vs `public/fishshooter.js:547-552`  
**Issue:** Fish Shooter guards paid token splash as visual-only. Reef `_bombSplash` / `_eelChain` still call `resolveSplash` + `_catchFish` on up to 4–7 collateral fish. Server credited `splash.total` once; client shows extra `+$` floats and removes shootable fish → **real-money confusion**.

**Fix for Claude:**
```javascript
// fishtable.js _bombSplash + _eelChain, top of token paid path:
if (this._tokenActive() && !shot.free) {
  // visual explosion only — server already paid splash.total
  return;
}
```
**Probe:** `CursorBugHunt-v10/reef-splash-token-probe.js`

---

### Medium

#### #4 — `demoSyncBalance()` calls undefined `force` → session tracker silently broken
**Files:** `public/app.js:3022,3037-3039`  
**Issue:** `demoSyncBalance()` has no `force` param but calls `paintSession(force)` → `ReferenceError` in strict mode, caught and swallowed. Demo **THIS SESSION** stats freeze on ETH poll / demo reset.

**Fix:** Remove `force` or add `demoSyncBalance(reanchor)` parameter.

---

#### #5 — Guest BJ seat hijack via `messageWallet` client hint
**Files:** `server/blackjack-server.js:802-806`, `server/server.js:526-530`  
**Issue:** `hello` with empty address leaves `sock.wallet` empty. Attacker sends `bj:room:join { wallet: "guest:victim" }` — reclaims disconnected victim's seat + demo bank. Guest IDs broadcast in snapshots + predictable format.

**Fix:** Never trust `m.wallet`; pin guest at hello only.

---

#### #6 — BJ seat wallet comparison not normalized (case bypass)
**Files:** `server/blackjack-server.js:540,567` vs `157-158` (`norm()`)  
**Issue:** Same EOA two checksum casings can sit at two tables simultaneously.

**Fix:** Use `norm()` on all seat wallet equality checks.

---

#### #7 — Fish `betUnits` vs `power` decoupling (malicious HTTP)
**Files:** `server/token-bridge.js:172-186`, `server/games/reef.js`  
**Issue:** `betUnits=1, power=7` debits $1 but uses whale-tier kill odds. RTP invariant holds; **bet display integrity** broken.

**Fix:** Bridge validates `betUnits === round2(unitBet × power)` with per-game MIN/MAX.

---

#### #8 — Settle/recover closes session with open `crashRound` ledger marker
**Files:** `server/token-http.js:512-514`, `server/token-bridge.js:258-266` (deeper v9 #6)  
**Issue:** RAM `liveCrashSession()` false after SIGKILL orphan → settle proceeds → closed session + open marker → BJ blocked.

**Fix:** `finalizeOrphanRounds(s, -1)` before `bridge.settle()`.

---

#### #9 — `doRelease` HTTP not wrapped in `batchWrite` (asymmetric with `doSettle`)
**Files:** `server/token-http.js:520-528` vs `586-607`  
**Issue:** Kill between bridge persist and HTTP save → stale `openByPlayer` until manual recover.

**Fix:** Wrap post-settle HTTP mutations in `batchWrite`.

---

#### #10 — Multi-tab same wallet: no cross-tab session sync
**Files:** `public/token-mode.js:40-43`  
**Issue:** Tab A cashes out; Tab B stale until bet fails.

**Fix:** `storage` event on `ctf_token_session` → `refreshTokens()` / `_clearSession()`.

---

#### #11 — Reef token win floats show direct catch only (omit bonus/splash)
**Files:** `public/fishtable.js:407-415`  
**Issue:** Balance jumps by server total; float shows `mult × unitBet` only.

**Fix:** Float server `outcome.payoutUnits` delta or breakdown string.

---

#### #12 — `bindToken()` failure silently ignored on WS hello
**Files:** `server/server.js:516-518`, `server/blackjack-server.js:146-151`  
**Issue:** Mid-hand hello with wrong `bjSession` → routing desync; failed debits confusing.

**Fix:** Reject hello or echo bound session when `bindToken` returns false.

---

#### #13 — v9 deferred items (unchanged, listed for Wave 0 continuity)

| Ref | Item |
|-----|------|
| v9 #1 | BJ Reload → `demoUsd` |
| v9 #2 | Plane `resumedGone` message |
| v9 #3 | slots3d setBalance in-flight guard |
| v9 #4 | Widen `bjDockLive` |
| v9 #5 | Demo re-seed policy |

---

### Low

#### #14 — Plane no visibility cash-out (Pressure has it) — v9 #8  
#### #15 — WS `cr:start` no per-session rate limit (HTTP has `rateOk`)  
#### #16 — Cache-bust drift `pressure-ui.js`/`slots3d.js` `?v=1283` — v9 #9  
#### #17 — `obligationConsumed` RPC false-positive before net=0 mint (edge, H2 class from concurrency sweep)

---

## Owner-only (unchanged)

| Ref | Item |
|-----|------|
| O1 | V2 deploy / cross-session `bjLocked` drain |
| O2 | On-chain staticCall cherry-pick |
| O3 | Contract F1/F2 redeploy (source landed c2bb824) |

---

## Wave plan for Claude

### Wave 0 — High (ship first)
| # | Item |
|---|------|
| 0A | **#1** Cold crash resume + fix false plane refund |
| 0B | **#2** Defer token-flying until cr:started OR server abort |
| 0C | **#3** Reef splash/chain visual-only guard + probe green |

### Wave 1 — Medium reliability
| # | Item |
|---|------|
| 1A | **#4** demoSyncBalance force bug |
| 1B | **#5–#6** Guest identity + wallet norm |
| 1C | **#8–#9** Orphan finalize before settle; batchWrite doRelease |
| 1D | **#7** Fish betUnits/power validation |

### Wave 2 — v9 continuity + polish
| # | Item |
|---|------|
| 2A | v9 #1–#5 |
| 2B | **#10–#12** multi-tab, reef floats, bindToken |

---

## Hunt comparison

| Pass | Method | New High | Money Critical/High |
|------|--------|----------|---------------------|
| v9 | 4-stream standard | 0 | 0 |
| **v10** | **4-stream adversarial + concurrency** | **3** | **0** |

Harder scan found **real High client/liveness bugs** (#94 resume incomplete, Reef regression vs Fish Shooter) without reopening money Critical/High on ledger.

---

## Rules

- Run full probe gate; new probes must PASS after Wave 0.
- Bump `?v=1292` on public changes.
- Do NOT re-file v7/v8 money fixes unless regression proven.
