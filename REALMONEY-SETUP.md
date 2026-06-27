# Real-money (Sepolia) setup — Reef Raiders · Royal Riches · Balloon Pop

These three games are play-money by default. To let them wager **real Sepolia ETH**
they use the contract's generic **buy-in → signed-settle** framework (the same one
built for blackjack): you deposit ETH, lock a session buy-in, play off-chain against
a server-committed provably-fair seed, and the house server signs your net P&L so the
contract pays out. **A player can never lose more than they locked.**

## ⚠️ Owner one-time setup (required — nothing pays out until this is done)

1. **Generate a house signer keypair** (do this locally, keep the private key secret):
   ```
   node server/realmoney.js --genkey
   ```
   It prints an `address` and a `privateKey`.

2. **Render env var** — in the Render dashboard for `tv-crypto-flip`, add:
   ```
   HOUSE_SIGNER_KEY = <the privateKey from step 1>
   ```
   (Never commit this to the repo. The server reads it at runtime; if it's unset,
   real-money settlement stays disabled and the games remain play-money.)

3. **Tell the contract to trust that signer** — from the **owner wallet** (the one
   that deployed the contract), send one transaction:
   ```
   contract.setBlackjackSigner(<the address from step 1>)
   ```
   (You can do this from the in-app Host tools, Etherscan "Write Contract", or a script.)

4. **Fund the house bankroll** so the contract can pay winners:
   ```
   npm run fundhouse:sepolia
   ```
   (or call `contract.fundHouse()` with some Sepolia ETH).

5. **Players deposit** Sepolia ETH into the contract (`deposit()` / the in-app Wallet
   panel) — that becomes their withdrawable balance the games buy in from.

## How a real-money session works (per game)
- Player picks **real** mode (wallet connected) and a **buy-in** amount → one tx
  `blackjackBuyIn(amount)` locks it.
- The server commits a provably-fair `serverSeed` (publishes its hash); the client
  plays, every outcome deriving from that seed (so it can't be forged either way).
- On **cash-out**, the server re-derives the authoritative net from the seed, signs
  `(player, net, nonce, chainId, contract)`, and the client submits
  `settleBlackjack(player, net, nonce, signature)` → the contract returns
  `locked + net` to the player's withdrawable balance.

## Status / phases
- ✅ **Foundation:** `server/realmoney.js` house signer (contract-compatible; self-test
  `node server/realmoney.js`), `ethers` promoted to a runtime dependency.
- ⏳ **Next:** per-game real-money session manager on the server (commit seed, track
  buy-in, re-derive net, sign), and the frontend real-money mode + deposit/buy-in/
  cash-out UI for each of the three games.

> Until the owner steps above are done, the three games stay play-money (safe default).
