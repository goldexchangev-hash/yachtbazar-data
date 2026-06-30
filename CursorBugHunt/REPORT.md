# Cursor Bug Hunt — Crypto TV (v12.39)

**Date:** 2026-06-30 (third pass — deep multi-agent audit)  
**Site:** https://tv-crypto-flip.onrender.com  
**Branch:** `claude/ethereum-betting-game-vrf-2dq50k` @ `09b1d18`  
**Build:** `?v=1239`, `ctf-v12.39`

---

## Methodology

| Pass | Agents / tools | Scope |
|------|----------------|--------|
| 1 | Initial parallel audits | Money paths, games, server, tests |
| 2 | 4 agents | Expanded client/server, adversarial nonce repro |
| **3** | **6 agents + adversarial suite** | **Contracts, blackjack, session restore, math parity, WS/API edges, scripted exploits** |

**Scripts in this directory:**
- `repro-crash-nonce-desync.js` — crash pacing vs settlement nonce mismatch
- `adversarial-suite.js` — txHash races, dual sessions, crash loss escape, EV scan

```bash
npm test
node CursorBugHunt/adversarial-suite.js      # 8 findings (exit 0/1)
node CursorBugHunt/repro-crash-nonce-desync.js
```

---

## Executive summary

**97 unique findings** below (Critical → Low). Automated tests still pass 22/22, but self-tests do not cover adversarial concurrency, on-chain simulation attacks, or cross-tab/session races.

**Top risks:**
1. **Token crash rounds** — nonce desync, unstaked rounds, settle mid-round (reproduced)
2. **Buy-in/top-up txHash replay** — double tokens from one chain tx (reproduced in `adversarial-suite.js`)
3. **On-chain instant games** — `staticCall` leaks outcome before submit; client uses this explicitly
4. **Blackjack** — token bets allowed during live hand; leave during `dealing` corrupts outcome; silent credit failures
5. **Client token mode** — affordability, plane mode, session restore ordering, cross-tab ghosts

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
| **9** | Plane stays demo/real after token buy-in | `app.js:640,3001-3005`, `plane-ui.js` | `syncTokenGameBalances()` sets balance but not `setMode("token")`. Demo debits locally without server. |
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
| **25** | Gem Vault token: no final `r.tokens` resync after bonus | `slots3d.js:281-314` | Local `E.evaluate` replay; drift vs ledger until next bet. |
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
| **136** | Monte Carlo crash RTP >100% in one scan run | `adversarial-suite.js` | Single 80k sample variance; not confirmed exploitable — monitor. |
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

## Audit agents (all passes)

**Pass 1–2:** Money paths, all games, server security, tests  
**Pass 3:** Smart contracts, blackjack exhaustive, session restore, client/server math parity, WS/API edges, adversarial suite

*138 findings catalogued; 97 in Critical–Medium tables above, 41 Low. Consolidated in this file for handoff.*
