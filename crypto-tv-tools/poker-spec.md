# POKER — Build-Ready Spec (LIVE PvP No-Limit Texas Hold'em, host rake-share)

**Repo:** `C:/Users/golde/crypto-tv-live` · branch `claude/ethereum-betting-game-vrf-2dq50k`
**Status target:** ship OFF (`POKER_ENABLED=false`), self-tests green, then flip ON.
**Template studied:** Baccarat (`server/baccarat-server.js`, `public/baccarat-ui.js`, `public/baccarat-net.js`).
**All 6 research lenses verified against committed code before writing (file:line cited inline). Lens F ("baccarat-principles") returned a stub; its intent is folded into §4/§9.**

---

## 1. SCOPE + THE BINDING MONEY-MODEL DECISION

**Product:** Real-money, player-vs-player No-Limit Texas Hold'em. **User-created tables.** Up to 9 seats. Rake skimmed per raked pot. **The platform takes 50% of every table's rake; the table CREATOR (host) earns the other 50% as a claimable wallet obligation.** Name: **"Poker"**. Runs on the existing Sepolia server commit-reveal token bridge (NO VRF). Demo mode + token mode both supported. Full-width `#poker-view` (no TV iframe). Kill-switch `POKER_ENABLED`.

**BINDING MONEY MODEL — "table-stack, per-seat net-vs-house, rake as the only chip-sink":**

1. **One token session per player** (their existing bridge session / `bjLocked` lock), bound to at most one poker seat via `bindToken` (mirror `baccarat-server.js:141`). No per-table on-chain lock.
2. **Buy-in = an `applyExternal` DEBIT** against that session (`applyPokerNet(player, sid, buyInUnits, 0, "buyin:tableId")`). Chips become **table-local integers** owned by the RoomManager. **1 chip = 1 USD cent** (exact 100× with session USD units; all chip math integer).
3. **During a hand, NOTHING touches the bridge.** The engine redistributes integer chips between seat stacks. Already chip-conserving (test-proven, `poker-server.js` self-test + `test/poker-engine.test.js`).
4. **Rake** is skimmed from each raked pot **before payout**, inside `_finish`. It is the **only** chip-sink. Therefore `sum(all seat chip losses) === totalRake` **by construction**.
5. **Cash-out / leave = an `applyExternal` CREDIT** of the seat's *current* stack back to the session (`applyPokerNet(player, sid, 0, stackUnits, "leave:tableId")`). The net vs the earlier buy-in debit is automatically `(returned − boughtIn)`.
6. **Zero-sum invariant (machine-checked):** `Σ over all-ever-seated (cumulativeBuyIn − returned) === totalRakeChips === houseRakeChips + creatorRakeChips`, exact to the cent. Asserted at teardown; **fail-closed** (refuse to settle if it does not hold).
7. **Rake split:** `houseHalf = floor(rake/2)`, `creatorHalf = rake − houseHalf` (creator gets the odd cent so the split is exact-to-the-chip — never mint/burn).
8. **House 50%** is simply the chips that left the pots and were never credited to any seat — house profit, no explicit payout.
9. **Creator 50%** accrues as `table.creatorRakeChips` and at teardown converts to a **durable signed wallet obligation** via the existing `recordObligation` / `pendingSettle` machinery (`token-http.js:273`), claimed via the normal settle/recover flow (signed net>0, fresh nonce, replay-guarded). NOT credited into the creator's live session (may be closed/absent).

**Why this is house-safe AND player-fair (the crux resolution):** `applyExternal` nets each session vs house, so naïvely each poker win *looks like* the house paying. Safety comes from the invariant: total winning credits `== total buy-in debits − totalRake`, enforced by engine chip-conservation PLUS rake being the only sink. A winner is funded strictly by losers' buy-in debits on the SAME table. The house can never be drained past the rake it collected and can never mint. This keeps the **audited `applyExternal` path byte-identical** (owner rule) and needs **no contract redeploy** (no on-chain P2P).

---

## 2. NLHE RULES GROUND TRUTH (what the engine must enforce)

- **Blinds/button:** SB + BB forced (not voluntary acts). Button rotates one live seat clockwise each hand. 3+-handed: SB=left of button, BB=left of SB, first-to-act preflop=UTG (left of BB). **Heads-up (n=2): button IS the SB, acts first preflop; BB acts first postflop.** Short blind (stack<blind) posts what they have and is all-in.
- **Dealing:** one card at a time clockwise from SB, two rounds. Burn before flop(3)/turn(1)/river(1).
- **Four betting rounds:** preflop / flop / turn / river. Postflop `currentBet` resets to 0, `minRaise` resets to BB, first-to-act = first live seat left of button.
- **Action legality:** check only when `toCall===0`; call = `min(toCall,stack)` (short call → all-in); bet only when `currentBet===0`, min = BB; raise-TO min = `currentBet + minRaise`; all-in always legal; **no-limit** max = whole stack.
- **Incomplete-raise-does-not-reopen:** a full raise (increment ≥ minRaise) reopens action (others' `acted=false`, `mayRaise=true`, minRaise updates). A **short all-in** (increment < minRaise) does NOT reopen for already-acted players (`mayRaise=false`) — they may only call/fold; minRaise unchanged.
- **Side pots:** built once from each player's `committedTotal` by peeling the min positive contribution; folded players' chips are dead money (counted in pot amount, excluded from eligible sets). N-way all-ins at distinct amounts handled.
- **Showdown/odd chips:** uncontested (1 live) → winner takes all, no cards shown. Contested → best-5-of-7 per pot's eligible set; ties split; **odd chip(s) awarded clockwise from the button** (Robert's Rules). Wheel A-2-3-4-5 = 5-high straight; steel wheel ranks below 6-high SF. Muck = losers not credited; UI honors muck etiquette cosmetically.
- **Rake (poker-specific, NEW):** `rake = min(round(RAKE_PCT·pot), RAKE_CAP_BB·bigBlindChips)`, **no-flop-no-drop** (rake=0 if the hand ends preflop with no flop dealt). Deducted from each pot before payout.

---

## 3. ENGINE REUSE/REWRITE VERDICT + SELF-TEST VECTORS

**VERDICT: REUSE the engine core essentially unchanged. REWRITE the table lifecycle, money, UI.** Both suites pass (incl. 3000-hand chip-conservation fuzz, 4-way all-in side pots, short-all-in-no-reopen, odd-chip-clockwise, heads-up ordering, wheel/steel-wheel ranking). The vs-house framing lives ONLY in `app.js` (`pokerPoolUsd` seeded from balance, `app.js:4795-4803`) and `poker-bots.js` — NOT in the pot/hand math.

**KEEP AS-IS (verified):**
- `server/poker-server.js`: `ServerHand` betting state machine (`act`, `legalActions`, `_advance`, `_closeStreet`, `_runOut`), `buildPots` side pots (`:170`), `evaluate`/`score5` hand eval, `_finish` (`:521`), and **`snapshotFor(viewerId)` (`:583`) — the leak-free security boundary** (`serverSeed: this.done ? … : null` at `:602`; per-viewer hole masking; never serializes the deck stub). `provablyFairDeck` (`:71`) sharing `blackjack-shuffle.js`.
- `public/poker-engine.js`: same math as client renderer/verifier for optimistic render + PF re-derive.
- `botDecide`/`advance` (`:245`,`:689`): demo/table-filler bots ONLY (not the money model).

**EDIT (small):** `ServerHand` `opts.clientSeed` (single string, `:311`) → accept combined `joinClientSeeds(seatedSeeds)`, locked at commit (see §7).

**ADD (in `_finish`):** rake extraction (deduct pre-payout; split 50/50 into `table.houseRakeChips` / `table.creatorRakeChips`).

**REWRITE / BUILD NEW:** table lifecycle → `PokerRoom`/`RoomManager` (§4); `applyPokerNet` sibling (§5); rake + creator-obligation ledger (§5); `poker-ui.js` felt as a thin server-snapshot renderer (§8); `poker-net.js` (clone `baccarat-net.js`); `POKER_ENABLED` flag; co-located CLI self-test.

**DISCARD:** `app.js:4795-4803` vs-house `pokerPoolUsd` seeding; the `app.js:3885` "temporarily disabled" gate; `poker-bots.js` as the primary opponent model.

### Self-test vector list (gates the build)
1. Wheel vs 6-high straight (wheel loses); steel wheel vs 9-high SF (steel wheel loses). *[exists]*
2. Quads-over-quads kicker: KKKK-A vs KKKK-Q on paired board (A-kicker wins); board-quads same kicker → split.
3. Three-way all-in 100/300/600 where the SHORT stack wins main but a bigger stack wins a side pot — assert each pot → correct eligible winner.
4. Wheel vs wheel split (both play A2345 off board) — even split, odd chip clockwise from button.
5. Odd-chip: 3-way split not divisible by 3 → extra chip(s) clockwise from button in order.
6. Short all-in does NOT reopen: BB raises, SB shoves for less-than-a-full-raise → BB may only call/fold (`mayRaise=false`).
7. Full all-in DOES reopen (shove ≥ min-raise increment).
8. Heads-up: button=SB acts first preflop; BB acts first postflop. *[exists]*
9. Fold-to-BB preflop → BB wins blinds, deltas exact. *[exists]*
10. All-in run-out: 2 all-in preflop → board runs to river, showdown pays. *[partial]*
11. Dead-money fold: folder's chips in pot amount, folder excluded from every eligible set. *[exists]*
12. **CHIP CONSERVATION WITH RAKE (money invariant):** `Σ seat deltas === −rake`, `rake === min(floor(RAKE_PCT·pot), RAKE_CAP_BB·bb)`.
13. Split-pot rake: rake taken BEFORE the split; odd chip after.
14. 3000-hand fuzz chip-conservation + termination. *[exists]*
15. No-flop-no-drop: uncontested-preflop win pays 0 rake.
16. **snapshotFor security:** `snapshotFor(A)` never contains B's live hole cards, never the deck/stub, `serverSeed===null` until `done`.
17. **END-TO-END MONEY (the binding house-safety proof):** seat N players from stub token sessions + controllable clock, play scripted raked hands, cash everyone out → assert `Σ(seat session nets) === −(houseRake + creatorRake)` to the cent; assert no `applyPokerNet` credit exceeds `PAYOUT_CAP.poker`; assert `creatorHalf + houseHalf === rake` per hand.
18. **Creator-share funding:** total creator payouts + house-retained rake === total rake skimmed (no mint).

---

## 4. SERVER ROOM STATE-MACHINE + `pk:` PROTOCOL + TIMER/DISCONNECT

### Room FSM (per table)
`WAITING → HAND → SHOWDOWN → BETWEEN → (HAND | WAITING)`; implicit `CLOSED`.
- **WAITING→HAND:** fires when ≥2 seats are IN with `stack ≥ BB`. Post blinds + deal (engine `start`). Broadcast commit BEFORE any card leaves the server.
- **HAND:** the engine's OWN street machine sequences turns. After each `pk:act` and after handStart, `room.advance()` runs: while `toAct` is a bot → delay-decide-apply; when `toAct` is human → arm `actTimer` keyed by `actEpoch++` and STOP. `engine.done` → SHOWDOWN.
- **SHOWDOWN:** engine already ran `_finish` (rake skimmed, payouts to seat.stack). Broadcast per-viewer `pk:state` (reveal `shown` holes) + `pk:reveal {serverSeed, commit}`. Hold ~4s.
- **BETWEEN (~3s):** reconcile deferred changes — remove LEFT seats (credit remaining stack to bank), seat pending JOINs, rotate button one live seat clockwise, auto-sit-out seats with `stack < BB`. Then ≥2 funded → HAND else WAITING.
- **Idle:** empty (0 seats) → fast reap 60s; ≥1 seated-idle → 5min (mirror `T.idle=300000`, `baccarat-server.js:67`, `scheduleIdle:223`); a table WAITING with 1 seated creator is NOT idle-closed for the full 5min (host may sit and wait). NEVER close mid-hand (`inHand` guard). Close = refund-first-abort-on-fail (`closeRoom` pattern).

### Per-seat state (room layer, distinct from engine's per-hand player)
`{wallet, sock, name, stack (persists across hands), cumulativeBuyInChips, sittingOut, disconnected(ts), _dcTimer, left, seatIndex, isBot, isHost}`. Engine builds per-hand `players[]` from seats IN + `stack≥BB` at startHand.

### Timer + timeout action
`actTimer = 20s` per turn (config `POKER_ACT_MS`), re-armed on every `toAct` change with `actEpoch++` (baccarat `bettingEpoch:273` pattern). On expiry: if `toCall===0` → auto-**CHECK**, else auto-**FOLD**. Guard: callback checks its epoch is still current before acting. Bots act via 800–1500ms delay (NOT the human timer). A disconnected to-act seat auto-checks-or-folds on timeout exactly like a present one (standard cash-game rule; no all-in protection for non-all-in seats).

### Disconnect / leave (two-tier, mirror `markDisconnected:484` + `RECONNECT_GRACE=90000`)
1. **Socket drop mid-hand:** mark `disconnected`, KEEP seat + committed chips, keep the act-timer running. Reconnect within grace re-binds the SAME socket→seat and resyncs; **do NOT reset the act clock** (anti time-buy).
2. **Explicit leave / grace expiry:** if a hand is live and chips are in the pot, FOLD (forfeit — chips already in pot, `buildPots` redistributes), remove seat, credit remaining stack back **only at the next BETWEEN** (never mid-hand). Cannot un-seat mid-hand while chips are live (freeze). **All-in protection is automatic** — an all-in seat runs out regardless of connection (`_runOut`).

### `pk:` protocol (namespaced, mirrors `bac:`)
**Inbound:** `pk:lobby:subscribe|unsubscribe`, `pk:table:create {sb,bb,maxSeats,minBuyIn,maxBuyIn,name,private,pw,kind}` (records `hostWallet`), `pk:table:join {tableId,buyInUnits,seatPref,pw}`, `pk:table:watch`, `pk:table:leave`, `pk:sit {in|out}`, `pk:act {type,amount}`, `pk:rebuy {amount}`, `pk:seed` (guest demo), `pk:ping`.
**Outbound:** `pk:lobby:list`, `pk:state` (**per-viewer masked snapshot**), `pk:event {kind}`, `pk:wallet {balance}`, `pk:reveal {serverSeed,commit}`, `pk:error {code,msg,intent}`, `pk:pong`.

**THE ONE PLACE THE BACCARAT TEMPLATE MUST BE BROKEN — per-socket broadcast.** Baccarat's `broadcast` sends ONE shared object to all seats (`baccarat-server.js:237`). Poker **MUST loop** seats + spectators and send `snapshotFor(recipient.wallet)` **separately** to each, so hole cards never cross to another socket. Spectators get `snapshotFor(null)`. **Self-test 16 asserts** recipient A's payload contains no live hole of recipient B.

### Wiring
`attachPoker()` export + `server.js`: `attachPoker + setTokenLedger({ tokensOf, applyNet: tokenSvc.applyPokerNet })` — a NEW sibling, NOT `applyBaccaratNet`. Kill-switch: `window.POKER_ENABLED` (`config.js`) + `POKER_ENABLED` env gate (`server.js`, mirror BACCARAT_ENABLED at `:215`/`:604`).

---

## 5. THE MONEY PATH (end-to-end)

**Unit:** 1 chip = 1 USD cent. Session units = USD (round2). `chips = round(units·100)`, exact.

**(1) BUY-IN.** Player has one bridge session (`bjLocked`, opened via `doStart`). Picks table + `buyInUnits` (≥ table min, ≤ session tokens). RoomManager.sit: (a) `bindToken(player, sid)` — FREEZE, refuse if already bound to another live game; (b) `applyPokerNet(player, sid, buyInUnits, 0, "buyin:tableId")` (debits via `applyExternal game:"poker"`, bounded/ledgered/nonced); (c) `seat.stack = round(buyInUnits·100)`; `seat.cumulativeBuyInChips = seat.stack`. Rebuy = another debit + increment `cumulativeBuyInChips`.

**(2) DURING A HAND.** Pure engine, table-local integers. NO bridge calls. Session stays FROZEN (`hasLiveHand` true whenever the wallet has chips in a live pot) → cash-out/recover/settle REFUSED mid-hand (mirror `baccarat-server.js:151` + `token-http` `liveExternal` gate).

**(3) RAKE (in `_finish`).** Per pot: no flop → rake=0. Else `rake = min(round(RAKE_PCT·pot), RAKE_CAP_BB·bigBlindChips)`. Deduct from pot BEFORE awarding; winners split `(pot − rake)` with existing odd-chip-clockwise logic. Then `houseHalf = floor(rake/2)`; `creatorHalf = rake − houseHalf`; `table.houseRakeChips += houseHalf`; `table.creatorRakeChips += creatorHalf`. Rake is now a pure sink: `Σstacks` after == before − rake.

**(4) CASH-OUT / LEAVE (uniform, exact form for winners AND losers).** Credit the RETURNED stack back and let the buy-in debit stand: `applyPokerNet(player, sid, 0, round2(seat.stack/100), "leave:tableId")`. Net vs the buy-in debit is automatically `(returned − boughtIn)`. Then `unbindToken(player)`.

> **capUp CEILING (verified real, `token-bridge.js:104`).** `applyExternal` clamps `s.tokens` to `buyInUnits + maxWinUnits` (`TOKEN_MAX_WIN_USD`). A poker winner's returned stack can exceed their own buy-in (they hold other seats' chips), so a naive session credit would **silently truncate a legit P2P win → breaks zero-sum (chips vanish that losers really lost)**. **BINDING FIX:** a **winning leave** (returned stack > cumulative buy-in) books the **net win** as a wallet **obligation** via `recordObligation` (same mechanism as creator rake), NOT a session credit — sidestepping `capUp` entirely. A losing/breakeven leave credits the remaining stack to the session normally (never exceeds the cap). The session ledger thus only ever sees buy-in debits + loser/breakeven returns.

**(5) ZERO-SUM INVARIANT (the proof, self-test 17).** Over the table's life, for every seat ever seated: `cumulativeBuyIn − totalReturned == that seat's chip loss`. Summed: `Σ(buyIn − returned) == totalRake` (rake is the only chip that left pots un-returned). `totalRake == houseRake + creatorRake` exactly (integer split, exact remainder). Therefore `Σ(session net from poker) == −(houseRake + creatorRake)`. House holds houseRake as profit; forwards creatorRake to the obligation. **Never mints** (every win funded by matching buy-in debits) and **never drained past collected rake**. `PAYOUT_CAP.poker` is the bridge-level backstop.

**(6) CREATOR RAKE-SHARE PAYOUT.** `table.creatorRakeChips` accrues per hand. At teardown (or a periodic sweep), convert to a durable signed obligation to the creator's WALLET via `recordObligation(creatorWallet, contract, chainId, settlement)` (`token-http.js:273`) using the SAME `pendingSettle` store the loss-escape recover path uses. Claimed via normal settle/recover (signed net>0, replay-guarded by nonce). NOT credited into the creator's session (may be closed/absent). House-safe because `creatorRakeChips ≤ totalRake ≤ totalBuyIns`, fully funded by already-skimmed rake.

**(7) `applyPokerNet` SIBLING CONTRACT.** Byte-copy of `applyBaccaratNet` (`token-http.js:980-990`), changing only `game:"poker"` and the guard message. Signature `applyPokerNet(player, sessionId, betUnits, payoutUnits, ref) → newBalance`. Enforces: open session (not closed/settled), player owns session, `liveCrashSession` gate (v12.99 lesson — a genuinely-live crash round blocks the net-apply so `finalizeOrphanRounds` can't force-bust it), then `bridge.applyExternal({sessionId, game:"poker", betUnits, payoutUnits, ref})`. **Do NOT generalize `applyExternal`** — keeps the audited path byte-identical.

**(8) PAYOUT_CAP.** Add `poker` to `PAYOUT_CAP` (`token-bridge.js:72`, currently absent). A seat can at most win the sum of the other seats' stacks. Recommend **`poker: 200`** (200× buy-in headroom) — ample for `maxSeats·maxBuyIn` while clamping any engine-bug overpay. Verify against `maxSeats·(maxBuyIn/buyIn)` at the largest allowed table.

### Money edge cases
- **Seat busts to 0:** cash-out is a no-op credit; the buy-in debit stands as the loss. Rebuy = new debit + increment.
- **Disconnect mid-pot:** engine auto-folds/checks; committed chips resolve via `buildPots` as dead money. Session frozen (`hasLiveHand`) → no mid-hand settle. At hand end + ~5min idle, force-cash-out the remaining stack and `unbindToken` — prevents a stranded on-chain lock.
- **Creator seated at own table:** SEAT net settles via `applyPokerNet` (zero-sum with table); CREATOR rake settles via the separate obligation. **Two separate ledger paths — never netted** (netting corrupts table zero-sum).
- **Multi-seat atomicity:** all cash-outs run at BETWEEN sequentially; each seat's credit is independent (its own session). But **precheck all leaving sessions are open** before crediting any; if one throws, surface `credit_failed` (mirror `baccarat:364`) and retry — poker must never leave a winner uncredited. The zero-sum assert (fail-closed) gates the batch.

---

## 6. LOBBY + CREATE-TABLE UX + DATA MODEL + HOUSE BOUNDS

**Creation model (BINDING): EXPLICIT user-created tables ONLY, plus ONE house-owned "warm" table so the lobby is never empty.** Baccarat's auto-generate/city-name model (`baccarat-server.js:193`) is WRONG here — an auto-table has no human creator to receive the 50% host share. The warm house table has `creatorId=HOUSE` (host share → platform).

### Table data model (extends `poker-server.js:626 createTable`)
```
Table {
  id, name, kind:'real'|'demo',
  creatorId, creatorWallet,          // NEW — earns 50% host rake-share
  sb, bb,                            // exists
  buyInMin, buyInMax,                // NEW — in big-blinds, bounded
  maxSeats,                          // exists — clamp 2..9
  rakeBps, rakeCapBb,                // NEW — house-clamped
  private:bool, pwHash|null,         // NEW — never echoed
  seats:[...],                       // exists
  phase, handNo, button,             // exists
  hostRakeAccrued(chips),            // NEW — creator 50%, frozen on leave
  housePendingRake(chips),           // NEW — platform 50%
  avgPotRing, createdAt, lastActivity,
  timers:{ idleEmpty, idleSeated }   // NEW two-tier GC
}
```

### House-policy bounds (server RE-CLAMPS every field on receipt; client bounds cosmetic)
| Bound | Default | Range (house-enforced) |
|---|---|---|
| rakeBps | 500 (5%) | 100–500 (**5% hard ceiling — creator can never gouge**) |
| rakeCapBb | 3 | 1–5 |
| bb (stakes) | — | whitelist {2,5,10,25,50,100}; sb = bb/2 |
| buyInMin | 20bb | ≥ 20bb |
| buyInMax | 100bb | ≤ 250bb AND ≤ table token ceiling |
| maxSeats | 9 | 2–9 |
| name len | — | 3–24, sanitized (HTML/profanity stripped) |
| per-wallet concurrent open tables | — | cap (recommend 2) — anti-spam |

**Rake model:** pot-rake, %-with-cap, no-flop-no-drop (universal cardroom standard; trivially clamped server-side).

**Creator-leave policy:** table PERSISTS; `hostRakeAccrued` FROZEN and paid on the creator's next settle. New-pot host share routes to HOUSE (a ghost creator must not skim pots they're absent from — passive-income exploit). **No ownership transfer** (hijack/collusion vector). Creator may CLOSE only when empty or ≤1 other seat AND not mid-hand. **NO kick** of a seated funded player (collusion weapon). Private tables gate ENTRY by password only.

**Host panel (creator-only overlay):** live `hostRakeAccrued` (the headline number), seats/hands/avg pot, CLOSE button (guarded), password field for private tables. Read-mostly.

**Lobby card:** name, `$SB/$BB`, seats filled/max, avg pot (rolling last-10), rake label, REAL/DEMO badge (segregate like `roomPublic.kind`), private lock icon, phase. Buttons JOIN (disabled full/no-seat) / WATCH. Client-side filters: stakes tier, seats-open, hide-full, real/demo, hide-private. Default sort: most-filled then highest avg pot.

**Create form:** name; stakes dropdown (whitelist bb, sb auto); buy-in min/max (bb); max-seats slider; rake read-only default with advanced lower-only; private toggle + password; kind. On submit → server validates/clamps → `pk:table:created {tableId}` → creator auto-subscribed + seated (must sit; a 0-seat table reaps in 60s).

---

## 7. PF-DECK PROTOCOL (verifiable without leaking hole cards)

**Already solved correctly in `poker-server.js`; one edit for multi-seat entropy.**

Per hand:
1. **Hand start:** `serverSeed = randomSeed(32)`; `commit = SHA256(serverSeed)`. Collect one `clientSeed` per SEATED player (auto-gen if blank), **FREEZE them at the instant of commit** (before drawing card 0 — mirror `baccarat-server.js:293`). `combined = joinClientSeeds(seatedSeeds)` (`blackjack-shuffle.js:70`); `nonce = handNumber`. Broadcast start snapshot with `{commit, clientSeeds, nonce}` — NOT serverSeed, NOT any card.
2. **Deal:** `deck = provablyFairDeck(serverSeed, combined, nonce)` (`poker-server.js:71`). Every mid-hand `snapshotFor(viewer)` reveals ONLY the viewer's holes + public board; `serverSeed` stays `null` (`:602`).
3. **Hand end (`done`):** `_showdown` puts only active-at-showdown holes into `shown`; uncontested → no cards. Final snapshot includes `serverSeed`. Any client verifies `commit === SHA256(serverSeed)` and recomputes the deck to replay the deal.

**Edit needed:** `ServerHand` `opts.clientSeed` (single string, `:311`) → the Table joins all seated seeds via `joinClientSeeds` and passes the combined string; hard lock-at-commit ordering.

**Muck property (state plainly in the PF panel):** revealing serverSeed makes the WHOLE deal verifiable — a verifier can reconstruct even mucked losers' hands. This is the standard, honest provably-fair guarantee; the felt honors muck etiquette **cosmetically** (folded cards never rendered face-up) but this is NOT a cryptographic hide. **No mid-hand leakage** (seed withheld until done). **Do NOT build per-card ZK commitments** — enormous surface for a property no online room offers verifiably.

**Mid-hand seat changes:** `seatedSeeds` is snapshotted at hand start and never re-read; joiners/leavers do not alter the live hand's committed deck.

---

## 8. FELT UX + CONTROLS + FULLSCREEN

**Full-width `#poker-view` (no TV iframe).** Simpler than baccarat — no `?tv=1` embed, no parent postMessage bridge, no portrait-hint plumbing.

**Salvage geometry + controls; swap the drive loop.** Keep: ellipse `seatPos` (`poker-ui.js:24-28`, a=44 b=39, hero bottom-center), 9-seat ring `build` (`:30-51`), `cardEl` (`:261-268`), the **raise SLIDER + ½/¾/POT/MAX presets (`:214-234`) — this IS the requested bet-control spec**, buy-in modal (`index.html:1472-1483`), turn-timer conic ring (`:245-258`, make it render server `timeLeft`, cosmetic). **DELETE** the local-hand-loop / botBank / in-browser `act` (`:74-199`) — the client becomes a THIN renderer of server `snapshotFor()` state over WebSocket.

**Clone `baccarat-net.js` → `poker-net.js`** (swap 3 literals `bac:ping/pong/net` → `pk:ping/pong/net`; keep hello frame + heartbeat + resume verbatim). Receives `pk:state` snapshots, sends `pk:act {type,amount}`. Heartbeat/resume re-pulls the snapshot after a backgrounded-mobile socket so a frozen felt can't miss its turn.

**Felt visual spec:** oval table; up to 9 seats; community cards center-top with POT + side-pot pills below; each seat shows name/stack/current-street-bet/dealer-button/fold-dim/all-in badge/turn-ring; YOUR hole cards BIG in a fixed bottom dock (`poker-hole`) separate from your seat; controls (FOLD fixed-left / CHECK-or-CALL / RAISE-slider+presets) below the holes. **Quiet losses** (no flashy fold FX); satisfying win — animate pot chips sliding to winner seat(s) on `winners`, split-aware.

**Fullscreen:** reuse `FsUtil` verbatim (`fullscreen-util.js`). ⛶ button → `FsUtil.enterFs(tableEl, {skipNative:false, lockOrientation:null})` (do NOT force-rotate — poker is portrait-native). Exit → `FsUtil.exitFs()`. Landscape side-rail: move controls to a RIGHT rail, felt scales `s = min((w−rail−8)/FELT_W, (h−8)/FELT_H)` (template `baccarat-ui.js:1018`) — **self-measure `w≥h`** (no iframe → no stale-viewport hintFresh branch). Portrait: controls bottom, felt scales to width. CSS contract: `html.fsu-fake{min-height:100.5lvh; overflow-y:auto}` + `#fsu-spacer` (iPhone/MetaMask chrome collapse), `body.fs-embed .fsbar` safe-area padding via `env()` (copy `baccarat.html:35-40`). Pick poker's own `FELT_W/FELT_H` (a 9-seat oval is wider than baccarat's 720×540 — needs real-device sizing so the rail never overlaps hero holes/slider).

---

## 9. WIRING / BUILD-ORDER CHECKLIST

- **Config flag:** `window.POKER_ENABLED = false` in `public/config.js` (mirror `BACCARAT_ENABLED:30`). Ship OFF.
- **Server env gate:** `POKER_ENABLED` in `server.js` (mirror `:215`/`:604`); gate `attachPoker` + ws routing + token bind.
- **View registration (`app.js`):** add `"poker"` to `GAME_ORDER` (`:3888`, currently absent — Poker hidden); when flag off, splice it out at boot (mirror the baccarat splice `:3895`). `document.body.classList.toggle("game-poker", …)` already exists (`:3911`). Remove the `:3885` "temporarily disabled" gate.
- **Balance-sync lists (`app.js`):** add `"poker"` to: `sesMode` (`:3373`), the `statsMode`/session-balance branch (`:3377`), the hidden-demo-credits list (`:3431`, `:3960` analog), the 1500ms repaint gate (`:3446`), the `ctf:resume-done` rebind (`:3587`), and add an `ensurePokerReady()` (mirror `ensureBaccaratReady`). Replace `pokerPoolUsd` (`:4795-4803`) with the server-authoritative session.
- **Token-bridge registration:** add `applyPokerNet` sibling in `token-http.js` (next to `:980`); export it in the service return (`:1045`); add `poker: 200` to `PAYOUT_CAP` (`token-bridge.js:72`); `server.js` `Poker.setTokenLedger({ tokensOf, applyNet: tokenSvc.applyPokerNet })`.
- **Profile stats:** `recordGameResult("poker", statsMode(), win, wagered, net)` at hand-settle for the local player (mirror `:4709`).
- **PF panel copy:** state the muck-verifiability property (§7).
- **Deploy discipline:** version-token bump (preflight.js), node-check gate, self-tests green BEFORE deploy; ship with flag OFF; smoke on localhost; flip ON only after a live-with-flag-off deploy is healthy.

---

## 10. PHASED BUILD PLAN

Each phase ships behind `POKER_ENABLED=false`; each has a deliverable + gating self-test.

**Phase 0 — Research/lock (DONE):** this spec. Deliverable: `poker-spec.md`. Gate: owner sign-off on §11.

**Phase 1 — Engine confirm + edits.** Deliverable: `poker-server.js` engine kept; `clientSeed`→`joinClientSeeds` lock-at-commit; rake in `_finish` (split accumulators). Self-tests: vectors 1–16 (esp. 12/13/15/16) green. NO money yet.

**Phase 2 — RoomManager (no money).** Deliverable: `PokerRoom`/`RoomManager` wrapping the engine — user-created tables, seat/leave/sit-out, button rotation, WAITING/HAND/SHOWDOWN/BETWEEN FSM, 20s act-timer + `actEpoch`, disconnect/reconnect grace, two-tier idle, `pk:` protocol with **per-socket masked broadcast**, `attachPoker` export. DEMO mode only (chips are play-money integers). Self-tests: FSM transitions, act-timer auto-fold/check with epoch guard, per-socket no-leak (16), reconnect-reclaims-same-seat.

**Phase 3 — MONEY (the crux).** Deliverable: `applyPokerNet` sibling; `PAYOUT_CAP.poker`; buy-in debit + `bindToken`; cash-out credit with **winner→obligation** capUp handling; creator-rake `recordObligation`; `hasLiveHand` freeze; force-cash-out on idle. Self-tests: **17 (end-to-end zero-sum to the cent)**, **18 (creator funding no-mint)**, capUp-winner-routes-to-obligation, multi-seat atomicity/precheck, stranded-lock-on-disconnect recovered.

**Phase 4 — Felt.** Deliverable: `poker-net.js` (clone); `poker-ui.js` rewritten as thin snapshot renderer (salvaged geometry/controls); lobby + create form + host panel; fullscreen (`FsUtil`, side-rail). Manual: multi-tab PvP on localhost, verify no hole-card leak in the network tab, fullscreen portrait+landscape on a phone.

**Phase 5 — Wiring.** Deliverable: config flag, view registration, all balance-sync list edits, profile stats, PF panel copy, `setTokenLedger`. Self-test: full CLI suite green; `app.js` boot with flag OFF hides Poker cleanly.

**Phase 6 — Verify.** Deliverable: adversarial review of the money diff (attack for drain/mint/stuck/leak); re-run all self-tests; localhost E2E (create table → 3 wallets buy in → play raked hands → all cash out → assert ledger zero-sum + creator obligation claimable). Gate: zero-sum + no-leak + no-stuck-lock all proven.

**Phase 7 — Deploy OFF → flip ON.** Deploy with `POKER_ENABLED=false` (preflight version bump); confirm live healthy + Poker hidden; then flip `POKER_ENABLED=true` (config + env) and redeploy; smoke a real table with small stakes.

---

## 11. OPEN QUESTIONS FOR THE OWNER

1. **Rake defaults:** confirm 5% / 3bb cap / no-flop-no-drop, and the 1–5% hard bound. Any minimum table rake?
2. **Creator eligibility:** may ANY wallet create a table, or gated (min balance / KYC / allowlist)? Per-wallet concurrent-table cap value (spec assumes 2)?
3. **Creator rake-share cash-out:** claim per-table at teardown, or a periodic sweep into one obligation? Any daily creator-rake cap for anti-collusion (`CREATOR_RAKE_CAP_DAILY`)?
4. **Collusion posture:** accept protocol-level chip-dumping as a known residual (rake makes transfer lossy; log every hand's PF reveal + deltas for post-hoc review; flag same-two-wallet heads-up tables)? Confirm this is v1-acceptable.
5. **`PAYOUT_CAP.poker` value:** 200× buy-in proposed — confirm vs the largest allowed table (`maxSeats·maxBuyIn/buyIn`).
6. **`TOKEN_MAX_WIN_USD` / obligation route:** confirm winners cash out via wallet obligation (to dodge `capUp` truncation) is acceptable UX (they claim like a recovered win), vs raising the session ceiling.
7. **Bots:** keep bots as optional table-fill (demo only, never wired to the bridge), or pure-human PvP only?
8. **Stakes whitelist:** confirm bb ∈ {2,5,10,25,50,100}. Add micro-stakes for demo?
9. **Idle timings:** 60s empty-reap / 5min seated-idle / 20s act-timer — confirm.
10. **Missed/dead blinds:** MVP uses "sit out until the button passes" (no dead blinds). Confirm phase-2 for full dead-blind accounting.

---

## 12. MONEY MODEL v2 — RED-TEAM HARDENED (BINDING; OVERRIDES §5 steps 4/6, §5.8, §6 where they conflict)

The money red-team (2026-07-03) CONFIRMED four fund-loss/mint defects in the §5 settlement rails against committed code. The engine + zero-sum math (§5.1–5.3, §5.5) are SOUND and unchanged. Only the **off-engine settlement rails** change. All items below are BINDING.

**H1 (was A1/A2) — DROP the `pendingSettle`/`recordObligation` route entirely for poker.** That map is single-slot-per-wallet (`token-http.js:275`, overwrite-on-write) and only claimable against a live `bjLocked` on-chain lock — so a winner-obligation and a creator-rake-obligation for the SAME wallet collide (one silently vanishes), and a creator-rake obligation with no lock behind it is unclaimable. **Both the winner reconciliation AND the creator rake-share are paid as HOUSE-FUNDED `applyPokerNet` CREDITS into the payee's own token session** (exactly like a vs-house game win). House-safe because every such credit ≤ chips the house already skimmed/holds (rake) or ≤ chips losers already debited (winner side). If the payee has NO open session, accrue into a durable **summed, append-only `pokerOwed[wallet]` ledger** (never overwrite) and pay on their next session open. Winner side never routes through an obligation.

**H2 (was A3) — buy-in debit is PRE-CHECKED and REFUSED, never floored.** Before `applyPokerNet(player, sid, buyInUnits, 0)`, assert `round(buyInUnits*100) ≤ round(tokensOf(sid)*100)` else throw `insufficient` (mirror `applyExternal:269`). A seat must never hold more table chips than its session actually surrendered — otherwise `applyExternal`'s loss-floor-at-0 (`token-bridge.js:273`) mints table chips a later winner is paid from.

**H3 (was A3/B4) — winner credit must not be silently capUp-truncated.** capUp clamps a session to `buyIn + TOKEN_MAX_WIN_USD`; a deep P2P winner can exceed it. Since winners are now house-funded credits (H1), the reconciliation credit must bypass capUp for poker OR be sized against a poker-specific ceiling. BINDING: the poker cash-out credit is exempt from `capUp` (it is a reconciliation of chips losers already surrendered, not a fresh house-risk win), bounded instead by the H4 absolute clamp. Do NOT rely on the global `TOKEN_MAX_WIN_USD`.

**H4 (was B3) — `PAYOUT_CAP.poker` is a NO-OP on `betUnits=0` credits** (`clampPayout` returns early when `!(b>0)`). Add a poker-specific ABSOLUTE clamp at cash-out: `creditUnits ≤ cumulativeBuyInUnits + maxTablePotUnits` (the most a single seat can legitimately hold). Assert it; fail-closed.

**H5 (was B2) — persistence + boot-drain (REQUIRED, no MVP exception).** Table seat→session bindings + stacks + `cumulativeBuyIn` + accrued rake persist durably (mirror the BJ bank/bridge disk files). On `attachPoker` boot, run a DRAIN: any poker-bound session with no live table reconstructs a force-cash-out (credit remaining stack, unbind) so a Render restart during a disconnect window can NEVER strand an on-chain lock (the v12.94 "locked funds forever" class). This is the single most important non-money-math addition and gates Phase 3.

**H6 (was C1) — a SEATED creator earns ZERO rake-share on hands they are dealt into.** That hand's creator-half routes to HOUSE (extend §6's "absent creator → house" to a seated creator). Kills self-dealing at the source. Non-negotiable.

**H7 (was C2) — creator-half accrues to the creator only after an anti-wash gate:** creator-half routes to HOUSE until the table has had **≥3 distinct funded wallets** play **≥N hands** (recommend N=10), AND a binding **`CREATOR_RAKE_CAP_DAILY`** per creator wallet. Both are BINDING defaults, not open questions.

**H8 (was A4/D1/D2) — settlement hygiene:** any poker payout that becomes an on-chain settlement draws a FRESH `uintNonce()`, stored append-only. Rebuy is a single guarded transaction `(debit → stack+= → cumulativeBuyIn+=)` that rolls back all three on any failure (refund-first-abort-on-fail). Multi-seat cash-out credits each seat independently (own try/catch → `credit_failed` → `pokerOwed` fallback); the zero-sum assert is computed over ATTEMPTED credits (booked OR owed), never only-successful, so a failed credit is an owed obligation, not a hole.

**New self-tests gating Phase 3 (add to the §3 list):** 19 house-funded winner credit bypasses capUp but respects the H4 absolute clamp; 20 insufficient buy-in is REFUSED (not floored); 21 boot-drain reconstructs a force-cash-out for an orphaned poker-bound session; 22 seated-creator hand routes creator-half to HOUSE; 23 creator-half withheld until the ≥3-distinct-wallets/≥N-hands gate opens; 24 `pokerOwed` sums (never overwrites) across two payouts to one sessionless wallet.

**Unchanged & CONFIRMED-GOOD by the red-team (keep):** engine `_finish`/`buildPots`/`snapshotFor` chip-conservation + no-leak; rake as the only sink with exact integer split (odd cent to creator); `applyPokerNet` as a non-generalizing sibling of `applyBaccaratNet`; creator-leave freeze + no-ownership-transfer (C3); fail-closed zero-sum assert; per-socket masked broadcast.

**One-sentence crux (updated):** the zero-sum math is correct inside the engine; move BOTH off-engine rails (winner reconciliation + creator rake-share) to HOUSE-FUNDED `applyPokerNet` credits (with a `pokerOwed` fallback when sessionless), pre-check buy-ins, add persistence + boot-drain, and gate the creator-half behind seated-creator-exclusion + an anti-wash distinct-wallet/daily-cap — then the model is provably house-safe with no fund loss, mint, or stranded lock.
