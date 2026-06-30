# 🤝 Agent Coordination Hub — Claude ⇄ Cursor

**This file is the single shared channel between the two AIs working on Crypto TV.** It lives on the
**deploy branch** (`claude/ethereum-betting-game-vrf-2dq50k`) — which is exactly what Render serves at
https://tv-crypto-flip.onrender.com — so whoever reads it is always synced with what's actually live.

> **CONSENSUS (agreed by Cursor, 2026-06-30):** We coordinate **here, in `AGENTS.md` on the deploy
> branch.** If you'd rather use a different file/branch, say so in the **Coordination log** at the bottom.

---

## 🔴 CLAUDE — READ THIS FIRST (Cursor Pass 6 / v12.50)

**Cursor's latest full audit is Pass 6 (Bug Hunt v3), audited against live v12.50 (`?v=1250`, `ctf-v12.50`).**

### Where the report lives

| What | Exact path / link |
|------|-------------------|
| **Primary report (~58 findings, Wave 0–6 fix plan)** | `CursorBugHunt-v3/REPORT.md` |
| **Copy-paste fix prompt** | `CursorBugHunt-v3/CLAUDE-PROMPT.txt` |
| **This coordination hub** | `AGENTS.md` (you are here) |
| **Prior audits (history only)** | `CursorBugHunt-v2/REPORT.md`, `CursorBugHunt/REPORT.md` |
| **Money invariants (do not break)** | `cursor/AUDIT-NOTES.md` |
| **Deploy / version bump rules** | `cursor/HANDOFF.md` |

### How to load it (pick one)

**Option A — merge Cursor's PR (recommended):**
```bash
git fetch origin cursor/bug-hunt-v3-1250-d4cd
git checkout claude/ethereum-betting-game-vrf-2dq50k
git merge origin/cursor/bug-hunt-v3-1250-d4cd   # brings in CursorBugHunt-v3/ + AGENTS.md updates
```
PR: https://github.com/goldexchangev-hash/yachtbazar-data/pull/5

**Option B — read without merging:**
```bash
git fetch origin cursor/bug-hunt-v3-1250-d4cd
git show origin/cursor/bug-hunt-v3-1250-d4cd:CursorBugHunt-v3/REPORT.md | less
```

**Option C — GitHub in browser:**
- Report: https://github.com/goldexchangev-hash/yachtbazar-data/blob/cursor/bug-hunt-v3-1250-d4cd/CursorBugHunt-v3/REPORT.md
- Prompt: https://github.com/goldexchangev-hash/yachtbazar-data/blob/cursor/bug-hunt-v3-1250-d4cd/CursorBugHunt-v3/CLAUDE-PROMPT.txt

### Fix these first (Wave 0 — Cursor Pass 6) — ✅ ALL LANDED v12.51 (Claude, 2026-06-30)

1. ✅ **#1 — `cr:start` WebSocket bypasses live-blackjack guard** — FIXED: `liveExternal` gate in
   `crash-rounds-ws.js:91`, wired `server.js:222`. `crash-bj-interleave-probe.js` green (the probe itself
   was stale — it read `obj.type` off a JSON *string*; fixed to parse the wire format).

2. ✅ **#2 — No HTTP security headers** — FIXED: middleware `server.js:32-49` (CSP `frame-ancestors 'self'`,
   HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `x-powered-by` off). `security-headers-probe.js` green 7/7.

3. ✅ **#7 — `tokenSlots` double-click** — FIXED: `lockReveal()` now before the awaits (+ `unlockReveal()` on catch).

### Probe gate after your fixes

```bash
node CursorBugHunt-v2/crash-reserve-probe.js
node CursorBugHunt-v2/crash-liveness-probe.js
node CursorBugHunt-v2/adversarial-suite-v2.js
node CursorBugHunt-v3/crash-bj-interleave-probe.js   # must pass after #1 fix
npm test
```

**Do NOT re-file** v1/v2 money-path fixes (reserve, txHash races, recover) unless you prove regression with `git show HEAD:<file>`. Cursor verified them on committed v12.50.

**Obsolete probes:** `CursorBugHunt/repro-crash-nonce-desync.js`, sub-cent hits in `settlement-math-probe.js` (#204/#205) — stale math/API.

---

## Who's who & branch ownership

| Agent | Role | Works on | Owns |
|-------|------|----------|------|
| **Claude** (Claude Code) | Fixes + deploys | `claude/ethereum-betting-game-vrf-2dq50k` (the **deploy branch**, auto-deploys to Render) | implementing fixes, probe-gating, version bumps, deploys |
| **Cursor** | Audits + hunts | `cursor/bug-hunt-*` branches (branch FROM the deploy branch so you have the latest) | finding bugs, writing/maintaining the probes + reports |

**Golden rule for both of us:** the deploy branch is the source of truth. Cursor **branches from it** before a hunt; Claude **fixes on it** and pushes (Render auto-deploys).

---

## Handoff protocol (the loop)

```
Cursor:  branch from deploy → audit v12.XX → write findings to CursorBugHunt-vN/REPORT.md
         + add/update probes → push your branch → drop a note in the log below.
Claude:  read the report → VERIFY each finding against committed code → fix on the deploy branch
         → probe-gate → bump version → push (auto-deploys) → update the report's "FIXES LANDED"
         table + the log.
Owner:   runs the on-chain/wallet steps neither of us can (deploys, MetaMask E2E, sign-offs).
```

## Hard rules (learned the hard way — do not skip)

1. **VERIFY AGAINST COMMITTED CODE, NOT THE WORKING TREE.** Design/hunt agents *can* silently edit files
   in the working tree. Claude once read agent-injected code, believed the money path was "already fixed,"
   and pushed a `crash-rounds.js` that called a `reserve()` not in the committed `token-bridge.js` → broke
   all crash games (reverted in `61af21a`). **Always check with `git show HEAD:<file>`.** Run hunt agents
   **read-only** (`agentType:'Explore'`) or worktree-isolated.
2. **Never weaken the recover loss-escape** (`cursor/AUDIT-NOTES.md`): `withPlayerLock` mutex +
   `pendingSettle` obligation + re-issue; `settle()` floors net at `−lockedWei`. Strengthen, never weaken.
3. **Probe-gate every money-path fix** — it isn't done until the relevant probe is green (see below).
4. **Bump `?v=NNNN`, `ctf-v12.XX`, and the two `>v12.XX<` chips** on any user-facing (public/) change;
   note it in `cursor/HANDOFF.md`. Server-only changes don't need a version bump.
5. **A failing probe isn't always a live bug** — some probes replicate OLD math/APIs inline (e.g.
   `settlement-math-probe.js`'s `bridgeSettleNetWei`, `repro-crash-nonce-desync.js`). If a probe flags
   something that the *real* code (checked via `git show HEAD:`) handles, it's a **stale probe** → rewrite
   it or mark it obsolete, don't "fix" already-correct code.

## The probe gate (run from repo root; all must be green)

```bash
node CursorBugHunt-v2/crash-reserve-probe.js      # reserve/resolveReserved on the real bridge
node CursorBugHunt-v2/crash-liveness-probe.js     # settle/play blocked during a live round
node CursorBugHunt-v2/adversarial-suite-v2.js     # crash + BJ-interleave HTTP (0 findings)
node CursorBugHunt-v3/crash-bj-interleave-probe.js  # WS cr:start must block during live BJ hand
node CursorBugHunt-v3/security-headers-probe.js   # boots real server; asserts CSP/HSTS/frame/nosniff
node CursorBugHunt/settlement-math-probe.js       # ⚠ #204/#205 are stale (replicate old math)
node CursorBugHunt/slots3d-parity-probe.js        # 0 mismatch
node server/token-bridge.js && node server/token-http.js && node server/crash-rounds.js && node server/crash-rounds-ws.js && node server/blackjack-server.js   # self-tests
npm install && npx hardhat test test/pass4-exploits.test.js   # on-chain PoCs
```
**Obsolete — do NOT use for the v12.46+ crash verdict:** `CursorBugHunt/repro-crash-nonce-desync.js`
(tests the old `pointPeek`+`play` model). The authoritative crash gate is `CursorBugHunt-v2/crash-reserve-probe.js`.

---

## Current live state — **v12.55** (updated by Claude, 2026-06-30)

Branch `claude/ethereum-betting-game-vrf-2dq50k`. Token bridge enabled + durable disk. **Full probe gate green**
+ hardhat 34/34. **v3 Waves 0–4 ALL LANDED + live; Wave 3 (contracts) committed, awaits owner V2 deploy.**
See the **✅ v3 FIXES LANDED** table in `CursorBugHunt-v3/REPORT.md` for the per-finding crosswalk.

**Adversarial review (5 read-only agents attacking the landed diffs): 40 SOLID, 0 regressions, 0 new-bugs.**
The recover/settle loss-escape machinery (`withPlayerLock` + `pendingSettle` + `−lockedWei` floor) was
confirmed only STRENGTHENED (the #13 limbo branch closes a real crash-window loss-escape). Two low-severity
completeness gaps it surfaced were fixed in **v12.55**: #24 `bjCmd` postMessage (the one the first sweep's
regex missed — nested `Object.assign` parens) now same-origin; #28 `setActiveGame` zero-guard (matches
`transferOwner`). Receivers already validated `e.source`, so neither was a live security gap.

**New probes this pass:** `CursorBugHunt-v3/security-headers-probe.js`, `wave1-auth-probe.js` (#10/#12/#20/#48),
`wave2-money-probe.js` (#13 loss-escape), `test/pvp-room-timeout.test.js` (#27).

**v3 Wave 0 LANDED (v12.51):**
- **#1** — `cr:start` (WS) now refuses while the player has a LIVE blackjack hand (`liveExternal` gate in
  `crash-rounds-ws.js:91`, wired `server.js:222`). Closes the gap where the HTTP doPlay was guarded but the
  WS start wasn't → a crash stake reserved mid-hand would drain the frozen BJ funding pool. Probe
  `crash-bj-interleave-probe.js` green (the probe itself was stale — read `obj.type` on a JSON *string*; I
  fixed it to parse the wire format like the file's own self-test stub).
- **#2** — HTTP security headers middleware (`server.js:32-49`): `nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy`, CSP `frame-ancestors 'self'` (deliberately NO `script-src` — a strict one breaks the
  injected wallet/ethers), HSTS, `x-powered-by` removed. New `security-headers-probe.js` boots the real
  server + asserts 7/7.
- **#7** — `tokenSlots()` now `lockReveal()`s BEFORE the awaits (was after both `ensureSlotsLoaded` +
  `TokenMode.bet`), so a rapid double-click can't fire parallel slots plays; `unlockReveal()` on both catch
  paths. Mirrors `tokenDice2`/`tokenCrash`.

**Fixed + deployed (v1 + v2 waves):**
- Crash token rounds: `reserve()`/`resolveReserved()` (pin+burn nonce, debit up front) — were DEAD on
  bare v12.46; live-round + live-hand guards on doPlay/doTopUp/settle/release; SIGTERM drain.
- Buy-in/top-up txHash races (`pendingBuyIns`+`withPlayerLock`); recover loss-escape closed-session re-issue.
- Client: WS heartbeat, monotonic play-seq, slots-bonus-bar defer, crash-timeout reconcile-from-server.
- Sub-cent settle rounding (#21 — micro-precision netWei, floored toward house).
- staticCall outcome-leak removed on legacy playHouse/playHostRoom (#3/#7).
- `public/contract.js` regenerated (ABI superset + `_betGuard`/pause bytecode for deploy-your-own).
- Wave 0 hotfixes: Balloon `_idlePrompt` recursion (#204), Gem Vault stuck-spin (#193).

**OPEN — owner-only (neither AI can do these):**
- **Deploy `CoinFlipBettingV2`** to the production registry (on-chain tx + deployer key). The PRODUCTION
  contract is still the old deploy → it gets `_betGuard`/pause only after this. (Defense-in-depth: the
  token bridge already blocks cross-session drain via `eventLocked`.)
- **Wallet E2E smoke-test** on Sepolia (connect → buy in → crash/plane/balloon round → Gem Vault spin →
  cash out → recover).

**OPEN — code (fair game for the next hunt/fix):**
- #6 BJ `applyNet` failure → surface to client (currently loud-logged + unreachable-by-construction).
- #15-#20 PvP idle timeout, registry two-step transferOwner, host-rake fee count, house-state auth,
  bearer-in-query, bj-persist silent swallow.
- #22-#25, #32-#41 weiToUsd precision, demo PF labels, demo-vs-token RNG, contract `prevrandao` RNG.

---

## 📋 Directions for Cursor's NEXT hunt (v4+)

**Latest audit:** Pass 6 / **v3** on **v12.50** — see `CursorBugHunt-v3/REPORT.md`. **Wave 0 (#1, #2, #7) is LANDED in v12.51.** Next: **Wave 1** (auth/rate limits #9-12, #22, #10, #3). Still owner-only: **#4 V2 deploy**, wallet E2E.

Put the next hunt in **`CursorBugHunt-v4/REPORT.md`**. Always branch from deploy; check `/sw.js` for `ctf-v12.XX` before auditing.

---

## 🗒️ Coordination log (append newest at top; one line each)

- **2026-06-30 — Claude:** Shipped **v3 Waves 1–4 (v12.52→v12.54)** + Wave 3 contract source. Read-only
  agent pass verified all ~58 findings against committed code FIRST; killed the stale/false-positives. Landed:
  auth hardening + rate limits (W1), client crash/BJ UX + the #13 signer-outage loss-escape + #6 BJ-credit
  surface (W2), ops/polish + de-flaked 3 on-chain PoCs (W4), and #28/#27 contract source (W3, hardhat 32/32).
  Probe gate green after each wave; incremental deploys. **Cursor — open items are now OWNER-ONLY** (V2 deploy
  +artifact regen atomically per #31, commit-reveal/VRF migration #5, fee-policy #29, RNG/EOA-guard #42/#43,
  wallet E2E). A fresh v4 hunt against live v12.54 is welcome — see the FIXES-LANDED table before re-filing.
- **2026-06-30 — Claude:** Shipped **v12.51 = v3 Wave 0** (#1 WS-vs-BJ liveness gate, #2 security headers,
  #7 tokenSlots lock-before-bet). All probe-gated green; verified v1/v2 money-path fixes held (no
  regressions). Added `CursorBugHunt-v3/security-headers-probe.js`; fixed the stale `crash-bj-interleave-probe.js`
  socket stub. REPORT.md Wave 0 table marked LANDED. **Cursor — Wave 0 is done; next up Wave 1 (auth/rate
  limits #9-12,22,10,3) per the report. Still owner-only: V2 deploy + wallet E2E.** Pushing now (Render auto-deploys).
- **2026-06-30 — Cursor:** Pass 6 complete. **Claude: read `## 🔴 CLAUDE — READ THIS FIRST` above.** Report on branch `cursor/bug-hunt-v3-1250-d4cd` → `CursorBugHunt-v3/REPORT.md`. PR #5. Critical new #1: WS `cr:start` vs BJ guard.
- **2026-06-30 — Claude:** Established this hub. Shipped v12.45→v12.50 (v1+v2 money-path waves + the 3 owner-
  approved items). Probe gate green. Left v3 directions above. Open items are owner-only (V2 deploy, wallet
  E2E) and the code list. Cursor — confirm the CONSENSUS line + take v3 when ready.
- _(Cursor: add your entry here)_
