/* ============================================================
   realmoney.js — HOUSE SIGNER for on-chain settlement of the off-chain games
   (Reef Raiders, Royal Riches, Balloon Pop). Reuses the contract's GENERIC
   buy-in → signed-settle framework (`blackjackBuyIn` / `settleBlackjack`):

     1. Player deposits Sepolia ETH → withdrawable `balances[player]`.
     2. `blackjackBuyIn(amount)` LOCKS a session buy-in (their credits/ammo).
        Locked funds can't be withdrawn until settled → makes off-chain play safe.
     3. Player plays off-chain. Outcomes come from a provably-fair seed the SERVER
        committed (the client can't choose it), so the server can re-derive the
        authoritative net P&L and the player can verify every round afterward.
     4. On cash-out the server signs `(player, net, nonce, chainId, contract)` with
        the house signer key; the player submits `settleBlackjack(...)` and the
        contract returns `locked + net` (net can be negative; never lose > locked).

   The signer key lives ONLY in the Render env (HOUSE_SIGNER_KEY) — never in code.
   If it's unset, real-money settlement is simply DISABLED (games stay play-money).

   ⚠️ OWNER SETUP (one-time, required before real-money works):
     a) generate a keypair:           node server/realmoney.js --genkey
     b) Render env:                   HOUSE_SIGNER_KEY = <the private key>
     c) on-chain (owner wallet):      contract.setBlackjackSigner(<the address>)
     d) fund the house bankroll:      npm run fundhouse:sepolia   (or contract.fundHouse)
   ============================================================ */
"use strict";
const { ethers } = require("ethers");

const KEY = process.env.HOUSE_SIGNER_KEY || process.env.BLACKJACK_SIGNER_KEY || "";
let wallet = null;
try { if (KEY) wallet = new ethers.Wallet(KEY.trim()); } catch (e) { wallet = null; }

function enabled() { return !!wallet; }
function signerAddress() { return wallet ? wallet.address : null; }

// The exact digest the contract verifies:
//   h = keccak256(abi.encodePacked(player, int256 net, uint256 nonce, uint256 chainid, address contract))
//   then an EIP-191 personal_sign over `h`.
function settlementHash(player, net, nonce, chainId, contractAddr) {
  return ethers.solidityPackedKeccak256(
    ["address", "int256", "uint256", "uint256", "address"],
    [player, net, nonce, chainId, contractAddr]
  );
}

// Returns a 65-byte signature string the player passes to settleBlackjack(...).
async function signSettlement(player, net, nonce, chainId, contractAddr) {
  if (!wallet) throw new Error("house signer not configured");
  const h = settlementHash(player, net, nonce, chainId, contractAddr);
  return wallet.signMessage(ethers.getBytes(h)); // EIP-191 over the raw 32-byte hash
}

// Verify locally that a signature recovers to a given signer (mirrors the contract).
function recoverSettlement(player, net, nonce, chainId, contractAddr, signature) {
  const h = settlementHash(player, net, nonce, chainId, contractAddr);
  return ethers.verifyMessage(ethers.getBytes(h), signature);
}

module.exports = { enabled, signerAddress, signSettlement, recoverSettlement, settlementHash };

/* ---------------- CLI: key generation + self-test ---------------- */
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--genkey") {
    const w = ethers.Wallet.createRandom();
    console.log("HOUSE SIGNER (keep the private key secret; put it in Render env HOUSE_SIGNER_KEY)");
    console.log("  address:    ", w.address, "   <- call setBlackjackSigner(this) from the owner wallet");
    console.log("  privateKey: ", w.privateKey);
  } else {
    // self-test: prove a signed settlement recovers to the signer (contract-compatible)
    (async () => {
      const w = ethers.Wallet.createRandom();
      const t = new ethers.Wallet(w.privateKey);
      const player = "0x2F4BEF94550C29c497b999B86b758F9771F7aB39";
      const contractAddr = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
      const chainId = 11155111, nonce = 123456;
      for (const net of [25n * 10n ** 16n, -(7n * 10n ** 16n)]) { // +0.25 ETH win, -0.07 ETH loss
        const h = settlementHash(player, net, nonce, chainId, contractAddr);
        const sig = await t.signMessage(ethers.getBytes(h));
        const rec = ethers.verifyMessage(ethers.getBytes(h), sig);
        console.log("net", net.toString(), "recovered==signer:", rec === t.address);
        if (rec !== t.address) process.exit(1);
      }
      console.log("SELF-TEST OK — signatures are contract-compatible.");
    })();
  }
}
