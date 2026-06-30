# Prompt for Claude — Crypto TV v12.46 bug fix (Hunt v2)

**How to use:** Open `CursorBugHunt-v2/CLAUDE-PROMPT.txt` at repo root, or copy everything below the `---` line.

---

You are taking over **Crypto TV v12.46** bug fix work. A full re-audit was done in **Bug Hunt v2**.

## Your mission

1. **Read** `CursorBugHunt-v2/REPORT.md` (primary — ~45 findings for v12.46).
2. **Skim** `CursorBugHunt/REPORT.md` only for historical context — many items are fixed or obsolete.
3. **Launch agents** to verify current code and find anything we missed.
4. **Fix in wave order** — Wave 0 (#1 reserve) is the blocker before anything else.
5. **Run v2 probes** until green; update `CursorBugHunt-v2/REPORT.md` with fixes.

Hi Claude 😀 — v1 had ~230 findings on v12.39. v12.46 fixed most money-path races but **crash token rounds are broken** until `token-bridge.js` gets `reserve()` / `resolveReserved()`.

---

## Where information lives

| What | Path |
|------|------|
| **v2 bug report (USE THIS)** | `CursorBugHunt-v2/REPORT.md` |
| v1 report (stale for crash) | `CursorBugHunt/REPORT.md` |
| v2 probes | `CursorBugHunt-v2/*.js` |
| v1 probes (settlement, slots, RTP) | `CursorBugHunt/*.js` |
| On-chain tests | `test/pass4-exploits.test.js` |
| Deploy / channel rules | `cursor/HANDOFF.md` |
| Money invariants | `cursor/AUDIT-NOTES.md` |

### Probes (repo root)

```bash
node CursorBugHunt-v2/crash-reserve-probe.js
node CursorBugHunt-v2/crash-liveness-probe.js
node CursorBugHunt-v2/adversarial-suite-v2.js
node CursorBugHunt/settlement-math-probe.js
node CursorBugHunt/slots3d-parity-probe.js
node CursorBugHunt/crash-rtp-probe.js
npm test
npx hardhat test test/pass4-exploits.test.js
```

**Do not trust** `CursorBugHunt/repro-crash-nonce-desync.js` on v12.46 — it tests the old `pointPeek`+`play` model.

---

## Repo

- **GitHub:** https://github.com/goldexchangev-hash/yachtbazar-data
- **Deploy branch:** `claude/ethereum-betting-game-vrf-2dq50k`
- **v2 hunt branch:** `cursor/bug-hunt-v2-1246-d4cd`
- **Live:** https://tv-crypto-flip.onrender.com (`?v=1246`)

---

## Fix order (REPORT.md waves)

- **Wave 0** — Implement `reserve`/`resolveReserved` in `token-bridge.js` (**#1**)
- **Wave 1** — BJ guards on `doPlay`/`doTopUp` (**#5, #10**)
- **Wave 2** — Regen `contract.js`, staticCall removal (**#2–#4**)
- **Wave 3** — Client balance/UX (**#11–#14**)
- **Wave 4** — Ops polish

---

## Rules

- Never weaken recover loss-escape (`cursor/AUDIT-NOTES.md`).
- Bump version strings on user-facing changes.
- Reference v2 finding **# numbers** from `CursorBugHunt-v2/REPORT.md`.

Go.
