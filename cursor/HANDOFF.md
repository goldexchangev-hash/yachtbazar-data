# Crypto TV — Project Handoff for Cursor (new AI)

> Written 2026-06-30 by the previous AI assistant (Claude). Read this top-to-bottom before touching anything.
> **Live version: v12.43.** This is a real crypto-betting dApp on **Sepolia testnet** with real (testnet) ETH
> flowing through it — treat every change to the money path as production code.

---

## 0. WHERE EVERYTHING IS (exact locations)

| What | Where |
|---|---|
| **GitHub repo** | `https://github.com/goldexchangev-hash/yachtbazar-data` |
| **Branch (the ONLY one that matters / auto-deploys)** | `claude/ethereum-betting-game-vrf-2dq50k` |
| **Local working copy (Windows)** | `C:\Users\golde\crypto-tv-live` |
| **Live site (auto-deployed)** | `https://tv-crypto-flip.onrender.com` |
| **Host** | Render.com (Starter plan, $7/mo — needed for the persistent disk) |
| **Chain** | Ethereum **Sepolia** testnet (chainId `11155111`) |
| **Smart contract** | `contracts/CoinFlipBetting.sol` (deployed on Sepolia; address is read at runtime from the contract registry / `?contract=` param, not hard-coded) |

> ⚠️ The repo is **named `yachtbazar-data`** for historical reasons but this branch is the **Crypto TV game**, a
> completely separate project from the yacht marketplace. Don't be confused by the repo name.

### How deploy works (CRITICAL to understand)
- **There is no build step and no CI.** It's vanilla JS served statically + a Node server.
- **`git push origin claude/ethereum-betting-game-vrf-2dq50k` → Render auto-rebuilds and redeploys.** That's the
  entire deploy. (Render watches that branch.)
- After pushing, **confirm the deploy landed** by polling the live service-worker cache tag:
  `curl -s https://tv-crypto-flip.onrender.com/sw.js | grep ctf-v12.NN` — when it shows your new version, it's live.
- A redeploy takes ~1–3 minutes and **restarts the Node process** (in-memory state is lost unless persisted to disk).

---

## 1. WHAT THIS PROJECT IS

A retro-TV-themed crypto casino. The UI is a red CRT television; each "channel" (CH 8, CH 11, CH 16, CH 19, …) is
a different game. Players connect MetaMask, deposit Sepolia ETH, and play. Two money modes:

- **Demo mode** (no wallet): play-money, client-side RNG, just for fun.
- **Token mode** (the real-money path): deposit ETH → it becomes **tokens** (1 token ≈ $1) → play every game with
  those tokens off-chain (no per-bet MetaMask popups) → cash out once. This is the important, audited path.

### The games (channels)
| CH | Game | Engine / notes |
|---|---|---|
| 8 | Coin Flip | discrete, `server/games/coinflip.js` |
| 9 | 0–100 Dice | `server/games/dice.js` |
| 10 | Dice #2 | `server/games/dice2.js` |
| 11 | Crash (rocket) | `server/games/crash.js` + live ws round-runner |
| 13 | Balloon Pop (a.k.a. "pressure") | `server/games/pressure.js`, hold-to-pump crash variant |
| 14 | Plane (Aviator) | crash mechanic, two simultaneous bets A/B |
| 15 | Gem Vault 3D (slots3d) | Three.js 3D slot |
| 16 | **Blackjack** | multiplayer 4-seat tables, `server/blackjack-server.js` (see §4 — most complex) |
| 17 | Reef Raiders | PixiJS fish-table, `server/games/reef.js` |
| 18 | Sky Swoop | crash mechanic, PlayCanvas biplane |
| 19 | Fish Shooter | PixiJS fish-table, own engine `public/fishshooter-engine.js` |

---

## 2. THE MONEY MODEL (read this before changing anything financial)

Everything financial flows through **the token bridge**. The on-chain contract has a per-player accumulator
`bjLocked[player]` and two functions used as the deposit/settle rails:
- `blackjackBuyIn(amount)` — moves the player's `balances[player]` (their deposited "game credits") into
  `bjLocked[player]` (locked). The server then grants off-chain **tokens** equal to that USD value.
- `settleBlackjack(player, net, nonce, sig)` — the **house signs** a net P&L; the player submits it; the contract
  **zeros `bjLocked` and returns `locked + net`** to `balances`. `net` is floored so a player can't lose more than
  they locked, and the tx reverts if a win exceeds the house bankroll.

**Server side** (`server/token-bridge.js` + `server/token-http.js`):
- A **session** = `{ player, tokens, buyInUnits, lockedWei, serverSeed, commit, bets[], settleNonce }`.
- `play()` debits a bet, runs the game's deterministic engine over a committed seed, credits the payout, records a
  **re-derivable** bet (provably fair — anyone can replay the seed and verify every bet after the seed is revealed).
- `settle()` signs `net = tokens − buyInUnits`, pinned to `lockedWei`, and reveals the seed.
- **ONE open token session per player** (`openByPlayer`), enforced.

**THE HARDENED "RECOVER" PATH** (this took 3 adversarial review rounds — do not weaken it):
- `doRelease()` in `token-http.js` is the "Recover stuck funds" path. It either (1) settles an open session, (2)
  re-issues a persisted **obligation** (the same signed settlement, so a player who settled a loss off-chain and
  withheld the broadcast can't then recover a fresh `net=0` and escape the loss), or (3) does a `net=0` orphan
  release. A per-player **mutex** (`withPlayerLock`) serializes settle/release. See `cursor/AUDIT-NOTES.md` and the
  git history for `v12.34`.

**Client side**: `public/token-mode.js` (UI) + `public/token-client.js` (signing/HTTP, byte-identical auth message
to the server). `public/app.js` is the giant (~5000-line) main controller that wires every channel.

---

## 3. RECENT CHANGES (v12.33 → v12.37, newest first)

| Ver | What |
|---|---|
| **v12.43** | **Blackjack table segregation** — real-money (token/bridge) players never share a table/shoe with demo/guest players (they share one provably-fair shoe, so others' hit/stand changes your cards). Rooms tagged `kind` real/demo; `openRoom(kind)` + share-link redirect. Adversarially reviewed. |
| **v12.40–12.42** | Blackjack felt self-heal (it loaded as a guest before the wallet connected → re-inits to the token session); "Lock credits" no longer hits the dead bridge for token players; top token bar live-syncs from the server while at a token table; hid the redundant `guest:… / $X tokens` row under the TV. |
| **v12.39** | Fixed the CH16 bug below — the felt now reliably binds to the token session (the token session was in the iframe's #hash, which doesn't reload an iframe; added a `&r=<nonce>` query to force a real reload). Token-funded dock now reads "🪙 $X tokens". |
| **v12.38** | Token bar live-syncs during Fish Shooter/Reef (`TokenMode.paintTokens()`); fixed the buy-in/top-up slider snapping back to default on a background re-render; "Lock $X" → "Buy in $X" wording. |
| **v12.37** | Plane auto-cash-out moved into the action dock (next to BET A/BET B). |
| **v12.36** | **Blackjack unified onto the token bridge** — real-money blackjack funded by your token session (no "lock credits" step). 2 adversarial review rounds. ⚠️ **HAS A LIVE BUG — see §6.** |
| **v12.35** | Win amounts show **profit, not stake+profit** (Balloon Pop / slots / slots3d / swoop); killed Balloon Pop's stray beep; redesigned the Fish Shooter control dock (compact); moved Balloon Pop auto-cash-out under the HOLD button. |
| **v12.34** | **Bulletproof "Recover"** (the loss-escape-proof obligation system + per-player mutex); house can release a player's stranded funds (owner-authed); profile X-button fix; click players → full profile + on-chain diagnostics. |
| **v12.33** | Stop funds getting locked (pre-flight before on-chain lock); sync the reveal animation to the result; red ticket → gold coin 🪙. |

Full detail is in each commit message (`git log`) and in the older root docs `HANDOFF.md`, `DEV_NOTES.md`,
`START-HERE-NEW-AI.md`.

---

## 4. BLACKJACK ARCHITECTURE (the most intricate part — v12.36)

Blackjack (CH 16) is **multiplayer** (4-seat tables, lobby, spectate) and now **real-money via the token bridge**.
The player's blackjack chips ARE their token-bridge session balance.

- `server/blackjack-server.js` — the table engine. `makeBank` is a `wallet→balance` map with `get/credit/debit`.
  For a **token-bound** wallet, those three route to the **token ledger** instead of the in-memory map. The binding
  is **frozen for the life of a hand** (`bindToken`/`unbindToken` refuse while `hasLiveHand`) so a bet's debit and
  the win's credit can never split across sessions (this was a critical bug caught in review — don't undo it).
- `server/token-bridge.js` `applyExternal()` — records a blackjack hand as a bounded, house-attested ledger entry
  (bet ≤ tokens, payout ≥ 0, never negative). Blackjack fairness comes from blackjack's OWN shoe commit-reveal, NOT
  the token seed.
- `server/token-http.js` `applyBlackjackNet()` (sync) + `doSettle/doRelease` **refuse while a hand is live**.
- `server/server.js` — WS `hello` with `bjSession`(=token sessionId)+`bjToken`(=bearer) → `verifySession` → bind.
- Client felt: `public/blackjack.html` + `blackjack-ui.js` + `blackjack-net.js` (the iframe inside the TV) +
  `public/app.js` (`ensureBlackjackReady`, `renderBjDock`).

> There is also an **OLD separate experimental on-chain blackjack bridge** (`server/bridge-server.js`,
> `ENABLE_EXPERIMENTAL_BRIDGE`). **It is OFF and must stay OFF** — it shares `bjLocked` with the token bridge and
> caused a cross-bridge footgun. The token-bridge path (above) replaced it.

---

## 5. COMMON TOOLS & DEV WORKFLOW

**Stack:** vanilla JS (no framework, no bundler) on the client; Node + Express + `ws` on the server; Hardhat +
Solidity for the contract; `ethers` v6 for chain interaction. Audio via Web Audio (`public/chiptune.js`). 3D via
Three.js / PlayCanvas / PixiJS depending on the game.

**Every change is verified with these, in order:**
1. **Syntax:** `node --check <file>` on every changed `.js`.
2. **Self-tests** (these are the safety net — run after ANY money-path change; all must print `SELF-TEST OK`):
   - `node server/token-bridge.js`
   - `node server/token-http.js`
   - `node server/blackjack-server.js`  ← drives the real `handle()` path for token-funded blackjack
   - `node public/token-client.js`  ← confirms client auth message is byte-identical to the server
3. **Preview** (local dev server): use the harness/IDE preview tooling against `node server/server.js` (port 3000,
   auto-bumps). The token bridge is OFF locally unless you set `ENABLE_TOKEN_BRIDGE=1` + a signer key, so most
   money testing is done via the self-tests, not the browser.
4. **Deploy:** bump the version (see below), `git add` the specific files, commit (end the message with
   `Co-Authored-By: ...`), push to the branch, poll `/sw.js` for the new `ctf-vNN` tag.

**Version bump (do this on every user-facing deploy):**
```
# bump asset cache-bust, display tag, and SW cache name together
sed -i 's/?v=1237/?v=1238/g' public/index.html public/app.js
sed -i 's/v12\.37/v12.38/g'  public/index.html public/sw.js
# (blackjack felt has its own ?v= inside the iframe URL in app.js — bump it too if you touch the felt)
```
Then verify: `grep -o '?v=12[0-9][0-9]' public/index.html | sort -u` and `grep ctf-v12 public/sw.js`.
**Why it matters:** a normal browser refresh serves the cached old version via the service worker. Bumping the
`ctf-vNN` SW cache name + the `?v=` query string forces clients onto the new build. (Users sometimes still need to
fully close/reopen the tab.)

**Multi-agent review:** the previous AI verified money-path changes with adversarial sub-agent "panels" (find a
bug → independently try to refute it). Cursor doesn't have that harness, so **lean hard on the self-tests and write
a new self-test for any new money invariant** before deploying.

---

## 6. ✅ (FIXED in v12.39) — token-funded blackjack not engaging — VERIFY IT HOLDS

> **Status: believed fixed in v12.39** (root cause was the iframe-hash-doesn't-reload issue; fixed with a `&r=`
> query nonce in `ensureBlackjackReady`). The previous AI could NOT live-test it (no wallet locally + the token
> bridge is off in the local env), so **the next person with a wallet should confirm**: connect → buy in tokens →
> CH16 → the dock should read "🪙 $X tokens" (not "Table"/"Credits"/"LOCK CREDITS"), and a bet should debit the
> token balance. If it's still flaky, see the diagnosis below and consider a postMessage-based re-bind (push the
> session to the felt without a reload) as the more robust fix.

**Original symptom (v12.36/12.37):** a connected wallet WITH an active token session ($285 tokens in the top
token bar) opens CH 16 and the blackjack felt **hangs (blank TV)** and shows the **OLD guest / "LOCK CREDITS"
flow** (`guest:…k8pj`, `CREDITS $375.07`, "Reload chips before placing a bet"). The token-funded path from v12.36
is NOT activating, and the in-game "credits" balance (the on-chain `balances`, separate from tokens) is what the UI
references — confusing the player about which balance blackjack uses.

**Diagnosis (where to look):**
- The felt iframe (`#bj-frame`, built in `public/app.js` `ensureBlackjackReady`, ~line 3393) appears to have loaded
  with a **guest** id (`guest=…`) — meaning `account` was falsy when it first loaded — and then did **not reload**
  after the wallet connected + a token session started. The bj-wallet label (`#bj-wallet`, set ~line 3319) also
  still shows the guest id, confirming a stale render.
- `ensureBlackjackReady` only injects the token session into the felt URL hash (`#bjsession=…&bjtoken=…`) when
  `account && TokenMode.active() && TokenMode.session()` are all true **at the moment it runs**. The reload-on-change
  logic (it removes `src` and rebuilds if the felt's `bjsession`/`guest` differs from the current one) is firing on
  channel-enter and on `TokenMode.onChange`, but evidently NOT reliably on wallet-connect-while-already-on-CH16.
- Verify on the live console:
  - `TokenMode.active()` and `JSON.stringify(TokenMode.session())` — is a session actually active?
  - `document.getElementById('bj-frame').src` — does it contain `#bjsession=`? If **no**, `ensureBlackjackReady`
    didn't get the session (client-side: fix the reload trigger). If **yes** but the felt is still guest, the
    **server bind failed** (check `server/server.js` hello: `tokenSvc.verifySession(bjSession, bjToken)` returning
    null, or `ts.player !== addr`).
- `renderBjDock` (~line 3624) hides the LOCK CREDITS / table CASH OUT buttons only when
  `TokenMode.active()` is true; the screenshot shows them visible, consistent with the dock reading a stale/guest
  felt state.

**Likely fix direction:** make the felt deterministically (re)load with the token session whenever the user is on
CH 16 AND `account` + a token session exist — e.g. (a) call `ensureBlackjackReady()` from the wallet-connect/account
hook (~app.js:909 area) AND whenever a token session opens/closes, and (b) ensure `ensureBlackjackReady` rebuilds
the iframe if the felt's current `guest`/`bjsession` ≠ the desired `(account, sessionId)`, and (c) keep the
`#bj-wallet` label in sync. Re-test the whole flow: connect → buy in tokens → CH 16 → place a bet → confirm the bet
debits the **token** balance (not "credits"), then cash out via the top token bar.

**Money-safety note:** this bug is **fail-safe** — when the token path doesn't engage, blackjack falls back to
guest/play-money, so no real funds are mis-moved. But it's a broken, confusing UX and the headline v12.36 feature
is effectively dark for connected users. The server-side token-funded engine itself passed 2 adversarial reviews
(see §4); the bug is in the **client wiring that connects the felt to the token session.**

---

## 7. OTHER GOTCHAS / STANDING RULES (the owner has stated these)

- **Never enter the private key / never do on-chain transactions on the owner's behalf.** The owner signs all
  MetaMask actions. The server holds the house signer key via env (`HOUSE_SIGNER_KEY`) — never log or expose it.
- **Don't enable the old experimental blackjack bridge** (`ENABLE_EXPERIMENTAL_BRIDGE` stays `0`).
- **No Chainlink VRF** — fairness is server commit-reveal only (owner decision: VRF too slow).
- **Durable disk:** Render Starter disk is mounted at `/var/data`; `TOKEN_BRIDGE_FILE` and `BJ_BANK_FILE` point
  there (in `render.yaml`) so token sessions + the blackjack bank survive a redeploy. If these ever point at
  ephemeral storage, sessions die on every deploy (this was the original "frozen balance" bug).
- **Env vars NOT in `render.yaml`** (set in the Render dashboard): `ENABLE_TOKEN_BRIDGE=1`, `HOUSE_SIGNER_KEY`,
  the RPC URL(s). The token games only work because these are set live.
- **`$10` minimum bet, USD ($) display, no "credits" wording in new UI** — the owner dislikes the word "credits"
  and the multi-step "lock" flow (which is exactly what v12.36 was meant to remove — see §6).
- **gh CLI:** use the full path if `gh` isn't on PATH. Commit messages should end with the `Co-Authored-By:` trailer.
- The previous AI's running memory/notes for this project also live outside the repo at
  `C:\Users\golde\.claude\projects\C--Users-golde-yacht-marketplace\memory\` (markdown files) — useful background.

---

## 8. CURRENT DIRECTION

1. **Fix the token-funded blackjack client wiring (§6).** Highest priority — it's the live regression.
2. Keep the money path provably-fair + loss-escape-proof. Any change to `token-bridge.js`/`token-http.js`/
   `blackjack-server.js` MUST keep all four self-tests green and should add a new self-test for any new invariant.
3. Polish/UX is welcome (the owner cares a lot about feel: animations synced to outcomes, clear "you won $X profit"
   numbers, controls near the action button, not intimidating for new users).
4. Everything stays free-to-run and on Sepolia testnet for now.

**Start by reading:** this file → `cursor/AUDIT-NOTES.md` (the security model in one page) → `server/token-http.js`
(the hardened money rails, with extensive comments) → `server/blackjack-server.js` (the token-funded bank
delegation + freeze) → `public/app.js` `ensureBlackjackReady`/`renderBjDock` (the bug in §6).
