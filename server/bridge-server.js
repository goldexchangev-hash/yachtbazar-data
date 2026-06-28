"use strict";

const crypto = require("crypto");
const { ethers } = require("ethers");
const realmoney = require("./realmoney.js");

const sessions = new Map();
const usedBuyIns = new Set();
const pendingBuyIns = new Set();
const BRIDGE_ABI = [
  "event BlackjackBuyIn(address indexed player,uint256 amount)",
];
const WEI_PER_ETH = 10n ** 18n;

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

function bridgeEnabled() {
  return realmoney.enabled() && process.env.ENABLE_EXPERIMENTAL_BRIDGE === "1";
}

function buyInUsdFromWei(wei) {
  const ethUsd = Math.max(1, +(process.env.BRIDGE_ETH_USD || process.env.ETH_USD || 3400));
  return Math.round((Number(wei) / Number(WEI_PER_ETH)) * ethUsd * 100) / 100;
}

function rpcUrl(chainId) {
  if (chainId === 11155111) return process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || "";
  if (chainId === 31337) return process.env.LOCAL_RPC_URL || process.env.RPC_URL || "http://127.0.0.1:8545";
  return process.env.RPC_URL || "";
}

function sessionFor(player, includeClosed) {
  const p = String(player || "").toLowerCase();
  for (const s of sessions.values()) {
    if ((includeClosed || !s.closed) && s.player.toLowerCase() === p) return s;
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
      enabled: bridgeEnabled(),
      signerConfigured: realmoney.enabled(),
      bridgeFlagEnabled: process.env.ENABLE_EXPERIMENTAL_BRIDGE === "1",
      signerAddress: realmoney.signerAddress(),
      rpcConfigured: !!(process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || process.env.LOCAL_RPC_URL),
      games: ["blackjack"],
      parkedGames: ["pressure", "slots3d", "fish"],
      model: "verified on-chain buy-in + server-authoritative ledger + signed settlement",
    });
  });

  app.post("/api/bridge/blackjack/start", async (req, res) => {
    if (!blackjack || !blackjack.bridge) return fail(res, 503, "blackjack bridge is unavailable");
    if (!bridgeEnabled()) return fail(res, 503, "bridge is not enabled on the server");
    let txKey = "";
    try {
      const player = address(req.body && req.body.player, "player");
      const existing = sessionFor(player);
      const contract = address(req.body && req.body.contract, "contract");
      const chainId = Number(req.body && req.body.chainId);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
      const txHash = String(req.body && req.body.txHash || "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("buy-in transaction hash is invalid");
      txKey = txHash.toLowerCase();
      if (usedBuyIns.has(txKey) || pendingBuyIns.has(txKey)) throw new Error("buy-in transaction was already used");
      pendingBuyIns.add(txKey);
      const buyInWei = positiveWei(req.body && req.body.buyInWei, "buy-in");
      const buyInUsd = buyInUsdFromWei(buyInWei);
      if (!(buyInUsd > 0)) throw new Error("buy-in USD value is invalid");
      await verifyBuyIn({ txHash, player, contract, chainId, buyInWei });
      if (existing) {
        if (existing.contract.toLowerCase() !== contract.toLowerCase()) throw new Error("open bridge session uses a different contract");
        if (Number(existing.chainId) !== chainId) throw new Error("open bridge session uses a different chain");
      }
      blackjack.bridge.fund(player, buyInUsd, !!existing);
      let session = existing;
      if (session) {
        session.buyInWei = (BigInt(session.buyInWei) + buyInWei).toString();
        session.buyInUsd = Math.round((+session.buyInUsd + buyInUsd) * 100) / 100;
        session.buyInCents = (BigInt(session.buyInCents) + cents(buyInUsd)).toString();
        session.lastTxHash = txHash;
        session.updatedAt = Date.now();
      } else {
        const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
        session = {
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
        sessions.set(id, session);
      }
      usedBuyIns.add(txKey);
      pendingBuyIns.delete(txKey);
      res.json({ ok: true, session, balanceUsd: blackjack.bridge.balance(player) });
    } catch (e) {
      if (txKey) pendingBuyIns.delete(txKey);
      fail(res, 400, e.message || "could not start blackjack bridge");
    }
  });

  app.post("/api/bridge/blackjack/settle", async (req, res) => {
    if (!blackjack || !blackjack.bridge) return fail(res, 503, "blackjack bridge is unavailable");
    if (!bridgeEnabled()) return fail(res, 503, "bridge is not enabled on the server");
    try {
      const player = address(req.body && req.body.player, "player");
      const s = sessionFor(player, true);
      if (!s) throw new Error("no open blackjack bridge session");
      if (s.settlement) return res.json(s.settlement);
      if (s.closed) throw new Error("blackjack bridge session is already closed");
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
      s.settlement = {
        ok: true,
        sessionId: s.id,
        player,
        balanceUsd,
        netWei: netWei.toString(),
        nonce: s.nonce,
        chainId: s.chainId,
        contract: s.contract,
        signature,
      };
      blackjack.bridge.clear(player);
      res.json(s.settlement);
    } catch (e) {
      fail(res, 400, e.message || "could not settle blackjack bridge");
    }
  });
}

module.exports = { attachBridge };
