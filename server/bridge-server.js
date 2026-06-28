"use strict";

const crypto = require("crypto");
const { ethers } = require("ethers");
const realmoney = require("./realmoney.js");

const sessions = new Map();
const usedBuyIns = new Set();
const BRIDGE_ABI = [
  "event BlackjackBuyIn(address indexed player,uint256 amount)",
];

function fail(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function address(v, label) {
  if (!ethers.isAddress(v)) throw new Error((label || "address") + " is invalid");
  return ethers.getAddress(v);
}

function positiveWei(v, label) {
  const out = BigInt(String(v || "0"));
  if (out <= 0n) throw new Error((label || "amount") + " must be positive");
  return out;
}

function cents(n) {
  return BigInt(Math.round((+n || 0) * 100));
}

function nonce() {
  return BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString();
}

function rpcUrl(chainId) {
  if (chainId === 11155111) return process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || "";
  if (chainId === 31337) return process.env.LOCAL_RPC_URL || process.env.RPC_URL || "http://127.0.0.1:8545";
  return process.env.RPC_URL || "";
}

function sessionFor(player) {
  const p = String(player || "").toLowerCase();
  for (const s of sessions.values()) {
    if (!s.closed && s.player.toLowerCase() === p) return s;
  }
  return null;
}

async function verifyBuyIn(o) {
  const url = rpcUrl(o.chainId);
  if (!url) throw new Error("bridge RPC not configured");
  const provider = new ethers.JsonRpcProvider(url);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== o.chainId) throw new Error("bridge RPC is on the wrong chain");
  const receipt = await provider.getTransactionReceipt(o.txHash);
  if (!receipt || receipt.status !== 1) throw new Error("buy-in transaction is not confirmed");
  if (receipt.to && receipt.to.toLowerCase() !== o.contract.toLowerCase()) throw new Error("buy-in went to the wrong contract");
  const iface = new ethers.Interface(BRIDGE_ABI);
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== o.contract.toLowerCase()) continue;
    let parsed = null;
    try { parsed = iface.parseLog(log); } catch {}
    if (!parsed || parsed.name !== "BlackjackBuyIn") continue;
    if (String(parsed.args.player).toLowerCase() !== o.player.toLowerCase()) continue;
    if (BigInt(parsed.args.amount.toString()) !== o.buyInWei) continue;
    return true;
  }
  throw new Error("buy-in event was not found in the transaction");
}

function attachBridge(app, opts) {
  const blackjack = opts && opts.blackjack;

  app.get("/api/bridge/status", (req, res) => {
    res.json({
      ok: true,
      enabled: realmoney.enabled(),
      signerAddress: realmoney.signerAddress(),
      rpcConfigured: !!(process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || process.env.LOCAL_RPC_URL),
      games: ["blackjack"],
      parkedGames: ["pressure", "slots3d", "fish"],
      model: "verified on-chain buy-in + server-authoritative ledger + signed settlement",
    });
  });

  app.post("/api/bridge/blackjack/start", async (req, res) => {
    if (!blackjack || !blackjack.bridge) return fail(res, 503, "blackjack bridge is unavailable");
    if (!realmoney.enabled()) return fail(res, 503, "bridge signer not configured");
    try {
      const player = address(req.body && req.body.player, "player");
      if (sessionFor(player)) throw new Error("you already have an open bridge session");
      const contract = address(req.body && req.body.contract, "contract");
      const chainId = Number(req.body && req.body.chainId);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
      const txHash = String(req.body && req.body.txHash || "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("buy-in transaction hash is invalid");
      if (usedBuyIns.has(txHash.toLowerCase())) throw new Error("buy-in transaction was already used");
      const buyInWei = positiveWei(req.body && req.body.buyInWei, "buy-in");
      const buyInUsd = Math.max(0, Math.min(1000000, +(req.body && req.body.buyInUsd) || 0));
      if (!(buyInUsd > 0)) throw new Error("buy-in USD value is invalid");
      await verifyBuyIn({ txHash, player, contract, chainId, buyInWei });
      const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
      const session = {
        id,
        game: "blackjack",
        player,
        contract,
        chainId,
        txHash,
        buyInWei: buyInWei.toString(),
        buyInUsd,
        buyInCents: cents(buyInUsd).toString(),
        nonce: nonce(),
        startedAt: Date.now(),
        closed: false,
      };
      blackjack.bridge.fund(player, buyInUsd);
      usedBuyIns.add(txHash.toLowerCase());
      sessions.set(id, session);
      res.json({ ok: true, session, balanceUsd: buyInUsd });
    } catch (e) {
      fail(res, 400, e.message || "could not start blackjack bridge");
    }
  });

  app.post("/api/bridge/blackjack/settle", async (req, res) => {
    if (!blackjack || !blackjack.bridge) return fail(res, 503, "blackjack bridge is unavailable");
    if (!realmoney.enabled()) return fail(res, 503, "bridge signer not configured");
    try {
      const player = address(req.body && req.body.player, "player");
      const s = sessionFor(player);
      if (!s) throw new Error("no open blackjack bridge session");
      const balanceUsd = blackjack.bridge.balance(player);
      const netCents = cents(balanceUsd) - BigInt(s.buyInCents);
      const buyInCents = BigInt(s.buyInCents);
      let netWei = buyInCents > 0n ? (netCents * BigInt(s.buyInWei)) / buyInCents : 0n;
      const floor = -BigInt(s.buyInWei);
      if (netWei < floor) netWei = floor;
      const signature = await realmoney.signSettlement(player, netWei, s.nonce, s.chainId, s.contract);
      s.closed = true;
      s.closedAt = Date.now();
      s.balanceUsd = balanceUsd;
      s.netWei = netWei.toString();
      blackjack.bridge.clear(player);
      res.json({
        ok: true,
        sessionId: s.id,
        player,
        balanceUsd,
        netWei: netWei.toString(),
        nonce: s.nonce,
        chainId: s.chainId,
        contract: s.contract,
        signature,
      });
    } catch (e) {
      fail(res, 400, e.message || "could not settle blackjack bridge");
    }
  });
}

module.exports = { attachBridge };
