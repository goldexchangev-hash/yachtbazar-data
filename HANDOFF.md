# Crypto TV — Project Handoff

Everything another AI (or developer) needs to continue this project flawlessly.
Last updated at build **v11.67**.

> **NOTE FOR CLAUDE/CHATGPT (v11.67):** Bug hunt hardening pass.
> Real-wallet Blackjack WebSockets no longer trust a bare `hello.address`; bridge
> buy-in now issues a per-session `wsToken`, the iframe sends it as `bjtoken`, and
> the server only stamps a real wallet onto the Blackjack socket when the token
> matches the open bridge session. Bridge start now preflights open table exposure
> before mutating/saving session state, avoiding stranded buy-ins if a top-up is
> attempted mid-hand. Balloon Pop remains play-money enabled after wallet connect
> even when lazy-loaded after connect. Versioned service-worker asset misses now
> return a 503 instead of falling back to `index.html` as JavaScript.

> **NOTE FOR CLAUDE/CHATGPT (v11.66):** Follow-up full-scan runtime fix.
> Browser/runtime scan found a front-end `MutationObserver.observe(...)` crash in
> the mobile floating bet bar when the active action dock was not a valid element.
> `observeBetbarDock()` now guards the observed target and falls back to a height
> sync. Cache/build bumped to 1166.

> **NOTE FOR CLAUDE/CHATGPT (v11.65):** Third audit pass bridge hardening.
> The bridge can no longer be enabled with only a signer and flag; it now also
> requires `BRIDGE_STATE_FILE` so used buy-in tx hashes and sessions are persisted
> across restarts. `/api/bridge/status` is chain-aware (`?chainId=`) and reports
> `stateConfigured`, so Sepolia buy-ins are not green-lit by a local-only RPC.
> Buy-in verification checks current on-chain `bjLocked(player)` against the emitted
> locked amount, which rejects already-settled historical buy-in txs. Cache/build
> bumped to 1165. Real-money bridge still remains disabled on Render until durable
> state, Sepolia RPC, signer, wallet auth, and the explicit flag are all configured.

> **NOTE FOR CLAUDE/CHATGPT (v11.64):** Second audit pass.
> Fixed bridge verification/session issues from the post-`v11.63` audit: the
> `BlackjackBuyIn` ABI now matches the contract's `(player, amount, locked)` event,
> Blackjack bridge starts store the returned session id client-side, and settle prefers
> the open session unless an exact `sessionId` is supplied. This prevents a later
> session from replaying an older cached settlement. Reef mobile now maps the floating
> bet strip to `#fish-bet`; Reef demo reset clears all live bullets so old paid shots
> cannot hit after a reset; Pressure reset/balance updates refresh stale status text.
> Cache/build bumped to 1164. Real-money bridge remains gated behind
> `ENABLE_EXPERIMENTAL_BRIDGE=1`; full signed wallet auth is still required before
> enabling that flag for value.

> **NOTE FOR CLAUDE/CHATGPT (v11.63):** Whole-site bug-hunt hotfix.
> Mobile header: disconnected phones no longer reserve an empty wallet cluster, so
> Music/Help/Chat and Connect stay visible. Connected phones keep all top-bar buttons
> plus the compact `OUT` sign-out pill. Core wallet games: Dice, Dice #2, Crash, Plane,
> and legacy Crypto Reels now treat `$0` in-game credits as insufficient instead of
> letting zero-balance wallets submit reverting bets; live click paths re-check
> `read.balances(account)` immediately before sending. Dice #2 now keeps its unsupported
> contract warning disabled after slider/readout updates. Gem Vault remains playable
> as play-money after wallet connect. Reef/Fish controls are enrolled in the mobile
> fixed-dock layout so portrait controls do not clip under the bottom nav. Blackjack
> bridge top-ups now add to an existing verified session instead of replacing table
> funds, and real wallet identity must come from the stamped WebSocket connection
> while guest ids still work for demo. The real-money bridge is intentionally gated
> behind `ENABLE_EXPERIMENTAL_BRIDGE=1`; server-side buy-in credits are derived from
> `BRIDGE_ETH_USD`/`ETH_USD`, duplicate tx hashes are reserved during verification,
> and settle responses are idempotent. Legacy `/slots.html` redirects to Gem Vault;
> Blackjack iframe inner assets are cache-bumped; PWA shell caches all local icons;
> Gem Vault/Plane/Reef internal max buttons obey demo caps; reset clears active
> Pressure/Gem/Reef bonus state; flip feed/history uses the contract's 3% fee math.
> Full cache/build bump to 1163, including app JS, lazy game scripts, CSS,
> manifest/promo, Blackjack iframe URL, and service worker cache.

> **NOTE FOR CLAUDE/CHATGPT (v11.62):** Restore mobile speaker/help top-bar buttons.
> v11.58 hid the speaker and Help buttons under 480px to keep wallet sign-out visible.
> That removed useful menus on phones. `styles.css` now keeps speaker, Help, and Chat
> visible by shrinking icon buttons, the network badge, wallet avatar, address width,
> and the `OUT` sign-out pill instead of hiding controls. Build/cache bumped to 1162.

> **NOTE FOR CLAUDE/CHATGPT (v11.61):** Show game credits on connected Blackjack.
> Connected wallets have `$0` server table chips until they lock game credits into
> Blackjack, which looked like the player's balance vanished. `renderBjDock()` now
> paints `Credits $X` from `gameWei` when table chips are zero, changes Reload to
> `Lock credits`, and refreshes on-chain balance before starting a buy-in. Build/cache
> bumped to 1161.

> **NOTE FOR CLAUDE/CHATGPT (v11.60):** Fix Blackjack black screen after wallet connect.
> v11.59 cleared a stale guest Blackjack iframe with `f.src = ""`, but browsers can
> resolve an empty iframe src to the current page URL, leaving `ensureBlackjackReady()`
> thinking the iframe was already loaded and causing a black CH-16 screen. It now uses
> `removeAttribute("src")` and checks `getAttribute("src")` before loading
> `blackjack.html`. Build/cache bumped to 1160.

> **NOTE FOR CLAUDE/CHATGPT (v11.59):** Hide demo balance after wallet connect.
> Connected wallets now forcibly hide `#demo-bar`, `#demo-below`, and the TV demo badge
> in both JS and CSS. Blackjack also now reloads its iframe if it was already loaded
> under a `guest:` id, so connected users do not keep seeing the demo/guest `$1,000`
> table balance after MetaMask connects. Build/cache bumped to 1159.

> **NOTE FOR CLAUDE/CHATGPT (v11.58):** Mobile connected-header fix.
> On narrow phones, the connected wallet pill could push the Disconnect button off the
> right edge. `styles.css` now lets the wallet cluster shrink, ellipsizes the address,
> compacts Disconnect to an `OUT` pill, compresses the network badge, and hides the
> extra music/help icons under 480px. Build/cache bumped to 1158.

> **NOTE FOR CLAUDE/CHATGPT (v11.57):** Blackjack wallet bridge foundation.
> Added `server/bridge-server.js` and attached it from `server/server.js`. The only live
> bridge game is Blackjack because it is server-authoritative: `/api/bridge/blackjack/start`
> requires a confirmed `BlackjackBuyIn` event from the contract tx before funding table
> chips, and `/api/bridge/blackjack/settle` signs only the server-held blackjack balance.
> Required Render env before this works live: `HOUSE_SIGNER_KEY` plus `SEPOLIA_RPC_URL`
> (or `RPC_URL`), and the contract owner must set `blackjackSigner` to the signer address.
> Connected-wallet Blackjack now loads under the wallet address; guest play keeps demo
> reload. Balloon Pop, Gem Vault, and Reef are deliberately listed as parked bridge games
> until server-side replay adapters are added. Build/cache bumped to 1157.

> **NOTE FOR CLAUDE/CHATGPT (v11.56):** 0-100 Dice target clamp + Reef frenzy-freeze hotfix.
> Dice: the 2% edge makes targets above 98.00% (under) / below 1.99% (over) produce a
> multiplier below 1.00x, so `app.js` now clamps dice targets with `clampDiceTarget()` in
> readouts, demo rolls, and real-wallet rolls. Reef: v11.55 could end Feeding Frenzy while
> the bullet loop was resolving a catch, then remove bullets by stale array index and freeze
> the tank near the end of free shots. `fishtable.js` now removes bullets by object identity
> via `_removeBullet()`, skips missing bullet slots after array shrink, and only closes frenzy
> once. Build/cache bumped to 1156.

> **NOTE FOR CLAUDE/CHATGPT (v11.55):** Reef Raiders payout hotfix + Balloon/0-100 UI.
> Reef now snapshots unit bet/power/cost onto every bullet, budget-prices special fish
> (`chest`/`frenzy` + bomb/eel splash value) in `fishtable-engine.js`, caps Bomb Fish
> splash to the 4 closest targets, makes Treasure Chest/Frenzy use trigger-time stake/power,
> clears stale frenzy free bullets, and adds `scripts/reef-rtp-audit.js`. A 1M-shot $50
> audit puts tested random/boss/small/lock-on styles under ~91% RTP after jackpot/bonus
> estimates; old lock-on/special farming was player-positive. Balloon Pop demo stakes are
> capped at $500 in `pressure-ui.js`. 0-100 TV preview now updates the green/red rail live
> while dragging the target slider. Build/cache bumped to 1155.

> **NOTE FOR CLAUDE/CHATGPT (v11.54):** Emergency TV startup hotfix. v11.53 removed
> the old CH-12 Crypto Reels DOM layer, but `tv.js::_show()` still blindly called
> `.classList` on every registered layer including the now-missing `slots` layer.
> That crashed TV init and showed SIGNAL LOST across the site. `_show()` now skips
> null/missing layers. Build/cache bumped to 1154 so browsers load the fixed TV script.

> **NOTE FOR CLAUDE/CHATGPT (v11.53):** Blackjack mobile/TV layout pass + Crypto
> Reels removal. CH-16 now tags occupied seats and uses an adaptive TV layout:
> one occupied seat hides empty seats and gives the player/dealer larger readable
> cards; as seats fill it compresses toward the four-seat table. Dealer total is
> now explicit (`Showing X` before the hole card reveal, `Dealer Y` after). The old
> CH-12 Crypto Reels slot was removed from visible nav/TV/dock/panel routing and
> old `?game=slots` links fall through to Gem Vault (`slots3d`). **Gem Vault gameplay
> and renderer were intentionally not changed.**

> **NOTE FOR CLAUDE/CHATGPT (v11.52):** Gem Vault RTP fix. Independent audit found
> `slots3d-engine.js` was ~95% on **base spins only** but ~129-130% RTP after the
> active credited free-spins bonus was included. The CH-15 Gem Vault paytable and
> scatter cash pays were retuned so base spins are ~70% and the free-spin feature
> contributes the rest, putting full modeled RTP back near **~95%**. Do not restore
> the old `PAY` / `SCATTER_PAY` values unless the free-spin bonus is also redesigned.

> **NOTE FOR CLAUDE/CHATGPT (v11.51):** Reverted the CH-15 slot ART back to the ORIGINAL
> **Gem Vault** at the owner's request. v11.50 ("Restore Gem Vault channel") re-enabled the
> channel + renamed it to "Gem Vault" but kept the **Royal Riches renderer** (`slots3d.js` =
> gold vault-dials / ruby cherries / emerald grapes / amethyst WILD), so the owner still saw
> the wrong art. Now `public/slots3d.js` is restored to the pre-Royal-Riches commit
> `f1945b4` (flat neon symbols: cherry/bell/star/7/BAR/diamond/WILD/vault) and the emoji is
> back to 💎. Channel id (15), key (`slots3d`), and the engine (`slots3d-engine.js`) are
> unchanged. The Royal Riches renderer is preserved in git history (`c2c6b31`..`180d11d`) if
> it's ever wanted again. **Do NOT swap this back to Royal Riches without owner approval.**

> **📒 PER-GAME LIVING SPECS:** Detailed, always-current handoff docs live alongside this
> file. **`REEF-RAIDERS.md`** is the full spec for the Reef Raiders fish-shooter (CH 17) —
> read it before touching that game. Its **§0 "House rules for ANY AI"** applies to the
> WHOLE site: after every change, update the relevant doc + Changelog, bump the build
> version, leave a note for the other AI, protect/verify the house edge, and test before
> pushing. If you do non-trivial work on a game that has no spec file yet, create one in the
> same format and link it here.

> **NOTE FOR CLAUDE/CHATGPT (v11.47):** Reef Raiders Android fullscreen fix. The fish
> game now auto-enters CSS fullscreen when a mobile device rotates to landscape via the
> CSS-only `autoFullscreen` path, then exits that auto mode on portrait without stealing
> manual fullscreen. `.rr-fs-on` CSS now hides topbar, bottom nav, chat rail/drawer,
> ticker/share UI, and modal chrome; duplicate exit-button styling was consolidated.
> No math/payout/RNG changes.

> **NOTE FOR CLAUDE/CHATGPT (v11.48):** Follow-up Android fix for the owner's exact repro:
> tap Reef fullscreen, then tilt to landscape. Android may drop native fullscreen during
> rotation; `FishTable.setFullscreenTarget()` now preserves/reasserts the CSS `.rr-fs`
> shell instead of calling `_fsExit`, and the tilt listener runs repeated delayed syncs.
> This keeps site chrome from returning over the game. The manifest now uses fullscreen
> display + any orientation for the iOS Home Screen/PWA path; Safari's own address/tab bar
> cannot be hidden by ordinary page code. No math/payout/RNG changes.

> **NOTE FOR CLAUDE/CHATGPT (v11.50):** Correction: the owner wanted **Gem Vault** kept.
> Royal Riches was the renamed Gem Vault channel (`slots3d`), so v11.49 accidentally hid
> the game. v11.50 restores CH 15 / internal `slots3d` and changes player-facing branding
> back to **Gem Vault**. Do not use the Royal Riches name unless the owner asks.

> **🆕 NOTE FOR CHATGPT (v11.44):** (1) **Music no longer auto-starts** after the
> promo intro — `window.__onPromoEnded` no longer calls `startMusicAfterPromo`;
> music plays ONLY when the user taps the Music button. (2) **Reef no longer hangs
> on the loading screen after the promo.** `__onPromoEnded` now re-kicks
> `ensureFishReady()` when `currentGame==="fish"`, and the load watchdog no longer
> spends its retry budget while `TV._promoPlaying` (a long promo used to exhaust it,
> leaving Reef stuck until a channel switch). (3) **Deposit/withdraw confirmation
> modal** (`#xfer-modal`, `confirmTransfer()` in app.js) — every wallet↔credits
> move now shows the exact $ + ETH and direction BEFORE the MetaMask popup.
>
> **⚠️ REAL-MONEY CREDITS BLOCKER:** The owner wants real-money credits for the
> off-chain games (Blackjack, Reef, Gem Vault, Balloon Pop) via the generic
> `blackjackBuyIn`/`settleBlackjack` lock-and-signed-settle mechanism. Those
> functions EXIST in `contracts/CoinFlipBetting.sol` but are **NOT in the deployed
> artifact** (`public/contract.js` ABI lacks them) — the live contract is the older
> build. **This feature is blocked on the owner redeploying the updated contract**
> (then update `contract.js` ABI+address, `fundHouse`, `setBlackjackSigner`, set
> `HOUSE_SIGNER_KEY` in Render env). Until then blackjack/arcade games stay
> play-money (blackjack seeds its server bank from the demo balance).

> **🆕 NOTE FOR CHATGPT (v11.43):** **Reef Raiders** gameplay/feel fixes —
> (1) **Shots never expire.** In `fishtable.js` `_frame()` bullet loop, the
> `bounces/life` retirement caps were removed: a shot ricochets off all four
> walls **forever until it catches a fish** (so a paid shot is never wasted).
> Memory stays bounded by the 38-bullet FIFO cap in `_fire()`. (2) **Fish fill
> the whole field.** `_spawnFish` now picks an entry edge: ~78% horizontal
> swimmers spanning the **full height incl. the very bottom band** (`rand(30,
> H-40)`), ~22% **vertical swimmers entering from the top/bottom edges** (new
> `mode:"v"`, `vx/vy`, `baseX`). The `_frame` fish-move + despawn loop branches
> on `f.mode`. Net effect: flat/horizontal/straight-up shots always meet a target.
> (3) **HUD overlap fixed** — session readout moved to a centered top line
> (`sesText` y=9), jackpot label/meter pushed below it (`jpText` y=30, bar y=52).
> (4) **Loading watchdog** — `ensureFishReady()` in `app.js` now polls
> `TV.idle()` every 200ms until `#fish-stage canvas` exists AND `TV._phase==="fish"`,
> re-kicking the lazy loader up to 2× if the canvas never mounts (fixes the
> "loads but keeps the loading screen on" hang).

> **🆕 NOTE FOR CHATGPT (v11.37):** NEW GAME — **Reef Raiders** (CH **17**, key
> **`fish`**), an arcade fish-shooter, is now LIVE (demo/play-money). Files:
> `public/fishtable.js` (PixiJS renderer + host bridge `setActive/setEnabled/
> setBalance/setEthUsd/setMode/setBet/setPower/toggleAuto/toggleLock/
> toggleFullscreen`) and `public/fishtable-engine.js` (~90% RTP, per-fish
> kill-probability `p=power*RTP/mult`, seeded provably-fair stream). Wired exactly
> like the slots3d channel: `GAME_CHANNEL/TITLE/ORDER`, `ensureFishLoaded/
> buildFish/ensureFishReady`, demo-only show/hide (hidden in real mode),
> `tv.js _fishIdle`+`layers.fish`, `index.html` `#ch-fish`/`#layer-fish`/`.fish-dock`/
> `#fish-panel`, `styles.css` `.fish-stage`/`.fish-*`. Bonus rounds: **Gold Crab →
> Treasure Chest** (prizes pop out + add up), **Treasure Clam → Feeding Frenzy**
> (timed fish flood). **Fullscreen** via `#fish-fs` → `toggleFullscreen(#layer-fish)`.
> Real-money/wallet PARKED (buy-in→credits→cash-out, same model as blackjack — do
> NOT build until owner says go). Standalone preview: `public/_reef_preview.html`.

> **NOTE FOR CHATGPT (v11.36):** The CH-15 slot was given a **brand-new
> premium renderer** and **renamed "Gem Vault" → "Royal Riches"** (player-facing
> only). The internal channel id (**15**) and key (**`slots3d`**) are unchanged,
> the provably-fair math (`slots3d-engine.js`) and the host-bridge API are
> byte-for-byte identical — only `public/slots3d.js` (visuals) and the displayed
> name/emoji changed. New name + 👑 emoji live in `index.html` + `app.js`
> (search `Royal Riches`). The new renderer uses a procedural PMREM env-mapped
> gold cabinet + baked 512px faceted-gem symbols; no full-screen bloom (keeps
> symbols crisp). Preview harness: `public/_gemvault_preview.html`.

> **Security note:** No passwords, private keys, or secrets are stored in this repo
> (and must never be). "Access" below describes *how* access works, not credentials.
> Anything secret (e.g. a house signer key) lives only in the Render dashboard env,
> set by the human owner.

---

## 1. What this is
"Crypto TV" — a retro-TV themed, multi-game crypto betting dApp. A single TV screen
switches between game "channels". Games run in two modes:
- **DEMO** (play-money, no wallet) — the default; a local `demoUsd` balance.
- **REAL** (Sepolia testnet ETH) — when a wallet (MetaMask) is connected.

It is a **vanilla-JS site with NO build step** (no webpack/vite). Files in `public/`
are served as-is by a small Node server. Edit a file → bump the version → deploy.

**Live site:** https://tv-crypto-flip.onrender.com

---

## 2. Repo, branch, access
- **GitHub repo:** `goldexchangev-hash/yachtbazar-data` → https://github.com/goldexchangev-hash/yachtbazar-data
- **Active dev branch (everything lives here, Render deploys this):**
  `claude/ethereum-betting-game-vrf-2dq50k`
- **Owner account:** GitHub `goldexchangev-hash` (email goldexchangev@gmail.com).
- **How GitHub is accessed by the AI:** via the GitHub MCP integration, scoped to
  repos `goldexchangev-hash/yachtbazar-data`, `…/yachtbazar`, `…/chillpod`.
  `git push` goes through a local proxy remote — just `git push -u origin <branch>`.
- **Login/passwords:** not held by the AI and not in this repo. The human owner logs
  into GitHub and Render with their own credentials.

---

## 3. Deploy (Render) — how it ships
- Defined in `render.yaml` (Blueprint). Service **`tv-crypto-flip`**:
  - `runtime: node`, `plan: free`, `branch: claude/ethereum-betting-game-vrf-2dq50k`
  - `buildCommand: npm install --omit=dev`
  - `startCommand: node server/server.js`
  - env: `NODE_VERSION=20`
- **Render auto-deploys on every push to that branch.** There is deploy lag (a few
  minutes) + browser/service-worker caching, so a change isn't instant for users.
- The owner manages the Render service in their own Render dashboard (the AI cannot
  log into Render). If real-money blackjack is ever turned on, its signer key is set
  as a Render **environment variable** (e.g. `BLACKJACK_SIGNER_KEY`) — never in code.

---

## 4. ⚠️ Versioning convention (DO THIS ON EVERY USER-FACING CHANGE)
Cache-busting is manual and **must** be bumped or users keep the old build. Current =
**v11.37 / v=1137 / ctf-v11.37**. To ship `v11.38`:
1. `public/index.html` — bump every `?v=1137` → `?v=1138` (≈14 occurrences) AND the
   two build-tag chips `>v11.37<` → `>v11.38<` (brand tag + the mobile pill by ☰).
2. `public/app.js` — bump `coinflip3d.js?v=1137`, the blackjack iframe
   `blackjack.html?tv=1&v=1137`, AND `slots3d.js?v=`+`fishtable*.js?v=` (currently `1137`) → `…1138`.
   ⚠️ `slots3d.js` has its OWN version (was `1109`, now `1136`) — bump it whenever
   you change the slot renderer, or users keep the stale build.
3. `public/sw.js` — bump `const CACHE = "ctf-v11.37"` → `"ctf-v11.38"`.
- Quick recipe (sed): `sed -i 's/v=1137/v=1138/g' public/index.html`,
  `sed -i 's/>v11.37</>v11.38</g' public/index.html`, plus the app.js + sw.js lines.
- The service worker (`sw.js`) is network-first for HTML, cache-first for `?v=`/`/vendor/`
  assets, and calls `skipWaiting()`+`clients.claim()` so updates apply on next load.
- **Server-only changes** (e.g. `server/blackjack-server.js`) do NOT need a version
  bump (the server isn't cached) — but the user still benefits from a redeploy.

**Commit message footer used throughout** (keep it consistent):
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WXBP6SbFfnkNE8eqQGGJCn
```

---

## 5. Architecture
- **Server:** `server/server.js` — Express static host for `public/` + a `ws` WebSocket
  server (live chat, active-player presence, and the blackjack sub-protocol). Runs on
  `PORT` (default 3000).
- **Blackjack engine:** `server/blackjack-server.js` — server-authoritative multiplayer
  engine, attached to the same ws server (`attachBlackjack({ startBalance: 1000, … })`).
  Routes any `bj:*` message. This is the only writer of blackjack balances.
- **Frontend:** `public/` vanilla-JS IIFE modules. Key libs: **ethers.js v6**,
  **Three.js r128** (UMD global, in `public/vendor/`).
- **Smart contract:** `contracts/CoinFlipBetting.sol` (Hardhat project; `npm run
  compile`, deploy scripts in `scripts/`). Frontend reads ABI/bytecode from
  `public/contract.js` (auto-generated by `scripts/exportArtifact.js`).

### TV channels (`GAME_CHANNEL` in app.js)
flip **8**, dice (0-100) **9**, twodice **10**, crash **11**, slots **12**,
pressure/Balloon Pop **13**, plane **14**, blackjack **16**, fish/Reef Raiders **17**.
slots3d/Gem Vault **15**, blackjack **16**, fish/Reef Raiders **17**.
(Poker is a separate full-width view, not a TV channel.)

### On-chain config (`public/config.js`, Sepolia chainId 11155111)
- Game contract `address`: `0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc`
- Registry (lets owner hot-swap the live contract on-chain): `0x21Fc88619753254D2Cd5D74A2102D4A876fc1Fa1`
- Treasury: `0x2F4BEF94550C29c497b999B86b758F9771F7aB39`
- Default RPC: `https://rpc.sepolia.org`; faucet recommended to users: https://sepolia-faucet.pk910.de/#/

---

## 6. Key files (public/)
- `app.js` — **the brain.** Wallet/chain, demo money (`demoUsd`), every game's bet
  handlers (`demoFlip/demoDice/demoCrash/…`, real `doPlay*`), `switchGame`/
  `paintGameTabs`, the blackjack dock bridge, the floating bet bar, `reconcile()` (TV
  reveal reconciler for real rounds). Large file — grep for the function you need.
- `tv.js` — the TV screen: channel switching, idle states, `startFlip`/`revealResult`/
  `_doReveal` (coin reveal pipeline), result overlay.
- `coinflip3d.js` — the 3D coin (Three.js): toss → hang → aligned edge-on drop →
  last-second flat reveal → landed hold.
- `dice3d.js` (0-100 tachometer/rail), `dice2-3d.js`, `crash-render.js`/`crash-engine.js`,
  `slots*.js`, `plane-*.js`, `pressure*.js`, `poker-*.js` — per-game UIs/engines.
- `blackjack-ui.js` / `blackjack-net.js` / `blackjack-rules.js` / `blackjack-shuffle.js`
  / `blackjack.html` (felt iframe) / `blackjack.css` — the blackjack felt client.
- `sw.js` (service worker), `config.js` (on-chain config), `contract.js` (ABI+bytecode).

### Blackjack integration model (important)
- The felt runs in an **isolated iframe** (`blackjack.html?tv=1&…`) inside the TV.
- Betting/action **controls are native site elements** in a dock under the TV
  (`#bj-dock` in index.html, built in app.js), bridged to the felt by **postMessage**:
  `bj:cmd` (intents in: setBet/placeBet/cancelBet/topUp/action/insurance),
  `bj:dock` (state out), `bj:seed`, `bj:ready`, `bj:wallet`.
- Blackjack uses a **standalone play-money balance** per guest wallet held by the server
  (default $1000), **decoupled** from the site `demoUsd`. Guests get a persistent
  `guest:xxxx` id (localStorage `bj_guest`). The dock shows the table wallet + balance;
  `⟳ Reload` tops it back to $1000; mid-hand `TOP UP` funds a double/split.
- Shareable tables via `?bjtable=<roomId>`; reconnect grace holds your seat 45s on an
  app-switch.

---

## 7. Local run + testing
- **Run server:** from repo root, `PORT=3000 node server/server.js` (it dies on container
  restarts — just relaunch). `pkill -f server/server.js` to stop. Note: launching it as a
  background task can land in the wrong cwd — use an **absolute path**:
  `cd /home/user/yachtbazar-data && PORT=3000 node /home/user/yachtbazar-data/server/server.js`.
- **Headless browser tests:** Playwright is available. Use the pre-installed Chromium:
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`,
  `args: ['--use-gl=swiftshader','--no-sandbox']`, `NODE_PATH=…/node_modules`.
  Hit `http://localhost:3000`. For a mobile test use `viewport:{width:390,height:760}, isMobile:true`.
- **Blackjack server tests:** raw `ws` client. Protocol: send `{type:"hello",address:"guest:x"}`
  first (stamps the wallet), then `bj:lobby:subscribe`, `bj:seed {balance}`, `bj:room:join`,
  `bj:bet:place {amountUsd}`, `bj:action {action}`, `bj:topup {amount}`, `bj:insurance {take}`.
  Snapshots arrive as `bj:room:snapshot`; turns as `bj:turn`; balance as `bj:wallet`; payouts
  as `bj:settle`. **If a test needs an isolated server, use a different port (e.g. 3201) so it
  doesn't fight the main one.**
- Useful debug globals exposed on the page: `window.__coin3d` (the coin), `TV` (the screen),
  `window.BJ` (blackjack client inside the iframe).

---

## 8. Conventions / gotchas
- **No build step** — never add one; edit `public/` files directly.
- **Always bump the version** (Section 4) for any change to a cached asset, or users keep
  the stale build. The build-version pill by the ☰ menu is the quick "did my deploy land?"
  check.
- Demo games read `demoUsd` live each play; `demoReset()` (Reset credits) re-seeds the
  per-game engines that hold their own balance (pressure/plane/slots3d).
- The floating bet bar (mobile) **drives the real per-game stake slider** via `input`
  events — it never reimplements game logic. Games that change stake/range programmatically
  are kept in sync by a poll in `wireBetbar`.
- House fee is **3%** (`HOUSE_FEE_BPS=300`); `flipReveal()`/`breakdown()` must agree.

---

## 9. Open / parked work
- **#14 Real-money blackjack ("step 3") — PARKED at owner's request.** The contract
  foundation is committed but **inert**: `contracts/CoinFlipBetting.sol` has
  `blackjackSigner`, `blackjackBuyIn`, `settleBlackjack` (house-signed EIP-191 settlement),
  `setBlackjackSigner`. To turn it on, the owner must: (a) redeploy the contract, (b)
  generate a house signer key + set it as a Render env var (e.g. `BLACKJACK_SIGNER_KEY`),
  (c) call `setBlackjackSigner`, then (d) wire the server signer + felt real-ETH buy-in +
  signature auth. The blackjack TOP-UP UI already has a hook where the MetaMask buy-in
  slots in. Do NOT build this unless the owner says go.
- **Slots jackpot cap (contract, low):** `playSlots` *caps* a payout instead of *reverting*
  when the house bankroll is too low (other games revert). Under-pays a rare jackpot vs the
  displayed win. Needs a contract change + redeploy — bundle with the real-money pass.
- A couple of latent/low coin-flip + bet-bar edge cases were reviewed and deemed not
  currently reachable (documented in commit history v11.35).

---

## 10. Recent history (most recent first)
- **v11.37 — NEW GAME "Reef Raiders" (CH 17, key `fish`) shipped LIVE** (demo). PixiJS
  arcade fish-shooter: aim cannon, shoot fish, catch for coins; ~90% RTP engine
  (`fishtable-engine.js`), specials (bomb AoE, eel chain, gold/boss), progressive
  jackpot, autofire + target-lock + power 1–7, **fullscreen**. Two bonus rounds:
  Gold Crab → Treasure Chest, Treasure Clam → Feeding Frenzy. Built from 4 research
  agents' specs. Real-money parked. Files `fishtable.js`/`fishtable-engine.js`;
  preview `_reef_preview.html`.
- **v11.36 — CH-15 slot RENAMED "Gem Vault" → "Royal Riches" + brand-new premium
  renderer** (`public/slots3d.js` fully replaced). Procedural PMREM env-mapped ornate
  gold cabinet, baked 512px faceted-gem symbols (sparkle/glint/caustic), gold-ingot BAR,
  amethyst WILD shield, vault-dial scatter, perimeter chase light, ring bursts. No
  full-screen bloom (symbols stay crisp). Channel id 15 + key `slots3d` + engine math
  unchanged. Preview: `public/_gemvault_preview.html`. `slots3d.js?v=` bumped 1109→1136.
- v11.35 — bug-hunt fixes: coin shows the *result* face on channel-leave-while-pending;
  re-bet-during-hold gated; floating bet-bar range mirrors live slider (Balloon Pop max).
- (server) blackjack: one seat per wallet across tables; mid-hand top-up re-arms turn clock.
- v11.34 — house fee display 10%→3%; keyboard stepper on plane/slots3d; reveal re-sync on tab focus.
- v11.30–v11.33 — blackjack mid-hand TOP UP; **floating mobile bet bar** (+ draggable slider, dock-height fix).
- v11.22–v11.29 — coin flip rework (edge-on descent → last-second reveal, no fake-out/freeze; PICK→LANDED line).
- v11.23 — blackjack decoupled into its own standalone server balance + wallet + Reload.
- (full detail in `git log`.)
