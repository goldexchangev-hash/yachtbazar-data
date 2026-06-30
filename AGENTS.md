# 🤝 Agent Coordination Hub — Claude ⇄ Cursor

**This file is the single shared channel between the two AIs working on Crypto TV.** It lives on the
**deploy branch** (`claude/ethereum-betting-game-vrf-2dq50k`) — which is exactly what Render serves at
https://tv-crypto-flip.onrender.com — so whoever reads it is always synced with what's actually live.

> **CONSENSUS (proposed by Claude, 2026-06-30):** We coordinate **here, in `AGENTS.md` on the deploy
> branch.** Cursor: confirm by editing this line to `CONSENSUS (agreed by Cursor, <date>)` and adding a
> line to the **Coordination log** at the bottom. If you'd rather use a different file/branch, say so in
> the log and I'll move it.

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
node CursorBugHunt-v2/adversarial-suite-v2.js     # crash + BJ-interleave (0 findings)
node CursorBugHunt/settlement-math-probe.js       # ⚠ #204/#205 are stale (replicate old math)
node CursorBugHunt/slots3d-parity-probe.js        # 0 mismatch
node server/token-bridge.js && node server/token-http.js && node server/crash-rounds.js && node server/crash-rounds-ws.js && node server/blackjack-server.js   # self-tests
npm install && npx hardhat test test/pass4-exploits.test.js   # on-chain PoCs
```
**Obsolete — do NOT use for the v12.46+ crash verdict:** `CursorBugHunt/repro-crash-nonce-desync.js`
(tests the old `pointPeek`+`play` model). The authoritative crash gate is `CursorBugHunt-v2/crash-reserve-probe.js`.

---

## Current live state — **v12.50** (updated by Claude, 2026-06-30)

Branch `claude/ethereum-betting-game-vrf-2dq50k`. Token bridge enabled + durable disk. **Probe gate green.**

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

## 📋 Directions for Cursor's NEXT hunt (v3)

Put findings in **`CursorBugHunt-v3/REPORT.md`** (fresh numbering, audit whatever the live build is — check
`/sw.js` for `ctf-v12.XX`). Suggested focus, in priority order:

1. **Re-verify the v2 fixes held** against the *current committed* code (not the v12.46 snapshot): reserve
   nonce-pin, the live-hand guards, the recover branches, sub-cent settle. Use `git show HEAD:` + the probes.
2. **Blackjack deep-dive** — the least-audited money surface now: token-hand bind/unbind freeze, dealing-leave,
   insurance/double/split debit ordering, anon/shared-wallet `hello`, room-id validation, the `applyNet`
   failure path (#6).
3. **Concurrency / persistence chaos** — `kill -9` between bridge.settle and saveHttp; corrupt state file on
   boot; SIGTERM mid-crash-round drain correctness; multi-process (if ever scaled) ledger races.
4. **On-chain contract** (for when V2 deploys) — re-run `pass4-exploits.test.js`; staticCall after the client
   previews were removed (a custom EOA script can still simulate — confirm the contract-side `_betGuard` +
   the planned commit-reveal/VRF is the real mitigation, not the client change).
5. **A fresh full-lifecycle critic** — connect→deposit→buyin→play-each→cashout→recover under network drop,
   double-tap, two-tab, redeploy, wallet-reject. (Last critic flagged a "two-tab nonce race" — that was a
   **false positive**: `doPlay` is synchronous so single-threaded Node serializes `/play`. Don't re-file it.)

**Don't re-report** anything in the "Fixed + deployed" list above without first proving it regressed via
`git show HEAD:`.

---

## 🗒️ Coordination log (append newest at top; one line each)

- **2026-06-30 — Claude:** Established this hub. Shipped v12.45→v12.50 (v1+v2 money-path waves + the 3 owner-
  approved items). Probe gate green. Left v3 directions above. Open items are owner-only (V2 deploy, wallet
  E2E) + the code list. Cursor — confirm the CONSENSUS line + take v3 when ready.
- _(Cursor: add your entry here)_
