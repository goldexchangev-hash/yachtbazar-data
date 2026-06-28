# START HERE — Onboarding for a new AI (Crypto TV)

> Hand this whole file to a fresh Claude (or any AI) to get fully up to speed on this
> project and continue exactly where the last session left off. The durable parts (access,
> deploy, channel map, contract model, math invariants, house rules) stay true; for the
> fast-moving state (current build #, real-money progress, recent work) **`HANDOFF.md`'s
> top "NOTE FOR …" entries are the live source of truth** — read them after this.
>
> ⚠️ **Two AIs ship this repo in parallel and the OTHER one is very active** — the branch
> moved from v11.51 to **v11.73** in a short window (a real-money Blackjack bridge + many bug
> hunts). **`git pull` before you start**, and re-pull often; expect your local snapshot to
> be behind.

---

## 0. First moves (do these before anything else)

1. **Read the two living specs** in the repo root:
   - `HANDOFF.md` — the master, site-wide project handoff (architecture, access, deploy,
     versioning, the channel map, parked work). Has a stack of dated "NOTE FOR CLAUDE/CHATGPT"
     entries at the top — read them.
   - `REEF-RAIDERS.md` — the full living spec for the Reef Raiders fish game (CH 17). Its
     **§0 "House rules for ANY AI"** applies to the WHOLE site, not just Reef.
2. **Follow the house rules** (summarized in §9 below) on every change: bump the build
   version, update the docs + changelog, leave a note for the other AI, protect the house
   edge (re-simulate RTP after any payout change), test before pushing, keep secrets out of
   the repo.
3. **Two AIs work this repo in parallel** — Claude (me) and the owner's ChatGPT/Codex.
   Always leave a "NOTE FOR ..." in `HANDOFF.md` so you don't undo each other. (Example this
   session: ChatGPT disabled then re-enabled a channel; I restored its artwork — see §6.)

---

## 1. What this project is

**"Crypto TV"** (a.k.a. Crypto TV Flip) — a retro-TV-themed, multi-game crypto **betting
dApp** on the **Sepolia testnet**. One TV screen switches between game "channels."

- **Vanilla JS, NO build step.** Files in `public/` are served as-is by a small Node server.
  Workflow = edit a file → **bump the cache version** → commit → push → Render auto-deploys.
- ethers.js v6, Three.js (r128) for 3D games, PixiJS v7 (vendored) for 2D/arcade games. No
  CDN at runtime — everything is vendored under `public/vendor/`.
- Two money modes: **DEMO** (local play-money `demoUsd`, no wallet) and **REAL** (Sepolia ETH
  via MetaMask), depending on the game.

**Live site:** https://tv-crypto-flip.onrender.com

---

## 2. Access, repo, deploy (how to ship)

| Thing | Value |
|---|---|
| **GitHub repo** | `goldexchangev-hash/yachtbazar-data` |
| **Active branch (everything lives here; Render deploys it)** | `claude/ethereum-betting-game-vrf-2dq50k` |
| **Owner** | GitHub `goldexchangev-hash` (goldexchangev@gmail.com) |
| **Render service** | `tv-crypto-flip` (web, node, free plan) |
| **Render build / start** | `npm install --omit=dev` / `node server/server.js`, `NODE_VERSION=20` |
| **Auto-deploy** | ON — every push to the branch above triggers a Render deploy (a few min lag + browser/SW cache) |

- **How the AI pushes:** `git push -u origin claude/ethereum-betting-game-vrf-2dq50k`
  (goes through a local proxy remote). GitHub is reachable via the GitHub MCP tools, scoped
  to `goldexchangev-hash/yachtbazar-data` (+ `…/yachtbazar`, `…/chillpod`).
- **Render dashboard is OWNER-managed** — the AI cannot log into Render. Anything secret
  (e.g. a house signer key) is set by the owner as a Render **environment variable**, never
  in code. **Do NOT create a PR unless the owner asks.**
- **Server** (`server/server.js`): Express serves `public/`, `GET /api/info` health check,
  SPA fallback to `index.html`, and a `ws` WebSocketServer (active-players + chat) that also
  hosts multiplayer Blackjack (`server/blackjack-server.js`). Port = `process.env.PORT || 3000`.

### Local run + headless testing
- Run server: `cd /home/user/yachtbazar-data && PORT=3000 node server/server.js`
  (`pkill -f server/server.js` to stop; it dies on container restarts — just relaunch).
- Playwright (Chromium pre-installed, no internet needed):
  `NODE_PATH=/home/user/yachtbazar-data/node_modules node <script>.js`, browser
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`,
  `args: ['--use-gl=swiftshader','--no-sandbox']`, hit `http://localhost:3000`.
- Debug globals on the page: `TV` (the screen), `window.__fish` (live FishTable —
  `__fish._fire()`, `__fish.balance`), `window.__coin3d`, `window.BJ` (blackjack iframe client).

---

## 3. The games (channel map)

Source of truth: `GAME_CHANNEL` / `GAME_TITLE` / `GAME_ORDER` in `public/app.js` (~line 2758).

| CH | key | Name | Renderer / file | Tech | Money | On-chain fn |
|----|-----|------|-----------------|------|-------|-------------|
| 8 | `flip` | Coin Flip | `coinflip3d.js` (+`tv.js`) | 3D coin | Real + demo | `playHouse` / `playHostRoom` |
| 9 | `dice` | 0-100 | `dice3d.js` (+`tv.js`) | 3D rail | Real + demo | `playDice` |
| 10 | `twodice` | Dice #2 | `dice2-3d.js` (+`tv.js`) | 3D dice | Real + demo | `playTwoDice` |
| 11 | `crash` | Crash | `crash-render.js` / `crash-engine.js` | 2D canvas | Real + demo | `playCrash` |
| 12 | `slots` | Crypto Reels | `slots.js` (+Pixi) | 2D slot | Real + demo | `playSlots` |
| 13 | `pressure` | Balloon Pop | `pressure-*.js` / `pressure-engine.js` | 2D+3D | **Demo only** | none |
| 14 | `plane` | Plane | `plane-*.js` / `plane-engine.js` | 2D canvas | Demo; **real when connected** | `playCrash` (shares the audited crash path) |
| 15 | `slots3d` | **Gem Vault** | `slots3d.js` / `slots3d-engine.js` (+Three) | 3D slot | **Demo only** | none |
| 16 | `blackjack` | Blackjack | `blackjack.html` iframe + `blackjack-server.js` | iframe | Server play-money ($1,000 chips) | none (server-settled) |
| 17 | `fish` | **Reef Raiders** | `fishtable.js` / `fishtable-engine.js` (+Pixi) | 2D arcade | **Demo only** | none |
| — | `poker` | Poker | `poker-ui.js` / `poker-engine.js` | DOM view | Demo | none — **hidden/disabled** |

**Real on-chain (bet from the deposited balance):** Coin Flip, 0-100, Dice #2, Crash, Crypto
Reels, and Plane-when-connected. **Play-money only:** Balloon Pop, Gem Vault, Reef Raiders,
Blackjack (own server chip balance), Poker. Poker is currently hidden.

---

## 4. Contract & money model (Sepolia)

- **Contract:** `CoinFlipBetting.sol` (Solidity 0.8.24). `owner = deployer`, `treasury` =
  fee recipient / house wallet (default `0x2F4BEF94550C29c497b999B86b758F9771F7aB39`).
- **Live config** (`public/config.js` → `window.COINFLIP_CONFIG`):
  - deployed `address` = `0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc`, `chainId` 11155111,
    `registry` = `0x21Fc88619753254D2Cd5D74A2102D4A876fc1Fa1`.
  - The frontend resolves the LIVE contract from `registry.activeGame()` on load (the owner
    can flip the whole site to a new contract with one `setActiveGame` tx — no code push);
    `address` is the fallback. ABI/bytecode come from `public/contract.js`.
- **Deposit-balance model:** `deposit()` / `withdraw()` / `withdrawAll()`, `balances[addr]`.
  The per-bet games bet straight from `balances`. House liquidity = `houseBankroll`
  (`fundHouse()` / `withdrawHouse()`, owner only).
- **House edges (all owner-tunable except the flip fee):** flip `HOUSE_FEE_BPS=300` (3%),
  `diceEdgeBps=200` (2%), `twoDiceEdgeBps=200` (2%), `crashEdgeBps=100` (1%), slots ~90% RTP
  (weighted symbol table). `maxBet=1 ETH`, crash multiplier 1.01×–1000×, single-win profit
  capped at `maxPayoutBpsOfBankroll` (default 100% of bankroll). Setters: `setDiceEdge`,
  `setTwoDiceEdge`, `setCrashEdge` (≤10% cap), `setMaxBet`, `setMaxPayoutCap`.
- **Generic off-chain settlement** (reused by ALL off-chain games, not just blackjack):
  `setBlackjackSigner(addr)` (owner), `blackjackBuyIn(amount)` (locks credits from
  `balances`), `settleBlackjack(player, net, nonce, sig)` where the signature is over
  `keccak256(abi.encodePacked(player, int256 net, nonce, block.chainid, address(this)))` +
  EIP-191. "A player can never lose more than they locked." The server signer lives in
  `server/realmoney.js` (reads `HOUSE_SIGNER_KEY`, falls back to `BLACKJACK_SIGNER_KEY`).

### Real-money credits status — BUILT (Blackjack bridge), gated OFF behind env flags
> This advanced a lot recently. Treat **`HANDOFF.md`'s NOTE entries (v11.6x–v11.73)** as
> authoritative — they document the bridge hardening pass-by-pass. Summary:

The owner wants real-money credits (deposit → buy-in → play → cash-out) for the off-chain
games. The **Blackjack real-money bridge is built** in `server/bridge-server.js` (+
`server/realmoney.js` signer), reusing the contract's generic `blackjackBuyIn` /
`settleBlackjack`. It is **deliberately DISABLED until every piece is configured** — see
`bridgeEnabled()` in `bridge-server.js`: requires `realmoney.enabled()` **AND**
`ENABLE_EXPERIMENTAL_BRIDGE=1` **AND** durable state (`BRIDGE_STATE_FILE`). It also needs a
Sepolia RPC and the deployed contract to actually expose the credits functions (the bridge
verifies on-chain `bjLocked(player)` against the emitted buy-in). Endpoints:
`GET /api/bridge/status` (reports readiness, chain-aware via `?chainId=`),
`POST /api/bridge/blackjack/start`, `POST /api/bridge/blackjack/settle`.

**To go live (owner actions; check `/api/bridge/status` for what's still missing):**
1. Ensure the **deployed contract exposes** `blackjackBuyIn`/`settleBlackjack`. The source +
   regenerated `public/contract.js` ABI have them. The contract was **size-tuned** (`viaIR`,
   optimizer runs:1, no metadata hash) to fit under EIP-170 (~20 KB). If the LIVE contract
   (config.js `0xD7E584…` / the registry's `activeGame`) lacks them, redeploy via Host tools
   "🔄 Start a fresh game" (MetaMask) or `npm run deploy:sepolia`, then update `config.js`
   address or `registry.setActiveGame(newAddr)`, and `fundHouse`.
2. `setBlackjackSigner(serverSignerAddr)` on-chain (owner), and set **Render env**:
   `HOUSE_SIGNER_KEY`, `ENABLE_EXPERIMENTAL_BRIDGE=1`, `BRIDGE_STATE_FILE`, `SEPOLIA_RPC_URL`,
   optional `BRIDGE_ETH_USD` (credit pricing, default 3400). Runbook: `REALMONEY-SETUP.md`.
3. The **arcade games (Reef, Gem Vault, Balloon Pop) are still play-money** — only Blackjack
   has the real-money bridge so far. **Owner decision on record: leave Crash & Plane edges at 1%.**

---

## 5. Reef Raiders — money math & the bugs that must never come back

(Full detail in `REEF-RAIDERS.md`.) `fishtable-engine.js` + `fishtable.js`, CH 17, demo only.

- **Kill RTP = 85%:** `p_kill = clamp(power*RTP/mult, P_MIN, P_MAX)` with **`RTP=0.85,
  P_MIN=0.005, P_MAX=0.9`**. `P_MIN` MUST stay below `0.85/160 = 0.0053` — a flat 0.02 floor
  used to make the Kraken pay 320% / Gold Shark 160% (farmable). Don't raise it.
- **Progressive jackpot is self-budgeting:** 5% of each paid shot accrues to a pool; the
  meter pays out exactly that pool. (Old code handed a free 300–900× every ~83 catches.)
- **Frenzy** = free shots, **capped at 25× bet**; **chest** prize pool `[1,1,2,2,3,3,5,5,8,10,15]`.
- **Bonus/special fish are priced into the odds** (added ~v11.56, `budgetMult(def,power)`):
  chest/frenzy add ~25× expected bonus budget, bomb/eel add splash budget. **`resolveHit` must
  get the full `fish.def`, not just `fish.def.mult`** — otherwise lock-on/special farming goes
  player-positive again. (See REEF-RAIDERS.md §4, the live source.)
- **Realized RTP ≈ 93–95%** (85% kills + jackpot/chest/frenzy on top); ~5–7% house edge.
  Engine-only sims were ~89.9–90.7%. **Re-simulate after any payout change** (§9).
- **Safety invariants that were real bugs — never regress:**
  1. **Frenzy must end at EXACTLY 0** (a tiny positive re-pins it every frame → stuck free
     shots / auto-fire that can't be stopped — the actual live bug we fixed).
  2. **`_holding` clears** on `mouseup/touchend/touchcancel/pointercancel/blur/visibilitychange`,
     and `toggleAuto` force-clears it (Auto button = reliable stop).
  3. **`setActive(false)` runs `_forceEndBonuses()`** (clears frenzy, tears down chest/jackpot)
     so leaving the channel can't strand firing disabled.
  4. **Shots never expire** — they ricochet off all walls until they catch a fish (38-bullet
     FIFO cap bounds memory).
  5. **Fullscreen reparents `#layer-fish` to `<body>`** so one CSS rule
     (`body.rr-fs-on > *:not(#layer-fish){display:none}`) hides ALL chrome (the landscape
     side-menu, ETH ticker, Share-win button) in every orientation.
- Five **loading/reveal guards** prevent the "stuck on loading" bug (page-load restore branch
  for `fish`, watchdog in `ensureFishReady`, promo-end re-kick, `changeChannel(17)` case,
  `setConnected` fish refresh).

---

## 6. The Gem Vault situation (don't undo this)

- CH-15 (`slots3d`) was historically **Gem Vault** (neon Three.js slot:
  cherry/bell/star/7/BAR/diamond/WILD/vault). A reskin renamed it **"Royal Riches"** (gold
  vault-dials / ruby cherries / amethyst WILD), changing ONLY `slots3d.js` + the name/emoji.
- ChatGPT disabled the channel, then re-enabled it as "Gem Vault" — but kept the **Royal
  Riches artwork**. **v11.51 restored the ORIGINAL Gem Vault renderer** (`slots3d.js` from
  commit `f1945b4`) + the 💎 emoji. The engine/channel/key are unchanged.
- **Do NOT swap back to the Royal Riches renderer without owner approval.** It's preserved in
  git history (commits `c2c6b31`..`180d11d`) if ever wanted.

---

## 7. Game-math audit & risk-of-ruin (analysis done this session)

- **House edge per game (all verified house-favored, no +EV exploit, bankroll-drain
  protected):** Coin Flip / Dice 3%, **Crash 1%** (flat across all targets), **Balloon Pop
  3%**, **Plane 1% real / 3% demo**, **Reef ~5–7%**. The house never loses long-term on any.
- **Risk of Ruin** (the analysis name; Monte Carlo + the analytic Lundberg coefficient were
  both used): the bankroll the house needs is driven by **variance ÷ edge**, scales **linearly
  with bet**. Rough rule for Reef-like variance: **~1,700× the bet for ~1% ruin** (e.g. $5/shot
  → ~$8.5k; $50/shot → ~$85k). For lower risk, ×1.5 → 0.1%.
- **Multiple simultaneous players do NOT multiply the bankroll** — more players add variance
  AND edge equally, so the required bankroll for a given ruin% is unchanged (they just reach
  the long run faster). One **shared** house bank covers everything; you do **not** sum
  per-game or per-player requirements. The only extra consideration is instant liquidity to
  cover a few simultaneous max-payouts (the ruin bankroll already covers that).

---

## 8. What changed recently / open work

**The running list lives in `HANDOFF.md`'s NOTE entries — read them; this is just orientation.**
Big themes recently (v11.52→v11.73, mostly the other AI): the **Blackjack real-money bridge**
(`server/bridge-server.js`: signed buy-in/settle, durable state, wallet auth via MetaMask
signature, per-wallet serialization, on-chain `bjLocked` verification, restart recovery) and
many whole-site bug-hunt passes (mobile top-bar, demo-balance hiding after connect, zero-balance
bet guards, Reef bonus pricing `budgetMult`, etc.). Earlier (this AI): v11.51 restore original
Gem Vault art, v11.46 Reef bug-hunt (stuck frenzy / input / reparent fullscreen), v11.45 Reef
10%-edge math, v11.44 transfer-confirm modal (`#xfer-modal`), v11.43 shots-never-expire.

**Open / next:**
- **Real-money credits** — Blackjack bridge built; to ACTIVATE see §4 (owner sets the Render
  env flags + on-chain signer/redeploy; check `/api/bridge/status`). Extending real-money to
  the arcade games (Reef/Gem Vault/Balloon) is not done.
- Low-priority: a slots jackpot-cap contract tweak to bundle with any redeploy (noted in HANDOFF).
- Reef art/animation overhaul (multi-part sprites) — researched, not built.

**Current state at this snapshot:** **build v11.73** (the other AI ships fast — re-pull and
trust `HANDOFF.md` over this number). Branch in sync after the pull that added this file.

---

## 9. House rules (apply to EVERY change, every game)

1. **Bump the build version** — `public/index.html` (~14 `?v=NNNN` + both `>v11.XX<` chips),
   `public/app.js` (the lazy-loader `?v=` strings incl. `slots3d.js?v=`, `fishtable.js?v=`,
   `fishtable-engine.js?v=`), `public/sw.js` (`ctf-v11.XX`). Stale caches are the #1
   "it didn't update" cause. (Server-only changes don't need a bump.) Quick recipe (example
   1173 → 1174): `sed -i 's/1173/1174/g' public/index.html public/app.js`,
   `sed -i 's/>v11.73</>v11.74</g' public/index.html`, `sed -i 's/ctf-v11\.73/ctf-v11.74/' public/sw.js`.
2. **Update the docs** — the relevant game spec + `HANDOFF.md` (its "Last updated" line +
   changelog). Create a new `*-HANDOFF.md` for any game you do non-trivial work on that lacks
   one (Overview → Files → Wiring → Math → Mechanics → Loading → Versioning → Changelog).
3. **Leave a "NOTE FOR CHATGPT/CLAUDE (vNN.NN)"** so the other AI doesn't undo/duplicate.
4. **Protect the house edge** — it's a casino. After ANY payout/odds/RNG change, re-simulate
   the RTP and confirm < 100% (player net-negative long-term). Never reintroduce a fixed bug.
5. **Test before pushing** — headless-test, confirm no console errors.
6. **Secrets stay out of the repo** — `HOUSE_SIGNER_KEY` / `PRIVATE_KEY` / the model
   identifier live only in Render env or a local `.env`.
7. **Commit message footer:**
   ```
   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01WXBP6SbFfnkNE8eqQGGJCn
   ```
8. **No PRs unless the owner asks.** Don't push to other branches.

---

*Generated as a session handoff. If anything here disagrees with the code, the code wins —
re-verify and update this file (and HANDOFF.md) so the next AI isn't misled.*
