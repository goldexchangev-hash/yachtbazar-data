/**
 * Crypto TV Flip — local game server.
 *
 *  - Serves the static frontend in ../public
 *  - Runs a WebSocket hub that tracks the "active players" (connected wallets)
 *    and relays lobby refresh pings so every screen stays in sync in real time.
 *  - On startup it prints the exact URLs to share so other people can join:
 *      • Local    (this machine)
 *      • Network  (anyone on your wifi/LAN — share this host:port)
 *      • Public   (set PUBLIC_HOST to your public IP for internet play)
 *
 * Run:  npm run serve     (PORT and PUBLIC_HOST are optional env vars)
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");
require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const { attachBlackjack } = require("./blackjack-server.js");
const { attachBridge } = require("./bridge-server.js");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_HOST = process.env.PUBLIC_HOST || ""; // e.g. your public IP for internet play

const app = express();
const publicDir = path.join(__dirname, "..", "public");
app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir));

// Tiny health/info endpoint the frontend can use to learn its share base.
app.get("/api/info", (req, res) => {
  res.json({ publicHost: PUBLIC_HOST, port: PORT, players: activePlayers().length });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// Multiplayer Blackjack (TV channel) — server-authoritative engine attached to the
// SAME ws server. Players are identified by their connection's stamped wallet.
// Durable store for GUEST (play-money) blackjack balances so a crash / deploy / idle spin-down
// can't reset a player's grown balance to $1,000. Atomic write (tmp + rename), guest keys only.
// NOTE: on an ephemeral filesystem (Render free tier) this survives a process restart/crash within
// the same container; for durability across a cold spin-down, point BJ_BANK_FILE at a mounted disk.
const BJ_BANK_FILE = String(process.env.BJ_BANK_FILE || path.join(__dirname, ".bj-bank.json"));
const bjPersist = {
  load() { try { return JSON.parse(fs.readFileSync(BJ_BANK_FILE, "utf8")); } catch (e) { return {}; } },
  save(obj) { try { const tmp = BJ_BANK_FILE + ".tmp"; fs.mkdirSync(path.dirname(BJ_BANK_FILE), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, BJ_BANK_FILE); } catch (e) {} },
};
const blackjack = attachBlackjack({
  startBalance: 1000, // match the site's default play-money demo balance ($1,000)
  persist: bjPersist,
  timers: { dealReveal: 450, dealPace: 430, dealerReveal: 800, dealerPace: 900 },
});
attachBridge(app, { blackjack });

// LAST-RESORT process guards: even with every engine timer wrapped (blackjack-server.js setT), a
// stray throw/rejection anywhere must NOT silently exit and wipe the in-memory bank. Log it, flush
// balances to disk, and keep serving. Also flush on a graceful shutdown (Render sends SIGTERM on
// deploy/spin-down) so the last balances are persisted.
function flushBjBank() { try { blackjack.bank && blackjack.bank.flush && blackjack.bank.flush(); } catch (e) {} }
process.on("uncaughtException", (e) => { try { console.error("uncaughtException:", (e && e.stack) || e); } catch (_) {} flushBjBank(); });
process.on("unhandledRejection", (e) => { try { console.error("unhandledRejection:", (e && e.stack) || e); } catch (_) {} });
["SIGTERM", "SIGINT"].forEach((sig) => process.on(sig, () => { flushBjBank(); process.exit(0); }));

// SPA-ish fallback so deep links like /?room=12 still serve index.html.
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/** ws -> { address } */
const clients = new Map();

// Short-term chat history kept in memory so newcomers (and a host who steps away)
// always load the recent conversation. Bounded by age AND count; not durable —
// a server restart clears it, which is fine for "recent chat".
const chatHistory = [];
const CHAT_TTL_MS = 2 * 60 * 60 * 1000; // keep ~2 hours
const CHAT_MAX = 200;                    // and at most 200 lines
function pruneChat() {
  const cutoff = Date.now() - CHAT_TTL_MS;
  while (chatHistory.length && chatHistory[0].ts < cutoff) chatHistory.shift();
  if (chatHistory.length > CHAT_MAX) chatHistory.splice(0, chatHistory.length - CHAT_MAX);
}

function activePlayers() {
  const seen = new Set();
  const list = [];
  for (const info of clients.values()) {
    if (info.address && !seen.has(info.address.toLowerCase())) {
      seen.add(info.address.toLowerCase());
      list.push(info.address);
    }
  }
  return list;
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function broadcastPlayers() {
  const players = activePlayers();
  broadcast({ type: "players", players, count: players.length });
}

wss.on("connection", (ws) => {
  clients.set(ws, { address: null });
  ws.on("error", () => {}); // ignore abrupt drops instead of crashing
  broadcastPlayers();

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (data.type === "bj:ping") { try { ws.send(JSON.stringify({ type: "bj:pong" })); } catch {} return; } // liveness probe so the client can detect a half-open socket + recover a frozen felt
    if (typeof data.type === "string" && data.type.startsWith("bj:")) {
      const allowedBeforeHello = data.type === "bj:lobby:subscribe" || data.type === "bj:lobby:unsubscribe";
      if (!ws.bjHelloSeen && !allowedBeforeHello) {
        try { ws.send(JSON.stringify({ type: "bj:error", code: "auth_required", message: "Identify before joining blackjack" })); } catch {}
        return;
      }
      // Blackjack sub-protocol: route any bj:* intent to the engine after identity.
      try {
        blackjack.handle(ws, data);
      } catch (e) {
        try { ws.send(JSON.stringify({ type: "bj:error", code: "server", message: "Blackjack message could not be processed" })); } catch {}
        console.error("blackjack ws error:", e && e.message ? e.message : e);
      }
      return;
    }
    if (data.type === "hello" && typeof data.address === "string") {
      const addr = data.address;
      const realWallet = /^0x[0-9a-fA-F]{40}$/.test(addr);
      ws.bjHelloSeen = true;
      clients.get(ws).address = addr;
      // Presence/chat can use the displayed address, but Blackjack spending needs
      // a trusted identity. Guests are play-money; real wallets must present the
      // bridge session token issued after an on-chain buy-in.
      if (/^guest:/.test(addr) || (blackjack.bridge && blackjack.bridge.isAuthorized(addr, data.bjToken))) {
        ws.wallet = addr;
        ws.bjToken = data.bjToken || "";
      }
      else ws.wallet = "";
      ws.bjAuthDenied = realWallet && !ws.wallet;
      broadcastPlayers();
      // Replay recent chat so the conversation is already there when they arrive
      // (and so a host who reconnects sees what players said while away).
      pruneChat();
      if (chatHistory.length && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "chat-history", messages: chatHistory }));
      }
    } else if (data.type === "rooms-updated" || data.type === "flip") {
      // Relay lobby/game changes so everyone refreshes from chain instantly.
      broadcast({ type: data.type, by: clients.get(ws)?.address || null, roomId: data.roomId });
    } else if (data.type === "chat") {
      // Relay a chat line. Trust the connection's stored address, not the
      // client-supplied one, and cap the length.
      const from = clients.get(ws)?.address || null;
      const text = String(data.text || "").slice(0, 240);
      const name = String(data.name || "").slice(0, 24).trim() || null; // chosen display name
      if (from && text.trim()) {
        const line = { type: "chat", from, name, text, ts: Date.now() };
        chatHistory.push({ from, name, text, ts: line.ts });
        pruneChat();
        broadcast(line);
      }
    } else if (data.type === "bet-proposal" || data.type === "bet-response") {
      // Bet negotiation between a joiner and a room creator. Clients filter by
      // roomId / `to`, so a simple broadcast is enough. Stamp the real sender.
      const from = clients.get(ws)?.address || null;
      if (from) {
        broadcast({
          type: data.type,
          from,
          roomId: data.roomId != null ? String(data.roomId) : null,
          amount: data.amount != null ? String(data.amount) : null,
          accepted: !!data.accepted,
          to: typeof data.to === "string" ? data.to : null,
        });
      }
    }
  });

  ws.on("close", () => {
    blackjack.onClose(ws); // free the player's seat / spectator slot
    clients.delete(ws);
    broadcastPlayers();
  });
});

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const line = "─".repeat(54);
  console.log(`\n📺  Crypto TV Flip is live!\n${line}`);
  console.log(`  Local:    http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  Network:  http://${ip}:${PORT}     ← share this on your wifi`);
  }
  if (PUBLIC_HOST) {
    console.log(`  Public:   http://${PUBLIC_HOST}:${PORT}     ← share this on the internet`);
  } else {
    console.log(`  Public:   set PUBLIC_HOST=<your-public-ip> to print an internet link`);
  }
  console.log(line);
  console.log("  Share a specific room by appending ?room=<id> to any URL above.");
  console.log("  For internet play, forward this port on your router (or use a");
  console.log("  tunnel like `ngrok http " + PORT + "`) and share the resulting URL.\n");
});
