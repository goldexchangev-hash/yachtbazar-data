# Real-money (Sepolia) setup - bridge sessions

The contract has a generic **buy-in -> signed-settle** framework: players deposit
ETH, lock a session buy-in, play a server-authoritative off-chain game, then the
house server signs the final net P&L so the contract releases `locked + net`.
**A player can never lose more than they locked.**

Current live bridge scope: **Blackjack only**. Reef Raiders, Gem Vault, and
Balloon Pop remain play-money for wallet-connected users until their server-side
replay adapters exist. Do not sign browser-reported balances for those games.

## Owner one-time setup

1. Generate a house signer keypair locally:
   ```bash
   node server/realmoney.js --genkey
   ```

2. In Render, add:
   ```bash
   HOUSE_SIGNER_KEY=<private key from step 1>
   SEPOLIA_RPC_URL=<Sepolia JSON-RPC URL>
   ```

3. From the contract owner wallet, call:
   ```solidity
   contract.setBlackjackSigner(<signer address from step 1>)
   ```

4. Fund the house bankroll so winners can be paid:
   ```bash
   npm run fundhouse:sepolia
   ```

5. Players deposit Sepolia ETH into game credits through the in-app Wallet panel.

## Blackjack Bridge Flow

- The player connects a wallet and taps **Reload balance** on Blackjack.
- The app calls `blackjackBuyIn(amount)` to lock credits on-chain.
- `/api/bridge/blackjack/start` verifies the confirmed `BlackjackBuyIn` event by
  transaction hash before funding the server-held table balance.
- Blackjack hands remain server-authoritative: the server owns the shoe, bets,
  actions, and balance changes.
- On **Cash out**, `/api/bridge/blackjack/settle` signs
  `(player, net, nonce, chainId, contract)`.
- The app submits `settleBlackjack(player, net, nonce, signature)` and the contract
  releases `locked + net` back to the player's withdrawable game credits.

## Status

- Live foundation: `server/realmoney.js` house signer plus
  `server/bridge-server.js` Blackjack bridge with receipt verification.
- Next: server replay/session adapters for Reef Raiders, Gem Vault, and Balloon Pop
  before enabling real-money bridge mode for those games.

If `HOUSE_SIGNER_KEY` or `SEPOLIA_RPC_URL` is missing, the app shows a setup error
before locking funds.
