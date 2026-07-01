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
const { makeCrashWs } = require("./crash-rounds-ws.js");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_HOST = process.env.PUBLIC_HOST || ""; // e.g. your public IP for internet play

const app = express();
// v5 #7: trust exactly ONE proxy hop (Render's router). Without this, Express leaves req.ip as the socket
// peer and the per-IP rate limiter fell back to the leading X-Forwarded-For token — which a client can spoof
// (Render APPENDS the real IP, so the first token is attacker-controlled) to cycle fresh buckets. With one
// trusted hop, req.ip resolves to the entry Render appended (the real client), defeating the spoof.
app.set("trust proxy", 1);
const publicDir = path.join(__dirname, "..", "public");

// ── HTTP security headers (v3 #2) ──────────────────────────────────────────────
// Applied to EVERY response (static assets + API + WS upgrade page) before anything
// else runs. These harden transport + framing WITHOUT constraining what the dApp can
// load: the CSP sets ONLY `frame-ancestors` (anti-clickjacking) — there is deliberately
// no `script-src`/`default-src`, so inline scripts, ethers, and the injected wallet
// provider (MetaMask) keep working. A strict script-src CSP would break wallet injection
// and is intentionally omitted (the report's own caveat). HSTS is ignored by browsers when
// received over plain HTTP, so it's inert on localhost dev and only enforced on the HTTPS
// Render origin. X-Powered-By is removed so we don't advertise the Express version.
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"); // v6 #32: object-src 'none' (no <object>/<embed> plugins) + base-uri 'self' (no injected <base> hijack). No script-src/default-src — wallet injection + ethers must keep working.
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

app.use(express.json({ limit: "64kb" }));
// Don't expose the dev/engine test harnesses (public/_*.html, *-preview.html) publicly.
app.use((req, res, next) => {
  if (/\/_[^/]*\.html$/i.test(req.path) || /-preview\.html$/i.test(req.path)) return res.status(404).end();
  next();
});
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
// Durable, corruption-proof JSON write: write to a temp file, fsync it to disk, VALIDATE it
// parses, then atomically rename over the real file. If the write is interrupted (ENOSPC / EIO),
// the throw leaves the existing good file untouched — never a half-written/truncated state file.
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(obj);
  const fd = fs.openSync(tmp, "w");
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  JSON.parse(fs.readFileSync(tmp, "utf8")); // readback: refuse to promote a corrupt temp
  fs.renameSync(tmp, file);
  // mega-hunt LOW: fsync the PARENT DIR so the rename (the directory entry) is durable across a power loss —
  // the file DATA was fsync'd above, but the rename can still sit in the OS cache. Best-effort: some platforms
  // reject opening a dir for fsync, and a failure here never corrupts anything (the atomic rename already landed).
  try { const dfd = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (e) {}
}
// Durable-store loader that DISTINGUISHES "file absent" (fresh install → {}) from "file present but
// CORRUPT" (truncated/garbled JSON). The old `catch { return {} }` silently emptied a corrupt store,
// which is catastrophic for the money stores: an empty state replays already-spent buy-in txHashes
// (re-fund) and orphans every open session's recover. So on a parse failure of EXISTING bytes we
// quarantine the bad file and THROW (label it) — the caller decides whether that's fatal. A missing
// file (ENOENT) or an empty file is the only "return {}" case.  (audit #142)
function loadJsonStoreOrThrow(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e && e.code === "ENOENT") return {}; throw e; } // unreadable for any OTHER reason is a real error
  if (!raw || !raw.trim()) return {}; // empty file == fresh
  try { return JSON.parse(raw); }
  catch (e) {
    // Preserve the corrupt bytes for forensics instead of letting the next save() overwrite them.
    let saved = "";
    try { const bak = file + ".corrupt." + Date.now(); fs.copyFileSync(file, bak); saved = " (backed up to " + bak + ")"; } catch (_) {}
    try { console.error("STATE_FILE_CORRUPT — refusing to boot " + (label || file) + " from unparseable JSON" + saved + ":", (e && e.message) || e); } catch (_) {}
    const err = new Error("corrupt state file: " + (label || file) + " — " + ((e && e.message) || e));
    err.code = "STATE_FILE_CORRUPT";
    throw err;
  }
}
const BJ_BANK_FILE = String(process.env.BJ_BANK_FILE || path.join(__dirname, ".bj-bank.json"));
const bjPersist = {
  // v5 #29: harden the guest play-money bank load. The old version swallowed EVERY error → a corrupt
  // .bj-bank.json silently became {} and the next save() overwrote the bytes, wiping all guest balances
  // with no forensic trace. loadJsonStoreOrThrow QUARANTINES the corrupt file (.corrupt.*) + logs loudly;
  // we then continue with a fresh bank — unlike the real-money token store we do NOT hard-fail boot here
  // (it's only play money, and taking the whole site down over a corrupt demo bank isn't worth it).
  load() {
    try { return loadJsonStoreOrThrow(BJ_BANK_FILE, "blackjack guest bank"); }
    catch (e) { return {}; } // corrupt bytes already backed up + logged inside loadJsonStoreOrThrow
  },
  save(obj) { try { writeJsonAtomic(BJ_BANK_FILE, obj); } catch (e) {} },
};
const blackjack = attachBlackjack({
  startBalance: 5000, // match the site-wide $5,000 play-money demo balance
  persist: bjPersist,
  timers: { dealReveal: 450, dealPace: 430, dealerReveal: 800, dealerPace: 900 },
});
attachBridge(app, { blackjack });

// ── Server-side TOKEN bridge (the new commit-reveal token games: coinflip/dice/dice2/
//    crash/pressure/slots/slots3d). FLAG-GATED + OFF by default, so the live demo is
//    untouched. Enable with ENABLE_TOKEN_BRIDGE=1 plus HOUSE_SIGNER_KEY (signer) and an
//    RPC URL. Shares the same buy-in/settle contract slots as blackjack, so one open
//    bridge session per player until the per-session-lock contract upgrade ships.
const realmoney = require("./realmoney.js");
const { attachTokenBridge } = require("./token-http.js");
const TOKEN_STATE_FILE = String(process.env.TOKEN_BRIDGE_FILE || path.join(__dirname, ".token-bridge.json"));
let _tokenPersistWarnedAt = 0;
const tokenPersist = {
  // CORRUPT-STORE SAFETY (audit #142): a parse failure of an EXISTING token-state file must NOT
  // silently return {} — that would re-fund every already-spent buy-in txHash and orphan every open
  // session's recover. loadJsonStoreOrThrow returns {} only for a truly absent/empty file and THROWS
  // on corrupt bytes (after backing them up). We surface that as a hard boot failure below so the
  // operator fixes the disk instead of the server quietly minting free tokens.
  load() { return loadJsonStoreOrThrow(TOKEN_STATE_FILE, "token bridge state"); },
  save(obj) {
    try { writeJsonAtomic(TOKEN_STATE_FILE, obj); }
    catch (e) {
      // A SILENT persist failure here is exactly how a token session "freezes" after a restart: the
      // bearer is granted in memory but never written, so on reboot every /play 400s. Make it LOUD so
      // the operator sees it (throttled to avoid log spam if the disk is persistently unwritable).
      const now = Date.now();
      if (now - _tokenPersistWarnedAt > 30000) { _tokenPersistWarnedAt = now; try { console.error("TOKEN_BRIDGE_PERSIST_FAILED — token sessions will NOT survive a restart (path:", TOKEN_STATE_FILE + "):", (e && e.message) || e); } catch (_) {} }
    }
  },
};
// Boot preflight: prove the token-state path is writable so a broken/read-only TOKEN_BRIDGE_FILE is
// caught at startup — not silently at the first buy-in (which would then freeze on the next restart).
let _tokenStoreWritable = false;
(function preflightTokenStore() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_STATE_FILE), { recursive: true });
    const probe = TOKEN_STATE_FILE + ".probe";
    fs.writeFileSync(probe, "ok"); fs.rmSync(probe, { force: true });
    _tokenStoreWritable = true;
  } catch (e) {
    try { console.error("TOKEN_BRIDGE_STORE_NOT_WRITABLE — point TOKEN_BRIDGE_FILE at a writable (ideally mounted-disk) path or token sessions won't survive a restart:", (e && e.message) || e); } catch (_) {}
  }
})();
// Boot preflight (audit #142): if the token-state file exists but is CORRUPT, REFUSE to start. The
// bridge's internal load() swallows load errors (try/catch → {}), which on a corrupt store would boot
// with empty money state — re-funding every spent buy-in txHash and orphaning every open session's
// recover. We catch that here, FIRST, and crash loudly so the operator restores/clears the disk
// deliberately instead of the server silently minting free tokens. (Set TOKEN_ALLOW_CORRUPT_RESET=1
// only to intentionally start fresh from a known-bad file — it's quarantined as .corrupt.* either way.)
(function preflightTokenStoreParse() {
  try { loadJsonStoreOrThrow(TOKEN_STATE_FILE, "token bridge state"); }
  catch (e) {
    if (e && e.code === "STATE_FILE_CORRUPT" && process.env.TOKEN_ALLOW_CORRUPT_RESET !== "1") {
      try { console.error("FATAL: token bridge state is corrupt — refusing to boot (would re-fund spent buy-ins). Fix/restore the disk, or set TOKEN_ALLOW_CORRUPT_RESET=1 to start fresh.", (e && e.message) || e); } catch (_) {}
      process.exit(1);
    }
    // Any OTHER read error (e.g. permissions) we let the normal swallowing path handle — it isn't a
    // silent-empty-of-corrupt-money-state hazard, and the writable preflight above already warns.
  }
})();
// Durability diagnostic (exposed on /api/token/status): durable = the state file is on a CONFIGURED
// (non-default) path AND writable — i.e. a mounted disk, so sessions survive restarts.
function tokenStoreInfo() {
  const custom = !!process.env.TOKEN_BRIDGE_FILE;
  return { path: TOKEN_STATE_FILE, custom: custom, writable: _tokenStoreWritable, durable: custom && _tokenStoreWritable };
}
function tokenRpcUrl(chainId) {
  if (chainId === 11155111) return process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || "";
  if (chainId === 31337) return process.env.LOCAL_RPC_URL || process.env.RPC_URL || "http://127.0.0.1:8545";
  return process.env.RPC_URL || "";
}
// Token valuation MUST track the SAME ETH/USD the client uses (app.js fetches CoinGecko), or a $X
// deposit gets relabeled as a different token count on buy-in (the wei→USD round-trip uses two
// different prices). The client was on a live ~$1.6k feed while the server defaulted to a stale
// $3,400 → ~2x inflated tokens. So poll the live price here too. An explicit BRIDGE_ETH_USD/ETH_USD
// env still wins (manual override); otherwise we use the live feed, falling back to 3400 only before
// the first fetch.
let _ethUsdLive = 0;
// v6 #3: sanity-bound the live feed + expire it. A glitched provider returning e.g. $50 or $500k/ETH would
// otherwise directly over/under-mint token grants (weiToUsd at doStart/doTopUp), and a good price would live
// FOREVER if both providers later fail (no staleness gate) — valuing new buy-ins off an arbitrarily old price.
const ETH_USD_MIN = Number(process.env.ETH_USD_MIN) || 200;      // reject clearly-broken feed values
const ETH_USD_MAX = Number(process.env.ETH_USD_MAX) || 100000;
const ETH_USD_STALE_MS = Number(process.env.ETH_USD_STALE_MS) || 15 * 60 * 1000; // grants blocked if the live feed is older than this (poll is 60s, so this tolerates ~15 missed refreshes)
let _ethUsdLiveAt = 0; // when _ethUsdLive was last refreshed from a VALID in-range fetch
// #37/#38: poll TWO sources so a single-provider outage can't block buy-ins (the cold-start window where
// ethUsdReady() is false), and so the server's primary source MATCHES the client's (Coinbase spot first,
// then CoinGecko) — no grant discrepancy under provider divergence. We deliberately do NOT pin a fixed
// BRIDGE_ETH_USD env on Render (that would break the 1:1 live valuation); this keeps the feed live + resilient.
async function fetchCoinbaseEthUsd() {
  const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return Number(j && j.data && j.data.amount);
}
async function fetchCoinGeckoEthUsd() {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return Number(j && j.ethereum && j.ethereum.usd);
}
async function refreshTokenEthUsd() {
  // Coinbase first (matches the client's primary), CoinGecko as fallback. Either landing keeps buy-ins open.
  // v6 #3: only ACCEPT an in-range price [ETH_USD_MIN, ETH_USD_MAX] and stamp when it landed. An out-of-range
  // value from a glitched provider is dropped (the last good price stays, and staleness eventually gates grants).
  const okRange = (u) => Number.isFinite(u) && u >= ETH_USD_MIN && u <= ETH_USD_MAX;
  try { const u = await fetchCoinbaseEthUsd(); if (okRange(u)) { _ethUsdLive = u; _ethUsdLiveAt = Date.now(); return; } } catch (e) {}
  try { const u = await fetchCoinGeckoEthUsd(); if (okRange(u)) { _ethUsdLive = u; _ethUsdLiveAt = Date.now(); return; } } catch (e) {}
}
refreshTokenEthUsd();
{ const t = setInterval(refreshTokenEthUsd, 60000); if (t && t.unref) t.unref(); }
function tokenEthUsd() {
  const override = Number(process.env.BRIDGE_ETH_USD || process.env.ETH_USD || 0);
  if (override > 0) return override;       // explicit manual override wins
  if (_ethUsdLive > 0) return _ethUsdLive; // live CoinGecko price (matches the client)
  return 3400;                              // last-resort fallback before the first fetch lands
}
const tokenSvc = attachTokenBridge(app, {
  enabled: () => process.env.ENABLE_TOKEN_BRIDGE === "1" && realmoney.enabled(),
  // v5 #11 (optional, off by default): pin the admin endpoints to known house contract(s). When set, a
  // caller can't pass a clone contract they "own" to clear requireOwner. e.g. TOKEN_ALLOWED_CONTRACTS=0xabc,0xdef
  allowedContracts: String(process.env.TOKEN_ALLOWED_CONTRACTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  signer: { sign: (p, net, nonce, cid, c) => realmoney.signSettlement(p, net, nonce, cid, c) },
  signerAddress: () => { try { return realmoney.signerAddress(); } catch (e) { return null; } }, // public address (for /status diagnostics) — never the key
  flag: () => process.env.ENABLE_TOKEN_BRIDGE === "1",
  rpcUrlFor: tokenRpcUrl,
  ethUsd: tokenEthUsd, // live ETH/USD (matches the client) so $X deposited ≈ $X tokens
  storeInfo: tokenStoreInfo, // durability diagnostic on /api/token/status (disk mounted + writable?)
  // True once a REAL price is available (explicit override, or the live CoinGecko fetch landed).
  // Used to BLOCK a buy-in during the cold-start window when tokenEthUsd() still returns the 3400
  // fallback — otherwise a deposit made in the first seconds after a restart would be valued at
  // $3,400/ETH and grant ~2x inflated tokens (the "$49 → 101 tokens" bug). Play/settle are
  // unaffected (net is pinned to the locked wei); this only gates the initial grant.
  // v6 #3: an explicit BRIDGE_ETH_USD/ETH_USD manual pin is ALWAYS ready (intentional override, never expires).
  // Otherwise require a live price that is BOTH in-range AND fresh (< ETH_USD_STALE_MS) — a prolonged dual-
  // provider outage then blocks NEW grants (doStart/doTopUp) rather than valuing buy-ins off a stale price.
  // Play/settle are unaffected (net is pinned to the locked wei); this only gates the initial grant.
  ethUsdReady: () => (Number(process.env.BRIDGE_ETH_USD || process.env.ETH_USD || 0) > 0) || (_ethUsdLive > 0 && (Date.now() - _ethUsdLiveAt) < ETH_USD_STALE_MS),
  persist: tokenPersist,
  minConfirmations: Number(process.env.TOKEN_MIN_CONFIRMATIONS || 1),
  // v6 #14: per-session MAX-WIN cap (USD). The settle pays lockedWei+netWei and the house float funds the NET, so
  // an uncapped big win (e.g. a fish bonus tail ~$23k) could exceed a finite house float and become UNCLAIMABLE.
  // Bounds the session UPSIDE (net) so the house never gets stuck. Default $2000 is safe for the current ~$3,500
  // house; RAISE `TOKEN_MAX_WIN_USD` as the house grows (a very large value effectively disables the cap). Losses
  // are never touched. Applied honestly at accrual (the displayed balance never shows more than is payable).
  maxWinUnits: Number(process.env.TOKEN_MAX_WIN_USD) > 0 ? Number(process.env.TOKEN_MAX_WIN_USD) : 2000,
  // Token-funded blackjack: refuse a token cash-out / recover while the player has a live blackjack hand
  // (else the settle would lock in a debited stake before the hand resolves). blackjack exists already.
  // Stranded-lock auto-claim is only safe when the legacy on-chain blackjack bridge is OFF (else a prior
  // bjLocked could be a live on-chain hand). It is OFF by default and the owner keeps it 0.
  experimentalBridgeOn: () => process.env.ENABLE_EXPERIMENTAL_BRIDGE === "1",
  hasLiveExternal: (player) => { try { return blackjack.hasLiveHand(player); } catch (e) { return false; } },
  // STRICTER: only a DEALT, in-play hand (not a bet placed in the betting phase). The token top-up guard uses
  // this so adding funds between hands / during betting credits immediately, while mid-hand top-up still refuses.
  hasDealtExternal: (player) => { try { return blackjack.hasDealtHand(player); } catch (e) { return false; } },
});

// TOKEN-FUNDED BLACKJACK wiring: a real wallet's blackjack chips ARE their token session. Hand bets/wins
// route through the hardened token ledger; cash-out is the normal token settle. (Late-bound here because
// tokenSvc is created after blackjack.) The OLD experimental on-chain blackjack bridge stays optional.
try { blackjack.setTokenLedger({ tokensOf: tokenSvc.tokensOf, applyNet: tokenSvc.applyBlackjackNet }); } catch (e) {}

// ── Live crash rounds over the ws (cr:* sub-protocol) ───────────────────────────
// The server-paced round-runner that makes MANUAL tap-to-cash-out provably fair for the
// crash family (crash/plane/swoop/pressure). Shares the SAME token-bridge ledger as the
// HTTP /api/token/* path (tokenSvc._bridge) and reuses its per-session bearer for auth
// (tokenSvc.verifySession). Dormant until ENABLE_TOKEN_BRIDGE=1 — with no open session,
// verifySession returns null and every cr:start is rejected, so the live demo is untouched.
const crashWs = makeCrashWs({ bridge: tokenSvc._bridge, verifySession: tokenSvc.verifySession, liveExternal: (player) => tokenSvc.liveExternal(player) }); // v3 #1: WS cr:start refuses during a live BJ hand
// Wire the crash-round liveness guard into the token service (late-bound: crashWs is built after tokenSvc).
// doSettle/doRelease/doAdminRelease/doPlay now refuse while a server-paced crash/plane/swoop/pressure round
// is live on that session — a mid-round cash-out can't close the session out from under the pending
// resolveReserved, and an instant HTTP bet can't burn a fresh nonce while the round is in flight (#3/#15).
try { tokenSvc.setActiveCrashCheck((sessionId) => crashWs.hasActiveRound(sessionId)); } catch (e) {}

// LAST-RESORT process guards: even with every engine timer wrapped (blackjack-server.js setT), a
// stray throw/rejection anywhere must NOT silently exit and wipe the in-memory bank. Log it, flush
// balances to disk, and keep serving. Also flush on a graceful shutdown (Render sends SIGTERM on
// deploy/spin-down) so the last balances are persisted.
function flushBjBank() { try { blackjack.bank && blackjack.bank.flush && blackjack.bank.flush(); } catch (e) {} }
// Flush BOTH money stores on the way down/sideways (audit #143/#144): the GUEST blackjack bank AND the
// token bridge's HTTP-guard state (spent buy-ins, open sessions, bearers, pendingSettle obligations).
// The token bridge already persists synchronously on every op, but a final flush guarantees the very
// last state survives a deploy/spin-down and is cheap + swallow-on-fail.
function flushTokenStore() { try { tokenSvc && tokenSvc.flushPersist && tokenSvc.flushPersist(); } catch (e) {} }
function flushAllStores() { flushBjBank(); flushTokenStore(); }
// #32: drain in-flight crash rounds into the ledger BEFORE flushing on a fault too (mirrors the SIGTERM
// path) — an uncaughtException often precedes the process dying, so booking the reserved stakes now keeps
// the ledger consistent even if Render SIGKILLs us next. drainCrashRounds() is idempotent + best-effort
// (defined just below), so re-settlement is a no-op if we keep serving. NOTE: drainCrashRounds is hoisted.
process.on("uncaughtException", (e) => { try { console.error("uncaughtException:", (e && e.stack) || e); } catch (_) {} try { drainCrashRounds(); } catch (_) {} flushAllStores(); });
process.on("unhandledRejection", (e) => { try { console.error("unhandledRejection:", (e && e.stack) || e); } catch (_) {} try { drainCrashRounds(); } catch (_) {} flushAllStores(); }); // #144/#32: drain + flush (was log-only)
// Graceful shutdown: flush both stores, then stop accepting new connections and drain in-flight
// requests (server.close), exiting once drained or after a hard 4s cap so Render's SIGKILL never
// interrupts a half-written response. Guarded so a double signal can't double-exit.
let _shuttingDown = false;
// Drain in-flight crash rounds (settle each at its current multiplier into the ledger) BEFORE the flush, so a
// redeploy never destroys a live round's in-memory timer with the stake reserved but the win/loss un-booked
// (the house would otherwise eat every in-flight losing bet). Best-effort — never let it block shutdown (#141).
function drainCrashRounds() { try { crashWs && crashWs.drain && crashWs.drain(); } catch (e) { try { console.error("crash drain failed:", (e && e.stack) || e); } catch (_) {} } }
function gracefulShutdown() {
  if (_shuttingDown) return; _shuttingDown = true;
  drainCrashRounds();   // settle live rounds into the ledger first…
  flushAllStores();     // …then persist (so the drained settlements are on disk)
  const done = () => { flushAllStores(); process.exit(0); }; // re-flush after drain in case an in-flight op completed
  try {
    let closed = false;
    // v6 #33: server.close() stops NEW connections but leaves open WS sockets alive → shutdown would wait the
    // full 4s cap every deploy. Close every live socket (1001 Going Away) so it drains promptly; balances are
    // already flushed above and the client auto-reconnects to the new instance.
    try { wss.clients.forEach((c) => { try { c.close(1001, "server restarting"); } catch (e) {} }); } catch (e) {}
    server.close(() => { if (!closed) { closed = true; done(); } });
    const t = setTimeout(() => { if (!closed) { closed = true; done(); } }, 4000); // hard cap so we never hang the deploy
    if (t && t.unref) t.unref();
  } catch (e) { done(); }
}
["SIGTERM", "SIGINT"].forEach((sig) => process.on(sig, gracefulShutdown));

// v5 #30: an unknown /api/* path must 404 as JSON, not fall through to the SPA HTML below (a 200 + index.html
// for a mistyped endpoint makes token-client.status() and any fetch() parse garbage / mask a real outage).
app.all("/api/*", (req, res) => { res.status(404).json({ ok: false, error: "not found" }); });
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

// #9/#22: per-connection token-bucket. One socket flooding hello/chat/rooms-updated/bet-proposal makes
// each broadcast() O(clients) → O(clients²) amplification; it could also storm the crash/bj handlers.
// Legitimate play is a few msgs/sec (a manual crash tap, a blackjack action), so a generous limit never
// bites real users and silently drops a flood. In-memory per-socket (no shared map to grow).
const WS_MSG_RATE = 40;   // sustained messages/sec/connection
const WS_MSG_BURST = 80;  // bucket capacity (brief bursts ok)
function wsRateOk(ws) {
  const now = Date.now();
  let b = ws._msgBucket;
  if (!b) { b = ws._msgBucket = { tokens: WS_MSG_BURST, ts: now }; }
  b.tokens = Math.min(WS_MSG_BURST, b.tokens + ((now - b.ts) / 1000) * WS_MSG_RATE);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const MAX_WS_CONNECTIONS = Number(process.env.MAX_WS_CONNECTIONS) || 600;
// v6 #4: the global cap alone lets ONE client open all 600 sockets and deny service to everyone. Add a
// per-IP cap + an Origin allowlist (anti cross-site-WebSocket-hijack). Both fail OPEN on any uncertainty so
// a legit player is never locked out.
const MAX_WS_PER_IP = Number(process.env.MAX_WS_PER_IP) || 12;
const wsByIp = new Map();
function wsClientIp(req) {
  try {
    const xff = String((req && req.headers && req.headers["x-forwarded-for"]) || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // 1 trusted hop (Render) APPENDS the real client IP last; leftmost tokens are client-spoofable (mirror the HTTP trust-proxy=1 resolution)
    return (req && req.socket && req.socket.remoteAddress) || "";
  } catch (e) { return ""; }
}
function wsOriginOk(req) {
  try {
    const origin = String((req && req.headers && req.headers.origin) || "");
    if (!origin) return true; // non-browser client (native/tests) sends no Origin — allow
    const oh = new URL(origin).host;
    const host = String((req && req.headers && req.headers.host) || "");
    if (host && oh === host) return true;                                  // same-origin: the served page → its own WS (the live case)
    if (PUBLIC_HOST && (oh === PUBLIC_HOST || origin === PUBLIC_HOST)) return true;
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(oh)) return true;          // local dev
    return false;
  } catch (e) { return true; } // any parse failure → don't lock anyone out
}
wss.on("connection", (ws, req) => {
  // v6 #4: reject cross-origin browser hijack attempts before we allocate anything.
  if (!wsOriginOk(req)) { try { ws.close(1008, "origin not allowed"); } catch (e) {} return; }
  // v5 #17: cap total live sockets. Each connect triggers a broadcastPlayers() over ALL clients, so an
  // unbounded connection flood is O(N^2) work on the single event loop. Refuse past the cap instead.
  if (clients.size >= MAX_WS_CONNECTIONS) { try { ws.close(1013, "server at capacity"); } catch (e) {} return; }
  // v6 #4: per-IP cap so a single source can't hoard the global pool.
  const ip = wsClientIp(req);
  if (ip) {
    const n = (wsByIp.get(ip) || 0) + 1;
    if (n > MAX_WS_PER_IP) { try { ws.close(1013, "too many connections"); } catch (e) {} return; }
    wsByIp.set(ip, n); ws._ip = ip;
  }
  clients.set(ws, { address: null });
  ws.on("error", () => {}); // ignore abrupt drops instead of crashing
  broadcastPlayers();

  ws.on("message", (raw) => {
    if (!wsRateOk(ws)) return; // #9/#22: drop a per-connection message flood before it can amplify
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (data.type === "bj:ping") { try { ws.send(JSON.stringify({ type: "bj:pong" })); } catch {} return; } // liveness probe so the client can detect a half-open socket + recover a frozen felt
    if (typeof data.type === "string" && data.type.startsWith("cr:")) {
      // Live crash rounds (token mode). Self-authorizing via the bridge session token in
      // the message itself — no `hello` required. Errors are returned as cr:error, never thrown.
      try { crashWs.handle(ws, data); } catch (e) {
        try { ws.send(JSON.stringify({ type: "cr:error", code: "server", message: "crash message could not be processed" })); } catch {}
      }
      return;
    }
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
      // v6 #8: the presence/chat identity (player roster, chat `from`, rooms-updated `by`, bet-proposal `from`)
      // accepted ANY string → a client could spoof another wallet's handle. Only accept a real 0x wallet or a
      // well-formed guest id; blank anything else (they still connect, just with no spoofable handle). The
      // money identity (ws.wallet) is validated separately below and is unaffected.
      clients.get(ws).address = (realWallet || /^guest:[a-z0-9]{1,32}$/.test(addr)) ? addr : "";
      // Presence/chat can use the displayed address, but Blackjack spending needs
      // a trusted identity. Guests are play-money; real wallets must present a trusted token.
      // PREFERRED real-money path: a TOKEN-bridge session (bjSession=sessionId, bjToken=its bearer) —
      // the player's blackjack chips ARE their token balance. Falls back to the old experimental
      // on-chain blackjack bridge if present, else guests.
      ws.tokenSession = "";
      let tokenOk = false;
      if (realWallet && data.bjSession && tokenSvc && tokenSvc.verifySession) {
        try {
          const ts = tokenSvc.verifySession(String(data.bjSession), String(data.bjToken || ""));
          if (ts && String(ts.player || "").toLowerCase() === addr.toLowerCase()) {
            ws.wallet = addr; ws.tokenSession = String(data.bjSession); ws.bjToken = String(data.bjToken || "");
            blackjack.bindToken(addr, data.bjSession);
            tokenOk = true;
          }
        } catch (e) {}
      }
      if (!tokenOk) {
        // v5 #1: a guest id is a client-minted `guest:` + base36 slug (Math.random().toString(36)). Pin the
        // charset/length so a crafted `guest:<img onerror=…>` can never be accepted and later rendered into a
        // seat nameplate (stored-XSS sink in blackjack-ui _name). Defense-in-depth: the felt also escapes it.
        if (/^guest:[a-z0-9]{1,32}$/.test(addr) || (blackjack.bridge && blackjack.bridge.isAuthorized(addr, data.bjToken))) {
          ws.wallet = addr;
          ws.bjToken = data.bjToken || "";
        }
        else ws.wallet = "";
      }
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
    crashWs.onClose(ws);   // detach any live crash round (it still settles via the server timer)
    // Drop any token-session binding so a settled/replaced session can't keep routing this wallet's chips —
    // BUT only if no OTHER open socket still holds the same wallet's token session (#36 two-tab safety):
    // closing one tab must not delink token blackjack for another tab sharing the same wallet. (ws is still
    // in `clients` here; deleted just below — so skip self in the scan.)
    if (ws.wallet && ws.tokenSession) {
      let othersHold = false;
      const w = ws.wallet.toLowerCase();
      for (const [other, info] of clients) {
        if (other === ws) continue;
        if (other.readyState === other.OPEN && other.wallet && other.tokenSession && other.wallet.toLowerCase() === w) { othersHold = true; break; }
      }
      if (!othersHold) { try { blackjack.unbindToken(ws.wallet); } catch (e) {} }
    }
    if (ws._ip) { const n = (wsByIp.get(ws._ip) || 0) - 1; if (n <= 0) wsByIp.delete(ws._ip); else wsByIp.set(ws._ip, n); } // v6 #4: release the per-IP slot
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
