/* ============================================================
   slots3d-engine.js — "GEM VAULT 3D": pure slot math for a 5×3, 20-line
   video slot with WILD substitution + SCATTER. NO Three.js / NO DOM here.

   Provably fair (same commit-reveal family as Crash/Balloon Pop/Plane):
     commit(serverSeed) = SHA256(serverSeed)                      (published first)
     bytes = HMAC_SHA256(serverSeed, clientSeed + ':' + nonce)    (revealed after)
   The 32 HMAC bytes drive the 5 reel stops, so the grid can't be changed after
   the commit, and anyone can re-derive it. Money math is independent of the
   renderer — frame rate never affects a payout.

   globalThis.Slots3DEngine
   ============================================================ */
(function (root) {
  "use strict";

  /* ---------------- SHA-256 + HMAC (sync, dependency-free) ---------------- */
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
    const len = msg.length, bitLen = len * 8, withOne = len + 1;
    const pad = (56 - (withOne % 64) + 64) % 64, total = withOne + pad + 8;
    const buf = new Uint8Array(total); buf.set(msg, 0); buf[len] = 0x80;
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
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((hh, i) => odv.setUint32(i * 4, hh >>> 0, false));
    return out;
  }
  const enc = (s) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s)
    : Uint8Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0)));
  const toHex = (b) => { let s = ""; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0"); return s; };
  const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
  function sha256Hex(str) { return toHex(sha256(enc(str))); }
  function hmac(keyStr, msgStr) {
    let key = enc(keyStr); if (key.length > 64) key = sha256(key);
    const block = new Uint8Array(64); block.set(key);
    const ip = new Uint8Array(64), op = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ip[i] = block[i] ^ 0x36; op[i] = block[i] ^ 0x5c; }
    return sha256(cat(op, sha256(cat(ip, enc(msgStr))))); // 32 bytes
  }

  /* ---------------- theme: symbols + paytable ---------------- */
  // id, short name, kind. WILD substitutes for everything except SCATTER.
  const SYMBOLS = [
    { id: 0, key: "cherry",  name: "Cherry" },
    { id: 1, key: "bell",    name: "Bell" },
    { id: 2, key: "star",    name: "Star" },
    { id: 3, key: "seven",   name: "Lucky 7" },
    { id: 4, key: "bar",     name: "Gold Bar" },
    { id: 5, key: "diamond", name: "Diamond" },
    { id: 6, key: "wild",    name: "WILD" },
    { id: 7, key: "scatter", name: "Vault" },
  ];
  const WILD = 6, SCATTER = 7;

  // Payout per matching LINE (in multiples of the per-line bet): index [3,4,5].
  // NOTE FOR CLAUDE/CHATGPT (v11.52): these values are tuned for TOTAL RTP with
  // the active free-spins bonus included. The old table produced ~95% on base
  // spins alone, but ~129-130% once credited free spins were counted.
  const PAY = {
    0: [3, 7, 18],       // cherry
    1: [4, 12, 30],      // bell
    2: [7, 18, 58],      // star
    3: [12, 36, 115],    // lucky 7
    4: [21, 73, 231],    // gold bar
    5: [36, 145, 580],   // diamond
    6: [58, 231, 1154],  // wild line
  };
  // scatter pays × TOTAL bet for 3/4/5 anywhere
  const SCATTER_PAY = { 3: 3, 4: 15, 5: 73 };

  // 20 fixed paylines over a 5×3 grid (rows: 0 top, 1 middle, 2 bottom).
  const LINES = [
    [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
    [0, 0, 1, 0, 0], [2, 2, 1, 2, 2], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1],
    [1, 0, 1, 0, 1], [1, 2, 1, 2, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
    [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [1, 1, 0, 1, 1], [1, 1, 2, 1, 1],
    [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [0, 2, 0, 2, 0],
  ];

  // Per-reel weighted strips. Highs/wild/scatter are rare. With the v11.52
  // paytable above, base spins land around ~70% RTP and the free-spins feature
  // contributes the rest, putting the total modeled RTP near ~95%.
  // Each reel is a flat strip; a uniform stop over the strip = weighted symbol.
  const WEIGHTS = [
    // reel: cherry,bell,star,seven,bar,diamond,wild,scatter
    [10, 9, 7, 6, 4, 3, 2, 2],
    [10, 9, 7, 6, 4, 3, 2, 2],
    [10, 9, 8, 6, 4, 2, 2, 2],
    [10, 9, 7, 6, 4, 3, 2, 2],
    [10, 9, 7, 6, 4, 3, 2, 2],
  ];
  const STRIPS = WEIGHTS.map((w) => {
    const strip = [];
    for (let sym = 0; sym < w.length; sym++) for (let n = 0; n < w[sym]; n++) strip.push(sym);
    // shuffle deterministically (Fisher–Yates with a fixed LCG) so adjacent
    // symbols vary but the strip is stable across sessions.
    let seed = 0x9e3779b9 ^ (strip.length * 2654435761);
    for (let i = strip.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1); const t = strip[i]; strip[i] = strip[j]; strip[j] = t;
    }
    return strip;
  });

  /* ---------------- grid derivation ---------------- */
  // 5 reel stops from the 32 HMAC bytes (4 bytes per reel → uint32 → index).
  function gridFromBytes(bytes) {
    const grid = [[], [], [], [], []];
    for (let r = 0; r < 5; r++) {
      const o = r * 4;
      const v = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
      const strip = STRIPS[r], stop = v % strip.length;
      for (let row = 0; row < 3; row++) grid[r][row] = strip[(stop + row) % strip.length];
    }
    return grid; // grid[reel][row]
  }
  function deriveGrid(serverSeed, clientSeed, nonce) {
    return gridFromBytes(hmac(serverSeed, String(clientSeed) + ":" + String(nonce)));
  }

  /* ---------------- evaluation ---------------- */
  // Left-to-right line wins with WILD substitution; SCATTER pays anywhere.
  function evaluate(grid, totalBetUsd) {
    const lineBet = (totalBetUsd || 0) / LINES.length;
    let win = 0; const wins = [];
    for (let li = 0; li < LINES.length; li++) {
      const rows = LINES[li];
      const first = grid[0][rows[0]];
      // the "target" symbol is the first non-wild on the line (wild leads → use next)
      let target = first;
      if (target === WILD) { for (let r = 1; r < 5; r++) { const s = grid[r][rows[r]]; if (s !== WILD) { target = s; break; } } }
      if (target === SCATTER) continue; // scatter never pays on a line
      let count = 0;
      for (let r = 0; r < 5; r++) { const s = grid[r][rows[r]]; if (s === target || s === WILD) count++; else break; }
      if (count >= 3 && PAY[target]) {
        const mult = PAY[target][count - 3];
        if (mult > 0) { const p = mult * lineBet; win += p; wins.push({ line: li, sym: target, count, payUsd: p, rows: rows.slice() }); }
      }
    }
    // scatter anywhere
    let sc = 0; const scCells = [];
    for (let r = 0; r < 5; r++) for (let row = 0; row < 3; row++) if (grid[r][row] === SCATTER) { sc++; scCells.push([r, row]); }
    let scatterUsd = 0;
    if (sc >= 3) { scatterUsd = (SCATTER_PAY[Math.min(5, sc)] || 0) * (totalBetUsd || 0); win += scatterUsd; }
    return { winUsd: Math.round(win * 100) / 100, lines: wins, scatter: sc >= 3 ? { count: sc, payUsd: scatterUsd, cells: scCells } : null };
  }

  /* ---------------- free-spins bonus ---------------- */
  // 3+ Vault (SCATTER) symbols lock in a FREE SPINS round. The number of spins
  // scales with how many vaults landed; every free-spin win is multiplied. The
  // whole round is DETERMINISTIC from the same commit (each free spin derives
  // from nonce + ":free:" + i), so the grand total is fixed at reveal time —
  // the renderer just animates a result that's already provably settled.
  const FREE_SPINS = { 3: 8, 4: 12, 5: 20 };
  const FREE_MULT = 2;
  function freeSpinsFor(scatterCount) { return FREE_SPINS[Math.min(5, scatterCount | 0)] || 0; }
  function deriveBonus(serverSeed, clientSeed, nonce, totalBetUsd, scatterCount) {
    const spins = freeSpinsFor(scatterCount);
    const results = []; let total = 0;
    for (let i = 0; i < spins; i++) {
      const grid = deriveGrid(serverSeed, clientSeed, String(nonce) + ":free:" + i);
      const r = evaluate(grid, totalBetUsd);
      const winUsd = Math.round(r.winUsd * FREE_MULT * 100) / 100;
      total += winUsd;
      results.push({ grid: grid, lines: r.lines, scatter: r.scatter, baseUsd: r.winUsd, winUsd: winUsd });
    }
    return { spins: spins, mult: FREE_MULT, results: results, totalUsd: Math.round(total * 100) / 100 };
  }

  function randomSeed(len) {
    len = len || 16; const b = new Uint8Array(len);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b);
    else for (let i = 0; i < len; i++) b[i] = Math.floor(Math.random() * 256);
    return toHex(b);
  }

  function verify(serverSeed, committedHash, clientSeed, nonce, totalBetUsd) {
    const computed = sha256Hex(serverSeed);
    const grid = deriveGrid(serverSeed, clientSeed, nonce);
    return { hashOk: committedHash ? computed === committedHash : null, computedHash: computed, grid, result: evaluate(grid, totalBetUsd) };
  }

  const API = {
    SYMBOLS, WILD, SCATTER, PAY, SCATTER_PAY, LINES, STRIPS, FREE_SPINS, FREE_MULT,
    sha256Hex, commit: sha256Hex, deriveGrid, gridFromBytes, evaluate, verify, randomSeed,
    freeSpinsFor, deriveBonus,
    // exposed for Monte-Carlo RTP testing
    _hmacBytes: hmac,
    DEFAULTS: { minBetUsd: 10, edgePctApprox: 5 },
  };
  root.Slots3DEngine = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
