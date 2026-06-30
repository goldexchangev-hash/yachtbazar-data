# Cursor Bug Hunt — Crypto TV (v12.39)

**Date:** 2026-06-30 (fifth pass — meta-review + settlement/live probes)  
**Site:** https://tv-crypto-flip.onrender.com  
**Branch:** `claude/ethereum-betting-game-vrf-2dq50k` @ `09b1d18`  
**Build:** `?v=1239`, `ctf-v12.39`

---

## Methodology

| Pass | Agents / tools | Scope |
|------|----------------|--------|
| 1 | Initial parallel audits | Money paths, games, server, tests |
| 2 | 4 agents | Expanded client/server, adversarial nonce repro |
| **3** | **6 agents + adversarial suite** | Contracts, blackjack, session restore, math parity, WS/API edges |
| **4** | **8 agents + live probes** | Chaos/persistence, concurrency fuzzer, fork PoCs, host/PvP, wallet flows, canvas lifecycle, live site probes |
| **5** | **6 agents + meta-review** | Live v12.44 diff, settlement math, slots3d parity, crash RTP verify, HANDOFF cross-ref, admin/RPC |

**Scripts in this directory:**
- `repro-crash-nonce-desync.js` — crash pacing vs settlement nonce mismatch
- `crash-rtp-probe.js` — fixed-strategy crash RTP (#136 closed false positive)
- `adversarial-suite.js` — txHash races, dual sessions, crash loss escape
- `concurrency-fuzzer.js` — parallel HTTP+WS+BJ interleave harness
- `fork-staticCall-poc.js` — on-chain staticCall cherry-pick PoC
- `settlement-math-probe.js` — netWei rounding, doRelease orphan escape (#215)
- `slots3d-parity-probe.js` — 10k evaluate parity + token replay

```bash
npm test
node CursorBugHunt/adversarial-suite.js
node CursorBugHunt/concurrency-fuzzer.js
node CursorBugHunt/repro-crash-nonce-desync.js
node CursorBugHunt/crash-rtp-probe.js
node CursorBugHunt/settlement-math-probe.js
node CursorBugHunt/slots3d-parity-probe.js
node CursorBugHunt/fork-staticCall-poc.js
npx hardhat test test/pass4-exploits.test.js
```

---

## Executive summary

**~230 findings** across five passes (#1–#138 P1–3; #139–#203 P4; **#204–#230 P5**). Live production is **v12.44** (`?v=1244`); repo workspace is **v12.39** — several P1–4 findings **fixed on live** but repo stale (see Pass 5).

**Top risks (all passes):**
1. **Token crash rounds** — nonce desync, unstaked rounds, settle mid-round, server restart (#1–3, #141)
2. **Persist / recover loss escape** — split-brain persist (#139–#140), **closed session + stale `openByPlayer` → orphan `net=0` (#215)**
3. **Buy-in/top-up txHash replay** — concurrent and sequential (#4–5, #139)
4. **On-chain staticCall** — one-probe dice cherry-pick (#6, #174–175)
5. **Live-only regression** — **`pressure-ui.js` `_idlePrompt()` infinite recursion breaks demo Balloon Pop (#204 live)**
6. **PvP rooms never timeout** — escrow locked forever (#147)
7. **Gem Vault spin stuck** on channel leave (#193)

---

## Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Exploitable fund loss, double-credit, fairness break, or provably wrong settlement |
| **High** | Broken real-money UX, orphaned state, latent security if feature enabled |
| **Medium** | Desync, reliability, DoS, verification broken, economic edge cases |
| **Low** | Polish, cache/version, demo-only, cosmetic |

---

## All findings (most severe → least)

### Critical

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **1** | Crash rounds nonce desync **[REPRODUCED]** | `crash-rounds.js:41-54,95-102`, `token-bridge.js` | `pointPeek` at nonce N; interleaved `play()` advances nonce; settlement uses N+k. Animation ≠ ledger. |
| **2** | Crash stake not reserved; bust may not debit **[REPRODUCED]** | `crash-rounds.js`, `token-http.js`, `server.js:164` | Stake debited only at bust. Drain balance mid-round → `insufficient tokens` → loss not recorded. |
| **3** | Settle/release during live WS crash round **[REPRODUCED]** | `token-http.js:377-437`, `crash-rounds.js` | `liveExternal` checks blackjack only. Cash out mid Plane round → session closed → bust throws. |
| **4** | Buy-in txHash replay race (double session) **[REPRODUCED]** | `token-http.js:283-304` | Concurrent `doStart` same `txHash` both pass `usedBuyIns` before RPC returns. Two sessions, one chain tx. |
| **5** | Top-up txHash replay race (double credit) **[REPRODUCED]** | `token-http.js:352-366` | Same TOCTOU on `doTopUp` — one chain top-up credits twice (adversarial suite: 1000→3000). |
| **6** | On-chain instant games leak outcome via `staticCall` | `CoinFlipBetting.sol:768-1114`, `app.js:1669,1840` | `playDice`/`playCrash`/`playSlots`/`playHostRoom` return `won`/payout. EOA simulates until win, then submits. |
| **7** | V1 `bjLocked` cross-session principal release | `CoinFlipBetting.sol:458-498`, `token-http.js` | Global `bjLocked`; `settleBlackjack` zeros entire lock. V2 fix exists but not deployed/exported. |
| **8** | Stale `public/contract.js` — browser deploy missing pause/EOA guard | `contract.js`, `exportArtifact.js`, `app.js:968` | Shipped bytecode lacks `paused`, `setPaused`, `_betGuard` from source. In-browser deploy is pre-patch. |
| **9** | Plane stays demo/real after token buy-in | `app.js:640,3001-3005`, `plane-ui.js` | **Fixed on live v12.44** (`setMode("token")` in `syncTokenGameBalances`); **still broken in repo v12.39**. |
| **10** | Token `doPlay` allowed during live blackjack hand | `token-http.js:316-322`, `blackjack-server.js:143` | No `hasLiveHand` guard on `/api/token/play`. Drain token pool mid-hand; BJ debit/credit desync. |
| **11** | Token blackjack winnings silently dropped | `blackjack-server.js:109-116` | `applyNet` failure logged and swallowed — UI shows win, tokens never booked. |
| **12** | Leave/abandon during `dealing` settles incomplete hands | `blackjack-server.js:507-527` | `leave()` marks all hands `done` in non-betting phases including mid-deal one-card hands. |

### High

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **13** | `_resolve()` settled before `play()` succeeds | `crash-rounds.js:95-107` | Round cleared from maps before ledger debit; failed `play()` orphans state. |
| **14** | No balance check at `cr:start` | `crash-rounds-ws.js:81-101` | Round starts with `betUnits` > balance; fails only at bust. |
| **15** | HTTP instant crash + WS crash on same session | `app.js:3242`, `crash-rounds.js` | CH11 HTTP bet during active WS round advances nonce and spends unreserved stake. |
| **16** | Concurrent `doStart` dual open sessions **[REPRODUCED]** | `token-http.js:277,304` | Two different txHashes both pass `openByPlayer` check concurrently. |
| **17** | Token affordability gated on `gameWei` | `app.js:1925,2025,2136,2230,317-319` | Dice/Crash/Slots buttons + `spendableUsd()` ignore `TokenMode.tokens()`. |
| **18** | Plane balance poll overwrites token HUD | `app.js:1357` | 12s `refreshBalances` sets plane from `gameWei` without token guard. |
| **19** | Fish/Reef optimistic fire (unbounded in-flight) | `fishshooter.js`, `fishtable.js`, `token-client.js:136` | No local debit or in-flight cap; rapid shots exceed balance. |
| **20** | Out-of-order token responses corrupt balance display | `token-client.js:136` | Last response wins; stale ack inflates displayed tokens. |
| **21** | Plane/Pressure optimistic debit before `cr:start` ack | `plane-ui.js:350`, `pressure-ui.js:242`, `crash-rounds-client.js:85` | Client refunds on timeout while server may have live round. |
| **22** | CrashRounds singleton blocks all crash launches | `crash-rounds-client.js:74-103` | One global instance; stuck round blocks plane+balloon up to 120s. |
| **23** | Sky Swoop in-flight round frozen on channel leave | `swoop3d.js:299-300,524-533`, `app.js:3079` | `setActive(false)` pauses `_update`; stake locked; no `demoReset` for swoop. |
| **24** | Wallet connected + play-money canvas: header vs HUD diverge | `app.js:3052-3077,318-319` | Header shows `gameWei`; fish/slots/pressure use `demoUsd`. |
| **25** | Gem Vault token: no final `r.tokens` resync after bonus | `slots3d.js:281-314` | Local `E.evaluate` replay; **Pass 5: math lands on `r.tokens` when server sends grids** (#218 narrows to demo-only concern). |
| **26** | On-chain `prevrandao` RNG (no VRF on production path) | `CoinFlipBetting.sol:555-643`, `config.js:15` | Validator-influenced entropy; `vrf-version/` unused in deploy. |
| **27** | Compromised house signer can drain `houseBankroll` | `CoinFlipBetting.sol:472-498`, `realmoney.js` | Signed `net` unbounded except bankroll check; no on-chain play binding. |
| **28** | GameRegistry can point to brick/malicious contract | `GameRegistry.sol:25-35`, `app.js:5165` | No code-size check; `address(0)` allowed; `transferOwner(0)` allowed. |
| **29** | Client uses `staticCall` before host/house bets (amplifies #6) | `app.js:1669-1677,1839-1846` | Explicit simulate-first UX for on-chain games. |
| **30** | BJ iframe loads before token session resumes | `app.js:636-640,3396-3424`, `token-mode.js:52-62` | `ensureBlackjackReady` before `TokenMode.resume()` — stale `#bjtoken` without `bjsession`. |
| **31** | False “stranded lock / Recover” before token resume | `app.js:876,3012-3018` | `checkStrandedLock()` runs before `TokenMode.init()` completes. |
| **32** | Cross-tab token ghost sessions | `token-mode.js:38-41,219-220` | Single `ctf_token_session`; no `storage` listener; tab A cash-out leaves tab B stale. |
| **33** | Cached BJ bridge settlement can be stale | `app.js:3502-3517` | Valid cached signature skips server re-fetch; wrong net on submit. |
| **34** | Token top-up allowed mid-blackjack hand | `token-http.js:340-368` | Changes affordably for double/split mid-hand (guest top-up correctly blocked). |
| **35** | Token BJ dock hides TOP UP when short for double/split | `app.js:3598-3607` | `needFunds` ignored when `account` connected. |
| **36** | Second device blocked during BJ reconnect grace (90s) | `blackjack-server.js:486-546` | Same wallet new tab gets `already_seated` until grace expires. |
| **37** | Invalid `roomId` on BJ join opens different table | `blackjack-server.js:491-492` | Closed table link silently lands on arbitrary open room. |
| **38** | Plane demo RNG ≠ token/server RNG | `plane-engine.js` vs `games/crash.js` | 32-bit HMAC vs 52-bit PF stream; demo 3% default vs server 1%. |
| **39** | Slots3D grid derivation differs client vs server | `slots3d-engine.js` vs `games/slots3d.js` | Client HMAC bytes vs server `PF.floats`; verify panel false-fails token spins. |
| **40** | PF verification UI wrong for token games | `plane-ui.js`, `pressure-ui.js`, `slots3d.js` | In-game “verify” uses demo schemes, not `provablyfair.js` stream. |
| **41** | Pressure valve locks ignored in token mode | `pressure-engine.js`, `pressure-ui.js`, `games/pressure.js` | Demo pop pays locked floors; server pays 0 on bust. |
| **42** | Shared `"anon"` play-money blackjack bank | `blackjack-server.js:718`, `server.js:269` | Non-guest/non-0x `hello` address → all clients share wallet `"anon"`. |
| **43** | Standalone `blackjack.html` cannot join without `?guest=` | `blackjack-net.js:35`, `server.js:254` | No `hello` sent → perpetual `auth_required`. |
| **44** | Poker hole cards client-side (latent) | `poker-ui.js`, `poker-server.js` (unwired) | Authoritative server exists but not mounted. |
| **45** | WS `hello` allows address impersonation | `server.js:269-299` | Any string address for chat/presence; no signature. |
| **46** | Owner can drain `houseBankroll` while balances remain | `CoinFlipBetting.sol:436-442` | House games freeze; player deposits still withdrawable — insolvency DoS. |
| **47** | Experimental BJ bridge weaker persistence | `bridge-server.js:40-48` | No fsync/readback; `BRIDGE_STATE_FILE` not in `render.yaml`. |

### Medium

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **48** | Off-channel token plane/pressure promise resolves | `plane-ui.js:364-468`, `pressure-ui.js` | `_tokenEpoch` not bumped on `setActive(false)`. |
| **49** | `switchGame` unlocks balance before TV animation ends | `app.js:3297`, `tv.js:586` | Balance unfreezes while prior channel animation visible. |
| **50** | On-chain bets refresh balance before TV reveal | `app.js` `doPlayDice/Crash/Slots` | `gameWei` cache updates during `revealLock` display hold. |
| **51** | Gem Vault token balance updates before reel land | `slots3d.js:286-287` | HUD debited before animation completes. |
| **52** | BJ token session binding fragile (stale iframe) | `app.js:3393-3478` | v12.39 `&r=` helps; “Lock credits” UX still possible. |
| **53** | Blackjack iframe version skew | `app.js:3414` v1238, `blackjack.html` v1197-1198 | Split-brain deploy vs shell v1239. |
| **54** | BETBAR missing swoop/fishshooter sliders | `app.js` `BETBAR_GAMES` vs `BETBAR_SL` | Bet bar enrolled but no slider mapping. |
| **55** | Dice TV layer desync on reload | `app.js` restore block | `ensureDice3dReady` without `TV.changeChannel`. |
| **56** | Unguarded `.classList` in TV reveal | `tv.js` | Null layer throws mid-animation. |
| **57** | Guest BJ / token persist failures silent | `server.js:66-68`, `token-bridge.js:69` | `bjPersist.save` swallows errors. |
| **58** | Unbounded `clientSeed` on `/api/token/play` | `token-bridge.js:121`, `token-http.js:321` | Megabyte seeds burn HMAC CPU. |
| **59** | No rate limit on buy-in / RPC endpoints | `token-http.js:628-634` | `/start`, `/topup` hammer RPC (12s timeout each). |
| **60** | WS chat/broadcast spam | `server.js:221-319` | No per-connection rate limit on chat. |
| **61** | Reef `power` not clamped (fishshooter is) | `games/reef.js:135`, `fishshooter.js:168` | Arbitrary power affects kill math. |
| **62** | Pressure void below 1.20× refunds stake | `games/pressure.js:109-119` | Net 0 on sub-min targets; minor EV skew. |
| **63** | Multi-instance token ledger if scaled | `token-http.js:258`, `token-bridge.js:67` | In-memory per process; no distributed lock. |
| **64** | `/api/token/house-state` unauthenticated | `token-http.js:554-577` | Aggregate exposure readable by anyone. |
| **65** | Poker pool uses `gameWei` only | `app.js:3699`, `poker-ui.js` | Ignores token mode if poker re-enabled. |
| **66** | Legacy `ctf_bj_token_*` not cleared on TokenMode | `app.js:3421`, `token-mode.js:220` | Stale bridge token hijacks iframe fallback. |
| **67** | `demoUsd` cap on load only, not on save | `app.js:90-92,2935` | In-session/tampered balance can exceed cap until reload. |
| **68** | `pressure.balance` global localStorage key | `pressure-ui.js:42-43` | Not wallet-scoped; cross-profile leakage on shared machine. |
| **69** | SW cache-first stale `app.js` after deploy | `sw.js:37-50`, `index.html` | Versioned assets cached; logic changes need `?v=` bump. |
| **70** | Token `resume()` network failure silent | `token-mode.js:60-61` | Empty `.catch()`; no retry UI. |
| **71** | CrashRounds not restored on reload | `crash-rounds-client.js`, `app.js` | In-memory only; server may still hold round. |
| **72** | Game restore skips `switchGame()` side effects | `app.js:3786-3821` | No `unlockReveal`, channel pause, etc. |
| **73** | Fast reload / `accountsChanged` full page reload | `app.js:5103-5109` | Mid-buy-in/settle relies on chain truth only. |
| **74** | BJ insurance UI locks before server ack | `blackjack-ui.js:219` | `_insuranceDone` set early; error leaves UI stuck. |
| **75** | Standalone BJ felt never surfaces `needFunds` | `blackjack-ui.js:426-432` | TOP UP only in embed path. |
| **76** | Guest balance probe via pre-hello lobby subscribe | `blackjack-server.js:684-716` | `bj:lobby:subscribe` before auth; guest balance enumerable. |
| **77** | BJ postMessage `targetOrigin: "*"` | `app.js:3339+`, `blackjack-ui.js:466` | Embed trust model; demo OK, risky if real identity via URL only. |
| **78** | Mid-hand shoe reshuffle breaks PF claim | `blackjack-server.js:148-155` | New `shoeId` suffix mid-hand. |
| **79** | BJ `clientSeed` length uncapped | `blackjack-server.js:569`, `blackjack-ui.js:197` | CPU DoS per bet. |
| **80** | `verifySession` does not reject closed sessions | `token-http.js:583-587` | Closed session + lingering bearer → opaque `cr:error`. |
| **81** | `bindToken()` failure ignored on token `hello` | `server.js:281-287` | `ws.tokenSession` updates even when bind fails mid-hand. |
| **82** | `rounds` Map in crash-rounds never pruned | `crash-rounds.js:37,95` | Memory leak on long-running server. |
| **83** | `wsByRound` / `ws._crRounds` leak after disconnect | `crash-rounds-ws.js:56,121` | Null entries retained; Set grows. |
| **84** | `playBuckets` not pruned on orphan sessions | `token-http.js:263-273` | Rate-limit map grows. |
| **85** | Main hub WS no heartbeat (crash/chat half-open) | `app.js:4449-4474` | Unlike `BJNet` 35s stale detection. |
| **86** | `wsSend()` silently drops when WS closed | `app.js:4474`, `crash-rounds-client.js` | `cr:start` dropped; 12s misleading timeout. |
| **87** | `connectWS()` gives up after 5 retries | `app.js:4470` | Extended outage needs full reload. |
| **88** | `bridgeJson` fetches have no timeout | `app.js:3354-3384` | Legacy BJ bridge hangs indefinitely vs token 12s timeout. |
| **89** | `playSlots` post-spin bankroll cap (silent haircut) | `CoinFlipBetting.sol:1044-1106` | Jackpot line vs capped payout mismatch. |
| **90** | Instant game events missing → no TV reveal | `app.js:1962,2087,2193,2913` | Paid on-chain but UI says check balance. |
| **91** | Registry `activeGame` resolved once per session | `app.js:5164-5173` | Registry flip mid-session not picked up. |
| **92** | `config.js` vs `deployment.json` drift | `config.js`, `deploy.js` | Registry not written by deploy script. |
| **93** | Dice target window client/server mismatch | `app.js` clamp vs `games/dice.js` | Server accepts wider target range than client. |
| **94** | Fish demo RNG + bonus payout differs from token | `fishshooter-engine.js` vs `games/fishshooter.js` | `mulberry32` vs PF; bonus timing differs. |
| **95** | Reef demo same pattern as fish | `fishtable-engine.js` vs `games/reef.js` | Demo RTP ≠ token for bonus fish. |
| **96** | Channel switch mid fish token shot | `fishtable.js`, `fishshooter.js` | Catch FX on wrong channel; balance still syncs. |
| **97** | `doRelease` orphan branch + V1 commingled locks | `token-http.js:456-463` | Defense-in-depth gap on V1 contract. |

### Low

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **98** | Fish min bet $1 vs $10 elsewhere | `fishtable.js`, `fishshooter.js` | Inconsistent minimum stake. |
| **99** | Sky Swoop demo-only; max $1000 vs shell $500 | `swoop3d.js` | No token path; higher max than `HARD_MAX_USD`. |
| **100** | Plane engine default 3% edge | `plane-engine.js:138` | Wrong if constructed without `app.js` opts. |
| **101** | Legacy Crypto Reels CH12 orphaned | `app.js:2212`, `tv.js:721` | No channel in `index.html`. |
| **102** | WS crash `cr:*` unrate-limited | `crash-rounds-ws.js:73-116` | vs HTTP 30/s bucket. |
| **103** | Session bearer in query string | `token-http.js:627`, `token-client.js:80` | URL logging/history leak surface. |
| **104** | SW registered without cache-bust | `app.js:5243` | Old SW logic after deploy. |
| **105** | `token-client.status()` ignores `res.ok` | `token-client.js:55-59` | 503 HTML may break `enabled` flag. |
| **106** | Unknown `bj:*` intents silently ignored | `blackjack-server.js:713-728` | Typos hang client. |
| **107** | `cr:cashout` missing `roundId` misleading error | `crash-rounds-ws.js:104-108` | Says “already crashed”. |
| **108** | Crash client timeout copy wrong | `crash-rounds-client.js:85` | Says stake not taken; server may have round. |
| **109** | BJ channel switch doesn't `bj:room:leave` | `app.js:3316` | Seat stays; hand continues off-channel. |
| **110** | Guest reload toast says $1,000 vs $5,000 seed | `app.js:3349,4856` | `BJ_START=5000` mismatch. |
| **111** | `bjFrameMatchesWallet` ignores token session hash | `app.js:3386-3407` | Wallet-only match insufficient. |
| **112** | `ctf_game` remap without rewriting storage | `app.js:3787-3797` | `swoop`→`flip` in UI only. |
| **113** | Demo session tracker not persisted | `app.js:2949` | Resets every `enterDemo()`. |
| **114** | `pokerPoolUsd` in-memory only | `app.js:3699` | Lost on reload. |
| **115** | `bj_guest` shared across tabs | `app.js:3342` | Intentional demo identity leak. |
| **116** | `profile.js` accepts tampered LS | `profile.js:26-36` | Cosmetic only. |
| **117** | `ctf_last_bet` tampering | `app.js:312` | Affects default slider only. |
| **118** | CH12 `cryptoReels.credits` separate from demo | `slots.js:674` | Legacy balance not unified. |
| **119** | Host earnings omit crash/slots | `app.js:695-734` | `HOST_GAMES` incomplete. |
| **120** | `totalFeesCollected` statistical not cash flow | `CoinFlipBetting.sol:807+` | Misleading host analytics. |
| **121** | `dicePayoutCapBps` UI 1% fallback when read fails | `app.js:1875-1888` | Blocks合法 bets contract allows. |
| **122** | Reentrancy on withdraw (CEI OK, no `nonReentrant`) | `CoinFlipBetting.sol:322-338` | Low risk today. |
| **123** | ECDSA malleability (no low-`s`) | `CoinFlipBetting.sol:501-514` | `bjNonceUsed` mitigates replay. |
| **124** | Host rake odd-wei dust | `CoinFlipBetting.sol:708-710` | 1 wei to host on odd fees. |
| **125** | `uncaughtException` keeps process alive | `server.js:185` | May serve after corrupt state. |
| **126** | Crash `autoTarget` no upper bound | `crash-rounds.js:58` | Absurd timers/memory. |
| **127** | Invalid fish target debits stake, pays 0 | `fishshooter.js`, `reef.js` | UX footgun. |
| **128** | Dev harness paths partially blocked | `server.js:33-36` | Some dev assets still served. |
| **129** | CoinFlipBettingV2 not in CI/deploy pipeline | `hardhat.config.js` | V2 untested in `npm test`. |
| **130** | Hardhat tests: no BJ/settle/staticCall tests | `test/` | 22 tests; contracts only. |
| **131** | Swoop `onBalance` no `TokenMode` guard | `app.js:2622` | Latent if token wired to swoop. |
| **132** | `tokenSlots`/dice redundant 2800ms sync | `app.js:3225+` | Harmless redundancy. |
| **133** | `renderBjDock` balance double-write flicker | `app.js:3637-3646` | Cosmetic flash. |
| **134** | Obligation RPC failure strands release | `token-http.js:250-254` | Conservative but strands users. |
| **135** | Crash cash-out floor uses 1.01× for pressure | `crash-rounds.js:89` | Sub-1.01 releases clamp oddly. |
| **136** | Monte Carlo crash RTP >100% in one scan run **[CLOSED — false positive]** | `adversarial-suite.js`, `crash-rtp-probe.js` | Pass 5 probe: fixed 2.0× @ 500k → 98.92% RTP (Δ −0.08pp, within CI). Suite cycling @ 80k flags ~4/20 seeds by variance alone (max 101.46%); no engine bug. |
| **137** | Plinko not implemented in client | — | On-chain only if added later. |
| **138** | No automated BJ interleaving tests | `blackjack-server.js:753` | Happy-path self-test only. |

---

## Category index

| Category | Finding #s |
|----------|------------|
| **Crash rounds (token WS)** | 1-3, 13-15, 21-22, 71, 82-83, 102, 107-108, 135 |
| **Token HTTP / bridge** | 4-5, 10, 16, 58-64, 80, 84, 97 |
| **On-chain contracts** | 6-8, 26-29, 46, 89-93, 97, 119-124, 129 |
| **Blackjack** | 10-12, 30-37, 42-43, 52-53, 74-79, 109-111 |
| **Client token mode / UI** | 9, 17-20, 24-25, 48-51, 54-56 |
| **Session / localStorage** | 30-33, 66-73, 112-118 |
| **Math / provably fair parity** | 38-41, 39-40, 94-95, 136 |
| **WebSocket / API** | 42-43, 45, 59-60, 80-87, 105-108 |
| **Fish / Reef / Swoop** | 19, 23, 61, 94-96, 98-99, 127, 131 |
| **Deploy / cache / version** | 53, 69, 104, 91-92 |
| **Demo / play-money** | 24, 67-68, 113-114, 136 |
| **Poker (latent)** | 44, 65 |
| **DoS / ops** | 58-60, 64, 82-84, 125-128, 134 |

---

## Per-game test matrix

| Game / CH | Demo | On-chain | Token | Auto tests | Status |
|-----------|------|----------|-------|------------|--------|
| Coin Flip CH10 | ✓ | ⚠ #6 | ✓ | CoinFlipBetting | staticCall exploit |
| Dice CH15 | ✓ | ⚠ #6 | ⚠ #17 | Registry | UI gating |
| Dice#2 CH16 | ✓ | ⚠ #6 | ⚠ #17 | Registry | UI gating |
| Crash CH11 | ✓ | ⚠ #6 | ⚠ #17 | token-bridge | HTTP+WS interleave #15 |
| Plane CH14 | ✓ | — | 🔴 | crash-rounds | #1-3,9,18,21-22,38 |
| Balloon CH13 | ✓ | — | 🔴 | crash-rounds | #1-3,21-22,41 |
| Gem Vault CH17 | ✓ | ⚠ #6 | ⚠ #25,39 | slots3d engine | PF verify broken #40 |
| Blackjack CH18 | ✓ | bridge | ⚠ #10-12,30 | blackjack-server | Many BJ findings |
| Poker | ✓ | — | — | client engine | #44 latent |
| Reef CH17 | ✓ | — | ⚠ #19,61 | reef engine | Demo≠token #95 |
| Fish Shooter | ✓ | — | ⚠ #19 | fishshooter | Optimistic fire |
| Sky Swoop | ✓ | — | — | none | #23,99 |
| Crypto Reels CH12 | dead | — | — | none | #101 |
| Plinko | — | ? | — | none | #137 not in client |

---

## Bet limit / house edge inconsistencies

| Layer | Min | Max | Edge | Notes |
|-------|-----|-----|------|-------|
| On-chain contract | 0.0001 ETH | 1 ETH | Flip 3%, Dice 2%, Crash 1% | Authoritative |
| Client shell | $10 | $500 | Crash 1% | `HARD_MAX_USD` |
| Plane (via app) | $10 | $500 | 1% | OK |
| Plane engine default | $10 | — | **3%** | #100 |
| Pressure / Balloon | $10 | $500 | 3% | Valves #41 |
| Gem Vault 3D | $10 | $500 | ~5% | Grid deriv #39 |
| Reef / Fish | **$1** | $50 | ~15%/shot | Power #61 |
| Sky Swoop | $10 | **$1000** | 1% | #99 |
| Blackjack | $10 | balance/5 | — | Server minBet 10 |

---

## Test coverage gaps

| Area | Status |
|------|--------|
| Hardhat `npm test` | 22 pass — contracts + client poker engine only |
| Token bridge/HTTP self-tests | Extensive — no txHash race, no crash interleave |
| Crash rounds self-tests | Happy path — **no adversarial nonce** |
| `adversarial-suite.js` | **Reproduces #4-5, #16, #1-3** |
| `server.js` WS hub | **No tests** |
| All `public/` game clients | **No tests** |
| `poker-server.js` | Self-test only, not wired |
| On-chain staticCall exploit | **Not tested** |
| Blackjack interleaving | **Not tested** |
| E2E browser | **None** |

---

## Commands run

```bash
npm test                                         # 22 passing
node server/token-bridge.js                      # OK
node server/token-http.js                        # OK
node server/blackjack-server.js                  # OK
node server/crash-rounds.js                      # OK (happy path)
node server/crash-rounds-ws.js                   # OK
node public/token-client.js                      # OK
node server/games/{coinflip,crash,dice,dice2,pressure,reef,fishshooter,slots3d}.js  # OK
node CursorBugHunt/repro-crash-nonce-desync.js   # BUG REPRODUCED
node CursorBugHunt/adversarial-suite.js          # 8 findings
node CursorBugHunt/concurrency-fuzzer.js         # 6 findings
npx hardhat test test/pass4-exploits.test.js      # 28/29 pass
node CursorBugHunt/fork-staticCall-poc.js        # on-chain PoC
```

---

## Recommended fix priority

| P | Findings | Action |
|---|----------|--------|
| **P0** | 1-5, 13 | Crash: pin nonce, reserve stake, transactional `_resolve`, block settle/play during rounds; `pendingBuyIns` + `withPlayerLock` on start/topup |
| **P0** | 6, 8, 29 | Regen `contract.js`; remove/limit `staticCall` previews; commit-reveal or VRF |
| **P0** | 7 | Deploy CoinFlipBettingV2 per-session locks |
| **P0** | 9-12 | `setMode("token")`; block `doPlay` during BJ hand; surface credit failures; fix dealing leave |
| **P1** | 16-25, 30-33 | Token UI, session restore order, cross-tab sync, dual session mutex |
| **P1** | 34-37, 42-43 | BJ top-up policy, needFunds UI, room validation, anon wallet |
| **P2** | 38-41, 48-97 | Math parity, PF verifier, valves, WS heartbeat, memory pruning |
| **P3** | 98-138 | Polish, cache bumps, docs, monitoring |

---

## Well-hardened (verified OK)

- Token loss-escape / `pendingSettle` + per-player mutex on settle/release
- Cross-session drain guard on buy-in (`eventLocked`)
- Transactional engine-first bet reject in `play()`
- Settle idempotency; serverSeed never leaked pre-settle
- Blackjack real-wallet auth; token bind frozen mid-hand
- Atomic JSON persist for token/BJ on mounted disk
- Crash WS cash-out ownership check
- Server `play()` uses PF/HMAC only (no `Math.random` in production)
- BJ rules core: S17 default, 3:2, DAS, late surrender, insurance 2:1
- Demo cap on load (`DEMO_MAX_USD`); API rejects negative/zero/over-balance bets

---

# Pass 4 — Live Chaos & E2E Hunt (#139–#202)

**Method:** 8 parallel agents + live probes against https://tv-crypto-flip.onrender.com + `concurrency-fuzzer.js` + Hardhat `pass4-exploits.test.js`.

## Pass 4 Critical

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **139** | Two-phase persist split on buy-in | `token-http.js:303-312`, `token-bridge.js` | `bridge.start()` persists sessions **before** `saveHttp()` adds txHash/bearer. `kill -9` between → replay same txHash for second session (sequential #4). |
| **140** | Settle obligation gap (persist split) | `token-http.js:378-387`, `token-bridge.js:189-218` | `bridge.settle()` persisted before `pendingSettle`/`saveHttp()`. Crash after sign → closed session on disk, no obligation → Recover mints orphan `net=0` (#140 loss escape). |
| **141** | Server restart mid crash round | `crash-rounds.js`, `server.js:187` | In-memory rounds + timers lost on SIGTERM; stake never debited. Extends #2 for process death (not just drain). |
| **142** | Corrupt state file → empty store | `server.js:87-88`, `token-http.js:169-173` | `JSON.parse` fail → `{}` boot; replay spent txHash, orphan recover. |
| **147** | PvP open rooms never timeout | `CoinFlipBetting.sol:344-408` | Unlike host tables (`HOST_TIMEOUT`), PvP escrow locked forever if creator abandons. Only creator can `cancelRoom`. |
| **148** | `?contract=` phishing override | `app.js:23-33,5165-5173` | URL param bypasses registry; no code-size probe. Malicious link → victim deposits to attacker contract. |
| **193** | Gem Vault spin stuck on channel leave | `slots3d.js:690-696,648-652` | `setActive(false)` cancels RAF but not `_spinning`; stake debited; SPIN disabled forever. Token: server bet may complete while UI stuck. |

## Pass 4 High

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **143** | SIGTERM only flushes guest BJ bank | `server.js:184-187` | No token flush, no `server.close()` drain on deploy. |
| **149** | `playHouse` staticCall pins wrong `activeRoomId` | `app.js:1666-1683,4042-4077` | `staticCall` before tx sets room id; concurrent play desyncs → missed TV reveal. |
| **150** | `setActiveGameManual` stale session | `app.js:1045-1057` | Registry updated on-chain but `deployment.address`/`contract` not rebound until reload. |
| **151** | `deployRegistry` → treasury EOA brick | `app.js:1028-1031` | `activeGame` = treasury when no game deployed → `getCode` returns 0x, lobby broken. |
| **152** | Bet-proposal accept without chain stake verify | `app.js:4020-4037` | Join uses local `myProposal.amount`; no `r.betAmount` check; WS impersonation (#45) amplifies. |
| **153** | `paused` bypass for room ops | `CoinFlipBetting.sol:344-408,661` | `createRoom`/`createHostRoom` work while paused; funds escrow but can't play. |
| **174** | `gasleft()` makes staticCall RNG ≠ real tx | `CoinFlipBetting.sol:555-572` | 25/25 probe pairs mismatched rolls; skip-on-loss still works; sim-win not guaranteed. |
| **175** | Single-probe dice cherry-pick | `CoinFlipBetting.sol:768-812` | One `staticCall` leaks roll; attacker picks winning target post-hoc (refines #6). |
| **177** | Registry flip doesn't rebind TokenMode | `app.js:5164-5173,1045` | Same class as #150/#91; token auth still signs old contract after registry change. |
| **178** | Token buy-in: chain lock OK, server fails | `token-client.js:108-126` | `blackjackBuyIn` confirms then `/api/token/start` fails → stranded `bjLocked`. |
| **179** | Coin flip vs house: no receipt parse | `app.js:1655-1690` | Relies on event listener + 12s poll; missed event = no reveal (up to 20s). |
| **183** | Bridge + token double lock path | `app.js:3431-3485,3417` | `bjReload` still reachable while token session active before dock hides it. |
| **194** | Sky Swoop balance reset inflation | `swoop3d.js`, `app.js` | Leave mid-climb + `setBalance(demoUsd)` → cash out with refunded stake + win. |
| **195** | Reef auto-fire in background tab | `fishtable.js:698,858` | Unlike fishshooter, ticker keeps firing when `document.hidden`. |
| **199** | Live v12.43 vs repo v12.39 drift | production probe | `?v=1243`, `ctf-v12.43`; unaudited deltas in `app.js`, `sw.js`, `token-mode.js`. |
| **200** | WS chat impersonation **live confirmed** | `server.js:269-319` | Probe: fake `hello` + chat broadcast as arbitrary `0x` address on production. |

## Pass 4 Medium (selected)

| # | Title | Summary |
|---|-------|---------|
| **144** | `unhandledRejection` no BJ bank flush | Unlike `uncaughtException`; up to 800ms guest balance loss. |
| **145** | `doRelease` ignores `bridge.session.settlement` | Missing `pendingSettle` → orphan even when settlement on disk. |
| **146** | Render ops gaps | No `ENABLE_TOKEN_BRIDGE` in yaml; no shutdown hook; disk mount required. |
| **154–168** | Host/PvP/lobby UX | Idle host close only creator tab; empty tables cap grief; earnings wrong/truncated; daily streak tamper; bet-proposal spam/stuck; sybil room DoS; join +4 slack; chat name spoof; referral poison; reconcile design. |
| **176** | `doJoinRoom` zero receipt parsing | Worse than house path; stuck flip if event missed. |
| **180–182** | Wallet flows | Silent receipt fail; chain switch reload; stranded lock hidden when ghost session. |
| **196–198** | Canvas lifecycle | Plane/pressure token settle off-channel; slots WebGL context loss; pressure `setEnabled` strands pump. |
| **201** | Missing security headers live | No HSTS, CSP, X-Frame-Options on wallet dApp. |
| **202** | `house-state` exposure live | 1 open session, ~0.031 ETH locked visible without auth. |

## Pass 4 Low (selected)

| # | Title | Summary |
|---|-------|---------|
| **169–173** | PvP/host polish | 24 escrow cap per address; autoClose without wallet; host history timestamp estimate; referral link needs connect; cancelRoom no joiner notify. |
| **184–192** | Wallet polish | Registry localStorage; silent balance refresh fail; cached buy-in check; tx.wait no timeout; gas/nonce errors; partial connect; disconnect during token session. |
| **203** | `X-Powered-By: Express` exposed | Info leak on all responses. |

## Pass 4 harness results

**`concurrency-fuzzer.js`** (6 confirmed):
- 201 interleaved `doPlay` during live crash round; 9 nonce desync hits
- Settle during crash: `closed=true`, plane bet not recorded
- Concurrent top-up: 1000→3000 tokens from one tx
- 25/25 `doPlay` during simulated BJ hand
- Over-balance `cr:start` (bet 100, balance 3): bust debited nothing

**`pass4-exploits.test.js`**: V1 `bjLocked` cross-session, `_betGuard`, staticCall host/dice/crash PoCs (28/29 pass).

**Live probe**: Token bridge **enabled** on production; durable disk at `/var/data/.token-bridge.json`; experimental bridge off; admin POSTs require signatures.

---

## Updated fix priority (includes Pass 4)

| P | Findings | Action |
|---|----------|--------|
| **P0** | 1-5, 13, 139-142 | Single atomic persist; crash pin+reserve; `pendingBuyIns`; recover from `session.settlement` |
| **P0** | 6, 8, 29, 174-176 | Remove staticCall previews; deploy V2; parse receipts on join/house |
| **P0** | 147-148, 193 | PvP idle refund; validate `?contract=`; fix slots `setActive` spin abort |
| **P0** | 9-12, 10 | BJ interleave block; credit failures; dealing leave |
| **P1** | 149-153, 177-183, 194-195, 200 | Registry rebind; wallet stranded lock; host/PvP; canvas lifecycle; signed WS hello |
| **P2** | 154-168, 196-202, 204-230 | Host panel, headers, live sync, settlement rounding |

---

# Pass 5 — Meta-review & targeted deep dives (#204–#230)

**Method:** Reviewed all passes + `cursor/HANDOFF.md` + `cursor/AUDIT-NOTES.md`; ran 6 agents on gaps: live v12.44 diff, settlement math, slots3d parity, crash RTP (#136), admin/RPC, HANDOFF cross-ref.

## Pass 5 Critical

| # | Title | Files | Summary |
|---|-------|-------|---------|
| **204** | **LIVE** `_idlePrompt()` infinite recursion | live `pressure-ui.js?v=1244` L224-226 | Demo Balloon Pop: `return this._idlePrompt()` → stack overflow on channel entry/reset. **Not in repo** — live-only regression. |
| **215** | `doRelease` orphan when session closed but map stale | `token-http.js:426-442` | `openByPlayer` has sid, session `closed=true`, no `pendingSettle` → falls through to branch (3) `net=0`. **Loss escape** (refines #140/#145). **Repro:** `settlement-math-probe.js`. |

## Pass 5 High

| # | Title | Summary |
|---|-------|---------|
| **205** | Live `pressure-ui.js` not in repo | Token TAP UX at v1244 vs repo hold-to-pump; split-brain with cached v1243 modules (#208). |
| **206** | Live retires on-chain Plane for connected wallets | `mode:"token"` forced; repo still `mode:"real"`. Fixes #9/#15 on live only. |
| **207** | Experimental bridge: no confirmations / no ethUsd gate / pendingBuyIns race | `bridge-server.js` — High if `ENABLE_EXPERIMENTAL_BRIDGE=1` (off on production). |
| **216** | `admin-release` ignores `liveExternal()` | Owner can sign `net=0` while experimental BJ hand live (token path blocked via `openByPlayer`). |
| **217** | Stale `openByPlayer` blocks `admin-release` | Player `doRelease` clears stale slot; admin path throws "active session". |
| **218** | Slots3d `evaluate()` parity **proven** on shared grids | 0/10k mismatches; token replay 0/2000 drift. **#25 downgraded** — demo grid deriv differs (#219). |

## Pass 5 Medium

| # | Title | Summary |
|---|-------|---------|
| **208** | Mixed cache keys on live (v1243/1244) | Shell 1244, some lazy loads 1243; extends #69. |
| **209** | Live `HARD_MAX_USD` = $100 | Contract still ~$500 max; UI-only cap. |
| **210** | `syncTokensFromFelt()` dead code on live | Never called; latent trust issue if wired without server verify. |
| **211** | `TokenMode.refreshTokens()` every 1.5s during BJ | Races with in-flight plays (#20 amplification). |
| **212** | BJ felt `bjHealAt` reload mid-hand | Wallet connect on guest felt → iframe reload. |
| **213** | Live split funding: plane/pressure token, fish/slots demo | Evolves #24. |
| **219** | Slots3d demo grid uses HMAC; server uses PF floats | Demo verify panel false-fails token spins; not a paytable bug. |
| **220** | Sub-cent losses → `netWei=0` at settle | `round2()` before conversion; full lock returned on-chain. |
| **221** | RPC readers skip chain-ID check | `readBjLocked`/`readNonceUsed` vs `verifyBuyIn`. |
| **222** | Stale `BRIDGE_ETH_USD` env bypasses cold-start guard | `ethUsdReady()` true with wrong static price → ~2× token grant. |
| **223** | Bearer-only redeploy desync | Session on disk, `tokenForSession` empty → all `/play` 400 until manual clear (HANDOFF gap). |
| **224** | `receipt.to` null skips destination check | `verifyBuyIn` edge case with colluding RPC. |
| **225** | Unpinned `contract` on `/api/token/start` | Attacker can open session against self-deployed clone. |

## Pass 5 Low / closed / meta

| # | Title | Summary |
|---|-------|---------|
| **226** | `gcClosed` skips `createdAt=0` sessions | Persist bloat. |
| **227** | `play()` accepts `bet ≤ tokens + 1e-9` | Micro-overbet tolerance. |
| **228** | Production **v12.44** vs repo v12.39 | Updates #199; v12.40–43 deltas partially reviewed via live fetch. |
| **229** | `TOKEN_MIN_CONFIRMATIONS=1` default | No reorg depth on token buy-in. |
| **230** | REPORT "Well-hardened" overclaims vs #139–142 | Internal inconsistency; do not use as sign-off. |
| **#136** | **CLOSED** | `crash-rtp-probe.js`: 500k @ 2.0× = 98.96% RTP. |

## Live fixes (not in repo) — audit note

| Live v12.44 fix | Was REPORT # |
|-----------------|--------------|
| `setMode("token")` on buy-in | #9 |
| `bjReload` blocked when `TokenMode.active()` | #183 |
| `CrashRounds.active()` cash-out guard | new |
| `gameWeiChanged → TokenMode._render()` | new |

## HANDOFF / AUDIT-NOTES gaps

- **v12.39 BJ iframe fix** claimed in HANDOFF §6 — REPORT #30/#52/#53 still open in repo; not wallet E2E verified.
- **AUDIT-NOTES invariant #2** ("bulletproof recover") contradicted by #139–#140, #215.
- **`hasLiveExternal` scope** — AUDIT-NOTES implies all live external play; code only checks BJ (#3).
- **Root `AUDIT-2026-06-29.md`** referenced but not in workspace.
- **Channel numbers** in HANDOFF vs REPORT game matrix disagree (cosmetic doc error).

## Pass 5 harness results

```bash
node CursorBugHunt/settlement-math-probe.js   # 8 findings; #215 Critical reproduced
node CursorBugHunt/slots3d-parity-probe.js    # 0 evaluate mismatches; demo grid deriv differs
node CursorBugHunt/crash-rtp-probe.js         # #136 closed
curl live pressure-ui.js                      # #204 _idlePrompt recursion confirmed L226
```

---

# Master remediation plan

*Hi Claude 😀 — this is the fix order we'd use if we were shipping it all. Grouped so each **wave** is one focused PR (or one deploy), with issues batched by **same files / same subsystem**. Run the `CursorBugHunt/*.js` probes after each wave; add self-tests before moving on.*

**Rules of thumb**
- Never weaken `doRelease` loss-escape (#97, AUDIT-NOTES invariant #2).
- Bump `?v=`, `v12.XX`, `ctf-v12.XX` once per user-facing deploy.
- Money-path changes → extend `token-http.js` self-test + relevant `CursorBugHunt` script.
- Sync repo with live v12.44 **after** Phase 0 (don't reintroduce #204).

---

## Wave 0 — Live hotfix (deploy today)

**Goal:** Stop active user pain on production without waiting for the big server refactor.

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **0A** | **#204** | Fix `_idlePrompt()` → `return "HOLD the balloon to pump"` (or equivalent). Smoke-test demo Balloon Pop channel entry. | live `pressure-ui.js` → commit to repo |
| **0B** | **#205, #208** | Pull live `pressure-ui.js` into repo; single `BUILD_VERSION` for all lazy loads + shell + SW. | `pressure-ui.js`, `app.js`, `index.html`, `sw.js` |
| **0C** | **#193** | `slots3d.setActive(false)`: if `_spinning`, fast-forward `_settle()` or abort + resync from `TokenMode.tokens()`. | `slots3d.js` |

**Verify:** Manual — Balloon demo loads, Gem Vault channel-switch mid-spin recovers.

---

## Wave 1 — Crash rounds token path (highest $ risk)

**Goal:** One atomic server change set; fixes the exploit chain #1 → #3 → #13 → #141.

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **1A** | **#1, #13, #14, #102** | At `cr:start`: pin nonce, **reserve/debit stake**, balance check. `_resolve()`: call `play()` first; rollback `settled` on failure; try/catch on timer. | `crash-rounds.js`, `crash-rounds-ws.js`, `token-bridge.js` |
| **1B** | **#2, #3, #15, #141** | Extend `hasLiveExternal()` → `hasActiveCrashRound(sessionId)`. Block `doPlay`, `doSettle`, `doRelease` while round live. | `token-http.js`, `server.js` |
| **1C** | **#21, #71, #85–#86, #108** | Client: bump epoch on channel leave; WS heartbeat on main hub (copy `BJNet` pattern); fix timeout copy. | `crash-rounds-client.js`, `app.js`, `plane-ui.js`, `pressure-ui.js` |

**Tests to add:** Extend `concurrency-fuzzer.js` + `crash-rounds.js` self-test — interleaved play during round must fail or use pinned nonce.

**Verify:** `node CursorBugHunt/repro-crash-nonce-desync.js` → exit 0 (no desync). `node CursorBugHunt/concurrency-fuzzer.js` → CONC-* clean.

---

## Wave 2 — Persist, buy-in, recover (loss-escape hardening)

**Goal:** Single `token-http.js` + persist refactor PR. Restores trust in AUDIT-NOTES invariant #2.

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **2A** | **#4, #5, #16, #139** | `pendingBuyIns` set before RPC; `withPlayerLock(player)` on `doStart`/`doTopUp`. **One** `writeJsonAtomic` per op after all in-memory updates (bridge + http blob). | `token-http.js`, `token-bridge.js` |
| **2B** | **#140, #145, #215** | `doSettle`: record obligation + `saveHttp` in same atomic write as bridge settle. `doRelease` branch (1): if `s.closed && s.settlement`, re-issue settlement — **never** fall through to orphan `net=0`. | `token-http.js` |
| **2C** | **#142, #223** | Corrupt JSON → refuse start + alert; rehydrate `tokenForSession` with bridge on boot. Document bearer loss on redeploy in HANDOFF. | `server.js`, `token-http.js` |
| **2D** | **#143, #144** | SIGTERM: drain in-flight token ops + flush merged persist; `unhandledRejection` → `flushBjBank()`. | `server.js` |
| **2E** | **#220, #227** | Settle: compute `netWei` from unrounded `(tokens - buyInUnits)`; floor losses toward `-lockedWei`. Tighten `play()` bet check. | `token-bridge.js` |

**Tests to add:** `settlement-math-probe.js` scenarios → formal self-tests in `token-http.js` (split-brain sim, #215 closed-session recover).

**Verify:** `node CursorBugHunt/settlement-math-probe.js` → 0 findings. `node server/token-http.js` self-test OK.

---

## Wave 3 — Blackjack + token session integrity

**Goal:** Server guards first, then client iframe/session order.

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **3A** | **#10, #34** | `doPlay` (+ policy on `doTopUp`) → `if (hasLiveHand(player)) throw`. | `token-http.js` |
| **3B** | **#11, #12** | Propagate `applyNet` failures to client; defer `leave()` during `dealing` until deal completes or auto-finish. | `blackjack-server.js` |
| **3C** | **#30, #31, #66, #111, #52, #53** | Reorder connect: `TokenMode.init` + await `resume()` **before** `checkStrandedLock` + `ensureBlackjackReady`. Thread `#bjsession` in all paths; unify BJ `?v=`; clear legacy `ctf_bj_token_*` on token buy-in/out. | `app.js`, `blackjack.html`, `token-mode.js` |
| **3D** | **#35, #75, #183** | Surface `needFunds` for token + standalone; global guard on `bjReload` when `TokenMode.active()`. | `app.js`, `blackjack-ui.js` |
| **3E** | **#37, #42, #43** | Invalid `roomId` → error not silent `openRoom()`; reject non-`guest:`/`0x` hello wallets; standalone BJ sends `hello`. | `blackjack-server.js`, `blackjack-net.js` |

**Verify:** `node server/blackjack-server.js` + new interleave test (play during live hand must reject).

---

## Wave 4 — Client token mode UX (one `app.js` pass)

**Goal:** Token players can actually bet everywhere; balances stay honest.

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **4A** | **#9, #206** | Port live fix: `syncTokenGameBalances()` → `setMode("token")` on plane/pressure; reverse on cash-out. (Repo still missing this.) | `app.js`, `plane-ui.js`, `pressure-ui.js` |
| **4B** | **#17, #18, #209** | `spendableUsd()` + all `*Readouts()` → use `TokenMode.tokens()` when active. Guard plane poll in `refreshBalances()`. | `app.js` |
| **4C** | **#20, #211** | Monotonic sequence on `token-client` play responses; debounce or cancel stale `refreshTokens()` during BJ. | `token-client.js`, `token-mode.js` |
| **4D** | **#19, #195** | Fish: in-flight cap + optimistic debit; Reef: pause ticker on `document.hidden` (match fishshooter). | `fishshooter.js`, `fishtable.js` |
| **4E** | **#24, #213** | Document or unify funding model (demo vs token per channel); align header balance with active channel. | `app.js` |

**Verify:** Token buy-in → Dice/Crash/Plane buttons enabled; plane HUD stable across 12s poll.

---

## Wave 5 — Canvas lifecycle & channel switching

**Goal:** One PR per game family; no stranded stakes.

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **5A** | **#48, #196–#197** | Plane/pressure: bump `_tokenEpoch` on `setActive(false)`; ignore off-channel `.then()`. | `plane-ui.js`, `pressure-ui.js` |
| **5B** | **#23, #194** | Swoop: refund or force-bust on `setActive(false)`; add `restartDemo()` to `demoReset()`. | `swoop3d.js`, `app.js` |
| **5C** | **#22** | Per-channel `CrashRounds` instance or explicit cancel on channel switch. | `crash-rounds-client.js`, `app.js` |
| **5D** | **#49–#51, #55–#56** | TV: null-guard layers; channel restore calls `TV.changeChannel()`. | `tv.js`, `app.js` |

---

## Wave 6 — On-chain contracts & deploy pipeline

**Goal:** Separate from token server; needs testnet deploy + registry flip.

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **6A** | **#8, #157** | `npm run compile && npm run artifact` in CI; regen `public/contract.js` with `paused` + `_betGuard`. | `contract.js`, `exportArtifact.js`, CI |
| **6B** | **#6, #29, #174–#176, #179** | Remove client `staticCall` previews; parse `FlipSettled` from receipts on house/join paths. | `app.js` |
| **6C** | **#7** | Deploy `CoinFlipBettingV2`; migrate token + BJ to per-session locks. | contracts, `token-http.js` |
| **6D** | **#147, #153, #145** | PvP room idle timeout + `closeOpenRoom`; extend `paused` to room creation. | `CoinFlipBetting.sol` |
| **6E** | **#148, #177, #150, #91** | Validate `?contract=` (code size + registry allowlist); rebind `contract`/`TokenMode` on registry change + reload. | `app.js` |

**Verify:** `npm test` + `pass4-exploits.test.js`; no `staticCall` before mutate on house/dice paths.

---

## Wave 7 — PvP, host, lobby, WS social

**Goal:** Mostly `app.js` + `server.js` + contract views — batchable.

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **7A** | **#149, #160, #176** | Parse flip receipts; pass `roomId` into reconcile; fix `activeRoomId` race. | `app.js` |
| **7B** | **#152, #154, #151, #60** | Verify `r.betAmount` on accept; rate-limit chat + bet-proposals; cap proposal state. | `app.js`, `server.js` |
| **7C** | **#200, #45, #155** | Signed `hello` or guest-only chat; bind display name to verified address. | `server.js`, `app.js` |
| **7D** | **#146–#149, #154–#168** | Host table auto-close for others; empty-bank close; earnings index crash/slots/host-flip. | `app.js`, contract |

---

## Wave 8 — Wallet, MetaMask, stranded locks

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **8A** | **#178, #6-F02** | Buy-in: if `/api/token/start` fails after chain tx, auto-surface Recover; idempotent start by txHash. | `token-client.js`, `token-mode.js` |
| **8B** | **#182, #31** | `checkStrandedLock` compares on-chain `bjLocked` even when `TokenMode.active()`. | `app.js` |
| **8C** | **#179–#181, #88** | Receipt fallbacks + `tx.wait` timeout; `bridgeJson` AbortSignal. | `app.js` |
| **8D** | **#212, #178** | Defer reload during pending tx; BJ heal waits for idle phase. | `app.js` |

---

## Wave 9 — Security, ops, experimental bridge

| Batch | Findings | Work (together) | Files |
|-------|----------|-----------------|-------|
| **9A** | **#201, #203, #64, #202** | Security headers middleware; remove `X-Powered-By`; auth-gate `house-state`. | `server.js`, Render/CF |
| **9B** | **#58–#59, #79, #102** | Rate limits on buy-in; cap `clientSeed`; WS crash rate limit. | `token-http.js`, `crash-rounds-ws.js` |
| **9C** | **#216–#217, #221–#225, #229** | `liveExternal` on admin-release; chain-check RPC readers; contract allowlist on start. | `token-http.js` |
| **9D** | **#207, #47** | If experimental bridge ever enabled: parity with token path (confirmations, ethUsd, persist, `pendingBuyIns`). | `bridge-server.js` |
| **9E** | **#82–#84, #125–#126, #146** | Prune crash `rounds` map; `wsByRound` delete; `playBuckets` GC; render.yaml env docs. | `crash-rounds.js`, `render.yaml` |

---

## Wave 10 — Polish, demo, docs (when everything above is green)

| Batch | Findings | Work |
|-------|----------|------|
| **10A** | #98–#99, #54, #110–#119, #132–#133 | Bet limits, BETBAR sliders, toasts, host history |
| **10B** | #38–#41, #94–#96, #219 | Demo PF labels ("demo RNG ≠ token"); disable pressure valves in token mode |
| **10C** | #44, #65, #101, #137 | Poker server wire-up or remove; orphan CH12 |
| **10D** | #230, HANDOFF | Update `cursor/HANDOFF.md`, `AUDIT-NOTES.md`, trim "well-hardened" until probes pass |

---

## Suggested PR / deploy sequence

```
Wave 0  → hotfix deploy (pressure + slots)
Wave 1  → server: crash-rounds (BLOCK production exploits)
Wave 2  → server: persist + recover (BLOCK money escape)
Wave 3  → server: blackjack guards
Wave 4  → client: token UX (sync live v12.44 good bits)
Wave 5  → client: canvas lifecycle
Wave 6  → contracts (separate testnet cycle)
Wave 7  → PvP / lobby / WS
Wave 8  → wallet flows
Wave 9  → ops / security
Wave 10 → polish
```

**Do not skip Wave 1–2** before marketing token mode or adding players. Waves 4–5 can overlap Wave 3 after 1–2 land.

---

## After each wave — run this

```bash
npm test
node server/token-bridge.js && node server/token-http.js && node server/blackjack-server.js
node server/crash-rounds.js && node server/crash-rounds-ws.js
node CursorBugHunt/adversarial-suite.js
node CursorBugHunt/concurrency-fuzzer.js
node CursorBugHunt/repro-crash-nonce-desync.js
node CursorBugHunt/settlement-math-probe.js
```

Update this report: strike closed findings, note wave completed in HANDOFF.

---

## Audit agents (all passes)

**Pass 1–2:** Money paths, all games, server security, tests  
**Pass 3:** Contracts, blackjack, session restore, math parity, WS/API, adversarial suite  
**Pass 4:** Chaos/persistence, concurrency fuzzer, fork PoCs, host/PvP/lobby, wallet/MetaMask, canvas/WebGL lifecycle, live production probes  
**Pass 5:** Meta-review, live v12.44 diff, settlement math, slots3d parity, crash RTP verify, HANDOFF/AUDIT-NOTES cross-ref, admin/RPC

*~230 findings in this file. Primary report: `CursorBugHunt/REPORT.md`.*

---

# Pass 6 — Re-verification against LIVE v12.46 (Claude takeover, 2026-06-30)

**Method:** Claude (deploy-branch owner) re-ran every probe against the CURRENT repo (v12.46, == live), then ran multi-agent design fleets (Wave 1 crash money-path, Wave 2 persist/recover) that VERIFIED each finding against current code before proposing patches. **Key result: the report was written at v12.39; the deploy branch is 7 versions ahead, and most "Critical/High" money-path findings are ALREADY FIXED.** The legacy repro probes still "reproduce" because they call the obsolete `pointPeek`+`play` API, not because the bug is open.

## Already FIXED in v12.46 (verified by reading current code + new probes — do NOT re-fix)
| Finding | Fixed by (current code) |
|---|---|
| **#1, #2, #13, #14, #82, #126** crash nonce-desync / unreserved stake / resolve order / over-balance / map prune / autoTarget | `token-bridge.reserve()`/`resolveReserved()` (pins+BURNS the nonce, debits stake up front, integer-cent balance check); `crash-rounds._resolve` is ledger-first with rollback + prune. **New regression gate: `CursorBugHunt/crash-reserve-probe.js` → PROBE OK.** |
| **#4, #5, #16(same-tx), #139** buy-in/top-up txHash replay | `doStart`/`doTopUp` reserve `pendingBuyIns` before the await + `withPlayerLock` (per-player serialize) |
| **#209/#215, #140/#145** recover loss-escape orphan | `doRelease` re-issues the recorded settlement for `s.closed && s.settlement` (branch 1) + defense-in-depth `findSettledSessionForPlayer` (branch 2b) — never a net=0 orphan when a settlement exists. settlement-math-probe shows NO critical loss-escape. |
| **#210/#216, #217** admin-release | `doAdminRelease` has the `liveExternal` guard + closed-session re-issue + clears a stale `openByPlayer` slot |
| **#143, #144** shutdown flush | `gracefulShutdown()` (flush → server.close drain → 4s cap); `unhandledRejection` now flushes |
| **#9, #206** plane token mode | `syncTokenGameBalances` forces `setMode("token")` when connected (v12.44) |

## Wave 0 (shipped live this session)
- **#204** `_idlePrompt()` infinite recursion broke demo Balloon Pop — a regression I introduced in v12.44 (a too-greedy string replace). Fixed v12.46.
- **#193** Gem Vault stuck-on-"Spinning…": token spin settled prematurely (undefined `_result` → throw). Fixed v12.45 (`_awaitingServer` guard + null-result guard + off-channel recovery + token-bar resync).

## Wave 1 ADDED (shipped this session — genuinely-open defense-in-depth)
- **#3, #15, #141** crash-round liveness guards: `setActiveCrashCheck` → `liveCrashSession`/`liveCrashPlayer`; `doSettle/doRelease/doAdminRelease/doPlay` refuse while a server-paced round is live; `crash-rounds.drain()` on `gracefulShutdown` settles in-flight rounds into the ledger before a redeploy.

## Genuinely-open remaining (re-verified against v12.46)
- **Client robustness (Wave 1C):** #85 main-hub WS heartbeat, #86 silent `wsSend` drop, #108 timeout copy, #22 CrashRounds cancel on channel-leave, #48 plane/pressure `_tokenEpoch` bump. (Designed; not yet applied. NB: the agent's plane reconcile used a nonexistent `TokenMode.refresh` — use `TokenMode.active()?TokenMode.tokens():this.balance`.)
- **Settlement rounding (Wave 2C):** #204/#205/#220 sub-cent loss → `netWei=0` → full lock returned (≤1¢/session house leak); #206 small buy-in rounds to 0 tokens; #207 weiToUsd precision; #208 gcClosed `createdAt=0`; #227 play() 1e-9 overbet tolerance. All Medium/Low.
- **#16 dual-session** (different txHashes, one wallet): `doStart` is now `withPlayerLock`'d in v12.46? — re-confirm; single-session invariant, not a money exploit (cross-session-drain guard holds).
- **Waves 3-10** (blackjack guards, contracts/staticCall, PvP, wallet, headers, polish): NOT yet re-verified against v12.46 — many likely already fixed; need the same current-code check.

## Stale probes (rewrite to the current API before trusting)
- `repro-crash-nonce-desync.js`, `concurrency-fuzzer.js` (CONC-CRASH-*), `adversarial-suite.js` (crash sections) — all test the obsolete `pointPeek`+`play` model. The authoritative crash gate is now `crash-reserve-probe.js`. The txHash-race sections of adversarial-suite also predate `pendingBuyIns`.

---

# Pass 6 — CORRECTION / RETRACTION (Claude, 2026-06-30)

**The "Already FIXED in v12.46" table in the Pass 6 section above is WRONG — retracted.** I was misled: while my design-agent workflows ran, an agent SILENTLY edited the working-tree `token-bridge.js` and `token-http.js` to add the reserve mechanism + `pendingBuyIns`, and I read that injected code believing it was the deployed state. It was not. Verified against `git show HEAD:` (the real committed/deployed v12.46):

| Finding | TRUE status in deployed v12.46 (verified) |
|---|---|
| **#1/#2/#13** crash nonce-desync / unreserved stake | **OPEN** — `crash-rounds.js` uses `bridge.pointPeek()` + `bridge.play()`; `token-bridge.js` has **no `reserve()`**. `repro-crash-nonce-desync.js` REPRODUCES (pacing nonce 0, settle nonce 1). |
| **#4/#5/#16/#139** buy-in/top-up txHash replay | **OPEN** — `token-http.js` has **no `pendingBuyIns`**. |
| **#209/#215** recover loss-escape orphan | **OPEN** — `doRelease` has **no `s.closed && s.settlement` re-issue** and no `findSettledSessionForPlayer`. settlement-math-probe fires **#209 [Critical]**. |
| **#210** admin-release ignores liveExternal (sessionless target) | **OPEN** — fires in settlement-math-probe. |
| **#204/#205/#220** sub-cent settle rounding | **OPEN** (Medium). |

**Genuinely PRESENT (real, committed v12.34) and NOT to be weakened:** the loss-escape CORE — `withPlayerLock` (per-player mutex), `pendingSettle` (obligation), `obligationConsumed`/`recordObligation` (re-issue). #209/#215 is a *refinement gap* in that machinery (the closed-session branch), not a total absence.

**What actually happened to live this session:** v12.45 (slots-stuck fix) + v12.46 (Balloon Pop `_idlePrompt` recursion fix — a regression I'd introduced in v12.44) are good and live. Commit **04cfa7f** ("Wave 1 server guards") was BROKEN — it committed `crash-rounds.js` calling `bridge.reserve()` that doesn't exist in committed `token-bridge.js` → crash/plane/pressure/swoop token rounds threw. Reverted by **61af21a**, restoring the working v12.46 server. No reserve/guard fixes are in the deployed code; the money-path criticals above are OPEN and must be implemented properly (reserve added to BOTH `token-bridge.js` AND `crash-rounds.js` together, probe-gated by `crash-reserve-probe.js`; `pendingBuyIns`+lock to `doStart`/`doTopUp`; the `s.closed && s.settlement` branch to `doRelease`).

**Process lesson:** design agents have Edit access and CAN mutate the working tree. Verify "is it fixed?" against `git show HEAD:<file>` (committed), never the working tree, while agents are running — or run them worktree-isolated.

---

# Pass 6 — FIXES LANDED (Claude, 2026-06-30, probe-verified)

Re-done PROPERLY (verified against committed code, applied consistently across files, gated on the probes). Commits on `claude/ethereum-betting-game-vrf-2dq50k`:

**`ed9831b` — server money path (deployed):**
| Findings | Fix | Probe gate |
|---|---|---|
| #1 #2 #13 #14 #82 #126 | `token-bridge.reserve()`/`resolveReserved()` (pin+BURN nonce, debit up front) + `crash-rounds` startRound/_resolve use them; prune | `crash-reserve-probe.js` OK; adversarial-suite 7→1 |
| #4 #5 #16 #139 | `pendingBuyIns` + `withPlayerLock` on doStart/doTopUp | adversarial-suite TXHASH-*/DUAL gone; fuzzer TOPUP-REPLAY gone |
| #209 #215 #210 | `doRelease` re-issues closed-session settlement + `findSettledSessionForPlayer`; `doAdminRelease` guarded | settlement-math-probe **0 criticals** |
| #3 #15 #10 | live-round/live-hand guards on settle/play/release/doPlay (`setActiveCrashCheck`→`liveCrashSession`; `liveExternal`) | fuzzer CONC-BJ-PLAY gone; #15 verified blocked w/ real wiring |
| #141 | `crash-rounds.drain()` in `gracefulShutdown` | self-test |

**`f240e10` (v12.47) — client crash robustness (deployed):** #85 WS heartbeat, #86 fail-fast on dropped send, #22 `CrashRounds.cancel()` on channel leave, #108/#21 round-timeout reconcile-not-refund, #48 plane/pressure epoch bump. (No signed-money impact.)

**Loss-escape CORE preserved** (`withPlayerLock` + `pendingSettle` + obligation re-issue, v12.34) — strengthened, never weakened.

## Still OPEN after Pass 6 (deliberately not yet done)
- **#220/#205/#204 sub-cent settle rounding** (Medium, ≤½¢/session house leak): a <1¢ loss → `netWei=0` → full lock returned. Fix changes the SIGNED on-chain amount (compute netWei from un-rounded net) → **deferred for explicit owner review** (not applying unreviewed signed-money math after the agent-injection incident).
- **#206 #207 #208 #211/#227** settlement precision / micro-overbet (Low).
- **Wave 3 rest:** #11 (applyNet failure swallowed), #12 (leave during dealing), #30/#31 (BJ connect order), #37 (invalid roomId), #42/#43 (anon hello). Re-verify vs committed code first.
- **Waves 4-10:** client token UX (#17-25), canvas lifecycle (#23/#48/#194-197 — #48 done), contracts/staticCall (#6/#147/#148/#174-176), PvP/WS (#45/#200), wallet (#178-183), headers/rate-limits (#201-203/#58-60), polish.
- **DEMO-WALLET-DESYNC** (adversarial-suite, Low): client display only.

## Stale probes to rewrite (give false positives against current code)
- `repro-crash-nonce-desync.js`, `concurrency-fuzzer.js` CONC-CRASH-INTERLEAVE — don't wire `setActiveCrashCheck`; the real `server.js` does (proven). The authoritative crash gate is `crash-reserve-probe.js`.
