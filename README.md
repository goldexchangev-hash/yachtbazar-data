# 📺 TV Crypto Flip

A **provably-fair, two-player (and vs-house) ETH coin-flip** game with a retro
**16-bit / SNES-on-a-CRT-TV** vibe. Randomness comes from **Chainlink VRF v2.5**
— verifiable on-chain, so neither player nor the house can cheat.

- 🪙 **Pure ETH, end to end.** Deposit ETH, bet ETH, win ETH, withdraw ETH. No
  tokens, no USDC, no swaps, no conversion fees — only normal network gas.
- 🏠 **House takes 10%** of every game's pot, credited to the host's wallet.
- 👤 **Play another player** in custom rooms, or **play the house** (you) with a
  drag-to-choose stake.
- 🤝 **Bet negotiation** — a joiner can propose a higher stake; the host approves
  or denies until you both agree.
- ♾️ **Unlimited parallel games** — host your own custom game *and* let many
  players flip against the house at the same time.
- 📺 **The TV** broadcasts each flip: static → `3·2·1·FLIP!` → a spinning pixel
  coin → a per-viewer **WIN 😄 / LOSE 😢** reveal with confetti.
- 💬 **Matrix-style trash-talk chat** (host = green, visitors = red).
- 🎵 **Relaxing lo-fi background music** with a clear on/off button (bring your
  own track via `public/music.mp3`).
- 📱 Responsive — works on a phone.
- 🔗 Run it locally and **share a link** so friends can join.

> ⚠️ **Test networks only. Play money only.** Never use a wallet that holds real
> funds. Use a throwaway MetaMask account.

---

## What you need

- [Node.js](https://nodejs.org) 18+ and npm
- [MetaMask](https://metamask.io) (browser extension or mobile)
- Two terminals (one for the chain, one for the website) — three if you want the
  local VRF fulfiller

---

## 🚀 Quick start — play locally in 4 commands

```bash
npm install            # 1. install deps (also links OpenZeppelin for Chainlink)

npm run chain          # 2. start a local blockchain  (leave this running)
```

In a **second terminal**:

```bash
npm run deploy:local   # 3. deploy the game + a mock VRF + fund the house

npm run serve          # 4. start the website
```

In a **third terminal** (only for local play — it stands in for the Chainlink
oracle so flips resolve):

```bash
npm run fulfill:local
```

Now open the URL printed by `npm run serve` (e.g. **http://localhost:3000**).

> The server prints three links on startup: a **Local** link (this machine), a
> **Network** link (your LAN IP — share it with people on the same wifi), and a
> **Public** link if you set `PUBLIC_HOST` to your public IP.

---

## 🦊 Connect MetaMask & get fake ETH to play

### On the local chain (Hardhat)

1. Click **Connect Wallet**. The site offers to add/switch to the **Hardhat
   Local** network (chain id `31337`, RPC `http://127.0.0.1:8545`) — approve it.
2. The local chain pre-funds 20 test accounts with 10000 ETH each. The private
   keys are printed by `npm run chain`. **Import one** into MetaMask:
   _MetaMask → Account menu → Import account → paste a printed private key._
   (These keys are public and for testing only — never send real funds to them.)
3. **Deposit** some ETH into the game (panel under the TV) and play.

### On the Sepolia testnet (recommended for playing with others)

1. Click **Connect Wallet** → approve switching to **Sepolia**.
2. Get **free Sepolia ETH** from a faucet — paste your address into one of:
   - https://sepoliafaucet.com
   - https://cloud.google.com/application/web3/faucet/ethereum/sepolia
   - https://www.alchemy.com/faucets/ethereum-sepolia
3. **Deposit** into the game and play. (See **Deploy to Sepolia** below for the
   one-time contract setup.)

> 💡 **Your wallet address is the same on every network.** Switching MetaMask
> from Mainnet to Sepolia to the local chain never changes your address — only
> the balance differs per network. So `0x2F4B…` is you everywhere.

---

## 🔗 Sharing & "can my friend outside my network play?"

Sharing involves **two** things: the **website** and the **blockchain** the
wallets talk to.

| Sharing with | Website | Blockchain | What to do |
|---|---|---|---|
| **Same wifi/LAN** | Share the **Network** link (`http://<your-LAN-IP>:3000`) | Local Hardhat works *only on the host machine* | OK for the host; a guest still can't reach your local RPC — prefer Sepolia for guests |
| **Anywhere on the internet** (e.g. your brother) | Forward port 3000 on your router, or run `ngrok http 3000` and share the URL | **Deploy to Sepolia** | Guests just switch MetaMask to Sepolia + grab faucet ETH — no RPC sharing, real VRF |

**Bottom line:** for anyone **outside your network**, deploy the contract to
**Sepolia** and share the website link via a tunnel. A local Hardhat chain only
exists on your computer, so remote players can't reach it (the site warns you if
it detects this situation).

**Room links are unique.** Every room you create gets its own id and a shareable
link like `…/?room=12`. Opening that link takes a guest straight to that room's
bet screen.

---

## 🏠 Play vs House (you are the house) — runs in parallel

Anyone with the link can flip against the **house** — your funded host wallet.

- The **10% fee** of every game goes to the **treasury** wallet (you).
- When the **player loses**, their stake flows to the house; when they **win**,
  they take it from the house bankroll. Either way the house keeps its 10% edge.
- **Many players can flip the house at the same time.** Each game is its own
  on-chain room with its own random draw, so games run **in parallel** and never
  interfere. You can *also* create and play your **own custom room** at the same
  time — your personal bets come from your wallet balance, while the house's side
  comes from the separate **house bankroll**.
- The house bankroll (which covers the house's side of each bet) is pre-funded on
  local deploy (5 ETH). It must be large enough to cover all simultaneous house
  stakes — top it up any time:

```bash
AMOUNT=2 npm run fundhouse:local
# or on testnet:
AMOUNT=0.2 npm run fundhouse:sepolia
```

Withdraw fees/winnings by connecting with the host wallet and clicking
**Withdraw all** (fees), or call `withdrawHouse` for unused bankroll.

---

## 🎮 Custom rooms & bet negotiation

- **Create a room** with your own name and bet. You're escrowed for that amount.
- A joiner can **accept your bet** to flip immediately, or **drag the slider to
  raise it** — which sends you a proposal to **Accept** or **Deny**. Deny and
  they pick again; keep going until you both agree, then it flips.
- In custom rooms the stake is whatever you both agree on; **vs the house** the
  player freely drags their stake (up to the max and what the bankroll covers).

---

## 🎵 Music

The background music is an **original, synthesized lo-fi loop** (no copyrighted
audio) — toggle it with the **🔊 Music** button in the header. Want a specific
track? Drop an MP3 at **`public/music.mp3`** and it plays that instead, looped.

---

## 🌐 Deploy to Sepolia (real Chainlink VRF)

1. Create a **VRF v2.5 subscription** at https://vrf.chain.link, fund it with
   test **LINK**, and copy the subscription id.
2. Copy `.env.example` to `.env` and fill in:
   - `SEPOLIA_RPC_URL` — an RPC endpoint (Alchemy/Infura/public)
   - `PRIVATE_KEY` — a **throwaway** test wallet's key (the host/owner)
   - `TREASURY_ADDRESS` — where the 10% fee goes (defaults to the host wallet)
   - `SUBSCRIPTION_ID` — from step 1
3. Deploy and register the contract as a VRF consumer:

```bash
npm run deploy:sepolia
```

   (The script tries to add the consumer automatically if your wallet owns the
   subscription; otherwise add the printed contract address as a consumer at
   https://vrf.chain.link.)

4. Fund the house bankroll, then `npm run serve` and share the link.

---

## 🧱 How it works

```
contracts/CoinFlipBetting.sol   the game: deposits, rooms, vs-house, VRF, 10% fee
scripts/deploy.js               deploys (mock VRF locally, real VRF on Sepolia)
scripts/localFulfiller.js       local-only: stands in for the Chainlink oracle
scripts/fundHouse.js            top up the house bankroll
server/server.js                serves the site + WebSocket (players, chat, bets)
public/                         the frontend (vanilla JS + ethers, no build step)
  index.html  styles.css
  tv.js       the 16-bit TV broadcast animation
  app.js      wallet, contract, lobby, chat, negotiation
  chiptune.js music + SFX
test/                           Hardhat tests
```

- Each game is an **independent room** with its own VRF request, so unlimited
  games settle in parallel.
- Settlement happens by crediting **internal balances** inside the VRF callback
  (never external calls), so a flip can't be griefed or blocked, and players
  withdraw on their own.
- The **10% fee is always exactly 10% of the pot** and is credited to the
  treasury wallet.

### Tests

```bash
npm test
```

---

## 🔒 Safety notes

- **Testnet / play money only.** Never put real funds or a real-money key
  anywhere near this. Use throwaway test wallets.
- `.env` (with your key) is git-ignored. Don't commit secrets.
- This is a fun project, not an audited production casino.

---

## 🛠️ Troubleshooting

- **`npm run deploy:local` fails to connect** — make sure `npm run chain` is
  running in another terminal first.
- **Flips never resolve locally** — start `npm run fulfill:local` (it plays the
  Chainlink oracle on your local chain).
- **A remote friend can't read anything / it hangs** — you're on the local chain,
  which only works on the host machine. Deploy to **Sepolia** for remote play.
- **Solidity compiler download blocked by a network policy** — Hardhat normally
  fetches solc from `binaries.soliditylang.org`. On an open internet connection
  this just works. (In restricted CI you can seed Hardhat's compiler cache from
  the npm `solc` package.)
