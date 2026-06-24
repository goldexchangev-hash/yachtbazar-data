# Chainlink VRF version (kept for later — omitted from the default test run)

The live game uses Ethereum's built-in `block.prevrandao` for randomness: no
oracle, no subscription, no LINK, instant settlement — ideal for a quick test
run and for opening straight in the browser.

This folder preserves the **Chainlink VRF v2.5** version of the contract, which
is *provably fair / validator-manipulation-resistant* — the right choice if you
later want production-grade randomness. It is fully featured (deposits, custom
rooms, bet negotiation, vs-house, 10% fee, min/max bet, stuck-flip refund) and
was passing its full test suite, but it needs a paid VRF subscription, so it is
**not part of the default build**.

## Files

- `CoinFlipBetting.sol` — the VRF v2.5 contract (async settlement via the VRF callback)
- `VRFImports.sol` — pulls in the Chainlink mock so it compiles locally
- `deploy.js` — deploys a local mock VRF (local) or uses real VRF (Sepolia)
- `localFulfiller.js` — local-only watcher that plays the oracle so flips resolve
- `link-oz.js` — postinstall shim (Chainlink imports version-pinned OpenZeppelin)
- `CoinFlipBetting.test.js` — the VRF test suite (uses the mock coordinator)

## How to switch the project to the VRF version

1. Install Chainlink contracts:
   ```bash
   npm i -D @chainlink/contracts@^1.3.0
   ```
2. Swap in the contract + mock import, and the scripts:
   ```bash
   cp vrf-version/CoinFlipBetting.sol contracts/CoinFlipBetting.sol
   mkdir -p contracts/test && cp vrf-version/VRFImports.sol contracts/test/VRFImports.sol
   cp vrf-version/deploy.js scripts/deploy.js
   cp vrf-version/localFulfiller.js scripts/link-oz.js scripts/
   cp vrf-version/CoinFlipBetting.test.js test/CoinFlipBetting.test.js
   ```
3. Add the OpenZeppelin path shim so Chainlink compiles under Hardhat — add to
   `package.json` scripts: `"postinstall": "node scripts/link-oz.js"` and run
   `node scripts/link-oz.js` once. Re-add `"fulfill:local"` /
   `"deploy:sepolia"` scripts as needed.
4. **Local:** `npm run chain`, `npm run deploy:local`, `npm run fulfill:local`,
   `npm run serve`.
5. **Sepolia:** create a VRF v2.5 subscription at https://vrf.chain.link, fund it
   with test LINK, put `SUBSCRIPTION_ID` (and `SEPOLIA_RPC_URL`, `PRIVATE_KEY`)
   in `.env`, then `npm run deploy:sepolia` (it tries to add the contract as a
   consumer automatically).

> The frontend works with either version unchanged — same ABI surface for the
> functions it calls. The VRF version just settles a flip a few seconds later
> (when the oracle responds) instead of in the same transaction.
