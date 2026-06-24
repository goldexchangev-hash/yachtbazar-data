# 🛠️ Dev notes / handoff

Context that isn't obvious from the code — decisions, current state, and how to
pick the project up in a **local** session. (For "how to run", see `README.md`.)

## Where the work lives
- Active branch: **`claude/ethereum-betting-game-vrf-2dq50k`** (all changes are
  committed + pushed here). Nothing important lives only in a chat window — it's
  all in git.
- Frontend is plain files in `public/` (no build step). The contract is
  `contracts/CoinFlipBetting.sol`; ABI+bytecode for one-click in-browser deploy
  is embedded in `public/contract.js`.

## Move to a local session
1. Install the Claude Code CLI (or use the desktop app / VS Code extension).
2. Clone the repo and check out the branch:
   ```bash
   git clone <repo-url> && cd yachtbazar-data
   git checkout claude/ethereum-betting-game-vrf-2dq50k
   npm install
   npm run play     # local chain + deploy + fund house + serve site
   ```
3. Start Claude Code in that folder. A new local session starts with a fresh
   conversation, but this file + the git history carry the important context.

> We were building in the **cloud** simply because this session was launched
> from Claude Code's web/remote environment (the repo was cloned into an
> ephemeral container). Moving local changes nothing about the code — same repo,
> same branch.

## Key decisions
- **Randomness: `block.prevrandao`, not Chainlink VRF.** No oracle, no
  subscription, no LINK — flips settle synchronously in the same tx. The full
  VRF version is preserved under `vrf-version/` if we ever want a paid oracle.
  Trade-off: prevrandao is fine for a fun testnet game, not validator-proof.
- **Pure ETH only.** Deposit / bet / win / withdraw in ETH. The UI *displays*
  USD using a live ETH price (Coinbase, CoinGecko fallback) and converts back to
  wei — there's no on-chain USD.
- **House = the host wallet.** 10% of every pot is credited to `treasury`
  (defaults to `0x2F4BEF94550C29c497b999B86b758F9771F7aB39`). The house bankroll
  matches vs-house bets and is funded/withdrawn by the contract `owner`
  (deployer) only. Owner-gating is enforced on-chain.
- **Sliders for amounts** ($10–$500, live ETH shown): deposit, vs-house bet,
  create-room bet, join-raise. Min is $10.
- **Active players + per-wallet records are derived on-chain** (from
  `getRecentRooms`) so they work on static hosting with no server. You always
  show as `YOU` on connect; each wallet shows last-3 W/L, W–L tally, and 🔥 best
  win streak.

## Gotchas / things to remember
- **Cache-busting:** every `public/*` asset is loaded as `file?v=N` in
  `index.html`. **Bump `N` on every frontend change** (currently `v=17`) or
  browsers serve stale files. After pushing, tell the user to load with
  `?fresh=N` appended to force a refresh.
- **Gas:** transactions use a live `eth_estimateGas` (×1.3 headroom) with a safe
  fixed fallback if the public Sepolia RPC errors (`estGas()` in `app.js`). Gas
  *price* is set by MetaMask from current network rates.
- **Each "New game" deploys a fresh contract.** Balances/records do not carry
  across contracts. Deposited funds left in an old contract are still withdrawable
  from that contract address (recovery-by-address tool is an open item below).
- The contract keeps `Status` enum values stable (`Settled == 2`) because the
  frontend depends on those numbers.

## Hosting
- **GitHub Pages** (`.github/workflows/pages.yml`) publishes `public/` — core
  game works; **chat + live presence broadcast do not** (static host, no
  WebSocket server). On-chain-derived player records DO work there.
- **Render** (`render.yaml`) runs `server/server.js` (WebSocket) so chat +
  real-time presence work too.

## Open / optional items
- [ ] **Chat on the live link** — needs the Node server; spin up the Render
      blueprint to enable chat + real-time presence.
- [ ] **Recover locked funds tool** — paste an old contract address → withdraw
      your balance (and house bankroll if you're the owner).
- [ ] **House auto-refill to ~$1000** — client-side owner watcher (uses
      MetaMask; no key on a server).

## Verify
```bash
npm test                       # 8 contract tests
node --check public/app.js     # quick JS syntax check
```
