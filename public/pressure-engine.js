/* ============================================================
   pressure-engine.js — PRESSURE: pure, deterministic game logic.

   NO Pixi / NO DOM in here. This is the single source of truth for money and
   for provable fairness. The renderer/UI only READ from this.

   Provably fair (identical commit-reveal to a Stake-style crash curve):
     - commit(serverSeed)  -> SHA256(serverSeed)   (published BEFORE the round)
     - float = HMAC_SHA256(serverSeed, clientSeed + ':' + nonce) first 8 hex / 2^32
     - burst B = floor( max(1, (1 - houseEdge)/(1 - float)) , cap )
       The house edge lives entirely in an instant-pop mass at ~1.00x
       (it pops immediately whenever float < houseEdge). Survival S(m)=(1-edge)/m,
       so EV of any cash-out target = (1 - edge): RTP is target-independent.

   Exposed as globalThis.PressureEngine so it works in the browser AND in node
   (for the unit self-test).
   ============================================================ */
(function (root) {
  "use strict";

  /* ---------------- SHA-256 (sync, byte-array in / out) ---------------- */
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rrot = (x, n) => (x >>> n) | (x << (32 - n));

  function sha256(msg) {
    const len = msg.length;
    const bitLen = len * 8;
    const withOne = len + 1;
    const pad = (56 - (withOne % 64) + 64) % 64;
    const total = withOne + pad + 8;
    const buf = new Uint8Array(total);
    buf.set(msg, 0);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 4, bitLen >>> 0, false);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let i = 0; i < total; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
      for (let t = 16; t < 64; t++) {
        const s0 = rrot(w[t - 15], 7) ^ rrot(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rrot(w[t - 2], 17) ^ rrot(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let t = 0; t < 64; t++) {
        const S1 = rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
        const S0 = rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((hh, i) => odv.setUint32(i * 4, hh >>> 0, false));
    return out;
  }

  const enc = (str) => (typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(str)
    : Uint8Array.from(unescape(encodeURIComponent(str)), (c) => c.charCodeAt(0)));
  const toHex = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  };
  const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };

  function sha256Hex(str) { return toHex(sha256(enc(str))); }

  function hmacSha256Hex(keyStr, msgStr) {
    let key = enc(keyStr);
    if (key.length > 64) key = sha256(key);
    const block = new Uint8Array(64); block.set(key);
    const ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ipad[i] = block[i] ^ 0x36; opad[i] = block[i] ^ 0x5c; }
    const inner = sha256(concat(ipad, enc(msgStr)));
    return toHex(sha256(concat(opad, inner)));
  }

  /* ---------------- Provably-fair outcome ---------------- */
  function commit(serverSeed) { return sha256Hex(serverSeed); }

  function deriveFloat(serverSeed, clientSeed, nonce) {
    const hex = hmacSha256Hex(serverSeed, String(clientSeed) + ":" + String(nonce));
    return parseInt(hex.slice(0, 8), 16) / 0x100000000; // [0,1)
  }

  function deriveBurst(serverSeed, clientSeed, nonce, houseEdge, cap) {
    if (houseEdge == null) houseEdge = 0.03;
    cap = cap || 1000;
    const float = deriveFloat(serverSeed, clientSeed, nonce);
    let B = (1 - houseEdge) / (1 - float);
    if (!isFinite(B) || B < 1) B = 1;
    if (B > cap) B = cap;
    B = Math.floor(B * 100) / 100;
    if (B < 1) B = 1;
    return B;
  }

  function verify(serverSeed, committedHash, clientSeed, nonce, houseEdge, cap) {
    const computedHash = sha256Hex(serverSeed);
    return {
      hashOk: committedHash ? computedHash === committedHash : null,
      computedHash,
      float: deriveFloat(serverSeed, clientSeed, nonce),
      burst: deriveBurst(serverSeed, clientSeed, nonce, houseEdge, cap),
    };
  }

  /* ---------------- Time -> multiplier (the pump curve) ----------------
     Pure function of held seconds. The risk-dial only changes how fast the
     SAME multiplier is reached (pump speed / felt volatility); it never
     touches the burst distribution or RTP. */
  const DOUBLING = { calm: 4.6, normal: 3.0, frantic: 1.7 }; // seconds per x2
  function multiplierAtTime(heldSec, pumpSpeed) {
    const d = DOUBLING[pumpSpeed] || DOUBLING.normal;
    return Math.pow(2, Math.max(0, heldSec) / d);
  }
  // inverse: seconds of held time needed to reach a target multiplier
  function timeForMultiplier(mult, pumpSpeed) {
    const d = DOUBLING[pumpSpeed] || DOUBLING.normal;
    return Math.max(0, Math.log2(Math.max(1, mult)) * d);
  }

  /* ---------------- Round resolution (valve ledger) ----------------
     floors: array of { fraction, lockMult } locked while inflating (pop-proof).
     A clean release banks locked floors + the unlocked remainder x releaseMult.
     A pop keeps the locked floors and loses the unlocked remainder. */
  function resolveRound(o) {
    const stake = o.stake;
    const burst = o.burst;
    const releaseMult = o.releaseMult;
    const floors = o.floors || [];
    let lockedSum = 0, lockedFrac = 0;
    for (const f of floors) { lockedSum += f.fraction * f.lockMult * stake; lockedFrac += f.fraction; }
    const unlockedFrac = Math.max(0, 1 - lockedFrac);
    const popped = releaseMult >= burst;
    const ridingWin = popped ? 0 : unlockedFrac * stake * releaseMult;
    const payout = lockedSum + ridingWin;
    return {
      exit: o.exit || (popped ? "pop" : "release"),
      popped,
      payout,
      profit: payout - stake,
      lockedSum,
      ridingWin,
      unlockedFrac,
      lockedFrac,
      releaseMult,
      burst,
    };
  }

  /* Add a valve lock to a ledger; returns the new floor + remaining unlocked.
     Locks `valveFraction` of the CURRENTLY-unlocked stake at `mult`. */
  function valveLock(floors, valveFraction, mult) {
    let lockedFrac = 0;
    for (const f of floors) lockedFrac += f.fraction;
    const unlocked = Math.max(0, 1 - lockedFrac);
    const lockFrac = unlocked * valveFraction;
    const floor = { fraction: lockFrac, lockMult: mult };
    return { floor, remainingUnlocked: unlocked - lockFrac };
  }

  function randomSeed(bytesLen) {
    bytesLen = bytesLen || 16;
    const b = new Uint8Array(bytesLen);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b);
    else for (let i = 0; i < bytesLen; i++) b[i] = Math.floor(Math.random() * 256);
    return toHex(b);
  }

  const API = {
    // crypto / fairness
    sha256Hex, hmacSha256Hex, commit, deriveFloat, deriveBurst, verify, randomSeed,
    // curve
    multiplierAtTime, timeForMultiplier, DOUBLING,
    // money
    resolveRound, valveLock,
    // tuning defaults
    DEFAULTS: { houseEdge: 0.03, cap: 1000, valveFraction: 0.7, autoRelease: 2.0 },
  };

  root.PressureEngine = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
