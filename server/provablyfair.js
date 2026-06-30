/* ============================================================
   provablyfair.js — SERVER-SIDE commit-reveal RNG for the token games.

   Generalizes the blackjack shoe (public/blackjack-shuffle.js) into a reusable
   [0,1) FLOAT STREAM every game's server engine derives its outcome from. This is
   the trust anchor for the token bridge: the server commits a seed BEFORE the bet,
   the player can't influence or predict it, and after the reveal anyone re-derives
   every outcome. NO Chainlink VRF (too slow) — pure server commit-reveal.

   Scheme (identical hashing to the blackjack shoe, so one verifier covers both):
     commit = SHA256(serverSeed)                          published BEFORE the bet
     floats = HMAC_SHA256(serverSeed, clientSeed:nonce:cursor) → 8 floats per block
     reveal = serverSeed after the round → re-hash to confirm commit + re-derive.

   The serverSeed is SECRET until reveal (the HMAC key); clientSeed + nonce are
   PUBLIC and fixed at commit time, so the house can't re-roll after seeing the bet
   and the player can't steer the result. Per-bet `nonce` makes every bet in a
   session independently verifiable off the one committed seed.

   module.exports — newRound / floats / float / intBelow / pick / verify
   ============================================================ */
"use strict";

// Reuse the isomorphic SHA-256/HMAC already shipped + audited for blackjack, so the
// fairness panel verifies token games with the exact same primitive.
const Shuffle = require("../public/blackjack-shuffle.js");

// Start a round: a fresh secret seed + its public commit. Publish `commit` before bets.
function newRound() {
  const serverSeed = Shuffle.randomSeed(32);
  return { serverSeed: serverSeed, commit: Shuffle.commitHash(serverSeed) };
}

// Re-hash a revealed seed and confirm it matches the commit the player saw first.
function verify(commit, serverSeed) {
  return !!serverSeed && Shuffle.commitHash(serverSeed) === commit;
}

// Deterministic stream of `count` floats in [0,1). Each HMAC digest is 64 hex chars
// = 8 × 32-bit words → 8 floats per block; `cursor` advances when a block is spent.
// Pure function of (serverSeed, clientSeed, nonce) → fully re-derivable from the reveal.
function floats(serverSeed, clientSeed, nonce, count) {
  const out = [];
  const cs = String(clientSeed == null ? "" : clientSeed);
  const n = String(nonce == null ? 0 : nonce);
  let cursor = 0;
  while (out.length < count) {
    const dig = Shuffle.hmacHex(serverSeed, cs + ":" + n + ":" + cursor);
    for (let i = 0; i + 8 <= dig.length && out.length < count; i += 8) {
      const word = parseInt(dig.slice(i, i + 8), 16); // 32 bits
      out.push(word / 0x100000000); // [0, 1)
    }
    cursor++;
  }
  return out;
}

// One float in [0,1).
function float(serverSeed, clientSeed, nonce) {
  return floats(serverSeed, clientSeed, nonce, 1)[0];
}

// Integer in [0, n) from the k-th float of the stream (default 0).
function intBelow(serverSeed, clientSeed, nonce, n, k) {
  const f = floats(serverSeed, clientSeed, nonce, (k || 0) + 1)[k || 0];
  return Math.floor(f * n);
}

// Weighted pick: items = [{weight}], returns the chosen index using the k-th float.
function pick(serverSeed, clientSeed, nonce, weights, k) {
  const total = weights.reduce(function (a, w) { return a + w; }, 0);
  const f = floats(serverSeed, clientSeed, nonce, (k || 0) + 1)[k || 0];
  let r = f * total, acc = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r < acc) return i; }
  return weights.length - 1;
}

module.exports = {
  newRound: newRound,
  verify: verify,
  floats: floats,
  float: float,
  intBelow: intBelow,
  pick: pick,
  commitHash: Shuffle.commitHash,
  randomSeed: Shuffle.randomSeed,
};

/* ---------------- CLI self-test: node server/provablyfair.js ---------------- */
if (require.main === module) {
  let ok = true;
  const eq = (label, cond) => { console.log((cond ? "  ok  " : "  FAIL") + "  " + label); if (!cond) ok = false; };

  const { serverSeed, commit } = newRound();
  eq("commit verifies for the real seed", verify(commit, serverSeed));
  eq("commit rejects a wrong seed", !verify(commit, serverSeed + "00"));

  // determinism: same inputs → same stream
  const a = floats(serverSeed, "client-A", 1, 8);
  const b = floats(serverSeed, "client-A", 1, 8);
  eq("deterministic for identical (seed,client,nonce)", JSON.stringify(a) === JSON.stringify(b));

  // independence: different nonce / client → different stream
  eq("nonce changes the stream", JSON.stringify(a) !== JSON.stringify(floats(serverSeed, "client-A", 2, 8)));
  eq("clientSeed changes the stream", JSON.stringify(a) !== JSON.stringify(floats(serverSeed, "client-B", 1, 8)));

  // range + rough uniformity over a big sample (mean ≈ 0.5)
  const N = 200000, big = floats(serverSeed, "u", 7, N);
  let inRange = true, sum = 0;
  for (const x of big) { if (x < 0 || x >= 1) inRange = false; sum += x; }
  eq("all floats in [0,1)", inRange);
  const mean = sum / N;
  eq("mean ~0.5 (got " + mean.toFixed(4) + ")", Math.abs(mean - 0.5) < 0.01);

  // intBelow uniformity for a d6
  const counts = new Array(6).fill(0);
  for (let i = 0; i < 60000; i++) counts[intBelow(serverSeed, "d6", i, 6)]++;
  const minC = Math.min.apply(null, counts), maxC = Math.max.apply(null, counts);
  eq("d6 roughly uniform (" + counts.join("/") + ")", minC > 9000 && maxC < 11000);

  console.log(ok ? "\nSELF-TEST OK — commit-reveal float engine is deterministic + verifiable." : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}
