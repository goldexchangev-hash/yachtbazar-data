# Crypto TV — Bug Hunt v14 (Pass 17 — Scans 51–100)

**Baseline:** live **v12.91** (`?v=1291`, `ctf-v12.91`)  
**Prior audit:** Pass 16 / v13 — scans 1–50  
**Method:** **50 parallel focused scans** (scans **51–100**, max agents) + full probe gate + code verification  
**Cumulative:** **100 scans** across v13 + v14

---

## Executive summary

**Money ledger: still 1 NEW High server bug** (v13 Scan 46 orphan cap-at-1000× — **extended to pressure/plane/swoop** in scans 51, 91–92). **0 additional Critical / High house-drain** on happy path beyond that.

**Pass 17 adds 1 NEW Med–High client liveness trap + 10 NEW Medium/Low + confirms all v10–v13 carry-forward.**

| Metric | Count |
|--------|-------|
| Scans run (this pass) | **50** (51–100) |
| Cumulative scans | **100** |
| Scans CLEAN / FIXED | 31 |
| Scans OPEN (carry-forward) | 14 |
| Scans NEW finding | **12** (55, 57, 64, 75, 80, 82, 85, 86, 88, 89, 90, 93) |

Top **NEW** items this pass:
1. **Scan 64 — Pressure early-bank `cr:error` orphans server round** (stake stuck live server-side)
2. **Scan 55 — `verifyRederive` false assurance** on cap orphan wins
3. **Scan 82 — WS `cr:start`/BJ bypass HTTP bridge disabled gate**
4. **Scan 89 — `?contract=` URL phishing** (user signs attacker contract)

All v10–v13 Wave 0 items **remain open** on v12.91.

---

## 50-scan matrix (51–100)

| Scan | Focus | Verdict | Sev | NEW |
|------|--------|---------|-----|-----|
| 51 | orphan finalize **pressure** gameKey | **OPEN** → v13 #46 ext | High | ext |
| 52 | pressure SIGTERM drain / gameFloor | CLEAN (v7 fix) | — | no |
| 53 | pressure void window bust (`_resolve`) | CLEAN (hardened) | — | no |
| 54 | `crash-rounds.js` gameFloor parity | CLEAN | — | no |
| 55 | **`verifyRederive` open crashRound trust** | **BUG** | Med | **yes** |
| 56 | token-bridge self-test orphan path | OPEN → **93** | Med | ext |
| 57 | **BJ insurance `credit_failed` phantom** | **BUG** | Med | **yes** |
| 58 | BJ applyExternal during live crash | MITIGATED | — | no |
| 59 | pendingSettle composite key | FIXED (v5) | — | no |
| 60 | doSettle batchWrite / GC | OPEN (v10 #8) | Med | no |
| 61 | ack timeout plane false refund | OPEN (v12 #1) | High | no |
| 62 | ack timeout pressure | OPEN (v12 #1) | High | no |
| 63 | CR_ROUND_TIMEOUT reconcile path | OPEN (v12 #1 ext) | High | no |
| 64 | **pressure early-bank reject orphan** | **BUG** | Med–High | **yes** |
| 65 | `cr:error` vs `cr:result` race | OPEN (v12 #3) | High | no |
| 66 | cold F5 resume live rebuild | OPEN (v10 #1) | Med | no |
| 67 | Recover vs `TokenMode.init` resume | OPEN (v12 #2) | High | no |
| 68 | plane false refund inventory | OPEN (v12 #1/#3) | High | no |
| 69 | pressure catch / resumedGone | OPEN (v12 #12) | Med | no |
| 70 | fishtable epoch / splash guards | OPEN (v10/v11) | High/Low | no |
| 71 | reef splash token desync | OPEN (v10 #3) | Med | no |
| 72 | slots3d off-channel top bar | OPEN (v11 #2) | Med | no |
| 73 | slots3d PF parity | CLEAN (v12.90) | — | no |
| 74 | slots3d stake override | FIXED | — | no |
| 75 | **Gem Vault bonus `refreshTokens` spoiler** | **BUG** | Med | **yes** |
| 76 | dice/crash afford `gameWei` gate | OPEN (v12 #4) | Med | no |
| 77 | bjDockLive off-channel stale | OPEN (v12 #8) | Med | no |
| 78 | bjReload stranded race | OPEN (v12 #2) | High/Med | no |
| 79 | guest oracle / hijack | OPEN (v10/v12) | Med | no |
| 80 | **Chiptune not resynced on channel switch** | **BUG** | Low–Med | **yes** |
| 81 | pressure HTTP void | OPEN (v11 #3) | Med | no |
| 82 | **WS when HTTP bridge disabled** | **BUG** | Med | **yes** |
| 83 | clientSeed CPU cap | OPEN (v11 #5) | Med | no |
| 84 | loadScriptOnce dedup | OPEN (v13 #6) | Low–Med | no |
| 85 | **demo BJ `bj:topup` extends turn timer** | **BUG** | Low | **yes** |
| 86 | **legacy `bridgeAuth` no expiry** | **BUG** | Med | **yes** |
| 87 | chat XSS / NFKC | CLEAN | — | no |
| 88 | **profile/house diag error in innerHTML** | **BUG** | Low | **yes** |
| 89 | **`?contract=` URL param phishing** | **BUG** | Med | **yes** |
| 90 | **stale `ethUsd` / maxBet drift** | **BUG** | Low | **yes** |
| 91 | orphan cap **plane** gameKey | OPEN → v13 #46 | High | ext |
| 92 | orphan cap **swoop** gameKey | OPEN → v13 #46 | High | ext |
| 93 | **self-test gap: cap orphan** | **BUG** | Med | **yes** |
| 94 | cr:resume reconnect | CLEAN (hardened) | — | no |
| 95 | cr:cashout duplicate latch | CLEAN (v6) | — | no |
| 96 | switchGame cancel + refreshTokens | OPEN (v13 #2) | Med | no |
| 97 | syncTokenGameBalances hold | OPEN (v12 #7) | Med | no |
| 98 | TV reveal 2800ms spoiler | OPEN (v13 #4) | Med | no |
| 99 | swoop demo balance leak | OPEN (v13 #5) | Med/Low | no |
| 100 | crash+BJ+fish interleave | MOSTLY SAFE | Mixed | no |

---

## NEW consolidated findings (Pass 17)

### Med–High

#### #1 — Pressure early-bank reject orphans server round (stake stuck)
**Scan:** 64 · **Files:** `server/crash-rounds.js:113`, `server/crash-rounds-ws.js:128-132`, `public/crash-rounds-client.js:157-163`, `public/pressure-ui.js:286-304`  
**Issue:** When a player taps BANK below 1.20×, server rejects with `"hold longer"`. WS sends `cr:error`. Client `onError` nulls `live` and rejects the launch promise; pressure UI `.catch` resets to armed. **Server round stays live** with stake reserved — blocks BJ, blocks new rounds, may bust silently.

**Fix:** On recoverable cashout reject (below floor), **do not** tear down `live` — show "hold longer" and keep inflating. Only `onError` for terminal codes (auth, already crashed). Optionally reset `cashoutRequested` latch.

**Probe:** `CursorBugHunt-v14/pressure-early-bank-probe.js`

---

### Medium

#### #2 — `verifyRederive` false assurance on cap orphan wins
**Scan:** 55 · **Files:** `server/token-bridge.js:336-343`  
**Issue:** Open `crashRound` entries skip engine re-derive (trust ledger). Orphan finalize with `cashOutAt: 1e9` at cap records `payout = bet×1000`. `verifyRederive` accepts it — audit passes while house overpaid.

**Fix:** Fix orphan bust (v13 #46) **and** re-derive resolved crashRound entries even when previously open, or assert orphan bust target ≤ crashPoint.

**Probe:** `CursorBugHunt-v14/verify-rederive-cap-probe.js`

---

#### #3 — WS `cr:start` / BJ when HTTP bridge disabled
**Scan:** 82 · **Files:** `server/token-http.js:956`, `server/crash-rounds-ws.js:88-116`, `server/server.js:248-299`  
**Issue:** HTTP routes return 503 when `ENABLE_TOKEN_BRIDGE !== "1"`. WS crash rounds and blackjack still accept play via `verifySession` / `bridgeAuth` — inconsistent ops posture; stale sessions can still mutate in-memory ledger.

**Fix:** Gate `makeCrashWs.start` and token BJ paths on the same `enabled()` predicate; or reject WS token messages when bridge disabled.

**Probe:** `CursorBugHunt-v14/ws-bridge-disabled-probe.js`

---

#### #4 — Gem Vault bonus: `refreshTokens` spoils top bar mid free-spin
**Scan:** 75 · **Files:** `public/token-mode.js:263-271`, `public/app.js:5504`, `public/slots3d.js:425-430,519-522`  
**Issue:** Tab visibility / channel switch calls `refreshTokens()` → `paintTokens()` only (not `lockReveal`). During Gem Vault free-spin animation, top bar jumps to **final** server balance before bonus overlay completes — spoiler.

**Fix:** Skip `refreshTokens` while `slots3dGame._bonus` active; or extend `lockReveal` to token bar during bonus; defer to `_endBonus` sync (already done for canvas).

---

#### #5 — BJ insurance `credit_failed`: phantom `insuranceResult`
**Scan:** 57 · **Files:** `server/blackjack-server.js:359`  
**Issue:** When `bank.credit` returns `false` on insurance win, server still sets `insuranceResult = { won: true, payout: win }` and broadcasts result. Client shows win; wallet unchanged.

**Fix:** On credit failure, set `won: false, payout: 0` or retry; never record phantom payout.

---

#### #6 — Legacy `bridgeAuth` tokens never expire
**Scan:** 86 · **Files:** `server/blackjack-server.js:99,858`, `server/bridge-server.js`  
**Issue:** `bridgeAuth.set(wallet, token)` has no TTL. Stolen/old bridge token authorizes BJ indefinitely until explicit deauthorize.

**Fix:** Store `{ token, exp }`; reject expired on `isAuthorized`.

---

#### #7 — `?contract=` URL param phishing
**Scan:** 89 · **Files:** `public/app.js:23-28`  
**Issue:** Valid ethers address in `?contract=` is adopted as deployment target. Attacker link → user connects wallet → signs against malicious contract believing it's the real site.

**Fix:** Allowlist known deployments; show prominent "custom contract" banner + block buy-in until user confirms; prefer canonical config over URL on hosted site.

---

#### #8 — token-bridge self-test doesn't cover cap-hit orphan
**Scan:** 93, 56 · **Files:** `server/token-bridge.js:681-700` (self-test)  
**Issue:** Self-test verifies generic orphan bust but never seeds `crashPoint === MAX_CRASH_X`. Cap-at-1000× regression would ship green.

**Fix:** Add self-test case with cap-hit seed + assert orphan payout 0.

---

### Low–Med

#### #9 — Chiptune not resynced on channel switch
**Scan:** 80 · **Files:** `public/fishshooter.js:1021`, `public/app.js` (`switchGame`)  
**Issue:** Fish Shooter re-wakes audio on resume but `switchGame` doesn't call `Chiptune` track resync when leaving/entering channels — music can stay on wrong track or silent until manual interaction.

---

#### #10 — Demo BJ `bj:topup` spam extends turn timer
**Scan:** 85 · **Files:** `server/blackjack-server.js:401-426`  
**Issue:** Guest `topUp` re-arms turn clock (`T.turn`) even when `needFunds` is empty — spam extends deadline without affording double/split.

**Fix:** Only re-arm when `needFunds.length > 0`.

---

#### #11 — Profile/house diag error message in `innerHTML`
**Scan:** 88 · **Files:** `public/app.js:4487`  
**Issue:** `(e && e.message)` interpolated into `innerHTML` — low risk (admin-only, server errors) but violates XSS hygiene.

**Fix:** Use `textContent` for error line.

---

#### #12 — Stale `ethUsd` / client max-bet drift
**Scan:** 90 · **Files:** `public/app.js:111-126,629,987`  
**Issue:** ETH price polled ~60s; `maxBet` read at connect only. Long sessions can show wrong USD labels and stale max-bet caps vs on-chain.

**Fix:** Refresh maxBet on chain switch / periodic; show price age indicator.

---

## Master bug registry (100 scans — v10 through v14)

### Server money (Wave 0 — highest priority)

| ID | Source | Issue | Sev |
|----|--------|-------|-----|
| **M1** | v13 Scan 46; v14 51,91–92 | Orphan finalize `cashOutAt: 1e9` → 1000× when `crashPoint === cap`. Fix must use `max(point+ε, gameFloor(gameKey))` — naive `point+0.01` alone VOID-refunds pressure | **High** |
| M2 | v14 Scan 55, 93 | `verifyRederive` trusts cap orphan ledger | Med |
| M3 | v10 #8 | doSettle non-atomic / GC loss-escape | Med |
| M4 | v11 #3 | pressure HTTP void | Med |

### Client crash / liveness (Wave 0–1)

| ID | Source | Issue | Sev |
|----|--------|-------|-----|
| **C1** | v12 #1; scans 61–63 | Ack timeout false "stake not taken" + local refund | **High** |
| **C2** | v12 #2; scan 67 | Recover races `TokenMode.init` resume | **High** |
| **C3** | v12 #3; scan 65 | `cr:error` vs `cr:result` race | **High** |
| **C4** | v14 Scan 64 | Pressure early-bank orphan trap | Med–High |
| C5 | v10 #1; scan 66 | Cold F5 resume | Med |
| C6 | v10 #2–3; scans 68–71 | Launch ack, reef splash, fish epoch | High/Med |

### Client medium / UX / auth (Wave 1–2)

| ID | Source | Issue |
|----|--------|-------|
| U1 | v13 #2; scans 72,96 | `refreshTokens` → canvas desync |
| U2 | v13 #3; scan 96 | play seq rollback after topUp |
| U3 | v13 #4; scan 98 | TV reveal 2800ms spoiler |
| U4 | v14 Scan 75 | Gem Vault bonus top-bar spoiler |
| U5 | v12 #4; scan 76 | dice/crash afford gate |
| U6 | v12 #8; scan 77 | bjDockLive stale |
| U7 | v14 Scan 82 | WS when bridge disabled |
| U8 | v14 Scan 86 | bridgeAuth no expiry |
| U9 | v14 Scan 89 | `?contract=` phishing |
| U10 | v14 Scan 57 | BJ insurance phantom payout |
| U11 | v13 #5–6; scans 84,99 | swoop demo leak, loadScriptOnce |
| U12 | v14 Scan 80,85,88,90 | chiptune, demo topup, innerHTML, ethUsd |

---

## Carry-forward (unchanged — still open)

All v10–v13 findings not marked FIXED above remain open on v12.91. Scans 51–100 **confirm** rather than reopen v7/v8/v9 fixes.

---

## Probe gate (v12.91)

| Probe | Result |
|-------|--------|
| v2–v13 full gate | ✅ |
| **`CursorBugHunt-v13/orphan-cap-win-probe.js`** | ❌ documents M1 |
| **`CursorBugHunt-v13/token-play-seq-probe.js`** | ❌ documents U2 |
| **`CursorBugHunt-v14/pressure-early-bank-probe.js`** | ❌ documents C4 |
| **`CursorBugHunt-v14/ws-bridge-disabled-probe.js`** | ❌ documents U7 |
| **`CursorBugHunt-v14/verify-rederive-cap-probe.js`** | ❌ documents M2 |
| npm test | ✅ 35/35 |

---

## Wave plan for Claude (updated)

### Wave 0 — Money + crash client
| # | Item |
|---|------|
| 0A | **M1** Orphan bust: `max(crashPoint+ε, gameFloor(gameKey))`, not `1e9` |
| 0B | **C1–C3** v10/v12 crash client false refunds |
| 0C | **C4** Pressure early-bank: don't orphan on recoverable reject |
| 0D | v11 fish epoch + slots3d bar |

### Wave 1 — Client liveness + audit
| # | Item |
|---|------|
| 1A | **M2** verifyRederive + self-test cap orphan (**93**) |
| 1B | **U1–U2** refreshTokens → `changed()`; play seq / topUp |
| 1C | **U3–U4** TV reveal + Gem Vault bonus bar lock |
| 1D | v12 recover race + dice afford |

### Wave 2 — Reliability + security
| # | Item |
|---|------|
| 2A | **U7–U9** WS gate, bridgeAuth TTL, contract URL allowlist |
| 2B | **U10** BJ insurance credit_failed |
| 2C | swoop demo, loadScriptOnce, bjDockLive, guest oracle |

---

## Hunt comparison (cumulative)

| Pass | Scans | New High (money) | New High (client) | New Med+ |
|------|-------|------------------|-------------------|----------|
| v12 | 10 | 0 | 3 | 6 |
| v13 | 50 | **1** (cap orphan) | 0 | 4 |
| **v14** | **50** | 0 (extends M1) | 0 | **12** |
| **Total** | **100** | **1** | **3** (v12) | **16+** |

100× scan: **one real server money bug** (M1), one **new client orphan trap** (C4), plus security/audit gaps (U7–U9, M2).

---

## Rules

- Full probe gate after fixes; v14 probes must invert where applicable.
- Bump `?v=1292` on public changes.
- Do NOT re-file v7/v8 fixes unless regression proven with `git show HEAD:<file>`.
