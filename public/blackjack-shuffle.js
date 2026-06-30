/* ============================================================
   blackjack-shuffle.js — provably-fair 6-deck shoe. ISOMORPHIC: the SAME file
   runs on the server (to deal) and in the browser fairness panel (to verify),
   with a self-contained SHA-256/HMAC so it needs no Node 'crypto'.

   Scheme (commit-reveal, like the site's crash/plane engines):
     commit  = SHA256(serverSeed)                published BEFORE any bet
     shoe    = Fisher-Yates over a canonical 312-card deck, where each swap
               index comes from HMAC_SHA256(serverSeed, shoeId+':'+clientCombined+':'+i)
     reveal  = serverSeed after the shoe ends → anyone recomputes the exact shoe.
   clientCombined is the seat-ordered join of the 4 players' client seeds, so the
   order is fixed at commit time and the house cannot rearrange after seeing bets.

   globalThis.BlackjackShuffle  /  module.exports
   ============================================================ */
(function (root) {
  "use strict";
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
  const SUITS = ["S", "H", "D", "C"];

  /* ---- SHA-256 (sync, self-contained) ---- */
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
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  function sha256(msg) {
    const len = msg.length, bitLen = len * 8, withOne = len + 1, pad = (56 - (withOne % 64) + 64) % 64, total = withOne + pad + 8;
    const buf = new Uint8Array(total); buf.set(msg, 0); buf[len] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(total - 4, bitLen >>> 0, false); dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let i = 0; i < total; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
      for (let t = 16; t < 64; t++) { const s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3), s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10); w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0; }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let t = 0; t < 64; t++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32), odv = new DataView(out.buffer); [h0, h1, h2, h3, h4, h5, h6, h7].forEach((hh, i) => odv.setUint32(i * 4, hh >>> 0, false)); return out;
  }
  const enc = (s) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s) : Uint8Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0)));
  const toHex = (b) => { let s = ""; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0"); return s; };
  const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
  function sha256Hex(str) { return toHex(sha256(enc(str))); }
  function hmacHex(key, msg) {
    let k = enc(key); if (k.length > 64) k = sha256(k);
    const bl = new Uint8Array(64); bl.set(k); const ip = new Uint8Array(64), op = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ip[i] = bl[i] ^ 0x36; op[i] = bl[i] ^ 0x5c; }
    return toHex(sha256(cat(op, sha256(cat(ip, enc(msg))))));
  }

  /* ---- shoe ---- */
  function buildOrderedDeck(decks) {
    decks = decks || 6; const out = [];
    for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) out.push({ rank: r, suit: s });
    return out;
  }
  function commitHash(serverSeed) { return sha256Hex(serverSeed); }
  function joinClientSeeds(seats) { // seats: array length 4 of seed strings ('' for empty)
    const a = []; for (let i = 0; i < 4; i++) a.push((seats && seats[i]) ? String(seats[i]) : "");
    return a.join("|");
  }
  // deterministic Fisher-Yates; HMAC keyed by the SECRET serverSeed, message is the PUBLIC entropy + index
  function shuffle(serverSeed, clientCombined, shoeId, decks) {
    const deck = buildOrderedDeck(decks);
    for (let i = deck.length - 1; i >= 1; i--) {
      const dig = hmacHex(serverSeed, String(shoeId) + ":" + clientCombined + ":" + i);
      const r = parseInt(dig.slice(0, 13), 16) / 0x10000000000000;   // 13 hex = 52 bits
      const j = Math.floor(r * (i + 1));
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
    }
    return deck;
  }
  // re-derive the deal (player0..3 first card, dealer up, player0..3 second, dealer hole) for N seated players
  function dealOrder(shoe, seatedCount) {
    const hands = []; for (let i = 0; i < seatedCount; i++) hands.push([]); const dealer = []; let p = 0;
    for (let i = 0; i < seatedCount; i++) hands[i].push(shoe[p++]); dealer.push(shoe[p++]);
    for (let i = 0; i < seatedCount; i++) hands[i].push(shoe[p++]); dealer.push(shoe[p++]);
    return { hands, dealer, next: p };
  }
  // standalone verifier for the fairness panel
  function verify(serverSeed, committedHash, clientSeeds, shoeId, decks) {
    const computed = commitHash(serverSeed), cc = joinClientSeeds(clientSeeds);
    const shoe = shuffle(serverSeed, cc, shoeId, decks);
    return { hashOk: committedHash ? computed === committedHash : null, computedHash: computed, clientCombined: cc, shoe };
  }

  function randomSeed(len) {
    len = len || 32; const b = new Uint8Array(len);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b);
    else { try { b.set(require("crypto").randomBytes(len)); } catch (e) { for (let i = 0; i < len; i++) b[i] = Math.floor(Math.random() * 256); } }
    return toHex(b);
  }

  const API = { RANKS, SUITS, sha256Hex, hmacHex, buildOrderedDeck, commitHash, joinClientSeeds, shuffle, dealOrder, verify, randomSeed };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.BlackjackShuffle = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
