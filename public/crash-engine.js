/* ============================================================================
 * crash-engine.js — provably-fair crash math + curve helpers (no DOM, no deps)
 *
 * The crash point follows the canonical Bustabit/Stake distribution:
 *     P(crash >= M) = (1 - houseEdge) / M
 * i.e. inverse-CDF  M = (1 - edge) / (1 - X)  for a uniform X in [0,1), floored
 * at 1.00x (the floor is what realises the house edge — the "instant bust").
 *
 * The rising multiplier the player watches is purely cosmetic:
 *     multiplier(t) = e^(k * t)      (t in ms, k ~ 0.00006..0.00012 / ms)
 * It only animates the wait until the pre-decided crash point is reached; it
 * never affects odds.
 *
 * Exposed as window.CrashEngine (browser) and module.exports (node tests).
 * ==========================================================================*/
(function (root) {
  "use strict";

  // ---- provably-fair crash point ------------------------------------------
  // Map a uniform X in [0,1) to a crash multiplier (2-dp), with house edge.
  function crashFromUnit(x, houseEdge) {
    if (!(x >= 0)) x = 0;
    if (x >= 1) x = 1 - 1e-12;
    const edge = houseEdge == null ? 0.01 : houseEdge;
    const rtp = 1 - edge;                       // 0.99 at 1% edge
    const m = Math.floor((100 * rtp) / (1 - x)) / 100;
    return Math.max(1.0, m);                     // floor at 1.00x = instant bust
  }

  // Take the top 52 bits of a hex digest as the uniform draw (Bustabit form).
  function unitFromHex(hex) {
    const h = parseInt(String(hex).slice(0, 13), 16); // 13 hex chars = 52 bits
    return h / Math.pow(2, 52);
  }

  // Provably-fair crash point from a hex HMAC/hash digest.
  function crashFromHash(hex, houseEdge) {
    return crashFromUnit(unitFromHex(hex), houseEdge);
  }

  // Convenience for client-side / preview play when there's no chain hash yet.
  function crashFromRandom(rng, houseEdge) {
    const r = (typeof rng === "function") ? rng() : Math.random();
    return crashFromUnit(r, houseEdge);
  }

  // ---- the rising curve (cosmetic) ----------------------------------------
  // k is per-millisecond. 0.00006 ≈ Bustabit pace (2x at ~11.5s);
  // 0.00012 ≈ snappy Aviator pace (2x at ~5.8s). We default to a lively middle.
  const DEFAULT_K = 0.0001;
  function multiplierAtMs(ms, k) { return Math.exp((k || DEFAULT_K) * ms); }
  function msToReach(mult, k) { return Math.log(Math.max(1, mult)) / (k || DEFAULT_K); }

  // ---- payout / odds (auto-cashout single-tx model) -----------------------
  // Win iff the crash point reaches the player's target T. Flat house edge.
  function winChance(targetX, houseEdge) {
    const edge = houseEdge == null ? 0.01 : houseEdge;
    return Math.min(1, (1 - edge) / Math.max(1.01, targetX));
  }
  function profitOnWin(stake, targetX) { return stake * (targetX - 1); }

  root.CrashEngine = {
    crashFromUnit, unitFromHex, crashFromHash, crashFromRandom,
    multiplierAtMs, msToReach, winChance, profitOnWin, DEFAULT_K,
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

if (typeof module !== "undefined" && module.exports) module.exports = (typeof window !== "undefined" ? window : globalThis).CrashEngine;
