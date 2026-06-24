/**
 * Chainlink's Solidity imports OpenZeppelin with version-pinned paths like
 * `@openzeppelin/contracts@4.9.6/...`. Chainlink installs those as npm aliases
 * named `@openzeppelin/contracts-4.9.6` (hyphen) and resolves the `@`-style
 * paths via Foundry remappings. Hardhat has no remappings, so we create
 * matching directory symlinks: `contracts-4.9.6` -> `contracts@4.9.6`.
 *
 * Runs automatically as a postinstall hook; safe to run repeatedly.
 */
const fs = require("fs");
const path = require("path");

const ozDir = path.join(__dirname, "..", "node_modules", "@openzeppelin");
if (!fs.existsSync(ozDir)) {
  process.exit(0); // nothing installed yet
}

for (const entry of fs.readdirSync(ozDir)) {
  // Only version-pinned dirs (e.g. `contracts-4.9.6`) — Chainlink's `@`-style
  // imports are always `@openzeppelin/contracts@X.Y.Z`. Leave `contracts-
  // upgradeable` alone (it's imported with its hyphen).
  const m = entry.match(/^(contracts)-(\d+\.\d+\.\d+)$/);
  if (!m) continue;
  const linkName = `${m[1]}@${m[2]}`; // contracts@4.9.6
  const linkPath = path.join(ozDir, linkName);
  if (fs.existsSync(linkPath)) continue;
  try {
    fs.symlinkSync(entry, linkPath, "junction");
    console.log(`linked @openzeppelin/${linkName} -> ${entry}`);
  } catch (e) {
    // Fall back to a relative copy if symlinks are unavailable.
    try {
      fs.cpSync(path.join(ozDir, entry), linkPath, { recursive: true });
      console.log(`copied @openzeppelin/${linkName} <- ${entry}`);
    } catch (err) {
      console.warn(`could not link @openzeppelin/${linkName}: ${err.message}`);
    }
  }
}
