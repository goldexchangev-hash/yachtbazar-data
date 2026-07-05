# 📺 Crypto TV Flip

A two-player (and vs-house) **ETH coin-flip** game with a retro **16-bit /
SNES-on-a-CRT-TV** look. On-chain randomness with **no oracle, no subscription,
no LINK** — it uses Ethereum's built-in `block.prevrandao`, so flips settle
**instantly** and you can deploy on any testnet with one click.

- 🪙 **Pure ETH** — deposit, bet, win, withdraw. No tokens or swaps.
- 🏠 **House takes 3%** of every pot; host-table rake splits between platform and table host.
- 👤 **Play another player** (custom rooms) or **the house**, with a drag slider.
- 🤝 **Bet negotiation** — a joiner can propose a higher stake; host accepts/denies.
- ♾️ **Unlimited parallel games** at once.
- 📺 TV broadcast: static → `3·2·1·FLIP!` → spinning pixel coin → per-viewer
  **WIN 😄 / LOSE 😢** + confetti.
- 💬 Matrix-style chat (host green, visitors red) · 🎵 lo-fi music · 📱 mobile.

> ⚠️ Test networks / play money only. Use a throwaway MetaMask wallet, never one
> with real funds. `prevrandao` randomness is great for a fun game but is not
> validator-manipulation-proof like a paid oracle.

---

## ✅ Easiest way: just open it in your browser

This is a static site that talks to MetaMask directly — like any simple dapp, it
**just opens in a browser**. No terminals.

1. Open the live site (GitHub Pages URL for this repo), **or** host it yourself
   (Render blueprint / GitHub Pages — see below).
2. Click **Connect Wallet** and switch MetaMask to a testnet (e.g. **Sepolia**).
   Get free test ETH from a faucet:
   - https://sepoliafaucet.com · https://www.alchemy.com/faucets/ethereum-sepolia
3. Click **🚀 Deploy game contract** — MetaMask deploys it (you become the house
   + fee recipient). You get a **shareable game link** to send to players.
4. **Deposit** ETH and play. Share the link; friends open it, connect, and join.

That's it — the contract address travels in the share link, so anyone who opens
it plays against the same game.

> Chat + the live active-players list need the small Node server (the Render
> deploy or running locally). The core game works without it.

---

## 🖥️ Run it locally (one command)

```bash
npm install
npm run play      # starts a local chain, deploys, funds the house, serves the site
```

Then open the printed URL (e.g. **http://localhost:3000**). Connect MetaMask to
the **Hardhat Local** network (the site offers to add it) and import a test key
printed by the chain to get test ETH. Press Ctrl+C to stop everything.

Prefer separate terminals?

```bash
npm run chain          # terminal 1 — local blockchain
npm run deploy:local   # terminal 2 — deploy + fund house
npm run serve          # terminal 2 — website at http://localhost:3000
```

---

## ☁️ Host it (public URL)

- **GitHub Pages (zero setup):** pushing to this repo runs `.github/workflows/
  pages.yml`, which publishes `public/` to Pages. Live at
  `https://<user>.github.io/<repo>/`. (If Pages isn't on yet: repo **Settings →
  Pages → Source: GitHub Actions**.) Core game works; chat needs the server.
- **Render (full version, with chat):** New → Blueprint → pick this repo
  (`render.yaml`). Runs the Node server, so chat + active-players work too.

On either, the host clicks **🚀 Deploy game contract** once (on Sepolia) and
shares the game link.

---

## Deploy to Sepolia from the CLI (optional)

If you'd rather deploy from a terminal than the browser, copy `.env.example` to
`.env` (set `SEPOLIA_RPC_URL`, a throwaway `PRIVATE_KEY`, optional
`TREASURY_ADDRESS`) and run:

```bash
npm run deploy:sepolia
AMOUNT=0.2 npm run fundhouse:sepolia
```

No VRF subscription or LINK needed — just ETH for gas.

---

## How it works

```
contracts/CoinFlipBetting.sol   game logic; prevrandao randomness; 3% fee
scripts/deploy.js  fundHouse.js  exportArtifact.js  play.js
server/server.js                static site + WebSocket (players, chat, bets)
public/                         frontend (vanilla JS + ethers, no build step)
  index.html  styles.css  app.js  tv.js  chiptune.js
  contract.js                   ABI + bytecode for one-click in-browser deploy
test/                           Hardhat tests
```

- Each game is an independent room that settles in the same transaction, so many
  games run in parallel.
- The 3% fee is exactly 3% of the pot. PvP/vs-house rake goes into the house bankroll; host-table rake splits 50/50 between platform bankroll and table host.

```bash
npm test      # run the contract tests
```

---

## Safety

Testnet / play money only. `.env` (your key) is git-ignored. Not an audited
production casino — it's a fun project.
