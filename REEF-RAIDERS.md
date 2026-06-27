# Reef Raiders — AI Handoff & Living Spec

> **Single source of truth for the Reef Raiders fish-shooter (TV channel 17).**
> Whoever works on this game next (human or AI) should read this top-to-bottom and
> **update it with every change** so it never goes stale. Keep the Changelog at the
> bottom current and bump the "Last updated" build below.

**Last updated: build v11.46.** Live at https://tv-crypto-flip.onrender.com (Render
auto-deploys the `claude/ethereum-betting-game-vrf-2dq50k` branch on push).

---

## 0. House rules for ANY AI (or human) editing this site — READ FIRST

These rules apply to **Reef Raiders and every other game on this site** (Coin Flip, Dice
0-100, Dice #2, Crash, Crypto Reels, Royal Riches, Balloon Pop, Plane, Blackjack, Poker).
Multiple AIs (Claude, ChatGPT, …) work on this repo, so we only stay in sync if everyone
follows the same discipline. **After every change you make, before you finish:**

1. **Update the docs.** Update this file (`REEF-RAIDERS.md`) for any Reef change, and the
   site-wide `HANDOFF.md` for anything cross-cutting. For other games, keep their notes
   current too — if a game doesn't have its own `*-HANDOFF.md` / spec file yet and you do
   non-trivial work on it, **create one in this same format** (Overview → Files → Wiring →
   Math → Mechanics → Loading → Versioning → Changelog) and add it to `HANDOFF.md`. Bump the
   "Last updated: build vNN.NN" line and add a **Changelog** entry (newest first) describing
   what you changed and why.
2. **Leave notes for the next AI.** The owner runs ChatGPT and Claude side by side. Always
   leave a short "NOTE FOR CHATGPT/CLAUDE (vNN.NN)" style entry (in `HANDOFF.md` and/or the
   game's doc) summarizing what you touched, so the other AI doesn't undo it or duplicate it.
3. **Bump the build version** on every shippable change (see §9). Stale caches are the #1
   source of "it didn't update" reports.
4. **Never reintroduce a fixed bug.** The Changelog + "Known issues" sections record real
   bugs that were fixed (e.g. the Reef boss-fish RTP exploit, the loading-screen hang, the
   jackpot money fountain). Don't revert those guards. If you must touch that code, re-verify
   the fix still holds.
5. **Protect the house edge.** This is a casino — the house must always have a positive edge
   on every game (the player must be net-negative EV long-term). **After ANY change that
   affects payouts, odds, or RNG, re-derive/re-simulate the RTP and confirm it's < 100%**
   (see §9). Document the resulting edge in the game's Math section. Never ship a payout
   change without checking the math.
6. **Test before you push.** Headless-test the change (see §9) and confirm no console errors.
7. **Secrets stay out of the repo.** Keys (e.g. `HOUSE_SIGNER_KEY`, `PRIVATE_KEY`) live only
   in Render env / a local `.env`, never committed. Don't put the configured model identifier
   in commits or pushed files.
8. **One game's change shouldn't break another.** The games share `app.js`, `tv.js`, the TV
   channel system, the demo/real money plumbing, and the contract. Check the shared paths
   (channel wiring, `switchGame`, `idle()`, the deposit/credits flow) when you edit them.

Keeping these docs current IS part of the task, not optional cleanup. If you change the game
and don't update the doc, the next AI will work from wrong information.

---

## 1. What it is

Reef Raiders is an arcade "fish-table" shooter (Fu-Fish / Ocean King style): you aim a
cannon at the bottom of the screen and shoot fish swimming across a tank. Catching a
fish pays a multiple of your bet. It runs **inside the on-page "TV"** as **channel 17**,
internal game key **`"fish"`**. It is currently **play-money / demo** (real-money credits
are designed but not yet wired — see §8).

It is built with **PixiJS v7** (vendored, no build step, no CDN at runtime). All code is
plain ES5-ish IIFE modules served as-is from `public/`.

---

## 2. Files

| File | Role |
|------|------|
| `public/fishtable.js` | **The renderer + gameplay.** `FishTable` Pixi class: cannon, bullets, fish, HUD, bonus rounds, jackpot, fullscreen, the host bridge. ~840 lines. This is where 90% of Reef work happens. |
| `public/fishtable-engine.js` | **The money/odds brain.** `FishTableEngine` — no Pixi/DOM. Fish roster, kill-probability RTP math, seeded RNG. |
| `public/app.js` | Host app. Lazy-loads + wires Reef: `ensureFishLoaded()`, `buildFish()`, `ensureFishReady()`, the `switchGame()` `"fish"` branch, and the **page-load restore** branch. Also the `confirmTransfer()` deposit modal. |
| `public/tv.js` | The "TV". `_fishIdle()` reveals the canvas; `idle()`/`changeChannel(17)` route to it; `_endPromo()` re-reveals after the promo. |
| `public/index.html` | `#layer-fish` → `#fish-stage` (canvas mounts here) + `#fish-fs-exit`. The `.action-dock.fish-dock` controls (bet/power/auto/lock/fullscreen) and `#fish-panel` session readout. Build/version tags. |
| `public/styles.css` | `.fish-stage`, `#layer-fish.rr-fs` (fullscreen), `body.rr-fs-on` chrome-hiding, `.fish-dock`, the `#xfer-modal` styles. |
| `public/_reef_preview.html` | Standalone preview harness (loads the renderer outside the TV) for fast iteration. |

Engine + renderer are loaded with a cache-busting `?v=NNNN` from `app.js`
(`ensureFishLoaded`): `fishtable-engine.js?v=1145` then `fishtable.js?v=1145`.

---

## 3. Channel wiring (how it shows on the TV)

- `GAME_CHANNEL.fish = 17`, `GAME_TITLE.fish = "REEF RAIDERS"`, included in `GAME_ORDER`,
  body class `game-fish` (set by `paintGameTabs`).
- **Lazy-load:** `ensureFishLoaded()` loads Pixi + the two Reef scripts. `buildFish()`
  `new FishTable({...})` mounts a `<canvas>` into `#fish-stage`. `ensureFishReady()`
  builds + activates it and runs a **watchdog** (see §7).
- **Reveal:** `tv.js _fishIdle()` — if `#fish-stage canvas` exists → `_show("fish")`
  (sets `TV._phase = "fish"`); else shows `_loadingScreen()`. `idle()` routes channel 17
  here; `changeChannel(17)` calls `_fishIdle()`.
- **Entering the channel:** `switchGame("fish")` → `TV.changeChannel(17)` + `ensureFishReady()`.
  Leaving: `switchGame` calls `fishGame.setActive(false)` to pause the ticker.

### Host bridge (FishTable public API, called from app.js)
`setActive(bool)`, `setEnabled(bool)`, `setBalance(usd)`, `setEthUsd(n)`, `setBet(v)`,
`setPower(p)`, `toggleAuto()`, `toggleLock()`, `toggleFullscreen(el)`,
`setFullscreenTarget(el)`, `newSession(buyIn)`. Callbacks: `onBalance(usd)` (syncs the
demo balance), `onWin({profitUsd, bonus, mult})` (feeds the universal win overlay).

---

## 4. Money model & MATH (house edge ~10%)

> ⚠️ Reef pays out, so getting this right matters. As of v11.45 the realized RTP is
> **~90% (≈10% house edge)** for sensible play. Earlier builds paid **>100%** (the player
> won long-term) — see the fixes below so you don't reintroduce them.

### Core kill RTP (`fishtable-engine.js`)
Every fish has a payout multiple `mult`; catching pays `mult × unitBet`. A shot of power
`P` costs `P × unitBet`. On a hit the fish dies with probability:

```
p_kill = clamp( P * RTP / mult , P_MIN , P_MAX )
```

Constants: **`RTP = 0.85`, `P_MIN = 0.005`, `P_MAX = 0.9`.**
Expected payout of a connecting shot = `mult * (P*RTP/mult) = P*RTP = RTP * cost` → a flat
85% return on kills, **independent of which fish you shoot**.

- **Why `P_MIN = 0.005` (not 0.02):** `P_MIN` must stay **below `RTP / maxMult` = 0.85/160
  = 0.0053**, or boss fish get over-rewarded. The old `0.02` floor made the **Kraken
  (mult 160) pay 320%** and the **Gold Shark (mult 80) 160%** at power 1 — you could farm
  bosses for guaranteed profit. At 0.005 every fish returns ~85% at power 1.
- `P_MAX = 0.9` caps small-fish kill chance at high power → favors the house (don't "fix" this).

### Progressive jackpot (self-budgeting, `fishtable.js`)
- **5% of every PAID shot** accrues to `this._jackpotPool` (in `_fire`, only when `cost > 0`).
- The meter (`this._jackpot`) fills `+0.0022 * power` per catch; when full it calls
  `_awardJackpot()` which pays out **the whole pool** and resets it.
- Because it pays exactly what it raked, the jackpot **returns the 5% it takes** — RTP-neutral
  by construction. (Old code handed a **free 300–900× every ~83 catches** — the single
  biggest leak. Never go back to a fixed-payout meter.)
- The meter label shows the live pool: `★ JACKPOT $<pool> · <pct>% ★`.

### Bonus rounds (rare, triggered by catching specific fish)
- **Gold Crab (`bonus:"chest"`) → Treasure Chest:** pops `4–6` prizes from
  `[1,1,2,2,3,3,5,5,8,10,15]` (× unitBet). Trimmed from the old `5–8 × [...,25,50]`.
- **Treasure Clam (`bonus:"frenzy"`) → Feeding Frenzy:** `6s` of free auto-fire, **capped at
  25× unitBet of winnings** (`_updateFrenzy` ends it once `_frenzyWon >= unitBet*25`) so free-fire
  can't blow the edge. Was 9s, uncapped.

### Net result (simulated, 3M shots)
Random targeting @power1 = **89.9% RTP**; boss-only farming = **90.7%** (exploit dead);
small-fish only = **89.9%**. Bonus rounds add a couple % on top of the 85% kill base + 5%
jackpot rake. **Tune by editing `RTP` in the engine and the jackpot rake / bonus caps in
the renderer; re-run the sim (see §9) after any payout change.**

### Session money-flow readout
`fishtable.js` tracks `_sesSpent` / `_sesWon` and renders a top-of-canvas line + the
`#fish-panel` (`#fish-ses-spent/won/net`) so the credit flow is visible. `newSession(buyIn)`
resets it (called on first channel entry).

---

## 5. Gameplay mechanics

- **Bullets NEVER expire** — they ricochet off all four walls forever until they catch a
  fish (so a paid shot is never wasted). Retire only on `b.hit`. Memory is bounded by a
  38-bullet FIFO cap in `_fire()`. (Do not re-add bounce/life caps.)
- **Fish fill the whole field** so any shot angle meets a target: `_spawnFish` picks an
  entry edge — ~78% horizontal swimmers spanning the full height incl. the bottom band
  (`rand(30, H-40)`), ~22% **vertical swimmers** entering from the top/bottom edges
  (`mode:"v"`, with `vx/vy/baseX`). The `_frame` move + despawn loop branches on `f.mode`.
- **Aim clamp** (`_pointAt`): never aims flat or downward; kept ~7° off perfectly horizontal
  so a shot can't get trapped in a zero-height band.
- **Specials:** Bomb Fish = AoE splash; Electric Eel = chains to 3 nearest. Power 1–MAX_POWER
  scales cost + kill chance together (RTP preserved).

### Money/state safety invariants (do NOT break — these were real bugs)
- **Frenzy must end at exactly 0.** The free-shot Frenzy makes shots cost 0. Its winnings
  cap must set `_frenzy = 0` (NOT a tiny positive like `0.0001`) — a positive value gets
  re-pinned every frame so the `<= 0` end-check never fires → **frenzy stuck ON forever =
  free shots that never deduct + auto-fire that can't be stopped** (this was the live bug).
  `_startFrenzy` also early-returns if a frenzy is already active (no chaining).
- **`_holding` must clear on cancel.** The hold-to-fire flag clears on mouseup/touchend AND
  `touchcancel`/`pointercancel`/`blur`/`visibilitychange` — without the cancel handlers a
  cancelled mobile touch leaves it stuck true → endless fire. `toggleAuto()` also force-clears
  `_holding`, so tapping Auto is always a reliable stop.
- **Bonus state must not strand firing.** Firing is gated on `!_chest && !_jpFx`. `setActive(false)`
  calls `_forceEndBonuses()` (clears `_frenzy`, tears down `_chest`/`_jpFx` containers) so
  navigating away mid-bonus can't leave firing disabled on return.
- **Every paid shot deducts exactly `cost()`** (verified: 3,334-shot headless run, 0 bad
  deductions). The only free shots are during an active Frenzy. Keep it that way.

---

## 6. Fullscreen (mobile-critical)

- `toggleFullscreen(el)` **REPARENTS `#layer-fish` to be a direct child of `<body>`**
  (saving its home in `this._fsHome`), adds `.rr-fs` to it + `rr-fs-on` to `<body>`, and
  requests the real Fullscreen API where supported (iOS Safari ignores it for divs — the
  reparent + class is the real mechanism). `_fsExit(el)` reverses it (restores the element
  to `#tv-screen`, removes classes, exits real FS). `setActive(false)` also calls `_fsExit`
  so leaving the channel can't strand the layer on `<body>`.
- **Why reparent:** whitelisting chrome elements to hide kept missing things (the ETH
  ticker, the Share-win button, and the **landscape desktop side-menu `#game-nav`**, which
  only appears at wide viewports). With the layer on `<body>`, ONE rule hides everything:
  `body.rr-fs-on > *:not(#layer-fish) { display: none !important; }`. Verified headless: in
  fullscreen, the ONLY rendered things are `#layer-fish` and `#fish-fs-exit`.
- **Aspect:** `#layer-fish.rr-fs .fish-stage canvas { object-fit: contain }` so the 3:2
  render is letterboxed, not stretched. Rotate the phone to landscape to fill the screen.
- **Exit:** `#fish-fs-exit` ("✕ Exit fullscreen") lives INSIDE `#layer-fish` (so it moves
  with the reparent and stays clickable) — big, `position:fixed`, max z-index, shown only
  in `.rr-fs`. The dock fullscreen button and this exit button both call `toggleFullscreen`.

---

## 7. Loading / reveal (the "stuck on loading" class of bug)

Reef lazy-loads, so the loading screen can hang if the reveal fires before the canvas mounts.
Guards that MUST stay in place:

1. **Page-load restore branch** (`app.js`, in the channel-restore block): `if (saved === "fish")
   ensureFishReady();`. **Without this, a manual refresh on Reef hangs forever** (the canvas is
   never built) — the original "stuck after refresh" bug.
2. **Watchdog** (inside `ensureFishReady`): polls `TV.idle()` every 200ms until
   `#fish-stage canvas` exists AND `TV._phase === "fish"`; re-kicks the lazy loader up to 2×
   if the canvas never mounts. It does **not** spend its retry budget while `TV._promoPlaying`
   (a long promo used to exhaust it).
3. **Promo re-kick** (`app.js`): `window.__onPromoEnded` calls `ensureFishReady()` when
   `currentGame === "fish"`, because `_endPromo`'s single `idle()` can fire before the canvas mounts.
4. **`changeChannel(17)`** has an explicit `else if (num === 17) this._fishIdle()` (was missing →
   fell through to the coin-flip preview).
5. **`setConnected`** refreshes the `"fish"` phase on connect/disconnect (was missing → stale screen).

If Reef ever hangs on loading again, check these five first.

---

## 8. Real-money credits status (PARKED — blocked on a redeploy)

The owner wants real-money credits (deposit → buy-in → play → cash-out) for the off-chain
games incl. Reef. The mechanism exists in `contracts/CoinFlipBetting.sol` as a **generic**
lock-and-signed-settle: `blackjackBuyIn(amount)` locks credits from `balances[]`,
`settleBlackjack(player, net, nonce, sig)` settles a house-signed net P&L (works for ANY
off-chain game, not just blackjack). `realmoney.js` (server) holds the house signer.

**BLOCKER:** these functions are **not in the currently deployed contract** — the live
`public/contract.js` ABI lacks them. Real-money credits is impossible until the owner
**redeploys** the updated contract (the source has the functions; v11.45 made the build fit
under EIP-170 via `viaIR`, and regenerated `contract.js` so the in-browser "🔄 Start a fresh
game (redeploy)" host tool deploys it). After redeploy: bake the new address into
`config.js`, build the buy-in/cash-out UI + server signer endpoint, then the owner runs
`setBlackjackSigner` + sets `HOUSE_SIGNER_KEY` in Render env. Until then Reef stays play-money.

---

## 9. How to work on it

### Versioning (REQUIRED on every shippable change)
Bump the build everywhere or the browser serves stale cached files:
- `public/index.html`: `?v=NNNN` (~14 occurrences) **and** the two build chips `>v11.XX<`.
- `public/app.js`: the lazy-loader `?v=` strings (coinflip3d, blackjack, slots3d,
  `fishtable-engine.js?v=`, `fishtable.js?v=`).
- `public/sw.js`: the `CACHE`/`ctf-v11.XX` constant.

Quick bump (example 1145 → 1146):
```
sed -i 's/1145/1146/g' public/index.html public/app.js
sed -i 's/v11\.45/v11.46/g' public/index.html
sed -i 's/ctf-v11\.45/ctf-v11.46/' public/sw.js
```

### Headless testing (Playwright, no internet needed at runtime)
Server is usually already running on `:3000` (`PORT=3000 node server/server.js`).
```
NODE_PATH=/home/user/yachtbazar-data/node_modules node <script>.js
```
Chromium: `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`,
`args: ['--use-gl=swiftshader','--no-sandbox']`. Drive the game via `window.__fish`
(the live FishTable instance) — e.g. `__fish._fire()`, read `__fish.balance` / `__fish.fish`
/ `__fish.bullets`. The reveal test: set `localStorage.ctf_game='fish'`, reload, assert
`#fish-stage canvas` exists and `TV._phase === "fish"`.

### RTP simulation (after ANY payout change)
Run a pure-engine sim of `resolveHit` over millions of shots across strategies (random
targeting, boss-only, small-only) and confirm RTP stays ≤ ~0.92. The jackpot rake and bonus
caps live in the renderer, so for a full check also reason about those (see §4).

---

## 10. Known issues / TODO

- **Art/animation overhaul** (multi-part sprites + bones-ish rig, squash/stretch, trails,
  glow, particles) — researched, not implemented.
- **Real-money credits** — see §8 (blocked on redeploy).
- Bonus rounds (chest/frenzy) are budgeted by trimming/caps rather than a precise rake; if
  you want an exact total RTP incl. bonuses, fund them from a rake like the jackpot.

---

## Changelog (newest first)

- **v11.46** — Bug-hunt pass (auto-fire stuck / not deducting). ROOT CAUSE: the Frenzy
  winnings cap set `_frenzy = 0.0001`, which re-pinned every frame so Frenzy never ended →
  free shots forever + auto that couldn't be stopped (now ends at exactly 0). Also: `_holding`
  now clears on touchcancel/pointercancel/blur/visibilitychange + `toggleAuto` force-clears it;
  `_startFrenzy` won't re-arm an active frenzy; `setActive(false)` tears down in-flight
  bonus rounds (`_forceEndBonuses`). **Fullscreen rewritten to REPARENT `#layer-fish` to
  `<body>`** so one rule hides all chrome (incl. the landscape side-menu, ETH ticker,
  Share-win button) — verified only the game + exit button render. Verified via a headless
  ledger harness: 0 bad deductions across 3,334 shots, frenzy/chest/jackpot all end.
- **v11.45** — Fixed the refresh-hang (missing `fish` branch in the page-load restore +
  `changeChannel`/`setConnected` gaps). **Reef math → ~10% house edge**: RTP 0.92→0.85,
  kill floor 0.02→0.005 (killed the 320%/160% boss exploit), jackpot turned into a
  self-budgeting 5% progressive rake, chest/frenzy trimmed + frenzy capped at 25×. Mobile
  fullscreen: aspect-preserve (object-fit) + reliably hide all chrome + prominent exit button.
- **v11.44** — Music no longer auto-starts after the promo; fixed Reef hanging on the loading
  screen after the promo (re-kick + watchdog ignores promo time); added the wallet↔credits
  transfer confirmation modal (`#xfer-modal`).
- **v11.43** — Shots never expire (ricochet until a catch); fish fill the whole field incl.
  vertical swimmers from top/bottom edges; fixed the HUD overlap (session line vs jackpot
  meter); load watchdog in `ensureFishReady`.
- **v11.42** — Session money-flow readout (spent/caught/net) so the credit flow is visible.
- **v11.41** — Frenzy free-shots, fullscreen button, loading re-pokes, keep Reef visible on
  wallet connect.
- **v11.37** — Reef Raiders shipped live as CH 17 (renderer + 92% RTP engine + bonus rounds).
