/**
 * TV Crypto Flip — local game server.
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
const http = require("http");
const os = require("os");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_HOST = process.env.PUBLIC_HOST || ""; // e.g. your public IP for internet play

const app = express();
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Tiny health/info endpoint the frontend can use to learn its share base.
app.get("/api/info", (req, res) => {
  res.json({ publicHost: PUBLIC_HOST, port: PORT, players: activePlayers().length });
});

// SPA-ish fallback so deep links like /?room=12 still serve index.html.
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

/** ws -> { address } */
const clients = new Map();

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
    if (data.type === "hello" && typeof data.address === "string") {
      clients.get(ws).address = data.address;
      broadcastPlayers();
    } else if (data.type === "rooms-updated" || data.type === "flip") {
      // Relay lobby/game changes so everyone refreshes from chain instantly.
      broadcast({ type: data.type, by: clients.get(ws)?.address || null, roomId: data.roomId });
    } else if (data.type === "chat") {
      // Relay a chat line. Trust the connection's stored address, not the
      // client-supplied one, and cap the length.
      const from = clients.get(ws)?.address || null;
      const text = String(data.text || "").slice(0, 240);
      if (from && text.trim()) {
        broadcast({ type: "chat", from, text, ts: Date.now() });
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
  console.log(`\n📺  TV Crypto Flip is live!\n${line}`);
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
