/**
 * One-command local launcher.  `npm run play`
 *
 * Starts everything you need to play locally and prints the link:
 *   1. a local blockchain (hardhat node)
 *   2. deploys the game + mock VRF + funds the house
 *   3. the local VRF fulfiller (settles flips)
 *   4. the website
 *
 * Press Ctrl+C once to stop it all. Cross-platform (Win/Mac/Linux).
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const isWin = process.platform === "win32";
const NPX = isWin ? "npx.cmd" : "npx";
const RPC_PORT = 8545;
const children = [];

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, shell: isWin, ...opts });
  children.push(child);
  return child;
}

function pipe(child, label, color) {
  const tag = `\x1b[${color}m[${label}]\x1b[0m `;
  const onData = (buf) =>
    buf
      .toString()
      .split("\n")
      .filter((l) => l.trim())
      .forEach((l) => console.log(tag + l));
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
}

function waitForRpc(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.request(
        { host: "127.0.0.1", port: RPC_PORT, method: "POST", headers: { "content-type": "application/json" } },
        (res) => { res.resume(); resolve(); }
      );
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error("RPC did not come up"));
        else setTimeout(tryOnce, 500);
      });
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }));
    };
    tryOnce();
  });
}

function runToCompletion(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = run(cmd, args);
    pipe(child, "deploy", "36");
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("deploy failed (" + code + ")"))));
  });
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\x1b[33mShutting down…\x1b[0m");
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

(async () => {
  console.log("\x1b[35m📺 TV Crypto Flip — starting everything…\x1b[0m\n");

  console.log("→ starting local blockchain…");
  const node = run(NPX, ["hardhat", "node"]);
  pipe(node, "chain", "90");
  node.on("exit", (c) => { if (!shuttingDown) { console.error("chain exited", c); shutdown(); } });

  await waitForRpc();
  console.log("✓ blockchain ready\n→ deploying contract…");
  await runToCompletion(NPX, ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"]);

  console.log("✓ deployed\n→ starting website…\n");
  const server = run("node", ["server/server.js"], { env: { ...process.env } });
  pipe(server, "web", "94");
})().catch((err) => {
  console.error("\x1b[31m" + err.message + "\x1b[0m");
  shutdown();
});
