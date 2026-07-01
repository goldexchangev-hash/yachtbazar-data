# Crypto TV — Bug Hunt v6 (Pass 9)

**Baseline:** live **v12.69** (`?v=1269`, `ctf-v12.69`) @ `e7b1516` on `claude/ethereum-betting-game-vrf-2dq50k`  
**Prior audit:** Pass 8 / v5 on v12.59 — v5 Wave 0–2 landed **v12.60**; v12.61–12.69 owner UX + polish  
**Method:** Full probe gate → **12-stream deep audit** → v5 regression crosswalk → fresh numbering + **fix suggestions for Claude**

---

## Executive summary

**v5 fixes largely held** (21/37 FIXED, 1 PARTIAL, 0 REGRESSIONS on money invariants). Probe gate **12/12 green**.

**Pass 9 finds 34 actionable items** (#1–#34): **0 Critical** (v5 #1 XSS fixed), **6 High**, **14 Medium**, **14 Low**. Plus **6 owner-only** carry-forward.

Top real-world risks for players:
1. **Plane token mode can lock up** after switching channels mid-flight (#2)
2. **Demo BJ `bj:seed` still unlimited** — corrupts guest bank (#1)
3. **ETH price feed has no sanity cap** — bad upstream could over-mint tokens (#3)
4. **WS global cap only** — one client can fill all 600 slots (#4)
5. **BJ dock self-heal can still tear down iframe mid-hand** (#5 — partial v5 #10)
6. **Retained loss sessions grow forever** — slow memory/disk exhaustion (#6)

Every finding below includes a **Fix for Claude** block agents can execute directly.

---

## Probe gate (v12.69)

| Probe | Result |
|-------|--------|
| v2 crash-reserve / liveness / adversarial | ✅ |
| v3 BJ-interleave / headers / wave1 / wave2 | ✅ |
| v4 inverse / verify-rederive / orphan-drain | ✅ |
| v5 pending-settle-key | ✅ (documents deferred #2) |
| **`CursorBugHunt-v6/plane-token-stuck-probe.js`** | ✅ documents #2 |
| npm test + server self-tests | ✅ 33/33 |

---

## v5 regression crosswalk (summary)

| Status | Count | Notes |
|--------|-------|-------|
| **FIXED** | 21 | XSS, batchWrite settle, demoUsd, felt ?v=1269, trust proxy, WS cap, bjDockLive in `ensureBlackjackReady`, fish reveal, slider drag, kindMismatch toast, guest topup cap, postMessage origin, etc. |
| **PARTIAL** | 1 | #2 pendingSettle player-key (deferred; branch 2b backstop) |
| **STILL OPEN** | 15 | Mostly owner (#6 V2, #24 registry, #28 render branch, #32 confirmations, #37 EIP-7702) + by-design (#9 disconnect bust, #12–15 fish PF, #34 cosmetic) |
| **REGRESSION** | 0 | Money path invariants hold |

Full line-by-line crosswalk: see agent notes in commit or prior v5 `REPORT.md`.

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Exploit / total breakage |
| **High** | Real-money loss, stuck gameplay, or major security |
| **Medium** | Reliability, DoS, UX money confusion |
| **Low** | Polish, demo-only, cosmetic |

---

## Pass 9 findings — with fix suggestions for Claude

### High

#### #1 — `bj:seed` unlimited play-money mint (v5 #22 gap)
**Files:** `server/blackjack-server.js:677-687`  
**Issue:** `topUp` capped at `GUEST_BAL_CAP=25000` but `seedGuest` accepts any finite `amount` — guest sends `{type:"bj:seed", balance: 1e12}` and persists to `.bj-bank.json`.

**Fix for Claude:**
```javascript
// In seedGuest(), after validation:
const capped = Math.min(GUEST_BAL_CAP, Math.max(0, +amount || 0));
bank.all.set(w, r2(Math.max(capped, bank.get(w))));
```
Share `GUEST_BAL_CAP` / `GUEST_TOPUP_MAX` constants with `topUp`.

---

#### #2 — Plane token mode stuck after channel leave mid-flight
**Files:** `public/plane-ui.js:364-366,488-491`  
**Issue:** `setActive(false)` bumps `_realEpoch`; in-flight `.then` returns early **without** `_realBusy=false` → LAUNCH permanently disabled (`_tokenLaunch` gates on `_realBusy`).

**Fix for Claude:** In `setActive(false)` when `state==="token-flying"`, after `onTokenCashOut()`:
```javascript
this._realBusy = false;
this.state = "token-idle";
this._startTokenIdle();
```
Also in `.then/.catch` epoch-mismatch paths: `this._realBusy = false; this._startTokenIdle();`  
**Probe:** `CursorBugHunt-v6/plane-token-stuck-probe.js` → should FAIL after fix.

---

#### #3 — ETH/USD feed: no sanity bounds or staleness TTL
**Files:** `server/server.js:221-233`, `token-http.js:weiToUsd`  
**Issue:** Any `>0` price from Coinbase/CoinGecko is accepted; stale price never expires → inflated token grants if feed glitches.

**Fix for Claude:**
```javascript
const MIN_ETH = 500, MAX_ETH = 100000, STALE_MS = 15 * 60 * 1000;
let _ethUsdLiveAt = 0;
// In refreshTokenEthUsd: reject u outside [MIN_ETH, MAX_ETH]; set _ethUsdLiveAt = Date.now()
// In ethUsdReady(): return _ethUsdLive > 0 && (Date.now() - _ethUsdLiveAt) < STALE_MS
```
Block `doStart`/`doTopUp` when `!ethUsdReady()` (play/settle unaffected).

---

#### #4 — WS connection cap is global only (no per-IP limit)
**Files:** `server/server.js:385-392`  
**Issue:** One client can open all 600 sockets → deny service for everyone. No Origin check on upgrade.

**Fix for Claude:** Track `Map<ip, count>` on `connection`; cap e.g. 8/IP; add `verifyClient` checking `Origin` against `PUBLIC_HOST` / same-origin list.

---

#### #5 — BJ dock self-heal bypasses `bjDockLive` (partial v5 #10)
**Files:** `public/app.js:3799-3803` vs `3539`  
**Issue:** Self-heal does `removeAttribute("src")` **before** `ensureBlackjackReady()`. Guard at 3539 requires `src` present → mid-hand reload still possible on wallet/session mismatch.

**Fix for Claude:**
```javascript
// renderBjDock self-heal condition — add:
&& !bjDockLive
// OR move removeAttribute inside ensureBlackjackReady after the bjDockLive early return
```

---

#### #6 — Unbounded retained losing sessions (side-effect of v5 #3 fix)
**Files:** `token-bridge.js:90-100`, `token-http.js:298-311`  
**Issue:** Every settled **loss** kept forever in `sessions` map + full `bets[]` → memory, persist blob, and `findSettledSessionForPlayer` O(n) scans grow without bound.

**Fix for Claude:** After `obligationConsumed(ob)` OR on-chain `bjLocked==0`, prune settled-loss session to a compact tombstone `{id, player, contract, settlement}` (drop `bets[]`). Keep `pendingSettle` as durable loss-escape record.

---

### Medium

#### #7 — Guest bank disk growth via pre-hello lobby subscribe
**Files:** `server/blackjack-server.js:34,232`; WS handler  
**Issue:** `bank.get` auto-creates guest entries; `bj:lobby:subscribe` before hello with random `guest:*` wallets persists forever.

**Fix for Claude:** Require `bjHelloSeen` before `pushWallet`; don't persist on read-only `get`; cap guest map size (LRU); only persist wallets that placed a bet.

---

#### #8 — WS `hello` accepts arbitrary address for chat/presence spoofing
**Files:** `server/server.js:426-430,437-462`  
**Issue:** Any string becomes `clients.get(ws).address` → chat `from` and player roster show spoofed wallets (social engineering; XSS if client renders unsafely).

**Fix for Claude:** Only accept `^0x[0-9a-fA-F]{40}$` or `^guest:[a-z0-9]{1,32}$`; blank otherwise. Real-wallet chat should require signed proof (future).

---

#### #9 — Manual crash round: disconnect = forced bust (by design, document)
**Files:** `crash-rounds-ws.js:136-138`  
**Issue:** Transient disconnect on winning manual round → full loss. No cross-tab cash-out.

**Fix for Claude (optional):** Bind round to `sessionId` not socket; allow `cr:cashout` from any authenticated connection for that session; or document in UI ("stay connected during manual rounds").

---

#### #10 — Fish Shooter: paid bullets survive bonus wave start
**Files:** `public/fishshooter.js:598-603` vs boss refund `:723-727`  
**Issue:** In-flight paid shots can hit "free" wave fish → extra server bets or wasted stakes.

**Fix for Claude:** In `_startBonus`/`_startFrenzy`, refund/remove all non-free in-flight bullets (mirror `_updateBoss` boss-round logic).

---

#### #11 — `tokenFlip` leaves `revealLock` if channel changes during bet
**Files:** `public/app.js:1731-1734`  
**Issue:** Catch only calls `unlockReveal()` when `TV._seq === seq`; channel switch skips unlock → 20s global lock.

**Fix for Claude:** Call `unlockReveal()` unconditionally in catch; gate only the toast on seq.

---

#### #12 — Fish token burst-fire (v5 #12 carried)
**Files:** `public/fishshooter.js:386-392`, `fishtable.js:330-334`  
**Issue:** No optimistic debit in token mode → parallel server bets before balance updates.

**Fix for Claude:** Add `_tokenPendingCost` counter incremented on fire, decremented on `_resolveHit`; gate `_fire` on `balance >= cost + _tokenPendingCost`.

---

#### #13 — slots3d PF verify broken (server ≠ client grid)
**Files:** `server/games/slots3d.js:83-90`, `public/slots3d-engine.js:143-155`  
**Issue:** Different derivation paths → players cannot verify token spins.

**Fix for Claude:** Unify on `PF.floats` everywhere OR export server `deriveGrid` to client verify panel; add parity test like `pressure.js` cross-check.

---

#### #14 — Fish bonus `expDraw` unverifiable + unbounded tail (v5 #14–15)
**Files:** `server/games/fishshooter.js:130-145`  
**Issue:** Server-only exponential disbursement; tail can exceed house bankroll at settle.

**Fix for Claude:** Cap per-shot payout at `min(tail, houseBankroll * maxPayoutBps)`; document bonus path in client PF panel; add engine self-test for cap.

---

#### #15 — SW cache: `url.search.includes("v=")` false positives
**Files:** `public/sw.js:37`  
**Issue:** `?nav=`, `?rev=` match substring `v=` → cache-first forever, stale deploys.

**Fix for Claude:** `const immutable = /[?&]v=/.test(url.search) || url.pathname.includes("/vendor/");`

---

#### #16 — `/api/token/play` has no IP throttle
**Files:** `server/token-http.js:967`  
**Issue:** Invalid-token floods bypass per-session limiter (runs after bearer check).

**Fix for Claude:** Wrap `/play` and `/session` with `ipGuard(req)` like `/start`.

---

#### #17 — `kindMismatch` toast shows wrong label
**Files:** `public/blackjack-ui.js:96`  
**Issue:** Checks `tableKind === "token"` but server sends `"real"`/`"demo"`.

**Fix for Claude:** `m.tableKind === "real" ? "real-money (token)" : "demo"`

---

#### #18 — Crash WS `ws._crRounds` never pruned
**Files:** `crash-rounds-ws.js:106`, `onResolve ~73`  
**Issue:** Set grows for life of socket.

**Fix for Claude:** In `onResolve`, `if (ws && ws._crRounds) ws._crRounds.delete(out.roundId);`

---

#### #19 — Admin release/player signatures have no expiry
**Files:** `token-http.js:65`, `doAdminRelease`, `doAdminPlayer`  
**Issue:** Captured owner sig replayable forever (low impact; inconsistent with release expiry).

**Fix for Claude:** Add `Expiry` to admin intents in `tokenAuthMessage`; validate window like `doRelease`.

---

#### #20 — Stranded-lock UI hides buy-in auto-claim path
**Files:** `public/token-mode.js:364-374`, `token-client.js:119-134`  
**Issue:** v12.66 buy-in auto-claims stranded lock but UI only shows Recover.

**Fix for Claude:** When `stranded > 0`, show **"Buy in (reclaims $X)"** button calling `buyIn()` alongside Recover.

---

### Low

#### #21 — `spendableUsd()` ignores token mode
**Files:** `public/app.js:317-319`  
**Fix:** `if (TokenMode.active()) return TokenMode.tokens();` before demo branch.

#### #22 — `demoUsd` overwrite if session ends mid-canvas-play
**Files:** `app.js` `onBalance` handlers  
**Fix:** Gate on round-scoped token flag, not live `TokenMode.active()`.

#### #23 — `tokenDice`/crash/slots delayed sync without seq guard
**Files:** `app.js:3338+`  
**Fix:** Capture `TV._seq` before await; skip sync if changed (match `tokenFlip`).

#### #24 — Pressure double cash-out tap
**Files:** `pressure-ui.js:215-221`  
**Fix:** `_cashoutRequested` latch until `_resolveToken`.

#### #25 — Fish token splash uses client RNG in token mode
**Files:** `fishshooter.js:533-546`  
**Fix:** Token splash visual-only; don't despawn shootable fish from local roll.

#### #26 — `bjCountTimer` / wallet casing / messageWallet shadow (carried)
**Files:** `blackjack-server.js:524,753-757`  
**Fix:** Use `norm()` for seat match; trust only `sock.wallet`; clear timer on channel leave (v5 #26 fixed — verify).

#### #27 — Empty betting loop spins 5min
**Files:** `blackjack-server.js:271-276`  
**Fix:** After N empty betting windows → `phase=idle`.

#### #28 — Insurance stall on disconnected (not left) seat
**Files:** `blackjack-server.js:318`  
**Fix:** Pre-mark `insuranceDecided` for `s.disconnected` seats.

#### #29 — Felt hardcodes `ETH_USD=3400`
**Files:** `blackjack-ui.js:15`  
**Fix:** Parent posts live rate via `bj:rate` message.

#### #30 — `/api/info` + `/api/token/status` leak state path
**Files:** `token-http.js:811`  
**Fix:** Omit raw filesystem path from public `storeInfo()`.

#### #31 — `usedBuyIns` unbounded (v5 #31)
**Fix:** Periodic compaction when lock consumed + session GC'd.

#### #32 — CSP minimal (object-src, base-uri)
**Files:** `server.js:47-54`  
**Fix:** Extend CSP per v5 auth agent suggestion.

#### #33 — Graceful shutdown doesn't close WS
**Files:** `server.js:307-319`  
**Fix:** Close all `wss.clients` with 1001 before `server.close()`.

#### #34 — SW immutable cache unbounded across deploys
**Files:** `public/sw.js`  
**Fix:** Prune old cache entries on `activate`.

---

## Owner-only (neither AI — document, don't count as code regressions)

| Ref | Item | Fix owner action |
|-----|------|------------------|
| O1 | V2 not deployed (#6 v5) | Deploy `CoinFlipBettingV2` + rewrite bridge `sessionId` in settlement digest |
| O2 | Bridge signer ≠ V2 `settleSession` | Thread `sessionId` through `realmoney.js` + `token-bridge.settle` |
| O3 | On-chain `eth_call` / prevrandao | Commit-reveal or VRF migration |
| O4 | GameRegistry artifact stale | Regen `public/contract.js` with #28 zero-guard |
| O5 | `render.yaml` deploys feature branch | Pin prod to protected branch |
| O6 | EIP-7702 vs `_betGuard` | Strategic: replace `tx.origin` guard |

---

## Wave plan for Claude agents

### Wave 0 — Player-visible (ship first)
| # | Item |
|---|------|
| 0A | **#2** Plane token stuck + probe green |
| 0B | **#5** BJ self-heal + bjDockLive |
| 0C | **#1** bj:seed cap |
| 0D | **#20** Stranded buy-in UX |

### Wave 1 — Money / infra
| # | Item |
|---|------|
| 1A | **#3** ETH/USD sanity + staleness |
| 1B | **#6** Prune retained loss sessions |
| 1C | **#4** WS per-IP + Origin |
| 1D | **#16** IP guard on /play |

### Wave 2 — Games / client
| # | Item |
|---|------|
| 2A | **#10–12** Fish bonus bullets, burst-fire, flip revealLock |
| 2B | **#13–14** slots3d + fish PF/caps |
| 2C | **#11,21–25** misc client |

### Wave 3 — Ops / hardening
| # | Item |
|---|------|
| 3A | **#7–8,15,17–19,29–34** |

---

## Rules

- Coordinate via **`AGENTS.md`**
- Do NOT re-file v5 FIXED items without regression proof
- Probe-gate money fixes; bump `?v=` / `ctf-v12.XX` on public changes
- Use **Pass 9 # numbers** from this report

---

*End Pass 9. Agent prompt: `CursorBugHunt-v6/CLAUDE-PROMPT.txt`*
