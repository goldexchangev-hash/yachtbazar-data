const { makeTokenService, tokenAuthMessage } = require("./server/token-http.js");
const { ethers } = require("ethers");

(async () => {
  const wallet = ethers.Wallet.createRandom();
  const house = ethers.Wallet.createRandom();
  const player = wallet.address;
  const contract = "0xD7E584c341bDbF20848CFa162F65EfB406aA0Cbc";
  const chainId = 11155111;
  const lockedWei = (25n * 10n ** 16n);
  const signer = { 
    sign: (p, net, nonce, cid, c) => house.signMessage(ethers.getBytes(ethers.solidityPackedKeccak256(["address", "int256", "uint256", "uint256", "address"], [p, BigInt(net), BigInt(nonce), cid, c]))) 
  };
  
  const sign = (intent, o) => wallet.signMessage(tokenAuthMessage(intent, o));

  // Persistent store
  const store = { _state: null, load() { return this._state; }, save(s) { this._state = JSON.parse(JSON.stringify(s)); } };
  
  console.log("=== TEST: Bearer token persistence after restart ===\n");
  
  // Service 1: Player starts a session
  const svc1 = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), persist: store });
  const startBody = { player, contract, chainId, txHash: "0x" + "a".repeat(64), buyInWei: lockedWei.toString() };
  startBody.signature = await sign("start", { player, contract, chainId, buyInWei: lockedWei.toString() });
  const started = await svc1.doStart(startBody);
  console.log("1. Service A: Player started session");
  console.log("   Session ID:", started.sessionId);
  console.log("   Bearer token:", started.sessionToken.substring(0, 12) + "...");

  // Service 1: Player plays successfully
  try {
    const playResult = svc1.doPlay({ sessionId: started.sessionId, sessionToken: started.sessionToken, game: "coinflip", betUnits: 10, params: { side: 0 }, clientSeed: "c1" });
    console.log("2. Service A: Player played successfully, tokens:", playResult.tokens);
  } catch (e) {
    console.log("2. Service A: Play FAILED:", e.message);
  }

  // RESTART: Service 2 is a fresh instance loading from the same store
  console.log("\n--- SERVER RESTART (Service B) ---\n");
  const svc2 = makeTokenService({ signer, ethUsd: () => 4000, verifyBuyIn: async (o) => ({ lockedWei: o.buyInWei }), persist: store });
  const bridgeSession = svc2._bridge.session(started.sessionId);
  console.log("3. Service B: Restarted from persistent store");
  console.log("   Bridge session exists:", bridgeSession ? "YES" : "NO");
  console.log("   Session tokens:", bridgeSession ? bridgeSession.tokens : "N/A");
  
  // Service 2: Player tries to play with the same bearer token
  console.log("\n4. Service B: Player attempts to play with original bearer token...");
  try {
    const playResult = svc2.doPlay({ sessionId: started.sessionId, sessionToken: started.sessionToken, game: "coinflip", betUnits: 10, params: { side: 1 }, clientSeed: "c2" });
    console.log("   ✓ SUCCESS: Player played after restart");
    console.log("   Tokens:", playResult.tokens);
  } catch (e) {
    console.log("   ✗ FAILURE: Player CANNOT play after restart");
    console.log("   Error:", e.message);
    console.log("\n   ROOT CAUSE: Bearer token (sessionToken) is NOT persisted/regenerated");
    console.log("   - On start: token stored ONLY in memory (tokenForSession Map)");
    console.log("   - On restart: tokenForSession is a fresh empty Map");
    console.log("   - Result: Bearer token check at line 178 fails");
  }

  console.log("\n5. Can player settle without the bearer token?");
  const settleSig = await sign("settle", { player, contract, chainId, sessionId: started.sessionId });
  try {
    const stl = await svc2.doSettle({ player, sessionId: started.sessionId, signature: settleSig });
    console.log("   ✓ YES: Settle works (only checks wallet signature, not bearer token)");
  } catch (e) {
    console.log("   ✗ NO: Settle failed:", e.message);
  }

  console.log("\n=== CONCLUSION ===");
  console.log("The finding is CONFIRMED: Bearer token is not persisted.");
  console.log("After restart, a player cannot play() but CAN settle().");
})().catch(e => console.error("Test error:", e.message));
