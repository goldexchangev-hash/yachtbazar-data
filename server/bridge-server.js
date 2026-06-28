"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const realmoney = require("./realmoney.js");

const sessions = new Map();
const usedBuyIns = new Set();
const pendingBuyIns = new Set();
const BRIDGE_ABI = [
  "event BlackjackBuyIn(address indexed player,uint256 amount,uint256 locked)",
  "function bjLocked(address player) view returns (uint256)",
];
const WEI_PER_ETH = 10n ** 18n;

function bridgeStateFile() {
  const f = String(process.env.BRIDGE_STATE_FILE || "").trim();
  return f ? path.resolve(f) : "";
}

function bridgeStateConfigured() {
  return !!bridgeStateFile();
}

function loadBridgeState() {
  const f = bridgeStateFile();
  if (!f) return;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const tx of raw.usedBuyIns || []) if (typeof tx === "string") usedBuyIns.add(tx.toLowerCase());
    for (const s of raw.sessions || []) if (s && s.id) sessions.set(String(s.id), s);
  } catch (e) {
    if (e && e.code !== "ENOENT") console.error("bridge state load failed:", e.message || e);
  }
}

function saveBridgeState() {
  const f = bridgeStateFile();
  if (!f) return;
  const tmp = f + ".tmp";
  const data = JSON.stringify({ usedBuyIns: Array.from(usedBuyIns), sessions: Array.from(sessions.values()) }, null, 2);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, f);
}

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

function authToken() {
  return crypto.randomBytes(24).toString("hex");
}

function bridgeAuthMessage(intent, o) {
  const lines = [
    "Crypto TV Blackjack Bridge",
    "Action: " + String(intent || ""),
    "Player: " + address(o.player, "player"),
    "Contract: " + address(o.contract, "contract"),
    "Chain ID: " + Number(o.chainId),
  ];
  if (intent === "start") {
    lines.push("Buy-in wei: " + String(o.buyInWei || "0"));
  } else if (intent === "settle") {
    lines.push("Session: " + String(o.sessionId || "latest"));
  }
  return lines.join("\n");
}

function verifyBridgeSignature(intent, body, o) {
  const sig = String(body && body.signature || "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("wallet signature is required");
  const msg = bridgeAuthMessage(intent, o);
  const recovered = ethers.verifyMessage(msg, sig);
  if (String(recovered).toLowerCase() !== String(o.player).toLowerCase()) throw new Error("wallet signature does not match player");
}

function bridgeEnabled() {
  return realmoney.enabled() && process.env.ENABLE_EXPERIMENTAL_BRIDGE === "1" && bridgeStateConfigured();
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

function sessionById(id, player) {
  const s = sessions.get(String(id || ""));
  if (!s) return null;
  if (player && s.player.toLowerCase() !== String(player).toLowerCase()) return null;
  return s;
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
  let eventLocked = null;
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== o.contract.toLowerCase()) continue;
    let parsed = null;
    try { parsed = iface.parseLog(log); } catch {}
    if (!parsed || parsed.name !== "BlackjackBuyIn") continue;
    if (String(parsed.args.player).toLowerCase() !== o.player.toLowerCase()) continue;
    if (BigInt(parsed.args.amount.toString()) !== o.buyInWei) continue;
    eventLocked = BigInt(parsed.args.locked.toString());
    break;
  }
  if (eventLocked != null) {
    const contract = new ethers.Contract(o.contract, BRIDGE_ABI, provider);
    const currentLocked = BigInt((await contract.bjLocked(o.player)).toString());
    if (currentLocked < eventLocked) throw new Error("buy-in is no longer locked on-chain");
    return true;
  }
  throw new Error("buy-in event was not found in the transaction");
}

loadBridgeState();

function attachBridge(app, opts) {
  const blackjack = opts && opts.blackjack;
  if (blackjack && blackjack.bridge && blackjack.bridge.authorize) {
    for (const s of sessions.values()) {
      if (s && !s.closed && s.player && s.wsToken) {
        blackjack.bridge.authorize(s.player, s.wsToken);
        if (blackjack.bridge.setBalance) {
          const restoreUsd = +(s.balanceUsd != null ? s.balanceUsd : s.buyInUsd);
          if (restoreUsd > 0) {
            try { blackjack.bridge.setBalance(s.player, restoreUsd); } catch (e) { console.error("bridge balance restore failed:", e && e.message ? e.message : e); }
          }
        }
      }
    }
    if (blackjack.bridge.onBalanceChange) {
      blackjack.bridge.onBalanceChange((player, balanceUsd) => {
        const s = sessionFor(player);
        if (!s || s.closed) return;
        s.balanceUsd = balanceUsd;
        s.updatedAt = Date.now();
        saveBridgeState();
      });
    }
  }

  app.get("/api/bridge/status", (req, res) => {
    const chainId = Number(req.query && req.query.chainId);
    const statusChainId = Number.isSafeInteger(chainId) && chainId > 0 ? chainId : 11155111;
    res.json({
      ok: true,
      enabled: bridgeEnabled(),
      signerConfigured: realmoney.enabled(),
      bridgeFlagEnabled: process.env.ENABLE_EXPERIMENTAL_BRIDGE === "1",
      stateConfigured: bridgeStateConfigured(),
      signerAddress: realmoney.signerAddress(),
      statusChainId,
      rpcConfigured: !!rpcUrl(statusChainId),
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
      verifyBridgeSignature("start", req.body, { player, contract, chainId, buyInWei: buyInWei.toString() });
      const buyInUsd = buyInUsdFromWei(buyInWei);
      if (!(buyInUsd > 0)) throw new Error("buy-in USD value is invalid");
      await verifyBuyIn({ txHash, player, contract, chainId, buyInWei });
      if (existing) {
        if (existing.contract.toLowerCase() !== contract.toLowerCase()) throw new Error("open bridge session uses a different contract");
        if (Number(existing.chainId) !== chainId) throw new Error("open bridge session uses a different chain");
      }
      if (blackjack.bridge.hasOpenExposure(player)) throw new Error("finish the current hand before changing bridge funds");
      let session = existing;
      if (session) {
        session.buyInWei = (BigInt(session.buyInWei) + buyInWei).toString();
        session.buyInUsd = Math.round((+session.buyInUsd + buyInUsd) * 100) / 100;
        session.buyInCents = (BigInt(session.buyInCents) + cents(buyInUsd)).toString();
        session.lastTxHash = txHash;
        session.updatedAt = Date.now();
        if (!session.wsToken) session.wsToken = authToken();
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
          wsToken: authToken(),
          startedAt: Date.now(),
          closed: false,
        };
        sessions.set(id, session);
      }
      const balanceUsd = blackjack.bridge.fund(player, buyInUsd, !!existing);
      session.balanceUsd = balanceUsd;
      usedBuyIns.add(txKey);
      saveBridgeState();
      blackjack.bridge.authorize(player, session.wsToken);
      pendingBuyIns.delete(txKey);
      res.json({ ok: true, session, wsToken: session.wsToken, balanceUsd });
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
      const requestedSession = req.body && req.body.sessionId;
      const contract = address(req.body && req.body.contract, "contract");
      const chainId = Number(req.body && req.body.chainId);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chain id is invalid");
      verifyBridgeSignature("settle", req.body, { player, contract, chainId, sessionId: requestedSession || "latest" });
      const s = requestedSession ? sessionById(requestedSession, player) : sessionFor(player);
      if (!s) throw new Error("no open blackjack bridge session");
      if (s.contract.toLowerCase() !== contract.toLowerCase()) throw new Error("blackjack bridge session uses a different contract");
      if (Number(s.chainId) !== chainId) throw new Error("blackjack bridge session uses a different chain");
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
      if (blackjack.bridge.deauthorize) blackjack.bridge.deauthorize(player);
      saveBridgeState();
      res.json(s.settlement);
    } catch (e) {
      fail(res, 400, e.message || "could not settle blackjack bridge");
    }
  });
}

module.exports = { attachBridge };
