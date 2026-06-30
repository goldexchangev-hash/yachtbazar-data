/* ============================================================
   plane-feed.js — "PLANE": simulated live-player feed (FOMO engine).
   PURELY COSMETIC. Money is single-player vs house; this never touches balance.
   Each round it spawns fake players seeded from the round nonce, resolves them
   against the SAME engine crash point (so it can never contradict the result),
   and flips rows green (cashed) / red (lost) live as the multiplier climbs.

   window.PlaneFeed = { mount, start(nonce, crash, myBets), tick(mult), crash(mult), settle() }
   ============================================================ */
(function (root) {
  "use strict";
  const HANDLES = ["satoshi_j", "degen_dan", "moonboy", "0xWhale", "luckyLuke", "ape_ster", "vegas_vi", "cryptoKel",
    "jetset_jo", "hodl_hank", "rng_rita", "maxbet_mo", "tower_tom", "neonNina", "pumpPaul", "sky_sam",
    "riskRae", "coinKong", "blastoise", "gigaGale", "fomoFred", "zoomZoe", "altcoinAl", "bagsBea"];
  function addr() { const h = "0123456789abcdef"; let s = "0x"; for (let i = 0; i < 4; i++) s += h[(Math.random() * 16) | 0]; return s + "…" + h[(Math.random() * 16) | 0] + h[(Math.random() * 16) | 0]; }

  // tiny seeded RNG (mulberry32) from a string nonce
  function rngFrom(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  let host = null, players = [], crashAt = 1, lastMult = 1, tab = "all";

  function mount(el) { host = (typeof el === "string") ? document.querySelector(el) : el; }

  function start(nonce, crash, myBets) {
    if (!host) return;
    crashAt = crash; lastMult = 1;
    const r = rngFrom("feed:" + nonce);
    const n = 24 + Math.floor(r() * 40);
    players = [];
    for (let i = 0; i < n; i++) {
      const stake = [10, 10, 20, 25, 50, 50, 100, 250, 500][Math.floor(r() * 9)] * (r() < 0.04 ? 10 : 1);
      // hidden cashout target: most exit 1.2x-3x, a thin tail goes high
      const t = r() < 0.12 ? 3 + r() * 20 : 1.15 + r() * 1.9;
      players.push({ name: r() < 0.5 ? HANDLES[Math.floor(r() * HANDLES.length)] : addr(), stake, target: Math.round(t * 100) / 100, cashed: false, lost: false, mine: false, big: r() < 0.18 });
    }
    (myBets || []).forEach((b) => players.unshift({ name: "YOU", stake: b.stake, target: b.target, cashed: false, lost: false, mine: true, manual: b.manual }));
    render();
  }

  function tick(mult) {
    lastMult = mult; let changed = false;
    for (const p of players) {
      if (!p.cashed && !p.lost && !p.mine && p.target <= mult && p.target < crashAt) {
        // bias a few big greens to land just above the current view -> regret
        p.cashed = true; p.at = p.target; changed = true;
      }
    }
    if (changed) render();
  }
  function setMine(b) { for (const p of players) if (p.mine) { if (b.cashed) { p.cashed = true; p.at = b.at; } } render(); }

  function crash(c) { crashAt = c; for (const p of players) if (!p.cashed && !p.mine) p.lost = true; render(); }

  function render() {
    if (!host) return;
    let list = players.slice();
    if (tab === "top") list = list.filter((p) => p.cashed).sort((a, b) => (b.at || 0) - (a.at || 0));
    else if (tab === "mine") list = list.filter((p) => p.mine);
    else list.sort((a, b) => (b.cashed ? 1 : 0) - (a.cashed ? 1 : 0));
    const total = players.reduce((s, p) => s + p.stake, 0);
    const rows = list.slice(0, 40).map((p) => {
      const st = "$" + p.stake.toLocaleString();
      let right = '<span class="pf-pending">betting…</span>';
      if (p.cashed) right = '<span class="pf-cashed">' + (p.at ? p.at.toFixed(2) + "x  +$" + Math.round(p.stake * (p.at - 1)).toLocaleString() : "cashed") + "</span>";
      else if (p.lost) right = '<span class="pf-lost">lost</span>';
      return '<div class="pf-row' + (p.mine ? " mine" : "") + (p.big && p.cashed ? " big" : "") + '"><span class="pf-name">' + p.name + '</span><span class="pf-stake">' + st + '</span>' + right + "</div>";
    }).join("");
    host.innerHTML = '<div class="pf-head"><b>' + players.length + " flying</b> · $" + total.toLocaleString() + " in</div>" + rows;
  }

  function setTab(t) { tab = t; render(); }

  root.PlaneFeed = { mount, start, tick, crash, setMine, setTab };
})(typeof globalThis !== "undefined" ? globalThis : this);
