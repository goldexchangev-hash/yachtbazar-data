# Crypto TV — Bug Hunt v5 (Pass 8)

**Baseline:** live **v12.59** (`?v=1259`, `ctf-v12.59`) on deploy branch `claude/ethereum-betting-game-vrf-2dq50k` @ `457b3a6`  
**Prior audits:** Pass 7 / v4 on v12.55 (`CursorBugHunt-v4/REPORT.md`); Pass 6 / v3 on v12.50  
**Method:** Branch from deploy → confirm `public/sw.js` version → full probe gate (v2/v3/v4) → **10-stream deep read-only audit** → v4 regression crosswalk → fresh numbering below.

This is a **bigger hunt**: deeper money-path obligation analysis, BJ/XSS surface, v12.57–12.59 UX deltas, engine PF parity, ops/auth, and contract/deploy pipeline — not a re-list of v3 Wave 0–4.

---

## Executive summary

**v4 Wave A–C landed in v12.56; v12.57–12.58 owner UX; v12.59 canvas-balance patch.** Full probe gate green including all v4 probes. **No regressions** on v3 money-path invariants (reserve, txHash races, recover loss-escape core, WS↔BJ guards).

**Pass 8 adds 37 findings** (#1–#37): **1 Critical** (BJ guest XSS), **5 High** (obligation keying, GC loss-escape window, incomplete v12.59 demo leak, BJ SW cache skew, bridge/V2 blocker), **16 Medium**, **15 Low**. Several are **loss-escape or obligation** edge cases the v4 hardening did not fully close.

**Owner-only unchanged:** production V2 deploy, wallet E2E, commit-reveal/VRF migration, fee policy.

---

## Probe gate (v12.59)

| Probe | Result |
|-------|--------|
| `CursorBugHunt-v2/crash-reserve-probe.js` | ✅ OK |
| `CursorBugHunt-v2/crash-liveness-probe.js` | ✅ OK |
| `CursorBugHunt-v2/adversarial-suite-v2.js` | ✅ 0 findings |
| `CursorBugHunt-v3/crash-bj-interleave-probe.js` | ✅ OK |
| `CursorBugHunt-v3/security-headers-probe.js` | ✅ 7/7 |
| `CursorBugHunt-v3/wave1-auth-probe.js` | ✅ 11/11 |
| `CursorBugHunt-v3/wave2-money-probe.js` | ✅ OK |
| `CursorBugHunt-v4/crash-bj-inverse-probe.js` | ✅ OK (v4 #1 fixed v12.56) |
| `CursorBugHunt-v4/verify-rederive-crash-probe.js` | ✅ OK (v4 #4 fixed) |
| `CursorBugHunt-v4/orphan-drain-probe.js` | ✅ OK (v4 #5 fixed) |
| `CursorBugHunt/settlement-math-probe.js` | ⚠ stale #204–#209 |
| `CursorBugHunt/slots3d-parity-probe.js` | ✅ token path OK; demo HMAC grid known |
| Server self-tests (5 modules) | ✅ all OK |
| `npm test` | ✅ 33 passing |
| `npx hardhat test test/pass4-exploits.test.js` | ✅ 7/7 |
| **`CursorBugHunt-v5/pending-settle-key-probe.js`** | ✅ documents v5 #2 keying gap |

---

## v4 regression crosswalk (v12.59)

| v4 # | Title | v12.59 |
|------|-------|--------|
| 1 | Inverse BJ↔crash guard | ✅ **FIXED** v12.56 — `token-bridge.js:190`, `applyExternal` |
| 2 | Lazy-load channel guard | ✅ **FIXED** v12.56 — `currentGame !==` on all `ensure*Ready` |
| 3 | Fish burst-fire | ⚠ **STILL OPEN** → v5 #12 |
| 4 | verifyRederive open crashRound | ✅ **FIXED** v12.56 — trusted-until-resolved branch |
| 5 | Orphan crash reservations | ✅ **FIXED** v12.56 — `drainOrphanReservations()` on boot |
| 6 | Unbounded clientSeed | ✅ **FIXED** v12.56 — cap in `crash-rounds-ws.js` |
| 7 | BJ iframe version split | ⚠ **PARTIAL** — shell `1259`, inner assets still `1257` → v5 #5 |
| 8 | postMessage origin check | ⚠ **STILL OPEN** → v5 #33 |
| 9 | BJ applyNet refund paths | ✅ **FIXED** v12.56 — credit failure surfacing |
| 10 | Iframe reload bjDockLive | ⚠ **PARTIAL** — auto-heal paths still unguarded → v5 #10 |
| 11 | Reef chest animation | ⚠ **STILL OPEN** cosmetic → v5 #34 |
| 12 | Insurance deal-phase stall | ✅ **FIXED** v12.56 (per Claude log) |
| 13–23 | Low items | ✅ mostly fixed v12.56; see v5 for residual |

**v12.57–12.58 (off v4 report):** mobile BJ dock pin, Fish Shooter dock compact, one-tap token buy-in — audited for side effects in Pass 8 (#15, #20, #24).

**v12.59:** fish HUD after top-up + connect demo flash — **partial fix**; lazy-build paths still leak `demoUsd` → v5 #4.

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Exploit / total breakage / major security gap |
| **High** | Real-money desync, auth bypass, or systematic loss |
| **Medium** | Reliability, DoS, UX money confusion |
| **Low** | Polish, demo-only, cosmetic |

---

## Pass 8 findings (#1–#37)

### Critical

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **1** | **Stored XSS via crafted `guest:` wallet in BJ felt** | `server.js:420`, `blackjack-ui.js:20,346,339` | WS `hello` accepts any string matching `/^guest:/` with no charset limit. `_name()` returns `"Guest " + w.slice(6)` rendered via `innerHTML` on seat nameplates visible to all players. Payload `guest:<img onerror=…>` executes in same-origin iframe → can reach `window.parent` / wallet UI. **Fix:** validate `^guest:[a-z0-9]{1,32}$` server-side; render names with `textContent`. |

### High

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **2** | **`pendingSettle` keyed by player only — cross-chain obligation overwrite** | `token-http.js:257-260,590-597` | Obligation map uses `player` alone. Multi-chain RPC config (`server.js:182-185`) allows same wallet to settle on chain A (withheld loss), then buy in on chain B → `recordObligation` overwrites chain-A loss with chain-B entry → recover on A may fall through to **net=0 orphan** and refund full principal. **Repro:** `pending-settle-key-probe.js`. **Fix:** composite key `(player, chainId, contract)`. |
| **3** | **24h GC + non-atomic `doSettle` → loss-escape via net=0 orphan** | `token-bridge.js:84`, `token-http.js:478-485`, `618-625` | `doSettle` calls `bridge.settle()` then `recordObligation`+`saveHttp()` **outside `batchWrite`** (unlike `doStart`/`doTopUp`). Crash between writes loses obligation while bridge holds closed+settled session. Branch (2b) re-issues until `gcClosed` deletes settled sessions after 24h — then recover hits branch (3) **fresh net=0**. Withheld-loss + patient attacker. **Fix:** wrap settle in `batchWrite`; consider never GC-ing settled sessions that had `netWei < 0`. |
| **4** | **Demo balance leak on lazy canvas paths (incomplete v12.59)** | `app.js:2520,2544,2581,2709,2751` | v12.59 fixed `exitDemo`/`syncTokenGameBalances` but **Gem Vault** still `setBalance(demoUsd)` when connected-not-token (`2520`); Reef/Fish Shooter `initialBalance: demoUsd` in `build*` with ready handlers that skip connected-not-bought-in case. Connected wallet can play token games on **demo ledger** until first shot. **Fix:** `(TokenMode.active() ? tokens() : (account ? 0 : demoUsd))` everywhere. |
| **5** | **BJ felt sub-assets `?v=1257` vs SW cache `ctf-v12.59`** | `blackjack.html:16,96-103`, `app.js:3511`, `sw.js:6` | Parent loads `blackjack.html?v=1259` but inner CSS/JS still `?v=1257`. SW is cache-first → returning users keep **pre-12.58 felt** (one-tap buy-in, mobile dock fixes never apply). **Fix:** bump all felt inner `?v=` to `1259`. |
| **6** | **Token bridge V1-only — incompatible with undeployed V2** | `token-bridge.js:155-157,242`, `public/contract.js`, `CoinFlipBettingV2.sol:551` | Production uses global `bjLocked`; bridge signs `(player, net, nonce, chainId, contract)` without `sessionId`. V2 `settleSession` requires `sessionId` in digest. Cross-session drain PoC still valid on prod; **V2 deploy blocked on bridge rewrite**. Owner + code. |

### Medium

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **7** | **Per-IP rate limit bypass via spoofed `X-Forwarded-For`** | `token-http.js:878-882` | `clientIp()` trusts first XFF token; Express has no `trust proxy`. Attacker rotates header → fresh buckets on `/start`, `/topup`, `/settle`, `/release` (12s RPC each). DoS on single-instance event loop. |
| **8** | **`doTopUp` liveness checks race across `await verifyBuyIn`** | `token-http.js:430-443` | `liveExternal`/`liveCrashSession` checked before await; WS `cr:start` can reserve during RPC window. Principal changes mid-round (design violation, not ledger corruption). |
| **9** | **Manual crash round: disconnect = forced bust, no cross-tab cash-out** | `crash-rounds-ws.js:136-138`, `crash-rounds.js:88` | Manual round on socket drop: timer busts at crash point. `activeBySession` blocks new `cr:start`; ownership bound to dead socket → winning manual round lost on transient disconnect. |
| **10** | **Auto iframe reload lacks `bjDockLive` guard** | `app.js:3755-3758,3499-3504,3063,914` | `bjReload` guarded (#25); `renderBjDock` self-heal, `ensureBlackjackReady` sid drift, `renderWallet` still tear down iframe mid-hand → disconnect grace → auto-stand. |
| **11** | **Unpinned `contract` in token HTTP + admin owner-gate** | `token-http.js:331,630-660` | Caller supplies `contract`; `requireOwner` checks owner of *that* contract → anyone is "owner" of their clone. Signatures bind contract in digest (no replay on real contract) but defense is incidental. Allowlist/registry pin recommended. |
| **12** | **Fish token burst-fire parallel bets** | `fishshooter.js:386-392`, `fishtable.js:330-334` | Token mode skips optimistic local debit; rapid auto-fire queues parallel `TokenMode.bet()` before balance updates. Over-fires; server rejects extras (v4 #3 carried). |
| **13** | **Gem Vault slots3d PF verify broken (server ≠ client derivation)** | `server/games/slots3d.js:83-90`, `public/slots3d-engine.js:143-155` | Server uses `PF.floats` with cursor; client verify uses HMAC without cursor + different stop mapping. Players cannot reproduce spins. Token mode uses server grids (money OK); PF claim broken. |
| **14** | **fishshooter/reef bonus disbursement server-only, unverifiable** | `server/games/fishshooter.js:134-145`, `reef.js:99-114` | Chest/storm/frenzy payouts use server `expDraw`; client engine lacks path → re-derive from reveal under-credits vs server. |
| **15** | **Fish bonus tail can exceed house bankroll → stuck settle** | `fishshooter.js:130-133` | Unbounded exp disbursement vs on-chain `HouseBankrollLow` clamp — legitimate big win may become unclaimable. |
| **16** | **`_betError` nukes live session on regex-matched transient errors** | `token-mode.js:267-277` | Any bet error matching `/invalid session token|no such session|session is closed/` clears client session globally. One bad response during fish burst strands UI until re-resume. |
| **17** | **WS connection flood — no cap, O(N²) broadcast** | `server.js:360-363,366` | Per-message rate limit only; unlimited connections × `broadcastPlayers()` on each connect. |
| **18** | **Mobile token bar `innerHTML` rebuild aborts slider drag** | `token-mode.js:299-363` | Balance poll → `render()` replaces `#token-mount` wholesale during touch drag on buy-in/top-up sliders (v12.58 one-tap UX). |
| **19** | **Top-up HUD skip during fish reveal window** | `app.js:3054-3055` | `_tokenRevealUntil` skip blocks **all** balance sync including top-up-driven `onChange` — canvas HUD lags until next shot (v12.59 partial). |
| **20** | **Post buy-in betMax defaults to $200 while balance loading** | `blackjack-ui.js:454-456`, `app.js:3683` | Felt `balance` null until first `bj:wallet` → `betMax=200`; $50 buy-in player can select $200, server rejects. One-tap UX friction. |
| **21** | **`kindMismatch` event not shown to guest** | `blackjack-server.js:527-530`, `blackjack-ui.js` | Guest opening real-table link silently redirected to demo table. |
| **22** | **Guest `bj:topup` unbounded play-money mint** | `blackjack-server.js:374-391` | Up to $100k/call, any phase, no cooldown — corrupts demo bank + `.bj-bank.json`. |
| **23** | **`drainOrphanReservations` skips `closed` sessions** | `token-bridge.js:412` | Open crashRound on closed session never drained; blocks BJ on that session forever (edge: liveness guard absent). |
| **24** | **GameRegistry browser artifact pre-#28 zero-guard** | `public/contract.js` vs `GameRegistry.sol:28-37` | In-browser deploy gets registry without `InvalidAddress` on `setActiveGame(0)`. |

### Low

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **25** | **Stale `tokenBind` after live-hand `dropSeat`** | `blackjack-server.js:602-610` vs `599` | Insurance/idle path unbinds; live-hand abandon path does not. |
| **26** | **`bjCountTimer` ticks after leaving BJ channel** | `app.js:3667,3801-3805,3841` | Interval not cleared on channel switch. |
| **27** | **`bjFramePost(true)` 50ms timer missed on cold load** | `app.js:3522`, `blackjack.html:135-141` | Post before felt listener ready; use `bj:ready` ack. |
| **28** | **`render.yaml` auto-deploys from feature branch** | `render.yaml:9` | Any push to `claude/ethereum-betting-game-vrf-2dq50k` → production. |
| **29** | **`bjPersist.load()` silent corruption → empty bank** | `server.js:108-111` | Token store hardened; guest bank still swallows parse errors. |
| **30** | **SPA catch-all serves `index.html` for unknown `/api/*`** | `server.js:300-302` | 200+HTML instead of 404 JSON; can confuse `token-client.status()`. |
| **31** | **Unbounded `usedBuyIns` / abandoned session maps** | `token-http.js:213-229,319-328` | No GC for never-settled sessions; disk/memory growth. |
| **32** | **`TOKEN_MIN_CONFIRMATIONS` defaults to 1** | `server.js:236`, `render.yaml` | Thin reorg window; not pinned in deploy config. |
| **33** | **postMessage receivers omit `e.origin`** | `app.js`, `blackjack.html`, `blackjack-ui.js` | v4 #8 residual; low live risk (same-origin iframe). |
| **34** | **Reef treasure chest animation ≠ server payout** | `fishtable.js:596+` | Cosmetic; balance authoritative. |
| **35** | **Poker server unwired; `sit()` drops `clientSeed`** | `server.js`, `poker-server.js:644-666` | Latent PF weakness if poker enabled. |
| **36** | **Sky Swoop balance wiring inconsistent** | `app.js:2631,3141,3057` | Hidden channel; contradictory token/demo handling. |
| **37** | **EIP-7702 may bypass `_betGuard` (`msg.sender == tx.origin`)** | `CoinFlipBettingV2.sol:58-59` | Delegated EOA code could revert-drain on loss; strategic/owner assessment. |

---

## Owner-only (neither AI)

| Ref | Item |
|-----|------|
| v3 #4 | Deploy `CoinFlipBettingV2` + registry pointer |
| v3 #5 | Commit-reveal / VRF; EOA `eth_call` until then |
| v3 #31 | Regenerate `public/contract.js` with V2 |
| v3 #29 | Fee-accounting policy |
| v3 #42–43 | prevrandao; smart-account guard policy |
| — | Wallet E2E Sepolia smoke |

---

## Remediation plan (Pass 8 waves)

### Wave 0 — Security (P0)

| Step | # | Action |
|------|---|--------|
| 0A | **1** | Sanitize guest ids + `textContent` for BJ names |
| 0B | **2** | Composite `pendingSettle` key; probe → update when fixed |
| 0C | **3** | `batchWrite` around `doSettle`; GC policy for losing settlements |

### Wave 1 — Money / deploy integrity

| Step | # | Action |
|------|---|--------|
| 1A | **4** | Complete demoUsd purge on all lazy canvas paths |
| 1B | **5** | Bump BJ felt inner `?v=1259` |
| 1C | **6–7** | Bridge V2 rewrite plan; fix XFF/`trust proxy` |
| 1D | **11** | Contract allowlist on token HTTP |

### Wave 2 — Client / UX

| Step | # | Action |
|------|---|--------|
| 2A | **10,20,27** | Extend `bjDockLive`; suppress bet UI until balance; `bj:ready` handshake |
| 2B | **12,16,19** | Fish in-flight cap; narrow `_betError`; top-up bypass reveal hold |
| 2C | **18** | Targeted token bar updates vs full `innerHTML` |

### Wave 3 — PF / engines / ops

| Step | # | Action |
|------|---|--------|
| 3A | **13–15** | slots3d client parity test; document fish bonus path; cap tail payouts |
| 3B | **28–32** | render.yaml branch policy; persist hardening; API 404; env pins |

---

## Rules for fix agents

- Coordinate via **`AGENTS.md`** on deploy branch.
- **Do NOT re-file** v3/v4 fixes without regression proof.
- Probe-gate money-path changes; bump `?v=` / `ctf-v12.XX` on public changes.
- Use **Pass 8 # numbers** from this report.

---

*End Pass 8. Handoff prompt: `CursorBugHunt-v5/CLAUDE-PROMPT.txt`*
